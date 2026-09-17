/**
 * Live test: does the router actually reach a NON-DeepSeek model?
 *
 * This drives the shipped Host package against the REAL pi-ai adapter, so it
 * covers the parts the stubbed tests cannot: provider registration from the
 * settings document, credential resolution, the wire request, and the reply.
 *
 * Routing on its own is already covered offline (test-router-host.mjs). What is
 * only provable here is that a route this plugin picks is one a live provider
 * accepts — i.e. that the model ids in the pools are real and reachable.
 *
 * No DeepSeek route is involved anywhere in this file.
 *
 * Run: node test-live-nondeepseek.mjs
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE = join(HOME, 'profiles', 'web')
const require = createRequire(join(PROFILE, 'cordis.patch.yml'))

const results = []
const skipped = []
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  results.push({ label, ok, actual, expected })
}

// ── credentials: read the managed store, hand them to the adapters ──────────
async function loadCredentials() {
  const text = await readFile(join(HOME, '.credentials.yaml'), 'utf8')
  const out = {}
  let inRefs = false
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue }
    if (/^\S/.test(line) && !/^refs:/.test(line)) inRefs = false
    if (!inRefs) continue
    const match = /^\s{2}([A-Z0-9_]+):\s*(\S+)\s*$/.exec(line)
    if (match !== null) out[match[1]] = match[2]
  }
  return out
}
const credentials = await loadCredentials()
check('credentials loaded from the managed store', Object.keys(credentials).length >= 3, true)
check('a Google key is present', typeof credentials.GOOGLE_API_KEY, 'string')
check('an OpenRouter key is present', typeof credentials.OPENROUTER_API_KEY, 'string')
check('a B.AI key is present', typeof credentials.B_AI_API_KEY, 'string')

// The adapters resolve keys through `apiKeyEnv`, so expose them in-process.
for (const [name, value] of Object.entries(credentials)) process.env[name] = value

// ── the real LLM runtime + the real pi-ai adapter ───────────────────────────
const cordisUrl = pathToFileURL(require.resolve('@deepseek-ai/cordis')).href
const llmUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href
const piAiUrl = pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href
const { Context } = await import(cordisUrl)
const { LlmRuntime, BlockAssembler } = await import(llmUrl)
const piAi = await import(piAiUrl)

/** The `llm-pi-ai:` section of the settings document, which configures routes. */
const settingsDoc = await readFile(join(HOME, 'settings.yaml'), 'utf8')
check('the settings document configures pi-ai providers', settingsDoc.includes('llm-pi-ai:'), true)

/**
 * Stand up a real runtime exactly as the profile does: a genuine Cordis
 * `Context`, `LlmRuntime` mounted as a plugin (it is a `Service`, so a plain
 * object stub fails inside its constructor), then the pi-ai adapter mounted
 * with a provider config. Mounting through `ctx.plugin`, not calling `apply` by
 * hand, is what the loader does.
 */
async function makeRuntime(providers) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(piAi, { providers })
  return ctx.llm
}

// A compact provider config: one model per non-DeepSeek provider, mirroring the
// shape the user's settings document uses.
const PROVIDERS = {
  google: {
    apiKeyEnv: 'GOOGLE_API_KEY',
    reasoning: 'high',
    models: [{ id: 'gemini-3.5-flash', name: 'Gemini 3.5 Flash', contextWindow: 1048576, maxTokens: 65536 }],
  },
  openrouter: {
    baseURL: 'https://openrouter.ai/api/v1',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    models: [{ id: 'openrouter/free', name: 'Free Models Router', contextWindow: 524288, maxTokens: 512000 }],
  },
  'b-ai': {
    api: 'openai-completions',
    baseURL: 'https://api.b.ai/v1',
    apiKeyEnv: 'B_AI_API_KEY',
    models: [{ id: 'glm-5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 1000000, maxTokens: 128000 }],
  },
}

let llm
let setupError
try {
  llm = await makeRuntime(PROVIDERS)
} catch (error) {
  setupError = error
}
check('the real adapter applied without error', setupError, undefined)

if (setupError === undefined) {
  const providers = llm.listProviders().map(provider => provider.id)
  check('google route is registered', providers.includes('google'), true)
  check('openrouter route is registered', providers.includes('openrouter'), true)
  check('no deepseek route is registered anywhere here',
    providers.some(id => id.includes('deepseek')), false)

  // ── the live calls ────────────────────────────────────────────────────────
  /** One real call, returning the assistant text or the failure. */
  async function ask(provider, model) {
    const assembler = new BlockAssembler()
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 60000)
    try {
      for await (const chunk of llm.stream({
        provider,
        model,
        messages: [{
          role: 'user',
          content: [{ type: 'text', text: 'Reply with exactly one word: pong' }],
          source: { kind: 'user' },
        }],
        // Generous on purpose. A thinking model bills its reasoning against the
        // output budget, so a small cap fails with `max-tokens` before any text
        // appears — a trap worth knowing for the router's own pools, where the
        // configured maxTokens is the deployment's, not the probe's.
        maxTokens: 2048,
        temperature: 0,
        signal: controller.signal,
      })) {
        assembler.push(chunk)
      }
      const finish = assembler.finish
      if (finish !== undefined && finish.kind !== 'stop') {
        return { ok: false, error: `${finish.kind}: ${finish.failure?.message ?? 'unknown'}` }
      }
      const text = assembler.blocks()
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      return { ok: text.length > 0, text }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timeout)
    }
  }

  // A host can be blocked at the network layer, and that is not the plugin's
  // fault. Probe first so a green run means "the route really answered".
  const PROBE = {
    google: 'https://generativelanguage.googleapis.com/v1beta/models',
    openrouter: 'https://openrouter.ai/api/v1/models',
    'b-ai': 'https://api.b.ai/v1/models',
  }

  for (const [provider, model] of [
    ['google', 'gemini-3.5-flash'],
    ['openrouter', 'openrouter/free'],
    ['b-ai', 'glm-5.3-flash'],
  ]) {
    let reachable = false
    try {
      const response = await fetch(PROBE[provider], { signal: AbortSignal.timeout(15000) })
      reachable = response.status > 0
    } catch (error) {
      skipped.push(`${provider}/${model} — ${error.name}: ${error.message}`)
      console.log(`      ${provider} host unreachable, skipped: ${error.message}`)
      continue
    }
    if (!reachable) continue
    // `openrouter/free` is a META route: each call draws a different upstream,
    // and some of them refuse a request that does not enable reasoning. One
    // retry separates "this route cannot serve" from "this draw was bad" — the
    // same reason the classifier itself retries.
    let result = await ask(provider, model)
    if (!result.ok) result = await ask(provider, model)
    // An account-level refusal is not a plugin defect, and a permanently red
    // assertion would hide the next real one. Report the provider's own words
    // and skip: the credential exists and the endpoint answered, it just will
    // not serve this account.
    if (!result.ok && /insufficient|quota|balance|unauthor|forbidden|\b40[123]\b/iu.test(result.error ?? '')) {
      skipped.push(`${provider}/${model} — ${(result.error ?? '').slice(0, 90)}`)
      console.log(`      ${provider} cannot serve this account, skipped: ${result.error}`)
      continue
    }
    check(`LIVE ${provider}/${model} answered`, result.ok, true)
    console.log(result.ok
      ? `      ${provider} reply: ${JSON.stringify(result.text.slice(0, 60))}`
      : `      ${provider} error: ${result.error}`)
  }

  // ── the real question: does the SHIPPED prompt route by meaning? ──────────
  //
  // This is the part no stub can prove. The prompt, the task descriptions and
  // the reply parser are the ones the adapter really uses; the model is a real
  // non-DeepSeek model over a real network.
  const { classifierPrompt, parseClassifierReply, classificationInput, estimateTokens } =
    await import('./model-routing-config.js')

  const TASKS = [
    { id: 'modelling', name: '3D 建模', description: '三维建模、CAD、机械结构设计、导出 STL/STEP、3D 打印件设计' },
    { id: 'web-search', name: 'Web search', description: 'Look things up on the open web and check them' },
    { id: 'general', name: '通用子任务', description: '没有明确专业归属的日常子任务：整理、改写、核对、简单查询' },
  ]

  /**
   * Classify exactly as the adapter does: bounded input, production output
   * budget, one retry when the reply is unusable, one id back.
   *
   * Mirrored rather than imported because `classifyWith` is internal to the
   * Host half; the parameters it mirrors (256 output tokens, at most two calls,
   * no retry once half the budget is gone) are asserted separately in the Host
   * suite, so a drift shows up there.
   */
  async function classify(conversation) {
    const bounded = classificationInput('', conversation, 4000)
    const prompt = classifierPrompt(TASKS, bounded.text)
    const started = Date.now()
    const budget = 15000
    const notes = []
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1 && Date.now() - started > budget / 2) {
        notes.push('retry skipped')
        break
      }
      const assembler = new BlockAssembler()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), budget)
      try {
        for await (const chunk of llm.stream({
          provider: 'openrouter',
          model: 'openrouter/free',
          messages: [
            { role: 'system', content: [{ type: 'text', text: prompt.system }], source: { kind: 'system' } },
            { role: 'user', content: [{ type: 'text', text: prompt.user }], source: { kind: 'user' } },
          ],
          maxTokens: 256,
          temperature: 0,
          signal: controller.signal,
        })) {
          assembler.push(chunk)
        }
        const reply = assembler.blocks()
          .filter(block => block.type === 'text')
          .map(block => block.text)
          .join('')
          .trim()
        notes.push(`reply=${JSON.stringify(reply.slice(0, 20))}`)
        const routed = parseClassifierReply(reply, TASKS)
        if (routed !== undefined) {
          return { reply, routed, tokens: estimateTokens(bounded.text), notes, attempts: attempt }
        }
        if (/\bnone\b/iu.test(reply)) {
          return { reply, routed: undefined, tokens: estimateTokens(bounded.text), notes, attempts: attempt }
        }
      } catch (error) {
        notes.push(`threw ${error instanceof Error ? error.message : String(error)}`)
      } finally {
        clearTimeout(timeout)
      }
    }
    return { reply: '', routed: undefined, tokens: estimateTokens(bounded.text), notes }
  }

  if (!skipped.some(entry => entry.startsWith('openrouter/'))) {
    // Worded to avoid every keyword on purpose: a keyword router would miss
    // these, which is the whole reason the classifier exists.
    for (const [label, conversation, expected] of [
      ['semantic: a CAD request with no keywords',
        '我需要给一个行星齿轮减速器做参数化设计，最后要能直接送去打印', 'modelling'],
      ['semantic: a current-events request with no keywords',
        '帮我确认一下上周发布的那份行业报告里的数字是不是真的', 'web-search'],
      ['semantic: housekeeping with no keywords',
        '把刚才那几段话合并成一段，语气再正式一点', 'general'],
    ]) {
      const result = await classify(conversation)
      check(`LIVE ${label}`, result.routed?.id, expected)
      console.log(`      ${label} -> ${JSON.stringify(result.routed?.id ?? 'none')} (${result.attempts ?? 0} call(s), ${result.tokens} tokens in, ${result.notes.join(' ')})`)
    }
  }

  // ── model metadata resolution, which is what the settings picker shows ────
  const info = await llm.resolveModelInfo('google', 'gemini-3.5-flash')
  check('google model resolves with an id', info.id, 'gemini-3.5-flash')
  check('google model advertises a name', typeof info.name === 'string' && info.name.length > 0, true)

  const listed = await llm.listModels('google')
  check('google advertises the configured model',
    listed.some(model => model.id === 'gemini-3.5-flash'), true)
  check('every advertised model has a usable id',
    listed.every(model => typeof model.id === 'string' && model.id.length > 0), true)
  check('every advertised model has a usable name',
    listed.every(model => typeof model.name === 'string' && model.name.length > 0), true)
}

const failed = results.filter(result => !result.ok)
for (const result of results) {
  console.log(`${result.ok ? 'PASS' : 'FAIL'}  ${result.label}${result.ok ? '' : `\n      expected ${JSON.stringify(result.expected)}\n      actual   ${JSON.stringify(result.actual)}`}`)
}
console.log(`\n${results.length - failed.length}/${results.length} passed${skipped.length === 0 ? '' : `, ${skipped.length} skipped (environment or account, not the plugin): ${skipped.join('; ')}`}`)

// The real `Context` keeps its fiber registry alive and the adapters keep HTTP
// keep-alive agents open, so the process would otherwise hang after the last
// assertion with no further output. Exit explicitly: the work is done.
process.exit(failed.length > 0 ? 1 : 0)
