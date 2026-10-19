;(function () {
  const PLUGIN_ID = 'ocheevs'
  const ROUTE = '/plugins/cheevs'
  // Progress is saved to cheevs_data.json in the plugin folder by the
  // saveCheevsData task, and read back from the plugin's assets.
  const DATA_URL = `/plugin/${PLUGIN_ID}/assets/cheevs_data.json`
  const SAVE_TASK = 'saveCheevsData'
  // Versions before 0.2 kept progress in the plugin config. Stash's settings
  // page could save over it, so it is moved to the file on first load.
  const LEGACY_DATA_KEY = 'zz_data'
  const LEGACY_LOCAL_KEY = 'ocheevs_state_v1'
  const CHECK_INTERVAL = 30000
  const RESAVE_AFTER = 30000

  // ===== ACHIEVEMENTS =====
  // Each goal is counted from the totals Stash had when the plugin was first
  // loaded, so everyone starts fresh no matter how much they watched before.
  const TIERS = {
    common: { label: 'Common', accent: 'var(--ch-green)', points: 10 },
    uncommon: { label: 'Uncommon', accent: 'var(--ch-blue)', points: 25 },
    rare: { label: 'Rare', accent: 'var(--ch-purple)', points: 50 },
    epic: { label: 'Epic', accent: 'var(--ch-orange)', points: 100 },
    legendary: { label: 'Legendary', accent: 'var(--ch-amber)', points: 250 },
  }

  const TOAST_DURATION = 4000

  const MINUTE = 60
  const HOUR = 3600
  const DAY = 86400

  const CATEGORIES = [
    {
      id: 'watch',
      title: 'Watch Time',
      stat: 'watch',
      format: (v) => formatShortDuration(v),
      achievements: [
        { id: 'watch_1m', icon: '🎬', name: 'Press Play', goal: MINUTE, desc: 'Watch for 1 minute', tier: 'common' },
        { id: 'watch_1h', icon: '⏱️', name: 'Hour One', goal: HOUR, desc: 'Watch for 1 hour', tier: 'common' },
        { id: 'watch_10h', icon: '🍿', name: 'Binge Mode', goal: 10 * HOUR, desc: 'Watch for 10 hours', tier: 'uncommon' },
        { id: 'watch_1d', icon: '☀️', name: 'Full Day', goal: DAY, desc: 'Watch for 1 day', tier: 'rare' },
        { id: 'watch_1w', icon: '📅', name: 'Week Long', goal: 7 * DAY, desc: 'Watch for 1 week', tier: 'epic' },
        { id: 'watch_1mo', icon: '🌕', name: 'Month of Watching', goal: 30 * DAY, desc: 'Watch for 1 month (30 days)', tier: 'legendary' },
      ],
    },
    {
      id: 'o',
      title: "O's",
      stat: 'o',
      format: (v) => Math.floor(v).toLocaleString(),
      achievements: [
        { id: 'o_1', icon: '💦', name: 'First O', goal: 1, desc: 'Get 1 O', tier: 'common' },
        { id: 'o_10', icon: '🔟', name: 'Double Digits', goal: 10, desc: "Get 10 O's", tier: 'common' },
        { id: 'o_25', icon: '🌊', name: 'Making Waves', goal: 25, desc: "Get 25 O's", tier: 'uncommon' },
        { id: 'o_50', icon: '🏅', name: 'Half Century', goal: 50, desc: "Get 50 O's", tier: 'uncommon' },
        { id: 'o_100', icon: '💯', name: 'Centurion', goal: 100, desc: "Get 100 O's", tier: 'rare' },
        { id: 'o_250', icon: '🔥', name: 'On Fire', goal: 250, desc: "Get 250 O's", tier: 'epic' },
        { id: 'o_500', icon: '🚀', name: 'Liftoff', goal: 500, desc: "Get 500 O's", tier: 'epic' },
        { id: 'o_1000', icon: '👑', name: 'Thousand Club', goal: 1000, desc: "Get 1,000 O's", tier: 'legendary' },
      ],
    },
    {
      // Counts plays the way Stash does: a video counts once you've watched
      // enough of it (Minimum play percent in Stash's interface settings),
      // and watching the same video again counts again.
      id: 'plays',
      title: 'Videos Watched',
      stat: 'plays',
      format: (v) => Math.floor(v).toLocaleString(),
      achievements: [
        { id: 'plays_1', icon: '📺', name: 'First Watch', goal: 1, desc: 'Watch 1 video', tier: 'common' },
        { id: 'plays_10', icon: '📡', name: 'Channel Surfer', goal: 10, desc: 'Watch 10 videos', tier: 'common' },
        { id: 'plays_25', icon: '🎟️', name: 'Regular', goal: 25, desc: 'Watch 25 videos', tier: 'uncommon' },
        { id: 'plays_50', icon: '🎞️', name: 'Film Buff', goal: 50, desc: 'Watch 50 videos', tier: 'uncommon' },
        { id: 'plays_100', icon: '🏃', name: 'Marathoner', goal: 100, desc: 'Watch 100 videos', tier: 'rare' },
        { id: 'plays_250', icon: '🎥', name: 'Cinephile', goal: 250, desc: 'Watch 250 videos', tier: 'epic' },
        { id: 'plays_500', icon: '📚', name: 'Archivist', goal: 500, desc: 'Watch 500 videos', tier: 'epic' },
        { id: 'plays_1000', icon: '🌟', name: 'Library Legend', goal: 1000, desc: 'Watch 1,000 videos', tier: 'legendary' },
      ],
    },
  ]

  const ALL_ACHIEVEMENTS = CATEGORIES.flatMap((category) =>
    category.achievements.map((a) => ({ ...a, category })),
  )

  // ===== UTILITY FUNCTIONS =====
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
      console.error('[OCheevs] GraphQL errors:', result.errors)
      throw new Error(result.errors[0]?.message || 'GraphQL query failed')
    }

    return result.data
  }

  function createEl(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined && text !== null) node.innerText = text
    return node
  }

  function createSection(parent, title, note) {
    const section = createEl('section', 'ch-section')
    const head = createEl('div', 'ch-section-head')
    head.appendChild(createEl('h3', 'ch-section-title', title))
    if (note) head.appendChild(createEl('span', 'ch-section-note', note))
    section.appendChild(head)
    parent.appendChild(section)
    return section
  }

  function formatDuration(seconds) {
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m`
    if (seconds > 0) return `${Math.floor(seconds)}s`
    return '0m'
  }

  function formatLongDuration(seconds) {
    const days = Math.floor(seconds / 86400)
    if (days === 0) return formatDuration(seconds)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    return `${days}d ${hours}h ${minutes}m`
  }

  // Leaves out empty units so goals read "1h" or "1d" instead of "1h 0m"
  function formatShortDuration(seconds) {
    const parts = [
      [Math.floor(seconds / 86400), 'd'],
      [Math.floor((seconds % 86400) / 3600), 'h'],
      [Math.floor((seconds % 3600) / 60), 'm'],
    ].filter(([n]) => n > 0)
    if (parts.length === 0) {
      return seconds >= 1 ? `${Math.floor(seconds)}s` : '0m'
    }
    return parts.map(([n, unit]) => `${n}${unit}`).join(' ')
  }

  function formatDate(iso) {
    return new Date(iso).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  // Client-side navigation: Stash's router picks up the new address on popstate
  function navigateTo(path) {
    if (window.location.pathname === path) return
    window.history.pushState({}, '', path)
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }))
  }

  // ===== SETTINGS & STATE =====
  // Stash replaces a plugin's whole config on save, so every write starts from
  // the saved config to keep the user's settings.
  async function getPluginConfig() {
    const data = await callGQL({ query: 'query { configuration { plugins } }' })
    return data.configuration?.plugins?.[PLUGIN_ID] || {}
  }

  function readSettings(config) {
    const settings = {}
    Object.keys(config).forEach((key) => {
      if (key === LEGACY_DATA_KEY) return
      settings[key.replace(/^\d+[a-z]?_/, '')] = config[key]
    })
    return settings
  }

  async function getTotals() {
    const data = await callGQL({
      query: `query {
        stats {
          total_o_count
          total_play_duration
          total_play_count
        }
      }`,
    })
    return {
      watch: data.stats?.total_play_duration || 0,
      o: data.stats?.total_o_count || 0,
      plays: data.stats?.total_play_count || 0,
    }
  }

  function parseState(raw) {
    if (!raw) return null
    try {
      const state = typeof raw === 'string' ? JSON.parse(raw) : raw
      if (!state || !state.baseline || !state.startedAt) return null
      state.unlocked = state.unlocked || {}
      return state
    } catch (e) {
      return null
    }
  }

  // Returns null when there is no file yet (first run). Any other failure
  // throws, so a server hiccup never starts the achievements over.
  async function fetchSavedState() {
    const response = await fetch(`${DATA_URL}?t=${Date.now()}`, {
      cache: 'no-store',
    })
    if (response.status === 404) return null
    if (!response.ok) {
      throw new Error(`Failed to load progress: ${response.status}`)
    }
    return parseState(await response.json())
  }

  let lastSaveAt = 0

  function saveState(state) {
    lastSaveAt = Date.now()
    return callGQL({
      query: `mutation RunPluginTask($plugin_id: ID!, $task_name: String!, $args_map: Map) {
        runPluginTask(plugin_id: $plugin_id, task_name: $task_name, args_map: $args_map)
      }`,
      variables: {
        plugin_id: PLUGIN_ID,
        task_name: SAVE_TASK,
        args_map: { cheevs_data: JSON.stringify(state) },
      },
    }).catch((e) => console.error('[OCheevs] Failed to save progress:', e))
  }

  function newState(totals) {
    return {
      version: 2,
      startedAt: new Date().toISOString(),
      baseline: { ...totals },
      unlocked: {},
    }
  }

  // The save task runs in Stash's job queue, so the file can be a little
  // behind this tab. A later startedAt means a reset and wins; otherwise the
  // two are combined, keeping each unlock's earliest date.
  function combineStates(saved, cached) {
    if (!saved) return cached
    if (!cached) return saved
    if (saved.startedAt !== cached.startedAt) {
      return saved.startedAt > cached.startedAt ? saved : cached
    }
    const unlocked = { ...saved.unlocked }
    Object.entries(cached.unlocked).forEach(([id, date]) => {
      if (!unlocked[id] || date < unlocked[id]) unlocked[id] = date
    })
    return {
      ...saved,
      baseline: { ...cached.baseline, ...saved.baseline },
      unlocked,
    }
  }

  async function takeLegacyState(config) {
    let state = parseState(config[LEGACY_DATA_KEY])
    try {
      state = state || parseState(localStorage.getItem(LEGACY_LOCAL_KEY))
      localStorage.removeItem(LEGACY_LOCAL_KEY)
    } catch (e) {}
    if (LEGACY_DATA_KEY in config) {
      const rest = { ...config }
      delete rest[LEGACY_DATA_KEY]
      await callGQL({
        query: `mutation ($input: Map!) {
          configurePlugin(plugin_id: "${PLUGIN_ID}", input: $input)
        }`,
        variables: { input: rest },
      }).catch((e) => console.warn('[OCheevs] Failed to clear old data:', e))
    }
    return state
  }

  let stateCache = null

  // Loads saved progress, or starts counting from the current totals on the
  // very first run.
  async function loadState(config, totals) {
    const saved = await fetchSavedState()
    let state = combineStates(saved, stateCache)
    let needsSave = false

    if (!state) {
      state = await takeLegacyState(config)
      if (state) {
        console.log('[OCheevs] Moved progress to cheevs_data.json')
      } else {
        console.log('[OCheevs] First run, counting from current totals', totals)
        state = newState(totals)
      }
      needsSave = true
    }

    // Stats added in a later version start counting from now
    Object.keys(totals).forEach((key) => {
      if (typeof state.baseline[key] !== 'number') {
        state.baseline = { ...state.baseline, [key]: totals[key] }
        needsSave = true
      }
    })

    // Save again if the file is still missing something after a while
    const fileIsBehind =
      !saved ||
      saved.startedAt !== state.startedAt ||
      Object.keys(state.unlocked).some((id) => !saved.unlocked[id])
    if (fileIsBehind && Date.now() - lastSaveAt > RESAVE_AFTER) {
      needsSave = true
    }

    stateCache = state
    if (needsSave) await saveState(state)
    return state
  }

  function getProgress(state, totals) {
    const progress = {}
    Object.keys(totals).forEach((key) => {
      progress[key] = Math.max(0, totals[key] - (state.baseline[key] || 0))
    })
    return progress
  }

  // ===== CHECKING =====
  let inFlightCheck = null

  function checkAchievements() {
    if (inFlightCheck) return inFlightCheck
    inFlightCheck = runCheck().finally(() => {
      inFlightCheck = null
    })
    return inFlightCheck
  }

  async function runCheck() {
    const [config, totals] = await Promise.all([getPluginConfig(), getTotals()])
    const settings = readSettings(config)
    const state = await loadState(config, totals)
    const progress = getProgress(state, totals)

    const now = new Date().toISOString()
    const newlyUnlocked = ALL_ACHIEVEMENTS.filter(
      (a) => !state.unlocked[a.id] && progress[a.category.stat] >= a.goal,
    )
    if (newlyUnlocked.length > 0) {
      newlyUnlocked.forEach((a) => (state.unlocked[a.id] = now))
      await saveState(state)
      if (!settings.hideUnlockPopups) {
        newlyUnlocked.forEach((a, i) => setTimeout(() => showToast(a), i * 700))
      }
      // Redraw the achievements page if it's open
      const pageRoot = document.getElementById('cheevs-root')
      if (pageRoot) setTimeout(() => renderPage(pageRoot), 0)
    }

    return { settings, state, totals, progress }
  }

  // ===== UNLOCK POPUP =====
  // In fullscreen only the fullscreen element is drawn, so the popups move
  // into the player while it is fullscreen
  function getToastHost() {
    const fullscreen = document.fullscreenElement
    return fullscreen && fullscreen.tagName !== 'VIDEO'
      ? fullscreen
      : document.body
  }

  function getToastStack() {
    let stack = document.getElementById('ch-toasts')
    if (!stack) {
      stack = createEl('div', 'ch-toasts')
      stack.id = 'ch-toasts'
    }
    const host = getToastHost()
    if (stack.parentElement !== host) host.appendChild(stack)
    return stack
  }

  document.addEventListener('fullscreenchange', () => {
    const stack = document.getElementById('ch-toasts')
    if (stack) getToastHost().appendChild(stack)
  })

  function showToast(achievement) {
    const toast = createEl('div', 'ch-toast')
    toast.style.setProperty('--ch-accent', TIERS[achievement.tier].accent)
    toast.title = 'View achievements'
    toast.appendChild(createEl('div', 'ch-toast-icon', achievement.icon))
    toast.appendChild(createEl('div', 'ch-toast-kicker', 'Achievement Unlocked'))
    toast.appendChild(createEl('div', 'ch-toast-name', achievement.name))
    toast.appendChild(createEl('div', 'ch-toast-desc', achievement.desc))
    toast.appendChild(
      createEl(
        'div',
        'ch-toast-points',
        `+${TIERS[achievement.tier].points} pts`,
      ),
    )

    const dismiss = () => {
      toast.classList.add('is-leaving')
      setTimeout(() => toast.remove(), 600)
    }
    toast.addEventListener('click', () => {
      navigateTo(ROUTE)
      dismiss()
    })

    getToastStack().appendChild(toast)
    requestAnimationFrame(() => toast.classList.add('is-shown'))
    setTimeout(dismiss, TOAST_DURATION)
  }

  // ===== NAVBAR BUTTON =====
  let navButtonHidden = false

  function trophySvg() {
    const fa = window.PluginApi?.libraries?.FontAwesomeSolid?.faTrophy
    if (!fa) return null
    const [width, height, , , path] = fa.icon
    const ns = 'http://www.w3.org/2000/svg'
    const svg = document.createElementNS(ns, 'svg')
    svg.setAttribute('class', 'svg-inline--fa fa-trophy fa-icon')
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-hidden', 'true')
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('fill', 'currentColor')
    p.setAttribute('d', Array.isArray(path) ? path.join(' ') : path)
    svg.appendChild(p)
    return svg
  }

  // Stash draws the Stats link twice (top bar and collapsed menu), so each
  // one gets its own trophy button right after it
  function ensureNavButton() {
    if (navButtonHidden) {
      document.querySelectorAll('.ch-nav-button').forEach((b) => b.remove())
      return
    }
    document
      .querySelectorAll('a.nav-utility[href="/stats"]')
      .forEach(ensureNavButtonAfter)
  }

  function ensureNavButtonAfter(statsLink) {
    let link = statsLink.nextElementSibling
    if (!link?.classList.contains('ch-nav-button')) {
      link = createEl('a', 'nav-utility ch-nav-button')
      link.href = ROUTE
      const statsButton = statsLink.querySelector('button')
      const button = createEl(
        'button',
        statsButton?.className ||
          'minimal d-flex align-items-center h-100 btn btn-primary',
      )
      button.type = 'button'
      button.title = 'Achievements'
      button.appendChild(trophySvg() || document.createTextNode('🏆'))
      link.appendChild(button)
      link.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return
        e.preventDefault()
        navigateTo(ROUTE)
      })
      statsLink.after(link)
    }

    const active = window.location.pathname === ROUTE
    link.classList.toggle('active', active)
    // Stash marks the Stats link active by prefix; only one should light up
    if (active) statsLink.classList.remove('active')
  }

  let navQueued = false
  new MutationObserver(() => {
    if (navQueued) return
    navQueued = true
    requestAnimationFrame(() => {
      navQueued = false
      ensureNavButton()
    })
  }).observe(document.body, { childList: true, subtree: true })
  window.addEventListener('popstate', ensureNavButton)

  // ===== PAGE =====
  function createSummaryStat(grid, { icon, value, label, sub, accent }) {
    const card = createEl('div', 'ch-card ch-stat')
    if (accent) card.style.setProperty('--ch-accent', accent)
    card.appendChild(createEl('div', 'ch-stat-icon', icon))
    card.appendChild(createEl('div', 'ch-stat-value', value))
    card.appendChild(createEl('div', 'ch-stat-label', label))
    if (sub) card.appendChild(createEl('div', 'ch-stat-sub', sub))
    grid.appendChild(card)
  }

  function createAchievementCard(grid, achievement, state, progress) {
    const { category } = achievement
    const tier = TIERS[achievement.tier]
    const unlockedAt = state.unlocked[achievement.id]
    const current = Math.min(progress[category.stat], achievement.goal)
    const pct = Math.floor((current / achievement.goal) * 100)

    const card = createEl(
      'div',
      `ch-card ch-ach ${unlockedAt ? 'is-unlocked' : 'is-locked'}`,
    )
    card.style.setProperty('--ch-accent', tier.accent)

    const top = createEl('div', 'ch-ach-top')
    const icon = createEl('div', 'ch-ach-icon', achievement.icon)
    if (!unlockedAt) icon.appendChild(createEl('span', 'ch-ach-lock', '🔒'))
    top.appendChild(icon)
    const text = createEl('div', 'ch-ach-text')
    text.appendChild(createEl('div', 'ch-ach-name', achievement.name))
    text.appendChild(createEl('div', 'ch-ach-desc', achievement.desc))
    top.appendChild(text)
    top.appendChild(createEl('span', 'ch-tier', tier.label))
    card.appendChild(top)

    const bar = createEl('div', 'ch-bar')
    const fill = createEl('div', 'ch-bar-fill')
    fill.style.width = `${unlockedAt ? 100 : pct}%`
    bar.appendChild(fill)
    card.appendChild(bar)

    const meta = createEl('div', 'ch-ach-meta')
    if (unlockedAt) {
      meta.appendChild(
        createEl('span', 'ch-ach-done', `✓ Unlocked ${formatDate(unlockedAt)}`),
      )
      meta.appendChild(createEl('span', 'ch-ach-points', `+${tier.points} pts`))
    } else {
      meta.appendChild(
        createEl(
          'span',
          '',
          `${category.format(current)} / ${category.format(achievement.goal)}`,
        ),
      )
      const right = createEl('span', '', `${pct}% · `)
      right.appendChild(createEl('span', 'ch-ach-points', `${tier.points} pts`))
      meta.appendChild(right)
    }
    card.appendChild(meta)

    grid.appendChild(card)
  }

  async function renderPage(root) {
    root.innerHTML = ''

    const hero = createEl('header', 'ch-hero')
    const heroTitle = createEl('div', 'ch-hero-title')
    heroTitle.appendChild(createEl('div', 'ch-hero-mark', '🏆'))
    const heroText = createEl('div')
    heroText.appendChild(createEl('h2', '', 'Achievements'))
    const heroSub = createEl('div', 'ch-hero-sub', 'Loading…')
    heroText.appendChild(heroSub)
    heroTitle.appendChild(heroText)
    hero.appendChild(heroTitle)

    const actions = createEl('div', 'ch-actions')
    const resetButton = createEl('button', 'ch-btn', '↺ Reset')
    resetButton.type = 'button'
    resetButton.title =
      'Start counting again from your current totals and lock every achievement'
    actions.appendChild(resetButton)
    const settingsLink = createEl('a', 'ch-btn', '⚙ Settings')
    settingsLink.href = '/settings?tab=plugins'
    settingsLink.title = 'O Cheevs settings are under Plugins'
    actions.appendChild(settingsLink)
    hero.appendChild(actions)
    root.appendChild(hero)

    let result
    try {
      result = await checkAchievements()
    } catch (e) {
      console.error('[OCheevs] Failed to load achievements:', e)
      heroSub.innerText = 'Failed to load achievements.'
      return
    }
    if (!root.isConnected) return
    const { state, totals, progress } = result

    heroSub.innerText = `Counting since ${formatDate(state.startedAt)}`

    resetButton.addEventListener('click', async () => {
      const ok = window.confirm(
        'Reset all achievements? Progress will start again from your current totals and every achievement will be locked.',
      )
      if (!ok) return
      resetButton.disabled = true
      stateCache = newState(totals)
      await saveState(stateCache)
      renderPage(root)
    })

    // Summary
    const unlockedCount = ALL_ACHIEVEMENTS.filter(
      (a) => state.unlocked[a.id],
    ).length
    const nextUp = ALL_ACHIEVEMENTS.filter((a) => !state.unlocked[a.id])
      .map((a) => ({ a, pct: progress[a.category.stat] / a.goal }))
      .sort((x, y) => y.pct - x.pct)[0]

    const earnedPoints = ALL_ACHIEVEMENTS.filter(
      (a) => state.unlocked[a.id],
    ).reduce((sum, a) => sum + TIERS[a.tier].points, 0)
    const totalPoints = ALL_ACHIEVEMENTS.reduce(
      (sum, a) => sum + TIERS[a.tier].points,
      0,
    )

    const summary = createSection(
      root,
      'Overview & Stats Since Tracking Started',
    )
    const pointsTag = createEl(
      'span',
      'ch-points-tag',
      `⭐ ${earnedPoints.toLocaleString()} pts `,
    )
    pointsTag.appendChild(
      createEl('span', '', `/ ${totalPoints.toLocaleString()}`),
    )
    pointsTag.title = 'Points from unlocked achievements'
    summary.querySelector('.ch-section-head').appendChild(pointsTag)
    const grid = createEl('div', 'ch-grid')
    summary.appendChild(grid)
    createSummaryStat(grid, {
      icon: '🏆',
      value: `${unlockedCount} / ${ALL_ACHIEVEMENTS.length}`,
      label: 'Unlocked',
      sub: `${Math.floor((unlockedCount / ALL_ACHIEVEMENTS.length) * 100)}% complete`,
      accent: 'var(--ch-amber)',
    })
    createSummaryStat(grid, {
      icon: '⏱️',
      value: formatLongDuration(progress.watch),
      label: 'Watch Time',
      accent: 'var(--ch-green)',
    })
    createSummaryStat(grid, {
      icon: '💦',
      value: progress.o.toLocaleString(),
      label: "O's",
      accent: 'var(--ch-blue)',
    })
    createSummaryStat(grid, {
      icon: '📺',
      value: progress.plays.toLocaleString(),
      label: 'Videos Watched',
      accent: 'var(--ch-purple)',
    })
    createSummaryStat(grid, {
      icon: nextUp ? nextUp.a.icon : '👑',
      value: nextUp ? nextUp.a.name : 'All done',
      label: 'Next Up',
      sub: nextUp
        ? `${Math.floor(nextUp.pct * 100)}% · ${nextUp.a.desc}`
        : 'Every achievement unlocked',
      accent: nextUp ? TIERS[nextUp.a.tier].accent : 'var(--ch-amber)',
    })

    // One section per category
    for (const category of CATEGORIES) {
      const done = category.achievements.filter(
        (a) => state.unlocked[a.id],
      ).length
      const section = createSection(
        root,
        category.title,
        `${done} / ${category.achievements.length} unlocked`,
      )
      const achGrid = createEl('div', 'ch-ach-grid')
      section.appendChild(achGrid)
      category.achievements.forEach((a) =>
        createAchievementCard(achGrid, { ...a, category }, state, progress),
      )
    }
  }

  // ===== ROUTE =====
  function registerRoute() {
    const api = window.PluginApi
    if (!api?.register?.route) {
      console.error('[OCheevs] PluginApi.register.route is not available')
      return
    }
    const React = api.React

    function CheevsPage() {
      const ref = React.useRef(null)
      React.useEffect(() => {
        const previousTitle = document.title
        document.title = 'Achievements | Stash'
        renderPage(ref.current)
        return () => {
          document.title = previousTitle
        }
      }, [])
      return React.createElement(
        'div',
        { className: 'container-fluid ch-page' },
        React.createElement('div', { ref, className: 'ch', id: 'cheevs-root' }),
      )
    }

    api.register.route(ROUTE, CheevsPage)
  }

  // ===== START =====
  registerRoute()

  async function backgroundCheck() {
    if (document.hidden) return
    try {
      const { settings } = await checkAchievements()
      if (navButtonHidden !== !!settings.hideNavButton) {
        navButtonHidden = !!settings.hideNavButton
        ensureNavButton()
      }
    } catch (e) {
      console.warn('[OCheevs] Achievement check failed:', e)
    }
  }

  backgroundCheck()
  setInterval(backgroundCheck, CHECK_INTERVAL)
  document.addEventListener('visibilitychange', backgroundCheck)

  // Check right after Stash saves an O, a play or watch progress, so popups
  // show up straight away instead of on the next timed check
  const PROGRESS_MUTATIONS =
    /\b(SceneAddO|SceneAddPlay|SceneSaveActivity|ImageIncrementO)\b/
  let progressCheckTimer = null
  const originalFetch = window.fetch
  window.fetch = function (input, init) {
    const result = originalFetch.apply(this, arguments)
    if (
      typeof init?.body === 'string' &&
      PROGRESS_MUTATIONS.test(init.body)
    ) {
      result
        .then(() => {
          clearTimeout(progressCheckTimer)
          progressCheckTimer = setTimeout(backgroundCheck, 1000)
        })
        .catch(() => {})
    }
    return result
  }
})()
