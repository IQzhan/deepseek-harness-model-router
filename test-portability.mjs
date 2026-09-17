// Portability guard: this plugin must run on any machine, so nothing shipped may
// assume THIS one.
//
// Written as a test rather than a review habit because the failures are silent: a
// drive-letter fallback, a Windows-only symlink type or a write to the system temp
// directory all work perfectly on the machine they were written on. Each rule below
// was a real finding in this repository:
//
//   · `test-store.mjs` resolved the harness home with a hard-coded `E:\Workspace\.dsh`
//     fallback — correct on exactly one machine;
//   · the build passed `'junction'` to `symlink()`, which POSIX rejects with EINVAL,
//     so a macOS or Linux user could not build at all;
//   · two suites wrote their scratch directories to `os.tmpdir()`, which on Windows
//     is usually `C:` — a drive a checkout elsewhere must not touch;
//   · the generated artifacts embedded the machine's `node_modules` path in their
//     "inlined …" banners.
//
// The only Windows coupling that is allowed is the TEST ENTRY POINT (`verify.ps1`,
// `verify-live.ps1`), because PowerShell is how this checkout is driven; every file
// that ships or that the plugin loads at runtime must be platform-neutral.
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './test-support.mjs'

const results = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

/** Every file that either ships, runs at runtime, or runs as a test. */
function shippedFiles() {
  const named = [
    'dsh-model-router.host.js', 'dsh-model-router.client.js',
    'model-routing-config.js', 'model-routing-store.js',
    'build-router.mjs', 'run-tests.mjs', 'package.json', 'README.md', 'README.zh.md',
    'LICENSE', 'test-support.mjs', 'session-peek.mjs',
  ]
  const files = named.filter(name => existsSync(join(ROOT, name))).map(name => join(ROOT, name))
  for (const entry of readdirSync(ROOT)) {
    if (entry.startsWith('test-') && entry.endsWith('.mjs')) files.push(join(ROOT, entry))
  }
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else files.push(full)
    }
  }
  for (const dir of ['skills', 'docs']) {
    if (existsSync(join(ROOT, dir))) walk(join(ROOT, dir))
  }
  // The GENERATED artifacts are what the deployment actually loads, so they are
  // checked too — they are the ones that embedded a machine path.
  for (const artifact of ['package/lib/index.cjs', 'package/lib/client.cjs',
    'package/package.json', 'package/cordis.patch.yml']) {
    if (existsSync(join(ROOT, artifact))) files.push(join(ROOT, artifact))
  }
  return [...new Set(files)]
}

const files = shippedFiles()
check('the guard actually looks at the shipped files', files.length > 10, true)

/**
 * A drive-letter path with at least two real segments: `E:\Workspace\.dsh`,
 * `E:/Workspace/.dsh`.
 *
 * The "two real segments" part is what keeps JavaScript regex literals out:
 * `[task:\s*([a-z0-9-]+)\s*]` contains `k:\` and is not a path. A guard that cries
 * wolf on every `\s` gets switched off, and a switched-off guard protects nothing.
 */
const WINDOWS_PATH = /[A-Za-z]:\\[A-Za-z0-9_.\- ]+(?:\\[A-Za-z0-9_.\- ]+)+|[A-Za-z]:\/(?!\/)[A-Za-z0-9_.\- ]+(?:\/[A-Za-z0-9_.\- ]+)+/
/** POSIX home and temp roots, which only exist on machines that have them. */
const POSIX_PATH = /\/(?:Users|home|tmp|var\/folders)\//

const pathOffenders = []
const windowsOffenders = []
const tempOffenders = []
for (const file of files) {
  const name = file.slice(ROOT.length + 1)
  if (name.endsWith('test-portability.mjs')) continue
  const text = readFileSync(file, 'utf8')
  text.split('\n').forEach((line, index) => {
    if (WINDOWS_PATH.test(line) || POSIX_PATH.test(line)) pathOffenders.push(`${name}:${index + 1}`)
    // `os.tmpdir()` puts scratch data on whatever drive the OS picks.
    if (/\btmpdir\s*\(/.test(line) || /process\.env\.USERPROFILE/.test(line)) tempOffenders.push(`${name}:${index + 1}`)
    // A symlink type is platform-specific; it may appear only beside a platform check.
    if (/'junction'/.test(line) && !/process\.platform/.test(line)) windowsOffenders.push(`${name}:${index + 1}`)
  })
}

check('no absolute path from any machine', pathOffenders, [])
check('no system temp directory and no Windows-only home variable', tempOffenders, [])
check('no platform-specific symlink type outside a platform switch', windowsOffenders, [])

// The build must reach for the right link type on both platforms.
const build = readFileSync(join(ROOT, 'build-router.mjs'), 'utf8')
check('the build chooses its link type per platform',
  /process\.platform === 'win32' \? 'junction' : 'dir'/.test(build), true)

// A licence is what makes the repository usable by others at all.
const licence = readFileSync(join(ROOT, 'LICENSE'), 'utf8')
check('the licence is MIT', licence.startsWith('MIT License'), true)
check('and it is in English', /[\u4e00-\u9fff]/.test(licence), false)

// A test entry point may be PowerShell (this checkout is driven that way) — nothing
// else may require it.
const powerShellUsers = files
  .map(file => file.slice(ROOT.length + 1))
  .filter(name => name.endsWith('.ps1'))
check('PowerShell appears only as a test entry point',
  powerShellUsers.every(name => name === 'verify.ps1' || name === 'verify-live.ps1'), true)

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed`)
process.exit(failed.length > 0 ? 1 : 0)
