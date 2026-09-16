/**
 * build-router.mjs — assemble the router into installable artifacts from one source.
 *
 * WHY A BUILD STEP EXISTS AT ALL
 *   The same routing code must run under four different module rules:
 *
 *     1. Node tests              — plain ESM, `import` works.
 *     2. A Host profile row      — the Cordis loader imports the row's file.
 *     3. A dynamic Cordis plugin — the Host sandbox evaluates the body inside
 *                                  `new Function` in a `node:vm` context. A
 *                                  static `import` is a syntax error, `require`
 *                                  is trapped, and — measured, not assumed —
 *                                  `import()` fails with "A dynamic import
 *                                  callback was not specified."
 *     4. The browser             — the client bundle is loaded by
 *                                  `window.__ModuleLoader__`, a CJS-like
 *                                  wrapper, not by an ESM loader.
 *
 *   Rather than maintain four copies (which would drift, and the policy is the
 *   part that must be right), each source exists once and this script
 *   concatenates it into the shapes those loaders accept. Nothing is
 *   transpiled.
 *
 * INLINED DEPENDENCIES
 *   The plugin needs a schemastery schema for `settings.register` (the settings
 *   service resolves a namespace by CALLING its schema). Both schemastery and
 *   its single dependency cosmokit ship as self-contained ESM files, so they
 *   can be inlined without a bundler — which is what lets the Host half run in
 *   the dynamic sandbox at all.
 *
 * THE HOST/CLIENT SPLIT — why a loose file is not enough
 *   A profile row names ONE module, and the Cordis loader mounts only that.
 *   The browser never sees it, so a settings page contributed by a bare row
 *   silently does not exist. `packages/client/modules` decides what reaches the
 *   browser by walking from a row's resolved module URL to the nearest
 *   `package.json` and reading its `dsh.client` declaration; a package without
 *   one is skipped, and a `dsh.client` package without an `exports["./client"]`
 *   bundle is a hard error. So the durable install is a PACKAGE, not a file:
 *
 *     dsh-model-router/
 *       package.json          declares dsh.bundle + dsh.client + exports
 *       cordis.patch.yml      the bundle's own `insert` of the host row
 *       lib/index.cjs         Host half (self-contained, schemastery inlined)
 *       lib/client.cjs        browser bundle (window.__ModuleLoader__ wrapper)
 *
 * OUTPUTS
 *   · `<workspace>/package/`                  the installable package
 *   · `dsh-model-router.dynamic.json`         `{host, client}` for cordis_define
 *   · `dsh-model-router.plugin-body.js`       exports-stripped Host body, which
 *                                             the dynamic bootstrap reads
 *
 * Run: node build-router.mjs
 */
import { readFile, writeFile, copyFile, mkdir, rm, symlink, readlink, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

const CORE = join(here, 'model-routing-config.js')
const STORE = join(here, 'model-routing-store.js')
const HOST = join(here, 'dsh-model-router.host.js')
const CLIENT = join(here, 'dsh-model-router.client.js')
const OUT_PACKAGE = join(here, 'package')
const OUT_DYNAMIC = join(here, 'dsh-model-router.dynamic.json')
const OUT_PLUGIN_BODY = join(here, 'dsh-model-router.plugin-body.js')

/** Package/plugin name. Must equal the loader row's `name` for client scan. */
const ROUTER_NAME = 'dsh-model-router'

/**
 * Services the adapter needs as HARD dependencies.
 *
 * `agentPresets` is deliberately absent: it is only mounted by deployments that
 * serve a preset picker, and a row that injects it would sit in `waiting`
 * forever elsewhere — a plugin that "mounts" yet does nothing is the worst
 * failure shape. The adapter reads it with `ctx.get()` and degrades.
 */
const INJECT = ['settings', 'llm', 'timer']

// ─────────────────────────────────────────────────────────────────────────────
// Locating and inlining dependencies
// ─────────────────────────────────────────────────────────────────────────────

/** Find a package file, preferring the deployment the harness runs from. */
function resolvePackageFile(packageName, relative) {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const candidates = []
  for (const profile of ['web', 'headless']) {
    candidates.push(join(home, 'profiles', profile, 'node_modules', packageName, relative))
    candidates.push(join(home, 'profiles', 'node_modules', packageName, relative))
  }
  try {
    const require = createRequire(join(here, 'noop.cjs'))
    candidates.push(require.resolve(`${packageName}/package.json`).replace(/package\.json$/, relative))
  } catch { /* not resolvable from this checkout */ }
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error(`build: could not locate ${packageName}/${relative};\n`
    + `  tried:\n${candidates.map(candidate => `    ${candidate}`).join('\n')}`)
}

/**
 * Strip a trailing `export { … }` statement.
 *
 * Returns two different things on purpose. `local` are names that exist as
 * bindings in this scope. `aliases` are `local -> exported` renames
 * (`export { mapValues as valueMap }`), which make `valueMap` importable but do
 * NOT create a `valueMap` binding — an inlined consumer therefore needs an
 * explicit `const valueMap = mapValues`. Conflating the two is what makes an
 * inlined bundle throw `ReferenceError`.
 */
function stripExportBlock(source, label) {
  const match = /^export\s*\{([\s\S]*?)\}\s*;?\s*$/m.exec(source)
  if (match === null) throw new Error(`build: ${label} has no trailing export block to strip`)
  const local = []
  const aliases = []
  for (const entry of match[1].split(',')) {
    const trimmed = entry.trim()
    if (trimmed.length === 0) continue
    const parts = trimmed.split(/\s+as\s+/)
    const original = parts[0].trim()
    if (original.length > 0 && !local.includes(original)) local.push(original)
    if (parts.length > 1) {
      const exported = parts[1].trim()
      if (exported.length > 0 && exported !== original && !aliases.some(pair => pair.exported === exported)) {
        aliases.push({ local: original, exported })
      }
    }
  }
  return { body: source.replace(match[0], ''), local, aliases }
}

/** Reject an `import` statement in a source that must be import-free. */
function assertImportFree(source, label) {
  const found = /^\s*import\s.+$/m.exec(source)
  if (found !== null) {
    throw new Error(`build: ${label} must not import (found "${found[0].trim()}");`
      + ' the dynamic Host sandbox has no module graph')
  }
}

/** Reject a top-level declaration that would collide with an inlined name. */
function assertNoCollision(source, names, label) {
  for (const name of names) {
    const pattern = new RegExp(`^\\s*(?:function|class|const|let|var)\\s+${name}\\b`, 'm')
    if (pattern.test(source)) {
      throw new Error(`build: ${label} declares "${name}", which an inlined dependency also exports`)
    }
  }
}

/** Build the inlined schemastery + cosmokit bundle. */
async function inlineSchemastery() {
  const cosmokitPath = resolvePackageFile('@deepseek-ai/cosmokit', 'lib/index.js')
  const schemaPath = resolvePackageFile('@deepseek-ai/schemastery', 'lib/index.mjs')
  const [cosmokitSource, schemaSource] = await Promise.all([
    readFile(cosmokitPath, 'utf8'),
    readFile(schemaPath, 'utf8'),
  ])

  const cosmokit = stripExportBlock(cosmokitSource, 'cosmokit/lib/index.js')
  const importMatch = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?\s*$/m.exec(schemaSource)
  if (importMatch === null) throw new Error('build: schemastery has no `import { … } from …` line to inline')
  const imported = importMatch[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim())
    .filter(name => name.length > 0)
  const available = [...cosmokit.local, ...cosmokit.aliases.map(pair => pair.exported)]
  const missing = imported.filter(name => !available.includes(name))
  if (missing.length > 0) {
    throw new Error(`build: schemastery imports ${missing.join(', ')} from ${importMatch[2]},`
      + ' which cosmokit does not expose')
  }
  const withoutImport = schemaSource.replace(importMatch[0], '')
  assertImportFree(withoutImport, 'schemastery/lib/index.mjs')
  assertNoCollision(withoutImport, cosmokit.local, 'schemastery/lib/index.mjs')

  const schema = stripExportBlock(withoutImport, 'schemastery/lib/index.mjs')
  if (!schema.local.includes('Schema')) {
    throw new Error(`build: schemastery export shape changed (got: ${schema.local.join(', ')})`)
  }
  return [
    `// ─── begin inlined @deepseek-ai/cosmokit (${cosmokitPath}) ───`,
    cosmokit.body.trim(),
    ...cosmokit.aliases.map(pair => `const ${pair.exported} = ${pair.local}`),
    '// ─── end inlined @deepseek-ai/cosmokit ───',
    '',
    `// ─── begin inlined @deepseek-ai/schemastery (${schemaPath}) ───`,
    schema.body.trim(),
    '// ─── end inlined @deepseek-ai/schemastery ───',
    '',
    'const z = Schema',
  ].join('\n')
}

// ─────────────────────────────────────────────────────────────────────────────
// Assembling the halves
// ─────────────────────────────────────────────────────────────────────────────

/** Strip the core's ESM wrapper; the core is Cordis- and I/O-free. */
function stripCoreExports(source) {
  return source
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+default\s+.*$/gm, '')
    .replace(/^export\s+\{[^}]*\}\s*$/gm, '')
}

/**
 * Rewrite the store's two node imports into destructuring from injected
 * bindings.
 *
 * The store is the only module that touches the filesystem, and it must stay
 * import-free once inlined: the Host half runs in two places, and only one of
 * them has a module system. The CJS form supplies real `node:fs`/`node:path` and
 * `yaml`; the dynamic sandbox has no `require` at all, so those bindings become
 * undefined and the adapter falls back to the settings namespace.
 *
 * @param source - model-routing-store.js contents.
 * @returns its body, ready to concatenate.
 */
function rewriteStoreImports(source) {
  const fs = /^import\s*\{([^}]*)\}\s*from\s*'node:fs'\s*$/m.exec(source)
  const path = /^import\s*\{([^}]*)\}\s*from\s*'node:path'\s*$/m.exec(source)
  if (fs === null || path === null) {
    throw new Error('build: model-routing-store.js must import node:fs and node:path as named imports')
  }
  return source
    // `?? {}` matters: this destructuring runs at module evaluation, and the
    // sandbox has no filesystem at all. Destructuring `undefined` would throw
    // while the plugin is being LOADED — the one failure that takes the whole row
    // down. With the fallback the bindings are merely undefined, and the store's
    // entry points are only reached when the adapter found a filesystem.
    .replace(fs[0], `const {${fs[1]}} = STORE_FS ?? {}`)
    .replace(path[0], `const {${path[1]}} = STORE_PATH ?? {}`)
}

/** Strip the client half's exports so its body can be evaluated. */function stripClientExports(source) {
  return source
    .replace(/^export\s+function\s+/gm, 'function ')
    .replace(/^export\s+const\s+/gm, 'const ')
    .replace(/^export\s+default\s+/gm, 'const __default = ')
    .trim()
}

/**
 * Top-level names the client half exports, in source order.
 * @param source - the client half's module source.
 * @returns every `export const` / `export function` name it declares.
 */
function clientExportNames(source) {
  const names = []
  for (const match of source.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)) {
    if (!names.includes(match[1])) names.push(match[1])
  }
  return names
}

const [coreSource, hostSource, clientSource, storeSource] = await Promise.all([
  readFile(CORE, 'utf8'),
  readFile(HOST, 'utf8'),
  readFile(CLIENT, 'utf8'),
  readFile(STORE, 'utf8'),
])
assertImportFree(hostSource, 'dsh-model-router.host.js')
assertImportFree(clientSource, 'dsh-model-router.client.js')
assertNoCollision(coreSource, ['z', 'Schema'], 'model-routing-config.js')
assertNoCollision(hostSource, ['z', 'Schema'], 'dsh-model-router.host.js')

const inlinedZ = await inlineSchemastery()

const banner = `/**
 * ${ROUTER_NAME} — GENERATED FILE, DO NOT EDIT.
 *
 * Assembled by build-router.mjs from:
 *   · model-routing-config.js   (the pure routing policy)
 *   · dsh-model-router.host.js  (the Cordis adapter)
 *   · @deepseek-ai/schemastery  (inlined, with its cosmokit dependency)
 *
 * Edit the sources and re-run \`node build-router.mjs\`.
 */`

const coreBody = [
  '// ─── begin inlined model-routing-config.js (generated; edit the source) ───',
  stripCoreExports(coreSource).trim(),
  '// ─── end inlined model-routing-config.js ───',
].join('\n')

/**
 * The configuration store, plus the three primitives it needs.
 *
 * `require` is reached for inside guards rather than imported: the Host half
 * also runs in the dynamic sandbox, which has no module system, so the accessor
 * throws there and the store simply stays unavailable — the adapter then falls
 * back to the settings namespace instead of failing to mount.
 */
const storeBody = [
  '// ─── begin inlined model-routing-store.js (generated; edit the source) ───',
  "const STORE_FS = (() => { try { return require('node:fs') } catch (error) { return undefined } })()",
  "const STORE_PATH = (() => { try { return require('node:path') } catch (error) { return undefined } })()",
  "const STORE_YAML = (() => { try { return require('yaml') } catch (error) { return undefined } })()",
  rewriteStoreImports(stripCoreExports(storeSource)).trim(),
  '// ─── end inlined model-routing-store.js ───',
].join('\n')

/** Host half without any module system: the dynamic sandbox form. */
const hostBody = [
  banner,
  `const ROUTER_NAME = ${JSON.stringify(ROUTER_NAME)}`,
  coreBody,
  storeBody,
  inlinedZ,
  hostSource.trim(),
  'return {',
  '  name: ROUTER_NAME,',
  `  inject: ${JSON.stringify(INJECT)},`,
  '  apply(ctx) { return mountRouter(ctx) },',
  '}',
].join('\n\n')

/** Host half as a CommonJS module: what the Cordis loader receives. */
const hostModule = [
  banner,
  `'use strict'`,
  `const ROUTER_NAME = ${JSON.stringify(ROUTER_NAME)}`,
  coreBody,
  storeBody,
  inlinedZ,
  hostSource.trim(),
  'const plugin = {',
  '  name: ROUTER_NAME,',
  `  inject: ${JSON.stringify(INJECT)},`,
  '  apply(ctx) { return mountRouter(ctx) },',
  '}',
  'module.exports = plugin',
  'module.exports.default = plugin',
].join('\n\n')

/** The dynamic client body: evaluated inside an async function. */
const clientBody = [
  banner,
  stripClientExports(clientSource),
  'return { apply }',
].join('\n\n')

/**
 * The browser bundle.
 *
 * `packages/client/modules` loads client bundles through
 * `window.__ModuleLoader__.load({ id, factory })`, where `factory(require)`
 * returns a CJS-ish module object — not an ESM module. The id must equal the
 * package name, because the loader keys bundles by it.
 */
const clientModule = [
  banner,
  `'use strict'`,
  'window.__ModuleLoader__.load({',
  `  id: ${JSON.stringify(ROUTER_NAME)},`,
  '  factory: (require) => {',
  '    var module = { exports: {} }',
  '    var exports = module.exports',
  stripClientExports(clientSource).split('\n').map(line => (line.length === 0 ? line : `    ${line}`)).join('\n'),
  '    exports.apply = apply',
  '    exports.inject = inject',
  // Re-export every top-level named binding the module declares, so a
  // `__testing` face (or any future one) reaches the module table instead of
  // being dropped by the wrapper. Derived from the source rather than
  // hardcoded: a forgotten name would otherwise fail only at the call site.
  ...clientExportNames(clientSource)
    .filter(name => name !== 'apply' && name !== 'inject')
    .map(name => `    exports.${name} = ${name}`),
  '    exports.default = module.exports',
  '    return module.exports',
  '  },',
  '})',
].join('\n')

// ─────────────────────────────────────────────────────────────────────────────
// The package
// ─────────────────────────────────────────────────────────────────────────────

const manifest = {
  name: ROUTER_NAME,
  version: '1.0.6',
  private: true,
  description: 'Task-aware model routing with global load balancing for DeepSeek Harness.',
  type: 'commonjs',
  main: './lib/index.cjs',
  // The Host half reads and writes the configuration FILES, which is why the YAML
  // parser is a real runtime dependency rather than something inlined: an install
  // resolves it normally, and the local build links the deployment's own copy in.
  dependencies: { yaml: '^2.9.0' },
  exports: {
    '.': { default: './lib/index.cjs' },
    './client': { default: './lib/client.cjs' },
    './package.json': './package.json',
  },
  dsh: {
    bundle: { patch: './cordis.patch.yml' },
    client: {
      platform: 'web',
      immediately: false,
      // Client packages this bundle needs before it loads. Mirrors
      // `dsh-better-sidebar`, whose declaration lists the slots package among
      // others: without it the bundle can be applied before the slot system
      // exists, and its registration has nowhere to go.
      inject: ['@deepseek-ai/dsh-client-ui-slots'],
      // Platform seed: ModuleLoader answers `require('react')`. The dynamic
      // Cordis sandbox still injects React as a free variable instead.
      external: ['react'],
    },
  },
}

const bundlePatch = `# ${ROUTER_NAME} bundle patch.
#
# Declared as \`dsh.bundle.patch\`, so \`dsh plugin --profile web add <this
# package>\` appends the bundle and the profile boot merges this layer. The
# insert names the package, which is what lets \`packages/client/modules\`
# resolve the row to this package.json, read \`dsh.client\`, and serve
# \`./client\` to the browser. A row pointing at a loose file would mount the
# Host half and silently contribute no settings page — that is the trap this
# shape exists to avoid.
- insert:
    - id: ${ROUTER_NAME}
      name: ${ROUTER_NAME}
`

await rm(OUT_PACKAGE, { recursive: true, force: true })
await mkdir(join(OUT_PACKAGE, 'lib'), { recursive: true })
await writeFile(join(OUT_PACKAGE, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'cordis.patch.yml'), bundlePatch, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'index.cjs'), `${hostModule}\n`, 'utf8')
await writeFile(join(OUT_PACKAGE, 'lib', 'client.cjs'), `${clientModule}\n`, 'utf8')

await writeFile(OUT_DYNAMIC, `${JSON.stringify({ host: hostBody, client: clientBody }, null, 2)}\n`, 'utf8')
await writeFile(OUT_PLUGIN_BODY, `${hostBody}\n`, 'utf8')

const lines = source => source.split('\n').length
console.log(`built ${join('package', 'lib', 'index.cjs')}   (${lines(hostModule)} lines)`)
console.log(`built ${join('package', 'lib', 'client.cjs')}  (${lines(clientModule)} lines)`)
console.log(`built ${join('package', 'package.json')}       (dsh.bundle + dsh.client)`)
console.log(`built ${join('package', 'cordis.patch.yml')}`)
console.log(`built ${OUT_DYNAMIC} (host ${lines(hostBody)} lines, client ${lines(clientBody)} lines)`)
console.log(`built ${OUT_PLUGIN_BODY} (${lines(hostBody)} lines)`)

// ─────────────────────────────────────────────────────────────────────────────
// Linking into the profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Make the package resolvable from the profile without a package-manager run.
 *
 * A directory symlink under the profile's own `node_modules` is exactly what a
 * `file:` dependency produces, and it keeps the package tree complete (the
 * client scan walks up from the module URL to this manifest). Re-running the
 * build refreshes the link, so editing a source and rebuilding is the whole
 * workflow — no reinstall step.
 */
async function linkIntoProfile() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const profile of ['web', 'headless']) {
    const dir = join(home, 'profiles', profile)
    if (!existsSync(join(dir, 'cordis.patch.yml'))) continue
    const modules = join(dir, 'node_modules')
    await mkdir(modules, { recursive: true })
    const link = join(modules, ROUTER_NAME)
    // Replace whatever is there: a stale copy would shadow this build.
    const existing = await readlink(link).catch(() => undefined)
    if (existing !== undefined) {
      if (existing === OUT_PACKAGE) return { link, fresh: false }
      await rm(link, { recursive: true, force: true })
    } else if (existsSync(link)) {
      await rm(link, { recursive: true, force: true })
    }
    await symlink(OUT_PACKAGE, link, 'junction')
    return { link, fresh: true }
  }
  return undefined
}

/**
 * Make the store's YAML parser resolvable from the built package.
 *
 * The Host half reads and writes the configuration files, so it needs a YAML
 * parser at runtime. It reaches for `require('yaml')`, which resolves from the
 * package directory — so the deployment's own copy is linked in beside the built
 * code, exactly like the package itself is linked into the profile. A published
 * install gets the same binding from a real dependency; this is the local path's
 * equivalent, and it keeps the artifact free of a 200KB inlined parser.
 */
async function linkYamlIntoPackage() {
  if (!existsSync(OUT_PACKAGE)) return undefined
  const source = join(here, 'node_modules', 'yaml')
  const vendored = existsSync(source)
    ? source
    : resolvePackageFile('yaml', 'package.json').replace(/[\\/]package\.json$/, '')
  const modules = join(OUT_PACKAGE, 'node_modules')
  await mkdir(modules, { recursive: true })
  const link = join(modules, 'yaml')
  const existing = await readlink(link).catch(() => undefined)
  const wanted = vendored.startsWith(here) ? join(OUT_PACKAGE, 'node_modules', 'yaml') : vendored
  if (existing !== undefined) {
    if (existing === wanted) return { link, fresh: false }
    await rm(link, { recursive: true, force: true })
  } else if (existsSync(link)) {
    await rm(link, { recursive: true, force: true })
  }
  await symlink(vendored, link, 'junction')
  return { link, fresh: true }
}

const linked = await linkIntoProfile()

/**
 * Install or refresh the skill that ships with this plugin.
 *
 * The skill is what lets an agent edit the configuration CORRECTLY, and it is
 * deliberately `/`-only: its frontmatter sets `disable-model-invocation: true`, so
 * it never enters the model's catalog and loads only when a human asks for it.
 * Installing it is part of installing the plugin — a package that ships a skill
 * nobody can reach is a package with a missing feature.
 *
 * A LINK, not a copy: editing the skill in this checkout then updates what the
 * harness reads, exactly like the plugin package itself.
 */
async function linkSkillsIntoHome() {
  const source = join(here, 'skills')
  if (!existsSync(source)) return undefined
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const root = join(home, 'skills')
  await mkdir(root, { recursive: true })
  const installed = []
  for (const name of await readdir(source)) {
    const from = join(source, name)
    if (!existsSync(join(from, 'SKILL.md'))) continue
    const link = join(root, name)
    const existing = await readlink(link).catch(() => undefined)
    if (existing !== undefined) {
      if (existing === from) { installed.push({ name, fresh: false }); continue }
      await rm(link, { recursive: true, force: true })
    } else if (existsSync(link)) {
      await rm(link, { recursive: true, force: true })
    }
    await symlink(from, link, 'junction')
    installed.push({ name, fresh: true })
  }
  return { root, installed }
}

const skills = await linkSkillsIntoHome()
for (const skill of skills?.installed ?? []) {
  console.log(`${skill.fresh ? 'installed' : 'already installed'} skill ${skill.name} -> ${join(skills.root, skill.name)}`)
}

const yamlLink = await linkYamlIntoPackage()
if (yamlLink !== undefined) {
  console.log(`${yamlLink.fresh ? 'linked' : 'already linked'} ${yamlLink.link} (yaml, for the configuration files)`)
}
if (linked === undefined) {
  console.log('no profile with a cordis.patch.yml found; link package/ into a profile yourself')
} else {
  console.log(`${linked.fresh ? 'linked' : 'already linked'} ${linked.link} -> ${OUT_PACKAGE}`)
  console.log('')
  console.log('Next (once per profile):')
  console.log('  1. add the row to the profile patch (name: ' + ROUTER_NAME + '), or install the bundle:')
  console.log('       dsh plugin --profile web add ./package')
  console.log('  2. restart dsh web')
}
void copyFile
