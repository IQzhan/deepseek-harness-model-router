// Does the configuration actually deployed on this machine work?
//
// The other suites use fixtures. This one reads the REAL configuration folder and
// the REAL declared provider catalogs, then answers the only question that matters
// to the person using it: every route the router might pick — each task pool,
// the default task, the classifier — does it exist, and is the document valid?
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { readConfig, assemble, STORE_DIRNAME } from './model-routing-store.js'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const require = createRequire(join(HOME, 'profiles', 'web', 'cordis.patch.yml'))
const YAML = await import(pathToFileURL(require.resolve('yaml')).href)
const core = await import('./model-routing-config.js')

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

// ── the deployed document, from the folder the Host reads ───────────────────
const root = join(HOME, STORE_DIRNAME)
const stored = readConfig(root, YAML.parse)
check('the configuration folder has no unreadable file', stored.problems, [])
check('it holds a global file', Object.keys(stored.global).length > 0, true)

const raw = assemble(stored)
const repaired = core.sanitizeConfig(raw)
const config = repaired.config

check('the plugin is switched on', config.enabled, true)
check('the document needs no repair', repaired.removed, [])

const report = core.validateConfig(config)
check('the deployed document validates', report.problems, [])
check('the deployed document warns about nothing', report.warnings, [])

// ── the deployed catalog ────────────────────────────────────────────────────
// Same source the settings page reads: the routes the Host resolves and offers.
const settings = YAML.parse(readFileSync(join(HOME, 'settings.yaml'), 'utf8'))
// declaration that adapter never writes.
const routes = new Set()
const piAi = settings['llm-pi-ai'] ?? {}
for (const [providerId, profile] of Object.entries(piAi.providers ?? {})) {
  for (const model of profile?.models ?? []) routes.add(`${providerId}\u0000${model.id}`)
}
for (const model of settings['llm-deepseek']?.models ?? []) {
  routes.add(`deepseek-official\u0000${model.id}`)
}
for (const match of readFileSync(join(HOME, 'settings.yaml'), 'utf8')
  .matchAll(/deepseek-official\/([A-Za-z0-9._:-]+)/gu)) {
  routes.add(`deepseek-official\u0000${match[1]}`)
}
check('the catalog is not empty', routes.size > 0, true)

// ── every route the router could pick ──────────────────────────────────────
const missing = []
const used = []
const native = []
// The native DeepSeek adapter is not configured through a model list: it
// registers the provider and its own built-in catalog
// (`packages/llm/llm-deepseek/src/index.ts:90`). Its settings section existing is
// the evidence that a `deepseek-official/…` route is served, so such a route is
// taken on that evidence rather than called missing.
const nativeDeepseek = settings['llm-deepseek'] !== undefined
for (const task of config.tasks ?? []) {
  if (task.enabled === false) continue
  for (const entry of task.pool ?? []) {
    const key = `${entry.provider}\u0000${entry.model}`
    used.push(key)
    if (!core.isRouteId(entry.provider) || !core.isRouteId(entry.model)) {
      missing.push(`${task.id}: corrupt route ${JSON.stringify(key)}`)
    } else if (entry.provider === 'deepseek-official' && nativeDeepseek) {
      native.push(`${task.id}: ${entry.model}`)
    } else if (!routes.has(key)) {
      missing.push(`${task.id}: ${entry.provider}/${entry.model} is not in the catalog`)
    }
  }
}
check('every pool route resolves against the deployed catalog', missing, [])
check('the enabled tasks actually offer routes', used.length > 0, true)
if (native.length > 0) {
  console.log(`      served by the native DeepSeek adapter: ${native.join(', ')}`)
}

const classifier = config.classifier ?? {}
if (classifier.enabled === true) {
  const key = `${classifier.provider}\u0000${classifier.model}`
  check('the classifier route resolves against the deployed catalog', routes.has(key), true)
  check('the classifier budget is a positive number',
    Number.isFinite(classifier.maxInputTokens) && classifier.maxInputTokens > 0, true)
}

// The default task is optional by design; when named, it must be usable, or the
// user believes there is a fallback that will never fire.
const defaultId = config.defaultTaskId ?? ''
if (defaultId.length === 0) {
  console.log('      no default task: an unmatched delegated turn keeps the agent model')
} else {
  const task = (config.tasks ?? []).find(candidate => candidate.id === defaultId)
  check(`the default task "${defaultId}" exists`, task !== undefined, true)
  check(`the default task "${defaultId}" is enabled`, task?.enabled !== false, true)
  check(`the default task "${defaultId}" has a pool`, (task?.pool ?? []).length > 0, true)
}

// ── the grants ─────────────────────────────────────────────────────────────
for (const [presetId, preset] of Object.entries(config.presets ?? {})) {
  check(`preset "${presetId}" names only known tasks`,
    (preset.tasks ?? []).filter(id => !(config.tasks ?? []).some(task => task.id === id)), [])
}

// ── the profile wiring ─────────────────────────────────────────────────────
const patch = readFileSync(join(HOME, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
check('the profile patch mounts the plugin', patch.includes('dsh-model-router'), true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
