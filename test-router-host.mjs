/**
 * Integration test for the router's host adapter, driven through the REAL
 * generated dynamic body (so this exercises what actually ships) against a
 * stubbed harness: settings, llm, timer, agentPresets.
 *
 * Run: node test-router-host.mjs
 */
import { readFile } from 'node:fs/promises'

const dynamic = JSON.parse(await readFile(new URL('./dsh-model-router.dynamic.json', import.meta.url), 'utf8'))

const results = []

/**
 * One indirection the mounts flip. Capturing `console.log` itself would capture
 * whatever is installed at that moment, so the second mount would "restore" the
 * previous stub and the final report would print into a discarded array.
 */
const output = {
  log: (...values) => realLog(...values),
  error: (...values) => realError(...values),
}
const realLog = console.log.bind(console)
const realError = console.error.bind(console)

function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

// ── harness stubs ───────────────────────────────────────────────────────────

/**
 * Every object in a written section must be realm-safe (null-prototype).
 *
 * This is the offline guard for a failure that only reproduces in the dynamic
 * sandbox: `settings` admits a section only when
 * `Object.getPrototypeOf(value) === Object.prototype`, and inside the sandbox
 * that comparison is false for an ordinary `{}` because the realm's
 * `Object.prototype` is a different object. A null prototype passes in every
 * realm, so it is the only shape that survives.
 */
function assertRealmSafe(value, path) {
  if (value === null || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertRealmSafe(entry, `${path}[${index}]`))
    return
  }
  const proto = Object.getPrototypeOf(value)
  if (proto !== null) {
    throw new TypeError(`${path} must be realm-safe (null-prototype) but had ${String(proto?.constructor?.name)};`
      + ' a plain `{}` built in the dynamic sandbox realm is refused by the settings service')
  }
  for (const [key, entry] of Object.entries(value)) assertRealmSafe(entry, `${path}.${key}`)
}

/** Mirror of the adapter's realm-safe conversion, for tests that write directly. */
function hostPlain(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(hostPlain)
  const out = Object.create(null)
  for (const [key, entry] of Object.entries(value)) out[key] = hostPlain(entry)
  return out
}

/** A settings service whose single namespace holds one mutable document. */
function makeSettings(base) {
  const watchers = new Set()
  let value = base
  const stub = {
    value: () => value,
    /** The scope the plugin registered; the test drives `replace` through it. */
    scope: undefined,
    /** Every section handed to `replace`, so a test can inspect its shape. */
    written: [],
    register(ns, shape, options) {
      value = JSON.parse(JSON.stringify(options.base))
      const scope = {
        get: () => value,
        watch(callback) { watchers.add(callback); return () => watchers.delete(callback) },
        async replace(section) {
          stub.written.push(section)
          assertRealmSafe(section, 'section')
          value = JSON.parse(JSON.stringify(section))
          for (const watcher of watchers) await watcher(value)
        },
        async update(patch) { await scope.replace({ ...value, ...patch }) },
      }
      stub.scope = scope
      return scope
    },
  }
  return stub
}

/** A provider registry advertising two providers and a handful of models. */
function makeLlm(models, replies) {
  const requests = []
  return {
    requests,
    listProviders: () => [
      { id: 'google', name: 'Google' },
      { id: 'b-ai', name: 'B.AI' },
      { id: 'openrouter', name: 'OpenRouter' },
    ],
    listModels: async (provider) => models
      .filter(entry => entry.provider === provider)
      .map(entry => ({ provider, id: entry.model, name: entry.name ?? entry.model })),
    /** Stream one canned reply, recording the request for assertions. */
    stream(options) {
      requests.push({
        provider: options.provider, model: options.model, system: options.system,
        maxTokens: options.maxTokens, messages: options.messages?.length ?? 0,
      })
      // `replies` scripts one reply per call (an entry may be a string, or
      // `{ reply }` / `{ throws }`); `reply` stays the single-answer shortcut.
      const step = Array.isArray(replies) ? replies[requests.length - 1] : undefined
      if (step !== undefined && typeof step === 'object' && typeof step.throws === 'string') {
        return (async function* () {
          // `slow` models a timeout-shaped failure: it costs real time before it
          // fails, which is what decides whether a retry is worth it.
          if (typeof step.slow === 'number') {
            await new Promise(resolve => { setTimeout(resolve, step.slow) })
          }
          throw new Error(step.throws)
        })()
      }
      const reply = typeof step === 'string'
        ? step
        : step?.reply ?? models.reply ?? 'none'
      return (async function* () {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: reply }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
  }
}

/** The cordis timer service, backed by real timers for the test. */
const timer = {
  timeout(callback, ms) {
    const handle = setTimeout(callback, ms)
    return () => clearTimeout(handle)
  },
}

const presetRoster = {
  list: async () => [
    { id: 'diy', trust: 'user' },
    { id: 'diy-smart', trust: 'user' },
    { id: 'standard', trust: 'system' },
    { id: 'broken-one', trust: 'user', broken: 'unreadable' },
  ],
  // The live scope chain answers first; the header is the fallback. Returning
  // undefined here exercises the header path the tests set up.
  composedPreset: () => undefined,
}

/**
 * A fake Agent scope, shaped like the real one where this plugin touches it:
 * `ctx.plugin()` (returning a disposer-bearing fiber) and a session header.
 *
 * The tool registry models the real semantics the design depends on:
 * registrations are owned by the fiber, `restrict` REJECTS unknown names, and
 * disposing the fiber removes everything it contributed.
 */
function fakeAgent({
  preset = 'diy-smart', origin = undefined, id = 'a1', builtins = ['subagent', 'subagent_fork'], parent = undefined,
} = {}) {
  // Layered like the real runtime: the scope's OWN registrations shadow the
  // inherited ones, and removing an own registration restores what it shadowed.
  const inherited = new Map(builtins.map(name => [name, { name, description: `built-in ${name}` }]))
  const own = new Map()
  const scoped = []
  /** Prompt sections this agent's scope registered, in order. */
  const sections = []
  const fiber = () => ({
    disposed: false,
    async dispose() { this.disposed = true; for (const undo of scoped.reverse()) undo() },
  })
  const agent = {
    id,
    session: {
      id,
      header: {
        agentPreset: preset,
        ...origin === undefined ? {} : { origin },
        ...parent === undefined ? {} : { parentSession: parent },
      },
    },
    sections,
    /** What the agent's tool table resolves, shadowing included. */
    registered: {
      get: name => own.get(name) ?? inherited.get(name),
      has: name => own.has(name) || inherited.has(name),
      keys: () => [...new Set([...inherited.keys(), ...own.keys()])],
    },
    /** Names THIS plugin registered, so a built-in is never mistaken for ours. */
    owns: own,
    restrictions: [],
    fiber: null,
    ctx: {
      plugin(definition) {
        const owned = []
        const scope = {
          tools: {
            register(tool) {
              own.set(tool.name, tool)
              const undo = () => own.delete(tool.name)
              owned.push(undo)
              return undo
            },
            restrict(filter) {
              const known = [...inherited.keys(), ...own.keys()]
              const unknown = (filter.deny ?? []).filter(name => !known.includes(name))
              if (unknown.length > 0) throw new Error(`tools.restrict() names unknown global tool "${unknown[0]}"`)
              agent.restrictions.push(filter)
              const undo = () => {
                const index = agent.restrictions.indexOf(filter)
                if (index >= 0) agent.restrictions.splice(index, 1)
              }
              owned.push(undo)
              return undo
            },
            get: name => own.get(name) ?? inherited.get(name),
          },
          // The prompt registry contract this plugin relies on: sections are
          // registered by name (a nearer scope shadows the same name) and every
          // registration returns its own disposer.
          systemPrompt: {
            getSectionOrder: () => 0,
            section(definition) {
              sections.push(definition)
              const undo = () => {
                const index = sections.indexOf(definition)
                if (index >= 0) sections.splice(index, 1)
              }
              owned.push(undo)
              return undo
            },
          },
        }
        const result = definition.apply(scope)
        if (typeof result === 'function') owned.push(result)
        const handle = fiber()
        const dispose = handle.dispose.bind(handle)
        handle.dispose = async () => {
          scoped.push(...owned)
          await dispose()
        }
        agent.fiber = handle
        return handle
      },
    },
  }
  return agent
}

/**
 * A fake `subagents` service.
 *
 * `continuable: false` models a build whose provider cannot prepare a
 * continuable child — the case where the delegation description must NOT promise
 * a continuation tool.
 */
function makeSubagents(outcome = { output: [{ type: 'text', text: 'child answer' }] }, continuable = true) {
  const requests = []
  const starts = []
  const messages = []
  const service = {
    requests,
    starts,
    messages,
    /**
     * Called while a start is in flight, exactly like the real runtime: the child
     * is REGISTERED during `start()`, so `agent/created` fires before the call
     * returns. That ordering is what the child-profile handoff depends on.
     */
    onCreate: undefined,
    async start(provider, request) {
      requests.push({ provider, request })
      service.onCreate?.(request.parent)
      if (outcome.throws !== undefined) throw new Error(outcome.throws)
      return {
        id: 'run-1',
        result: Promise.resolve(outcome),
        dispose: async () => {},
      }
    },
    ...continuable ? {
      async startContinuable(spec) {
        starts.push(spec)
        service.onCreate?.(spec.request.parent)
        // Same failure contract as `start`: a provider that cannot serve throws,
        // and the tool must let that reach the caller rather than swallow it.
        if (outcome.throws !== undefined) throw new Error(outcome.throws)
        return { childId: 'child-7', messageId: 'msg-1' }
      },
      async sendMessage(sender, targetId, content, options) {
        messages.push({ sender, targetId, content, options })
        return 'msg-2'
      },
    } : {},
  }
  return service
}

const MODELS = [
  { provider: 'google', model: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash' },
  { provider: 'google', model: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash' },
  { provider: 'b-ai', model: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
  { provider: 'openrouter', model: 'openrouter/free', name: 'Free Router' },
]

/** Mount the generated plugin against fresh stubs. */
async function mount(configOverrides, replies, extra = {}) {
  const settings = makeSettings()
  const llm = makeLlm(MODELS, replies)
  const handlers = new Map()
  const listeners = new Map()
  const logs = []
  const effects = []
  const agents = extra.agents ?? []
  const subagents = extra.subagents ?? makeSubagents()
  const ctx = {
    settings,
    llm,
    timer,
    agents,
    subagents,
    get: (name) => (name === 'agentPresets' ? presetRoster
      : name === 'agents' ? { list: () => agents }
        : name === 'subagents' ? subagents
          : undefined),
    on: (event, listener) => { listeners.set(event, listener); return () => listeners.delete(event) },
    effect: (callback) => { const disposer = callback(); effects.push(disposer); return () => {} },
  }
  // The stub stays installed for the whole test body: the router logs while
  // serving requests, not only while mounting.
  console.log = (...values) => logs.push(values.join(' '))
  console.error = (...values) => logs.push(`ERROR ${values.join(' ')}`)
  const factory = new Function('ctx', 'harness', 'console', dynamic.host)
  const plugin = factory(ctx, {
    handle: (method, handler) => { handlers.set(method, handler); return () => {} },
  }, console)
  // `apply` is async now: it loads schemastery so the settings namespace can be
  // registered with a real schema. Cordis awaits the returned promise.
  const applyResult = await plugin.apply(ctx)
  const base = settings.value()
  if (configOverrides !== undefined) {
    const merged = { ...base, ...configOverrides }
    Object.assign(base, merged)
  }
  return { ctx, settings, llm, handlers, listeners, logs, effects, applyResult }
}

/** A fake Session with the surface the adapter reads. */
/**
 * A fake Session.
 *
 * `origin: 'subagent'` by DEFAULT, because that is the only kind of session the
 * router acts on. A test that wants the main session passes `origin: undefined`
 * — which is what `session.main()` is for, so the distinction is visible at the
 * call site rather than implied.
 */
function session({ id = 's1', preset = 'diy-smart', origin = 'subagent', messages = [], tools = ['pwsh'] } = {}) {
  const derived = messages.map(([role, text], index) => ({
    id: `m${index}`,
    role,
    content: [{ type: 'text', text }],
    source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'x', model: 'y' },
  }))
  return {
    id,
    // `null` is the sentinel for "not delegated": passing `undefined` would hit
    // the parameter default above and silently produce a child.
    header: { agentPreset: preset, origin: origin === null ? undefined : origin },
    deriveMessages: () => derived,
    requestHeader: () => ({
      config: { provider: 'deepseek-official', model: 'deepseek-flash' },
      tools: tools.map(name => ({ name, description: '', parameters: {} })),
    }),
  }
}

/** The session the user is talking to — never routed. */
session.main = options => session({ ...options, origin: null })

/** Drive one agent/request dispatch. */
async function request(listeners, agent, turn) {
  const asked = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' }
  return listeners.get('agent/request')(
    { agent, turn, step: 0, signal: new AbortController().signal },
    async () => asked,
  )
}

/** Settle the microtask queue so the plugin's async reconciliation finishes. */
const settle = () => new Promise(resolve => { setTimeout(resolve, 0) })

/**
 * Drive the settings watcher, which is what re-decides grants and delegation
 * tools. The plugin's watcher is async by design (disposal awaits), so settle
 * after firing it.
 */
async function mountSync(stubs) {
  await stubs.settings.scope.replace(hostPlain(stubs.settings.value()))
  await settle()
}

// ── tests ───────────────────────────────────────────────────────────────────

/** Turn routing on and grant one preset, the way the settings page would. */
function enable(stubs, { preset = 'diy-smart', tasks, defaultTaskId = 'general' } = {}) {
  const document = stubs.settings.value()
  document.enabled = true
  document.defaultTaskId = defaultTaskId
  document.tasks = tasks ?? [
    { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 },
        { provider: 'google', model: 'gemini-3.6-flash', weight: 1 }] },
    { id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
  ]
  document.presets = { [preset]: { enabled: true } }
  return document
}

// 1. A keyword-matched delegated turn routes into the task pool.
{
  const stubs = await mount()
  enable(stubs)
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '帮我建模一个齿轮']] }) }, 1)
  check('keyword turn routes into the task pool', routed.provider, 'google')
  // A route CHANGE drops the inherited reasoning effort: keeping it asks the new
  // model for a mode it may not have, which failed a live child outright
  // (-ai/mimo-v2.5 does not support reasoning). Absent, the adapter uses the
  // model's own default.
  check('a routed turn drops the inherited reasoning effort', routed.reasoningEffort, undefined)
  check('but keeps every other field', routed.maxTokens ?? 'untouched', 'untouched')
  check('mount logs that it is active', stubs.logs.some(line => line.includes('mounted')), true)
}

// 1b. The MAIN session is never routed, whatever it asks for.
{
  const stubs = await mount()
  enable(stubs)
  const keyword = await request(stubs.listeners, { session: session.main({ messages: [['user', '帮我建模']] }) }, 1)
  check('the main session keeps its model on a keyword turn', keyword.provider, 'deepseek-official')
  check('the main session keeps its model on an unmatched turn',
    (await request(stubs.listeners, { session: session.main({ messages: [['user', '写首诗']] }) }, 1)).provider,
    'deepseek-official')
  const withClassifier = await request(stubs.listeners, {
    session: session.main({ messages: [['user', '这是什么呢']] }),
  }, 1)
  check('the main session is not classified either', withClassifier.provider, 'deepseek-official')
}

// 2. Routing is off until the document says otherwise.
{
  const stubs = await mount()
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '帮我建模']] }) }, 1)
  check('a disabled router changes nothing', routed.model, 'deepseek-flash')
}

// 3. An ungranted preset is untouched.
{
  const stubs = await mount()
  enable(stubs, { preset: 'diy-smart' })
  const routed = await request(stubs.listeners, { session: session({ preset: 'standard', messages: [['user', '建模']] }) }, 1)
  check('an ungranted preset keeps its model', routed.provider, 'deepseek-official')
}

// 4. The rotation is GLOBAL: different sessions share one counter.
{
  const stubs = await mount()
  enable(stubs)
  const models = []
  for (let index = 0; index < 6; index += 1) {
    const agent = { session: session({ id: `session-${index}`, messages: [['user', '建模']] }) }
    models.push((await request(stubs.listeners, agent, 1)).model)
  }
  check('six separate sessions still alternate in ratio',
    [models.filter(model => model === 'gemini-3.7-flash').length,
      models.filter(model => model === 'gemini-3.6-flash').length], [3, 3])
}

// 5. A turn is stable: repeated steps reuse the pinned model.
{
  const stubs = await mount()
  enable(stubs)
  const agent = { session: session({ messages: [['user', '建模']] }) }
  const first = await request(stubs.listeners, agent, 3)
  const second = await request(stubs.listeners, agent, 3)
  const third = await request(stubs.listeners, agent, 3)
  check('all steps of one turn share a model',
    new Set([first.model, second.model, third.model]).size, 1)
}

// 6. The classifier call runs on the configured route and its answer routes.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true,
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
      { id: 'general', name: '通用', description: '日常', enabled: true, isDefault: true,
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  const document = stubs.settings.value()
  document.classifier = { enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000 }
  MODELS.reply = 'modelling'
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '把这个零件做出来']] }) }, 1)
  check('the classifier is called on its own configured route',
    [stubs.llm.requests[0]?.provider, stubs.llm.requests[0]?.model], ['openrouter', 'openrouter/free'])
  check('a semantic answer routes to that task',
    [routed.provider, routed.model], ['google', 'gemini-3.7-flash'])
  MODELS.reply = 'none'
}

// 6b. A delegation delivers its prompt by SPLICING it into the child's inbox, and
//     at the child's first request the derived message list does not yet contain
//     it.
//
//     Measured live: three delegations in a row fell through to the classifier
//     because `[task: …]` and every keyword were invisible in `deriveMessages()`.
//     The recorded splice is the fallback that makes the first turn routable.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
      { id: 'general', name: '通用', description: '日常', enabled: true,
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  /** A child whose opener exists ONLY as a recorded inbox splice. */
  const spliced = session({ messages: [] })
  spliced.deriveMessages = () => []
  spliced.snapshotEvents = () => [{
    type: 'agent/inbox/spliced',
    data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text: '建模这块交给你' }] }] },
  }]
  const byKeyword = await request(stubs.listeners, { session: spliced }, 1)
  check('a keyword in a spliced opener still routes', byKeyword.provider, 'google')
  check('and the classifier was not needed', stubs.llm.requests.length, 0)

  const directed = session({ messages: [] })
  directed.deriveMessages = () => []
  directed.snapshotEvents = () => [{
    type: 'agent/inbox/spliced',
    data: { inserted: [{ content: [{ type: 'text', text: '做点什么 [task: general]' }] }] },
  }]
  check('an explicit directive in a spliced opener still routes',
    (await request(stubs.listeners, { session: directed }, 1)).provider, 'b-ai')

  // A shape change must degrade to "no text", never throw on the request path.
  const odd = session({ messages: [] })
  odd.deriveMessages = () => []
  odd.snapshotEvents = () => [{ type: 'agent/inbox/spliced', data: { inserted: 'nonsense' } }]
  check('a malformed splice does not break the turn',
    (await request(stubs.listeners, { session: odd }, 1)).provider, 'b-ai')

  const noReader = session({ messages: [] })
  noReader.deriveMessages = () => []
  check('a session without an event reader still routes',
    (await request(stubs.listeners, { session: noReader }, 1)).provider, 'b-ai')
}

// 7. The classifier runs once per turn, not once per step.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true, isDefault: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  const document = stubs.settings.value()
  document.classifier = { enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000 }
  MODELS.reply = 'general'
  const agent = { session: session({ messages: [['user', '随便聊聊']] }) }
  await request(stubs.listeners, agent, 1)
  await request(stubs.listeners, agent, 1)
  await request(stubs.listeners, agent, 1)
  check('one classifier call per turn', stubs.llm.requests.length, 1)
  await request(stubs.listeners, agent, 2)
  check('a new turn classifies again', stubs.llm.requests.length, 2)
}

// 8. A classifier that fails degrades to the default task, not a broken turn.
{
  const stubs = await mount()
  enable(stubs, {
    defaultTaskId: 'general',
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  const document = stubs.settings.value()
  document.classifier = { enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000 }
  stubs.llm.stream = () => (async function* () {
    yield { type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'RATE_LIMIT' } } }
  })()
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '随便聊聊']] }) }, 1)
  check('a failed classifier still routes via the default', routed.provider, 'b-ai')
  check('the failure is reported, not swallowed',
    stubs.logs.some(line => line.includes('classifier unavailable')), true)
}

// 8b. The classifier is not starved of output budget.
//
// `maxTokens: 16` was a live bug, not a style choice: a thinking model bills its
// reasoning against the output budget, spends all 16 on reasoning, and returns
// NO text — which routing can only read as "no answer". The answer is one id, so
// a generous cap costs nothing and removes the failure.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  stubs.settings.value().classifier = {
    enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000,
  }
  MODELS.reply = 'general'
  await request(stubs.listeners, { session: session({ messages: [['user', '随便聊聊']] }) }, 1)
  const asked = stubs.llm.requests.at(-1)
  check('the classifier gets room for a reasoning preamble', asked.maxTokens >= 128, true)
  check('and the budget stays bounded', asked.maxTokens <= 2048, true)
  check('the classifier input rides as one message', asked.messages, 1)
  MODELS.reply = 'none'
}

// 8c. An unusable reply is retried once, then routing still works.
//
// Measured live on a free meta-route: one call in twelve came back as a safety
// classifier's string ("User Safety: safe"), another as a 400 because its
// endpoint demands reasoning. A second call usually lands on a different
// upstream model, and the retry is bounded to one extra call per turn.
{
  const stubs = await mount(undefined, [
    { reply: 'User Safety: safe' },
    { reply: 'modelling' },
  ])
  enable(stubs, {
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true,
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
      { id: 'general', name: '通用', description: '日常', enabled: true,
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  stubs.settings.value().classifier = {
    enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000,
  }
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '把这个零件做出来']] }) }, 1)
  check('an unusable reply is retried', stubs.llm.requests.length, 2)
  check('and the retry routes', [routed.provider, routed.model], ['google', 'gemini-3.7-flash'])
}

// 8d. A thrown classifier call is retried too — but only while it stays cheap.
{
  const stubs = await mount(undefined, [
    { throws: 'connect ECONNREFUSED' },
    { reply: 'general' },
  ])
  enable(stubs, {
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  stubs.settings.value().classifier = {
    enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000,
  }
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '随便聊聊']] }) }, 1)
  check('a fast failure is retried', stubs.llm.requests.length, 2)
  check('and the turn still routes', routed.provider, 'b-ai')
}

// 8e. "none" is a real answer, so it is NOT retried.
//
// The model read the candidate list and found nothing that fits. Repeating the
// question would spend tokens to receive the same answer.
{
  const stubs = await mount(undefined, ['none', { reply: 'general' }])
  enable(stubs, {
    defaultTaskId: 'general',
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  stubs.settings.value().classifier = {
    enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 5000,
  }
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '随便聊聊']] }) }, 1)
  check('a confident "none" costs one call', stubs.llm.requests.length, 1)
  check('and falls through to the default task', routed.provider, 'b-ai')
}

// 8f. A SLOW failure is not retried: the retry must not double the stall.
{
  const stubs = await mount(undefined, [
    { slow: 700, throws: 'timed out' },
    { reply: 'general' },
  ])
  enable(stubs, {
    defaultTaskId: 'general',
    tasks: [{ id: 'general', name: '通用', description: '日常', enabled: true,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] }],
  })
  // A 1000ms budget means a 700ms failure has already spent more than half.
  stubs.settings.value().classifier = {
    enabled: true, provider: 'openrouter', model: 'openrouter/free', maxInputTokens: 4000, timeoutMs: 1000,
  }
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '随便聊聊']] }) }, 1)
  check('a slow failure is not retried', stubs.llm.requests.length, 1)
  check('and the default task still serves the turn', routed.provider, 'b-ai')
  check('the reason is reported', stubs.logs.some(line => line.includes('classifier unavailable')), true)
}

// 9. With no classifier and no deterministic match, the default task applies.
{
  const stubs = await mount()
  enable(stubs)
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '写一首诗']] }) }, 1)
  check('an unmatched delegated turn lands on the default task', routed.provider, 'b-ai')
}

// 9b. With NO default, an unmatched delegated turn keeps the inherited route.
{
  const stubs = await mount()
  enable(stubs, { defaultTaskId: '' })
  const inherited = await request(stubs.listeners, { session: session({ messages: [['user', '写一首诗']] }) }, 1)
  check('no default means an unmatched turn is left alone', inherited.provider, 'deepseek-official')
  const matched = await request(stubs.listeners, { session: session({ messages: [['user', '建模']] }) }, 1)
  check('a matched turn still routes without a default', matched.provider, 'google')
}

// 10. A default that cannot serve behaves exactly like none.
{
  const stubs = await mount()
  enable(stubs, { defaultTaskId: 'general', tasks: [
    { id: 'general', name: '通用', description: '日常', enabled: false,
      pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
  ] })
  check('a disabled default is no default',
    (await request(stubs.listeners, { session: session({ messages: [['user', '写首诗']] }) }, 1)).provider,
    'deepseek-official')
}

// 11. A failed request rotates the pool and asks for a retry.
{
  const stubs = await mount()
  enable(stubs)
  const agent = { session: session({ messages: [['user', '建模']] }) }
  await request(stubs.listeners, agent, 1)
  const decision = await stubs.listeners.get('agent/request-error')(
    { agent, turn: 1, step: 0, provider: 'google', failure: { message: 'rate limited', code: 'RATE_LIMIT' },
      retryPolicy: undefined, signal: new AbortController().signal },
    async () => undefined,
  )
  check('a failed request asks for a retry', decision, { kind: 'retry' })
  check('the rotation is logged', stubs.logs.some(line => line.includes('rotating modelling')), true)
}

// 11b. The retry rotates the pool that FAILED, not whichever pool looks busy.
//
// The previous implementation inferred the task from the rotation counters, so
// with two multi-model tasks it could rotate the wrong one — a silent waste that
// left the failing pool untouched.
{
  const stubs = await mount()
  enable(stubs, {
    defaultTaskId: 'research',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 },
          { provider: 'google', model: 'gemini-3.6-flash', weight: 1 }] },
      { id: 'research', name: '检索', description: '查资料', enabled: true, keywords: ['查资料'],
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 },
          { provider: 'openrouter', model: 'openrouter/free', weight: 1 }] },
    ],
  })
  // Two turns of the OTHER task first, so the counters alone would point there.
  const busy = { session: session({ id: 's2', messages: [['user', '查资料']] }) }
  await request(stubs.listeners, busy, 1)
  await request(stubs.listeners, busy, 2)

  const agent = { session: session({ messages: [['user', '帮我建模']] }) }
  await request(stubs.listeners, agent, 1)
  const decision = await stubs.listeners.get('agent/request-error')(
    { agent, turn: 1, step: 0, provider: 'google', failure: { message: 'rate limited', code: 'RATE_LIMIT' },
      retryPolicy: undefined, signal: new AbortController().signal },
    async () => undefined,
  )
  check('a failed request retries', decision, { kind: 'retry' })
  check('the retry rotates the task that failed',
    stubs.logs.filter(line => line.startsWith('dsh-model-router: rotating')), [
      'dsh-model-router: rotating modelling after a failed request',
    ])
}

// 11c. A single-model pool has nowhere to go, so it must not spend a retry.
{
  const stubs = await mount()
  enable(stubs, {
    defaultTaskId: 'research',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 },
          { provider: 'google', model: 'gemini-3.6-flash', weight: 1 }] },
      { id: 'research', name: '检索', description: '查资料', enabled: true, keywords: ['查资料'],
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  const busy = { session: session({ id: 's2', messages: [['user', '建模']] }) }
  await request(stubs.listeners, busy, 1)

  const agent = { session: session({ messages: [['user', '查资料']] }) }
  await request(stubs.listeners, agent, 1)
  check('a one-model pool cannot rotate', await stubs.listeners.get('agent/request-error')(
    { agent, turn: 1, step: 0, provider: 'b-ai', failure: { message: 'x', code: 'X' },
      retryPolicy: undefined, signal: new AbortController().signal },
    async () => undefined,
  ), undefined)
  check('and it does not rotate the busier pool instead',
    stubs.logs.some(line => line.includes('rotating')), false)
}

// 12. A single-model pool does not rotate.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [{ id: 'modelling', name: '3D', description: '三维', enabled: true, keywords: ['建模'],
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] }],
  })
  const agent = { session: session({ messages: [['user', '建模']] }) }
  await request(stubs.listeners, agent, 1)
  check('a one-model pool cannot rotate', await stubs.listeners.get('agent/request-error')(
    { agent, turn: 1, step: 0, provider: 'google', failure: { message: 'x', code: 'X' },
      retryPolicy: undefined, signal: new AbortController().signal },
    async () => undefined,
  ), undefined)
}

// 13. The settings RPC surface.
// 13. The health channel — the ONLY host-to-page method that survives.
//
// The page reads data through the Typert Remote faces. What it cannot learn
// that way is runtime state: which capabilities this build found, what failed
// recently, and whether the plugin has taken itself out of the request path.
{
  const stubs = await mount()
  enable(stubs)
  const health = await stubs.handlers.get('health')()
  check('health reports the routing state', health.routing.enabled, true)
  check('health counts the configured tasks', health.routing.tasks, 2)
  check('health reports the delegation takeover',
    [health.delegation.tool, health.delegation.provider], ['subagent', 'spawn'])
  check('health reports no failures on a clean mount', health.errors, [])
  check('health reports the breaker as closed', health.breaker.tripped, false)
  check('health reports which capabilities were found',
    Object.keys(health.capabilities).sort(),
    ['agentCreated', 'agentPresets', 'agents', 'continuable', 'llm', 'settings',
      'subagents', 'timer', 'tools', 'webServer'])
  check('and names the ones that were missing here',
    [health.capabilities.subagents, health.capabilities.webServer], [true, false])

  // The five dead methods are gone: an unknown path must 404, not answer.
  check('only the health method exists', [...stubs.handlers.keys()], ['health'])
}

// 13a. The tool list comes from the sessions' TOOL ENTRIES.
//
// `headerToolNames` returns one space-joined string because the deterministic
// matcher wants exactly that; iterating it yields its CHARACTERS, which is how
// the settings page came to offer `a`, `b`, `c` … as tools. The picker needs the
// list, so a list it gets — and this is the guard that keeps it that way.
{
  // A live agent as the router sees it: the health read walks each agent's
  // ASSEMBLED header, so the fake carries the same `requestHeader` accessor a
  // real session does.
  const live = { session: session({ id: 'live-1', messages: [['user', 'hi']] }) }
  const stubs = await mount(undefined, undefined, { agents: [live] })
  enable(stubs, { preset: 'diy-smart' })
  const listed = await stubs.handlers.get('health')()
  check('the tool list carries real tool names', listed.tools, ['pwsh'])
  check('and never single characters', listed.tools.every(name => name.length > 1), true)
  check('the plugin does not offer itself as a child tool',
    listed.tools.some(name => name === 'subagent' || name === 'subagent_message'), false)

  // A foreign session shape must read as "no tools", not as a failure.
  const noAccessor = { session: { id: 'odd', header: {} } }
  const odd = await mount(undefined, undefined, { agents: [noAccessor] })
  check('a session without a header accessor yields no tools',
    (await odd.handlers.get('health')()).tools, [])
  check('and is not reported as a failure',
    (await odd.handlers.get('health')()).errors, [])
}

// 13b. The breaker takes the plugin out of the request path after repeated
//      failures, and a settings change puts it back.
{
  const stubs = await mount()
  enable(stubs)
  // Make routing fail: a hostile session whose header accessor throws.
  const hostile = { session: { ...session({ messages: [['user', '建模']] }), header: null } }
  Object.defineProperty(hostile.session, 'header', {
    get() { throw new Error('header exploded') },
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await stubs.listeners.get('agent/request')(
      { agent: hostile, turn: attempt, step: 0, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
    )
  }
  const tripped = await stubs.handlers.get('health')()
  check('repeated failures trip the breaker', tripped.breaker.tripped, true)
  check('and the reason names the failure',
    typeof tripped.breaker.reason === 'string' && tripped.breaker.reason.includes('header exploded'), true)
  check('the failures are kept for the page', tripped.errors.length >= 5, true)

  // A settings change is a human decision to try again.
  await stubs.settings.scope.replace(hostPlain({ ...stubs.settings.value(), enabled: true }))
  await settle()
  const reset = await stubs.handlers.get('health')()
  check('a settings change clears the breaker', reset.breaker.tripped, false)

  // And a routed turn works again.
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '建模']] }) }, 1)
  check('routing works again after the reset', routed.provider, 'google')
}

// 14. Per-task reasoning effort rides the route.
//
// A changed provider/model drops the inherited effort, so the adapter applies
// its own route default — often `high`, which a cheap pool then pays for.
{
  const stubs = await mount()
  enable(stubs, {
    tasks: [{ id: 'modelling', name: '3D', description: '三维', enabled: true, keywords: ['建模'],
      reasoningEffort: 'low',
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] }],
  })
  const routed = await request(stubs.listeners, { session: session({ messages: [['user', '建模']] }) }, 1)
  check('a task can pin the reasoning effort', routed.reasoningEffort, 'low')
  check('and the route still comes from the pool', routed.provider, 'google')

  const plain = await mount()
  enable(plain, {
    tasks: [{ id: 'modelling', name: '3D', description: '三维', enabled: true, keywords: ['建模'],
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] }],
  })
  const inherited = await request(plain.listeners, { session: session({ messages: [['user', '建模']] }) }, 1)
  check('without one, a route change drops the inherited effort too',
    inherited.reasoningEffort, undefined)
}
// 15. Settings changes invalidate cached decisions.
{
  const stubs = await mount()
  enable(stubs)
  const agent = { session: session({ messages: [['user', '建模']] }) }
  await request(stubs.listeners, agent, 1)
  await stubs.settings.scope.replace(hostPlain({ ...stubs.settings.value(), enabled: false }))
  check('a saved change takes effect immediately',
    (await request(stubs.listeners, agent, 1)).provider, 'deepseek-official')
}

// 18. The plugin SUPPLIES delegation, per granted preset, without touching any
//     preset file.
//
// `diy-smart` mounts no delegation row at all, which is why its main agent
// could never delegate: the tool simply was not in its table. This plugin
// registers its own, so the capability arrives with the grant and leaves with
// it — nothing is written to disk.
{
  const agent = fakeAgent({ preset: 'diy-smart', builtins: ['subagent', 'subagent_fork', 'read'] })
  const stubs = await mount(undefined, undefined, { agents: [agent] })

  check('an ungranted preset gets no delegation tool', agent.owns.size, 0)

  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)
  const mine = agent.registered.get('subagent')
  check('a granted preset gets the delegation tool', mine !== undefined, true)
  check('the tool is OURS, not the built-in',
    mine.description.includes('Delegate ONE closed task'), true)
  // The built-in `subagent` is left alone: ours shadows it by name, which the
  // real ToolRuntime resolves to the scope's own registration.
  check('the other built-in delegation tool is masked',
    agent.restrictions.some(filter => filter.deny?.includes('subagent_fork')), true)
  check('a non-delegation tool is untouched',
    agent.restrictions.some(filter => filter.deny?.includes('read')), false)
  check('the policy names every routable task',
    ['modelling', 'general'].every(id => mine.description.includes(id)), true)
  check('the policy explains the ownership rule',
    mine.description.includes('the child that got the task keeps it'), true)
  check('the task argument is an enum of the enabled tasks',
    mine.parameters.properties.task.enum, ['modelling', 'general'])

  // Revoking the grant restores the deployment exactly.
  stubs.settings.value().presets = {}
  await mountSync(stubs)
  check('revoking the grant removes the tool', agent.owns.size, 0)
  check('and the built-in is visible again',
    agent.registered.get('subagent').description, 'built-in subagent')
  check('and every mask it installed is lifted', agent.restrictions, [])
}

// 18b. A child never receives the tool: the graph stays one level deep by
//      construction, not by instruction.
{
  const child = fakeAgent({ preset: 'diy-smart', origin: 'subagent' })
  const stubs = await mount(undefined, undefined, { agents: [child] })
  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)
  check('a delegated child gets no delegation tool', child.owns.size, 0)
}

// 18c. Without a continuable provider the tool falls back to a one-shot child:
//      it goes through the in-process spawn provider, marks the task
//      deterministically, and returns the deliverable directly.
{
  const agent = fakeAgent({ preset: 'diy-smart' })
  const subagents = makeSubagents({ output: [{ type: 'text', text: '齿轮已建好' }] }, false)
  const stubs = await mount(undefined, undefined, { agents: [agent], subagents })
  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)
  const tool = agent.registered.get('subagent')
  const value = await tool.execute(
    { description: '建一个齿轮', prompt: '用 FreeCAD 建一个直齿轮', task: 'modelling' },
    { agent, signal: new AbortController().signal },
  )
  const sent = subagents.requests[0]
  check('delegation goes through the spawn provider', sent.provider, 'spawn')
  check('the child is capped at one level', sent.request.maxDepth, 1)
  check('the caller is the delegating agent', sent.request.parent, agent)
  // The marker goes at the END. A LEADING directive became the child's sidebar
  // title in a real session, and `matchDeterministic` scans the whole opener, so
  // the tail loses nothing.
  check('the explicit task rides the opener as a trailing directive',
    sent.request.prompt[0].text, '用 FreeCAD 建一个直齿轮\n\n[task: modelling]')
  check('and the opener still STARTS with the human task',
    sent.request.prompt[0].text.startsWith('用 FreeCAD 建一个直齿轮'), true)
  check('the child answer reaches the parent', value.text, '齿轮已建好')
  check('and the task is echoed back', value.task, 'modelling')
}

// 18d. A child that somehow still holds the tool is refused at execution, and a
//      child that fails is reported to the caller rather than retried forever.
{
  const agent = fakeAgent({ preset: 'diy-smart' })
  const subagents = makeSubagents({ throws: 'all pool models failed' })
  const stubs = await mount(undefined, undefined, { agents: [agent], subagents })
  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)
  const tool = agent.registered.get('subagent')

  agent.session.header.origin = 'subagent'
  let refused
  try {
    await tool.execute({ description: 'x', prompt: 'y' }, { agent, signal: new AbortController().signal })
  } catch (error) {
    refused = error.message
  }
  check('a child cannot delegate through this tool',
    typeof refused === 'string' && refused.includes('does not delegate further'), true)

  agent.session.header.origin = undefined
  let propagated
  try {
    await tool.execute({ description: 'x', prompt: 'y' }, { agent, signal: new AbortController().signal })
  } catch (error) {
    propagated = error.message
  }
  check('a failed child surfaces to the caller instead of being swallowed',
    propagated, 'all pool models failed')
  check('and only one child was started',
    subagents.requests.length + subagents.starts.length, 1)
}

// 18e. The same child keeps the task: delegation creates a CONTINUABLE child and
//      the plugin supplies the continuation tool, because a preset without that
//      row leaves the main agent unable to continue anything.
{
  const agent = fakeAgent({ preset: 'diy-smart' })
  const subagents = makeSubagents()
  const stubs = await mount(undefined, undefined, { agents: [agent], subagents })
  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)

  check('both tools are installed', [...agent.owns.keys()].sort(), ['subagent', 'subagent_message'])
  const delegate = agent.registered.get('subagent')
  const message = agent.registered.get('subagent_message')
  check('the delegation policy routes revisions to the same child',
    delegate.description.includes('subagent_message'), true)
  check('and says not to start a new child for a revision',
    delegate.description.includes('Do not start a new child for a'), true)
  check('the continuation tool explains what it is for',
    message.description.includes('keeping the same child for the same task'), true)
  check('and forbids handing over an unrelated task',
    message.description.includes('Do not use it to hand the child a different'), true)

  const value = await delegate.execute(
    { description: 'build a part', prompt: 'Build part A to spec S.' },
    { agent, signal: new AbortController().signal },
  )
  const spec = subagents.starts[0]
  check('delegation starts a continuable child', subagents.starts.length, 1)
  check('through the spawn provider and the calling agent',
    [spec.provider, spec.request.parent], ['spawn', agent])
  check('the child is capped at one level', spec.request.maxDepth, 1)
  check('the id comes back for later messages', value.subagent_id, 'child-7')
  check('and the text tells the model how to continue it',
    value.text.includes('subagent_message'), true)

  const sent = await message.execute(
    { subagent_id: 'child-7', message: 'Rework the tolerance on the outer face.' },
    { agent, signal: new AbortController().signal },
  )
  const forwarded = subagents.messages[0]
  check('the follow-up goes to the SAME child', forwarded.targetId, 'child-7')
  check('from the calling agent', forwarded.sender, agent)
  check('as the message text the model wrote',
    forwarded.content, [{ type: 'text', text: 'Rework the tolerance on the outer face.' }])
  check('and the model is told the reply arrives as a notice',
    sent.text.includes('notice'), true)

  // Revoking the grant removes BOTH tools.
  stubs.settings.value().presets = {}
  await mountSync(stubs)
  check('revoking removes both tools', agent.owns.size, 0)
}

// 18f. Without a continuable provider, the policy must not promise one.
{
  const agent = fakeAgent({ preset: 'diy-smart' })
  const subagents = makeSubagents(undefined, false)
  const stubs = await mount(undefined, undefined, { agents: [agent], subagents })
  enable(stubs, { preset: 'diy-smart' })
  await mountSync(stubs)

  check('only the delegation tool is installed', [...agent.owns.keys()], ['subagent'])
  const delegate = agent.registered.get('subagent')
  check('no continuation tool is named', delegate.description.includes('subagent_message'), false)
  check('and the policy describes the fresh-child reality',
    delegate.description.includes('returns one deliverable and ends'), true)

  const value = await delegate.execute(
    { description: 'x', prompt: 'y' },
    { agent, signal: new AbortController().signal },
  )
  check('it falls back to a one-shot child', [subagents.requests.length, subagents.starts.length], [1, 0])
  check('and returns the deliverable directly', value.text, 'child answer')
}

// 18g. A task can shape its children: a persona that REPLACES the inherited one
//      and a tool filter applied at creation — without touching any preset.
//
// A child composes the PARENT's preset, so this is the only way to give it a
// task-shaped prompt: `persona` is registered on the child's own scope under the
// deployment persona's name, and `complete: true` leaves exactly one complete
// section, so nothing of the parent's prompt rides along.
{
  const parent = fakeAgent({ preset: 'diy-smart', id: 'p1' })
  const subagents = makeSubagents()
  const stubs = await mount(undefined, undefined, { agents: [parent], subagents })
  enable(stubs, {
    preset: 'diy-smart',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维', enabled: true, keywords: ['建模'],
        childPersona: 'You are a CAD executor. Do only the part you were given.',
        childTools: { deny: ['web_fetch'] },
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
      { id: 'general', name: '通用', description: '日常', enabled: true,
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  await mountSync(stubs)

  // The child is created DURING the delegation call, exactly like the runtime.
  const children = []
  subagents.onCreate = (parentAgent) => {
    const child = fakeAgent({
      preset: 'diy-smart',
      origin: 'subagent',
      id: `c${children.length + 1}`,
      parent: parentAgent.session.id,
      // A child scope is nested under its parent's, so it INHERITS the parent's
      // registrations — including the delegation tools this plugin installed
      // there. Modelling that is what makes the mask assertion meaningful.
      builtins: [...parentAgent.registered.keys()],
    })
    children.push(child)
    stubs.listeners.get('agent/created')({ agent: child })
  }

  const tool = parent.registered.get('subagent')
  await tool.execute(
    { description: 'part', prompt: 'Build part A.', task: 'modelling' },
    { agent: parent, signal: new AbortController().signal },
  )
  const child = children[0]
  const sent = subagents.starts[0]
  check('the task persona is installed on the CHILD scope',
    child.sections.map(section => section.name), ['deployment:persona-prefix'])
  check('and it replaces the inherited prompt completely',
    [child.sections[0].text, child.sections[0].complete],
    ['You are a CAD executor. Do only the part you were given.', true])
  check('the task tool filter rides the start request',
    sent.request.toolFilter.deny, ['web_fetch'])
  check('a child never receives the delegation tools themselves',
    child.owns.size, 0)
  check('and its own delegation names are masked',
    child.restrictions.map(filter => filter.deny[0]).sort(),
    ['subagent', 'subagent_fork', 'subagent_message'])

  // A task with no child profile leaves the child inheriting exactly as before.
  const plain = fakeAgent({ preset: 'diy-smart', id: 'p2' })
  stubs.ctx.agents.push(plain)
  stubs.listeners.get('agent/created')({ agent: plain })
  await settle()
  const plainTool = plain.registered.get('subagent')
  await plainTool.execute(
    { description: 'chore', prompt: 'Tidy the notes.', task: 'general' },
    { agent: plain, signal: new AbortController().signal },
  )
  const plainChild = children[1]
  check('a task without a persona inherits the parent composition',
    plainChild.sections, [])
  // No childTools means NO filter at all. An earlier version added this
  // plugin's own tool names to every child's deny list; the provider validates
  // those names against the CHILD's registry, where they do not exist, so it
  // refused the filter and the retry dropped it — noise on every delegation and
  // no protection whatever. Recursion is enforced elsewhere (see the case below).
  check('a task without childTools sends no filter',
    subagents.starts[1].request.toolFilter, undefined)

  // The switch, not the preset, decides recursion: enabled means no mask.
  stubs.settings.value().childDelegation = true
  await mountSync(stubs)
  const permissive = fakeAgent({ preset: 'diy-smart', id: 'p3' })
  stubs.ctx.agents.push(permissive)
  stubs.listeners.get('agent/created')({ agent: permissive })
  await settle()
  children.length = 0
  await permissive.registered.get('subagent').execute(
    { description: 'split', prompt: 'Split this into parts.', task: 'general' },
    { agent: permissive, signal: new AbortController().signal },
  )
  check('child delegation on: the child is not masked',
    children[0].restrictions, [])
  check('and the depth cap allows the one extra level',
    subagents.starts[2].request.maxDepth, 2)
  check('while an operator filter still applies',
    subagents.starts[2].request.toolFilter, undefined)
}

// 18h. A tool filter the child cannot honour loses the FILTER, not the
//      delegation — and only a filter refusal is retried.
{
  const agent = fakeAgent({ preset: 'diy-smart' })
  const subagents = makeSubagents()
  const stubs = await mount(undefined, undefined, { agents: [agent], subagents })
  enable(stubs, {
    preset: 'diy-smart',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维', enabled: true,
        childTools: { allow: ['read', 'ghost_tool'] },
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
    ],
  })
  await mountSync(stubs)

  // First attempt: the provider refuses the filter name. Retry: without it.
  subagents.startContinuable = async (spec) => {
    subagents.starts.push(spec)
    if (spec.request.toolFilter !== undefined) {
      throw new Error('tools.restrict() names unknown global tool "ghost_tool"; known global tools: read')
    }
    return { childId: 'child-9', messageId: 'msg-1' }
  }
  const value = await agent.registered.get('subagent').execute(
    { description: 'part', prompt: 'Build part A.', task: 'modelling' },
    { agent, signal: new AbortController().signal },
  )
  check('a filter refusal is retried without the filter',
    subagents.starts.map(spec => spec.request.toolFilter === undefined), [false, true])
  check('and the delegation still happens', value.subagent_id, 'child-9')
  check('the dropped filter is reported, not hidden',
    stubs.logs.some(line => line.includes('child tool filter')), true)

  // Any OTHER failure must propagate: retrying a rate limit would double work.
  const other = fakeAgent({ preset: 'diy-smart', id: 'a2' })
  const subagents2 = makeSubagents()
  const stubs2 = await mount(undefined, undefined, { agents: [other], subagents: subagents2 })
  enable(stubs2, {
    preset: 'diy-smart',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维', enabled: true, childTools: { allow: ['read'] },
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] },
    ],
  })
  await mountSync(stubs2)
  subagents2.startContinuable = async (spec) => {
    subagents2.starts.push(spec)
    throw new Error('429 rate limited')
  }
  let propagated
  try {
    await other.registered.get('subagent').execute(
      { description: 'x', prompt: 'y', task: 'modelling' },
      { agent: other, signal: new AbortController().signal },
    )
  } catch (error) {
    propagated = error.message
  }
  check('a non-filter failure is not retried', subagents2.starts.length, 1)
  check('and reaches the caller unchanged', propagated, '429 rate limited')
}

// 18i. A child's tool list is built as an ALLOW list, so delegation tools cannot
//      appear in it without needing to be named.
//
// The child composes its own preset, which here carries delegation rows; a DENY
// list naming them is refused wholesale at creation, so nothing was filtered at
// all. Naming what the child KEEPS is the mechanism that actually removes them.
{
  const parent = fakeAgent({ preset: 'diy-smart', id: 'allow-1' })
  // A realistic caller: an assembled header carrying this deployment's tools,
  // including the delegation tools that must not reach a child.
  parent.session.requestHeader = () => ({
    config: {},
    tools: [
      { name: 'read' }, { name: 'pwsh' }, { name: 'web_fetch' },
      { name: 'subagent' }, { name: 'subagent_message' },
      { name: 'subagent_fork' }, { name: 'list_subagent_models' },
    ].map(entry => ({ ...entry, description: '', parameters: {} })),
  })
  const subagents = makeSubagents()
  const stubs = await mount(undefined, undefined, { agents: [parent], subagents })
  enable(stubs, {
    preset: 'diy-smart',
    tasks: [{ id: 'modelling', name: '3D', description: '三维', enabled: true,
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] }],
  })
  await mountSync(stubs)
  await parent.registered.get('subagent').execute(
    { description: 'part', prompt: 'Build part A.', task: 'modelling' },
    { agent: parent, signal: new AbortController().signal },
  )
  const allow = subagents.starts[0].request.toolFilter?.allow ?? []
  check('the child keeps the ordinary tools', allow.includes('read') && allow.includes('pwsh'), true)
  check('and none of the delegation tools', allow.filter(name => /subagent|delegate/.test(name)), [])
  check('the list is not empty (that would deny everything)', allow.length > 0, true)
  check('and it carries no duplicates', allow.length, new Set(allow).size)

  // A caller with no tool header must produce NO filter, never an empty allow.
  const blind = fakeAgent({ preset: 'diy-smart', id: 'allow-2' })
  const second = makeSubagents()
  const stubs2 = await mount(undefined, undefined, { agents: [blind], subagents: second })
  enable(stubs2, {
    preset: 'diy-smart',
    tasks: [{ id: 'modelling', name: '3D', description: '三维', enabled: true,
      pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 }] }],
  })
  await mountSync(stubs2)
  await blind.registered.get('subagent').execute(
    { description: 'part', prompt: 'Build part A.', task: 'modelling' },
    { agent: blind, signal: new AbortController().signal },
  )
  check('no readable tool header means no filter at all',
    second.starts[0].request.toolFilter, undefined)
}

// 19. A task whose whole pool failed hands the turn to the default task; when
//     that is spent too, the caller keeps the inherited route and works itself.
{
  const stubs = await mount()
  enable(stubs, {
    defaultTaskId: 'general',
    tasks: [
      { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
        pool: [{ provider: 'google', model: 'gemini-3.7-flash', weight: 1 },
          { provider: 'google', model: 'gemini-3.6-flash', weight: 1 }] },
      { id: 'general', name: '通用', description: '日常', enabled: true,
        pool: [{ provider: 'b-ai', model: 'qwen3.8-flash', weight: 1 }] },
    ],
  })
  const agent = { session: session({ messages: [['user', '建模']] }) }
  const routed = await request(stubs.listeners, agent, 1)
  check('the first attempt uses the task pool', routed.provider, 'google')

  const fail = (provider, model) => stubs.listeners.get('agent/request-error')(
    { agent, turn: 1, step: 0, provider, model, failure: { message: 'boom', code: 'X' },
      retryPolicy: undefined, signal: new AbortController().signal },
    async () => undefined,
  )

  check('the first model failing rotates inside the pool', await fail('google', 'gemini-3.7-flash'), { kind: 'retry' })
  // The rotation moved the pin; the second attempt lands on the other model.
  const second = await request(stubs.listeners, agent, 1)
  check('the retry uses the other pool model', second.model, 'gemini-3.6-flash')

  const afterFallback = await fail('google', 'gemini-3.6-flash')
  check('a spent pool falls back to the default task', afterFallback, { kind: 'retry' })
  check('and says so', stubs.logs.some(line => line.includes('exhausted; falling back')), true)

  const viaDefault = await request(stubs.listeners, agent, 1)
  check('the fallback runs on the default task', [viaDefault.provider, viaDefault.model], ['b-ai', 'qwen3.8-flash'])

  const spent = await fail('b-ai', 'qwen3.8-flash')
  check('a spent default task stops retrying', spent, undefined)
  check('and reports that nothing is left',
    stubs.logs.some(line => line.includes('leaving the turn to the caller')), true)

  const inherited = await request(stubs.listeners, agent, 1)
  check('the caller then keeps its own route and does the work', inherited.provider, 'deepseek-official')
}

// 16. The plugin registers exactly the listeners it owns.
{
  const stubs = await mount()
  check('the routing events are observed, and the agent lifecycle with them',
    [...stubs.listeners.keys()].sort(),
    ['agent/created', 'agent/disposed', 'agent/request', 'agent/request-error'])
  // Three effects: the settings watcher, the delegation tools, and the health
  // handler registration on the dynamic-plugin harness.
  check('the settings watcher is an effect', stubs.effects.length, 3)
}

// 17. `apply` must return nothing.
//
// Cordis reads a plugin's `apply` return value as its effect and accepts only a
// disposer, a promise, an iterator, or null/undefined. Returning a plain object
// fails the mount with `TypeError: Invalid effect` — and because this row is
// part of the profile tree, that failure takes down the entire boot, so the
// settings page never appears at all. The dynamic runner tolerates a bad
// return, which is exactly why this needs an explicit assertion on the
// profile path.
{
  const stubs = await mount()
  check('apply returns nothing, not a bare object', stubs.applyResult, undefined)
}

// ── report ──────────────────────────────────────────────────────────────────
const failed = results.filter(result => !result.ok)
for (const result of results) {
  output.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
output.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
