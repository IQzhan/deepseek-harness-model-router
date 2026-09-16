// Read one session log: the ground truth for "which model actually served a turn".
//
// A session log is `session.v3.jsonl.zstd` — a CONCATENATED sequence of zstd
// frames, one per append. The stock decoders stop at the first frame, so the
// magic number is used to split the buffer and each frame is decompressed on its
// own. Not part of the plugin: this is the tool used to VERIFY the plugin from
// outside, which is the only way to check routing without trusting the plugin's
// own report.
//
//   node session-peek.mjs <session-id | path> [--routes] [--types] [--tail N] [--grep TEXT]
//
//   --routes   one line per route-relevant record: the inherited route, the
//              spliced opener, the header the turn RAN on, and how it ended
//   --types    the record types present, so a schema is discovered and not guessed
//   --tail N   only the last N matching lines (default 20)
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

function splitFrames(buffer) {
  const offsets = []
  let at = buffer.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + 1)
  }
  if (offsets.length === 0) return []
  return offsets.map((start, index) => buffer.subarray(start, offsets[index + 1] ?? buffer.length))
}

function readLog(target) {
  const path = target.endsWith('.zstd') ? target : resolve(target)
  const frames = splitFrames(readFileSync(path))
  const lines = []
  for (const frame of frames) {
    let text
    try {
      text = zstdDecompressSync(frame).toString('utf8')
    } catch {
      continue // a truncated final frame is normal while a session is live
    }
    for (const line of text.split('\n')) if (line.trim().length > 0) lines.push(line)
  }
  return { path, lines }
}

/**
 * The session folder of the CURRENT workspace.
 *
 * Derived from the working directory, because a session root is laid out as
 * `<DSH_HOME>/sessions/--<workspace path, separators as dashes>--/`. Nothing
 * here may be machine-specific: `DSH_HOME` or `DSH_SESSION_ROOT` can point the
 * reader somewhere else entirely.
 */
function workspaceDir() {
  const root = process.env.DSH_SESSION_ROOT ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')
  const exact = `--${process.cwd().replace(/:/gu, '').replace(/[\\/]/gu, '-')}--`
  const entries = readdirSync(root)
  if (entries.includes(exact)) return join(root, exact)
  const tail = basename(process.cwd())
  const match = entries.find(entry => entry.includes(tail))
  if (match === undefined) {
    throw new Error(`no session folder for ${JSON.stringify(process.cwd())} under ${root}`)
  }
  return join(root, match)
}

function resolve(name) {
  const base = workspaceDir()
  const direct = join(base, name)
  try {
    if (statSync(direct).isDirectory()) return join(direct, 'session.v3.jsonl.zstd')
  } catch { /* fall through to the prefix search */ }
  const match = readdirSync(base).find(entry => entry.startsWith(name))
  if (match === undefined) throw new Error(`no session matching ${JSON.stringify(name)} under ${base}`)
  return join(base, match, 'session.v3.jsonl.zstd')
}

const [target, ...rest] = process.argv.slice(2)
if (target === undefined) {
  console.error('usage: node session-peek.mjs <session-id|path> [--routes] [--tail N] [--grep TEXT]')
  process.exit(2)
}
const flag = (name, fallback) => {
  const index = rest.indexOf(`--${name}`)
  return index === -1 ? fallback : rest[index + 1]
}
const wantRoutes = rest.includes('--routes')
const tail = Number(flag('tail', 20))
const grep = flag('grep', undefined)

const { path, lines } = readLog(target)
const records = []
for (const line of lines) {
  try {
    records.push(JSON.parse(line))
  } catch { /* a torn line: skip it, never fail the read */ }
}

/** The provider/model a request record was answered with. */
function routeOf(record) {
  // `request/header` keeps the assembled header under `data.header`; other
  // records may carry a header or a bare config. All three shapes are read
  // because this is the ONLY place a log states the route a turn really ran on.
  const data = record?.data ?? {}
  const header = data.header ?? record?.header ?? record?.requestHeader ?? data ?? record?.config
  const config = header?.config ?? header
  if (config?.provider === undefined && config?.model === undefined) return undefined
  return {
    provider: config.provider ?? null,
    model: config.model ?? null,
    effort: config.reasoningEffort ?? record?.reasoningEffort ?? null,
  }
}

/**
 * One line per ROUTE-RELEVANT record.
 *
 * A session log carries no per-request header, so the route a child actually ran
 * on is read from three places instead: the descriptor (the route the child
 * INHERITED), the spliced opener (which task the parent asked for — the marker
 * the router reads), and the turn's end reason (a routed model that refuses the
 * inherited reasoning effort names itself in the error).
 */
function summarise(record) {
  const data = record?.data ?? {}
  if (record?.type === 'subagent/descriptor') {
    return `descriptor inherited ${data.agentProvider}/${data.agentModel}`
      + ` effort=${data.agentReasoningEffort} label=${JSON.stringify(data.label ?? '')}`
  }
  if (record?.type === 'subagent/model-selection-policy') {
    const models = (data.allowedModels ?? []).map(entry => `${entry.provider}/${entry.model}`)
    return `model-policy allowed=${models.length} ${models.slice(0, 4).join(' ')}${models.length > 4 ? ' …' : ''}`
  }
  if (record?.type === 'agent/inbox/spliced' && Array.isArray(data.inserted) && data.inserted.length > 0) {
    const text = (data.inserted[0].content ?? [])
      .map(block => block?.text ?? '').join(' ').replace(/\s+/gu, ' ').trim()
    return `opener ${JSON.stringify(text.slice(0, 160))}`
  }
  if (record?.type === 'turn/end') {
    const reason = data.reason ?? {}
    const error = reason.error ?? reason
    return `turn ${data.turn} ended kind=${reason.kind ?? '?'}`
      + (error?.message === undefined ? '' : ` :: ${error.message}`)
  }
  const route = routeOf(record)
  if (route !== undefined) return `${record.type} RAN ${route.provider}/${route.model} effort=${route.effort}`
  return undefined
}

/** Distinct record types with counts, so a new schema is discovered, not guessed. */
function typeCounts(records) {
  const counts = new Map()
  for (const record of records) counts.set(record.type, (counts.get(record.type) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${type} x${count}`)
}

const out = []
if (wantRoutes) {
  for (const record of records) {
    const line = summarise(record)
    if (line !== undefined) out.push(line)
  }
} else {
  for (const record of records) out.push(JSON.stringify(record))
}
const filtered = grep === undefined ? out : out.filter(line => line.includes(grep))
if (rest.includes('--types')) {
  console.log(`${path}: ${records.length} records`)
  for (const line of typeCounts(records)) console.log(`  ${line}`)
}
console.log(`${path}: ${records.length} records, ${filtered.length} shown`)
for (const line of filtered.slice(-tail)) console.log(line.slice(0, 400))
