;(function () {
  // ===== UTILITY FUNCTIONS (Replaces CommunityScriptsUILibrary dependency) =====

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

  // ===== SCENE DATA HELPERS =====
  const inFlightDataRequests = {
    scenesCore: null,
    scenesFull: null,
  }

  // Remove data left behind by the old "Use cache" option.
  try {
    localStorage.removeItem('ostats_scenes_core_v1')
    localStorage.removeItem('ostats_scenes_full_v1')
    localStorage.removeItem('ostats_use_cache')
  } catch (e) {}

  function sanitizeScene(scene, includePlayHistory) {
    return {
      id: scene.id,
      title: scene.title || null,
      o_counter: scene.o_counter || 0,
      o_history: Array.isArray(scene.o_history) ? scene.o_history : [],
      play_duration: scene.play_duration || 0,
      play_history:
        includePlayHistory && Array.isArray(scene.play_history)
          ? scene.play_history
          : [],
      files: [{ basename: scene.files?.[0]?.basename || '' }],
      paths: { screenshot: scene.paths?.screenshot || '' },
    }
  }

  async function fetchScenesData(includePlayHistory) {
    const playHistoryField = includePlayHistory ? 'play_history' : ''
    const query = `query {
      findScenes(scene_filter: {}, filter: { per_page: -1 }) {
        scenes {
          id
          title
          o_counter
          o_history
          play_duration
          ${playHistoryField}
          files {
            basename
          }
          paths {
            screenshot
          }
        }
      }
    }`

    const data = await callGQL({ query })
    const scenes = data.findScenes?.scenes || []
    return scenes.map((scene) => sanitizeScene(scene, includePlayHistory))
  }

  async function getScenesData(includePlayHistory = false) {
    const inFlightKey = includePlayHistory ? 'scenesFull' : 'scenesCore'

    if (inFlightDataRequests[inFlightKey]) {
      return inFlightDataRequests[inFlightKey]
    }

    inFlightDataRequests[inFlightKey] = fetchScenesData(
      includePlayHistory,
    ).finally(() => {
      inFlightDataRequests[inFlightKey] = null
    })

    return inFlightDataRequests[inFlightKey]
  }

  async function getScenesWithOHistory() {
    // Core data for top-level stats does not require play history.
    return getScenesData(false)
  }

  async function getScenesWithPlayHistory() {
    return getScenesData(true)
  }

  // Path element listener - waits for specific page elements to load
  function PathElementListener(pathPattern, elementSelector, callback) {
    let lastPath = null
    let isProcessing = false

    const checkAndSetup = async () => {
      const currentPath = window.location.pathname

      // Check if we're on the right path
      if (!currentPath.includes(pathPattern)) {
        lastPath = currentPath
        return
      }

      // Check if path changed or first load
      if (currentPath === lastPath && isProcessing) {
        return
      }

      // Find the target element
      const element = document.querySelector(elementSelector)
      if (!element) {
        return
      }

      // Only run callback if path changed or first time
      if (currentPath !== lastPath || !isProcessing) {
        lastPath = currentPath
        isProcessing = true
        try {
          await callback(element)
        } finally {
          isProcessing = false
        }
      }
    }

    // Check on page load
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', checkAndSetup)
    } else {
      checkAndSetup()
    }

    // Watch for navigation changes (SPA routing)
    const observer = new MutationObserver(() => {
      checkAndSetup()
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Also listen for popstate (back/forward navigation)
    window.addEventListener('popstate', checkAndSetup)

    // Check periodically as fallback
    setInterval(checkAndSetup, 1000)
  }

  // ===== WATCH TIME TRACKING =====
  // This section tracks actual play time per day similar to Stash's track-activity plugin

  const TRACKING_INTERVAL = 10000 // Track every 10 seconds

  // In-memory cache of watch data
  let watchDataCache = null
  let watchDataLoaded = false
  let lastSaveTimestamp = 0 // Track when we last saved to detect stale data
  let isSaving = false // Prevent concurrent saves
  let pendingSavePromise = Promise.resolve() // Serialize in-flight save operations
  let saveDebounceTimer = null // Debounce timer for save operations
  let lastQueuedJobId = null // Track the most recent queued job ID

  let trackingIntervalId = null
  let trackingLastTickTime = 0
  const activeVideoElements = new Set()
  let currentSceneInfo = null // Track current scene being watched

  // Cross-tab communication via localStorage
  const STORAGE_KEY = 'ostats_watch_data_sync'
  const STORAGE_LOCK_KEY = 'ostats_save_lock'

  // Broadcast updated data to other tabs
  function broadcastUpdate(data) {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          data: data,
          timestamp: Date.now(),
          tab: Math.random(), // Identify this tab
        }),
      )
    } catch (e) {
      console.warn('[OStats] Failed to broadcast update:', e)
    }
  }

  // Listen for updates from other tabs
  window.addEventListener('storage', (e) => {
    if (e.key === STORAGE_KEY && e.newValue) {
      try {
        const update = JSON.parse(e.newValue)
        const today = getTodayDate()

        // Only update cache if the broadcast has newer data for today
        if (update.data && update.data[today]) {
          if (
            !watchDataCache ||
            (watchDataCache[today] || 0) < update.data[today]
          ) {
            console.log(
              '[OStats] Received update from another tab, syncing cache',
            )
            watchDataCache = update.data
            watchDataLoaded = true
            lastSaveTimestamp = update.timestamp
          }
        }
      } catch (e) {
        console.warn('[OStats] Failed to parse storage update:', e)
      }
    }
  })

  // Get today's date in YYYY-MM-DD format
  function getTodayDate() {
    const now = new Date()
    return getLocalDateString(now) // YYYY-MM-DD format
  }

  // Extract scene info from current page
  function getCurrentSceneInfo() {
    const path = window.location.pathname
    const match = path.match(/\/scenes\/(\d+)/)
    if (!match) return null

    const sceneId = match[1]

    // Try multiple methods to get title
    let title = null

    // Method 1: Try h2 in the scene page
    const h2Element = document.querySelector(
      '.scene-header h2, h2.scene-header__title, h2',
    )
    if (h2Element) {
      title = h2Element.textContent.trim()
    }

    // Method 2: Try title tag and strip " | Scenes | Stash"
    if (!title || title === '') {
      const titleTag = document.title
      if (titleTag && titleTag !== 'Stash') {
        // Split by pipe and take first part
        title = titleTag.split('|')[0].trim()
      }
    }

    // Fallback
    if (!title || title === '') {
      title = `Scene ${sceneId}`
    }

    return { id: sceneId, title: title }
  }

  // Load watch time data from Stash configuration (syncs across devices)
  async function loadWatchTimeData() {
    // Return cached data if already loaded
    if (watchDataLoaded && watchDataCache !== null) {
      console.log('[OStats] Returning cached data')
      return watchDataCache
    }

    try {
      // Load data directly from the JSON file via HTTP
      // Add timestamp to prevent browser caching of stale data
      const url = `/plugin/ostats/assets/watch_data.json?t=${Date.now()}`
      console.log('[OStats] Fetching from:', url)
      const response = await fetch(url, {
        cache: 'no-store', // Force bypass of browser cache
        headers: {
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
      })
      console.log(
        '[OStats] Response status:',
        response.status,
        response.statusText,
      )

      if (response.ok) {
        const watchData = await response.json()

        // CRITICAL: Only update cache if loaded data is newer or equal
        // Check if we have cached data with more recent information
        if (watchDataCache && Object.keys(watchDataCache).length > 0) {
          const today = getTodayDate()
          // Simple format: just numbers
          const cachedTodayTime = watchDataCache[today] || 0
          const loadedTodayTime = watchData[today] || 0

          // If cached data has more watch time for today, keep it (it's fresher)
          if (cachedTodayTime > loadedTodayTime) {
            console.warn(
              `[OStats] Loaded data appears stale (${loadedTodayTime}s < ${cachedTodayTime}s cached). Keeping cached data.`,
            )
            watchDataLoaded = true
            return watchDataCache
          }
        }

        watchDataCache = watchData
        watchDataLoaded = true
        console.log(
          '[OStats] Loaded watch history from JSON file, total days:',
          Object.keys(watchData).length,
        )
        return watchDataCache
      } else if (response.status === 404) {
        // Only cache empty data on 404 if we don't have existing cache
        if (watchDataCache && Object.keys(watchDataCache).length > 0) {
          console.warn(
            '[OStats] File not found but have cached data, keeping cache',
          )
          watchDataLoaded = true
          return watchDataCache
        }
        console.log('[OStats] No watch history file found, starting fresh')
        watchDataCache = {}
        watchDataLoaded = true
        return watchDataCache
      } else {
        console.error('[OStats] Failed to load watch history:', response.status)
        // Return cached data if available, even if stale
        if (watchDataCache !== null) {
          console.warn('[OStats] Using cached data due to load failure')
          return watchDataCache
        }
      }
    } catch (e) {
      console.error('[OStats] Error loading watch history:', e)
      // Return cached data if available, even if stale
      if (watchDataCache !== null) {
        console.warn('[OStats] Using cached data due to error')
        return watchDataCache
      }
    }

    // Only reach here if load failed AND no cache exists
    // This is dangerous - don't cache this empty state
    console.error(
      '[OStats] Failed to load watch history and no cache available - using empty data (NOT cached)',
    )
    return {}
  }

  // Save watch time data to JSON file via Python task
  async function saveWatchTimeData(data) {
    // Safety check: don't save empty data if we have cached data
    if (
      Object.keys(data).length === 0 &&
      watchDataCache &&
      Object.keys(watchDataCache).length > 0
    ) {
      console.error(
        '[OStats] Refusing to save empty data - cached data exists!',
      )
      return
    }

    // Clear any existing debounce timer
    if (saveDebounceTimer) {
      clearTimeout(saveDebounceTimer)
    }

    // Debounce: only actually save after 2 seconds of no new save requests
    saveDebounceTimer = setTimeout(async () => {
      saveDebounceTimer = null

      // Check if another tab already has a save queued with the same or newer data
      try {
        const lockInfo = localStorage.getItem(STORAGE_LOCK_KEY)
        if (lockInfo) {
          const lock = JSON.parse(lockInfo)
          const today = getTodayDate()
          // If another tab queued a save within last 5 seconds with same/better data, skip
          if (
            Date.now() - lock.timestamp < 5000 &&
            lock.data[today] >= data[today]
          ) {
            console.log(
              '[OStats] Another tab already queued save with current data, skipping',
            )
            return
          }
        }
      } catch (e) {
        console.warn('[OStats] Failed to check save lock:', e)
      }

      // Set lock to indicate we're saving
      try {
        localStorage.setItem(
          STORAGE_LOCK_KEY,
          JSON.stringify({
            timestamp: Date.now(),
            data: data,
          }),
        )
      } catch (e) {
        console.warn('[OStats] Failed to set save lock:', e)
      }

      // If we previously queued a task, try to cancel it
      if (lastQueuedJobId) {
        console.log(
          '[OStats] Attempting to cancel previous save task:',
          lastQueuedJobId,
        )
        try {
          await callGQL({
            query: `mutation StopJob($job_id: ID!) {
              stopJob(job_id: $job_id)
            }`,
            variables: {
              job_id: lastQueuedJobId,
            },
          })
          console.log('[OStats] Canceled old save task')
        } catch (e) {
          // Task might have already started/completed, that's fine
          console.log(
            '[OStats] Could not cancel task (might be running):',
            e.message,
          )
        }
        lastQueuedJobId = null
      }

      isSaving = true
      try {
        const today = getTodayDate()
        const todaysTotal = data[today] || 0
        console.log('[OStats] Queueing save task, todays total:', todaysTotal)

        const result = await callGQL({
          query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args_map: Map) {
            runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args_map: $args_map)
          }`,
          variables: {
            plugin_id: 'ostats',
            task_name: 'saveWatchData',
            args_map: {
              watch_data: JSON.stringify(data),
            },
          },
        })

        // Store the job ID if available (runPluginTask returns the job ID)
        if (result.runPluginTask) {
          lastQueuedJobId = result.runPluginTask
          console.log('[OStats] Save task queued with ID:', lastQueuedJobId)
        }

        // Update cache after queuing task
        watchDataCache = data
        watchDataLoaded = true
        lastSaveTimestamp = Date.now()

        // Broadcast to other tabs that save was queued
        broadcastUpdate(data)

        console.log('[OStats] Watch history save task queued')
      } catch (e) {
        console.error('[OStats] Error queueing save task:', e)
      } finally {
        isSaving = false
      }
    }, 2000) // 2 second debounce
  }

  // Add watch time for today (simplified - just total time)
  async function addWatchTime(seconds, sceneInfo) {
    const today = getTodayDate()

    // Check for updates from other tabs via localStorage
    try {
      const storedUpdate = localStorage.getItem(STORAGE_KEY)
      if (storedUpdate) {
        const update = JSON.parse(storedUpdate)
        // Merge with other tabs' data - use the maximum value for today
        if (update.data && update.data[today]) {
          if (
            !watchDataCache ||
            (watchDataCache[today] || 0) < update.data[today]
          ) {
            console.log('[OStats] Merging data from another tab before update')
            watchDataCache = update.data
            watchDataLoaded = true
            lastSaveTimestamp = update.timestamp
          }
        }
      }
    } catch (e) {
      console.warn('[OStats] Failed to check localStorage for updates:', e)
    }

    // Use cached data if available
    const cacheAge = Date.now() - lastSaveTimestamp
    if (!watchDataCache || cacheAge > 60000) {
      console.log('[OStats] Cache stale or missing, reloading from disk')
      watchDataLoaded = false
      watchDataCache = null
    }

    const data = await loadWatchTimeData()

    // Safety check: if data is empty and we don't have cache loaded, something went wrong
    if (Object.keys(data).length === 0 && !watchDataLoaded) {
      console.error(
        '[OStats] Cannot add watch time - data load failed and no cache available. Skipping to prevent data loss.',
      )
      return
    }

    // Create a deep copy to avoid mutating the cache directly
    const dataCopy = JSON.parse(JSON.stringify(data))

    // Migrate old format to simple format if needed
    if (
      dataCopy[today] &&
      typeof dataCopy[today] === 'object' &&
      'totalTime' in dataCopy[today]
    ) {
      // Old format with videos array - extract just the total time
      dataCopy[today] = dataCopy[today].totalTime || 0
    }

    // Initialize today's time if it doesn't exist
    if (!dataCopy[today]) {
      dataCopy[today] = 0
    }

    // Update total time (simple format - just a number)
    dataCopy[today] += seconds

    // Broadcast update to other tabs
    broadcastUpdate(dataCopy)

    await saveWatchTimeData(dataCopy)
  }

  function queueWatchTimeSave(seconds) {
    if (seconds <= 0) return pendingSavePromise

    const sceneLog = currentSceneInfo ? ` (${currentSceneInfo.title})` : ''
    pendingSavePromise = pendingSavePromise
      .then(() => addWatchTime(seconds, currentSceneInfo))
      .then(() => {
        console.log(
          `[OStats] Saved ${seconds}s watch time for ${getTodayDate()}${sceneLog}`,
        )
      })
      .catch((err) => {
        console.error('[OStats] Failed queued watch time save:', err)
      })

    return pendingSavePromise
  }

  function flushTrackedWatchTime() {
    if (activeVideoElements.size === 0) {
      trackingLastTickTime = Date.now()
      return 0
    }

    const now = Date.now()
    if (!trackingLastTickTime) {
      trackingLastTickTime = now
      return 0
    }

    const elapsedSeconds = Math.floor((now - trackingLastTickTime) / 1000)
    if (elapsedSeconds <= 0) {
      return 0
    }

    trackingLastTickTime += elapsedSeconds * 1000
    const totalSeconds = elapsedSeconds * activeVideoElements.size
    queueWatchTimeSave(totalSeconds)
    return totalSeconds
  }

  function ensureTrackingInterval() {
    if (trackingIntervalId) return

    trackingLastTickTime = Date.now()
    trackingIntervalId = setInterval(() => {
      flushTrackedWatchTime()
    }, TRACKING_INTERVAL)
  }

  // Start tracking watch time for a specific video element.
  function startWatchTimeTracking(videoElement) {
    // Only count playback in the main scene player, not previews or other
    // plugins' videos.
    if (!isOnScenePage() || !isMainScenePlayer(videoElement)) {
      return
    }

    if (videoElement && activeVideoElements.has(videoElement)) {
      return
    }

    flushTrackedWatchTime()

    if (videoElement) {
      activeVideoElements.add(videoElement)
    }

    if (!currentSceneInfo) {
      currentSceneInfo = getCurrentSceneInfo()
    }

    ensureTrackingInterval()
    console.log(
      '[OStats] Active video trackers:',
      activeVideoElements.size,
      currentSceneInfo ? `(${currentSceneInfo.title})` : '',
    )
  }

  // Stop tracking watch time for a specific video element.
  async function stopWatchTimeTracking(videoElement) {
    flushTrackedWatchTime()

    if (videoElement) {
      activeVideoElements.delete(videoElement)
    } else {
      activeVideoElements.clear()
    }

    if (activeVideoElements.size > 0) {
      trackingLastTickTime = Date.now()
      console.log('[OStats] Active video trackers:', activeVideoElements.size)
      return
    }

    if (trackingIntervalId) {
      clearInterval(trackingIntervalId)
      trackingIntervalId = null
    }

    trackingLastTickTime = 0
    await pendingSavePromise
    currentSceneInfo = null
    console.log('[OStats] Stopped watch time tracking')
  }

  async function stopAllWatchTimeTracking() {
    await stopWatchTimeTracking(null)
  }

  // Check if we're currently on a scene page
  function isOnScenePage() {
    return /\/scenes\/\d+/.test(window.location.pathname)
  }

  // Check if a video element is Stash's main scene player
  function isMainScenePlayer(videoElement) {
    return !!videoElement?.closest('.scene-player-container')
  }

  // Hook into video player events
  function setupVideoPlayerTracking() {
    function attachTrackingToVideo(videoPlayer) {
      if (!videoPlayer || videoPlayer.dataset.ostatsTracking) return
      if (!isMainScenePlayer(videoPlayer)) return

      videoPlayer.dataset.ostatsTracking = 'true'

      videoPlayer.addEventListener('playing', () => {
        console.log('[OStats] Video playing')
        startWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('pause', async () => {
        console.log('[OStats] Video paused')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('ended', async () => {
        console.log('[OStats] Video ended')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('waiting', async () => {
        console.log('[OStats] Video waiting/buffering')
        await stopWatchTimeTracking(videoPlayer)
      })

      videoPlayer.addEventListener('stalled', async () => {
        console.log('[OStats] Video stalled')
        await stopWatchTimeTracking(videoPlayer)
      })

      // If already playing when attached, start tracking immediately.
      if (!videoPlayer.paused && !videoPlayer.ended) {
        startWatchTimeTracking(videoPlayer)
      }

      console.log('[OStats] Video player tracking setup complete')
    }

    // Monitor route changes to stop tracking when leaving scene page
    let lastPath = window.location.pathname
    const checkPathChange = setInterval(async () => {
      const currentPath = window.location.pathname
      if (currentPath !== lastPath) {
        lastPath = currentPath
        // If we've left the scene page and tracking is active, stop it
        if (!isOnScenePage() && activeVideoElements.size > 0) {
          console.log('[OStats] Left scene page, stopping tracking')
          await stopAllWatchTimeTracking()
        }
      }
    }, 500) // Check every 500ms

    // Use MutationObserver to detect when video player is added to DOM
    const observer = new MutationObserver(() => {
      const videoPlayers = document.querySelectorAll('video')
      videoPlayers.forEach((videoPlayer) => {
        attachTrackingToVideo(videoPlayer)
      })
    })

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    })

    // Also check if video is already present
    const existingVideos = document.querySelectorAll('video')
    existingVideos.forEach((videoPlayer) => {
      attachTrackingToVideo(videoPlayer)
    })
  }

  // Initialize video player tracking on page load
  setupVideoPlayerTracking()

  // Save any remaining watch time before page unload
  window.addEventListener('beforeunload', (e) => {
    if (activeVideoElements.size > 0 || trackingIntervalId) {
      console.log('[OStats] Page unloading, saving watch time...')
      const pendingSeconds = flushTrackedWatchTime()

      if (trackingIntervalId) {
        clearInterval(trackingIntervalId)
        trackingIntervalId = null
      }

      if (pendingSeconds > 0) {
        const data = watchDataCache || {}
        const today = getTodayDate()

        if (
          data[today] &&
          typeof data[today] === 'object' &&
          'totalTime' in data[today]
        ) {
          data[today] = data[today].totalTime || 0
        }

        if (!data[today]) {
          data[today] = 0
        }
        data[today] += pendingSeconds

        watchDataCache = data
        try {
          navigator.sendBeacon(
            '/graphql',
            JSON.stringify({
              query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args_map: Map) {
              runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args_map: $args_map)
            }`,
              variables: {
                plugin_id: 'ostats',
                task_name: 'saveWatchData',
                args_map: { watch_data: JSON.stringify(data) },
              },
            }),
          )
        } catch (err) {
          console.error('[OStats] Failed to send beacon:', err)
        }
        console.log(`[OStats] Beforeunload: saved ${pendingSeconds}s`)
      }

      activeVideoElements.clear()
      trackingLastTickTime = 0
      currentSceneInfo = null
    }
  })

  // ===== END WATCH TIME TRACKING =====

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

  // OPTIMIZATION: Pre-process O history into a day map to avoid repeated iteration
  function buildOHistoryDayMap(scenes) {
    const dayMap = new Map()
    const dayTotals = {}

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        scene.o_history.forEach((timestamp) => {
          // Skip invalid/undated O's
          if (!timestamp) return

          const date = new Date(timestamp)
          // Validate date
          if (isNaN(date.getTime())) return

          const day = getLocalDateString(date)

          // Add to day map (for detailed queries)
          if (!dayMap.has(day)) {
            dayMap.set(day, [])
          }
          dayMap.get(day).push({ scene, timestamp })

          // Increment totals (for quick counts)
          dayTotals[day] = (dayTotals[day] || 0) + 1
        })
      }
    })

    return { dayMap, dayTotals }
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
      label: 'Record Session',
      accent: 'var(--os-green)',
    })
    if (maxDay && maxDuration > 0) {
      setSubWithDayLink(subEl, 'on', maxDay)
    }
  }

  // Export/Import watch time data as JSON
  function createWatchTimeExportButton(row, scenesForExport = null) {
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
        const scenes = scenesForExport || (await getScenesWithOHistory())
        const oHistoryCache = buildOHistoryDayMap(scenes)

        // Clean data for export and add O counts
        const cleanedData = {}
        Object.keys(watchTimeData).forEach((day) => {
          const dayData = watchTimeData[day]
          let watchSeconds = 0

          if (typeof dayData === 'number') {
            watchSeconds = dayData
          } else if (typeof dayData === 'object' && 'totalTime' in dayData) {
            watchSeconds = dayData.totalTime || 0
          }

          // Watch time and O count for this day
          cleanedData[day] = {
            seconds: watchSeconds,
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
        a.download = `ostats-watch-time-${new Date()
          .toISOString()
          .slice(0, 10)}.json`
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
        console.error('Export failed:', error)
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

          // Determine if this is wrapped format (with "data" property) or direct format
          let dataToImport
          if (importData.data && typeof importData.data === 'object') {
            // New export format with wrapper
            dataToImport = importData.data
            console.log(
              '[OStats] Importing data from wrapped format, total days:',
              Object.keys(dataToImport).length,
            )
          } else if (
            importData.version === undefined &&
            typeof importData === 'object'
          ) {
            // Old direct format (just the watch data object)
            dataToImport = importData
            console.log(
              '[OStats] Importing data from direct format, total days:',
              Object.keys(dataToImport).length,
            )
          } else {
            throw new Error('Invalid file format')
          }

          // Keep only the watch time; O counts come from Stash itself.
          // Reads every export format: { seconds, o_count } (3.0),
          // "watchTime,oCount" (2.0) and plain numbers (older).
          const cleanedDataToImport = {}
          Object.keys(dataToImport).forEach((day) => {
            const value = dataToImport[day]
            if (value && typeof value === 'object' && 'seconds' in value) {
              cleanedDataToImport[day] = Number(value.seconds) || 0
            } else if (typeof value === 'string' && value.includes(',')) {
              // New format: "watchTime,oCount" - extract just watch time
              cleanedDataToImport[day] = parseInt(value.split(',')[0])
            } else if (typeof value === 'number') {
              // Old format: just a number
              cleanedDataToImport[day] = value
            } else {
              cleanedDataToImport[day] = 0
            }
          })

          console.log(
            '[OStats] Importing data sample:',
            JSON.stringify(cleanedDataToImport).substring(0, 200),
          )

          // Delete all local data and replace with imported data
          await saveWatchTimeData(cleanedDataToImport)

          // Wait a bit for file write to complete
          await new Promise((resolve) => setTimeout(resolve, 500))

          // Clear cache BEFORE verification to force fresh load from file
          watchDataCache = null
          watchDataLoaded = false

          // Verify the save by loading it back
          const verifyData = await loadWatchTimeData()
          console.log(
            '[OStats] Verification after import, total days:',
            Object.keys(verifyData).length,
          )
          console.log(
            '[OStats] Verify data sample:',
            JSON.stringify(verifyData).substring(0, 200),
          )

          importBtn.innerText = '✓ Imported!'
          setTimeout(() => {
            importBtn.innerText = '📥 Import JSON'
            importBtn.disabled = false
            // Reload page to show new data - wait longer to ensure save completes
            window.location.reload()
          }, 2000)
        } catch (error) {
          console.error('Import failed:', error)
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
      label: 'Record Day',
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
        const prevDate = new Date(allSortedDays[i - 1])
        const currDate = new Date(allSortedDays[i])
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
    createStatCard(row, {
      icon: streakIcon,
      value: displayStreak,
      label: streakHeading,
      sub:
        highestStreak > 0
          ? `Best: ${highestStreak} day${highestStreak === 1 ? '' : 's'}`
          : '',
      accent: 'var(--os-orange)',
      tooltip,
    })
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
  async function createLongestWatchedScene(row, scenes = null) {
    const sceneList = scenes || (await getScenesWithOHistory())
    let maxScene = null
    let maxDuration = 0

    sceneList.forEach((scene) => {
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

  // most recent O scene
  async function createMostRecentOScene(row, scenes) {
    let recentScene = null
    let recentTimestamp = null

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        // Filter out invalid timestamps
        const validTimestamps = scene.o_history.filter((t) => {
          if (!t) return false
          const date = new Date(t)
          return !isNaN(date.getTime())
        })

        if (validTimestamps.length === 0) return

        const mostRecent = validTimestamps.sort().reverse()[0]
        if (!recentTimestamp || mostRecent > recentTimestamp) {
          recentTimestamp = mostRecent
          recentScene = scene
        }
      }
    })

    if (recentScene) {
      const date = new Date(recentTimestamp)
      const timeAgo = formatTimeAgo(date)
      createHighlightCard(
        row,
        recentScene,
        timeAgo,
        'Most Recent O',
        'var(--os-purple)',
      )
    }
  }

  // oldest O scene
  async function createOldestOScene(row, scenes) {
    let oldestScene = null
    let oldestRecentTimestamp = null

    scenes.forEach((scene) => {
      if (scene.o_history && scene.o_history.length > 0) {
        // Filter out invalid timestamps
        const validTimestamps = scene.o_history.filter((t) => {
          if (!t) return false
          const date = new Date(t)
          return !isNaN(date.getTime())
        })

        if (validTimestamps.length === 0) return

        // Get the most recent O for this scene
        const mostRecent = validTimestamps.sort().reverse()[0]
        if (!oldestRecentTimestamp || mostRecent < oldestRecentTimestamp) {
          oldestRecentTimestamp = mostRecent
          oldestScene = scene
        }
      }
    })

    if (oldestScene) {
      const date = new Date(oldestRecentTimestamp)
      const timeAgo = formatTimeAgo(date)
      createHighlightCard(
        row,
        oldestScene,
        timeAgo,
        'Oldest O',
        'var(--os-amber)',
      )
    }
  }

  // ===== CALENDARS =====
  // A calendar year as a grid: one column per week (Monday first), one
  // square per day, darker for more. Used for O's and for watch time.
  // Click a day to open it in On This Day.
  function createCalendarHeatmap(
    row,
    { title, accent, dayTotals, formatValue, formatTotal, gapLabel, gapNoun },
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
      const activeDays = yearDays.filter((day) => day.value > 0).length
      totalEl.innerHTML = ''
      totalEl.append(
        createEl('strong', '', formatTotal(total)),
        ` on ${plural(activeDays, 'day')} in ${year}`,
      )

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
          'Longest streak',
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
      icon: '🎬',
      value: formatNumber(stats.scenes_played),
      label: 'Scenes Played',
      sub: `of ${formatNumber(stats.scene_count)} scenes`,
      accent: 'var(--os-purple)',
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
      hideStats = false,
      expandedByDefault = false,
      timelineExpandedByDefault = false,
      hideTimelineOs = false,
      showTimelineWatches = false,
    } = options
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

      // Get day's O's from cache
      const cachedOEvents = oHistoryCache.dayMap.get(targetDay) || []

      // Collect day's O's with times for timeline display
      const dayOs = cachedOEvents.map((event) => ({
        time: new Date(event.timestamp),
        hour: new Date(event.timestamp).getHours(),
        minute: new Date(event.timestamp).getMinutes(),
        scene: event.scene,
      }))

      // Collect all events (O's and plays) for this day
      const daySceneEvents = []

      // Add O events from cache
      cachedOEvents.forEach((event) => {
        daySceneEvents.push({
          scene: event.scene,
          time: new Date(event.timestamp),
          hasO: true,
        })
      })

      // Collect play times for this day
      scenes.forEach((scene) => {
        if (scene.play_history && scene.play_history.length > 0) {
          scene.play_history.forEach((timestamp) => {
            const date = new Date(timestamp)
            const day = getLocalDateString(date)
            if (day === targetDay) {
              // Check if there's an O for THIS SPECIFIC SCENE within 30 minutes
              const hasNearbyO = daySceneEvents.some(
                (oEvent) =>
                  oEvent.hasO &&
                  oEvent.scene.id === scene.id &&
                  Math.abs(oEvent.time - date) < 1800000, // 30 minutes in ms
              )

              // Only add watch event if there's no O nearby for this scene
              if (!hasNearbyO) {
                // Also check for duplicate watch events within 30 minutes
                const hasDuplicateWatch = daySceneEvents.some(
                  (existingEvent) =>
                    !existingEvent.hasO &&
                    existingEvent.scene.id === scene.id &&
                    Math.abs(existingEvent.time - date) < 1800000,
                )

                if (!hasDuplicateWatch) {
                  daySceneEvents.push({
                    scene: scene,
                    time: date,
                    hasO: false,
                  })
                }
              }
            }
          })
        }
      })

      // Sort events by time
      daySceneEvents.sort((a, b) => a.time - b.time)

      // Sort O's by time
      dayOs.sort((a, b) => a.time - b.time)

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

      // Load watch time data
      const watchTimeData = await loadWatchTimeData()
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

  PathElementListener('/stats', 'div.container-fluid div.mt-5', setupStats)
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
    const topStats = settings.hideTopStats
      ? []
      : [
          [
            settings.hideTopStatsOsToday,
            (row) => createOrgasmsToday(row, scenes, oHistoryCache),
          ],
          [
            settings.hideTopStatsRecordDay,
            (row) => createBestOrgasmDay(row, scenes, oHistoryCache),
          ],
          [
            settings.hideTopStatsStreak,
            (row) => createOrgasmStreak(row, scenes, oHistoryCache),
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
            (row) => createMostRecentOScene(row, scenes),
          ],
          [
            settings.hideSceneHighlightsOldestO,
            (row) => createOldestOScene(row, scenes),
          ],
        ].filter(([hidden]) => !hidden)

    // Sections are added in page order. A hidden section is never created,
    // so the spacing between the ones that are left stays even.
    if (topStats.length > 0) {
      const section = createSection(root, 'Today & Records')
      const grid = createEl('div', 'os-grid')
      section.appendChild(grid)
      await Promise.all(topStats.map(([, create]) => create(grid)))
    }

    if (!settings.hideAllTimeStats && libraryStats) {
      const section = createSection(root, 'All Time')
      const grid = createEl('div', 'os-grid')
      section.appendChild(grid)
      createAllTimeStats(grid, libraryStats)
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
      createWatchTimeExportButton(root, scenes)
    }

    if (!onThisDaySection) return

    // Heavy path: fetch full play history in background and hydrate the section.
    const onThisDayBody = createEl('div')
    getScenesWithPlayHistory()
      .then(async (fullScenes) => {
        const fullHistoryCache = buildOHistoryDayMap(fullScenes)
        onThisDaySection.querySelector('.os-otd-loading')?.remove()
        onThisDaySection.appendChild(onThisDayBody)
        await createOnThisDaySection(onThisDayBody, fullScenes, fullHistoryCache, {
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
