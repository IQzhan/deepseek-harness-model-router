/**
 * Offline tests for model-routing-config.js — the pure routing core.
 *
 * The contract under test:
 *   · routing applies to DELEGATED sessions only (the main session keeps the
 *     model its user picked);
 *   · the default task is a REFERENCE that resolves only when it names a task
 *     able to serve, so "no default" is always honest;
 *   · a preset grants permission and never redefines policy.
 *
 * Run: node test-model-routing-config.mjs
 */
import {
  NAMESPACE, defaultConfig, starterConfig, validateConfig, presetPolicy,
  candidateTasks, matchDeterministic, resolveSync, classifierPrompt,
  parseClassifierReply, createScheduler, weightOf, reconcile,
  isRouteId, sanitizePool, sanitizeConfig,
} from './model-routing-config.js'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

/** A config with three tasks and three presets. */
function fixture() {
  const config = defaultConfig()
  config.enabled = true
  config.defaultTaskId = 'general'
  config.tasks = [
    { id: 'modelling', name: '3D', description: '三维建模', enabled: true, keywords: ['建模'],
      pool: [{ provider: 'google', model: 'g1', weight: 1 }, { provider: 'google', model: 'g2', weight: 1 }] },
    { id: 'web-research', name: '搜', description: '联网搜索', enabled: true, keywords: ['搜一下'],
      tools: ['web_search'], pool: [{ provider: 'or', model: 'free', weight: 1 }] },
    { id: 'general', name: '通用', description: '日常', enabled: true, keywords: [],
      pool: [{ provider: 'ds', model: 'flash', weight: 1 }] },
  ]
  config.presets = {
    'diy-smart': { enabled: true },
    'diy': { enabled: true, exclusive: true, tasks: ['modelling', 'general'] },
    'standard': { enabled: false },
  }
  return config
}

/** Shorthand for a routing context. A delegated child is the default subject. */
function ctx(overrides = {}) {
  return { presetId: 'diy-smart', isSubagent: true, text: '', toolNames: '', ...overrides }
}

// ── namespace + defaults ────────────────────────────────────────────────────
check('namespace follows the settings grammar', /^[a-z0-9]+(-[a-z0-9]+)*$/.test(NAMESPACE), true)
check('default config is valid and off', [validateConfig(defaultConfig()).ok, defaultConfig().enabled], [true, false])
check('starter config is valid', validateConfig(starterConfig()).ok, true)
check('default config has no default task', defaultConfig().defaultTaskId, '')
check('default config carries no retired flags',
  ['respectExplicitSelection', 'routeSubagents', 'search'].filter(key => key in defaultConfig()), [])
check('starter config ships no default task', starterConfig().defaultTaskId, '')

// ── the samples are templates, and templates must not mislead ───────────────
//
// Five generic shapes of work, written in English, with EMPTY pools: a sample that
// shipped a model would route traffic on someone else's account the moment they turned
// the plugin on, and a sample that named a framework would only be followed for that
// framework. The tool scopes are checked too, because a filter naming a tool the child
// cannot see makes the provider refuse the WHOLE filter — so the samples may only name
// tools every DSH deployment has.
{
  const starter = starterConfig()
  check('the samples cover five shapes of work',
    starter.tasks.map(task => task.id),
    ['general', 'web-search', 'bulk', 'drawing', 'modelling'])
  check('every sample is switchable on but routes nothing yet',
    starter.tasks.every(task => task.enabled === true && (task.pool ?? []).length === 0), true)
  check('no sample ships a model', /provider|model:/u.test(JSON.stringify(starter.tasks)), false)
  check('the samples are written in English',
    /[\u4e00-\u9fff]/u.test(JSON.stringify(starter.tasks)), false)
  check('every sample describes itself for the classifier',
    starter.tasks.every(task => typeof task.description === 'string' && task.description.length > 40), true)
  check('every sample gives its executor a persona',
    starter.tasks.every(task => typeof task.childPersona === 'string' && task.childPersona.length > 80), true)

  // Only tools DSH itself registers in an agent scope: a name a deployment does not
  // have voids the entire filter, which is worse than no filter at all.
  const PORTABLE_TOOLS = new Set(['read', 'write', 'edit', 'glob', 'grep', 'pwsh', 'web_fetch', 'web_search'])
  const named = starter.tasks.flatMap(task => task.childTools?.deny ?? [])
  check('the samples only scope tools every deployment has',
    named.filter(name => !PORTABLE_TOOLS.has(name)), [])
  check('and they scope tools on the tasks that clearly need it',
    starter.tasks.filter(task => task.childTools !== undefined).map(task => task.id),
    ['web-search', 'bulk'])
  // The point of the bulk task: per-item thinking must stay shallow.
  check('the volume sample asks for the cheap reasoning level',
    starter.tasks.find(task => task.id === 'bulk')?.reasoningEffort, 'low')
}

// ── validation ──────────────────────────────────────────────────────────────
check('non-object config is rejected', validateConfig(null).ok, false)
check('bad task id is rejected', validateConfig({ tasks: [{ id: 'Bad Id', pool: [] }] }).ok, false)
check('duplicate task id is rejected',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'm' }] }, { id: 'a', pool: [{ provider: 'p', model: 'm' }] }] })
    .problems.some(problem => problem.includes('duplicate task id')), true)
check('enabled task with empty pool warns but is valid', (() => {
  const report = validateConfig({ tasks: [{ id: 'a', enabled: true, pool: [] }] })
  return [report.ok, report.problems, report.warnings.some(w => w.includes('will not route'))]
})(), [true, [], true])
check('non-positive weight is rejected',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'm', weight: 0 }] }] }).ok, false)
// The optional child profile: a persona REPLACES the inherited prompt, a tool
// filter shapes the child's tool table. Both must reject shapes that would
// silently do something else than the author meant.
check('an empty child persona is rejected',
  validateConfig({ tasks: [{ id: 'a', childPersona: '   ',
    pool: [{ provider: 'p', model: 'm' }] }] }).ok, false)
check('a child tool filter with neither allow nor deny is rejected',
  validateConfig({ tasks: [{ id: 'a', childTools: {},
    pool: [{ provider: 'p', model: 'm' }] }] }).problems.some(p => p.includes('allow and/or deny')), true)
check('a child tool filter naming a non-string is rejected',
  validateConfig({ tasks: [{ id: 'a', childTools: { allow: ['read', 7] },
    pool: [{ provider: 'p', model: 'm' }] }] }).ok, false)
check('a well-formed child profile is accepted',
  validateConfig({ tasks: [{ id: 'a', childPersona: 'You are an executor.',
    childTools: { deny: ['web_fetch'] }, pool: [{ provider: 'p', model: 'm' }] }] }).ok, true)
// Two spellings for one field is what made the settings page misread a deny
// document, so a document that carries both is valid but says so out loud.
const bothSpellings = validateConfig({ tasks: [{ id: 'a',
  childTools: { allow: ['read'], deny: ['pwsh'] }, pool: [{ provider: 'p', model: 'm' }] }] })
check('a filter declaring both spellings is still valid', bothSpellings.ok, true)
check('and warns which one is applied',
  bothSpellings.warnings.some(w => w.includes('deny is subtracted from allow')), true)
check('a single spelling warns about nothing',
  validateConfig({ tasks: [{ id: 'a', childTools: { deny: ['pwsh'] },
    pool: [{ provider: 'p', model: 'm' }] }] }).warnings.length, 0)
check('duplicate route in one pool is rejected',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }] }] })
    .problems.some(p => p.includes('repeats route')), true)
check('preset referring to an unknown task is rejected',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'm' }] }],
    presets: { x: { enabled: true, exclusive: true, tasks: ['nope'] } } })
    .problems.some(p => p.includes('unknown task "nope"')), true)
check('enabled classifier without a route is rejected',
  validateConfig({ classifier: { enabled: true } }).problems.some(p => p.includes('requires provider and model')), true)
check('all problems are reported at once',
  validateConfig({ enabled: 'yes', tasks: 'nope', presets: [] }).problems.length >= 3, true)
check('byId survives a partial document',
  validateConfig({ tasks: [{ id: 'ok', pool: [{ provider: 'p', model: 'm' }] }, { id: 'BAD', pool: [] }] }).byId.size, 1)

// ── the stringified-nullish corruption ──────────────────────────────────────
check('isRouteId accepts a real id', isRouteId('deepseek-flash'), true)
check('isRouteId rejects the literal "undefined"', isRouteId('undefined'), false)
check('isRouteId rejects the literal "null"', isRouteId('null'), false)
check('isRouteId rejects empty and non-strings', [isRouteId(''), isRouteId(undefined), isRouteId(42)], [false, false, false])
check('sanitizePool drops a stringified-undefined model',
  sanitizePool([{ provider: 'p', model: 'undefined' }, { provider: 'p', model: 'ok' }]).map(e => e.model), ['ok'])
check('validation rejects a stringified-undefined model with a repair hint',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'undefined' }] }] })
    .problems.some(p => p.includes('stringified nullish')), true)
check('a validated task exposes only usable routes',
  validateConfig({ tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'undefined' }, { provider: 'p', model: 'ok' }] }] })
    .byId.get('a').pool.map(e => e.model), ['ok'])
check('sanitizeConfig repairs the whole document', (() => {
  const repaired = sanitizeConfig({
    defaultTaskId: 'gone',
    tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'undefined' }, { provider: 'q', model: 'ok' }] }],
  })
  return [repaired.config.tasks[0].pool.map(e => e.model), repaired.config.defaultTaskId, repaired.removed.length]
})(), [['ok'], '', 1])
check('sanitizeConfig keeps a usable default',
  sanitizeConfig({ defaultTaskId: 'a', tasks: [{ id: 'a', pool: [{ provider: 'p', model: 'm' }] }] })
    .config.defaultTaskId, 'a')

// ── preset permissions ──────────────────────────────────────────────────────
const config = fixture()
check('unconfigured preset does not route', presetPolicy(config, 'unknown').allowed, false)
check('preset with no presetId does not route', presetPolicy(config, undefined).allowed, false)
check('explicitly disabled preset does not route', presetPolicy(config, 'standard').allowed, false)
check('enabled preset routes every task', presetPolicy(config, 'diy-smart'), { allowed: true, tasks: null })
check('exclusive preset routes only its list', presetPolicy(config, 'diy'), { allowed: true, tasks: ['modelling', 'general'] })
check('non-exclusive preset sees every enabled task',
  candidateTasks(config, 'diy-smart').map(task => task.id), ['modelling', 'web-research', 'general'])
check('a preset never redefines policy', candidateTasks(config, 'diy')[0].pool, config.tasks[0].pool)
check('the default task is ordered LAST for the classifier',
  candidateTasks(config, 'diy-smart').at(-1).id, 'general')

// ── the resolution ladder: delegated sessions only ──────────────────────────
check('disabled config routes nothing', resolveSync({ ...config, enabled: false }, ctx()).tier, 'disabled')
check('the MAIN session is never routed', resolveSync(config, ctx({ isSubagent: false })).tier, 'not-delegated')
check('a main session with a deterministic match is still not routed',
  resolveSync(config, ctx({ isSubagent: false, text: '建模' })).tier, 'not-delegated')
check('a delegated child IS routed', resolveSync(config, ctx({ text: '建模' })).tier, 'deterministic')
check('unpermitted preset routes nothing', resolveSync(config, ctx({ presetId: 'standard' })).tier, 'preset')
check('keyword match is deterministic', resolveSync(config, ctx({ text: '帮我建模一个齿轮' })).task.id, 'modelling')
check('tool name match is deterministic',
  resolveSync(config, ctx({ toolNames: 'read web_search write' })).task.id, 'web-research')
check('explicit [task: …] directive wins over keywords',
  resolveSync(config, ctx({ text: '建模 [task: web-research]' })).task.id, 'web-research')
check('unmatched falls to the configured default', (() => {
  const resolved = resolveSync(config, ctx({ text: '写一首诗' }))
  return [resolved.task.id, resolved.tier]
})(), ['general', 'default'])
check('without a default, an unmatched delegated turn is left alone',
  resolveSync({ ...config, defaultTaskId: '' }, ctx({ text: '写一首诗' })).tier, 'unmatched')
check('a default naming a disabled task counts as no default',
  resolveSync({ ...config, tasks: config.tasks.map(t => (t.id === 'general' ? { ...t, enabled: false } : t)) },
    ctx({ text: '写一首诗' })).tier, 'unmatched')
check('a default naming an empty-pool task counts as no default',
  resolveSync({ ...config, tasks: config.tasks.map(t => (t.id === 'general' ? { ...t, pool: [] } : t)) },
    ctx({ text: '写一首诗' })).tier, 'unmatched')
check('a default naming an unknown task is reported',
  validateConfig({ ...config, defaultTaskId: 'ghost' }).problems.some(p => p.includes('unknown task "ghost"')), true)
check('deterministic match respects the exclusive task list',
  resolveSync(config, ctx({ presetId: 'diy', text: '搜一下资料' })).task.id, 'general')

// ── classifier prompt + reply parsing ───────────────────────────────────────
const prompt = classifierPrompt(config.tasks, '帮我建模')
check('prompt lists every task with its description',
  [prompt.system.includes('- modelling: 三维建模'), prompt.system.includes('- web-research: 联网搜索')], [true, true])
check('prompt asks for an id only', prompt.system.includes('Reply with ONLY the task id'), true)
check('exact reply resolves', parseClassifierReply('modelling', config.tasks).id, 'modelling')
check('reply is case and punctuation tolerant', parseClassifierReply(' Modelling.\n', config.tasks).id, 'modelling')
check('"none" resolves to nothing', parseClassifierReply('none', config.tasks), undefined)
check('empty reply resolves to nothing', parseClassifierReply('   ', config.tasks), undefined)
check('a chatty reply still resolves', parseClassifierReply('I think web-research fits', config.tasks).id, 'web-research')
check('an unknown reply resolves to nothing', parseClassifierReply('astrology', config.tasks), undefined)

// ── global load balancing ───────────────────────────────────────────────────
{
  const scheduler = createScheduler()
  const task = { id: 't', pool: [{ provider: 'p', model: 'a', weight: 1 }, { provider: 'p', model: 'b', weight: 2 }] }
  const order = []
  for (let index = 0; index < 9; index += 1) {
    order.push(scheduler.next(task, `session-${index}`, 1).candidate.model)
  }
  const counts = order.reduce((acc, model) => ({ ...acc, [model]: (acc[model] ?? 0) + 1 }), {})
  check('rotation is global across sessions', counts, { b: 6, a: 3 })
  check('smooth WRR interleaves rather than bursting', order, ['b', 'a', 'b', 'b', 'a', 'b', 'b', 'a', 'b'])
}

{
  const scheduler = createScheduler()
  const task = { id: 't', pool: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] }
  const first = scheduler.next(task, 's1', 7)
  const again = scheduler.next(task, 's1', 7)
  const nextTurn = scheduler.next(task, 's1', 8)
  check('a turn pins one model', first.candidate.model === again.candidate.model, true)
  check('the first request of a turn is the fresh pick', [first.fresh, again.fresh], [true, false])
  check('a new turn advances the rotation', nextTurn.candidate.model !== first.candidate.model, true)
}

{
  const scheduler = createScheduler()
  const task = { id: 't', pool: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] }
  const models = []
  for (let index = 0; index < 4; index += 1) models.push(scheduler.next(task, 's1', index, 'global').candidate.model)
  check('global stickiness advances every request', models, ['a', 'b', 'a', 'b'])
}

{
  const scheduler = createScheduler()
  const task = { id: 't', pool: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] }
  scheduler.next(task, 's1', 1)
  scheduler.unpin('s1', 1)
  check('unpin lets a turn re-pick', scheduler.next(task, 's1', 1).fresh, true)
  check('rotate reports success with two candidates', scheduler.rotate(task), true)
  check('rotate refuses a single-candidate pool',
    scheduler.rotate({ id: 'u', pool: [{ provider: 'p', model: 'a' }] }), false)
}

{
  // `rotateTo` reports where it advanced to, and `pin` makes the retry land
  // there. `rotate` alone is NOT enough: the retry's own `next()` call consumes
  // the slot after the advanced one, so it goes back to the model that just
  // failed — observed in the Host suite before this existed.
  const scheduler = createScheduler()
  const task = { id: 't', pool: [
    { provider: 'p', model: 'a', weight: 1 },
    { provider: 'p', model: 'b', weight: 1 },
  ] }
  check('the first pick is the head of the pool', scheduler.next(task, 's1', 1, 'turn').candidate.model, 'a')
  const advanced = scheduler.rotateTo(task)
  check('rotateTo reports the candidate it advanced to', advanced.model, 'b')
  scheduler.unpin('s1', 1)
  scheduler.pin('s1', 1, task.id, advanced)
  const retry = scheduler.next(task, 's1', 1, 'turn')
  check('the pinned retry uses the rotated-to model', retry.candidate.model, 'b')
  check('and it reads as a reuse, not a fresh pick', retry.fresh, false)
  check('rotateTo refuses a single-candidate pool',
    scheduler.rotateTo({ id: 'one', pool: [{ provider: 'p', model: 'a', weight: 1 }] }), undefined)
  const picks = scheduler.stats().t.picks
  scheduler.pin('s1', 2, task.id, undefined)
  check('pinning nothing is a no-op', scheduler.stats().t.picks, picks)
}

{
  // A pool edit mid-turn must not keep serving a model the user just removed.
  const scheduler = createScheduler()
  const before = { id: 't', pool: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] }
  scheduler.next(before, 's1', 1)
  check('a removed model is not pinned',
    scheduler.next({ id: 't', pool: [{ provider: 'p', model: 'c' }] }, 's1', 1).candidate.model, 'c')
}

{
  const scheduler = createScheduler({ pinTtlMs: 0 })
  const task = { id: 't', pool: [{ provider: 'p', model: 'a' }] }
  scheduler.next(task, 's1', 1)
  check('an expired pin re-picks', scheduler.next(task, 's1', 1).fresh, true)
}

{
  const scheduler = createScheduler()
  const task = { id: 't', pool: [{ provider: 'p', model: 'a' }, { provider: 'p', model: 'b' }] }
  for (let index = 0; index < 4; index += 1) scheduler.next(task, 's1', index)
  check('stats report picks and a next candidate', scheduler.stats().t.picks, 4)
  scheduler.reset()
  check('reset clears the stats', scheduler.stats(), {})
  check('an empty pool yields no candidate', scheduler.next({ id: 't', pool: [] }, 's', 1).candidate, undefined)
}

// The readout must not lie about the rotation it describes.
//
// `weights` used to carry the internal smooth-WRR ACCUMULATORS — which start
// empty and go negative by design (the winner is decremented by the total), so a
// nine-model pool printed `-11,1,1,…` and the page repeated it. `next` compared
// the CURRENT accumulators, while `pick()` adds each weight first and compares
// after, so the two disagree as soon as the weights differ. Both were measured
// live; both are asserted here.
{
  const scheduler = createScheduler()
  const task = {
    id: 'w',
    pool: [
      { provider: 'p', model: 'a', weight: 3 },
      { provider: 'p', model: 'b', weight: 1 },
    ],
  }
  const predicted = []
  const actual = []
  for (let index = 0; index < 8; index += 1) {
    predicted.push(scheduler.stats([task]).w.next.model)
    actual.push(scheduler.next(task, 's1', index).candidate.model)
  }
  check('the predicted next candidate is the one the pick returns', predicted, actual)
  check('the weights reported are the configured ones, not accumulators',
    scheduler.stats([task]).w.weights, [3, 1])
  check('and the routes behind them are named', scheduler.stats([task]).w.candidates, ['p/a', 'p/b'])
  check('the 3:1 pool really delivers 3:1 over a full cycle',
    [actual.filter(model => model === 'a').length, actual.filter(model => model === 'b').length], [6, 2])

  // A pool edited after the rotation was built must be described as the NEW pool:
  // passing the live tasks rebuilds it, which is what the settings page needs.
  const edited = {
    id: 'w',
    pool: [
      { provider: 'p', model: 'a', weight: 1 },
      { provider: 'p', model: 'c', weight: 1 },
    ],
  }
  check('a pool edited after the fact is described as it is now',
    scheduler.stats([edited]).w.candidates, ['p/a', 'p/c'])
  check('and its weights are the new ones', scheduler.stats([edited]).w.weights, [1, 1])
  check('while a rotation that was never picked is still described',
    scheduler.stats([{ id: 'fresh', pool: [{ provider: 'p', model: 'z' }] }]).fresh.next.model, 'z')
}

check('weightOf defaults to 1', [weightOf({}), weightOf({ weight: 3 }), weightOf({ weight: 0 })], [1, 3, 1])

// ── catalog reconciliation ──────────────────────────────────────────────────
{
  const known = [{ provider: 'google', model: 'g1' }, { provider: 'ds', model: 'flash' }]
  const result = reconcile(config, known)
  check('missing provider is distinguished from a missing model',
    result.unknown.map(entry => `${entry.model}:${entry.reason}`),
    ['g2:model-not-advertised', 'free:provider-not-registered'])
  check('a pool with no resolvable model is reported', result.poolsWithoutKnownModel, ['web-research'])
  check('a pool with no known model is reported',
    reconcile({ tasks: [{ id: 'x', pool: [{ provider: 'gone', model: 'm' }] }] }, known).poolsWithoutKnownModel, ['x'])
}

// ── reporting ───────────────────────────────────────────────────────────────
const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
if (failed.length > 0) process.exitCode = 1
