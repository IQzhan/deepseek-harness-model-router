// Does the BUILT Host half actually read the configuration folder?
//
// The store suite proves the reader/writer against real files, and the Host suite
// proves the fallback path. Neither answers the question that matters here: when a
// folder exists, does the deployed artifact use it? That needs the real artifact,
// loaded the way the loader loads it (CommonJS, with its `require` intact), and
// pointed at the real folder.
//
// The real folder is READ-ONLY here, and that is enforced below: a suite that
// rewrites the operator's live configuration can leave it half-written when it
// fails, and it makes "the revision did not move while nothing changed" an
// unverifiable claim. Every case that has to WRITE runs against a temporary copy
// of the same folder, mounted through the same artifact.
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { cleanup, dshHome, scratch } from './test-support.mjs'
import { join } from 'node:path'

const HOME = dshHome()
const require = createRequire(join(HOME, 'profiles', 'web', 'cordis.patch.yml'))
// The artifact is resolved from THIS file, so the suite runs from a checkout
// anywhere — a hard-coded path would make it a machine-local script.
const artifact = new URL('./package/lib/index.cjs', import.meta.url).pathname.replace(/^\//, '')

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

/**
 * Mount the artifact with one settings document path.
 *
 * The store roots itself BESIDE `settings.yaml`, so pointing this at a temp
 * directory is what redirects every write into the copy.
 */
async function mount(documentPath) {
  const routes = []
  const listeners = new Map()
  const settings = {
    documentPath,
    register: () => { throw new Error('the file path must not register a settings namespace') },
  }
  const fakeServer = { register(route) { routes.push(route); return () => {} } }
  const ctx = {
    settings,
    llm: { listProviders: () => [], listModels: async () => [], stream: async function* () {} },
    timer: { timeout: (callback, ms) => { const handle = setTimeout(callback, ms); return () => clearTimeout(handle) } },
    get: (name) => (name === 'settings' ? settings : name === 'webServer' ? fakeServer : undefined),
    on: (event, listener) => { listeners.set(event, listener); return () => {} },
    effect: (callback) => { const disposer = callback(); return () => { if (typeof disposer === 'function') disposer() } },
    inject: (names, callback) => callback({
      webServer: fakeServer,
      get: ctx.get,
      effect: (body) => { const disposer = body(); return () => { if (typeof disposer === 'function') disposer() } },
    }),
  }
  const plugin = require(artifact)
  await plugin.apply(ctx)

  /** One HTTP round trip through the registered route. */
  async function call(method, path, body) {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
    const req = {
      method,
      url: path,
      async *[Symbol.asyncIterator]() { for (const chunk of chunks) yield chunk },
    }
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) { status = code },
      end(text) { payload = text ?? '' },
    }
    await routes[0].handler(req, res)
    return { status, body: payload === '' ? null : JSON.parse(payload) }
  }
  return { call, ctx }
}

// ── phase 1: the deployment's real folder, read only ────────────────────────

const live = await mount(join(HOME, 'settings.yaml'))
const health = (await live.call('GET', '/api/dsh-model-router/health')).body
const config = (await live.call('GET', '/api/dsh-model-router/config')).body

check('the artifact registered its configuration route',
  health?.configuration?.source, 'files')
check('and names the folder it reads', health?.configuration?.root, join(HOME, 'model-routing'))
check('it read the deployed tasks', health?.routing?.tasks, config?.config?.tasks?.length)
check('there is at least one task on disk', (health?.routing?.tasks ?? 0) > 0, true)
check('the global half came through', typeof config?.config?.enabled, 'boolean')
check('the migration found the folder already populated',
  health?.configuration?.migration, 'the folder already holds a configuration')
check('the files it reports are the files that exist',
  (health?.configuration?.files ?? []).every(name => existsSync(join(HOME, 'model-routing', name))), true)
check('and tasks live in their own folder',
  (health?.configuration?.files ?? []).filter(name => name.startsWith('tasks/')).length,
  health?.routing?.tasks)

// ── phase 2: a temporary COPY, where every write happens ────────────────────

const sandbox = scratch('wiring-')
try {
  cpSync(join(HOME, 'model-routing'), join(sandbox, 'model-routing'), { recursive: true })
  const copy = await mount(join(sandbox, 'settings.yaml'))
  const before = (await copy.call('GET', '/api/dsh-model-router/config')).body

  // A hand-edit must be visible to the next read: same file, new content.
  const target = join(sandbox, 'model-routing', 'tasks', 'general.yml')
  const original = readFileSync(target, 'utf8')
  writeFileSync(target, original.replace(/^name: .*$/m, 'name: 手改过的名字'), 'utf8')
  const after = (await copy.call('GET', '/api/dsh-model-router/config')).body
  check('a hand-edited task file is picked up',
    after?.config?.tasks?.find(task => task.id === 'general')?.name, '手改过的名字')
  check('and the revision moves with the content', after?.revision !== before?.revision, true)

  // The fence is about CONTENT. Rewriting the same bytes moves the folder's
  // mtime, and a revision derived from that would refuse a perfectly good draft
  // with "配置已被其他来源修改" for a configuration that never changed.
  writeFileSync(target, original, 'utf8')
  const restored = (await copy.call('GET', '/api/dsh-model-router/config')).body
  check('a byte-identical rewrite keeps the revision', restored?.revision, before?.revision)
  check('and the value comes back', 
    restored?.config?.tasks?.find(task => task.id === 'general')?.name,
    before?.config?.tasks?.find(task => task.id === 'general')?.name)

  // A write through the endpoint replaces the folder — and a stale revision is
  // refused, which is what keeps two editors from clobbering each other.
  const current = (await copy.call('GET', '/api/dsh-model-router/config')).body
  const again = (await copy.call('GET', '/api/dsh-model-router/config')).body
  check('an unchanged folder keeps its revision', again?.revision, current?.revision)
  const stale = (await copy.call('POST', '/api/dsh-model-router/config',
    { config: current.config, revision: (current.revision ?? 0) + 1 })).body
  check('a stale revision is refused instead of overwriting', stale?.conflict, true)
  check('and the refusal says why', /revision/.test(stale?.problems?.[0] ?? ''), true)
  const saved = (await copy.call('POST', '/api/dsh-model-router/config',
    { config: current.config, revision: current.revision })).body
  check('a current revision is accepted', saved?.ok, true)
} finally {
  cleanup(sandbox)
}

// ── phase 3: the real folder is exactly where it was ────────────────────────
//
// The guard for everything above: whatever the suite did, the DEPLOYMENT's own
// revision must not have moved. That is what "the tests never touch the live
// configuration" means in a form a machine can check.
const after = (await live.call('GET', '/api/dsh-model-router/config')).body
check('the live revision never moved while the suite ran', after?.revision, config?.revision)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
