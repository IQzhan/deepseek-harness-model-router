/**
 * Render the client half for real.
 *
 * A blank settings page means the registered component threw during render and
 * an error boundary swallowed it — or never found its data. Guessing at the
 * cause is expensive, so this loads the SHIPPED bundle, registers it against a
 * stub slot system, and renders it with real React. Any throw surfaces with its
 * stack, and the rendered HTML is asserted for the things the page must show.
 *
 * Run: node test-render.mjs
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const ANCHOR = `${HOME.replace(/\\/g, '/')}/profiles/web/cordis.patch.yml`
const require = createRequire(ANCHOR)

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

// ── real React ──────────────────────────────────────────────────────────────
const React = (await import(pathToFileURL(require.resolve('react')).href)).default
const { renderToString } = await import(pathToFileURL(require.resolve('react-dom/server')).href)

const clientSource = readFileSync(require.resolve('dsh-model-router/client'), 'utf8')

// ── the document the page renders from ──────────────────────────────────────
//
// The task names, descriptions and keywords below are USER CONTENT, not copy:
// the page must print them verbatim whatever language it is in. They are kept
// ASCII here so that the bilingual check further down ("the english render
// carries no Chinese at all") measures the page's own copy and nothing else —
// a Chinese task name in this fixture would legitimately appear in the English
// render and make that assertion meaningless.
function config() {
  return {
    enabled: true,
    defaultTaskId: 'general',
    classifier: { enabled: true, provider: 'google', model: 'gemini-3.7-flash', maxInputTokens: 4000, timeoutMs: 15000 },
    presets: { 'diy-smart': { enabled: true } },
    tasks: [
      { id: 'modelling', name: '3D modelling', description: '3D modelling, CAD, mechanical design', enabled: true,
        keywords: ['modelling', 'FreeCAD'], pool: [
          { provider: 'google', model: 'gemini-3.7-flash', weight: 2 },
          { provider: 'google', model: 'gemini-3.6-flash', weight: 1 }] },
      { id: 'general', name: 'General subtasks', description: 'Everyday subtasks', enabled: true, keywords: [],
        pool: [{ provider: 'or', model: 'free', weight: 1 }] },
    ],
  }
}

/**
 * A document whose tool scope is written as a DENY list.
 *
 * This is the shape the samples ship (`{ deny: ['write', 'edit', 'pwsh'] }`) and the
 * one the page used to misrepresent: it understood `allow` only, so a deny document
 * rendered as "filter on, nothing ticked" — the opposite of what it said — and the
 * next tick rewrote it into an allow list of one tool. Every assertion below about
 * this fixture is a regression test for that.
 */
function denyConfig() {
  const document = config()
  document.tasks[0].childTools = { deny: ['pwsh', 'write'] }
  document.tasks[1].childTools = { allow: ['read', 'write', 'edit'], deny: ['edit'] }
  return document
}

const PROVIDERS = [{ id: 'google', name: 'google' }, { id: 'or', name: 'or' }]
const MODELS = {
  google: [
    { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  ],
  or: [{ id: 'free', name: 'free' }],
}

/** A settings mirror, shaped like `ctx.settingsScope.bind(...)`. */
function makeScope(value, status = 'ready', overrides = {}) {
  return {
    getSnapshot: () => {
      if (overrides.snapshotThrows !== undefined) throw new Error(overrides.snapshotThrows)
      return {
        status, value, base: undefined, user: undefined,
        revision: 1, writable: true, mode: 'host',
      }
    },
    subscribe: () => {
      if (overrides.subscribeThrows !== undefined) throw new Error(overrides.subscribeThrows)
      return () => {}
    },
    set: async () => {},
    unset: async () => {},
    mutate: async () => {},
  }
}

/**
 * The copy dictionaries the page registers, and the language in force.
 *
 * The stub below captures what `ctx.locale.register` receives and answers `bind`
 * from it, so a test can switch the language and render again — which is the only
 * way to prove the page FOLLOWS the harness language instead of being pinned to
 * one. (The real plugin resolves through the same call.)
 */
const registeredCopy = new Map()
let activeLanguage = 'zh'

/**
 * Evaluate the bundle and apply it, returning the registered component.
 * @param value - the settings value the mirror will report.
 * @param status - the mirror's sync status.
 */
function load(value, status = 'ready', overrides = {}) {
  const registered = []
  const inserted = []
  const presetFace = {
    list: async () => {
      if (overrides.presetsThrow !== undefined) throw new Error(overrides.presetsThrow)
      return overrides.presetsFail === undefined
        ? { ok: true, value: overrides.presets ?? [{ id: 'diy-smart' }, { id: 'diy' }] }
        : { ok: false, error: { code: 'gateway/down', message: overrides.presetsFail } }
    },
  }
  const sessionFace = {
    // The Host catalog, shaped exactly like `ModelCatalog`:
    // { default, routableProviders, groups, failures }.
    modelCatalog: async () => ({
      ok: true,
      value: {
        default: { provider: 'or', model: 'free' },
        routableProviders: (overrides.providers ?? PROVIDERS).map(provider => provider.id),
        groups: Object.entries(overrides.models ?? MODELS).map(([id, models]) => ({ id, name: id, models })),
        failures: overrides.failures ?? [],
      },
    }),
  }
  const ctx = {
    slots: {
      inject: (slot, callback) => callback(),
      register: (options, component) => registered.push({ options, component }),
    },
    effect: (callback) => { callback(); return () => {} },
    locale: {
      register: (namespace, dictionary) => {
        registeredCopy.set(namespace, dictionary)
        return () => registeredCopy.delete(namespace)
      },
      bind: namespace => key => (registeredCopy.get(namespace)?.[activeLanguage] ?? {})[key] ?? key,
      subscribe: () => () => {},
      getSnapshot: () => ({ revision: 1, active: activeLanguage }),
    },
    // The dotted Remote namespaces are SERVICES: `ctx.get('remote.<ns>')` is the
    // sanctioned accessor and answers undefined when absent, while the property
    // read off `ctx.remote` may throw.
    get: (name) => {
      // The page's configuration mirror. Production builds the HTTP-backed one;
      // a test supplies one with the same surface — which is also what keeps this
      // suite synchronous, since a fetch-backed mirror is only ready after an
      // await and every content assertion below is a server render.
      if (name === 'modelRoutingConfig') return makeScope(value, status, overrides)
      if (overrides.roster !== undefined && name === 'agentPresets') return overrides.roster
      if (name === 'remote.agentPresets') return overrides.noFaces === true ? undefined : presetFace
      if (name === 'remote.session') return overrides.noFaces === true ? undefined : sessionFace
      return undefined
    },
    settingsScope: {
      bind: () => {
        if (overrides.bindThrows !== undefined) throw new Error(overrides.bindThrows)
        return makeScope(value, status, overrides)
      },
    },
    remote: overrides.hostileRemote === true
      // A gateway face whose every property access throws. The section must
      // survive this: resolving faces happens while the panel is registered, so
      // an unguarded read here blanks the whole page.
      ? new Proxy({}, { get: () => { throw new Error('remote namespace unavailable') } })
      : { session: sessionFace, agentPresets: presetFace, llm: { listProviders: async () => ({ ok: true, value: overrides.providers ?? PROVIDERS }) } },
  }
  let registration = null
  new Function('window', 'React', 'styles', 'ctx', clientSource)(
    { __ModuleLoader__: { load: (value2) => { registration = value2 } } },
    React, { insert: (css) => { inserted.push(css); return () => {} } }, ctx,
  )
  const moduleObject = registration.factory((specifier) => {
    if (specifier === 'react') return React
    throw new Error(`unexpected external "${specifier}"`)
  })
  moduleObject.apply(ctx)
  return { page: registered[0], inserted, ctx, moduleObject }
}

/**
 * Render once, reporting a throw as a failed assertion rather than a crash.
 *
 * The registered component is rendered THROUGH React rather than invoked
 * directly: it is a component, so `createElement` + `renderToString` is what
 * runs its hooks and produces the full tree (head, status line, every card).
 */
function render(label, ...args) {
  const loaded = load(...args)
  const overrides = args[2] ?? {}
  try {
    // The shell merges the owner props with whatever `inject()` returns; the
    // component reads its faces from props, so the test must do the same.
    const faces = typeof loaded.page.options.inject === 'function' ? loaded.page.options.inject() : {}
    // Every task card starts CLOSED, because five open cards is the scroll this
    // page was. The body assertions below therefore ask for the expanded start;
    // the collapsed default is asserted on its own with `collapsed: true`.
    const html = renderToString(React.createElement(loaded.page.component, {
      ...faces, close: () => {}, expandAllTasks: overrides.collapsed === true ? undefined : true,
    }))
    check(`renders: ${label}`, true, true)
    return { html, loaded }
  } catch (error) {
    check(`renders: ${label}`, `THREW: ${error instanceof Error ? error.message : String(error)}`, true)
    if (error instanceof Error && error.stack !== undefined) {
      console.log(`      ${error.stack.split('\n').slice(1, 4).join('\n      ')}`)
    }
    return { html: '', loaded }
  }
}

// ── the registrations the shell depends on ──────────────────────────────────
{
  const { page, inserted, loaded } = load(config())
  check('a settings section was registered', page !== undefined, true)
  check('section id', page.options.id, 'model-routing')
  check('section slot name', page.options.name, 'settings.section')
  check('section order sits between Models and Plugins', page.options.order, 12)
  // The nav row renders this text; without it the sidebar shows a blank row.
  check('section carries a nav label', typeof page.options.label, 'function')
  check('nav label reads 任务路由', page.options.label(), '任务路由')
  check('the stylesheet reached the document', inserted.length, 1)
  check('stylesheet carries the nav icon override', inserted[0].includes('data:image/svg+xml'), true)
  // The injected faces the component receives.
  const face = page.options.inject()
  check('the injected face carries a settings mirror', typeof face.scope?.getSnapshot, 'function')
  check('the injected face carries the Host model catalog', typeof face.session?.modelCatalog, 'function')
  void loaded
}

// ── the states the page must survive ────────────────────────────────────────
{
  const { html } = render('loading', config(), 'loading')
  check('a loading mirror shows the title', html.includes('任务路由'), true)
  check('a loading mirror says so', html.includes('载入中'), true)
}
{
  const { html } = render('unavailable mirror', config(), 'unavailable')
  check('an unavailable mirror explains itself', html.includes('配置不可读写'), true)
  check('an unavailable mirror still shows the title', html.includes('任务路由'), true)
}
{
  const { html } = render('empty document', undefined)
  check('an empty document renders the title', html.includes('任务路由'), true)
  check('an empty document renders the cascade', html.includes('判定顺序'), true)
  check('an empty document renders no task cards', html.includes('dsh-mr-task'), false)
}

// ── the full page ───────────────────────────────────────────────────────────
{
  const { html } = render('full document', config(), 'ready', { roster: ['diy-smart', 'diy'] })
  check('title is present', html.includes('任务路由'), true)
  check('the scope line explains the range', html.includes('子智能体'), true)
  check('the cascade explainer is present', html.includes('判定顺序'), true)
  check('the master switch is present', html.includes('启用任务路由'), true)
  check('the default-task selector is present', html.includes('默认任务'), true)
  check('the classifier card is present', html.includes('语义分类器'), true)
  check('the delegation card names both tools',
    html.includes('subagent_message') && html.includes('委派工具'), true)
  // The save bar is the ONLY path that writes, and it says what state the edit
  // session is in rather than leaving it to be guessed.
  check('the save bar is present', html.includes('dsh-mr-savebar'), true)
  check('a fresh page reports no unsaved changes', html.includes('没有未保存的修改'), true)
  check('with a save control', html.includes('>保存<'), true)
  // The per-task child profile: click-only where it can be.
  check('the child profile card is present', html.includes('子智能体档案'), true)
  // The persona control is ONE textarea plus click-to-fill: a mode selector
  // cannot represent "custom, still empty", which is exactly how it broke.
  check('the persona control states that empty means inherit',
    html.includes('提示词（留空 = 继承父预设）'), true)
  check('and offers the template as a click, not a mode',
    html.includes('填入通用执行者模板'), true)
  check('the reasoning effort picker is present', html.includes('推理强度'), true)
  // Tools are a MODE plus tags: the document has two spellings for one field and
  // only one of them can be in force, so the control says which one it is.
  check('the tool filter is a labelled control', html.includes('限制子智能体可用工具'), true)
  // The tool list arrives in an effect, so a server render shows the empty-list
  // branch — which must SAY why the switch is unavailable instead of going grey
  // with no explanation (the failure the operator actually hit). The behaviour
  // behind it is covered by `defaultChildTools`/`normalizeTask` above.
  check('and says why when the tool list is not loaded yet',
    html.includes('读不到工具清单'), true)
  check('and explains that the same child keeps the task',
    html.includes('任务归属因此始终清晰'), true)
  // The budget field must read the DOCUMENT's value, not a default: a renamed
  // field that silently falls back would look right and ignore the setting.
  check('the classifier budget field shows the stored value', html.includes('value="4000"'), true)
  check('the classifier timeout field shows the stored value', html.includes('value="15000"'), true)
  check('the budget is described as tokens', html.includes('输入上限（tokens）'), true)
  check('task cards are rendered', (html.match(/dsh-mr-task\b/g) ?? []).length >= 2, true)
  check('the model pool shows weights', html.includes('权重合计 3'), true)
  check('the pool shows the share per model', html.includes('67%') && html.includes('33%'), true)
  // The roster arrives from an async service, so a server render always sees an
  // empty list; what matters here is that the section renders and explains itself.
  check('the grant section renders', html.includes('按预设授权'), true)
  check('the grant section says when the roster is empty', html.includes('预设清单为空'), true)
  check('the runtime readout names the catalog source', html.includes('模型目录'), true)
  check('and says it is the same source as the model picker', html.includes('与输入框旁的模型选择器同源'), true)
  check('the preview section is present', html.includes('路由预览'), true)
  check('the page never prints a bare "undefined"', html.includes('undefined'), false)
}

// ── task cards: closed on entry, informative while closed ───────────────────
{
  const { html } = render('closed by default', config(), 'ready', { collapsed: true })
  check('every card starts closed', html.includes('dsh-mr-task-body'), false)
  check('a closed card is still a card', (html.match(/dsh-mr-task\b/g) ?? []).length >= 2, true)
  // A closed card that says nothing is a hidden card: the head keeps the identity,
  // the model count and the tool spelling in force.
  check('and names the task', html.includes('3D modelling'), true)
  check('and states the model count', html.includes('2 个模型'), true)
  check('and offers a twisty per card', (html.match(/dsh-mr-twisty/g) ?? []).length >= 2, true)
  check('and marks it as closed for assistive tech', html.includes('aria-expanded="false"'), true)
}
{
  const { html } = render('expanded on request', config(), 'ready', {})
  check('the expanded start renders the body', html.includes('dsh-mr-task-body'), true)
  check('and marks the card open for assistive tech', html.includes('aria-expanded="true"'), true)
}

// ── the two tool spellings, on screen ───────────────────────────────────────
{
  const { html } = render('a deny document', denyConfig())
  // The regression this fixture exists for: a deny document used to render as
  // "filter on, nothing ticked", because only `allow` was ever read — and the
  // next tick rewrote the file into an allow list of one tool.
  check('the deny spelling is the one selected', html.includes('除勾选外都允许（黑名单）'), true)
  check('and the page says what a deny list does about future tools',
    html.includes('以后 DSH 新增的工具会自动获得'), true)
  check('and what an allow list does about them',
    html.includes('以后 DSH 新增的工具不会自动获得'), true)
  check('the closed head states the deny scope', html.includes('黑名单 2'), true)
  // A document declaring both spellings is displayed as the Host resolves it, and
  // says so rather than quietly dropping one of them.
  check('a document with both spellings explains the resolution',
    html.includes('同时写了 allow 和 deny'), true)
  check('and shows the resolved scope in the head', html.includes('白名单 2'), true)
  // The boxes themselves need the Host's tool list, which only arrives in an
  // effect — a server render never has it, so the box logic is exercised through
  // the same functions the boxes call (below), not through this HTML.
}
{
  const { childToolsView, toggleChildTool } = load(config()).moduleObject.__testing
  // The exact sequence that used to destroy a deny document: open the page on a
  // deny task, tick one more tool, untick an excluded one, then save.
  let draft = { deny: ['pwsh'] }
  draft = toggleChildTool(draft, childToolsView({ childTools: draft }).mode, 'write', true)
  draft = toggleChildTool(draft, childToolsView({ childTools: draft }).mode, 'pwsh', false)
  check('editing a deny document never turns it into an allow document', 'deny' in draft, true)
  check('and the edits land in the deny list', draft.deny, ['write'])
}
{
  const { html } = render('an unrestricted document', config())
  check('an unrestricted task keeps the no-restriction default', html.includes('不限制（继承全部）'), true)
  check('and explains that the child inherits everything',
    html.includes('子智能体拿到父预设的全部工具'), true)
  // The badge carries a COUNT ("白名单 2"); the select's option text, which is
  // always on screen, does not — so this asserts the badge, not the word.
  check('and states no tool scope in the head', /白名单 \d/u.test(html), false)
}

// ── the tool scope round-trips through the page's own logic ─────────────────
{
  const { childToolsView, withChildToolsMode, toggleChildTool } = load(config()).moduleObject.__testing
  const TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'job_list']
  const deny = { deny: ['pwsh'] }
  check('a deny document reads as deny mode', childToolsView({ childTools: deny }).mode, 'deny')
  check('and its list is the deny list', childToolsView({ childTools: deny }).list, ['pwsh'])
  check('ticking in deny mode writes back a deny list',
    toggleChildTool(deny, 'deny', 'write', true), { deny: ['pwsh', 'write'] })
  check('unticking in deny mode removes from the deny list',
    toggleChildTool(deny, 'deny', 'pwsh', false), { deny: [] })
  check('an allow document reads as allow mode',
    childToolsView({ childTools: { allow: ['read'] } }).mode, 'allow')
  check('ticking in allow mode writes back an allow list',
    toggleChildTool({ allow: ['read'] }, 'allow', 'edit', true), { allow: ['read', 'edit'] })
  check('the last allow entry cannot be dropped (an empty list means no filter)',
    toggleChildTool({ allow: ['read'] }, 'allow', 'read', false), { allow: ['read'] })
  check('both spellings resolve to allow-minus-deny',
    childToolsView({ childTools: { allow: ['read', 'edit'], deny: ['edit'] } }).list, ['read'])
  check('and the page is told the document declared both',
    childToolsView({ childTools: { allow: ['read'], deny: ['edit'] } }).resolved, true)
  check('an absent filter reads as no restriction', childToolsView({}).mode, 'all')
  check('switching to deny starts empty, so no hidden filter appears',
    withChildToolsMode({ allow: ['read'] }, 'deny', TOOLS), { deny: [] })
  check('switching to allow seeds the ordinary work tools',
    withChildToolsMode(null, 'allow', TOOLS), { allow: ['read', 'write', 'edit', 'glob', 'grep'] })
  check('switching to no restriction writes nothing at all',
    withChildToolsMode({ deny: ['pwsh'] }, 'all', TOOLS), null)
}

// ── the preview ladder, driven through the rendered input ───────────────────
{
  const { html } = render('preview samples', config(), 'ready', { roster: ['diy-smart'] })
  check('preview is inert until text is typed', html.includes('判定结果'), false)
}

// ── a catalog with nothing in it must degrade, not throw ────────────────────
{
  const { html } = render('empty catalog', config(), 'ready', { providers: [], models: {} })
  check('an empty catalog still renders the tasks', html.includes('dsh-mr-task'), true)
  // The catalog is fetched in an effect, which a server render never runs.\n  check('an empty catalog shows the reading state', html.includes('读取中'), true)
}

// ── a corrupted pool entry is reported, not silently accepted ───────────────
//
// Asserted through the exported helper rather than the HTML: a broken route and
// a missing one look identical in a `<select>` that has no matching option, so
// only the message proves the page noticed.
{
  const { moduleObject } = load(config())
  const { routeProblem } = moduleObject.__testing
  const known = new Set(['google\u0000gemini-3.7-flash'])
  check('a healthy route reports no problem',
    routeProblem({ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }, known), undefined)
  check('a stringified-undefined model is reported as corruption',
    routeProblem({ provider: 'deepseek-official', model: 'undefined', weight: 1 }, known)
      .includes('字符串 "undefined"'), true)
  check('an unknown but well-formed route is reported as missing',
    routeProblem({ provider: 'google', model: 'gemini-9-flash', weight: 1 }, known)
      .includes('找不到这条路由'), true)
}

// ── the preview ladder, asserted on the pure helper ─────────────────────────
{
  const { moduleObject } = load(config())
  const { describePreview } = moduleObject.__testing
  const document = config()
  check('preview: explicit directive wins',
    describePreview(document, '建模 [task: general]', 'diy-smart').includes('general'), true)
  check('preview: keyword hit',
    describePreview(document, '用 FreeCAD 画个零件', 'diy-smart').includes('modelling'), true)
  check('preview: unmatched falls to the default',
    describePreview(document, '写一首诗', 'diy-smart').includes('default'), true)
  check('preview: an ungranted preset is called out',
    describePreview(document, '建模', 'nope').includes('未授权'), true)
  check('preview: a disabled router is called out',
    describePreview({ ...document, enabled: false }, '建模', 'diy-smart').includes('disabled'), true)
  const noDefault = { ...document, defaultTaskId: '' }
  check('preview: no default means unmatched',
    describePreview(noDefault, '写一首诗', 'diy-smart').includes('unmatched'), true)
}

// ── the grant section, when the roster is available ─────────────────────────
{
  const { moduleObject } = load(config())
  const { asConfig } = moduleObject.__testing
  check('a missing document becomes a complete one',
    Object.keys(asConfig(undefined)).sort(), ['classifier', 'defaultTaskId', 'enabled', 'presets', 'tasks'])
  check('a malformed tasks field degrades to an empty list', asConfig({ tasks: 'nope' }).tasks, [])
  check('a malformed presets field degrades to an empty map', asConfig({ presets: [] }).presets, {})
}

// ── the panel must never go blank ───────────────────────────────────────────
//
// Twice this section rendered as an EMPTY PANEL: the nav row appeared, the page
// was blank, and nothing on screen said which plugin had failed. These tests are
// the guarantee that it cannot happen again — every hostile condition below must
// still produce a titled page carrying a readable diagnosis.
{
  // The plugin logs the cause to the console on purpose. Capture it so the run
  // stays readable, and assert it happened exactly once per distinct failure.
  const logged = []
  const realError = console.error
  const mute = () => { console.error = (...values) => logged.push(values.map(String).join(' ')) }
  const unmute = () => { console.error = realError }

  /** Render one hostile configuration and report the HTML plus what was logged. */
  function renderHostile(overrides) {
    const loaded = load(config(), 'ready', overrides)
    let facesFor
    let injectThrew
    try {
      facesFor = loaded.page.options.inject()
    } catch (failure) {
      injectThrew = failure.message
    }
    let html = ''
    mute()
    try {
      html = renderToString(React.createElement(loaded.page.component, { ...facesFor, close: () => {} }))
    } catch (failure) {
      html = `THREW ${failure.message}`
    } finally {
      unmute()
    }
    return { html, faces: facesFor, injectThrew, logged: [...logged] }
  }

  // 1. A gateway whose every PROPERTY access throws, while the dotted service is
  //    still resolvable. This is the live failure that blanked the panel: the
  //    faces were read as properties, the read threw during registration, and
  //    the page vanished. Resolving through `ctx.get('remote.<ns>')` first keeps
  //    the hostile property unread and the page working.
  const hostile = renderHostile({ hostileRemote: true })
  check('resolving faces never throws', hostile.injectThrew, undefined)
  check('and the hostile property is never touched', hostile.faces.fault, undefined)
  check('and the panel renders its real content',
    hostile.html.includes('按预设授权') && hostile.html.includes('判定顺序'), true)

  // The fault path still exists for the case where NEITHER route works.
  const noFaces = renderHostile({ hostileRemote: true, noFaces: true })
  check('a total face failure is reported', typeof noFaces.faces.fault, 'string')
  check('and the page still renders its title', noFaces.html.includes('任务路由'), true)
  check('with the reason on screen', noFaces.html.includes('设置页无法连接 Host'), true)

  // 2. A hostile `settingsScope`. Since the configuration moved to its own
  //    folder, the page does not touch that service at all — so a throwing bind
  //    must now be IRRELEVANT rather than fatal. That is a real robustness gain,
  //    and it is asserted rather than assumed.
  const noScope = renderHostile({ bindThrows: 'settingsScope unavailable' })
  check('a throwing settingsScope no longer matters', noScope.faces.fault, undefined)
  check('and the panel renders its real content',
    noScope.html.includes('判定顺序'), true)

  // 3. A mirror that throws while RENDERING. `useSyncExternalStore` calls the
  //    snapshot reader during render, so an escaping throw here IS the blank
  //    page — the component must treat every face read as total.
  const brokenMirror = renderHostile({ snapshotThrows: 'mirror exploded' })
  check('a throwing snapshot reader does not take the page down',
    brokenMirror.html.includes('任务路由'), true)
  check('and the failure is stated on the page',
    brokenMirror.html.includes('mirror exploded'), true)
  check('and the page says the mirror is unusable',
    brokenMirror.html.includes('设置镜像读写出错'), true)
  check('and the cause reaches the console once',
    brokenMirror.logged.filter(line => line.includes('getSnapshot failed')).length, 1)

  // A throwing `subscribe` must be survivable too.
  const brokenSub = renderHostile({ subscribeThrows: 'subscribe exploded' })
  check('a throwing subscribe does not take the page down',
    brokenSub.html.includes('任务路由'), true)

  // 4. A missing mirror object entirely.
  const missing = load(config())
  const missingHtml = renderToString(React.createElement(missing.page.component, { close: () => {} }))
  check('a missing settings mirror explains itself', missingHtml.includes('设置镜像不可用'), true)

  // 5. The error boundary itself. `renderToString` is the LEGACY server
  //    renderer and deliberately rethrows instead of running a boundary, so the
  //    contract is asserted directly on the class and its fallback is rendered
  //    from a real state, then checked for the diagnosis it promises.
  const { sectionBoundary } = load(config()).moduleObject.__testing
  const SectionBoundary = sectionBoundary()
  check('the section is wrapped in an error boundary', typeof SectionBoundary, 'function')
  check('and the class is built lazily, not at module load',
    sectionBoundary(), SectionBoundary)
  check('the boundary derives its state from the error',
    SectionBoundary.getDerivedStateFromError(new Error('boom')).error.message, 'boom')
  const boundary = new SectionBoundary({ children: null })
  boundary.state = { error: new Error('boundary fallback works') }
  const fallbackHtml = renderToString(boundary.render())
  check('the boundary fallback names the failure', fallbackHtml.includes('设置页渲染失败'), true)
  check('and shows the thrown message', fallbackHtml.includes('boundary fallback works'), true)
  check('and keeps the page title', fallbackHtml.includes('任务路由'), true)
  check('and says the plugin itself still runs',
    fallbackHtml.includes('插件本体仍在运行'), true)

  // 6. Every degenerate path must still produce a substantial page: a blank
  //    panel is the one outcome that is never acceptable.
  for (const [label, overrides] of [
    ['hostile remote', { hostileRemote: true }],
    ['throwing bind', { bindThrows: 'x' }],
    ['throwing mirror', { snapshotThrows: 'y' }],
    ['throwing subscribe', { subscribeThrows: 'z' }],
    ['rejecting roster', { presetsThrow: 'roster down' }],
    ['refused roster', { presetsFail: 'gateway down' }],
  ]) {
    const result = renderHostile(overrides)
    check(`never a blank panel: ${label}`,
      result.html.includes('任务路由') && result.html.length > 200, true)
  }
}

// ── the Host health channel ────────────────────────────────────────────────
//
// The Host half is a separate bundle. When it fails to mount, the ONLY way this
// page can know is to ask — so an unreachable endpoint must read as a diagnosis,
// and a healthy report must be rendered rather than swallowed.
{
  const { fetchHealth, classifierPatch } = load(config()).moduleObject.__testing

  const absent = await fetchHealth(undefined)
  check('no fetch in the environment is reported', absent.status, -1)
  check('and says so', absent.error.includes('没有 fetch'), true)

  const refused = await fetchHealth(async () => ({ ok: false, status: 404 }))
  check('a 404 means the Host half is not mounted', refused.status, 404)
  check('and the message says exactly that', refused.error.includes('Host 半边可能没有挂载'), true)

  const down = await fetchHealth(async () => { throw new Error('connection refused') })
  check('a transport failure is reported', [down.status, down.error], [0, 'connection refused'])

  const healthy = await fetchHealth(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, routing: { enabled: true, tasks: 2 }, capabilities: { agents: true } }),
  }))
  check('a healthy report is parsed', [healthy.status, healthy.health.routing.tasks], [200, 2])
  check('and carries no error', healthy.error, '')

  const garbage = await fetchHealth(async () => ({
    ok: true, status: 200, json: async () => { throw new Error('bad json') },
  }))
  check('a malformed body is reported, not thrown', [garbage.status, garbage.error], [0, 'bad json'])

  // The classifier write path must not carry dead keys forward.
  check('a classifier write drops unknown keys',
    Object.keys(classifierPatch({ enabled: true, provider: 'p', model: 'm', maxInputChars: 4000 },
      { enabled: false })).sort(),
    ['enabled', 'maxInputTokens', 'model', 'provider', 'timeoutMs'])
  check('and keeps the fields it does not touch',
    classifierPatch({ provider: 'p', model: 'm', maxInputTokens: 2000, timeoutMs: 9000 }, { enabled: true }),
    { enabled: true, provider: 'p', model: 'm', maxInputTokens: 2000, timeoutMs: 9000 })
  check('and repairs a missing document',
    classifierPatch(undefined, {}),
    { enabled: false, provider: '', model: '', maxInputTokens: 4000, timeoutMs: 15000 })
}

// The health card's derivations. Tested through the pure view rather than the
// JSX, because the fetch runs in an effect that a server render never executes —
// a page whose diagnostics are only exercised in a browser is a page whose
// diagnostics are never tested.
{
  const { healthView } = load(config()).moduleObject.__testing

  const offline = healthView({ status: 404, health: null, error: 'Host 状态接口返回 404：Host 半边可能没有挂载或已崩溃' })
  check('an offline Host half is marked bad', [offline.reachable, offline.bad], [false, true])
  check('and its message is the diagnosis', offline.summary.includes('没有挂载'), true)

  const healthy = healthView({
    status: 200,
    error: '',
    health: {
      routing: { enabled: true, tasks: 3 },
      delegation: { installed: 2, applied: 2, tool: 'subagent', provider: 'spawn' },
      capabilities: { agents: true, subagents: true, webServer: false },
      breaker: { tripped: false },
      errors: [],
      providers: {},
    },
  })
  check('a healthy report is summarised', healthy.summary,
    'Host 半边在线 · 路由已启用 · 3 个任务 · 委派工具已生效 2 / 已挂载 2 个会话')
  check('a missing capability is named', healthy.missing, ['webServer'])
  check('and marks the card bad', healthy.bad, true)
  check('with no breaker line', healthy.breaker, '')

  // A fiber is tracked before Cordis starts it, so the two counts can differ.
  // Showing the pair is the difference between "the takeover is absent" and
  // "its startup never ran" — a live defect that reported `installed: 0` beside
  // a working delegation tool.
  const pending = healthView({
    status: 200,
    error: '',
    health: {
      routing: { enabled: true, tasks: 1 },
      delegation: { installed: 3, applied: 1, service: true },
      capabilities: { agents: true, subagents: true },
      breaker: { tripped: false },
      errors: [],
      providers: {},
    },
  })
  check('a pending startup is visible as the pair', pending.summary.includes('已生效 1 / 已挂载 3'), true)

  // A host half from before the pair existed reports only `installed`; the page
  // must not turn that into a misleading zero.
  const legacy = healthView({
    status: 200,
    error: '',
    health: {
      routing: { enabled: true, tasks: 1 },
      delegation: { installed: 2 },
      capabilities: { agents: true },
      breaker: { tripped: false },
      errors: [],
      providers: {},
    },
  })
  check('an older host half falls back to the installed count',
    legacy.summary.includes('已生效 2 / 已挂载 2'), true)

  const tripped = healthView({
    status: 200,
    error: '',
    health: {
      routing: { enabled: true, tasks: 1 },
      delegation: { installed: 0 },
      capabilities: { agents: true },
      breaker: { tripped: true, reason: '5 consecutive failures', consecutive: 5, threshold: 5 },
      errors: [{ at: 1700000000000, where: 'agent/request', message: 'boom' }],
      providers: { 'b-ai': { failures: 4 }, 'openrouter': { failures: 1 } },
    },
  })
  check('a tripped breaker is stated', tripped.breaker.includes('本插件已自动停用'), true)
  check('with the reason and the counts', tripped.breaker.includes('5 consecutive failures'), true)
  check('only providers past the threshold are listed', tripped.struggling, ['b-ai（4 次）'])
  check('and the errors survive for the page', tripped.errors.length, 1)

  check('an empty answer is handled', healthView(undefined).summary, 'Host 半边没有回应')
}

// Everything the health card renders must survive a real render too.
{
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => { throw new Error('no route to host') }
  let down = ''
  try {
    const loaded = load(config())
    const faces = loaded.page.options.inject()
    down = renderToString(React.createElement(loaded.page.component, { ...faces, close: () => {} }))
  } finally {
    globalThis.fetch = realFetch
  }
  check('an unreachable Host half is shown as such', down.includes('运行状态'), true)
  check('and the page still renders its cards', down.includes('判定顺序'), true)
  check('the emergency disable path is documented', down.includes('cordis.patch.yml'), true)
  check('with the disable switch offered', down.includes('停用本插件'), true)
}

// ── the edit session: draft, save, cancel ───────────────────────────────────
//
// The page writes NOTHING while typing. That is what stops the caret jumping to
// the end (the value no longer comes back from a persisted round trip) and what
// makes Cancel possible at all. These tests pin the contract of the pieces that
// decide when a write happens.
{
  const { canonical, sameConfig, diffFields, diffOps, EDITABLE_PATHS } = load(config()).moduleObject.__testing

  check('canonical ignores key order',
    canonical({ a: 1, b: [2, { d: 4, c: 3 }] }), canonical({ b: [2, { c: 3, d: 4 }], a: 1 }))
  check('sameConfig sees equal content as equal', sameConfig({ a: 1 }, { a: 1 }), true)
  check('sameConfig sees a changed value as changed', sameConfig({ a: 1 }, { a: 2 }), false)
  check('null is only equal to null', [sameConfig(null, null), sameConfig(null, {})], [true, false])

  const before = { enabled: false, tasks: [{ id: 'a' }], classifier: { enabled: false } }
  check('diffFields names exactly the changed field',
    diffFields(before, { ...before, enabled: true }), ['enabled'])
  check('an unchanged draft has no diff', diffFields(before, { ...before }), [])
  check('a removed field is an unset, not a stale copy',
    diffOps({ a: 1, b: 2 }, { a: 1 }), [{ op: 'unset', path: ['b'] }])
  check('a changed field becomes a set op',
    diffOps({ a: 1, b: 2 }, { a: 9, b: 2 }), [{ op: 'set', path: ['a'], value: 9 }])
  check('an unchanged draft produces no ops', diffOps(before, { ...before }), [])

  // The two traps that made the child-profile controls look broken.
  //
  // 1. An EMPTIED optional field must leave the document, not enter it as ''.
  //    The schema rejects `childPersona: ''`, so writing an emptied textarea
  //    straight through would fail the save with an error nobody could trace.
  const { normalizeTask, defaultChildTools, EXECUTOR_PERSONA, DEFAULT_CHILD_TOOLS } =
    load(config()).moduleObject.__testing
  check('an emptied persona is removed, not stored',
    'childPersona' in normalizeTask({ id: 'a', childPersona: '' }), false)
  check('a whitespace persona survives (the schema trims, not the form)',
    normalizeTask({ id: 'a', childPersona: '  ' }).childPersona, '  ')
  check('an emptied tool filter is removed, not stored as an empty allow list',
    'childTools' in normalizeTask({ id: 'a', childTools: {} }), false)
  check('an empty allow list is removed too',
    'childTools' in normalizeTask({ id: 'a', childTools: { allow: [] } }), false)
  check('an emptied reasoning effort is removed',
    'reasoningEffort' in normalizeTask({ id: 'a', reasoningEffort: '' }), false)
  check('a real persona is kept', normalizeTask({ id: 'a', childPersona: EXECUTOR_PERSONA }).childPersona,
    EXECUTOR_PERSONA)
  check('and a real filter is kept',
    normalizeTask({ id: 'a', childTools: { allow: ['read'] } }).childTools, { allow: ['read'] })

  // 2. Switching a tool filter on must never produce an EMPTY allow list: that
  //    would deny every tool, which is never what the click meant.
  const names = ['ask_user_question', 'edit', 'glob', 'grep', 'pwsh', 'read', 'write']
  check('the initial pick is the ordinary work tools',
    defaultChildTools(names), DEFAULT_CHILD_TOOLS.filter(name => names.includes(name)))
  check('and it is never empty', defaultChildTools(['pwsh', 'job_list']).length > 0, true)
  check('even when none of the usual names exist', defaultChildTools(['only_one']), ['only_one'])
  check('an absent list cannot produce an empty filter', defaultChildTools(undefined).length > 0, false)

  // The coverage contract, checked in BOTH directions against two independent
  // declarations: the core says what the document holds, this page says what it
  // can edit, and neither may drift from the other.
  const core = await import('./model-routing-config.js')
  const { SCHEMA_FIELDS } = core
  const defaults = core.defaultConfig()
  check('the schema declaration covers the shipped document',
    SCHEMA_FIELDS.root.filter(field => !(field in defaults)), [])
  check('and the classifier it ships',
    SCHEMA_FIELDS.classifier.filter(field => !(field in defaults.classifier)), [])
  const uiFields = new Set(EDITABLE_PATHS)
  const expected = [
    ...SCHEMA_FIELDS.root.filter(field => field !== 'classifier' && field !== 'tasks'),
    ...SCHEMA_FIELDS.classifier.map(field => `classifier.${field}`),
    ...SCHEMA_FIELDS.task.map(field => `tasks[].${field}`),
    ...SCHEMA_FIELDS.pool.map(field => `tasks[].pool[].${field}`),
  ]
  check('every configured field has a control on this page',
    expected.filter(path => !uiFields.has(path)), [])
  check('and the page claims no field the schema does not have',
    [...uiFields].filter(path => !expected.includes(path)), [])
}

// ── the catalog source ──────────────────────────────────────────────────────
//
// The picker's list must come from the Host catalog the composer reads. Two
// earlier attempts failed in production: `llm.listModels` does not exist on the
// Client face, and reading the settings declarations listed models from
// providers that cannot serve.
{
  const source = readFileSync(require.resolve('dsh-model-router/client'), 'utf8')
  // Comments may NAME a rejected approach; only code must never reach for it.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  check('the client half never calls llm.listModels', code.includes('listModels'), false)
  check('the client half never reads the settings document for models',
    code.includes('settings?.describe'), false)
  check('the client half reads the Host model catalog', code.includes('modelCatalog'), true)

  const { moduleObject } = load(config())
  const { catalogFromModelCatalog } = moduleObject.__testing
  check('provider groups become routes', catalogFromModelCatalog({
    groups: [
      { id: 'google', name: 'Google', models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] },
      { id: 'b-ai', name: 'B.AI', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] },
    ],
  }), [
    { provider: 'google', providerName: 'Google', model: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
    { provider: 'b-ai', providerName: 'B.AI', model: 'glm-5.3-flash', name: 'GLM 5.3 Flash' },
  ])
  check('a provider without a display name falls back to its id',
    catalogFromModelCatalog({ groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] }),
    [{ provider: 'p', providerName: 'p', model: 'm', name: 'M' }])

  // A picker must offer the model by NAME. The id is what the config stores, so
  // it stays visible as a disambiguator — but it must not be the whole label.
  const { modelOptionLabel, modelOptions } = moduleObject.__testing
  check('a label leads with the display name', modelOptionLabel({ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }),
    'GLM 5.3 Flash（glm-5.3-flash）')
  check('an id-only model is not decorated', modelOptionLabel({ id: 'free', name: 'free' }), 'free')
  check('a missing name falls back to the id', modelOptionLabel({ id: 'm' }), 'm')
  check('an empty model is tolerated', modelOptionLabel(undefined), '')

  const picker = renderToString(React.createElement('select', null,
    ...modelOptions([
      { id: 'google', name: 'Google', models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] },
      { id: 'b-ai', name: 'B.AI', models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash' }] },
    ])))
  check('the picker groups by provider display name', picker.includes('label="Google"'), true)
  check('and offers each model by name', picker.includes('Gemini 3.7 Flash（gemini-3.7-flash）'), true)
  check('with the provider display name, not its id', picker.includes('label="b-ai"'), false)
  check('the option value stays the stored route', picker.includes('value="b-ai\u0000glm-5.3-flash"'), true)
  check('a model keeps its id when it has no name',
    catalogFromModelCatalog({ groups: [{ id: 'p', models: [{ id: 'm' }] }] }),
    [{ provider: 'p', providerName: 'p', model: 'm', name: 'm' }])
  check('an empty catalog yields no routes', catalogFromModelCatalog({ groups: [] }), [])
  check('a missing catalog yields no routes', catalogFromModelCatalog(undefined), [])

  // The failure paths matter more than the happy one: this read is the page's
  // only link to the Host, and it must degrade to a line of text, never a crash
  // and never a silently empty picker.
  const { fetchRoutes } = moduleObject.__testing
  const ok = await fetchRoutes({ modelCatalog: async () => ({ ok: true, value: {
    groups: [{ id: 'google', models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] }],
    failures: [],
  } }) })
  check('a healthy catalog yields routes and no error', [ok.routes.length, ok.error], [1, ''])

  const partial = await fetchRoutes({ modelCatalog: async () => ({ ok: true, value: {
    groups: [{ id: 'google', models: [{ id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' }] }],
    failures: [{ id: 'b-ai', name: 'B.AI', message: 'connection refused' }],
  } }) })
  check('a partial catalog still yields the routes it has', partial.routes.length, 1)
  check('and names the provider that failed', partial.error, 'B.AI: connection refused')

  const refused = await fetchRoutes({ modelCatalog: async () => ({ ok: false, error: { code: 'settings/denied', message: 'no' } }) })
  check('a refused read is reported', [refused.routes.length, refused.error], [0, 'settings/denied: no'])

  const absent = await fetchRoutes(undefined)
  check('a missing remote face is reported', [absent.routes.length, absent.error.includes('不可用')], [0, true])

  const threw = await fetchRoutes({ modelCatalog: async () => { throw new Error('gateway down') } })
  check('a throwing read is reported, not propagated', [threw.routes.length, threw.error], [0, 'gateway down'])
}

// ── the classifier input budget ─────────────────────────────────────────────
//
// The budget is a TOKEN count, and the adapter must never exceed it however
// long the conversation is. A character cap cannot promise that: the same 4000
// characters is ~1000 tokens of English and ~4000 of Chinese.
{
  const { estimateTokens, classificationInput } = await import('./model-routing-config.js')
  for (const [label, text] of [
    ['latin', 'x'.repeat(60000)],
    ['cjk', '建'.repeat(60000)],
    ['mixed', '建模 FreeCAD '.repeat(8000)],
  ]) {
    const bounded = classificationInput('帮我用 FreeCAD 建一个齿轮', text, 4000)
    check(`the classifier input stays within budget (${label})`,
      estimateTokens(bounded.text) <= 4000, true)
  }
  check('a short conversation is passed through untouched',
    classificationInput('建模', '建模', 4000).trimmed, false)
  check('the opener is not repeated when it is also the tail',
    classificationInput('建模', '建模', 4000).text, '建模')
  check('the opener survives the cut',
    classificationInput('ROOT-MARKER 建模', 'x'.repeat(60000), 500).text.startsWith('ROOT-MARKER'), true)
}

// ── bilingual copy: the page must FOLLOW the harness language ────────────────
//
// Three rules, each one a defect this client actually had:
//   1. the two dictionaries must carry the SAME keys — a key missing from one
//      language renders a raw key for those readers;
//   2. no Chinese may live in CODE outside the dictionary — an earlier version sent
//      69 strings through COPY.zh, which pins the page to Chinese whatever language
//      the harness is set to;
//   3. the RENDERED section must change when the language changes — the decisive
//      check, and the one a source-level scan cannot make.
{
  const source = readFileSync('dsh-model-router.client.js', 'utf8')
  const sourceLines = source.split('\n')
  const from = sourceLines.findIndex(line => line.startsWith('const COPY = {'))
  let to = -1
  for (let index = from; index < sourceLines.length; index += 1) {
    if (sourceLines[index].trim() === '}}') { to = index; break }
  }
  check('the copy dictionary is one block', [from > 0, to > from], [true, true])

  const dictionary = sourceLines.slice(from, to + 1).join('\n')
  const enAt = dictionary.indexOf('en: {')
  const keysOf = text => [...text.matchAll(/'([^']+)'\s*:/g)]
    .map(match => match[1]).filter(key => key.includes('.')).sort()
  const zhKeys = keysOf(dictionary.slice(0, enAt))
  const enKeys = keysOf(dictionary.slice(enAt))
  check('both languages carry the same keys', enKeys, zhKeys)
  check('and enough of them to cover the page', zhKeys.length > 50, true)

  // Comments are prose for maintainers; everything else is copy.
  const offenders = []
  sourceLines.forEach((line, index) => {
    if (index >= from && index <= to) return
    if (!/[\u4e00-\u9fff]/.test(line)) return
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//') || trimmed.startsWith('/*')) return
    offenders.push(index + 1)
  })
  check('no Chinese in code outside the dictionary', offenders, [])

  // The decisive one: render in English, then in Chinese, off the SAME plugin.
  activeLanguage = 'en'
  const english = render('language: english', config(), 'ready', { roster: ['diy-smart'] })
  activeLanguage = 'zh'
  const chinese = render('language: chinese', config(), 'ready', { roster: ['diy-smart'] })
  check('the english render carries no Chinese at all', /[\u4e00-\u9fff]/.test(english.html), false)
  check('and the same keys resolve to different copy', english.html !== chinese.html, true)
  check('while the chinese render still is chinese', /[\u4e00-\u9fff]/.test(chinese.html), true)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
if (process.argv.includes('--dump')) {
  const { writeFileSync } = await import('node:fs')
  const { html } = render('dump', config(), 'ready', { roster: ['diy-smart', 'diy'] })
  writeFileSync('render-out.html', html, 'utf8')
  console.log(`\nwrote render-out.html (${html.length} bytes)`)
  console.log('starts with:', html.slice(0, 120))
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
// `process.exitCode`, NOT `process.exit()`: this suite's output is one line per
// assertion and a hard exit truncates it on a pipe, which silently swallowed the
// `N/N passed` tally the runner keys on. Nothing here holds the event loop open,
// so the process ends on its own once stdout has drained.
process.exitCode = failed.length > 0 ? 1 : 0
