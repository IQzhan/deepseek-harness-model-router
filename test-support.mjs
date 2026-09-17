// Shared plumbing for the suites: where scratch data goes, and where DSH lives.
//
// Two rules this module exists to keep, both machine-checked by the portability
// guard (`test-portability.mjs`):
//
//   1. Scratch data lives INSIDE the checkout (`.tmp/`), never the system temp
//      directory. A suite that defers to the system temp directory writes to whatever
//      drive the OS picks — on Windows that is usually `C:`, which is exactly the
//      drive a checkout on another volume must not touch — and leaves files behind
//      when it fails halfway.
//   2. The harness home is RESOLVED (`DSH_HOME`, else the user's `~/.dsh`), never
//      spelled out. A hard-coded drive-letter fallback works on exactly one machine.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The checkout this file lives in. */
export const ROOT = dirname(fileURLToPath(import.meta.url))

/** Scratch space inside the checkout. */
export const SCRATCH = join(ROOT, '.tmp')

/**
 * A fresh scratch directory inside the checkout.
 * @param prefix - a name that says which suite owns it.
 * @returns its absolute path; remove it with `cleanup()`.
 */
export function scratch(prefix) {
  mkdirSync(SCRATCH, { recursive: true })
  return mkdtempSync(join(SCRATCH, prefix))
}

/** Remove a scratch directory, ignoring the "already gone" case. */
export function cleanup(path) {
  if (path === undefined) return
  rmSync(path, { recursive: true, force: true })
}

/**
 * The harness home the deployment uses.
 *
 * `DSH_HOME` when set, otherwise the documented default. Nothing here may point at
 * a specific machine: the suites run on a user's checkout, not on the one this
 * plugin was written on.
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
