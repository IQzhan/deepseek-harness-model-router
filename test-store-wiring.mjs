// Does the BUILT Host half actually read the configuration folder?
//
// The store suite proves the reader/writer against real files, and the Host suite
// proves the fallback path. Neither answers the question that matters here: when a
// folder exists, does the deployed artifact use it? That needs the real artifact,
// loaded the way the loader loads it (CommonJS, with its `require` intact), and
// pointed at the real folder.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const require = createRequire(join(HOME, 'profiles', 'web', 'cordis.patch.yml'))
// The artifact is resolved from THIS file, so the suite runs from a checkout
// anywhere — a hard-coded path would make it a machine-local script.
const plugin = require(new URL('./package/lib/index.cjs', import.meta.url).pathname.replace(/^\//, ''))

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

const routes = []
const settings = {
  documentPath: join(HOME, 'settings.yaml'),
  register: () => { throw new Error('the file path must not register a settings namespace') },
}
const listeners = new Map()
const fakeServer = {
  register(route) { routes.push(route); return () => {} },
}
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
await plugin.apply(ctx)

check('the artifact registered its configuration route',
  routes.map(route => route.path), ['/api/dsh-model-router'])

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

const health = (await call('GET', '/api/dsh-model-router/health')).body
const config = (await call('GET', '/api/dsh-model-router/config')).body

check('the artifact reports the file source', health?.configuration?.source, 'files')
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

// A hand-edit must be visible to the next read: same file, new content.
const target = join(HOME, 'model-routing', 'tasks', 'general.yml')
const original = readFileSync(target, 'utf8')
try {
  writeFileSync(target, original.replace(/^name: .*$/m, 'name: 手改过的名字'), 'utf8')
  const after = (await call('GET', '/api/dsh-model-router/config')).body
  check('a hand-edited task file is picked up',
    after?.config?.tasks?.find(task => task.id === 'general')?.name, '手改过的名字')
} finally {
  writeFileSync(target, original, 'utf8')
}

// A write through the endpoint replaces the folder — and a stale revision is
// refused, which is what keeps two editors from clobbering each other.
const current = (await call('GET', '/api/dsh-model-router/config')).body
const again = (await call('GET', '/api/dsh-model-router/config')).body
check('an unchanged folder keeps its revision', again?.revision, current?.revision)
const stale = (await call('POST', '/api/dsh-model-router/config',
  { config: current.config, revision: (current.revision ?? 0) + 1 })).body
check('a stale revision is refused instead of overwriting', stale?.conflict, true)
check('and the refusal says why', /revision/.test(stale?.problems?.[0] ?? ''), true)
const saved = (await call('POST', '/api/dsh-model-router/config',
  { config: current.config, revision: current.revision })).body
check('a current revision is accepted', saved?.ok, true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
