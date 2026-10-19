;(function () {
  // ===== UTILITY FUNCTIONS =====

  // Extra console output for troubleshooting; turn on by running
  // localStorage.setItem('ostats_debug', '1') in the browser console
  const DEBUG = (() => {
    try {
      return localStorage.getItem('ostats_debug') === '1'
    } catch (e) {
      return false
    }
  })()
  function debugLog(...args) {
    if (DEBUG) console.log('[OStats]', ...args)
  }

  // GraphQL API call function
  async function callGQL(options) {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query: options.query,
        variables: options.variables || {},
      }),
    })

    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`)
    }

    const result = await response.json()
    if (result.errors) {
      console.error('[OStats] GraphQL errors:', result.errors)
      throw new Error(result.errors[0]?.message || 'GraphQL query failed')
    }

    return result.data
  }

  // ===== PLUGIN SETTINGS =====
  // Settings are defined in ostats.yml and saved by Stash. Stash lists them
  // sorted by key, so the keys are numbered (01_hideTopStats, 06a_...) to
  // keep them in page order; the number is stripped off here.
  async function getPluginSettings() {
    try {
      const data = await callGQL({ query: 'query { configuration { plugins } }' })
      const saved = data.configuration?.plugins?.ostats || {}
      const settings = {}
      Object.keys(saved).forEach((key) => {
        settings[key.replace(/^\d+[a-z]?_/, '')] = saved[key]
      })
      return settings
    } catch (e) {
      console.warn('[OStats] Failed to load plugin settings:', e)
      return {}
    }
  }

  // ===== SCENE DATA =====
  // Only scenes with an O or some play time matter to the stats, so the
  // rest of the library isn't downloaded.
  const ACTIVE_SCENES_FILTER = `{
    o_counter: { value: 0, modifier: GREATER_THAN }
    OR: {
      play_count: { value: 0, modifier: GREATER_THAN }
      OR: { play_duration: { value: 0, modifier: GREATER_THAN } }
    }
  }`

  // Remove data left behind by the old "Use cache" option and the old
  // cross-tab watch time syncing.
  try {
    ;[
      'ostats_scenes_core_v1',
      'ostats_scenes_full_v1',
      'ostats_use_cache',
      'ostats_watch_data_sync',
      'ostats_save_lock',
    ].forEach((key) => localStorage.removeItem(key))
  } catch (e) {}

  function sanitizeScene(scene) {
    return {
      id: scene.id,
      title: scene.title || null,
      o_counter: scene.o_counter || 0,
      o_history: Array.isArray(scene.o_history) ? scene.o_history : [],
      play_duration: scene.play_duration || 0,
      last_played_at: scene.last_played_at || null,
      play_history: [],
      files: [{ basename: scene.files?.[0]?.basename || '' }],
      paths: { screenshot: scene.paths?.screenshot || '' },
    }
  }

  // Scenes for the stats, without play history (fast)
  async function getScenesWithOHistory() {
    const data = await callGQL({
      query: `query {
        findScenes(scene_filter: ${ACTIVE_SCENES_FILTER}, filter: { per_page: -1 }) {
          scenes {
            id
            title
            o_counter
            o_history
            play_duration
            last_played_at
            files { basename }
            paths { screenshot }
          }
        }
      }`,
    })
    return (data.findScenes?.scenes || []).map(sanitizeScene)
  }

  // Adds play history to the scenes from getScenesWithOHistory. Only IDs
  // and timestamps are downloaded, for scenes that have been played.
  async function addPlayHistory(scenes) {
    const data = await callGQL({
      query: `query {
        findScenes(
          scene_filter: { play_count: { value: 0, modifier: GREATER_THAN } }
          filter: { per_page: -1 }
        ) {
          scenes { id play_history }
        }
      }`,
    })
    const historyById = new Map(
      (data.findScenes?.scenes || []).map((scene) => [
        scene.id,
        scene.play_history || [],
      ]),
    )
    scenes.forEach((scene) => {
      scene.play_history = historyById.get(scene.id) || []
    })
    return scenes
  }

  // ===== PAGE CHANGES =====
  // Stash is a single-page app, so pages change without a reload. One
  // watcher, run at most every 100ms, handles every page O Stats cares
  // about: the stats page and the scene player. (A timer rather than
  // requestAnimationFrame, which doesn't run in background tabs.)
  const pageHandlers = []
  let pageCheckQueued = false

  function onPageChange(handler) {
    pageHandlers.push(handler)
    queuePageCheck()
  }

  function queuePageCheck() {
    if (pageCheckQueued) return
    pageCheckQueued = true
    setTimeout(() => {
      pageCheckQueued = false
      pageHandlers.forEach((handler) => handler(window.location.pathname))
    }, 100)
  }

  // Stash's own navigation event, plus the browser's back/forward
  window.PluginApi?.Event?.addEventListener?.('stash:location', queuePageCheck)
  window.addEventListener('popstate', queuePageCheck)
  // Page content (like the scene player or the stats page) can appear a
  // moment after the address changes
  new MutationObserver(queuePageCheck).observe(document.body, {
    childList: true,
    subtree: true,
  })

  // ===== WATCH TIME TRACKING =====
  // Counts how long the main scene player actually plays. Time comes from
  // the player's own progress, so pauses, buffering, seeking and a computer
  // sleeping mid-video aren't counted. Seconds are collected here and sent
  // every minute, and whenever playback stops or the page is left; the
  // server adds them to the day's total (save_watch_data.py).

  const SAVE_INTERVAL_MS = 60000

  let pendingSeconds = 0 // watched but not saved yet
  let pendingDay = null // the day those seconds belong to

  function getTodayDate() {
    return getLocalDateString(new Date())
  }

  function isOnScenePage() {
    return /^\/scenes\/\d+/.test(window.location.pathname)
  }

  // Stash's main scene player, not previews or other plugins' videos
  function isMainScenePlayer(videoElement) {
    return !!videoElement?.closest('.scene-player-container')
  }

  function runPluginOperation(args, { keepalive = false } = {}) {
    return fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive lets the request finish while the page is closing
      keepalive,
      body: JSON.stringify({
        query: `mutation ($args: Map) {
          runPluginOperation(plugin_id: "ostats", args: $args)
        }`,
        variables: { args },
      }),
    }).then(async (response) => {
      const result = await response.json()
      if (!response.ok || result.errors) {
        throw new Error(
          result.errors?.[0]?.message || `HTTP ${response.status}`,
        )
      }
      return result.data.runPluginOperation
    })
  }

  function addPlayedSeconds(seconds) {
    const today = getTodayDate()
    // Past midnight: save what belongs to yesterday first
    if (pendingDay && pendingDay !== today) saveWatchTime()
    pendingDay = today
    pendingSeconds += seconds
  }

  // Send the whole seconds collected so far; the rest stays for next time
  function saveWatchTime({ keepalive = false } = {}) {
    const seconds = Math.floor(pendingSeconds)
    if (seconds <= 0) return
    const day = pendingDay
    pendingSeconds -= seconds

    runPluginOperation({ mode: 'add', day, seconds }, { keepalive })
      .then((total) => debugLog(`Saved ${seconds}s for ${day} (${total}s)`))
      .catch((err) => {
        console.error('[OStats] Failed to save watch time:', err)
        // Keep the seconds to try again with the next save
        if (pendingDay === day) pendingSeconds += seconds
      })
  }

  function trackPlayer(video) {
    if (video.dataset.ostatsTracking) return
    video.dataset.ostatsTracking = 'true'
    debugLog('Tracking scene player')

    let lastMediaTime = video.currentTime
    let lastClockTime = performance.now()

    function resetBaseline() {
      lastMediaTime = video.currentTime
      lastClockTime = performance.now()
    }

    video.addEventListener('timeupdate', () => {
      const now = performance.now()
      const played =
        (video.currentTime - lastMediaTime) / (video.playbackRate || 1)
      const elapsed = (now - lastClockTime) / 1000
      lastMediaTime = video.currentTime
      lastClockTime = now
      // Normal playback moves forward about as fast as the clock. Seeks
      // jump further (or backwards), so they're left out.
      if (played > 0 && played <= elapsed + 1 && isOnScenePage()) {
        addPlayedSeconds(played)
      }
    })
    video.addEventListener('seeking', resetBaseline)
    video.addEventListener('play', resetBaseline)
    video.addEventListener('pause', () => saveWatchTime())
    video.addEventListener('ended', () => saveWatchTime())
  }

  let wasOnScenePage = false
  onPageChange(() => {
    const onScenePage = isOnScenePage()
    // Left a scene page: save what was watched there
    if (wasOnScenePage && !onScenePage) saveWatchTime()
    wasOnScenePage = onScenePage
    if (!onScenePage) return

    const video = document.querySelector('.scene-player-container video')
    if (isMainScenePlayer(video)) trackPlayer(video)
  })

  setInterval(saveWatchTime, SAVE_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveWatchTime({ keepalive: true })
  })
  window.addEventListener('pagehide', () => saveWatchTime({ keepalive: true }))

  // The stats page reads the file directly; it is served as a plugin asset
  async function loadWatchTimeData() {
    try {
      const response = await fetch(
        `/plugin/ostats/assets/watch_data.json?t=${Date.now()}`,
        { cache: 'no-store' },
      )
      if (response.status === 404) return {}
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (e) {
      console.error('[OStats] Failed to load watch time:', e)
      return {}
    }
  }


  // ===== UI BUILDING BLOCKS =====
  // Styles live in ostats.css; elements only get classes here.
  function createEl(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.innerText = text
    return node
  }

  // Section with a small uppercase heading. Returns the section element.
  function createSection(parent, title, note) {
    const section = createEl('section', 'os-section')
    const head = createEl('div', 'os-section-head')
    head.appendChild(createEl('h3', 'os-section-title', title))
    if (note) head.appendChild(createEl('span', 'os-section-note', note))
    section.appendChild(head)
    parent.appendChild(section)
    return section
  }

  // Stat card: icon chip, big value, label and an optional sub line.
  // Returns the sub line element so callers can add links to it.
  function createStatCard(
    container,
    { icon, value, label, sub, accent, tooltip, href },
  ) {
    const card = createEl(href ? 'a' : 'div', 'os-card os-stat')
    if (href) card.href = href
    if (accent) card.style.setProperty('--os-accent', accent)
    if (tooltip) card.title = tooltip

    if (icon) card.appendChild(createEl('div', 'os-stat-icon', icon))
    card.appendChild(createEl('div', 'os-stat-value', value))
    card.appendChild(createEl('div', 'os-stat-label', label))
    const subEl = createEl('div', 'os-stat-sub', sub || '')
    if (!sub) subEl.style.display = 'none'
    card.appendChild(subEl)

    container.appendChild(card)
    return subEl
  }

  // Scene highlight card: cover image with the value and label on top and
  // the scene title underneath. Links to the scene.
  function createHighlightCard(container, scene, value, label, accent) {
    const card = createEl('a', 'os-card os-highlight')
    card.href = `/scenes/${scene.id}`
    if (accent) card.style.setProperty('--os-accent', accent)

    const media = createEl('div', 'os-highlight-media')
    const img = createEl('img')
    img.src = scene.paths.screenshot
    img.loading = 'lazy'
    img.alt = ''
    media.appendChild(img)

    const overlay = createEl('div', 'os-highlight-overlay')
    overlay.appendChild(createEl('div', 'os-highlight-value', value))
    overlay.appendChild(createEl('span', 'os-highlight-label', label))
    media.appendChild(overlay)
    card.appendChild(media)

    card.appendChild(createEl('div', 'os-highlight-title', getSceneTitle(scene)))
    container.appendChild(card)
  }

  function getSceneTitle(scene) {
    return (
      scene.title || (scene.files && scene.files[0]?.basename) || 'Untitled'
    )
  }

  // "1h 5m", "12m", "40s"
  function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m`
    if (seconds > 0) return `${Math.floor(seconds)}s`
    return '0m'
  }

  // Longer spans get days: "1d 17h 41m"
  function formatLongDuration(seconds) {
    const days = Math.floor(seconds / 86400)
    if (days === 0) return formatDuration(seconds)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${days}d ${hours}h ${minutes}m`
  }

  // Same units Stash uses on its own stats page: "143.9 GiB"
  function formatBytes(bytes) {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
    let value = bytes || 0
    let i = 0
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024
      i++
    }
    return `${i === 0 ? value : value.toFixed(1)} ${units[i]}`
  }

  function formatNumber(n) {
    return (n || 0).toLocaleString()
  }

  // "MM/DD/YY" from "YYYY-MM-DD"
  function formatShortDate(dayStr) {
    const [year, month, day] = dayStr.split('-')
    return `${month}/${day}/${year.slice(2)}`
  }

  // Parse "YYYY-MM-DD" as local midnight. new Date('YYYY-MM-DD') would be
  // UTC midnight, which is the previous evening west of UTC.
  function parseLocalDate(dayStr) {
    const [year, month, day] = dayStr.split('-').map(Number)
    return new Date(year, month - 1, day)
  }

  // Watch time per day as plain seconds (older data stored { totalTime })
  function getWatchSeconds(dayData) {
    if (dayData && typeof dayData === 'object' && 'totalTime' in dayData) {
      return dayData.totalTime || 0
    }
    return dayData || 0
  }

  // Helper function to get consistent YYYY-MM-DD date string in local timezone
  function getLocalDateString(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  // Show a YYYY-MM-DD day in the On This Day section and scroll to it
  function openDayInOnThisDay(dayStr) {
    const targetDate = parseLocalDate(dayStr)
    const now = new Date()
    const nowLocal = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const dayDiff = Math.round((targetDate - nowLocal) / (1000 * 60 * 60 * 24))

    if (window.onThisDayRender) {
      window.onThisDayRender(dayDiff)
    }

    const section = document.getElementById('on-this-day-section')
    if (section) {
      section.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  // Fill a stat card's sub line with "<label> <date>" where the date opens
  // that day in the On This Day section
  function setSubWithDayLink(subEl, label, dayStr) {
    subEl.innerText = label ? `${label} ` : ''
    subEl.style.display = ''

    const dateLink = createEl('span', 'os-day-link', formatShortDate(dayStr))
    dateLink.title = 'Open in On This Day'
    dateLink.addEventListener('click', () => openDayInOnThisDay(dayStr))
    subEl.appendChild(dateLink)
  }

  function openSceneInNewTab(sceneId) {
    window.open(`/scenes/${sceneId}`, '_blank', 'noopener,noreferrer')
  }

  // O history by day, built once and shared by every stat:
  //   dayMap:    day -> [{ scene, time }]
  //   dayTotals: day -> number of O's
  //   lastO:     scene id -> time of that scene's latest O (ms)
  function buildOHistoryDayMap(scenes) {
    const dayMap = new Map()
    const dayTotals = {}
    const lastO = new Map()

    scenes.forEach((scene) => {
      scene.o_history.forEach((timestamp) => {
        if (!timestamp) return
        const time = new Date(timestamp)
        if (isNaN(time.getTime())) return

        const day = getLocalDateString(time)
        if (!dayMap.has(day)) dayMap.set(day, [])
        dayMap.get(day).push({ scene, time })
        dayTotals[day] = (dayTotals[day] || 0) + 1

        if (time.getTime() > (lastO.get(scene.id) || 0)) {
          lastO.set(scene.id, time.getTime())
        }
      })
    })

    return { dayMap, dayTotals, lastO }
  }

  // orgasms today
  async function createOrgasmsToday(row, scenes, oHistoryCache) {
    // Get today in local timezone
    const now = new Date()
    const today = getLocalDateString(now) // YYYY-MM-DD format

    // Use pre-processed cache for instant lookup
    const todayCount = oHistoryCache.dayTotals[today] || 0

    createStatCard(row, {
      icon: '💦',
      value: todayCount,
      label: "O's Today",
      accent: 'var(--os-blue)',
    })
  }

  // watch time today
  function createWatchTimeTodayStat(row, watchTimeData) {
    const seconds = getWatchSeconds(watchTimeData[getTodayDate()])
    createStatCard(row, {
      icon: '📺',
      value: formatDuration(seconds),
      label: 'Watch Time Today',
      accent: 'var(--os-green)',
    })
  }

  // videos watched today: scenes played today or with an O today, counted
  // once each (the same count as On This Day)
  function createVideosWatchedToday(row, scenes, oHistoryCache) {
    const today = getTodayDate()
    const sceneIds = new Set()
    scenes.forEach((scene) => {
      if (
        scene.last_played_at &&
        getLocalDateString(new Date(scene.last_played_at)) === today
      ) {
        sceneIds.add(scene.id)
      }
    })
    ;(oHistoryCache.dayMap.get(today) || []).forEach((event) => {
      sceneIds.add(event.scene.id)
    })
    createStatCard(row, {
      icon: '🎞️',
      value: sceneIds.size,
      label: 'Videos Watched Today',
      accent: 'var(--os-amber)',
    })
  }

  // record session - day with longest watch time
  async function createWatchTimeToday(row, watchTimeData) {
    let maxDuration = 0
    let maxDay = null

    // Find day with most watch time
    Object.keys(watchTimeData).forEach((day) => {
      const duration = getWatchSeconds(watchTimeData[day])
      if (duration > maxDuration) {
        maxDuration = duration
        maxDay = day
      }
    })

    const subEl = createStatCard(row, {
      icon: '⌛',
      value: formatDuration(maxDuration),
      label: 'Most Time Spent in One Day',
      accent: 'var(--os-green)',
    })
    if (maxDay && maxDuration > 0) {
      setSubWithDayLink(subEl, 'on', maxDay)
    }
  }

  // Export/Import watch time data as JSON
  function createWatchTimeExportButton(row, oHistoryCache) {
    const container = createEl('div', 'os-toolbar')
    row.appendChild(container)

    // JSON Export Button
    const jsonBtn = createEl('button', 'os-btn', '💾 Export JSON')
    container.appendChild(jsonBtn)

    jsonBtn.addEventListener('click', async () => {
      jsonBtn.disabled = true
      jsonBtn.innerText = '⏳ Exporting...'

      try {
        const watchTimeData = await loadWatchTimeData()

        // Watch time and O count per day
        const cleanedData = {}
        Object.keys(watchTimeData)
          .sort()
          .forEach((day) => {
            cleanedData[day] = {
              seconds: getWatchSeconds(watchTimeData[day]),
              o_count: oHistoryCache.dayTotals[day] || 0,
            }
          })

        // Create JSON with metadata
        const exportData = {
          version: '3.0',
          exported: new Date().toISOString(),
          data: cleanedData,
          totalDays: Object.keys(cleanedData).length,
          totalSeconds: Object.values(cleanedData).reduce(
            (sum, dayData) => sum + dayData.seconds,
            0,
          ),
        }

        // Create download link
        const blob = new Blob([JSON.stringify(exportData, null, 2)], {
          type: 'application/json',
        })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `ostats-watch-time-${getTodayDate()}.json`
        document.body.appendChild(a)
        a.click()
        document.body.removeChild(a)
        URL.revokeObjectURL(url)

        jsonBtn.innerText = '✓ Exported!'
        setTimeout(() => {
          jsonBtn.innerText = '💾 Export JSON'
          jsonBtn.disabled = false
        }, 2000)
      } catch (error) {
        console.error('[OStats] Export failed:', error)
        jsonBtn.innerText = '✗ Export Failed'
        setTimeout(() => {
          jsonBtn.innerText = '💾 Export JSON'
          jsonBtn.disabled = false
        }, 2000)
      }
    })

    // Import JSON Button
    const importBtn = createEl('button', 'os-btn', '📥 Import JSON')
    container.appendChild(importBtn)

    // Help icon with tooltip (on the right)
    const helpIcon = createEl('div', 'os-help', '?')
    helpIcon.title =
      'Watch time data is stored on your Stash server and syncs across all devices. Use Export to backup your data to a JSON file and Import to restore it.'
    container.appendChild(helpIcon)

    importBtn.addEventListener('click', () => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = '.json'

      input.onchange = async (e) => {
        const file = e.target.files[0]
        if (!file) return

        importBtn.disabled = true
        importBtn.innerText = '⏳ Importing...'

        try {
          const text = await file.text()
          const importData = JSON.parse(text)

          // Exports wrap the days in "data"; very old backups are just the
          // days. The server reads every format O Stats has exported
          // ({ seconds, o_count }, "seconds,oCount" and plain numbers) and
          // keeps only the watch time; O counts come from Stash itself.
          const days =
            importData.data && typeof importData.data === 'object'
              ? importData.data
              : importData
          if (!days || typeof days !== 'object' || Array.isArray(days)) {
            throw new Error('Invalid file format')
          }

          // Replaces all watch time with the file's
          const importedDays = await runPluginOperation({
            mode: 'save',
            watch_data: JSON.stringify(days),
          })
          if (!importedDays) throw new Error('No days found in the file')

          importBtn.innerText = `✓ Imported ${importedDays} days`
          // Reload to show the imported data
          setTimeout(() => window.location.reload(), 1000)
        } catch (error) {
          console.error('[OStats] Import failed:', error)
          importBtn.innerText = '✗ Import Failed'
          setTimeout(() => {
            importBtn.innerText = '📥 Import JSON'
            importBtn.disabled = false
          }, 2000)
        }
      }

      input.click()
    })
  }

  // day with most orgasms
  async function createBestOrgasmDay(row, scenes, oHistoryCache) {
    // Use pre-processed totals
    const dayTotals = oHistoryCache.dayTotals

    const maxCount = Math.max(0, ...Object.values(dayTotals))
    // If multiple days tie for maxCount, choose the oldest (earliest) date.
    let bestDay = null
    if (maxCount > 0) {
      const daysWithMax = Object.keys(dayTotals).filter(
        (day) => dayTotals[day] === maxCount,
      )
      if (daysWithMax.length > 0) {
        // Dates are in YYYY-MM-DD so lexical sort gives chronological order
        daysWithMax.sort()
        bestDay = daysWithMax[0]
      }
    }

    const subEl = createStatCard(row, {
      icon: '☔',
      value: maxCount,
      label: "Most O's in One Day",
      accent: 'var(--os-purple)',
    })
    if (bestDay) {
      setSubWithDayLink(subEl, 'on', bestDay)
    }
  }

  // consecutive days streak
  async function createOrgasmStreak(row, scenes, oHistoryCache) {
    // Use pre-processed day set
    const daySet = new Set(Object.keys(oHistoryCache.dayTotals))

    const sortedDays = Array.from(daySet).sort().reverse()
    let streak = 0
    // Get today in local timezone
    const now = new Date()
    const todayStr = getLocalDateString(now)
    const hasOToday = daySet.has(todayStr)

    // Count consecutive days without an O starting from today
    let daysSinceLastO = 0
    if (!hasOToday) {
      // Count backwards from today until we find a day with an O
      // Cap at 30 days to prevent counting indefinitely if no O history exists
      const maxDaysToCheck = sortedDays.length > 0 ? 365 : 30
      for (let i = 0; i < maxDaysToCheck; i++) {
        const checkDate = new Date(now)
        checkDate.setDate(now.getDate() - i)
        const checkDateStr = getLocalDateString(checkDate)

        if (daySet.has(checkDateStr)) {
          // Found a day with an O, stop counting
          break
        }
        daysSinceLastO++
      }
    }

    // If no O today, start checking from yesterday
    const startOffset = hasOToday ? 0 : 1

    for (let i = 0; i < sortedDays.length; i++) {
      // Calculate expected date string
      const expectedDate = new Date(now)
      expectedDate.setDate(now.getDate() - (i + startOffset))
      const expectedDateStr = getLocalDateString(expectedDate)

      if (sortedDays[i] === expectedDateStr) {
        streak++
      } else {
        break
      }
    }

    // Calculate highest streak ever and track dates
    let highestStreak = 0
    let currentStreak = 0
    let highestStreakStart = null
    let highestStreakEnd = null
    let currentStreakStart = null
    const allSortedDays = Array.from(daySet).sort()

    for (let i = 0; i < allSortedDays.length; i++) {
      if (i === 0) {
        currentStreak = 1
        currentStreakStart = allSortedDays[i]
      } else {
        const prevDate = parseLocalDate(allSortedDays[i - 1])
        const currDate = parseLocalDate(allSortedDays[i])
        const dayDiff = Math.round(
          (currDate - prevDate) / (1000 * 60 * 60 * 24),
        )

        if (dayDiff === 1) {
          currentStreak++
        } else {
          if (currentStreak > highestStreak) {
            highestStreak = currentStreak
            highestStreakStart = currentStreakStart
            highestStreakEnd = allSortedDays[i - 1]
          }
          currentStreak = 1
          currentStreakStart = allSortedDays[i]
        }
      }
    }
    // Check final streak
    if (currentStreak > highestStreak) {
      highestStreak = currentStreak
      highestStreakStart = currentStreakStart
      highestStreakEnd = allSortedDays[allSortedDays.length - 1]
    }

    // Determine if we should show "No Nut Streak" mode (2 or more days without O)
    // Only activate if there's some O history (otherwise streak is just 0)
    const isNoNutMode =
      sortedDays.length > 0 && daysSinceLastO > 1 && !hasOToday

    let displayStreak
    let streakHeading
    let streakIcon
    if (isNoNutMode) {
      // No Nut Streak Counter mode
      displayStreak = daysSinceLastO
      streakHeading = 'No Nut Streak'
      streakIcon = '🥜'
    } else if (streak > 0 && !hasOToday) {
      // Show tombstone if there's a streak but no O today (streak will be lost)
      displayStreak = streak
      streakHeading = 'Streak'
      streakIcon = '🪦'
    } else {
      // Normal streak mode
      displayStreak = streak
      streakHeading = 'Streak'
      streakIcon = '🔥'
    }

    // Format tooltip with dates
    let tooltip = null
    if (highestStreak > 0 && highestStreakStart && highestStreakEnd) {
      const formatDate = (dateStr) => {
        const [year, month, day] = dateStr.split('-')
        return `${month}/${day}/${year}`
      }
      tooltip = `Highest Streak: ${highestStreak} days\n${formatDate(highestStreakStart)}\nto\n${formatDate(highestStreakEnd)}`
    }
    const subEl = createStatCard(row, {
      icon: streakIcon,
      value: displayStreak,
      label: streakHeading,
      accent: 'var(--os-orange)',
      tooltip,
    })

    // Best streak with its first and last day; the dates open On This Day
    if (highestStreak > 0 && highestStreakStart && highestStreakEnd) {
      setSubWithDayLink(
        subEl,
        `Best: ${highestStreak} day${highestStreak === 1 ? '' : 's'},`,
        highestStreakStart,
      )
      if (highestStreakEnd !== highestStreakStart) {
        subEl.append(' – ')
        const endLink = createEl(
          'span',
          'os-day-link',
          formatShortDate(highestStreakEnd),
        )
        endLink.title = 'Open in On This Day'
        endLink.addEventListener('click', () =>
          openDayInOnThisDay(highestStreakEnd),
        )
        subEl.appendChild(endLink)
      }
    }
  }

  // average O per minute of watch time (overall)
  async function createAverageOPerMinute(
    row,
    scenes,
    watchTimeData,
    oHistoryCache,
  ) {
    // Get total watch time in seconds and find first day with watch time
    let totalWatchTimeSeconds = 0
    let firstWatchDay = null

    const watchDays = Object.keys(watchTimeData).sort()
    if (watchDays.length > 0) {
      firstWatchDay = watchDays[0]
    }

    Object.values(watchTimeData).forEach((dayData) => {
      totalWatchTimeSeconds += getWatchSeconds(dayData)
    })

    // Count total O's only from first watch day onward using cache
    let totalOs = 0
    if (firstWatchDay) {
      Object.keys(oHistoryCache.dayTotals).forEach((day) => {
        if (day >= firstWatchDay) {
          totalOs += oHistoryCache.dayTotals[day]
        }
      })
    } else {
      // If no watch history, count all O's
      Object.values(oHistoryCache.dayTotals).forEach((count) => {
        totalOs += count
      })
    }

    // Convert to minutes
    const totalWatchTimeMinutes = totalWatchTimeSeconds / 60

    // Calculate average minutes per O
    let avgMinPerO = 0
    if (totalOs > 0) {
      avgMinPerO = totalWatchTimeMinutes / totalOs
    }

    // Format the display with time unit
    let displayText = '0s'
    if (avgMinPerO > 0) {
      if (avgMinPerO >= 60) {
        // Show hours
        const hours = avgMinPerO / 60
        displayText = hours.toFixed(1) + 'h'
      } else if (avgMinPerO >= 1) {
        // Show minutes
        if (avgMinPerO >= 10) {
          displayText = avgMinPerO.toFixed(1) + 'm'
        } else {
          displayText = avgMinPerO.toFixed(2) + 'm'
        }
      } else {
        // Show seconds
        const seconds = avgMinPerO * 60
        displayText = seconds.toFixed(0) + 's'
      }
    }

    createStatCard(row, {
      icon: '⏱️',
      value: displayText,
      label: 'Average min/O',
      sub: 'Watch time per O',
      accent: 'var(--os-pink)',
    })
  }

  // scene with most orgasms
  async function createMostOScene(row, scenes) {
    let maxScene = null
    let maxCount = 0

    scenes.forEach((scene) => {
      const count = scene.o_counter || 0
      if (count > maxCount) {
        maxCount = count
        maxScene = scene
      }
    })

    if (maxScene) {
      createHighlightCard(
        row,
        maxScene,
        `${maxCount} O's`,
        "Most O's",
        'var(--os-blue)',
      )
    }
  }

  // longest watched scene
  function createLongestWatchedScene(row, scenes) {
    let maxScene = null
    let maxDuration = 0

    scenes.forEach((scene) => {
      const duration = scene.play_duration || 0
      if (duration > maxDuration) {
        maxDuration = duration
        maxScene = scene
      }
    })

    if (maxScene) {
      const hours = Math.floor(maxDuration / 3600)
      const minutes = Math.floor((maxDuration % 3600) / 60)
      const seconds = Math.floor(maxDuration % 60)
      let timeStr = ''
      if (hours > 0) {
        timeStr = `${hours}h ${minutes}m`
      } else if (minutes > 0) {
        timeStr = `${minutes}m ${seconds}s`
      } else {
        timeStr = `${seconds}s`
      }
      createHighlightCard(
        row,
        maxScene,
        timeStr,
        'Longest Played',
        'var(--os-green)',
      )
    }
  }

  // The scene whose latest O is the newest (or the oldest)
  function findSceneByLastO(scenes, oHistoryCache, pickNewest) {
    let found = null
    let foundTime = null
    scenes.forEach((scene) => {
      const time = oHistoryCache.lastO.get(scene.id)
      if (!time) return
      if (foundTime === null || (pickNewest ? time > foundTime : time < foundTime)) {
        found = scene
        foundTime = time
      }
    })
    return found ? { scene: found, time: new Date(foundTime) } : null
  }

  // most recent O scene
  function createMostRecentOScene(row, scenes, oHistoryCache) {
    const result = findSceneByLastO(scenes, oHistoryCache, true)
    if (!result) return
    createHighlightCard(
      row,
      result.scene,
      formatTimeAgo(result.time),
      'Most Recent O',
      'var(--os-purple)',
    )
  }

  // oldest O scene: the scene whose latest O is the longest ago
  function createOldestOScene(row, scenes, oHistoryCache) {
    const result = findSceneByLastO(scenes, oHistoryCache, false)
    if (!result) return
    createHighlightCard(
      row,
      result.scene,
      formatTimeAgo(result.time),
      'Oldest O',
      'var(--os-amber)',
    )
  }

  // ===== CALENDARS =====
  // A calendar year as a grid: one column per week (Monday first), one
  // square per day, darker for more. Used for O's and for watch time.
  // Click a day to open it in On This Day.
  function createCalendarHeatmap(
    row,
    {
      title,
      accent,
      dayTotals,
      formatValue,
      formatTotal,
      streakLabel,
      gapLabel,
      gapNoun,
    },
  ) {
    const activeDayKeys = Object.keys(dayTotals)
      .filter((day) => dayTotals[day] > 0)
      .sort()
    const firstActiveDay = activeDayKeys[0] || null

    const card = createEl('div', 'os-card os-chart os-heatmap')
    card.style.setProperty('--os-accent', accent)
    row.appendChild(card)

    const head = createEl('div', 'os-chart-head')
    const titleWrap = createEl('div')
    titleWrap.appendChild(createEl('h4', 'os-chart-title', title))
    const totalEl = createEl('div', 'os-chart-total')
    titleWrap.appendChild(totalEl)
    head.appendChild(titleWrap)

    const pager = createEl('div', 'os-pager')
    const prevBtn = createEl('button', 'os-btn os-btn-icon', '‹')
    prevBtn.title = 'Previous year'
    const periodLabel = createEl('span', 'os-pager-label')
    const nextBtn = createEl('button', 'os-btn os-btn-icon', '›')
    nextBtn.title = 'Next year'
    pager.append(prevBtn, periodLabel, nextBtn)
    head.appendChild(pager)
    card.appendChild(head)

    // The grid scrolls sideways on narrow screens instead of shrinking
    const scroller = createEl('div', 'os-heatmap-scroll')
    card.appendChild(scroller)

    const foot = createEl('div', 'os-heatmap-foot')
    card.appendChild(foot)

    // The year shown; starts on the current year
    let year = new Date().getFullYear()
    const firstYear = firstActiveDay
      ? parseLocalDate(firstActiveDay).getFullYear()
      : year

    prevBtn.addEventListener('click', () => {
      if (year > firstYear) {
        year--
        render()
      }
    })
    nextBtn.addEventListener('click', () => {
      if (year < new Date().getFullYear()) {
        year++
        render()
      }
    })

    // Shade 0-4: nothing, then four steps relative to the busiest day
    function getLevel(value, maxValue) {
      if (value <= 0) return 0
      return Math.min(4, Math.ceil((value / maxValue) * 4))
    }

    function formatDayLong(date) {
      return date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    }

    function plural(n, word) {
      return `${n} ${word}${n === 1 ? '' : 's'}`
    }

    const dayMs = 1000 * 60 * 60 * 24
    const daysBetween = (a, b) =>
      Math.round((parseLocalDate(b) - parseLocalDate(a)) / dayMs)

    // Longest run of days with nothing, all time. Counting starts at the
    // first active day ever, so the days before it don't count. The run that
    // is still going (since the last active day) counts up to and including
    // today.
    function getLongestGap(todayStr) {
      if (!firstActiveDay) return null

      let longest = { days: 0, from: null, to: null }
      for (let i = 1; i < activeDayKeys.length; i++) {
        const gap = daysBetween(activeDayKeys[i - 1], activeDayKeys[i]) - 1
        if (gap > longest.days) {
          longest = {
            days: gap,
            from: activeDayKeys[i - 1],
            to: activeDayKeys[i],
          }
        }
      }

      const lastActiveDay = activeDayKeys[activeDayKeys.length - 1]
      const sinceLast = daysBetween(lastActiveDay, todayStr)
      if (lastActiveDay !== todayStr && sinceLast > longest.days) {
        longest = { days: sinceLast, from: lastActiveDay, to: null }
      }
      return longest
    }

    function render() {
      const now = new Date()
      const todayStr = getLocalDateString(now)
      const thisYear = now.getFullYear()

      // Monday on or before Jan 1 through the Sunday on or after Dec 31
      const jan1 = new Date(year, 0, 1)
      const start = new Date(jan1)
      start.setDate(1 - ((jan1.getDay() + 6) % 7))
      const dec31 = new Date(year, 11, 31)
      const end = new Date(dec31)
      end.setDate(31 + ((7 - dec31.getDay()) % 7))
      const weeks = Math.round((end - start) / (dayMs * 7)) + 1

      const days = []
      for (let i = 0; i < weeks * 7; i++) {
        const date = new Date(start)
        date.setDate(start.getDate() + i)
        const key = getLocalDateString(date)
        days.push({
          date,
          key,
          value: dayTotals[key] || 0,
          isOutside: date.getFullYear() !== year,
          isFuture: key > todayStr,
          isToday: key === todayStr,
        })
      }

      periodLabel.innerText = String(year)
      prevBtn.disabled = year <= firstYear
      nextBtn.disabled = year >= thisYear

      const yearDays = days.filter((day) => !day.isOutside && !day.isFuture)
      const total = yearDays.reduce((sum, day) => sum + day.value, 0)
      totalEl.innerHTML = ''
      totalEl.append(createEl('strong', '', formatTotal(total)), ` in ${year}`)

      const maxValue = Math.max(1, ...yearDays.map((day) => day.value))

      // Grid: weekday labels, month labels across the top, then the days
      scroller.innerHTML = ''
      const grid = createEl('div', 'os-heatmap-grid')
      grid.style.setProperty('--os-weeks', weeks)
      scroller.appendChild(grid)

      ;['Mon', '', 'Wed', '', 'Fri', '', 'Sun'].forEach((label, i) => {
        const weekday = createEl('div', 'os-heatmap-weekday', label)
        weekday.style.gridRow = String(i + 2)
        grid.appendChild(weekday)
      })

      // Label the column holding the 1st of each month
      for (let month = 0; month < 12; month++) {
        const first = new Date(year, month, 1)
        const week = Math.floor(Math.round((first - start) / dayMs) / 7)
        const monthLabel = createEl(
          'div',
          'os-heatmap-month',
          first.toLocaleDateString('en-US', { month: 'short' }),
        )
        monthLabel.style.gridColumn = String(week + 2)
        grid.appendChild(monthLabel)
      }

      let todayCell = null
      days.forEach((day, i) => {
        const cell = createEl('div', 'os-heatmap-cell')
        cell.style.gridColumn = String(Math.floor(i / 7) + 2)
        cell.style.gridRow = String((i % 7) + 2)
        if (day.isOutside) {
          // Days from the neighbouring years in the first and last week
          cell.classList.add('is-outside')
        } else if (day.isFuture) {
          // Rest of the year still shows, as empty days
          cell.classList.add('is-future')
          cell.dataset.level = '0'
          cell.title = formatDayLong(day.date)
        } else {
          cell.dataset.level = String(getLevel(day.value, maxValue))
          cell.title = `${formatDayLong(day.date)}: ${formatValue(day.value)}`
          cell.addEventListener('click', () => openDayInOnThisDay(day.key))
        }
        if (day.isToday) {
          cell.classList.add('is-today')
          todayCell = cell
        }
        grid.appendChild(cell)
      })

      // On narrow screens, start with today in view (or January for
      // past years)
      scroller.scrollLeft = todayCell
        ? todayCell.offsetLeft - scroller.clientWidth / 2
        : 0

      // Footer: highlights for the year, the all-time longest gap and the
      // legend
      foot.innerHTML = ''
      const facts = createEl('div', 'os-heatmap-facts')
      foot.appendChild(facts)

      function addFact(label, value, links = []) {
        const fact = createEl('span', 'os-heatmap-fact')
        fact.appendChild(createEl('span', '', `${label} `))
        fact.appendChild(createEl('strong', '', value))
        links.forEach(([text, dayKey]) => {
          fact.append(text)
          if (!dayKey) return
          const link = createEl('span', 'os-day-link', formatShortDate(dayKey))
          link.title = 'Open in On This Day'
          link.addEventListener('click', () => openDayInOnThisDay(dayKey))
          fact.appendChild(link)
        })
        facts.appendChild(fact)
        return fact
      }

      if (total > 0) {
        // Best day (earliest if tied)
        let best = yearDays[0]
        yearDays.forEach((day) => {
          if (day.value > best.value) best = day
        })
        addFact('Best day', formatValue(best.value), [[' on ', best.key]])

        // Longest run of active days in a row, with its first and last day
        let longest = { days: 0, from: null, to: null }
        let runStart = null
        yearDays.forEach((day, i) => {
          if (day.value > 0) {
            if (runStart === null) runStart = i
            const length = i - runStart + 1
            if (length > longest.days) {
              longest = {
                days: length,
                from: yearDays[runStart].key,
                to: day.key,
              }
            }
          } else {
            runStart = null
          }
        })
        addFact(
          streakLabel,
          plural(longest.days, 'day'),
          longest.days > 1
            ? longest.to === todayStr
              ? [[' since ', longest.from], [' (still going)', null]]
              : [
                  [' between ', longest.from],
                  [' and ', longest.to],
                ]
            : [[' on ', longest.from]],
        )
      } else {
        facts.appendChild(
          createEl('span', 'os-heatmap-fact', `Nothing in ${year}`),
        )
      }

      // All time, so it is the same whichever year is shown
      const gap = getLongestGap(todayStr)
      if (gap && gap.days > 0) {
        const fact = addFact(
          gapLabel,
          plural(gap.days, 'day'),
          gap.to
            ? [
                [' between ', gap.from],
                [' and ', gap.to],
              ]
            : [[' since ', gap.from], [' (still going)', null]],
        )
        fact.title = `All time, counted from your first logged ${gapNoun} on ${formatShortDate(firstActiveDay)}`
      }

      const legend = createEl('div', 'os-heatmap-legend')
      legend.appendChild(createEl('span', '', 'Less'))
      for (let level = 0; level <= 4; level++) {
        const swatch = createEl('i', 'os-heatmap-cell')
        swatch.dataset.level = String(level)
        legend.appendChild(swatch)
      }
      legend.appendChild(createEl('span', '', 'More'))
      foot.appendChild(legend)
    }

    render()
  }

  // O's per day
  function createOHeatmap(row, oHistoryCache) {
    const plural = (n) => `${n} O${n === 1 ? '' : "'s"}`
    createCalendarHeatmap(row, {
      title: 'O Calendar',
      accent: 'var(--os-blue)',
      dayTotals: oHistoryCache.dayTotals,
      formatValue: plural,
      formatTotal: plural,
      streakLabel: 'Longest O streak',
      gapLabel: 'Longest no-fap streak',
      gapNoun: 'O',
    })
  }

  // Watch time per day
  function createWatchHeatmap(row, watchTimeData) {
    const dayTotals = {}
    Object.keys(watchTimeData).forEach((day) => {
      dayTotals[day] = getWatchSeconds(watchTimeData[day])
    })
    createCalendarHeatmap(row, {
      title: 'Watch Calendar',
      accent: 'var(--os-green)',
      dayTotals,
      formatValue: (seconds) =>
        seconds > 0 ? `${formatDuration(seconds)} watched` : 'Nothing watched',
      formatTotal: (total) => `${formatDuration(total)} watched`,
      streakLabel: 'Longest watch streak',
      gapLabel: 'Longest break',
      gapNoun: 'watch',
    })
  }

  // Stash's own numbers from its Stats page, shown in O Stats' All Time
  // and Library sections instead of Stash's rows
  async function getLibraryStats() {
    try {
      const data = await callGQL({
        query: `query {
          stats {
            scene_count
            scenes_size
            scenes_duration
            image_count
            images_size
            gallery_count
            performer_count
            studio_count
            group_count
            tag_count
            total_o_count
            total_play_duration
            total_play_count
            scenes_played
          }
        }`,
      })
      return data.stats
    } catch (e) {
      console.warn('[OStats] Failed to load library stats:', e)
      return null
    }
  }

  function createAllTimeStats(grid, stats) {
    createStatCard(grid, {
      icon: '💦',
      value: formatNumber(stats.total_o_count),
      label: "Total O's",
      accent: 'var(--os-blue)',
    })
    createStatCard(grid, {
      icon: '▶️',
      value: formatNumber(stats.total_play_count),
      label: 'Total Plays',
      accent: 'var(--os-amber)',
    })
    createStatCard(grid, {
      icon: '🕒',
      value: formatDuration(stats.total_play_duration),
      label: 'Total Play Duration',
      accent: 'var(--os-green)',
    })
  }

  function createLibraryStats(grid, stats) {
    const tiles = [
      {
        icon: '🎞️',
        value: formatNumber(stats.scene_count),
        label: 'Scenes',
        sub: `${formatBytes(stats.scenes_size)} · ${formatLongDuration(
          stats.scenes_duration,
        )}`,
        href: '/scenes',
      },
      {
        icon: '🖼️',
        value: formatNumber(stats.image_count),
        label: 'Images',
        sub: formatBytes(stats.images_size),
        href: '/images',
      },
      {
        icon: '📚',
        value: formatNumber(stats.gallery_count),
        label: 'Galleries',
        href: '/galleries',
      },
      {
        icon: '👤',
        value: formatNumber(stats.performer_count),
        label: 'Performers',
        href: '/performers',
      },
      {
        icon: '🏢',
        value: formatNumber(stats.studio_count),
        label: 'Studios',
        href: '/studios',
      },
      {
        icon: '🗂️',
        value: formatNumber(stats.group_count),
        label: 'Groups',
        href: '/groups',
      },
      {
        icon: '🏷️',
        value: formatNumber(stats.tag_count),
        label: 'Tags',
        href: '/tags',
      },
    ]
    tiles.forEach((tile) =>
      createStatCard(grid, { ...tile, accent: 'var(--os-gray)' }),
    )
  }

  // helper to format time ago
  function formatTimeAgo(date) {
    const now = new Date()
    const diffMs = now - date
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)
    const diffMonths = Math.floor(diffDays / 30)
    const diffYears = Math.floor(diffDays / 365)

    if (diffMins < 60) {
      return `${diffMins}m ago`
    } else if (diffHours < 24) {
      return `${diffHours}h ago`
    } else if (diffDays < 30) {
      return `${diffDays}d ago`
    } else if (diffMonths < 12) {
      return `${diffMonths}mo ago`
    } else {
      return `${diffYears}y ago`
    }
  }

  // ===== CHARTS =====
  // One bar chart used by both the O's and watch time graphs. Week and
  // month views show days (click a day to open it in On This Day); the year
  // view shows months (click a month to switch to it).
  function createBarChart(
    row,
    { title, accent, dayTotals, formatValue, formatTotal },
  ) {
    const card = createEl('div', 'os-card os-chart')
    card.style.setProperty('--os-accent', accent)
    row.appendChild(card)

    // Header: title and period total on the left, view switcher on the right
    const head = createEl('div', 'os-chart-head')
    card.appendChild(head)
    const titleWrap = createEl('div')
    titleWrap.appendChild(createEl('h4', 'os-chart-title', title))
    const totalEl = createEl('div', 'os-chart-total')
    titleWrap.appendChild(totalEl)
    head.appendChild(titleWrap)

    const switcher = createEl('div', 'os-segmented')
    head.appendChild(switcher)
    const viewButtons = {}
    ;[
      ['week', 'Week'],
      ['month', 'Month'],
      ['year', 'Year'],
    ].forEach(([view, label]) => {
      const btn = createEl('button', '', label)
      btn.type = 'button'
      btn.addEventListener('click', () => {
        offset = 0
        renderChart(view)
      })
      switcher.appendChild(btn)
      viewButtons[view] = btn
    })

    const plot = createEl('div', 'os-chart-plot')
    card.appendChild(plot)

    // Footer: previous / period label / next
    const foot = createEl('div', 'os-chart-foot')
    const pager = createEl('div', 'os-pager')
    const prevBtn = createEl('button', 'os-btn os-btn-icon', '‹')
    prevBtn.title = 'Previous'
    const periodLabel = createEl('span', 'os-pager-label')
    const nextBtn = createEl('button', 'os-btn os-btn-icon', '›')
    nextBtn.title = 'Next'
    pager.append(prevBtn, periodLabel, nextBtn)
    foot.appendChild(pager)
    card.appendChild(foot)

    let currentView = 'week'
    // 0 = the current week/month/year, -1 = the one before, etc.
    let offset = 0

    prevBtn.addEventListener('click', () => {
      offset--
      renderChart(currentView)
    })
    nextBtn.addEventListener('click', () => {
      if (offset < 0) {
        offset++
        renderChart(currentView)
      }
    })

    function getPeriodData(view) {
      const now = new Date()
      const todayStr = getLocalDateString(now)
      const data = []
      let label = ''
      let totalText = ''

      if (view === 'week') {
        // Monday of the selected week
        const dayOfWeek = now.getDay()
        const diff = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
        const monday = new Date(now)
        monday.setDate(now.getDate() + diff + offset * 7)
        monday.setHours(0, 0, 0, 0)
        const sunday = new Date(monday)
        sunday.setDate(monday.getDate() + 6)
        const short = { month: 'short', day: 'numeric' }
        label = `${monday.toLocaleDateString('en-US', short)} – ${sunday.toLocaleDateString('en-US', short)}`
        totalText = offset === 0 ? 'this week' : `for ${label}`

        for (let i = 0; i < 7; i++) {
          const date = new Date(monday)
          date.setDate(monday.getDate() + i)
          const dayStr = getLocalDateString(date)
          data.push({
            key: dayStr,
            value: dayTotals[dayStr] || 0,
            label: `${date.toLocaleDateString('en-US', { weekday: 'short' })} ${date.getDate()}`,
            isCurrent: dayStr === todayStr,
          })
        }
      } else if (view === 'month') {
        const target = new Date(now.getFullYear(), now.getMonth() + offset, 1)
        const daysInMonth = new Date(
          target.getFullYear(),
          target.getMonth() + 1,
          0,
        ).getDate()
        label = target.toLocaleDateString('en-US', {
          month: 'long',
          year: 'numeric',
        })
        totalText = offset === 0 ? 'this month' : `in ${label}`

        for (let i = 1; i <= daysInMonth; i++) {
          const dayStr = getLocalDateString(
            new Date(target.getFullYear(), target.getMonth(), i),
          )
          data.push({
            key: dayStr,
            value: dayTotals[dayStr] || 0,
            label: String(i),
            isCurrent: dayStr === todayStr,
          })
        }
      } else {
        const targetYear = now.getFullYear() + offset
        const monthTotals = new Array(12).fill(0)
        Object.keys(dayTotals).forEach((dayStr) => {
          const date = parseLocalDate(dayStr)
          if (date.getFullYear() === targetYear) {
            monthTotals[date.getMonth()] += dayTotals[dayStr]
          }
        })
        label = String(targetYear)
        totalText = offset === 0 ? 'this year' : `in ${label}`

        for (let i = 0; i < 12; i++) {
          data.push({
            key: `${targetYear}-${i}`,
            month: i,
            year: targetYear,
            value: monthTotals[i],
            label: new Date(targetYear, i, 1).toLocaleDateString('en-US', {
              month: 'short',
            }),
            isCurrent: offset === 0 && i === now.getMonth(),
          })
        }
      }

      return { data, label, totalText }
    }

    function renderChart(view) {
      currentView = view
      Object.keys(viewButtons).forEach((key) => {
        viewButtons[key].classList.toggle('is-active', key === view)
      })

      const { data, label, totalText } = getPeriodData(view)
      periodLabel.innerText = label
      nextBtn.disabled = offset >= 0

      const total = data.reduce((sum, item) => sum + item.value, 0)
      totalEl.innerHTML = ''
      const strong = createEl('strong', '', formatTotal(total))
      totalEl.append(strong, ` ${totalText}`)

      const maxValue = Math.max(1, ...data.map((item) => item.value))

      plot.innerHTML = ''
      plot.classList.toggle('is-dense', data.length > 12)

      const grid = createEl('div', 'os-chart-grid')
      for (let i = 0; i < 4; i++) grid.appendChild(createEl('span'))
      plot.appendChild(grid)

      data.forEach((item) => {
        const col = createEl('div', 'os-chart-col')
        if (item.isCurrent) col.classList.add('is-current')
        plot.appendChild(col)

        const barArea = createEl('div', 'os-chart-bar-area')
        col.appendChild(barArea)

        if (item.value > 0) {
          barArea.appendChild(
            createEl('div', 'os-chart-value', formatValue(item.value)),
          )
        }
        const bar = createEl('div', 'os-chart-bar')
        bar.style.height = `${(item.value / maxValue) * 100}%`
        bar.style.minHeight = item.value > 0 ? '4px' : '0'
        barArea.appendChild(bar)

        col.appendChild(createEl('div', 'os-chart-label', item.label))

        if (item.value > 0) {
          col.classList.add('is-clickable')
          if (view === 'year') {
            bar.title = `Show ${item.label} ${item.year}`
            bar.addEventListener('click', () => {
              // Switch to the month view for the clicked month
              const now = new Date()
              offset =
                (item.year - now.getFullYear()) * 12 +
                (item.month - now.getMonth())
              renderChart('month')
            })
          } else {
            bar.title = 'Open in On This Day'
            bar.addEventListener('click', () => openDayInOnThisDay(item.key))
          }
        }
      })
    }

    renderChart('week')
  }

  // O's per day
  async function createWeeklyBarChart(row, scenes, oHistoryCache) {
    createBarChart(row, {
      title: "O's",
      accent: 'var(--os-blue)',
      dayTotals: oHistoryCache.dayTotals,
      formatValue: (value) => String(value),
      formatTotal: (total) => `${total} O${total === 1 ? '' : "'s"}`,
    })
  }

  // Watch time per day
  async function createWatchTimeBarChart(row, watchTimeData) {
    const dayTotals = {}
    Object.keys(watchTimeData).forEach((day) => {
      dayTotals[day] = getWatchSeconds(watchTimeData[day])
    })

    createBarChart(row, {
      title: 'Watch Time',
      accent: 'var(--os-green)',
      dayTotals,
      formatValue: formatDuration,
      formatTotal: (total) => `${formatDuration(total)} watched`,
    })
  }

  async function createOnThisDaySection(
    row,
    scenes,
    oHistoryCache,
    options = {},
  ) {
    const {
      watchTimeData = {},
      hideStats = false,
      expandedByDefault = false,
      timelineExpandedByDefault = false,
      hideTimelineOs = false,
      showTimelineWatches = false,
    } = options

    // Plays by day, built once instead of on every day change
    const playDayMap = new Map()
    scenes.forEach((scene) => {
      scene.play_history.forEach((timestamp) => {
        const time = new Date(timestamp)
        if (isNaN(time.getTime())) return
        const day = getLocalDateString(time)
        if (!playDayMap.has(day)) playDayMap.set(day, [])
        playDayMap.get(day).push({ scene, time })
      })
    })
    // Create main container
    const mainContainer = createEl('div', 'os-card os-otd')
    mainContainer.id = 'on-this-day-section'
    row.innerHTML = ''
    row.appendChild(mainContainer)

    // Track selected day offset (0 = today, -1 = yesterday, etc.)
    let selectedDayOffset = 0
    // Track expanded state of the video list and timeline
    let isExpanded = expandedByDefault
    let isTimelineExpanded = timelineExpandedByDefault

    // Function to render the day
    async function renderDay(dayOffset) {
      selectedDayOffset = dayOffset
      const now = new Date()
      const targetDate = new Date(now)
      targetDate.setDate(now.getDate() + dayOffset)
      const targetDay = getLocalDateString(targetDate) // YYYY-MM-DD format

      // The day's O's, oldest first
      const dayOs = (oHistoryCache.dayMap.get(targetDay) || [])
        .map(({ scene, time }) => ({ scene, time }))
        .sort((a, b) => a.time - b.time)

      // Everything watched that day: each O, plus plays that aren't within
      // 30 minutes of an O or another play of the same scene
      const daySceneEvents = dayOs.map(({ scene, time }) => ({
        scene,
        time,
        hasO: true,
      }))
      const NEARBY_MS = 30 * 60 * 1000
      ;(playDayMap.get(targetDay) || [])
        .slice()
        .sort((a, b) => a.time - b.time)
        .forEach(({ scene, time }) => {
          const isNearby = daySceneEvents.some(
            (event) =>
              event.scene.id === scene.id &&
              Math.abs(event.time - time) < NEARBY_MS,
          )
          if (!isNearby) daySceneEvents.push({ scene, time, hasO: false })
        })
      daySceneEvents.sort((a, b) => a.time - b.time)

      // Clear container
      mainContainer.innerHTML = ''
      const isToday = dayOffset === 0

      // Header: the date on the left, day navigation on the right
      const header = createEl('div', 'os-otd-head')
      mainContainer.appendChild(header)

      const dateWrap = createEl('div')
      dateWrap.appendChild(
        createEl(
          'div',
          'os-otd-date',
          isToday
            ? 'Today'
            : targetDate.toLocaleDateString('en-US', {
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              }),
        ),
      )
      dateWrap.appendChild(
        createEl(
          'div',
          'os-otd-weekday',
          isToday
            ? targetDate.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })
            : targetDate.toLocaleDateString('en-US', { weekday: 'long' }),
        ),
      )
      header.appendChild(dateWrap)

      const pager = createEl('div', 'os-pager')
      const prevDayBtn = createEl('button', 'os-btn os-btn-icon', '‹')
      prevDayBtn.title = 'Previous day'
      // Shows the day being viewed; click to jump back to today
      const todayBtn = createEl(
        'button',
        'os-btn',
        targetDate.toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
      )
      todayBtn.title = isToday ? 'Showing today' : 'Back to today'
      const nextDayBtn = createEl('button', 'os-btn os-btn-icon', '›')
      nextDayBtn.title = 'Next day'
      nextDayBtn.disabled = dayOffset >= 0
      pager.append(prevDayBtn, todayBtn, nextDayBtn)
      header.appendChild(pager)

      prevDayBtn.addEventListener('click', () => {
        renderDay(selectedDayOffset - 1)
      })
      todayBtn.addEventListener('click', () => {
        renderDay(0)
      })
      nextDayBtn.addEventListener('click', () => {
        if (selectedDayOffset < 0) {
          renderDay(selectedDayOffset + 1)
        }
      })

      // Content: 24-hour timeline on the left, video list on the right
      const contentContainer = createEl('div', 'os-otd-body')
      mainContainer.appendChild(contentContainer)

      // Expand / Collapse toggle used by both panels
      function createExpandButton(expanded, onToggle) {
        const button = createEl(
          'button',
          'os-btn',
          expanded ? 'Collapse ▲' : 'Expand ▼',
        )
        button.addEventListener('click', onToggle)
        return button
      }

      // Left side: 24-hour timeline
      const timelineContainer = createEl('div')
      contentContainer.appendChild(timelineContainer)

      const timelineHead = createEl('div', 'os-panel-head')
      timelineHead.appendChild(createEl('h5', 'os-panel-title', 'Timeline'))
      timelineHead.appendChild(
        createExpandButton(isTimelineExpanded, () => {
          isTimelineExpanded = !isTimelineExpanded
          renderDay(selectedDayOffset)
        }),
      )
      timelineContainer.appendChild(timelineHead)

      // Timeline visualization. Everything is placed inside an inner track
      // with some padding so markers at midnight aren't cut off.
      const timelineBox = createEl('div', 'os-timeline')
      timelineBox.style.height = isTimelineExpanded ? '600px' : '400px'
      timelineContainer.appendChild(timelineBox)
      const timelineViz = createEl('div')
      Object.assign(timelineViz.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        top: '16px',
        bottom: '16px',
      })
      timelineBox.appendChild(timelineViz)

      // Daytime / evening shading (6am-6pm is lighter)
      const dayShade = createEl('div')
      Object.assign(dayShade.style, {
        position: 'absolute',
        left: '0',
        right: '0',
        top: '25%',
        height: '50%',
        background: 'rgba(255, 255, 255, 0.03)',
        pointerEvents: 'none',
      })
      timelineViz.appendChild(dayShade)

      // Center vertical line
      const centerLine = createEl('div')
      Object.assign(centerLine.style, {
        position: 'absolute',
        left: '50%',
        top: '-16px',
        bottom: '-16px',
        width: '2px',
        background: 'rgba(255, 255, 255, 0.1)',
        transform: 'translateX(-50%)',
      })
      timelineViz.appendChild(centerLine)

      // Hour markers (every 3 hours) with faint guide lines
      for (let hour = 0; hour <= 24; hour += 3) {
        const top = `${(hour / 24) * 100}%`

        if (hour > 0 && hour < 24) {
          const guide = createEl('div')
          Object.assign(guide.style, {
            position: 'absolute',
            left: '0',
            right: '0',
            top,
            borderTop: '1px dashed rgba(255, 255, 255, 0.05)',
          })
          timelineViz.appendChild(guide)
        }

        let displayHour = hour % 12
        displayHour = displayHour === 0 ? 12 : displayHour
        const ampm = hour < 12 || hour === 24 ? 'am' : 'pm'
        const hourLabel = createEl('span', '', `${displayHour}${ampm}`)
        Object.assign(hourLabel.style, {
          position: 'absolute',
          left: '50%',
          top,
          transform: 'translate(-50%, -50%)',
          fontSize: '0.72rem',
          fontWeight: hour === 0 || hour === 12 || hour === 24 ? '700' : '500',
          color: 'var(--os-muted)',
          background: 'rgba(20, 26, 32, 0.9)',
          padding: '1px 6px',
          borderRadius: '999px',
          zIndex: '6',
        })
        timelineViz.appendChild(hourLabel)
      }

      // Timeline markers: blue for O's, gray for watches without an O.
      // Both are sorted together so they alternate sides by time.
      const timelineEvents = [
        ...(hideTimelineOs
          ? []
          : dayOs.map((o) => ({ time: o.time, scene: o.scene, isO: true }))),
        ...(showTimelineWatches
          ? daySceneEvents
              .filter((event) => !event.hasO)
              .map((event) => ({
                time: event.time,
                scene: event.scene,
                isO: false,
              }))
          : []),
      ].sort((a, b) => a.time - b.time)

      timelineEvents.forEach((event, index) => {
        const color = event.isO ? 'var(--os-blue)' : 'var(--os-gray)'
        const glow = event.isO
          ? 'rgba(76, 141, 255, 0.55)'
          : 'rgba(138, 148, 166, 0.45)'
        const hour = event.time.getHours()
        const minute = event.time.getMinutes()
        const timePercent = ((hour * 60 + minute) / (24 * 60)) * 100
        const onRight = index % 2 === 0

        // Connector line from center to marker
        const connector = createEl('div')
        Object.assign(connector.style, {
          position: 'absolute',
          left: '50%',
          top: `${timePercent}%`,
          width: '30px',
          height: '2px',
          background: color,
          transform: onRight
            ? 'translateY(-50%)'
            : 'translateY(-50%) translateX(-100%)',
          zIndex: event.isO ? '5' : '4',
        })
        timelineViz.appendChild(connector)

        const marker = createEl('div')
        Object.assign(marker.style, {
          position: 'absolute',
          left: onRight ? 'calc(50% + 30px)' : 'calc(50% - 48px)',
          top: `calc(${timePercent}% - 9px)`,
          width: '18px',
          height: '18px',
          background: color,
          borderRadius: '50%',
          border: '2px solid rgba(255, 255, 255, 0.9)',
          cursor: 'pointer',
          zIndex: event.isO ? '10' : '9',
          boxShadow: `0 0 0 3px ${glow.replace(/[\d.]+\)$/, '0.18)')}`,
          transition: 'transform 0.15s, box-shadow 0.15s',
        })

        let tooltipHour = hour % 12
        tooltipHour = tooltipHour === 0 ? 12 : tooltipHour
        const tooltipAmpm = hour < 12 ? 'am' : 'pm'
        const tooltipMinute = minute.toString().padStart(2, '0')
        marker.title = `${tooltipHour}:${tooltipMinute}${tooltipAmpm} - ${getSceneTitle(event.scene)}${event.isO ? '' : ' (watched)'}`

        // Thumbnail preview shown on hover, on the same side as the marker
        const thumbnailPreview = createEl('div')
        Object.assign(thumbnailPreview.style, {
          position: 'absolute',
          top: `calc(${timePercent}% - 34px)`,
          left: onRight ? 'calc(50% + 58px)' : 'calc(50% - 178px)',
          width: '120px',
          height: '67.5px',
          display: 'none',
          zIndex: '100',
          pointerEvents: 'none',
          border: `2px solid ${color}`,
          borderRadius: '8px',
          boxShadow: '0 8px 24px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
          background: '#000',
        })
        const thumbnailImg = createEl('img')
        thumbnailImg.src = event.scene.paths.screenshot
        Object.assign(thumbnailImg.style, {
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          display: 'block',
        })
        thumbnailPreview.appendChild(thumbnailImg)
        timelineViz.appendChild(thumbnailPreview)

        marker.addEventListener('mouseenter', () => {
          marker.style.transform = 'scale(1.3)'
          marker.style.boxShadow = `0 0 0 5px ${glow}`
          thumbnailPreview.style.display = 'block'
        })
        marker.addEventListener('mouseleave', () => {
          marker.style.transform = 'scale(1)'
          marker.style.boxShadow = `0 0 0 3px ${glow.replace(/[\d.]+\)$/, '0.18)')}`
          thumbnailPreview.style.display = 'none'
        })
        marker.addEventListener('click', () => {
          openSceneInNewTab(event.scene.id)
        })

        timelineViz.appendChild(marker)
      })

      // Legend, only needed when both marker colors are on
      const legend = createEl('div', 'os-legend')
      if (!hideTimelineOs && showTimelineWatches) {
        const item = createEl('span')
        const dot = createEl('i')
        dot.style.background = 'var(--os-blue)'
        item.append(dot, 'O')
        legend.appendChild(item)
      }
      if (!hideTimelineOs && showTimelineWatches) {
        const item = createEl('span')
        const dot = createEl('i')
        dot.style.background = 'var(--os-gray)'
        item.append(dot, 'Watched')
        legend.appendChild(item)
      }
      if (legend.children.length > 0) timelineContainer.appendChild(legend)

      // Right side: Video list
      const videoListContainer = createEl('div')
      contentContainer.appendChild(videoListContainer)

      const uniqueScenes = new Set(daySceneEvents.map((event) => event.scene.id))

      const videoListHead = createEl('div', 'os-panel-head')
      const videoListTitle = createEl('h5', 'os-panel-title', 'Videos Watched')
      videoListTitle.appendChild(
        createEl('span', 'os-count', String(daySceneEvents.length)),
      )
      videoListHead.appendChild(videoListTitle)
      videoListHead.appendChild(
        createExpandButton(isExpanded, () => {
          isExpanded = !isExpanded
          renderDay(selectedDayOffset)
        }),
      )
      videoListContainer.appendChild(videoListHead)

      // Expanded shows the whole list; collapsed scrolls inside a short box.
      const videoList = createEl(
        'div',
        isExpanded ? 'os-videos' : 'os-videos is-collapsed',
      )
      videoListContainer.appendChild(videoList)

      const targetDayWatchData = watchTimeData[targetDay]
      const watchTimeSeconds = getWatchSeconds(targetDayWatchData)

      // Add videos to list
      if (daySceneEvents.length === 0) {
        videoList.appendChild(
          createEl('div', 'os-empty', 'No videos watched on this day'),
        )
      } else {
        daySceneEvents.forEach(({ scene, time, hasO }) => {
          const videoItem = createEl('div', hasO ? 'os-video has-o' : 'os-video')
          videoItem.addEventListener('click', () => {
            openSceneInNewTab(scene.id)
          })
          videoList.appendChild(videoItem)

          const thumbnail = createEl('img')
          thumbnail.src = scene.paths.screenshot
          thumbnail.loading = 'lazy'
          thumbnail.alt = ''
          videoItem.appendChild(thumbnail)

          const infoContainer = createEl('div', 'os-video-info')
          infoContainer.appendChild(
            createEl('div', 'os-video-title', getSceneTitle(scene)),
          )
          videoItem.appendChild(infoContainer)

          // Format time as 12-hour with am/pm
          let hours = time.getHours()
          const minutes = time.getMinutes()
          const ampm = hours >= 12 ? 'pm' : 'am'
          hours = hours % 12
          hours = hours ? hours : 12 // 0 should be 12
          const timeStr = `${hours}:${minutes.toString().padStart(2, '0')}${ampm}`

          // Check if this scene has watch time on this day
          let watchTimeText = timeStr
          if (targetDayWatchData && targetDayWatchData.videos) {
            const videoData = targetDayWatchData.videos.find(
              (v) => String(v.id) === String(scene.id),
            )
            if (videoData && videoData.watchTime > 0) {
              const dayText = isToday ? 'today' : 'on this day'
              watchTimeText = `${timeStr} · ${formatDuration(videoData.watchTime)} watched ${dayText}`
            }
          }
          infoContainer.appendChild(
            createEl('div', 'os-video-meta', watchTimeText),
          )

          if (hasO) {
            videoItem.appendChild(createEl('span', 'os-video-emoji', '💦'))
          }
        })
      }

      // Summary strip at the bottom
      const summaryContainer = createEl('div', 'os-otd-stats')
      if (hideStats) summaryContainer.style.display = 'none'
      mainContainer.appendChild(summaryContainer)

      function addSummaryStat(value, label, accent) {
        const stat = createEl('div', 'os-otd-stat')
        stat.style.setProperty('--os-accent', accent)
        stat.appendChild(createEl('div', 'os-otd-stat-value', value))
        stat.appendChild(createEl('div', 'os-otd-stat-label', label))
        summaryContainer.appendChild(stat)
      }

      addSummaryStat(dayOs.length, "O's", 'var(--os-blue)')
      addSummaryStat(
        formatDuration(watchTimeSeconds),
        'Watch Time',
        'var(--os-green)',
      )
      addSummaryStat(uniqueScenes.size, 'Videos Watched', 'var(--os-amber)')

      // Average minutes per O for this day; only when there are O's
      if (dayOs.length > 0) {
        const avgMinPerO = watchTimeSeconds / 60 / dayOs.length
        let avgDisplayText = '0m'
        if (avgMinPerO > 0) {
          const avgHours = Math.floor(avgMinPerO / 60)
          const avgMins = Math.floor(avgMinPerO % 60)
          avgDisplayText =
            avgHours > 0 ? `${avgHours}h ${avgMins}m` : `${avgMins}m`
        }
        addSummaryStat(avgDisplayText, 'Avg min/O', 'var(--os-pink)')
      }
    }

    // Initial render with today
    renderDay(0)

    // Store the render function globally so graphs can trigger it
    window.onThisDayRender = renderDay
  }

  onPageChange((path) => {
    if (path !== '/stats') return
    const statsPage = document.querySelector('div.container-fluid div.mt-5')
    if (statsPage) setupStats(statsPage)
  })
  async function setupStats(el) {
    if (document.getElementById('ostats-root')) return

    // Stash's own rows are hidden by ostats.css; everything on the page is
    // drawn here inside one root
    const root = createEl('div', 'os')
    root.id = 'ostats-root'
    el.appendChild(root)

    // Page header
    const hero = createEl('header', 'os-hero')
    const heroTitle = createEl('div', 'os-hero-title')
    heroTitle.appendChild(createEl('div', 'os-hero-mark', '💦'))
    const heroText = createEl('div')
    heroText.appendChild(createEl('h2', '', 'O Stats'))
    heroText.appendChild(
      createEl(
        'div',
        'os-hero-sub',
        new Date().toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric',
          year: 'numeric',
        }),
      ),
    )
    heroTitle.appendChild(heroText)
    hero.appendChild(heroTitle)
    const settingsLink = createEl('a', 'os-btn', '⚙ Settings')
    settingsLink.href = '/settings?tab=plugins'
    settingsLink.title = 'O Stats settings are under Plugins'
    hero.appendChild(settingsLink)
    root.appendChild(hero)

    // Fast path: load lightweight stats data first.
    const [settings, scenes, watchTimeData, libraryStats] = await Promise.all([
      getPluginSettings(),
      getScenesWithOHistory(),
      loadWatchTimeData(),
      getLibraryStats(),
    ])

    // OPTIMIZATION: Pre-process O history for faster lookups
    const oHistoryCache = buildOHistoryDayMap(scenes)

    // Individual stats, skipped when their own setting is on. The whole-row
    // setting overrides these, so a hidden row never shows any of its stats.
    const todayStats = settings.hideTopStats
      ? []
      : [
          [
            settings.hideTopStatsOsToday,
            (row) => createOrgasmsToday(row, scenes, oHistoryCache),
          ],
          [
            settings.hideTopStatsStreak,
            (row) => createOrgasmStreak(row, scenes, oHistoryCache),
          ],
          [
            settings.hideTodayWatchTime,
            (row) => createWatchTimeTodayStat(row, watchTimeData),
          ],
          [
            settings.hideTodayVideosWatched,
            (row) => createVideosWatchedToday(row, scenes, oHistoryCache),
          ],
        ].filter(([hidden]) => !hidden)

    const allTimeRecords = settings.hideAllTimeStats
      ? []
      : [
          [
            settings.hideTopStatsRecordDay,
            (row) => createBestOrgasmDay(row, scenes, oHistoryCache),
          ],
          [
            settings.hideTopStatsRecordSession,
            (row) => createWatchTimeToday(row, watchTimeData),
          ],
          [
            settings.hideTopStatsAverageMinPerO,
            (row) =>
              createAverageOPerMinute(row, scenes, watchTimeData, oHistoryCache),
          ],
        ].filter(([hidden]) => !hidden)

    const sceneHighlights = settings.hideSceneHighlights
      ? []
      : [
          [
            settings.hideSceneHighlightsMostOs,
            (row) => createMostOScene(row, scenes),
          ],
          [
            settings.hideSceneHighlightsLongestPlay,
            (row) => createLongestWatchedScene(row, scenes),
          ],
          [
            settings.hideSceneHighlightsMostRecentO,
            (row) => createMostRecentOScene(row, scenes, oHistoryCache),
          ],
          [
            settings.hideSceneHighlightsOldestO,
            (row) => createOldestOScene(row, scenes, oHistoryCache),
          ],
        ].filter(([hidden]) => !hidden)

    // Sections are added in page order. A hidden section is never created,
    // so the spacing between the ones that are left stays even.
    if (todayStats.length > 0) {
      const section = createSection(root, 'Today')
      const grid = createEl('div', 'os-grid')
      section.appendChild(grid)
      for (const [, create] of todayStats) await create(grid)
    }

    // Stash's totals, then the records
    if (
      !settings.hideAllTimeStats &&
      (libraryStats || allTimeRecords.length > 0)
    ) {
      const section = createSection(root, 'All Time & Records')
      const grid = createEl('div', 'os-grid os-grid-row')
      section.appendChild(grid)
      if (libraryStats) createAllTimeStats(grid, libraryStats)
      for (const [, create] of allTimeRecords) await create(grid)
    }

    if (sceneHighlights.length > 0) {
      const section = createSection(root, 'Scene Highlights')
      const grid = createEl('div', 'os-highlights')
      section.appendChild(grid)
      for (const [, create] of sceneHighlights) await create(grid)
      // A highlight with no scene (no O's yet) adds nothing
      if (grid.children.length === 0) section.remove()
    }

    const showCharts =
      !settings.hideOGraph ||
      !settings.hideWatchTimeGraph ||
      !settings.hideOCalendar ||
      !settings.hideWatchCalendar
    if (showCharts) {
      const section = createSection(root, 'Activity')
      if (!settings.hideOGraph) {
        await createWeeklyBarChart(section, scenes, oHistoryCache)
      }
      if (!settings.hideWatchTimeGraph) {
        await createWatchTimeBarChart(section, watchTimeData)
      }
      if (!settings.hideOCalendar) {
        createOHeatmap(section, oHistoryCache)
      }
      if (!settings.hideWatchCalendar) {
        createWatchHeatmap(section, watchTimeData)
      }
    }

    let onThisDaySection = null
    if (!settings.hideOnThisDay) {
      onThisDaySection = createSection(root, 'On This Day')
      const loading = createEl(
        'div',
        'os-card os-otd-loading',
        'Loading On This Day…',
      )
      onThisDaySection.appendChild(loading)
    }

    if (settings.showLibraryStats && libraryStats) {
      const section = createSection(root, 'Library')
      const grid = createEl('div', 'os-grid os-grid-compact')
      section.appendChild(grid)
      createLibraryStats(grid, libraryStats)
    }

    if (!settings.hideExportImportButtons) {
      createWatchTimeExportButton(root, oHistoryCache)
    }

    if (!onThisDaySection) return

    // On This Day also needs play history, loaded after everything else
    const onThisDayBody = createEl('div')
    addPlayHistory(scenes)
      .then(async () => {
        onThisDaySection.querySelector('.os-otd-loading')?.remove()
        onThisDaySection.appendChild(onThisDayBody)
        await createOnThisDaySection(onThisDayBody, scenes, oHistoryCache, {
          watchTimeData,
          hideStats: settings.hideOnThisDayStats,
          expandedByDefault: settings.expandOnThisDayList,
          timelineExpandedByDefault: settings.expandOnThisDayTimeline,
          hideTimelineOs: settings.hideOnThisDayTimelineOs,
          showTimelineWatches: settings.showOnThisDayTimelineWatches,
        })
      })
      .catch((err) => {
        console.error('[OStats] Failed loading On This Day data:', err)
        const loading = onThisDaySection.querySelector('.os-otd-loading')
        if (loading) loading.innerText = 'Failed to load On This Day data.'
      })
  }
})()
