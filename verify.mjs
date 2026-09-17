// Cross-platform test entry point: build, then run every offline suite.
//
// `verify.ps1` is the same thing for PowerShell users; this one exists so a macOS or
// Linux checkout has an entry point that needs nothing but Node.
import { spawnSync } from 'node:child_process'

for (const step of ['build-router.mjs', 'run-tests.mjs']) {
  const run = spawnSync(process.execPath, [step], { stdio: 'inherit' })
  if (run.status !== 0) process.exit(run.status ?? 1)
}