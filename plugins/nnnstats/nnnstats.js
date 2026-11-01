;(function () {
  // Reloading plugins in Stash runs this again without reloading the page.
  // The newest copy takes over, so there's only ever one top bar button and
  // watch time isn't counted twice.
  const instanceId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
  window.nnnstatsInstance = instanceId
  const isCurrentInstance = () => window.nnnstatsInstance === instanceId

  // ===== UTILITY FUNCTIONS =====

  // Extra console output for troubleshooting; turn on by running
  // localStorage.setItem('nnnstats_debug', '1') in the browser console
  const DEBUG = (() => {
    try {
      return localStorage.getItem('nnnstats_debug') === '1'
    } catch (e) {
      return false
    }
  })()
  function debugLog(...args) {
    if (DEBUG) console.log('[NNN]', ...args)
  }

  async function callGQL(query) {
    const response = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    })
    if (!response.ok) {
      throw new Error(`GraphQL request failed: ${response.statusText}`)
    }
    const result = await response.json()
    if (result.errors) {
      throw new Error(result.errors[0]?.message || 'GraphQL query failed')
    }
    return result.data
  }

  // Settings are defined in nnnstats.yml. Stash lists them sorted by key, so
  // the keys are numbered to keep them in order; the number is stripped off.
  async function getPluginSettings() {
    try {
      const data = await callGQL('query { configuration { plugins } }')
      const saved = data.configuration?.plugins?.nnnstats || {}
      const settings = {}
      Object.keys(saved).forEach((key) => {
        settings[key.replace(/^\d+[a-z]?_/, '')] = saved[key]
      })
      return settings
    } catch (e) {
      console.warn('[NNN] Failed to load plugin settings:', e)
      return {}
    }
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.innerText = text
    return node
  }

  function openInNewTab(link, href) {
    link.href = href
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
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

  // "9:42pm"
  function formatClock(date) {
    const hour = date.getHours()
    const minute = String(date.getMinutes()).padStart(2, '0')
    return `${hour % 12 || 12}:${minute}${hour < 12 ? 'am' : 'pm'}`
  }

  // "Thu, Nov 12"
  function formatDayShort(date) {
    return date.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  // YYYY-MM-DD in local time
  function getLocalDateString(date) {
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  function getTodayDate() {
    return getLocalDateString(new Date())
  }

  // Watch time per day as plain seconds (older O Stats data stored
  // { totalTime })
  function getWatchSeconds(dayData) {
    if (dayData && typeof dayData === 'object' && 'totalTime' in dayData) {
      return dayData.totalTime || 0
    }
    return Number(dayData) || 0
  }

  const plural = (n, word) =>
    `${n} ${word}${n === 1 ? '' : word === 'O' ? "'s" : 's'}`

  // ===== PAGE CHANGES =====
  // Stash is a single-page app, so pages change without a reload. One
  // watcher, run at most every 100ms, puts the top bar button back when
  // Stash redraws the bar and finds the scene player.
  const pageHandlers = []
  let pageCheckQueued = false

  function onPageChange(handler) {
    pageHandlers.push(handler)
    queuePageCheck()
  }

  function queuePageCheck() {
    if (pageCheckQueued || !isCurrentInstance()) return
    pageCheckQueued = true
    setTimeout(() => {
      pageCheckQueued = false
      pageHandlers.forEach((handler) => handler(window.location.pathname))
    }, 100)
  }

  window.PluginApi?.Event?.addEventListener?.('stash:location', queuePageCheck)
  window.addEventListener('popstate', queuePageCheck)
  new MutationObserver(queuePageCheck).observe(document.body, {
    childList: true,
    subtree: true,
  })

  // ===== DATA SOURCE =====
  // O Stats already tracks watch time, playback and image O's. When it's
  // installed its data is used and nothing is tracked here; otherwise No
  // Nut November tracks the same things itself (nnnsaver.py), in the same
  // layout. Both files are always read and merged, so history from before
  // O Stats was installed (or after it was removed) is kept.
  let dataSourcePromise = null
  function getDataSource() {
    if (!dataSourcePromise) {
      dataSourcePromise = (async () => {
        let plugins = []
        try {
          plugins = (await callGQL('query { plugins { id enabled } }')).plugins
        } catch (e) {
          // Older Stash versions don't say whether a plugin is enabled
          try {
            plugins = (await callGQL('query { plugins { id } }')).plugins
          } catch (e2) {
            console.warn('[NNN] Failed to list plugins:', e2)
          }
        }
        const ostats = (plugins || []).find((plugin) => plugin.id === 'ostats')
        return ostats && ostats.enabled !== false ? 'ostats' : 'nnnstats'
      })()
    }
    return dataSourcePromise
  }

  async function fetchDataFile(path) {
    try {
      const response = await fetch(`${path}?t=${Date.now()}`, {
        cache: 'no-store',
      })
      if (!response.ok) return null
      return await response.json()
    } catch (e) {
      return null
    }
  }

  // Watch time, image O's and playback from O Stats and from this plugin,
  // merged: the larger total for each day, every stretch once (by id) and
  // every image O once
  async function loadWatchData() {
    const [odata, legacy, own] = await Promise.all([
      fetchDataFile('/plugin/ostats/assets/odata.json'),
      fetchDataFile('/plugin/ostats/assets/watch_data.json'),
      fetchDataFile('/plugin/nnnstats/assets/nnndata.json'),
    ])
    const sources = [
      odata,
      !odata && legacy ? { watch_time: legacy } : null,
      own,
    ].filter((source) => source && typeof source === 'object')

    const watchTime = {}
    const imageOHistory = {}
    const playback = new Map()
    sources.forEach((source) => {
      Object.entries(source.watch_time || {}).forEach(([day, value]) => {
        watchTime[day] = Math.max(watchTime[day] || 0, getWatchSeconds(value))
      })
      Object.entries(source.image_o_history || {}).forEach(([id, times]) => {
        if (!Array.isArray(times)) return
        imageOHistory[id] = [...new Set([...(imageOHistory[id] || []), ...times])]
      })
      if (Array.isArray(source.playback)) {
        source.playback.forEach((stretch) => playback.set(stretch.id, stretch))
      }
    })
    return {
      found: sources.length > 0,
      watchTime,
      imageOHistory,
      playback: [...playback.values()],
    }
  }

  function runPluginOperation(args, { keepalive = false } = {}) {
    return fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive lets the request finish while the page is closing
      keepalive,
      body: JSON.stringify({
        query: `mutation ($args: Map) {
          runPluginOperation(plugin_id: "nnnstats", args: $args)
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

  // ===== WATCH TIME TRACKING =====
  // Only without O Stats, and the same way O Stats does it: time comes from
  // the main scene player's own progress, so pauses, buffering and seeking
  // aren't counted. Seconds are sent every minute and whenever playback
  // stops or the page is left, with the playback stretches (one scene played
  // with no break longer than a minute) the videos watched come from.
  //
  // A video's first 30 seconds are held, and dropped if another video
  // starts before then, unless Stash counts it as played (or it gets an O)
  // first, so videos clicked through aren't saved.
  let trackingOwn = false
  getDataSource().then((source) => {
    trackingOwn = source === 'nnnstats'
    debugLog(trackingOwn ? 'Tracking watch time' : 'Using O Stats data')
    queuePageCheck()
  })

  const SAVE_INTERVAL_MS = 60000
  const STRETCH_BREAK_MS = 60000
  const MIN_SAVED_SECONDS = 30

  let pendingSeconds = 0 // watched but not saved yet
  let pendingDay = null // the day those seconds belong to
  let currentStretch = null // the stretch playing now
  const unsavedStretches = new Map() // id -> stretch, changed since saved

  let visitSceneId = null // the video playing now
  let visitSaving = false // past its first 30 seconds, or counted
  let heldSeconds = 0
  const heldStretches = new Map()
  const countedScenes = new Set() // counted by Stash before playing here

  function isOnScenePage() {
    return /^\/scenes\/\d+/.test(window.location.pathname)
  }

  // The scene the player is actually playing, from its stream address. When
  // a video ends and the next one starts, the page moves on a moment before
  // the player does.
  function getVideoSceneId(video) {
    return (
      /\/scene\/(\d+)\/stream/.exec(video.currentSrc || '')?.[1] ||
      /^\/scenes\/(\d+)/.exec(window.location.pathname)?.[1] ||
      null
    )
  }

  // A different video: what was held for the last one is dropped
  function startVisit(sceneId) {
    if (sceneId === visitSceneId) return
    if (heldSeconds > 0) {
      debugLog(
        `Scene ${visitSceneId} played ${Math.round(heldSeconds)}s: not saved`,
      )
    }
    visitSceneId = sceneId
    // Carrying on after a reload, or already counted
    const recalled = recallStretch()
    visitSaving =
      countedScenes.delete(sceneId) ||
      (recalled?.scene === sceneId && !!recalled.saving)
    heldSeconds = 0
    heldStretches.clear()
  }

  function startSaving() {
    visitSaving = true
    if (heldSeconds > 0) addPlayedSeconds(heldSeconds)
    heldStretches.forEach((stretch, id) => {
      stretch.saving = true
      unsavedStretches.set(id, stretch)
    })
    heldSeconds = 0
    heldStretches.clear()
    if (currentStretch?.saving) rememberStretch(currentStretch)
  }

  // Stash counted a play of (or an O on) a scene
  function countScene(sceneId) {
    if (sceneId !== visitSceneId) {
      countedScenes.add(sceneId)
    } else if (!visitSaving) {
      debugLog(`Scene ${sceneId} counted by Stash: saving it`)
      startSaving()
    }
  }

  function addPlayed(seconds, sceneId) {
    if (!sceneId) return
    startVisit(sceneId)
    const stretch = addPlayedStretch(seconds, sceneId)
    if (visitSaving) {
      addPlayedSeconds(seconds)
      if (!stretch.saving) {
        stretch.saving = true
        rememberStretch(stretch)
      }
      unsavedStretches.set(stretch.id, stretch)
      return
    }
    heldSeconds += seconds
    heldStretches.set(stretch.id, stretch)
    if (heldSeconds >= MIN_SAVED_SECONDS) startSaving()
  }

  // The stretch playing now is remembered in this tab, so reloading the
  // page carries on with it instead of starting a new one
  const STRETCH_KEY = 'nnnstats_current_stretch'
  let stretchRememberedAt = 0
  function rememberStretch(stretch) {
    try {
      sessionStorage.setItem(STRETCH_KEY, JSON.stringify(stretch))
    } catch (e) {}
  }
  function recallStretch() {
    try {
      return JSON.parse(sessionStorage.getItem(STRETCH_KEY) || 'null')
    } catch (e) {
      return null
    }
  }

  function addPlayedStretch(seconds, sceneId) {
    const now = Date.now()
    if (!currentStretch) currentStretch = recallStretch()
    const isNew =
      !currentStretch ||
      currentStretch.scene !== sceneId ||
      now - currentStretch.endMs > STRETCH_BREAK_MS
    if (isNew) {
      currentStretch = {
        id: `${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        scene: sceneId,
        startMs: now - seconds * 1000,
        endMs: now,
        seconds: 0,
      }
    }
    currentStretch.endMs = now
    currentStretch.seconds += seconds
    if (isNew || now - stretchRememberedAt > 5000) {
      rememberStretch(currentStretch)
      stretchRememberedAt = now
    }
    return currentStretch
  }

  function addPlayedSeconds(seconds) {
    const today = getTodayDate()
    // Past midnight: save what belongs to yesterday first
    if (pendingDay && pendingDay !== today) saveWatchTime()
    pendingDay = today
    pendingSeconds += seconds
  }

  // Send the whole seconds collected so far (the rest stays for next time)
  // and the stretches that changed
  function saveWatchTime({ keepalive = false } = {}) {
    if (!trackingOwn) return
    if (currentStretch) rememberStretch(currentStretch)
    const seconds = Math.floor(pendingSeconds)
    const stretches = [...unsavedStretches.values()]
    if (seconds <= 0 && stretches.length === 0) return
    const day = pendingDay || getTodayDate()
    pendingSeconds -= Math.max(0, seconds)
    unsavedStretches.clear()

    const playback = stretches.map((stretch) => ({
      id: stretch.id,
      scene: stretch.scene,
      start: Math.floor(stretch.startMs / 1000),
      end: Math.ceil(stretch.endMs / 1000),
      seconds: Math.round(stretch.seconds),
    }))
    runPluginOperation(
      {
        mode: 'add',
        day,
        seconds: Math.max(0, seconds),
        playback: JSON.stringify(playback),
      },
      { keepalive },
    )
      .then((total) =>
        debugLog(
          `Saved ${seconds}s for ${day} (${total}s), ${playback.length} stretch(es)`,
        ),
      )
      .catch((err) => {
        console.error('[NNN] Failed to save watch time:', err)
        // Keep the seconds and stretches to try again with the next save
        if (pendingDay === day && seconds > 0) pendingSeconds += seconds
        stretches.forEach((stretch) => {
          if (!unsavedStretches.has(stretch.id)) {
            unsavedStretches.set(stretch.id, stretch)
          }
        })
      })
  }

  function trackPlayer(video) {
    if (video.dataset.nnnTracking === instanceId) return
    video.dataset.nnnTracking = instanceId
    debugLog('Tracking scene player')

    let lastMediaTime = video.currentTime
    let lastClockTime = performance.now()

    function resetBaseline() {
      lastMediaTime = video.currentTime
      lastClockTime = performance.now()
    }

    video.addEventListener('timeupdate', () => {
      if (!isCurrentInstance() || !trackingOwn) return
      const now = performance.now()
      const played =
        (video.currentTime - lastMediaTime) / (video.playbackRate || 1)
      const elapsed = (now - lastClockTime) / 1000
      lastMediaTime = video.currentTime
      lastClockTime = now
      // Normal playback moves forward about as fast as the clock. Seeks
      // jump further (or backwards), so they're left out.
      if (played > 0 && played <= elapsed + 1 && isOnScenePage()) {
        addPlayed(played, getVideoSceneId(video))
      }
    })
    video.addEventListener('seeking', resetBaseline)
    video.addEventListener('play', resetBaseline)
    video.addEventListener('pause', () => saveWatchTime())
    video.addEventListener('ended', () => saveWatchTime())
  }

  let wasOnScenePage = false
  onPageChange(() => {
    if (!trackingOwn) return
    const onScenePage = isOnScenePage()
    // Left a scene page: save what was watched there
    if (wasOnScenePage && !onScenePage) saveWatchTime()
    wasOnScenePage = onScenePage
    if (!onScenePage) return
    const video = document.querySelector('.scene-player-container video')
    if (video) trackPlayer(video)
  })

  setInterval(() => {
    if (isCurrentInstance()) saveWatchTime()
  }, SAVE_INTERVAL_MS)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && isCurrentInstance()) {
      saveWatchTime({ keepalive: true })
    }
  })
  window.addEventListener('pagehide', () => {
    if (isCurrentInstance()) saveWatchTime({ keepalive: true })
  })

  // ===== IMAGE O TRACKING =====
  // Also only without O Stats. Stash keeps only a count of O's for images,
  // so the time of each one is saved here once Stash confirms it, one at a
  // time in click order. A failed save is retried.
  const IMAGE_O_MUTATION = /\bimage(Increment|Decrement|Reset)O\b/
  const IMAGE_O_ACTIONS = {
    Increment: 'add',
    Decrement: 'remove',
    Reset: 'reset',
  }
  const IMAGE_O_RETRY_MS = 5000
  const pendingImageOs = []
  let sendingImageOs = false

  function queueImageO(imageId, action, time) {
    const change = { image_id: String(imageId), action, time, confirmed: false }
    pendingImageOs.push(change)
    return {
      confirm() {
        change.confirmed = true
        sendImageOs()
      },
      drop(reason) {
        console.warn(`[NNN] Image ${imageId}: ${action} O not saved:`, reason)
        const index = pendingImageOs.indexOf(change)
        if (index !== -1) pendingImageOs.splice(index, 1)
        sendImageOs()
      },
    }
  }

  async function sendImageOs() {
    if (sendingImageOs) return
    sendingImageOs = true
    try {
      while (pendingImageOs[0]?.confirmed) {
        const { confirmed, ...change } = pendingImageOs[0]
        await runPluginOperation({ mode: 'image_o', ...change })
        pendingImageOs.shift()
        debugLog(`Image ${change.image_id}: ${change.action} O saved`)
      }
    } catch (err) {
      console.error('[NNN] Failed to save image O, retrying:', err)
      setTimeout(sendImageOs, IMAGE_O_RETRY_MS)
    } finally {
      sendingImageOs = false
    }
  }

  // ===== STASH'S REQUESTS =====
  // Watched for O's (to update the top bar straight away) and, when
  // tracking here, for plays Stash counts and image O's
  const SCENE_COUNTED_MUTATION =
    /\bscene(AddPlay|IncrementPlayCount|AddO|IncrementO)\b/
  const O_CHANGED_MUTATION =
    /\b(scene(AddO|IncrementO|DeleteO|DecrementO|ResetO)|image(Increment|Decrement|Reset)O)\b/
  // Long enough for an image O to be saved (here or by O Stats) first
  const O_REFRESH_DELAY_MS = 3000

  const originalFetch = window.fetch
  window.fetch = function (input, init) {
    const request = originalFetch.apply(this, arguments)
    // The newest copy (wrapping this one) handles it
    if (!isCurrentInstance()) return request
    try {
      const body = typeof init?.body === 'string' ? init.body : ''
      if (!body.includes('mutation')) return request

      if (O_CHANGED_MUTATION.test(body)) {
        request
          .then(() => setTimeout(refreshStatus, O_REFRESH_DELAY_MS))
          .catch(() => {})
      }

      if (trackingOwn && SCENE_COUNTED_MUTATION.test(body)) {
        const sceneId = String(JSON.parse(body).variables?.id || '')
        if (sceneId) {
          request
            .then((response) => {
              if (response.ok) countScene(sceneId)
            })
            .catch(() => {})
        }
      }

      const match = trackingOwn && IMAGE_O_MUTATION.exec(body)
      if (match) {
        const { variables } = JSON.parse(body)
        // The time of the click, not of Stash's reply
        const time = new Date().toISOString()
        if (variables?.id) {
          const change = queueImageO(
            variables.id,
            IMAGE_O_ACTIONS[match[1]],
            time,
          )
          request
            .then(async (response) => {
              if (!response.ok) {
                change.drop(`Stash replied ${response.status}`)
                return
              }
              let result = null
              try {
                result = await response.clone().json()
              } catch (e) {
                debugLog("Couldn't read Stash's reply, saving anyway:", e)
              }
              if (result?.errors) change.drop(result.errors[0]?.message)
              else change.confirm()
            })
            .catch((err) => change.drop(err))
        }
      }
    } catch (e) {
      debugLog('Could not read a GraphQL request:', e)
    }
    return request
  }

  // ===== NO NUT NOVEMBER =====
  // From midnight on November 1 to midnight on December 1, local time. The
  // first O in that time ends it. Until November comes round, last year's is
  // the one shown.
  const MIN_STRETCH_SECONDS = 5
  // Stretches of one video this close together are one viewing
  const VIEWING_GAP_MS = 5 * 60 * 1000
  // An O goes with a viewing it came during or this soon after
  const O_GRACE_MS = 10 * 60 * 1000

  function currentYear() {
    const now = new Date()
    return now.getMonth() >= 10 ? now.getFullYear() : now.getFullYear() - 1
  }

  function periodOf(year) {
    return {
      year,
      start: new Date(year, 10, 1).getTime(),
      end: new Date(year, 11, 1).getTime(),
    }
  }

  // Every O as { time (ms), sceneId } or { time, imageId }, oldest first
  function collectOs(scenes, imageOHistory, settings) {
    const os = []
    scenes.forEach((scene) => {
      ;(scene.o_history || []).forEach((timestamp) => {
        const time = new Date(timestamp).getTime()
        if (!isNaN(time)) os.push({ time, sceneId: String(scene.id) })
      })
    })
    if (!settings.ignoreImageOs) {
      Object.keys(imageOHistory).forEach((imageId) => {
        imageOHistory[imageId].forEach((timestamp) => {
          const time = new Date(timestamp).getTime()
          if (!isNaN(time)) os.push({ time, imageId: String(imageId) })
        })
      })
    }
    return os.sort((a, b) => a.time - b.time)
  }

  // going: no O yet; failed: an O came first (until is its time); done:
  // made it to December
  function getStatus(period, os, now = Date.now()) {
    const firstO =
      os.find((o) => o.time >= period.start && o.time < period.end) || null
    if (firstO) return { state: 'failed', until: firstO.time, firstO }
    if (now >= period.end) return { state: 'done', until: period.end }
    return { state: 'going', until: Math.max(period.start, now) }
  }

  // How long it lasted up to t. Days by the calendar, so the hour the clocks
  // go back in November doesn't count, and the rest is the time of day.
  function lastedParts(period, t) {
    if (t >= period.end) return { days: 30, hours: 0, minutes: 0, seconds: 0 }
    const date = new Date(t)
    return {
      days: date.getDate() - 1,
      hours: date.getHours(),
      minutes: date.getMinutes(),
      seconds: date.getSeconds(),
    }
  }

  function formatLasted(parts) {
    return `${parts.days}d ${parts.hours}h ${parts.minutes}m`
  }

  // ===== TOP BAR BUTTON =====
  // 🥜 with the day you're on in November and December; 🪦 with how long
  // you lasted after an O, 🏆 if you made it. The rest of the year it's
  // just the icon.
  const NAV_ID = 'nnnstats-nav'
  document.getElementById(NAV_ID)?.remove()

  const navState = { os: [], settings: {}, loaded: false }

  // Only the times of O's, so this stays quick on every page load
  async function refreshStatus() {
    if (!isCurrentInstance()) return
    try {
      const [settings, data, watchData] = await Promise.all([
        getPluginSettings(),
        callGQL(`query {
          findScenes(
            scene_filter: { o_counter: { value: 0, modifier: GREATER_THAN } }
            filter: { per_page: -1 }
          ) { scenes { id o_history } }
        }`),
        loadWatchData(),
      ])
      navState.settings = settings
      navState.os = collectOs(
        data.findScenes?.scenes || [],
        watchData.imageOHistory,
        settings,
      )
      navState.loaded = true
      // The panel's numbers are only loaded when it opens
      if (panel) panel.data = null
    } catch (e) {
      console.warn('[NNN] Failed to load O history:', e)
    }
    updateNavButton()
  }

  function updateNavButton() {
    const button = document.getElementById(NAV_ID)
    if (!button) return
    const period = periodOf(currentYear())
    const now = Date.now()
    const status = getStatus(period, navState.os, now)
    const parts = lastedParts(period, status.until)
    // November and December; the rest of the year it's just the icon
    const inSeason = navState.loaded && now < period.end + 31 * 864e5
    const showLabel = inSeason && !navState.settings.hideNavbarTimer

    const icon = inSeason
      ? { going: '🥜', failed: '🪦', done: '🏆' }[status.state]
      : '🥜'
    button.querySelector('.nn-nav-icon').innerText = icon
    button.querySelector('.nn-nav-label').innerText = showLabel
      ? {
          going: `Day ${parts.days + 1}`,
          failed: `${parts.days}d ${parts.hours}h`,
          done: '30/30',
        }[status.state]
      : ''
    ;['going', 'failed', 'done'].forEach((state) =>
      button.classList.toggle(`is-${state}`, inSeason && status.state === state),
    )
    button.title = !inSeason
      ? 'No Nut November'
      : {
          going: `No Nut November: ${formatLasted(parts)} without an O`,
          failed: `No Nut November: you lasted ${formatLasted(parts)}`,
          done: 'No Nut November: you made it!',
        }[status.state]
  }

  function ensureNavButton() {
    if (document.getElementById(NAV_ID)) return
    const bar = document.querySelector('.navbar-buttons')
    if (!bar) return
    const button = createEl(
      'button',
      'btn btn-secondary minimal d-flex align-items-center h-100 nn-nav-btn',
    )
    button.id = NAV_ID
    button.type = 'button'
    button.appendChild(createEl('span', 'nn-nav-icon', '🥜'))
    button.appendChild(createEl('span', 'nn-nav-label'))
    button.addEventListener('click', openPanel)
    bar.prepend(button)
    updateNavButton()
  }

  onPageChange(ensureNavButton)
  refreshStatus()
  // The day and the timer move on; O's are checked again now and then in
  // case one came from another device
  setInterval(() => {
    if (isCurrentInstance()) updateNavButton()
  }, 30000)
  setInterval(refreshStatus, 10 * 60 * 1000)

  // ===== PANEL DATA =====
  // Scenes with an O or a play, with their history
  async function getScenes() {
    const data = await callGQL(`query {
      findScenes(
        scene_filter: {
          o_counter: { value: 0, modifier: GREATER_THAN }
          OR: { play_count: { value: 0, modifier: GREATER_THAN } }
        }
        filter: { per_page: -1 }
      ) {
        scenes {
          id
          title
          o_history
          play_history
          files { basename }
          paths { screenshot }
        }
      }
    }`)
    return (data.findScenes?.scenes || []).map((scene) => ({
      id: String(scene.id),
      title: scene.title || null,
      basename: scene.files?.[0]?.basename || '',
      screenshot: scene.paths?.screenshot || '',
      o_history: Array.isArray(scene.o_history) ? scene.o_history : [],
      play_history: Array.isArray(scene.play_history) ? scene.play_history : [],
    }))
  }

  // Everything one November needs, worked out once per year shown
  function buildModel(period, { scenes, watchData, settings }) {
    const now = Date.now()
    const todayKey = getTodayDate()
    const inPeriod = (t) => t >= period.start && t < period.end
    const scenesById = new Map(scenes.map((scene) => [scene.id, scene]))
    const allOs = collectOs(scenes, watchData.imageOHistory, settings)
    const os = allOs.filter((o) => inPeriod(o.time))
    const status = getStatus(period, allOs, now)

    const days = []
    for (let d = 1; d <= 30; d++) {
      const date = new Date(period.year, 10, d)
      const key = getLocalDateString(date)
      days.push({
        date,
        key,
        day: d,
        seconds: getWatchSeconds(watchData.watchTime[key]),
        os: os.filter((o) => getLocalDateString(new Date(o.time)) === key)
          .length,
        isFuture: key > todayKey,
        isToday: key === todayKey,
      })
    }

    // A few seconds is a blip, like the end of a video saved under the next
    const stretches = watchData.playback
      .map((stretch) => ({
        sceneId: String(stretch.scene),
        startMs: stretch.start * 1000,
        endMs: stretch.end * 1000,
        seconds: stretch.seconds || 0,
      }))
      .filter(
        (stretch) =>
          stretch.seconds >= MIN_STRETCH_SECONDS &&
          stretch.endMs >= stretch.startMs &&
          inPeriod(stretch.startMs),
      )
      .sort((a, b) => a.startMs - b.startMs)

    const plays = []
    scenes.forEach((scene) => {
      scene.play_history.forEach((timestamp) => {
        const time = new Date(timestamp).getTime()
        if (!isNaN(time) && inPeriod(time)) {
          plays.push({ sceneId: scene.id, time })
        }
      })
    })

    const model = { period, status, os, days, stretches, plays, scenesById }
    model.viewingsByDay = new Map(
      days.map((day) => [day.key, buildViewings(model, day)]),
    )
    const videos = new Set()
    model.viewingsByDay.forEach((viewings) =>
      viewings.forEach((v) => v.sceneId && videos.add(v.sceneId)),
    )
    model.videoCount = videos.size
    model.watchSeconds = days.reduce((sum, day) => sum + day.seconds, 0)
    model.elapsedDays = days.filter((day) => !day.isFuture)
    model.firstOKey =
      status.state === 'failed'
        ? getLocalDateString(new Date(status.firstO.time))
        : null
    return model
  }

  // A day's viewings: each video watched (stretches of it close together),
  // plays Stash logged with no stretch (from before tracking began, or
  // another player) and O's, in time order. An O on a video being watched
  // joins its viewing.
  function buildViewings(model, day) {
    const dayStart = day.date.getTime()
    const dayEnd = new Date(model.period.year, 10, day.day + 1).getTime()
    const within = (t) => t >= dayStart && t < dayEnd
    const viewings = []
    const newViewing = (props) => ({
      sceneId: null,
      imageId: null,
      seconds: 0,
      parts: [],
      os: [],
      ...props,
    })

    model.stretches
      .filter((stretch) => within(stretch.startMs))
      .forEach((stretch) => {
        const last = viewings[viewings.length - 1]
        if (
          last &&
          last.sceneId === stretch.sceneId &&
          stretch.startMs - last.endMs <= VIEWING_GAP_MS
        ) {
          last.endMs = Math.max(last.endMs, stretch.endMs)
          last.seconds += stretch.seconds
          last.parts.push(stretch)
        } else {
          viewings.push(
            newViewing({
              sceneId: stretch.sceneId,
              startMs: stretch.startMs,
              endMs: stretch.endMs,
              seconds: stretch.seconds,
              parts: [stretch],
            }),
          )
        }
      })

    const near = (sceneId, t, after) =>
      viewings.find(
        (v) =>
          v.sceneId === sceneId &&
          t >= v.startMs - VIEWING_GAP_MS &&
          t <= v.endMs + after,
      )
    model.plays
      .filter((play) => within(play.time))
      .forEach((play) => {
        if (!near(play.sceneId, play.time, VIEWING_GAP_MS)) {
          viewings.push(
            newViewing({
              sceneId: play.sceneId,
              startMs: play.time,
              endMs: play.time,
            }),
          )
        }
      })
    model.os
      .filter((o) => within(o.time))
      .forEach((o) => {
        const viewing = o.sceneId && near(o.sceneId, o.time, O_GRACE_MS)
        if (viewing) {
          viewing.os.push(o)
        } else {
          viewings.push(
            newViewing({
              sceneId: o.sceneId || null,
              imageId: o.imageId || null,
              startMs: o.time,
              endMs: o.time,
              os: [o],
            }),
          )
        }
      })
    return viewings.sort((a, b) => a.startMs - b.startMs)
  }

  // Where a viewing links to and what it shows
  function itemOf(model, { sceneId, imageId }) {
    if (imageId) {
      return {
        href: `/images/${imageId}`,
        cover: `/image/${imageId}/thumbnail`,
        title: `Image ${imageId}`,
        isImage: true,
      }
    }
    const scene = model.scenesById.get(sceneId)
    return {
      href: `/scenes/${sceneId}`,
      cover: scene?.screenshot || `/scene/${sceneId}/screenshot`,
      title: scene
        ? scene.title || scene.basename || 'Untitled'
        : `Scene ${sceneId}`,
    }
  }

  // ===== PANEL =====
  // Opened from the top bar, over whatever page you're on
  let panel = null

  function openPanel() {
    if (panel) return
    const overlay = createEl('div', 'nn-overlay')
    const dialog = createEl('div', 'nn nn-dialog')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-label', 'No Nut November')
    overlay.appendChild(dialog)
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) closePanel()
    })
    const onKey = (e) => {
      if (e.key === 'Escape') closePanel()
    }
    document.addEventListener('keydown', onKey)
    document.body.appendChild(overlay)
    panel = {
      overlay,
      dialog,
      onKey,
      overflow: document.body.style.overflow,
      tick: null,
      data: null,
      renderId: 0,
    }
    document.body.style.overflow = 'hidden'
    renderPanel(currentYear())
  }

  function closePanel() {
    if (!panel) return
    clearInterval(panel.tick)
    document.removeEventListener('keydown', panel.onKey)
    document.body.style.overflow = panel.overflow
    panel.overlay.remove()
    panel = null
  }

  async function renderPanel(year) {
    const own = panel
    const renderId = ++own.renderId
    clearInterval(own.tick)
    const { dialog } = own
    dialog.innerHTML = ''
    const period = periodOf(year)

    // Header: the year on the left, year pager and close on the right
    const hero = createEl('header', 'nn-hero')
    const heroTitle = createEl('div', 'nn-hero-title')
    heroTitle.appendChild(createEl('div', 'nn-hero-mark', '🥜'))
    const heroText = createEl('div')
    heroText.appendChild(createEl('h2', '', `No Nut November ${year}`))
    const heroSub = createEl('div', 'nn-hero-sub', 'Loading…')
    heroText.appendChild(heroSub)
    heroTitle.appendChild(heroText)
    hero.appendChild(heroTitle)

    const actions = createEl('div', 'nn-hero-actions')
    const closeBtn = createEl('button', 'nn-btn nn-btn-icon', '✕')
    closeBtn.title = 'Close'
    closeBtn.addEventListener('click', closePanel)
    actions.appendChild(closeBtn)
    hero.appendChild(actions)
    dialog.appendChild(hero)

    const loading = createEl('div', 'nn-card nn-loading', 'Loading…')
    dialog.appendChild(loading)

    try {
      if (!own.data) {
        const [settings, scenes, watchData, source] = await Promise.all([
          getPluginSettings(),
          getScenes(),
          loadWatchData(),
          getDataSource(),
        ])
        own.data = { settings, scenes, watchData, source }
      }
    } catch (e) {
      console.error('[NNN] Failed to load:', e)
      if (panel === own) loading.innerText = 'Failed to load No Nut November.'
      return
    }
    if (panel !== own || renderId !== own.renderId) return
    loading.remove()

    const model = buildModel(period, own.data)
    const { status } = model
    heroSub.innerText = {
      going: 'In progress · no O yet',
      failed: `Ended ${formatDayShort(new Date(status.until))} at ${formatClock(new Date(status.until))}`,
      done: 'Completed · all 30 days',
    }[status.state]

    // The top bar can be ahead of this or behind it; use the fresher data
    if (year === currentYear()) {
      navState.os = collectOs(
        own.data.scenes,
        own.data.watchData.imageOHistory,
        own.data.settings,
      )
      navState.settings = own.data.settings
      navState.loaded = true
      updateNavButton()
    }

    const updateTimer = createTimer(dialog, model)
    if (status.state === 'going') {
      own.tick = setInterval(() => {
        if (Date.now() >= period.end) renderPanel(year)
        else updateTimer()
      }, 1000)
    }

    createStats(dialog, model)

    if (!own.data.watchData.found && model.os.length === 0) {
      dialog.appendChild(
        createEl(
          'div',
          'nn-note',
          own.data.source === 'ostats'
            ? 'Watch time comes from O Stats. Nothing has been recorded yet.'
            : "Watch time is recorded from now on, whenever you watch in Stash's player.",
        ),
      )
    }

    const calendarSection = createSection(dialog, 'Watch Calendar')
    const daySection = createSection(dialog, 'Day by Day')
    let calendar = null
    const showDay = createDayView(daySection, model, (key) =>
      calendar?.select(key),
    )
    calendar = createCalendar(calendarSection, model, (key) => {
      showDay(key)
      daySection.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })

    // Today while it's on; otherwise the day it ended, or the last day
    const lastDay = model.elapsedDays[model.elapsedDays.length - 1]
    const startKey =
      status.state === 'going'
        ? lastDay?.key
        : status.state === 'failed' && model.days.some((d) => d.isToday)
          ? lastDay.key
          : model.firstOKey || lastDay?.key
    if (startKey) showDay(startKey)

    dialog.appendChild(
      createEl(
        'div',
        'nn-source',
        own.data.source === 'ostats'
          ? 'Watch time from O Stats'
          : 'Watch time tracked by No Nut November',
      ),
    )
  }

  function createSection(parent, title) {
    const section = createEl('section', 'nn-section')
    const head = createEl('div', 'nn-section-head')
    head.appendChild(createEl('h3', 'nn-section-title', title))
    section.appendChild(head)
    parent.appendChild(section)
    return section
  }

  // ===== TIMER =====
  // Days, hours, minutes and seconds without an O (ticking while it's on,
  // or how long you lasted), over a bar for the month with a notch per day.
  // Returns the function that moves it on.
  function createTimer(parent, model) {
    const { status, period } = model
    const card = createEl('div', `nn-card nn-timer is-${status.state}`)
    card.style.setProperty(
      '--nn-accent',
      {
        going: 'var(--nn-orange)',
        failed: 'var(--nn-pink)',
        done: 'var(--nn-amber)',
      }[status.state],
    )
    card.appendChild(
      createEl(
        'div',
        'nn-timer-label',
        {
          going: 'Time without an O',
          failed: 'You lasted',
          done: 'You made it 🏆',
        }[status.state],
      ),
    )

    const units = createEl('div', 'nn-timer-units')
    const values = ['days', 'hours', 'minutes', 'seconds'].map((name) => {
      const unit = createEl('div', 'nn-timer-unit')
      const value = createEl('div', 'nn-timer-value')
      unit.append(value, createEl('div', 'nn-timer-name', name))
      units.appendChild(unit)
      return value
    })
    card.appendChild(units)

    const progress = createEl('div', 'nn-progress')
    const fill = createEl('div', 'nn-progress-fill')
    const ticks = createEl('div', 'nn-progress-ticks')
    for (let i = 0; i < 30; i++) ticks.appendChild(createEl('span'))
    progress.append(fill, ticks)
    // Where the O came
    let pin = null
    if (status.state === 'failed') {
      pin = createEl('div', 'nn-progress-pin', '💦')
      progress.appendChild(pin)
    }
    card.appendChild(progress)

    const scale = createEl('div', 'nn-progress-scale')
    const percentEl = createEl('span', 'nn-progress-percent')
    scale.append(createEl('span', '', 'Nov 1'), percentEl, createEl('span', '', 'Dec 1'))
    card.appendChild(scale)

    const note = createEl('div', 'nn-timer-note')
    card.appendChild(note)
    if (status.state === 'failed') {
      const o = status.firstO
      const time = new Date(o.time)
      const item = itemOf(model, o)
      note.append(`First O on ${formatDayShort(time)} at ${formatClock(time)} · `)
      const link = createEl('a', '', item.title)
      openInNewTab(link, item.href)
      note.appendChild(link)
    } else if (status.state === 'done') {
      note.innerText = 'All 30 days without an O.'
    }

    function update() {
      const until = status.state === 'going' ? Date.now() : status.until
      const parts = lastedParts(period, until)
      ;[parts.days, parts.hours, parts.minutes, parts.seconds].forEach(
        (value, i) => (values[i].innerText = String(value).padStart(2, '0')),
      )
      const fraction = Math.min(
        1,
        Math.max(0, (until - period.start) / (period.end - period.start)),
      )
      fill.style.width = `${fraction * 100}%`
      if (pin) pin.style.left = `${fraction * 100}%`
      percentEl.innerText = `${Math.floor(fraction * 100)}% of November`
      if (status.state === 'going') {
        note.innerText = `Day ${parts.days + 1} of 30 · ${formatLongDuration(
          (period.end - until) / 1000,
        )} to go`
      }
    }
    update()
    parent.appendChild(card)
    return update
  }

  // ===== STATS =====
  function createStatCard(container, { icon, value, label, sub, accent }) {
    const card = createEl('div', 'nn-card nn-stat')
    if (accent) card.style.setProperty('--nn-accent', accent)
    card.appendChild(createEl('div', 'nn-stat-icon', icon))
    card.appendChild(createEl('div', 'nn-stat-value', value))
    card.appendChild(createEl('div', 'nn-stat-label', label))
    const subEl = createEl('div', 'nn-stat-sub', sub || '')
    if (!sub) subEl.style.display = 'none'
    card.appendChild(subEl)
    container.appendChild(card)
    return subEl
  }

  function createStats(parent, model) {
    const { status, period } = model
    const grid = createEl('div', 'nn-grid')
    parent.appendChild(grid)
    const parts = lastedParts(period, status.until)
    const elapsed = model.elapsedDays.length

    if (status.state === 'going') {
      createStatCard(grid, {
        icon: '📅',
        value: String(parts.days + 1),
        label: 'Day of 30',
        sub: `${plural(30 - parts.days - 1, 'day')} to go`,
        accent: 'var(--nn-orange)',
      })
    } else if (status.state === 'failed') {
      createStatCard(grid, {
        icon: '🪦',
        value: String(parts.days),
        label: 'Days Lasted',
        sub: `Ended on day ${parts.days + 1}`,
        accent: 'var(--nn-pink)',
      })
    } else {
      createStatCard(grid, {
        icon: '🏆',
        value: '30',
        label: 'Days Completed',
        sub: 'Every day of November',
        accent: 'var(--nn-amber)',
      })
    }

    createStatCard(grid, {
      icon: '📺',
      value: formatLongDuration(model.watchSeconds),
      label: 'Watch Time',
      sub: elapsed
        ? `${formatDuration(model.watchSeconds / elapsed)} a day on average`
        : null,
      accent: 'var(--nn-green)',
    })

    const daysWatched = model.elapsedDays.filter(
      (day) => model.viewingsByDay.get(day.key).length > 0 || day.seconds > 0,
    ).length
    createStatCard(grid, {
      icon: '🎞️',
      value: String(model.videoCount),
      label: 'Videos Watched',
      sub: `On ${daysWatched} of ${plural(elapsed, 'day')}`,
      accent: 'var(--nn-amber)',
    })

    createStatCard(grid, {
      icon: '💦',
      value: String(model.os.length),
      label: "O's in November",
      sub:
        model.os.length === 0
          ? 'Not a single one'
          : `First on ${formatDayShort(new Date(model.os[0].time))}`,
      accent: 'var(--nn-blue)',
    })

    const best = model.days.reduce(
      (a, b) => (b.seconds > a.seconds ? b : a),
      model.days[0],
    )
    createStatCard(grid, {
      icon: '⌛',
      value: formatDuration(best.seconds),
      label: 'Most Watched Day',
      sub: best.seconds > 0 ? formatDayShort(best.date) : null,
      accent: 'var(--nn-purple)',
    })
  }

  // ===== WATCH CALENDAR =====
  // November as a month, Monday first, each day shaded by its watch time.
  // The day of the first O is marked and the days after it are struck
  // through. Click a day to show it in Day by Day.
  function createCalendar(parent, model, onPick) {
    const { days } = model
    const card = createEl('div', 'nn-card nn-chart nn-cal-card')
    card.style.setProperty('--nn-accent', 'var(--nn-green)')
    parent.appendChild(card)

    const head = createEl('div', 'nn-chart-head')
    const titleWrap = createEl('div')
    titleWrap.appendChild(createEl('h4', 'nn-chart-title', 'Watch Time'))
    const total = createEl('div', 'nn-chart-total')
    total.append(
      createEl('strong', '', `${formatLongDuration(model.watchSeconds)} watched`),
      ' in November',
    )
    titleWrap.appendChild(total)
    head.appendChild(titleWrap)
    card.appendChild(head)

    const grid = createEl('div', 'nn-cal')
    card.appendChild(grid)
    ;['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].forEach((name) =>
      grid.appendChild(createEl('div', 'nn-cal-weekday', name)),
    )

    // Shade 0-4: nothing, then four steps relative to the busiest day
    const maxSeconds = Math.max(1, ...days.map((day) => day.seconds))
    const level = (seconds) =>
      seconds <= 0 ? 0 : Math.min(4, Math.ceil((seconds / maxSeconds) * 4))

    const cells = new Map()
    days.forEach((day, i) => {
      const cell = createEl('button', 'nn-cal-cell')
      cell.type = 'button'
      if (i === 0) {
        cell.style.gridColumnStart = String(((day.date.getDay() + 6) % 7) + 1)
      }
      cell.dataset.level = String(day.isFuture ? 0 : level(day.seconds))
      cell.appendChild(createEl('span', 'nn-cal-day', String(day.day)))
      if (day.seconds > 0) {
        cell.appendChild(
          createEl('span', 'nn-cal-time', formatDuration(day.seconds)),
        )
      }
      if (day.os > 0) cell.appendChild(createEl('span', 'nn-cal-o', '💦'))
      if (day.isToday) cell.classList.add('is-today')
      if (model.firstOKey === day.key) cell.classList.add('is-fail')
      if (model.firstOKey && day.key > model.firstOKey) {
        cell.classList.add('is-after')
      }
      const longDay = day.date.toLocaleDateString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      })
      if (day.isFuture) {
        cell.classList.add('is-future')
        cell.disabled = true
        cell.title = longDay
      } else {
        cell.title =
          `${longDay}: ${day.seconds > 0 ? `${formatDuration(day.seconds)} watched` : 'Nothing watched'}` +
          (day.os ? ` · ${plural(day.os, 'O')}` : '')
        cell.addEventListener('click', () => onPick(day.key))
      }
      cells.set(day.key, cell)
      grid.appendChild(cell)
    })

    // Footer: days watched, the longest stretch of days with nothing
    // watched, and the legend
    const foot = createEl('div', 'nn-cal-foot')
    const facts = createEl('div', 'nn-cal-facts')
    const addFact = (label, value) => {
      const fact = createEl('span', 'nn-cal-fact')
      fact.append(`${label} `, createEl('strong', '', value))
      facts.appendChild(fact)
    }
    const watchedDays = model.elapsedDays.filter((day) => day.seconds > 0)
    addFact(
      'Days watched',
      `${watchedDays.length} of ${model.elapsedDays.length}`,
    )
    let longestBreak = 0
    let run = 0
    model.elapsedDays.forEach((day) => {
      run = day.seconds > 0 ? 0 : run + 1
      longestBreak = Math.max(longestBreak, run)
    })
    addFact('Longest break', plural(longestBreak, 'day'))
    foot.appendChild(facts)

    const legend = createEl('div', 'nn-cal-legend')
    legend.appendChild(createEl('span', '', 'Less'))
    for (let l = 0; l <= 4; l++) {
      const swatch = createEl('i', 'nn-swatch')
      swatch.dataset.level = String(l)
      legend.appendChild(swatch)
    }
    legend.appendChild(createEl('span', '', 'More'))
    foot.appendChild(legend)
    card.appendChild(foot)

    return {
      select(key) {
        cells.forEach((cell, k) => cell.classList.toggle('is-selected', k === key))
      },
    }
  }

  // ===== DAY BY DAY =====
  // Like O Stats' On This Day: the videos watched that day, then the day's
  // numbers. Returns the function that shows a day.
  function createDayView(parent, model, onShow) {
    const card = createEl('div', 'nn-card nn-otd')
    parent.appendChild(card)
    const available = model.elapsedDays

    function show(key) {
      const index = available.findIndex((day) => day.key === key)
      if (index === -1) return
      const day = available[index]
      const viewings = model.viewingsByDay.get(day.key)
      onShow(key)
      card.innerHTML = ''

      // Header: the date on the left, day pager on the right
      const head = createEl('div', 'nn-otd-head')
      const dateWrap = createEl('div')
      dateWrap.appendChild(
        createEl(
          'div',
          'nn-otd-date',
          day.isToday
            ? 'Today'
            : day.date.toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              }),
        ),
      )
      const sub = createEl('div', 'nn-otd-weekday', `Day ${day.day} of No Nut November`)
      if (model.firstOKey === day.key) {
        sub.append(' ', createEl('span', 'nn-tag', 'It ended here'))
      }
      dateWrap.appendChild(sub)
      head.appendChild(dateWrap)

      const pager = createEl('div', 'nn-pager')
      const prev = createEl('button', 'nn-btn nn-btn-icon', '‹')
      prev.title = 'Previous day'
      prev.disabled = index === 0
      prev.addEventListener('click', () => show(available[index - 1].key))
      const label = createEl(
        'span',
        'nn-pager-label',
        day.date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      )
      const next = createEl('button', 'nn-btn nn-btn-icon', '›')
      next.title = 'Next day'
      next.disabled = index === available.length - 1
      next.addEventListener('click', () => show(available[index + 1].key))
      pager.append(prev, label, next)
      head.appendChild(pager)
      card.appendChild(head)

      const listHead = createEl('div', 'nn-panel-head')
      const listTitle = createEl('h5', 'nn-panel-title', 'Videos Watched')
      listTitle.appendChild(createEl('span', 'nn-count', String(viewings.length)))
      listHead.appendChild(listTitle)
      card.append(listHead, createViewedList(model, viewings))

      // The day's numbers. Watch time is the day's total; the stretches only
      // when there's no total (they come from the same tracking).
      const playedSeconds = viewings.reduce((sum, v) => sum + v.seconds, 0)
      const watchSeconds = day.seconds || playedSeconds
      const videos = new Set(viewings.map((v) => v.sceneId).filter(Boolean))
      const dayOs = viewings.reduce((sum, v) => sum + v.os.length, 0)
      const stats = createEl('div', 'nn-otd-stats')
      const addStat = (value, text, accent) => {
        const stat = createEl('div', 'nn-otd-stat')
        stat.style.setProperty('--nn-accent', accent)
        stat.appendChild(createEl('div', 'nn-otd-stat-value', value))
        stat.appendChild(createEl('div', 'nn-otd-stat-label', text))
        stats.appendChild(stat)
      }
      addStat(formatDuration(watchSeconds), 'Watch Time', 'var(--nn-green)')
      addStat(String(videos.size), 'Videos Watched', 'var(--nn-amber)')
      addStat(String(dayOs), "O's", 'var(--nn-blue)')
      const clean = !model.firstOKey || day.key < model.firstOKey
      addStat(
        clean ? '🥜' : model.firstOKey === day.key ? '💦' : '–',
        clean ? 'Still Going' : model.firstOKey === day.key ? 'Ended' : 'Over',
        clean ? 'var(--nn-orange)' : 'var(--nn-pink)',
      )
      card.appendChild(stats)
    }
    return show
  }

  function createViewedList(model, viewings) {
    const list = createEl('div', 'nn-videos')
    if (viewings.length === 0) {
      list.appendChild(createEl('div', 'nn-empty', 'Nothing watched on this day'))
      return list
    }
    viewings.forEach((viewing) => {
      const item = itemOf(model, viewing)
      const row = createEl('a', viewing.os.length ? 'nn-video has-o' : 'nn-video')
      openInNewTab(row, item.href)

      const thumbnail = createEl('img', item.isImage ? 'is-image' : '')
      thumbnail.src = item.cover
      thumbnail.loading = 'lazy'
      thumbnail.alt = ''
      row.appendChild(thumbnail)

      const info = createEl('div', 'nn-video-info')
      info.appendChild(createEl('div', 'nn-video-title', item.title))
      const what =
        viewing.seconds >= 1
          ? `${formatDuration(viewing.seconds)} watched`
          : viewing.imageId
            ? 'Image'
            : viewing.os.length
              ? 'O only'
              : 'Played'
      const meta = createEl(
        'div',
        'nn-video-meta',
        `${formatClock(new Date(viewing.startMs))} · ${what}`,
      )
      if (viewing.os.includes(model.status.firstO)) {
        meta.append(' ', createEl('span', 'nn-tag', 'NNN over'))
      }
      info.appendChild(meta)
      row.appendChild(info)

      if (viewing.os.length) {
        row.appendChild(
          createEl(
            'span',
            'nn-video-emoji',
            viewing.os.length > 1 ? `💦 ${viewing.os.length}×` : '💦',
          ),
        )
      }
      list.appendChild(row)
    })
    return list
  }
})()
