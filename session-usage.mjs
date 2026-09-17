// Where did the tokens go? Session logs are the only usage record a deployment keeps:
// every `assistant/message` carries `usage` and the model that produced it, so spend can
// be attributed to a conversation, a model and a workspace. Written after a real
// investigation into one model's quota disappearing — the answer was a single delegated
// session whose one turn ran 438 steps, all of them on the model the rotation had handed
// it because the plugin pins ONE model per turn (that pin is deliberate: it keeps the
// prompt prefix cached).
//
//   node session-usage.mjs                      # totals per model, all sessions
//   node session-usage.mjs --model dashscope/qwen3.7-flash-2026-07-15
//                                               # which sessions used it, biggest first
//   node session-usage.mjs --session f2b1bee0   # per-turn breakdown of one session
//
// The CLASSIFIER is the one consumer this cannot see: it runs as a nested call with no
// session, so it appears in no log. It is bounded instead — at most `maxInputTokens` read
// and a few hundred written per call, at most once per turn — which is why it is never
// the answer to "what burned the quota" unless the router is running on a loop.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const ROOT = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

/**
 * Every record of one session log.
 *
 * The file is a CONCATENATED sequence of zstd frames, one per append, and the stock
 * decoders stop at the first — so the magic number is used to split it.
 */
function recordsOf(file) {
  let buffer
  try {
    buffer = readFileSync(file)
  } catch {
    return []
  }
  const offsets = []
  let at = buffer.indexOf(MAGIC)
  while (at !== -1) {
    offsets.push(at)
    at = buffer.indexOf(MAGIC, at + 1)
  }
  const records = []
  offsets
    .map((start, index) => buffer.subarray(start, offsets[index + 1] ?? buffer.length))
    .forEach((frame) => {
      let text
      try {
        text = zstdDecompressSync(frame).toString('utf8')
      } catch {
        return // a truncated final frame is normal while a session is live
      }
      for (const line of text.split('\n')) {
        if (line.trim().length === 0) continue
        try {
          records.push(JSON.parse(line))
        } catch { /* a torn line at the tail */ }
      }
    })
  return records
}

/** Every session log under the harness home, with the workspace it belongs to. */
function sessions() {
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(ROOT)
  } catch {
    return out
  }
  for (const workspace of workspaces) {
    const base = join(ROOT, workspace)
    let ids = []
    try {
      ids = readdirSync(base)
    } catch {
      continue
    }
    for (const id of ids) {
      const file = join(base, id, 'session.v3.jsonl.zstd')
      try {
        if (statSync(file).isFile()) out.push({ workspace, id, file })
      } catch { /* not a session directory */ }
    }
  }
  return out
}

/** One session's usage, split per model and per turn. */
function usageOf(entry) {
  const records = recordsOf(entry.file)
  const head = records.find(record => record.type === 'session')
  const perModel = new Map()
  const perTurn = new Map()
  for (const record of records) {
    if (record.type !== 'assistant/message') continue
    const usage = record.data?.usage
    const source = record.data?.message?.source
    if (usage === undefined || source === undefined) continue
    const model = `${source.provider}/${source.model}`
    const add = (map, key) => {
      const bucket = map.get(key) ?? { steps: 0, input: 0, output: 0, cacheRead: 0, total: 0 }
      bucket.steps += 1
      bucket.input += usage.inputTokens ?? 0
      bucket.output += usage.outputTokens ?? 0
      bucket.cacheRead += usage.cacheReadTokens ?? 0
      bucket.total += usage.totalTokens ?? 0
      map.set(key, bucket)
      return bucket
    }
    add(perModel, model)
    const turn = add(perTurn, `${record.data?.turn ?? '?'}\u0000${model}`)
    turn.firstAt = turn.firstAt ?? record.time
    turn.lastAt = record.time
  }
  return {
    ...entry,
    head: head ?? {},
    title: records.find(record => record.type === 'session/title')?.data?.title ?? '',
    perModel,
    perTurn,
    records: records.length,
  }
}

const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? undefined : process.argv[index + 1]
}

const all = sessions().map(usageOf).filter(entry => entry.head.createdAt !== undefined)
const modelFilter = arg('model')
const sessionFilter = arg('session')

if (sessionFilter !== undefined) {
  const target = all.find(entry => entry.id.startsWith(sessionFilter))
  if (target === undefined) {
    console.log(`no session matching ${JSON.stringify(sessionFilter)}`)
    process.exitCode = 1
  } else {
    console.log(`${target.id}  ${JSON.stringify(String(target.title).slice(0, 70))}\n`)
    console.log('turn  steps  model                                      input      output     cacheRead        total')
    for (const [key, bucket] of [...target.perTurn].sort((a, b) => Number(a[0].split('\u0000')[0]) - Number(b[0].split('\u0000')[0]))) {
      const [turn, model] = key.split('\u0000')
      console.log(`${turn.padStart(4)}  ${String(bucket.steps).padStart(5)}  ${model.padEnd(40)} ${String(bucket.input).padStart(9)} ${String(bucket.output).padStart(11)} ${String(bucket.cacheRead).padStart(13)} ${String(bucket.total).padStart(12)}`)
    }
  }
} else if (modelFilter !== undefined) {
  const rows = all
    .map(entry => ({ entry, bucket: entry.perModel.get(modelFilter) }))
    .filter(row => row.bucket !== undefined)
    .sort((a, b) => b.bucket.total - a.bucket.total)
  const total = rows.reduce((sum, row) => sum + row.bucket.total, 0)
  console.log(`${modelFilter}: ${total} tokens across ${rows.length} sessions\n`)
  for (const row of rows) {
    const share = total === 0 ? 0 : Math.round((row.bucket.total / total) * 1000) / 10
    console.log(`  ${String(row.bucket.total).padStart(11)}  ${String(share).padStart(5)}%  steps=${String(row.bucket.steps).padStart(4)}  ${row.entry.id}`)
    console.log(`      ${JSON.stringify(String(row.entry.title).slice(0, 88))}`)
  }
  if (rows.length > 0) console.log(`\nrun with --session <id> for the per-turn breakdown of any of them`)
} else {
  const perModel = new Map()
  for (const entry of all) {
    for (const [model, bucket] of entry.perModel) {
      const all2 = perModel.get(model) ?? { steps: 0, input: 0, output: 0, cacheRead: 0, total: 0, sessions: 0 }
      all2.steps += bucket.steps
      all2.input += bucket.input
      all2.output += bucket.output
      all2.cacheRead += bucket.cacheRead
      all2.total += bucket.total
      all2.sessions += 1
      perModel.set(model, all2)
    }
  }
  console.log(`${all.length} sessions\n`)
  console.log('model                                      steps      input     output     cacheRead        total  sessions')
  for (const [model, bucket] of [...perModel].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`${model.padEnd(40)} ${String(bucket.steps).padStart(6)} ${String(bucket.input).padStart(10)} ${String(bucket.output).padStart(10)} ${String(bucket.cacheRead).padStart(13)} ${String(bucket.total).padStart(12)} ${String(bucket.sessions).padStart(9)}`)
  }
}
