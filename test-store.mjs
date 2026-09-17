// The configuration store: real files, real folders, real round trips.
//
// Nothing here is mocked. The store's whole job is the filesystem, so testing it
// against a stub would test the parts that cannot break.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { dshHome, scratch, cleanup } from './test-support.mjs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import {
  STORE_DIRNAME, GLOBAL_FILENAME, TASKS_DIRNAME, FILE_EXT,
  isSafeTaskId, paths, readConfig, writeConfig, splitDocument, assemble, migrateFromSettings,
} from './model-routing-store.js'

// The YAML parser the deployment already uses for `settings.yaml`, so this store
// reads and writes the same dialect the rest of the harness does. Resolved from
// the harness home, since this project has no node_modules of its own.
const require = createRequire(join(dshHome(), 'profiles', 'web', 'cordis.patch.yml'))
const { parse: parseYaml, stringify: stringifyYaml } =
  await import(pathToFileURL(require.resolve('yaml')).href)

const results = []
/** Key-order-independent comparison: files round-trip, order does not matter. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}
function check(label, actual, expected) {
  const ok = canonical(actual) === canonical(expected)
  results.push({ label, ok, actual, expected })
}

const root = scratch('mr-store-')
const at = paths(root)
const config = {
  global: {
    enabled: true,
    defaultTaskId: 'general',
    childDelegation: false,
    classifier: { enabled: true, provider: 'p', model: 'm', maxInputTokens: 4000, timeoutMs: 15000 },
    presets: { 'diy-smart': { enabled: true } },
  },
  tasks: [
    { id: 'modelling', name: '3D 建模', description: '三维建模', enabled: true,
      keywords: ['建模'], reasoningEffort: 'low',
      childPersona: '你是执行者。\n只做被交付的事。',
      childTools: { allow: ['read', 'write'] },
      pool: [{ provider: 'google', model: 'g1', weight: 2 }, { provider: 'ds', model: 'flash', weight: 1 }] },
    { id: 'web-research', name: '联网检索', description: '查资料', enabled: true,
      keywords: [], pool: [{ provider: 'or', model: 'free', weight: 1 }] },
  ],
}

// ── a fresh folder is empty, not broken ─────────────────────────────────────
check('the layout keeps tasks in their own folder',
  [at.global.endsWith(GLOBAL_FILENAME), at.task('x').includes(TASKS_DIRNAME)],
  [true, true])
check('a missing folder reads as empty, without a problem',
  (() => {
    const fresh = readConfig(root, parseYaml)
    return { global: fresh.global, tasks: fresh.tasks, problems: fresh.problems }
  })(),
  { global: {}, tasks: [], problems: [] })

// ── write, then read back exactly ───────────────────────────────────────────
const written = writeConfig(root, config, stringifyYaml)
check('every task gets its own file',
  readdirSync(at.tasks).sort(), [`modelling${FILE_EXT}`, `web-research${FILE_EXT}`])
check('and the global file exists', written.includes(GLOBAL_FILENAME), true)

const back = readConfig(root, parseYaml)
check('reading returns no problems', back.problems, [])
check('the global half survives the round trip', back.global, config.global)
check('and every task survives it too', back.tasks, config.tasks)

// The file name IS the id, so a file whose body disagrees is overruled.
writeFileSync(at.task('modelling'), '---\nid: something-else\nname: Renamed\n')
check('the file name overrules a conflicting id in the body',
  readConfig(root, parseYaml).tasks.find(task => task.name === 'Renamed').id, 'modelling')

// A hand-written file needs no tooling: comments and block scalars are fine.
writeFileSync(at.task('handmade'), [
  '# a comment',
  'name: 手写的',
  'description: |',
  '  多行描述',
  '  第二行',
  'keywords: [a, b]',
  'pool:',
  '  - provider: p',
  '    model: m',
  '    weight: 1',
].join('\n'))
const handmade = readConfig(root, parseYaml).tasks.find(task => task.id === 'handmade')
check('a hand-written task file is read as-is',
  [handmade.name, handmade.description, handmade.pool],
  ['手写的', '多行描述\n第二行\n', [{ provider: 'p', model: 'm', weight: 1 }]])

// ── broken files are reported per file, and never take the rest down ────────
writeFileSync(at.task('broken'), '- not\n- a\n- mapping\n')
const withBroken = readConfig(root, parseYaml)
check('a bad file is reported, not thrown',
  withBroken.problems.map(problem => problem.file), [`${TASKS_DIRNAME}/broken${FILE_EXT}`])
check('and the good files still load',
  withBroken.tasks.map(task => task.id).sort(), ['handmade', 'modelling', 'web-research'])
writeFileSync(at.global, '[')
check('a bad global file is reported too',
  readConfig(root, parseYaml).problems.some(problem => problem.file === GLOBAL_FILENAME), true)
check('with the other files still readable',
  readConfig(root, parseYaml).tasks.length, 3)

// ── writing is authoritative: a removed task loses its file ─────────────────
writeConfig(root, config, stringifyYaml)
check('files that are no longer part of the configuration are removed',
  readdirSync(at.tasks).sort(), [`modelling${FILE_EXT}`, `web-research${FILE_EXT}`])

// ── a task id must be usable as a file name ─────────────────────────────────
check('an id with a slash is refused', isSafeTaskId('a/b'), false)
check('an id that escapes upward is refused', isSafeTaskId('../evil'), false)
check('an empty id is refused', isSafeTaskId(''), false)
check('an uppercase or spaced id is refused', [isSafeTaskId('A'), isSafeTaskId('a b')], [false, false])
check('a normal id is accepted', isSafeTaskId('web-research-2'), true)
let refused
try {
  writeConfig(root, { global: {}, tasks: [{ id: '../evil', pool: [] }] }, stringifyYaml)
} catch (error) {
  refused = error.message
}
check('writing an unsafe id fails loudly instead of escaping the folder',
  typeof refused === 'string' && refused.includes('cannot be a file name'), true)
check('and nothing was created outside the folder', readdirSync(root).sort(),
  [GLOBAL_FILENAME, TASKS_DIRNAME])
let duplicate
try {
  writeConfig(root, { global: {}, tasks: [{ id: 'x' }, { id: 'x' }] }, stringifyYaml)
} catch (error) {
  duplicate = error.message
}
check('two tasks with the same id fail loudly', duplicate.includes('appears twice'), true)

// ── the document shape is unchanged for every consumer ──────────────────────
const document = assemble(back)
check('assemble produces one document with the tasks inside it',
  Object.keys(document).sort(),
  ['childDelegation', 'classifier', 'defaultTaskId', 'enabled', 'presets', 'tasks'])
check('and splitDocument is its inverse',
  assemble(splitDocument(document)), document)
check('a task in the document carries its id back',
  document.tasks.find(task => task.name === '联网检索').id, 'web-research')

// The generated files explain themselves, and the headers survive a re-write.
const globalText = readFileSync(at.global, 'utf8')
const taskText = readFileSync(at.task('modelling'), 'utf8')
check('the global file explains every setting it holds',
  ['enabled', 'defaultTaskId', 'childDelegation', 'classifier', 'presets']
    .every(key => globalText.includes(key)), true)
check('a task file explains every setting it holds',
  ['description', 'keywords', 'pool', 'reasoningEffort', 'childPersona', 'childTools']
    .every(key => taskText.includes(key)), true)
check('the task file does not repeat the task id in its body',
  /^id:/m.test(taskText), false)
check('and the global file holds no task', /^tasks:/m.test(globalText), false)

// ── migrating a deployment that used the settings document ──────────────────
const legacy = {
  'model-routing': {
    enabled: true,
    defaultTaskId: 'general',
    classifier: { enabled: false, provider: '', model: '', maxInputTokens: 4000, timeoutMs: 15000 },
    presets: { diy: { enabled: true } },
    tasks: [{ id: 'general', name: '通用', pool: [{ provider: 'p', model: 'm', weight: 1 }] }],
  },
}
check('a settings section migrates into the store shape',
  assemble(migrateFromSettings(legacy)),
  assemble({
    global: {
      enabled: true, defaultTaskId: 'general',
      classifier: { enabled: false, provider: '', model: '', maxInputTokens: 4000, timeoutMs: 15000 },
      presets: { diy: { enabled: true } },
    },
    tasks: [{ id: 'general', name: '通用', pool: [{ provider: 'p', model: 'm', weight: 1 }] }],
  }))
check('an absent section migrates to nothing', migrateFromSettings({}), undefined)
check('an empty section migrates to nothing', migrateFromSettings({ 'model-routing': {} }), undefined)
check('a section with only tasks still migrates',
  migrateFromSettings({ 'model-routing': { tasks: [{ id: 'a' }] } }).tasks.length, 1)

rmSync(root, { recursive: true, force: true })

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
