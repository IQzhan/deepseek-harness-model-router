/**
 * Verifies the INSTALLED PACKAGE the way the two real loaders see it:
 *   · Node's resolver + Cordis  → `dsh-model-router/lib/index.cjs`
 *   · the browser module loader → `dsh-model-router/lib/client.cjs`
 *
 * Run: node test-package.mjs
 */
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

// Resolve from the profile, exactly as the Cordis loader does for its row.
const profileAnchor = `file:///${(process.env.DSH_HOME ?? '').replace(/\\/g, '/')}/profiles/web/cordis.patch.yml`
const require = createRequire(profileAnchor)

// ── the package the loader finds ────────────────────────────────────────────
let pkg
try {
  pkg = require('dsh-model-router/package.json')
} catch (error) {
  console.error('cannot resolve dsh-model-router from the profile:', error.message)
  process.exit(1)
}
check('package declares dsh.client for web', pkg.dsh?.client?.platform, 'web')
check('package declares a bundle patch', pkg.dsh?.bundle?.patch, './cordis.patch.yml')
check('package exposes ./client', pkg.exports?.['./client']?.default, './lib/client.cjs')

// ── Host half: the Cordis row ───────────────────────────────────────────────
const host = require('dsh-model-router')
check('host exports a name', host.name, 'dsh-model-router')
check('host exports apply', typeof host.apply, 'function')
check('host default export mirrors it', typeof host.default?.apply, 'function')
check('host injects only mounted services', host.inject, ['settings', 'llm', 'timer'])
// The Host half must not need a module graph: the dynamic sandbox has none.
check('host bundle has no import statements',
  /^\s*import\s/m.test(readFileSync(require.resolve('dsh-model-router'), 'utf8')), false)

// ── Client half: the browser loader ─────────────────────────────────────────
const clientPath = require.resolve('dsh-model-router/client')
const clientSource = readFileSync(clientPath, 'utf8')
check('client bundle has no ESM exports', /^\s*export\s/m.test(clientSource), false)
check('client bundle registers via __ModuleLoader__', clientSource.includes('window.__ModuleLoader__.load('), true)
check('client declares react as a platform external', pkg.dsh?.client?.external, ['react'])

const registrations = []
const fakeWindow = { __ModuleLoader__: { load: (registration) => { registrations.push(registration) } } }

/**
 * Apply the bundle the way ModuleLoader does: only `window` is in scope when
 * the script runs; `factory(require)` materializes the module. React comes from
 * the platform seed via `require('react')`. Dynamic-sandbox free variables
 * (`host` / `styles` / injected `React`) stay optional fallbacks.
 */
const pageRenderers = []
const styleTags = []
const fakeDocument = {
  createElement: (tag) => {
    const el = { tag, textContent: '', attributes: {}, setAttribute(k, v) { this.attributes[k] = v }, remove() {} }
    return el
  },
  head: { appendChild: (el) => { styleTags.push(el) } },
}
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  useRef: (initial) => ({ current: initial }),
}
const slots = {
  inject: (slot, callback) => callback(),
  register: (options, component) => pageRenderers.push({ options, component }),
}
const stubCtx = {
  slots,
  get: () => undefined,
  effect: (callback) => { callback(); return () => {} },
  locale: { register: () => {}, bind: () => () => 'X', subscribe: () => () => {}, getSnapshot: () => ({ revision: 1 }) },
}

new Function('window', 'document', 'fetch', clientSource)(
  fakeWindow,
  fakeDocument,
  async () => ({ ok: true, text: async () => 'null', json: async () => null }),
)
check('client registers exactly one bundle', registrations.length, 1)
check('client bundle id equals the package name', registrations[0]?.id, 'dsh-model-router')

const moduleObject = registrations[0].factory((specifier) => {
  if (specifier === 'react') return fakeReact
  throw new Error(`the client bundle requested unexpected external "${specifier}"`)
})
check('client module exports apply', typeof moduleObject.apply, 'function')
check('client module declares its client dependencies', moduleObject.inject,
  ['slots', 'locale', 'remote', 'remote.session'])

moduleObject.apply(stubCtx)
check('client registers one settings section', pageRenderers.length, 1)
check('client section id', pageRenderers[0]?.options?.id, 'model-routing')
check('client section slot name', pageRenderers[0]?.options?.name, 'settings.section')
// The bundle must EVALUATE against a partial React. A class extending
// `React.Component` at module scope turns a missing member into
// `Class extends value undefined`, and the plugin then contributes nothing at
// all — strictly worse than any render error. `fakeReact` here deliberately has
// no `Component`, so reaching this line is the assertion.
check('the bundle evaluates against a React without Component',
  typeof fakeReact.Component, 'undefined')
check('client section renders a render function', typeof pageRenderers[0]?.component, 'function')
check('client inserts its stylesheet', styleTags.length, 1)
check('stylesheet is scoped to this plugin', styleTags[0]?.textContent?.includes('.dsh-mr'), true)

// ── the skill that ships with the plugin ────────────────────────────────────
//
// Two things must hold, and both are checkable rather than asserted in prose:
// the skill must be INVOCABLE ONLY BY A HUMAN (`disable-model-invocation: true`
// keeps it out of the model's catalog), and it must document every field the
// configuration declares — a skill that misses a field teaches an agent to
// configure the plugin wrongly.
{
  const { dirname, join } = await import('node:path')
  const { fileURLToPath } = await import('node:url')
  const here = dirname(fileURLToPath(import.meta.url))
  const skill = readFileSync(join(here, 'skills', 'model-routing', 'SKILL.md'), 'utf8')
  check('the plugin ships a skill', skill.startsWith('---'), true)
  check('the skill has a name', /^name: model-routing$/m.test(skill), true)
  check('and a description for the composer', /^description: .+$/m.test(skill), true)
  check('the skill is /-only: hidden from the model catalog',
    /^disable-model-invocation: true$/m.test(skill), true)

  const core = await import('./model-routing-config.js')
  const fields = [
    ...core.SCHEMA_FIELDS.root,
    ...core.SCHEMA_FIELDS.classifier,
    ...core.SCHEMA_FIELDS.task,
    ...core.SCHEMA_FIELDS.pool,
  ]
  check('the skill documents every configured field',
    fields.filter(field => !skill.includes(field)), [])
  check('and names the configuration folder',
    skill.includes('model-routing') && skill.includes('global.yml'), true)
  check('and states that settings.yaml no longer holds it',
    skill.includes('settings.yaml'), true)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
// Node exposes a GLOBAL `fetch`, so the page's configuration mirror polls for
// real here — its interval keeps the event loop alive and the suite would never
// exit. A page in a browser is supposed to keep polling; a test is not.
process.exit(failed.length > 0 ? 1 : 0)
