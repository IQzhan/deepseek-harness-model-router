/**
 * dsh-model-router.host.js — the HOST adapter for the routing core.
 *
 * This file is a FRAGMENT, not a provider. `build-router.mjs` concatenates it
 * with `model-routing-config.js` to produce two artifacts:
 *
 *   · `dsh-model-router.core.js` — one self-contained Cordis plugin module with
 *     no imports, which is what a profile row loads (`name: ./…core.js`).
 *   · a string embedded in a dynamic-plugin payload, which is what
 *     `cordis_define` runs. The dynamic Host sandbox evaluates its input with
 *     `new Function` and deliberately traps `require`, so a plugin that imports
 *     a sibling file cannot be defined dynamically. Inlining is therefore a
 *     requirement of the target, not a stylistic choice — and generating both
 *     from one source keeps them from drifting.
 *
 * Everything above the plugin entry point below is the core library that the
 * build step prepends. Everything below it needs a live harness, and is kept as
 * thin as possible: it owns the settings namespace, observes `agent/request`,
 * runs the auxiliary classifier call, and serves the Client's settings page.
 *
 * ── Why `agent/request` and not `llm/stream` ─────────────────────────────────
 * `agent/request` runs after the loop has a proposed config but BEFORE
 * `llm.prepareCall()` and before the `request/header` event is logged, so the
 * logged header, the prepared adapter registration, and the dispatched request
 * all agree on one route.
 *
 * The `llm/stream` waterfall runs after that header is logged. Rewriting
 * `options.model` there makes the dispatched model differ from the folded
 * header — exactly what `dsh-agent-loop/invariant.ts` rejects ("llm request for
 * session ... diverges from the folded request header"). That check compares
 * `options.model` and never `options.provider`, which is the precise reason a
 * provider-only rewrite is safe there and a model rewrite is not. Use the seam
 * that owns the decision, not the seam that happens to run first.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Host adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Symbols pulled from the inlined core by name.
 *
 * The build inlines `model-routing-config.js` above this adapter, so these are
 * plain bindings in the same scope — the list is kept explicit and alphabetical
 * so a rename in the core fails the build's collision check rather than at run
 * time.
 *
 * (Nothing is declared here: the core's declarations are already in scope. This
 * comment exists because the absence of a list is otherwise surprising.)
 */

/** Cap one message block so classification cost stays bounded. */
const BLOCK_CHARS = 2000

/**
 * Build the settings schema for the stored document.
 *
 * The settings service resolves a namespace by CALLING its schema
 * (`schema(merged)` — `packages/settings/settings/src/index.ts:748`), so the
 * second argument to `register` must be a schemastery schema rather than a
 * shape literal.
 *
 * The schema is deliberately shallow: it declares the scalar fields the form
 * always writes so a missing document resolves to a complete one, while
 * `presets` and each task entry stay `z.any()`. `z.object()` leaves unknown keys
 * inside an `any`-valued field untouched, so per-task `pool`, `keywords`, and the
 * nested per-preset grant survive resolution byte for byte.
 *
 * Structural rules — task ids, pool entries, weights, exactly one default,
 * presets referring only to tasks that exist — are enforced by `validateConfig`
 * instead, which returns ALL problems at once and runs identically at load, at
 * save, and on the routing hot path. Encoding them here as well would create a
 * second source of truth that drifts, and a schema's first-error-only reporting
 * fits a form the user is editing badly.
 *
 * @param z - the schemastery module.
 * @returns the namespace schema.
 */
function buildDocumentSchema(z) {
  return z.object({
    enabled: z.boolean().default(false),
    // A reference, not a flag: the task used when nothing else matched. Empty
    // means "no default", and a reference that names an unusable task is
    // cleared by `sanitizeConfig`, so "no default" is always honest.
    defaultTaskId: z.string().default(''),
    /**
     * Whether a delegated child may itself delegate.
     *
     * Off by default: a subagent is an executor, and one level keeps routing
     * predictable. On, children go one level deeper.
     */
    childDelegation: z.boolean().default(false),
    classifier: z.object({
      enabled: z.boolean().default(false),
      provider: z.string().default(''),
      model: z.string().default(''),
      /**
       * Budget for what the classifier reads, in ESTIMATED TOKENS.
       *
       * Was a character cap, which is the wrong unit: the same 4000 characters
       * is ~1000 tokens of English and ~4000 of Chinese, so a "4000" budget
       * could be four times the intended input. A token budget is what the
       * model actually limits, and the adapter trims to it (see
       * `classificationInput`).
       */
      maxInputTokens: z.number().default(4000),
      timeoutMs: z.number().default(15000),
    }).default({ enabled: false, provider: '', model: '', maxInputTokens: 4000, timeoutMs: 15000 }),
    presets: z.any().default({}),
    tasks: z.array(z.any()).default([]),
  })
}

/**
 * Rebuild a value as a plain object the HOST realm accepts.
 *
 * `settings` admits a section only when `isPlainObject` passes
 * (`packages/settings/settings/src/index.ts:176`), and that predicate is
 * `Object.getPrototypeOf(value) === Object.prototype`. That is a REALM
 * comparison: this adapter runs inside the dynamic sandbox's `node:vm` context,
 * where `Object.prototype` is a different object from the host's, so an
 * ordinary `{}` built here is refused with
 * `settings replace for "model-routing" must be a plain object` — even though
 * it looks plain from in here. `Object.getPrototypeOf` is the one call that
 * still tells the truth, which is why the confusion is so easy to fall into.
 *
 * A NULL-prototype object sidesteps the comparison entirely: `proto === null`
 * evaluates the same in every realm, and `isPlainObject` accepts it explicitly
 * (`proto === null`). The settings service then normalizes the tree into fresh
 * host-realm objects for storage, so nothing downstream sees the null prototype
 * (`mergeLayers` re-spreads it, `cloneJsonShaped` rebuilds it).
 *
 * Verified against the real service: literal, nested, and JSON-round-tripped
 * objects are all refused from the sandbox; only the null-prototype form is
 * accepted.
 *
 * @param value - JSON-shaped value assembled in the sandbox realm.
 * @returns the same data with every object rebuilt as null-prototype.
 */
function toHostPlain(value) {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(entry => toHostPlain(entry))
  const out = Object.create(null)
  for (const [key, entry] of Object.entries(value)) out[key] = toHostPlain(entry)
  return out
}

/**
 * Register the settings namespace.
 *
 * `z` is not imported: the build step inlines schemastery (and its cosmokit
 * dependency) above this adapter, so the artifact is self-contained. That is
 * required rather than convenient — the dynamic Host sandbox evaluates its
 * input with `new Function` inside a `node:vm` context, where a static `import`
 * is a syntax error, `require` is trapped, and `import()` fails with "A dynamic
 * import callback was not specified." There is no module graph to reach for.
 *
 * @param ctx - the row's context.
 * @returns the registered namespace scope.
 */
function registerSettings(ctx) {
  // The base layer is built in this realm as well, so it takes the same
  // conversion: a composition base that fails `isPlainObject` host-side would
  // make the whole namespace unreadable, not just unwritable.
  return ctx.settings.register(NAMESPACE, buildDocumentSchema(z), {
    base: toHostPlain(starterConfig()),
  })
}

/**
 * How often the configuration folder is checked for changes.
 *
 * One directory read per second, `stat` only: cheap enough to run forever, and
 * fast enough that a hand-edited file feels live next to the settings page. A
 * filesystem watcher would be more immediate and far more fragile — editors
 * write, rename and swap files, and every one of those patterns would need its
 * own handling.
 */
const CONFIG_POLL_MS = 1000

/** Key-order-independent JSON, for "did the configuration actually change". */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value).sort()
    .map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}

/**
 * A small stable revision for a string.
 *
 * @param signature - the text to hash.
 * @returns a non-negative integer.
 */
function revisionOf(signature) {
  let hash = 0
  for (let index = 0; index < signature.length; index += 1) {
    hash = (hash * 31 + signature.charCodeAt(index)) % 2147483647
  }
  return hash
}

/**
 * Deterministic JSON: object keys sorted, so two equal documents hash alike.
 *
 * @param value - any JSON-shaped value.
 * @returns its canonical text.
 */
function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return `{${keys.map(key => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/**
 * The revision of a configuration DOCUMENT, which is what the page fences on.
 *
 * The settings service gave the page a revision to fence its writes with; files
 * have no such counter, so one is derived here. It is derived from the CONTENT,
 * not from the folder signature the watcher uses: a signature carries size and
 * mtime, so touching a file, restoring it byte-for-byte, or letting any other
 * tool rewrite identical bytes all moved the revision — and the page then
 * refused a perfectly good draft with "配置已被其他来源修改" for a configuration
 * that had not changed at all. (Measured: the offline suite's own hand-edit case
 * moved the deployed revision while leaving every file identical.)
 *
 * Problems ride along, because a file that stopped parsing IS a configuration
 * change from the operator's point of view even when the last good values are
 * still in effect.
 *
 * @param document - the effective configuration.
 * @param problems - the parse problems attached to it.
 * @returns a non-negative integer that changes exactly when the content does.
 */
function revisionOfDocument(document, problems) {
  return revisionOf(`${stableString(document)}\u0000${stableString(problems ?? [])}`)
}

/**
 * The file-backed configuration source.
 *
 * Everything the plugin reads and writes comes from one folder BESIDE
 * `settings.yaml` — the settings service keeps every namespace inside that one
 * document (`SettingsRegisterOptions` has no storage hook), so a configuration
 * that wants its own files cannot ride it:
 *
 *     <DSH_HOME>/model-routing/global.yml
 *     <DSH_HOME>/model-routing/tasks/<id>.yml
 *
 * The folder is derived from `settings.documentPath`, never from an environment
 * variable or a hard-coded path, so a profile that moves keeps its configuration
 * beside it. When the filesystem is unreachable — the dynamic Host sandbox has no
 * module system at all — this returns undefined and the adapter falls back to the
 * settings namespace, which is why that path still exists.
 *
 * @param ctx - the row's context.
 * @returns a store handle, or undefined when files are unavailable.
 */
function createConfigStore(ctx) {
  if (STORE_FS === undefined || STORE_PATH === undefined || STORE_YAML === undefined) return undefined
  const documentPath = ctx.get('settings')?.documentPath
  const home = typeof documentPath === 'string' && documentPath.length > 0
    ? STORE_PATH.dirname(documentPath)
    : typeof process !== 'undefined' ? process.env?.DSH_HOME : undefined
  if (typeof home !== 'string' || home.length === 0) return undefined
  const root = STORE_PATH.join(home, STORE_DIRNAME)
  const parse = text => STORE_YAML.parse(text)
  const stringify = value => STORE_YAML.stringify(value)

  return {
    root,
    paths: paths(root),
    /** Read the folder as one document, plus the per-file problems. */
    read() {
      const stored = readConfig(root, parse)
      return { document: assemble(stored), problems: stored.problems }
    },
    /** Replace the folder with this document. */
    write(document) {
      return writeConfig(root, splitDocument(document), stringify)
    },
    /** Whether anything has ever been saved here. */
    exists() {
      try {
        return STORE_FS.existsSync(paths(root).global)
      } catch {
        return false
      }
    },
    /**
     * A change signature for the whole folder.
     *
     * Polling this is how a hand-edit becomes live: names, sizes and mtimes are
     * enough to notice an edit, a new task file or a deletion, and it costs one
     * directory read rather than a watcher that has to survive editor rename
     * dances.
     */
    signature() {
      const at = paths(root)
      const parts = []
      try {
        parts.push(statLine(at.global))
        const names = STORE_FS.readdirSync(at.tasks).filter(name => name.endsWith(FILE_EXT)).sort()
        for (const name of names) parts.push(statLine(STORE_PATH.join(at.tasks, name)))
      } catch {
        return `missing:${parts.length}`
      }
      return parts.join('|')

      function statLine(file) {
        try {
          const stat = STORE_FS.statSync(file)
          return `${file}:${stat.size}:${stat.mtimeMs}`
        } catch {
          return `${file}:0:0`
        }
      }
    },
  }
}

/**
 * Move a `model-routing` section out of `settings.yaml` and into the folder.
 *
 * Runs once: a deployment that configured the plugin through the settings page
 * must not lose that configuration because the storage moved. The section is
 * REMOVED from the document afterwards — that file is the harness's, and leaving
 * a dead copy behind is exactly the confusion this move exists to end.
 *
 * @param ctx - the row's context.
 * @param store - the file store.
 * @returns a short description of what happened, for the log.
 */
function migrateFromSettingsDocument(ctx, store) {
  if (store.exists()) return 'the folder already holds a configuration'
  const documentPath = ctx.get('settings')?.documentPath
  if (typeof documentPath !== 'string' || !STORE_FS.existsSync(documentPath)) return 'nothing to migrate'
  let raw
  try {
    raw = STORE_FS.readFileSync(documentPath, 'utf8')
  } catch (error) {
    return `could not read settings.yaml: ${error.message}`
  }
  let parsed
  try {
    parsed = STORE_YAML.parse(raw) ?? {}
  } catch (error) {
    return `settings.yaml does not parse: ${error.message}`
  }
  const section = parsed?.[NAMESPACE]
  if (section === null || typeof section !== 'object') return 'no model-routing section to migrate'
  const validation = validateConfig(section)
  if (!validation.ok) {
    // Migrating an invalid document would turn a visible settings error into a
    // file the plugin then refuses to load. Leave it alone and say so.
    return `the stored section is invalid, left in place: ${validation.problems.slice(0, 2).join('; ')}`
  }
  store.write(section)
  // Remove the section, preserving every other key and the file's own comments
  // as far as a YAML round trip can: only this namespace's block is dropped.
  const withoutSection = raw.replace(new RegExp(`^${NAMESPACE}:\\n(?:[ \\t].*\\n|\\n)*`, 'm'), '')
  try {
    STORE_FS.writeFileSync(`${documentPath}.tmp`, withoutSection, 'utf8')
    STORE_FS.renameSync(`${documentPath}.tmp`, documentPath)
  } catch (error) {
    return `configuration migrated, but the settings section could not be removed: ${error.message}`
  }
  return 'migrated from settings.yaml and removed the section there'
}

/**
 * How many recent messages the classifier may see, and how much of each.
 *
 * The token budget is the real bound (see `classificationInput`); these keep
 * the per-message cost sane so a single enormous tool result cannot dominate.
 */
const CLASSIFIER_MESSAGES = 4

/** Text of one message, joined from its text blocks and capped. */
function messageText(message) {
  const chunks = []
  for (const block of message.content) {
    if (block.type === 'text' && typeof block.text === 'string') chunks.push(block.text.slice(0, BLOCK_CHARS))
  }
  return chunks.join('\n')
}

/**
 * The message a delegated session was created with.
 *
 * For "which task is this", the OPENING instruction is the strongest signal and
 * the tail is usually the least interesting thing in the conversation — often a
 * tool result. This walks forward to the first non-empty user-side message,
 * which is the task the subagent was spawned with.
 *
 * The fallback is not a nicety, it is the difference between routing and not
 * routing. A delegation delivers its prompt by SPLICING it into the child's
 * inbox (`agent/inbox/spliced`, targeting the next turn), and at the moment the
 * child's first request is assembled the derived message list does not yet
 * contain it — measured live: three delegations in a row fell through to the
 * classifier because `[task: …]` and every keyword were invisible. Reading the
 * recorded splice is what makes the first turn routable.
 *
 * @param session - the delegated session.
 * @returns the opener's text, or an empty string when there is none.
 */
function rootTaskText(session) {
  const derived = openerFromMessages(session)
  return derived.length > 0 ? derived : openerFromSplices(session)
}

/** The opener as the session's derived message list reports it. */
function openerFromMessages(session) {
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = messageText(message).trim()
    if (text.length > 0) return text
  }
  return ''
}

/**
 * The opener as the session's recorded inbox splice reports it.
 *
 * Shape comes from the log itself: `inserted: [{ content: [{ type: 'text',
 * text }] }]`. Every read is guarded — this reaches into recorded events, so a
 * shape change must degrade to "no text", never to a throw on the request path.
 *
 * @param session - the delegated session.
 * @returns the first spliced user text, or an empty string.
 */
function openerFromSplices(session) {
  const events = typeof session.snapshotEvents === 'function'
    ? session.snapshotEvents()
    : typeof session.events === 'function' ? session.events() : []
  if (!Array.isArray(events)) return ''
  for (const event of events) {
    if (event?.type !== 'agent/inbox/spliced') continue
    const inserted = event.data?.inserted
    if (!Array.isArray(inserted)) continue
    for (const message of inserted) {
      const text = messageText({ content: Array.isArray(message?.content) ? message.content : [] }).trim()
      if (text.length > 0) return text
    }
  }
  return ''
}

/** Recent conversation text, newest-first, bounded by message count. */
function recentText(session, messageLimit) {
  const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
  const parts = []
  for (let index = messages.length - 1; index >= 0 && parts.length < messageLimit; index -= 1) {
    const message = messages[index]
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const text = messageText(message).trim()
    if (text.length > 0) parts.push(text)
  }
  // Collected tail-first; the caller wants chronological order.
  return parts.reverse().join('\n\n')
}

/**
 * Tool names the current request header declares, as a LIST.
 *
 * The list and the joined string are separate on purpose. The deterministic
 * matcher wants one searchable string; the settings page wants names. Iterating
 * the string yields its characters — which is exactly how the tool picker came to
 * offer `a`, `b`, `c` … as tools.
 *
 * @param session - the session whose assembled header to read.
 * @returns the declared tool names.
 */
function headerToolList(session) {
  // Defensive: this reads a FOREIGN agent's session, and a shape without the
  // accessor is a reason to answer "no tools", not to log a failure.
  if (typeof session?.requestHeader !== 'function') return []
  const header = session.requestHeader()
  const tools = header?.tools
  if (!Array.isArray(tools)) return []
  const names = []
  for (const tool of tools) {
    if (tool !== null && typeof tool === 'object' && typeof tool.name === 'string') names.push(tool.name)
  }
  return names
}

/** Tool names the current request header declares, as one searchable string. */
function headerToolNames(session) {
  return headerToolList(session).join(' ')
}

/** Join the text of one streamed response, ignoring everything else. */
async function collectText(llm, options) {
  const open = new Map()
  const parts = []
  for await (const chunk of llm.stream(options)) {
    if (chunk.type === 'block-start') open.set(chunk.index, chunk.blockType)
    else if (chunk.type === 'text-delta' && open.get(chunk.index) === 'text') parts.push(chunk.text)
    else if (chunk.type === 'block-end') open.delete(chunk.index)
    else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop') {
      throw new Error(`classifier call finished with ${chunk.reason.kind}`)
    }
  }
  return parts.join('')
}

/**
 * Output budget for one classifier call.
 *
 * Not 16. A thinking model bills its reasoning against this budget, so a tiny
 * cap can spend the whole allowance on reasoning and return NO text at all —
 * observed live as an empty reply, which routing can only read as "no answer".
 * The answer itself is one id, so the model stops long before this.
 */
const CLASSIFIER_MAX_TOKENS = 256

/**
 * How many classifier calls one turn may spend.
 *
 * The free/meta routes are intermittent in ways a single call cannot survive:
 * measured over 12 live calls, one route returned a safety-classifier string
 * ("User Safety: safe") instead of an id, and another returned a 400 because
 * its endpoint demands reasoning. A second call usually lands elsewhere.
 */
const CLASSIFIER_ATTEMPTS = 2

/**
 * Ask the configured classifier model which task this turn belongs to.
 *
 * This is an ORDINARY nested LLM call: it goes through `llm.stream`, which is
 * not the `agent/request` seam, so it cannot re-enter routing; and its route is
 * explicit, so nothing else can move it. Failure is never fatal to the turn —
 * a classifier that times out, is rate-limited, or answers nonsense resolves to
 * `undefined` and the caller falls through to its configured fallback task.
 * Routing degrades; the user's turn does not.
 *
 * `withTimeout` is injected rather than reached for: the dynamic Host sandbox
 * traps `setTimeout`, and the Cordis timer service is the supported substitute
 * (it is also a fiber effect, so a pending classifier timer cannot outlive the
 * plugin).
 *
 * @param llm - the live LLM runtime.
 * @param settings - the current document.
 * @param tasks - candidate tasks to choose among.
 * @param text - recent conversation text.
 * @param signal - the turn's cancellation signal.
 * @param withTimeout - `(task, ms) => Promise` that rejects after `ms`.
 */
async function classifyWith(llm, settings, tasks, text, signal, withTimeout) {
  const route = settings.classifier
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal?.reason)
  if (signal !== undefined) {
    if (signal.aborted) return { task: undefined, error: 'turn aborted' }
    signal.addEventListener('abort', onAbort, { once: true })
  }
  try {
    const prompt = classifierPrompt(tasks, text)
    const messages = [{
      role: 'user',
      content: [{ type: 'text', text: prompt.user }],
      source: { kind: 'plugin', plugin: ROUTER_NAME, form: 'instructions' },
    }]
    const budget = Number.isFinite(route.timeoutMs) && route.timeoutMs > 0 ? route.timeoutMs : 15000
    const started = Date.now()
    let failure = 'no reply'
    for (let attempt = 1; attempt <= CLASSIFIER_ATTEMPTS; attempt += 1) {
      if (controller.signal.aborted) return { task: undefined, error: 'turn aborted' }
      // A retry must not double the delay a SLOW classifier already cost: only a
      // failure that came back quickly is worth repeating. Measured live, the
      // unusable replies arrive in 0.05–0.8s while a timeout spends the budget.
      if (attempt > 1 && Date.now() - started > budget / 2) break
      try {
        const reply = await withTimeout(collectText(llm, {
          provider: route.provider,
          model: route.model,
          messages,
          system: prompt.system,
          maxTokens: CLASSIFIER_MAX_TOKENS,
          temperature: 0,
          purpose: 'model-routing-classify',
          signal: controller.signal,
        }), budget)
        const task = parseClassifierReply(reply, tasks)
        if (task !== undefined) return { task, error: undefined }
        // "none" is an ANSWER: the model read the candidates and found none. It
        // is not worth a second call, and repeating it would only spend tokens.
        if (/\bnone\b/iu.test(reply)) return { task: undefined, error: undefined }
        failure = `unusable reply ${JSON.stringify(reply.slice(0, 48))}`
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
      }
    }
    return { task: undefined, error: failure }
  } catch (error) {
    return { task: undefined, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (signal !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * Runtime diagnostics the settings page reads.
 *
 * A plugin that rewrites another agent's tool table has to be able to say what
 * it is doing and why it stopped. Everything here is cheap: a fixed-size ring of
 * the last failures, the services that were actually found at mount, and a
 * breaker that takes the plugin out of the request path when it keeps failing.
 *
 * `capabilities` is the version-resilience readout: it records which of the
 * services and seams this build depends on were present. A DSH update that
 * renames or removes one shows up there immediately, and the delegation feature
 * degrades to "routing only" instead of taking the panel down.
 */
const ERROR_RING = 12
const BREAKER_THRESHOLD = 5
const BREAKER_COOLDOWN_MS = 60000

function createDiagnostics() {
  const errors = []
  const providers = new Map()
  let trippedAt = 0
  let tripReason = ''
  let consecutive = 0
  const capabilities = {}

  return {
    /** Record which optional dependency was present at mount. */
    probe(capabilities_) {
      Object.assign(capabilities, capabilities_)
    },
    /** Remember one unexpected failure, and trip the breaker when they pile up. */
    fail(where, error) {
      const message = error instanceof Error ? error.message : String(error)
      errors.push({ at: Date.now(), where, message })
      if (errors.length > ERROR_RING) errors.shift()
      consecutive += 1
      if (consecutive >= BREAKER_THRESHOLD && trippedAt === 0) {
        trippedAt = Date.now()
        tripReason = `${consecutive} consecutive failures, last in ${where}: ${message}`
        console.error(`${ROUTER_NAME}: disabled itself after ${consecutive} failures — ${message}`)
      }
      console.error(`${ROUTER_NAME}: ${where} failed`)
      console.error(error)
    },
    /** One success clears the streak; the breaker itself needs a real reset. */
    ok() { consecutive = 0 },
    /** Why the plugin is out of the request path, or '' when it is active. */
    tripped() {
      if (trippedAt === 0) return ''
      if (Date.now() - trippedAt < BREAKER_COOLDOWN_MS) return tripReason
      // Cooldown over: try again. A transient upstream failure must not disable
      // routing for the rest of the process's life.
      trippedAt = 0
      tripReason = ''
      consecutive = 0
      return ''
    },
    /** Clear the breaker immediately (a settings change is a human decision). */
    reset() {
      trippedAt = 0
      tripReason = ''
      consecutive = 0
    },
    /** Count a provider-level request failure, for the pool health readout. */
    providerFailed(provider) {
      const key = String(provider ?? 'unknown')
      const entry = providers.get(key) ?? { failures: 0, lastAt: 0 }
      entry.failures += 1
      entry.lastAt = Date.now()
      providers.set(key, entry)
    },
    /** The whole readout, as plain JSON for the settings page. */
    snapshot() {
      return {
        errors: errors.map(entry => ({ ...entry })),
        capabilities: { ...capabilities },
        breaker: {
          tripped: trippedAt !== 0 && Date.now() - trippedAt < BREAKER_COOLDOWN_MS,
          reason: tripReason,
          consecutive,
          threshold: BREAKER_THRESHOLD,
        },
        providers: Object.fromEntries([...providers].map(([id, entry]) => [id, { ...entry }])),
      }
    },
  }
}

/**
 * The delegation tool this plugin provides in place of the built-in one.
 *
 * The plugin does not merely route children — it SUPPLIES the ability to
 * delegate, so a preset needs no delegation row of its own and the built-in
 * tools can be masked. Verified against the real `ToolRuntime`: an agent-scope
 * registration shadows an inherited name of the same name, and an inherited
 * name can be masked with `restrict()` whose disposer restores it.
 */
const DELEGATION_TOOL = 'subagent'

/**
 * The continuation tool this plugin provides alongside it.
 *
 * DSH ships an equivalent (`send_message`), but only when a preset mounts the
 * row that registers it. Without one the main agent cannot continue a child at
 * all — so the policy "keep the same child for the whole task" would be a
 * promise the composition cannot keep. Providing it here is what makes that
 * policy executable with zero preset edits.
 */
const MESSAGE_TOOL = 'subagent_message'

/** Built-in delegation tool names this plugin takes over when they are present. */
const BUILTIN_DELEGATION = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code']

/** Provider route this plugin delegates through (the in-process spawn backend). */
const DELEGATION_PROVIDER = 'spawn'

/**
 * The policy the MAIN agent reads, delivered as the delegation tool's own
 * description.
 *
 * This channel is deliberate. A preset with a `complete: true` persona
 * suppresses every prompt SECTION and — with `includeRuntimeContext: false` —
 * every runtime CONTEXT, so a plugin-registered prompt section is invisible in
 * exactly the presets that need the guidance most. Tool definitions are not
 * prompt sections: they reach the model whatever the persona does.
 *
 * The text is written GENERICALLY on purpose: it states how delegation is meant
 * to work for ANY kind of work, and never names a sample domain. A policy that
 * teaches by example gets followed only for that example.
 *
 * @param config - the current document.
 * @param toolName - the registered delegation tool name.
 * @param messageTool - the continuation tool name, or '' when this build cannot
 *   continue a child (the text must not promise what does not exist).
 * @returns the description text.
 */
function delegationPolicy(config, toolName, messageTool) {
  const tasks = (config.tasks ?? []).filter(task => task.enabled !== false && (task.pool ?? []).length > 0)
  const lines = [
    `Delegate ONE closed task to a subagent, and call ${toolName} BEFORE you start that work`,
    'yourself. You own the whole result; the child owns its part of it.',
    '',
    'Sizing — one child, one closed task:',
    '- The task must be self-contained, independently verifiable, and small enough to finish in one',
    '  go. A closed task is one that can be delivered and checked on its own.',
    '- Never pack unrelated work into one delegation: a child carrying several different jobs does',
    '  all of them badly. Split into separate children instead.',
    '- The child works only inside its own task. Do not hand it your own coordination, and do not',
    '  redo its work yourself while it runs.',
    '',
    'Instructions — the child cannot see this conversation, so `prompt` must be complete and',
    'standalone: state the goal, the constraints already agreed with the user, the deliverable, and',
    'how you will judge it. Naming the interface or format you expect back removes most rework.',
    '',
    'Ownership — the child that got the task keeps it:',
  ]
  if (messageTool === '') {
    lines.push(
      '- Each delegation is a fresh child that returns one deliverable and ends. Fold your review',
      '  notes into the NEXT delegation of that same task instead of opening several children for it.',
    )
  } else {
    lines.push(
      `- When the child delivers, review it yourself and send your changes back to THAT child with`,
      `  \`${messageTool}\` (its id comes from this tool's result). Do not start a new child for a`,
      '  revision, a follow-up, or a next step of the same task — the child keeps its context, and',
      '  staying with it is what keeps task ownership unambiguous.',
      '- Continue the same child for as long as it is working on that task. Start a separate child',
      '  only for a genuinely different closed task.',
    )
  }
  if (tasks.length > 0) {
    const hasDefault = typeof config.defaultTaskId === 'string' && config.defaultTaskId.length > 0
    lines.push(
      '',
      'Pass `task` to select the executor class; the harness then picks the model itself:',
      ...tasks.map(task => {
        const description = task.description && task.description.length > 0 ? task.description : task.name
        const keywords = (Array.isArray(task.keywords) ? task.keywords : []).filter(k => k.length > 0)
        return `- ${task.id}: ${description}${keywords.length === 0 ? '' : `（例如：${keywords.slice(0, 4).join('、')}）`}`
      }),
      '',
      // The omission rule is stated as the deployment actually behaves. Claiming
      // classification while it is switched off would be a promise the tool cannot
      // keep — the model would omit `task` expecting a judgment that never comes.
      config.classifier?.enabled === true
        ? 'Omit `task` only when none of them fits: the harness then classifies the request by meaning.'
        : hasDefault
          ? 'Always pass `task`: semantic classification is switched off here, so an omitted one runs on the default task.'
          : 'Always pass `task`: semantic classification is switched off and there is no default task, so an omitted'
            + ' one keeps the child it was given.',
    )
  }
  lines.push(
    '',
    'Answer directly, without delegating, when the request is a short question you can answer from',
    'what you already know, or a trivial edit.',
  )
  return lines.join('\n')
}

/**
 * Build the delegation tool definition.
 *
 * Hand-built rather than via `defineTool`: the definition is a plain object
 * (`{ name, description, parameters, output, execute }`) and avoiding the
 * import keeps this bundle free of a build-time dependency on the tools package.
 *
 * @param options - the live pieces the tool needs.
 * @returns a `ToolDefinition`.
 */
function buildDelegationTool(options) {
  const { toolName, messageTool, config, subagents, childDelegation, announce, reportFilterFailure } = options
  const tasks = (config.tasks ?? []).filter(task => task.enabled !== false && (task.pool ?? []).length > 0)
  const continuable = messageTool !== '' && typeof subagents.startContinuable === 'function'
  const parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['description', 'prompt'],
    properties: {
      description: { type: 'string', description: 'A short (3-5 word) description of the delegated task, for display.' },
      prompt: { type: 'string', description: 'The complete, standalone task for the subagent. It does not see this conversation.' },
      ...tasks.length === 0 ? {} : {
        task: {
          type: 'string',
          enum: tasks.map(task => task.id),
          description: 'Executor class for this delegation. Omit to let the harness classify the request.',
        },
      },
    },
  }
  return {
    name: toolName,
    description: delegationPolicy(config, toolName, continuable ? messageTool : ''),
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {
          task: { type: 'string' },
          subagent_id: { type: 'string' },
          text: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${toolName} requires a calling agent`)
      const origin = parent.session?.header?.origin
      if (origin === 'subagent' && childDelegation !== true) {
        throw new Error(
          'this subagent is an executor and does not delegate further; return the parts that need '
          + 'independent work to the parent instead',
        )
      }
      // The explicit class rides the child's opening message as a directive, so
      // the router resolves it DETERMINISTICALLY — no classifier call, no
      // ambiguity, no tokens.
      //
      // It goes at the END, not the front. Measured in a real session: a LEADING
      // marker became the child's sidebar title ("[task: web-research] 你必须加载
      // web"), because a title is taken from the start of the first message.
      // `matchDeterministic` scans the whole opener, so the tail costs nothing
      // and the human-visible title stays clean.
      const marker = typeof args.task === 'string' && args.task.length > 0
        ? `\n\n[task: ${args.task}]`
        : ''
      const declared = tasks.find(entry => entry.id === args.task)
      // A task-shaped child: the filter rides the START REQUEST (the provider
      // validates and applies it at creation, before any child exists), and the
      // persona is announced so the child's own scope installs it. See
      // `childProfileOf` for why the persona cannot ride the request too.
      // An allow list by default; the task's own declaration wins when it has
      // one, and childDelegation: true asks for children that CAN delegate, so
      // nothing is filtered away from them.
      const filter = childToolFilter(
        declared?.childTools,
        childDelegation === true ? undefined : childAllowList(parent),
      )
      /** The start request, with or without the task's tool filter. */
      const requestWith = (useFilter) => ({
        label: args.description,
        prompt: [{ type: 'text', text: `${args.prompt}${marker}` }],
        parent,
        ...useFilter && filter !== undefined ? { toolFilter: filter } : {},
        // A child is an executor: one level deep by default, and it may delegate
        // only when the operator asked for that.
        maxDepth: childDelegation === true ? 2 : 1,
      })
      const task = typeof args.task === 'string' && args.task.length > 0 ? { task: args.task } : {}

      /**
       * Start the child, tolerating a tool filter the child cannot honour.
       *
       * A spawn request naming a tool the child cannot see fails BEFORE any child
       * exists, so retrying without the filter is safe and is strictly better
       * than losing the delegation: the filter is a refinement, the delegation is
       * the point. The failure is reported, because a filter that is silently
       * dropped is a configuration that looks applied and is not.
       */
      const startChild = async (start) => {
        try {
          return await announce({ parent, task: declared }, () => start(requestWith(true)))
        } catch (error) {
          if (filter === undefined || !isFilterRefusal(error)) throw error
          reportFilterFailure(error)
          return await announce({ parent, task: declared }, () => start(requestWith(false)))
        }
      }

      if (continuable) {
        // A CONTINUABLE child is what makes "send the revision notes back to the
        // same child" possible at all: it stays addressable after its first turn
        // instead of ending with it. The call resolves at inbox acceptance, so
        // the deliverable arrives as a completion notice rather than a return
        // value — which is also why the description tells the model to review and
        // continue rather than wait here.
        const started = await startChild(request => subagents.startContinuable({
          provider: DELEGATION_PROVIDER,
          label: args.description,
          request,
          signal: exec.signal,
        }))
        const id = String(started?.childId ?? '')
        return {
          ...task,
          ...id.length === 0 ? {} : { subagent_id: id },
          text: `Delegated to a subagent${id.length === 0 ? '' : ` (id ${id})`}. It runs its own turns and `
            + `reports back when the run settles; send your review notes or the next step of this same task `
            + `to that id with \`${messageTool}\` instead of starting another subagent.`,
        }
      }

      const run = await startChild(request => subagents.start(
        DELEGATION_PROVIDER, { ...request, signal: exec.signal },
      ))
      try {
        const result = await run.result
        const text = (result?.output ?? [])
          .filter(block => block?.type === 'text')
          .map(block => block.text)
          .join('')
        return { ...task, text: text.length > 0 ? text : '(the subagent returned no text)' }
      } finally {
        await run.dispose()
      }
    },
  }
}

/**
 * Build the continuation tool: send a message to a child this agent started.
 *
 * This is the capability behind "keep the same child for the whole task". DSH
 * ships an equivalent tool, but only when a preset mounts its row — a preset
 * without it leaves the main agent unable to continue anything, which is exactly
 * the situation this plugin exists to fix. Providing it here keeps the promise
 * in the delegation description true without touching any preset.
 *
 * @param options - the live pieces the tool needs.
 * @returns a `ToolDefinition`.
 */
function buildMessageTool(options) {
  const { toolName, messageTool, subagents } = options
  return {
    name: messageTool,
    description: [
      `Send a message to a subagent YOU started, keeping the same child for the same task.`,
      '',
      'Use this for review notes, corrections, the next step of the task that child already owns, or a',
      'question about its deliverable. Do not use it to hand the child a different, unrelated task —',
      'that is a new delegation — and do not start a second child for work the first one still owns.',
      '',
      'The child keeps its own context, so it does not need the background restated; send only what',
      'changed or what you want next.',
    ].join('\n'),
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['subagent_id', 'message'],
      properties: {
        subagent_id: { type: 'string', description: `Target child id, as returned by ${toolName}.` },
        message: { type: 'string', description: 'What to send. Complete and standalone, without re-stating context the child already has.' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: { text: { type: 'string' } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${messageTool} requires a calling agent`)
      // The service enforces lineage itself: a message to a session this agent
      // did not start is refused there, with a better error than this tool could
      // invent.
      const messageId = await subagents.sendMessage(
        parent,
        args.subagent_id,
        [{ type: 'text', text: args.message }],
        { signal: exec.signal },
      )
      return { text: `Message accepted (${String(messageId)}). The child continues in its own session; its reply arrives as a notice.` }
    },
  }
}

/**
 * Whether a failed spawn was refused because of the child TOOL FILTER.
 *
 * Only that specific refusal is worth retrying without the filter: the provider
 * validates the filter names at creation and rejects the whole start, so the
 * delegation is lost over a refinement. Every other failure (rate limit, provider
 * down, depth cap) must propagate unchanged — retrying those would just double
 * the work. The message comes from `ToolRuntime.restrict`
 * (`tools.restrict() names unknown global tool "…"`).
 *
 * @param error - whatever the start threw.
 * @returns true when retrying without the filter is the right move.
 */
function isFilterRefusal(error) {
  const message = error instanceof Error ? error.message : String(error)
  return /tools\.restrict|unknown global tool/iu.test(message)
}

/**
 * The tool list a child should get, built as an ALLOW list.
 *
 * An allow list is the only mechanism that can remove a tool it cannot name. A
 * child composes its parent's preset, and that preset may carry delegation rows
 * (this deployment's `cordis` preset has several). A DENY list naming them is
 * validated against the child's registry at creation — before that composition is
 * in place — so it was refused wholesale and nothing was filtered at all;
 * measured live, on every delegation. Naming what the child KEEPS sidesteps the
 * question: whatever is not on the list is simply absent.
 *
 * The list comes from the caller's own assembled header, so it is whatever this
 * deployment actually has rather than a hard-coded guess.
 *
 * @param parent - the delegating agent.
 * @returns `{ allow }`, or undefined when there is nothing to build from (an
 *   empty allow list would deny every tool, which is never the intent).
 */
function childAllowList(parent) {
  const names = headerToolList(parent?.session)
    .filter(name => !isDelegationTool(name))
  return names.length > 0 ? { allow: [...new Set(names)] } : undefined
}

/**
 * Whether a tool name belongs to the delegation machinery.
 *
 * Matched by SHAPE, not by an enumerated list: this plugin's two tools, the
 * built-ins a preset may carry (`subagent_fork`, `subagent_codex`, …), the
 * model-selection helper (`list_subagent_models`) and the controller tools
 * (`send_message`, `list_agents`) are all delegation by construction, and a new
 * one added by a future DSH release still matches the pattern. A tool a child
 * needs is never named this way.
 *
 * @param name - a tool name from an assembled header.
 * @returns true when a child must not have it.
 */
function isDelegationTool(name) {
  return /^subagent/iu.test(name) || name === 'list_subagent_models'
    || name === 'send_message' || name === 'list_agents'
}

/**
 * The tool filter a delegation gives its child.
 *
 * Recursion is governed here rather than by the child's preset, which this plugin
 * cannot edit. The only filter form that REMOVES inherited delegation tools is an
 * ALLOW list; naming those tools in `deny` is refused by the provider ("unknown
 * global tool"), and a refused filter is dropped ENTIRELY — measured live, and
 * the opposite of protecting anything.
 *
 * So an operator's two statements are folded together instead of one replacing
 * the other:
 *
 *   · `allow` — what a child may have. It already excludes everything else,
 *     delegation included, so it stands as written.
 *   · `deny` — "no `pwsh` for these children". It is applied ON TOP of the
 *     default allow list, so declaring one no longer silently hands the child
 *     back the controller tools that list had removed.
 *
 * @param declared - the task's `childTools`, when it declares one.
 * @param base - the deployment's default allow list, undefined when the operator
 *   allows children to delegate.
 * @returns a `ToolRestriction`, or undefined when nothing needs restricting.
 */
function childToolFilter(declared, base) {
  const allow = Array.isArray(declared?.allow) ? [...declared.allow] : undefined
  const deny = Array.isArray(declared?.deny) ? [...declared.deny] : []
  // An explicit `allow` IS the operator's statement of what a child may have: it
  // already excludes everything else, delegation included.
  if (allow !== undefined) return allow.length === 0 ? undefined : { allow }
  if (deny.length === 0) return base
  // A `deny` is folded INTO the default allow list rather than replacing it. The
  // two are independent statements ("no `pwsh`" and "no delegation"), and letting
  // one erase the other is how a child kept a controller tool nobody gave it.
  if (base !== undefined) {
    const kept = base.allow.filter(name => !deny.includes(name))
    return kept.length > 0 ? { allow: kept } : undefined
  }
  return { deny }
}

/**
 * Mount the router.
 * @param ctx - the row's Cordis context (or the dynamic sandbox's restricted ctx).
 */
function mountRouter(ctx) {
  const settings = ctx.settings
  const llm = ctx.llm
  const timer = ctx.timer
  // One scheduler per process. Its rotation state is shared by every Session —
  // that is exactly what makes load balancing global rather than per-session.
  const scheduler = createScheduler()
  /** `${sessionId}\0${turn}` -> { taskId, error } — the classifier runs once per turn. */
  const decisions = new Map()
  /** `${sessionId}\0${turn}` -> taskId, so a retry rotates the pool that failed. */
  const routed = new Map()
  /** `${sessionId}\0${turn}\0${taskId}` -> routes already known to fail this turn. */
  const exhausted = new Map()
  /** `${sessionId}\0${turn}` -> task ids this turn must not route to again. */
  const banned = new Map()

  /** Bounded bookkeeping: a long-lived process must not grow a map per turn. */
  function remember(map, key, value) {
    map.set(key, value)
    if (map.size > 512) {
      const oldest = map.keys().next()
      if (oldest.done !== true) map.delete(oldest.value)
    }
  }
  const diagnostics = createDiagnostics()
  // What this build needs, and whether it was there. Recorded once so the
  // settings page can show it instead of the operator guessing.
  diagnostics.probe({
    settings: typeof settings?.register === 'function',
    llm: typeof llm?.stream === 'function',
    timer: typeof timer?.timeout === 'function',
    agents: typeof ctx.get('agents')?.list === 'function',
    agentCreated: true,
    subagents: typeof ctx.get('subagents')?.start === 'function',
    agentPresets: ctx.get('agentPresets') !== undefined,
    // A real probe, not an assertion: this build no longer reads the global tool
    // registry, so claiming it here would be a readout that lies.
    tools: typeof ctx.get('tools')?.schemas === 'function',
    webServer: ctx.get('webServer') !== undefined,
    continuable: typeof ctx.get('subagents')?.startContinuable === 'function',
  })

  // ── the configuration source ──────────────────────────────────────────────
  //
  // Files first. The settings namespace remains as a FALLBACK for the one case
  // where there is no filesystem — the dynamic Host sandbox, which has no module
  // system — so the same source still runs in both places.
  const store = createConfigStore(ctx)
  const settingsScope = store === undefined ? registerSettings(ctx) : undefined
  const migration = store === undefined
    ? 'no filesystem: using the settings namespace'
    : migrateFromSettingsDocument(ctx, store)
  console.log(`${ROUTER_NAME}: configuration ← ${store === undefined ? 'settings.yaml' : store.root} (${migration})`)

  /** Cache of the file-backed document, refreshed by the watcher. */
  let cached = store === undefined ? undefined : store.read()
  let cachedSignature = store === undefined ? '' : store.signature()

  /** Re-read the folder; returns true when the content changed. */
  function reload() {
    if (store === undefined) return false
    const signature = store.signature()
    if (signature === cachedSignature && cached !== undefined) return false
    cachedSignature = signature
    const next = store.read()
    const changed = canonicalJson(next.document) !== canonicalJson(cached?.document)
    cached = next
    if (next.problems.length > 0) {
      // A hand-edit that does not parse keeps the last good value for that file
      // and says so, instead of blanking the task list.
      for (const problem of next.problems) {
        console.error(`${ROUTER_NAME}: ${problem.file}: ${problem.message}`)
      }
      diagnostics.fail('configuration file', new Error(next.problems.map(p => `${p.file}: ${p.message}`).join('; ')))
    }
    return changed
  }

  /**
   * Current document, repaired once per read.
   *
   * `sanitizeConfig` drops route ids that cannot resolve — including the literal
   * `"undefined"` an older build could write — and clears a `defaultTaskId` that
   * no longer names a usable task. Doing it here rather than only at save means
   * an already-corrupted document routes correctly without waiting for the user
   * to touch the form.
   */
  const document = () => {
    const stored = store === undefined ? settingsScope.get() : cached?.document
    if (stored === null || typeof stored !== 'object') return defaultConfig()
    return sanitizeConfig(stored).config
  }

  /** The whole document as the settings page reads it, with its problems. */
  const readDocument = () => {
    if (store === undefined) return { document: document(), problems: [], revision: 0 }
    reload()
    const problems = cached?.problems ?? []
    return {
      document: document(),
      problems,
      revision: revisionOfDocument(document(), problems),
    }
  }

  /** Replace the configuration, after validating whatever the page sent. */
  function writeDocument(candidate, expectedRevision) {
    if (store === undefined) {
      const validation = validateConfig(candidate)
      if (!validation.ok) return { ok: false, problems: validation.problems }
      return Promise.resolve(settingsScope.replace(toHostPlain(candidate)))
        .then(() => ({ ok: true, problems: [] }))
        .catch(error => ({ ok: false, problems: [String(error?.message ?? error)] }))
    }
    reload()
    const current = revisionOfDocument(document(), cached?.problems ?? [])
    if (Number.isFinite(expectedRevision) && expectedRevision !== current) {
      // Another writer (or a hand-edit) moved the configuration after this page
      // read it. Refusing is the whole point of the fence: silently overwriting
      // is how an edit disappears.
      return { ok: false, problems: [`配置已被其他来源修改（当前 revision ${current}，你的草稿基于 ${expectedRevision}），请刷新后重试`], conflict: true }
    }
    const validation = validateConfig(candidate)
    if (!validation.ok) return { ok: false, problems: validation.problems }
    try {
      store.write(candidate)
    } catch (error) {
      return { ok: false, problems: [error instanceof Error ? error.message : String(error)] }
    }
    cached = store.read()
    cachedSignature = store.signature()
    onConfigChange()
    return { ok: true, problems: [], revision: revisionOfDocument(document(), cached?.problems ?? []) }
  }

  /** Everything a configuration change invalidates, in one place. */
  function onConfigChange() {
    decisions.clear()
    routed.clear()
    exhausted.clear()
    banned.clear()
    diagnostics.reset()
    void syncDelegation(true)
    // The depth guard follows the switch: the limit itself is read live, but
    // whether the guard is installed at all depends on `enabled`.
    syncDepthGuard()
  }

  // Files change without anyone telling the plugin: a hand-edit, an editor save,
  // a `git checkout`. Polling the folder's signature is the one mechanism that
  // covers all of them, and it is also what makes the settings page live.
  if (store !== undefined) {
    ctx.effect(() => {
      let stopped = false
      const tick = () => {
        if (stopped) return
        try {
          if (reload()) onConfigChange()
        } catch (error) {
          diagnostics.fail('configuration reload', error)
        }
        timer.timeout(tick, CONFIG_POLL_MS)
      }
      const disarm = timer.timeout(tick, CONFIG_POLL_MS)
      return () => { stopped = true; disarm() }
    }, 'dsh-model-router: configuration watcher')
  } else {
    // The settings route already pushes changes; keep its watcher semantics.
    ctx.effect(() => settingsScope.watch(onConfigChange))
  }

  // ── routing ───────────────────────────────────────────────────────────────
  /**
   * Bound one classifier call. The timer is a fiber effect, so a pending
   * classifier cannot outlive this plugin, and the abort is real: an adapter
   * that ignores the rejected promise still sees its signal cancelled.
   */
  const withTimeout = (call, ms) => new Promise((resolve, reject) => {
    const disarm = timer.timeout(() => {
      reject(new Error(`classifier timed out after ${ms}ms`))
    }, ms)
    Promise.resolve(call).then(
      (value) => { disarm(); resolve(value) },
      (error) => { disarm(); reject(error) },
    )
  })


  // ── routing ───────────────────────────────────────────────────────────────

  /** Advance the GLOBAL rotation and turn the chosen candidate into a route. */
  function pick(task, session, turn) {
    const chosen = scheduler.next(task, String(session.id), turn, 'turn')
    const candidate = chosen.candidate
    if (candidate === undefined) return undefined
    // Remember WHICH task produced this turn's route. A retry has to rotate the
    // pool that actually failed; inferring it later from the rotation stats
    // picks whichever task happens to look busy, which is a different task as
    // soon as a conversation uses more than one.
    remember(routed, `${String(session.id)}\u0000${String(turn)}`, task.id)
    if (chosen.fresh) console.log(`${ROUTER_NAME}: ${task.id} -> ${candidate.provider}/${candidate.model}`)
    return {
      provider: candidate.provider,
      model: candidate.model,
      // A changed route drops the inherited reasoning effort, so the adapter
      // falls back to its own route default — often `high`, which a cheap pool
      // then pays for on every step. A task-level value is the operator's
      // override; absent, the route default stands.
      ...typeof task.reasoningEffort === 'string' && task.reasoningEffort.length > 0
        ? { reasoningEffort: task.reasoningEffort }
        : {},
    }
  }

  /**
   * Resolve one request's route.
   *
   * Delegated sessions only: the session you are talking to keeps the model you
   * picked, by design. See `resolveSync` in the core for why.
   *
   * @returns `{ provider, model }` to apply, or `undefined` to leave it alone.
   */
  async function route(session, turn, signal) {
    const config = document()
    if (config.enabled !== true) return undefined
    // The breaker keeps a broken build out of the request path. Routing is an
    // optimisation; a session that keeps its inherited model always works.
    if (diagnostics.tripped() !== '') return undefined

    const presetId = session.header?.agentPreset
    const base = {
      presetId: typeof presetId === 'string' ? presetId : undefined,
      isSubagent: session.header?.origin === 'subagent',
      text: '',
      toolNames: '',
    }

    // The gating tiers run first with empty context on purpose: deciding "is
    // this session even eligible" must not cost a message scan, and for the
    // main session the answer is no before any work happens.
    const gate = resolveSync(config, base)
    if (gate.tier !== 'default' && gate.tier !== 'unmatched') return undefined

    base.toolNames = headerToolNames(session)
    // The opener (what the child was asked to do) plus the recent tail, then
    // trimmed to the configured TOKEN budget. Bounded by construction, so a
    // conversation that has grown long cannot push the classifier past the
    // input size its model was configured for.
    const classification = classificationInput(
      rootTaskText(session),
      recentText(session, CLASSIFIER_MESSAGES),
      config.classifier?.maxInputTokens ?? 4000,
    )
    base.text = classification.text
    const validation = validateConfig(config)
    const resolved = resolveSync(config, base)
    const turnKey = `${String(session.id)}\u0000${String(turn)}`
    const bannedIds = banned.get(turnKey)
    const isBanned = task => task !== undefined && bannedIds?.has(task.id) === true
    /** The configured fallback, when it exists and has not already failed. */
    const defaultTask = () => {
      const id = config.defaultTaskId
      if (typeof id !== 'string' || id.length === 0) return undefined
      const named = [...validation.byId.values()].find(task => task.id === id && task.enabled !== false)
      return named === undefined || isBanned(named) ? undefined : named
    }

    // A deterministic match is final: the classifier exists for what keywords
    // cannot express, not to second-guess an explicit instruction. A task whose
    // whole pool already failed this turn is the one exception — routing back
    // into it would repeat a failure the caller has already paid for.
    if (resolved.tier === 'deterministic') {
      if (!isBanned(resolved.task)) return pick(resolved.task, session, turn)
      const fallback = defaultTask()
      if (fallback === undefined) {
        console.log(`${ROUTER_NAME}: every configured route failed this turn; leaving the inherited route`)
        return undefined
      }
      console.log(`${ROUTER_NAME}: ${resolved.task?.id} is spent; using the default task ${fallback.id}`)
      return pick(fallback, session, turn)
    }

    // Semantic tier, consulted only when nothing deterministic matched — which
    // is the literal meaning of "when the rules miss". Cached per turn so a
    // multi-step turn pays for it once, and skipped entirely once this turn has
    // a decision, so a tool call mid-turn cannot re-roll the model.
    const classifier = config.classifier
    if (classifier?.enabled === true && classifier.provider && classifier.model) {
      const key = turnKey
      let cached = decisions.get(key)
      if (cached === undefined) {
        const outcome = await classifyWith(
          llm, config, candidateTasks(config, base.presetId), base.text, signal, withTimeout,
        )
        cached = { taskId: outcome.task?.id, error: outcome.error }
        remember(decisions, key, cached)
        if (outcome.error !== undefined) {
          // Absence is survivable: the default below still applies, so a
          // missing or failing classifier degrades routing rather than the turn.
          console.log(`${ROUTER_NAME}: classifier unavailable (${outcome.error}); using the default task`)
        }
      }
      if (cached.taskId !== undefined && bannedIds?.has(cached.taskId) !== true) {
        const chosen = [...validation.byId.values()].find(task => task.id === cached.taskId)
        if (chosen !== undefined) return pick(chosen, session, turn)
      }
    }

    const settled = isBanned(resolved.task) ? defaultTask() : resolved.task
    if (settled === undefined) {
      // Every configured route for this turn is spent. Leaving the request
      // alone is the documented last resort: the session runs on the route it
      // already had — which for a delegated child is the parent's own model —
      // so the caller keeps working instead of failing.
      if (bannedIds !== undefined && bannedIds.size > 0) {
        console.log(`${ROUTER_NAME}: every configured route failed this turn; leaving the inherited route`)
      }
      return undefined
    }
    return pick(settled, session, turn)
  }

  /**
   * Reasoning levels, strongest first.
   *
   * The vocabulary is the adapter's, so this is only a RANKING: an id the target
   * model does not list is never sent, and an id this table cannot rank is never
   * guessed at.
   */
  const EFFORT_LADDER = ['max', 'high', 'medium', 'low', 'off']

  /**
   * What each routed model can actually take, cached per route.
   *
   * `llm.resolveModelInfo` is ASYNC and reaches the adapter, so the answer is
   * cached: it is a property of one (provider, model) pair, and a routing
   * decision must stay cheap enough to run once per request. `undefined` means
   * "this build could not tell" — the caller then honours the declared value
   * rather than inventing one.
   *
   * @type {Map<string, {ids: string[]} | undefined>}
   */
  const effortSupport = new Map()

  /** The reasoning levels one route supports, or undefined when unknowable. */
  async function effortSupportOf(provider, model, signal) {
    const key = `${provider}/${model}`
    if (effortSupport.has(key)) return effortSupport.get(key)
    const llm = ctx.get('llm')
    if (typeof llm?.resolveModelInfo !== 'function') return undefined
    let support
    try {
      const info = await llm.resolveModelInfo(provider, model, signal)
      // An ABSENT `reasoning` block means the model takes no effort at all, and
      // that is an answer — the one that used to kill a child mid-turn.
      const efforts = info?.reasoning?.efforts
      support = {
        ids: Array.isArray(efforts)
          ? efforts.map(effort => effort?.id).filter(id => typeof id === 'string' && id.length > 0)
          : [],
      }
    } catch (error) {
      // An aborted lookup says nothing about the model, so it is not cached.
      if (signal?.aborted === true) return undefined
      diagnostics.fail('reasoning effort lookup', error)
      console.error(`${ROUTER_NAME}: could not resolve the reasoning levels of ${key}`)
      support = undefined
    }
    // Bounded: a long-lived process must not grow one entry per model ever seen.
    if (effortSupport.size > 64) effortSupport.clear()
    effortSupport.set(key, support)
    return support
  }

  /**
   * The effort to send a routed model, from the one the operator declared.
   *
   * DSH validates the request against the model and REFUSES to clamp — "no
   * clamping or aliasing is performed", a mismatch is a hard
   * `UNSUPPORTED_REASONING_EFFORT` before the first token. So a task that
   * declares `low` for a cheap pool has exactly three possible fates, and only
   * one of them is right:
   *
   *   · sent as declared, and the turn dies      ← a model without that level
   *   · silently dropped, running at the model's own default, often `high`
   *                                              ← what a route change used to do
   *   · moved to the nearest level it CAN take   ← this
   *
   * The walk goes DOWN from the requested level, because the reason to declare
   * one is cost: asking for less reasoning than the operator wanted is a
   * rounding error, asking for more is the bill they were avoiding. When the
   * model's floor is above the request, the weakest level it has is still the
   * closest honest reading — and beats dropping the key, which would hand the
   * decision to the adapter's default.
   *
   * @param requested - the task's declared effort.
   * @param support - what the model accepts, or undefined when unknowable.
   * @returns the level to send, or undefined to leave the key off entirely.
   */
  function resolveEffort(requested, support) {
    // Unknowable (an `llm` that cannot resolve models, or a lookup that failed):
    // an explicit instruction from the operator is honoured as written. The
    // adapter reports a genuine mismatch, which is visible, rather than this
    // plugin quietly ignoring what it was told.
    if (support === undefined) return requested
    const ids = support.ids
    if (ids.length === 0) return undefined
    if (ids.includes(requested)) return requested
    const from = EFFORT_LADDER.indexOf(requested)
    if (from !== -1) {
      for (let at = from + 1; at < EFFORT_LADDER.length; at += 1) {
        if (ids.includes(EFFORT_LADDER[at])) return EFFORT_LADDER[at]
      }
    }
    const ranked = EFFORT_LADDER.filter(level => ids.includes(level))
    return ranked[ranked.length - 1] ?? undefined
  }

  ctx.on('agent/request', async (payload, next) => {
    const base = await next()
    const session = payload?.agent?.session
    if (session === undefined || base === null || typeof base !== 'object') return base
    let target
    try {
      target = await route(session, payload.turn, payload.signal)
      diagnostics.ok()
    } catch (error) {
      diagnostics.fail('agent/request', error)
      console.error(`${ROUTER_NAME}: routing failed, keeping the requested route`)
      return base
    }
    if (target === undefined) return base
    const same = target.provider === base.provider && target.model === base.model
    const declared = target.reasoningEffort
    if (same && (declared === undefined || declared === base.reasoningEffort)) return base
    const routed = {
      ...base,
      ...same ? {} : { provider: target.provider, model: target.model },
    }
    if (declared === undefined) {
      // A route CHANGE must drop the inherited effort. Keeping it means asking
      // the new model for a reasoning mode it may not have — measured live: a
      // child died with `provider "b-ai" model "mimo-v2.5" does not support
      // reasoning` before producing a single token. Without the key the adapter
      // applies the model's own default, the only value that can be right.
      if (!same) delete routed.reasoningEffort
      return routed
    }
    // A DECLARED effort is an instruction, so it is preserved wherever the target
    // can honour it and moved to the nearest level it can when it cannot.
    const effort = resolveEffort(declared, await effortSupportOf(target.provider, target.model, payload.signal))
    if (effort === undefined) delete routed.reasoningEffort
    else routed.reasoningEffort = effort
    return routed
  })

  // A failed request advances the rotation so the retry lands on a different
  // model instead of hammering a rate-limited one.
  ctx.on('agent/request-error', async (payload, next) => {
    const decision = await next()
    if (decision !== undefined && decision !== null) return decision
    const session = payload?.agent?.session
    if (session === undefined) return decision
    const config = document()
    if (config.enabled !== true) return decision
    const presetId = session.header?.agentPreset
    const tasks = candidateTasks(config, typeof presetId === 'string' ? presetId : undefined)

    // Rotate the task that actually produced this turn's route. Only a pool with
    // somewhere else to go can rotate; a single-model pool has no alternative,
    // and pretending otherwise would burn the turn on a retry that cannot differ.
    const key = `${String(session.id)}\u0000${String(payload.turn)}`
    const taskId = routed.get(key)
    if (taskId === undefined) return decision
    const task = tasks.find(candidate => candidate.id === taskId)
    if (task === undefined) return decision

    // Remember WHICH route just failed. A pool is exhausted only when every
    // candidate has failed, which is the difference between "try the next
    // model" and "this task cannot serve this turn at all".
    diagnostics.providerFailed(payload.provider)
    const failed = exhausted.get(`${key}\u0000${taskId}`) ?? new Set()
    failed.add(`${String(payload.provider)}\u0000${String(payload.model)}`)
    remember(exhausted, `${key}\u0000${taskId}`, failed)
    const untried = (task.pool ?? []).filter(entry => !failed.has(`${entry.provider}\u0000${entry.model}`))

    if (untried.length > 0 && task.pool.length > 1) {
      // Advance the rotation AND pin what it advanced to: without the pin the
      // retry's own pick would consume the slot after it and land back on the
      // model that just failed.
      const next = scheduler.rotateTo(task)
      if (next === undefined) return decision
      scheduler.unpin(String(session.id), payload.turn)
      scheduler.pin(String(session.id), payload.turn, task.id, next)
      routed.delete(key)
      // The CLASSIFIER's decision is deliberately NOT deleted. It is a judgment
      // about the request text, which a failed model does not change — and
      // re-asking is not free of consequences: a classifier is an LLM, so the
      // same input can come back as a different task, and a turn would silently
      // switch what it is doing because one provider was rate-limited. Measured
      // live: a child whose first dispatch resolved to the default task was sent
      // to a different task by its retry, from the same opener. Rotating the pool
      // is the retry's job; the classification stands for the turn.
      console.log(`${ROUTER_NAME}: rotating ${task.id} after a failed request`)
      return { kind: 'retry' }
    }

    // The task's whole pool is spent. Ban it for this turn so the retry cannot
    // resolve straight back into it, then hand the turn to the default task.
    //
    // The ban — not a forgotten classification — is what moves the retry: with
    // the turn's decision still cached, the retry sees the classified task as
    // banned and settles on the default task, which is the documented cascade.
    // Deleting the decision instead would re-ask an LLM mid-turn and let the
    // answer, rather than the failure, decide where the turn goes.
    const bannedIds = banned.get(key) ?? new Set()
    bannedIds.add(taskId)
    remember(banned, key, bannedIds)
    routed.delete(key)
    scheduler.unpin(String(session.id), payload.turn)

    const fallback = tasks.find(candidate => candidate.id === config.defaultTaskId
      && candidate.enabled !== false
      && !bannedIds.has(candidate.id)
      && (candidate.pool ?? []).some(entry => !(exhausted.get(`${key}\u0000${candidate.id}`) ?? new Set())
        .has(`${entry.provider}\u0000${entry.model}`)))

    if (fallback !== undefined && fallback.id !== taskId) {
      console.log(`${ROUTER_NAME}: ${task.id} exhausted; falling back to the default task ${fallback.id}`)
      return { kind: 'retry' }
    }

    // Nothing left to try. No retry: the failure surfaces to the caller, which
    // then does the work itself — the documented last resort in the cascade.
    console.log(`${ROUTER_NAME}: every configured route failed; leaving the turn to the caller`)
    return decision
  })

  // ── the plugin's own delegation capability ────────────────────────────────
  //
  // For every agent whose preset is GRANTED, this plugin registers its own
  // `subagent` tool in that agent's scope and masks the built-in delegation
  // tools that scope inherits. Nothing is written to any preset file: the
  // capability is mounted at runtime, and disposing the fiber removes it — so
  // revoking a grant restores the deployment exactly as it was.

  /** agent -> the fiber that owns its delegation tool. */
  const delegationFibers = new Map()

  /**
   * Per-installation state, keyed by the fiber that owns the installation.
   *
   * Cordis DEFERS a plugin's startup: `agent.ctx.plugin(...)` returns a fiber
   * whose `apply` has not run yet, and the docs state the startup body may even
   * return a promise. A synchronous "did apply run?" flag is therefore ALWAYS
   * false at that moment, and gating the returned fiber on it discards a LIVE
   * installation: the tool stays registered in that agent's scope, nothing can
   * ever revoke it, and health reports `installed: 0` beside a working
   * delegation tool. Both halves of that were observed in a real session — the
   * tool's own description (generated from the config's task list) was in the
   * agent's tool list while health still said `installed: 0, owned: false`.
   *
   * So the fiber is tracked EAGERLY, and `applied` distinguishes the two
   * remaining failure modes: a fiber whose startup never ran (a service that
   * never became available in that scope) from one that ran and is live.
   *
   * @type {WeakMap<object, {kind: string, applied: boolean, error: string|undefined}>}
   */
  const installStates = new WeakMap()

  /** The state record of one installation, or undefined when it is untracked. */
  function installStateOf(fiber) {
    return installStates.get(fiber)
  }

  /** The preset an agent runs under, from its live scope chain when possible. */
  function presetIdOf(agent) {
    const roster = ctx.get('agentPresets')
    if (roster !== undefined && typeof roster.composedPreset === 'function') {
      try {
        const composed = roster.composedPreset(agent.ctx)
        if (typeof composed === 'string') return composed
      } catch (error) {
        console.error(`${ROUTER_NAME}: could not read the composed preset`)
        console.error(error)
      }
    }
    const header = agent.session?.header?.agentPreset
    return typeof header === 'string' ? header : undefined
  }

  /** Whether this plugin owns delegation for that agent right now. */
  function shouldOwn(agent, config) {
    if (config.enabled !== true) return false
    // A child is an executor: it never receives the tool, so the delegation
    // graph stays one level deep by construction rather than by instruction.
    if (agent.session?.header?.origin === 'subagent') return false
    const presetId = presetIdOf(agent)
    if (typeof presetId !== 'string' || presetId.length === 0) return false
    return config.presets?.[presetId] !== undefined
  }

  /**
   * The child profile of the delegation currently in flight, keyed by parent.
   *
   * A child composes the PARENT's preset — `agentPresets.composeFrom(childCtx,
   * parent.ctx)` binds the child's scope to the parent's standing mount, and the
   * delegation path has no per-child preset. So a task shapes its children at
   * creation instead: the tool filter rides the start request, and the persona is
   * installed on the child's own scope.
   *
   * The handoff exists because the child is registered DURING the start call, so
   * `agent/created` fires before the tool learns the child id. Announcing the
   * profile around the call is what lets that listener know which task — and
   * therefore which persona — the child belongs to.
   */
  const inFlight = new Map()

  /** Run one delegation with its child profile announced to `agent/created`. */
  async function announce(profile, start) {
    const parentId = profile?.parent?.session?.id
    const key = parentId === undefined ? undefined : String(parentId)
    if (key !== undefined) inFlight.set(key, profile)
    try {
      return await start()
    } finally {
      if (key !== undefined) inFlight.delete(key)
    }
  }

  /**
   * The persona a child should run with, from its parent's in-flight profile.
   *
   * Only a task that DECLARES one changes the child's prompt. Everything else
   * inherits the parent's composition untouched, which stays the default.
   */
  function childProfileOf(agent) {
    const parentId = agent.session?.header?.parentSession
    if (parentId === undefined) return undefined
    return inFlight.get(String(parentId))
  }

  /** Install the delegation tool and mask the built-ins for one agent. */
  function installDelegation(agent) {
    const subagents = ctx.get('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.start !== 'function') return undefined
    const state = { kind: 'delegation', applied: false, error: undefined }
    // A bridge plugin is required: only a context that DECLARES `tools` may
    // register into it or restrict it, and the fiber it returns owns every one
    // of those registrations — so one dispose removes the tool and lifts the
    // masks, with nothing written to any preset file.
    const fiber = agent.ctx.plugin({
      name: `${ROUTER_NAME}:delegation`,
      inject: ['tools'],
      apply(toolCtx) {
        const disposers = []
        /** Release everything registered so far, in reverse order. */
        const teardown = () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch { /* already gone */ }
          }
        }
        try {
          const live = document()
          const continuable = typeof subagents.startContinuable === 'function'
            && typeof subagents.sendMessage === 'function'
          disposers.push(toolCtx.tools.register(buildDelegationTool({
            toolName: DELEGATION_TOOL,
            messageTool: MESSAGE_TOOL,
            config: live,
            subagents,
            childDelegation: live.childDelegation === true,
            announce,
            reportFilterFailure: (error) => {
              diagnostics.fail('child tool filter', error)
              console.error(`${ROUTER_NAME}: the task's child tool filter was refused; retrying the delegation without it`)
            },
          })))
          // The continuation tool only exists when the service can actually
          // continue a child: registering a tool that always fails would be a
          // worse answer than the description honestly saying there is none.
          if (continuable) {
            disposers.push(toolCtx.tools.register(buildMessageTool({
              toolName: DELEGATION_TOOL,
              messageTool: MESSAGE_TOOL,
              subagents,
            })))
          }
          state.applied = true
          // Mask every built-in delegation tool this scope inherits. `restrict`
          // REJECTS unknown names outright, so an absent tool is simply a
          // rejected restriction that means "nothing to mask".
          for (const name of BUILTIN_DELEGATION) {
            if (name === DELEGATION_TOOL || name === MESSAGE_TOOL) continue
            try {
              disposers.push(toolCtx.tools.restrict({ deny: [name] }))
            } catch { /* absent from this scope's chain: nothing to mask */ }
          }
        } catch (error) {
          teardown()
          state.error = error instanceof Error ? error.message : String(error)
          // Recorded HERE, not only at the call site: startup runs after
          // `ctx.plugin()` has already returned, so the caller's `try` cannot see
          // this throw — a deferred failure would otherwise reach a console that
          // neither the settings page nor the health read can read.
           diagnostics.fail('delegation startup', error)
          throw error
        }
        return teardown
      },
    })
    // Tracked EAGERLY. `apply` has NOT run yet at this point — see
    // `installStates` for why gating the fiber on it loses a live tool.
    installStates.set(fiber, state)
    return fiber
  }

  /**
   * Install the CHILD-side rules for one delegated agent.
   *
   * Two jobs, and both are deliberately independent of whatever preset the child
   * composed:
   *
   *  1. **Recursion is the plugin's decision, not the preset's.** Unless the
   *     operator enabled child delegation, every delegation tool the child can
   *     see is masked, so a child cannot spawn grandchildren even if its
   *     composition carries a delegation row of its own.
   *  2. **A task-shaped prompt, when the task declares one.** A child inherits the
   *     parent's whole composition; a persona that REPLACES it (registered under
   *     the same section name, `complete: true`, so nothing else rides along) is
   *     how "state what it needs, inherit nothing" is expressed. No declaration
   *     means no registration: inherit stays the default.
   *
   * @param agent - the delegated child.
   * @returns its fiber, or undefined when nothing needed installing.
   */
  function installChildRules(agent) {
    const live = document()
    if (live.enabled !== true) return undefined
    const profile = childProfileOf(agent)
    const persona = typeof profile?.task?.childPersona === 'string' && profile.task.childPersona.trim().length > 0
      ? profile.task.childPersona
      : ''
    const maskDelegation = live.childDelegation !== true
    if (!maskDelegation && persona === '') return undefined
    const state = { kind: 'child', applied: false, error: undefined }
    /** Delegation names this child's own scope refused to give up. */
    const unmasked = []
    state.unmasked = unmasked
    const fiber = agent.ctx.plugin({
      name: `${ROUTER_NAME}:child`,
      inject: ['tools'],
      apply(childCtx) {
        const disposers = []
        /** Release everything registered so far, in reverse order. */
        const teardown = () => {
          for (const dispose of disposers.splice(0).reverse()) {
            try {
              dispose()
            } catch { /* already gone */ }
          }
        }
        try {
          if (maskDelegation) {
            // One deduplicated pass: the plugin's own names and the built-in
            // names overlap (`subagent` is both), and `restrict` rejects a name
            // the scope cannot see anyway.
            for (const name of new Set([DELEGATION_TOOL, MESSAGE_TOOL, ...BUILTIN_DELEGATION])) {
              try {
                disposers.push(childCtx.tools.restrict({ deny: [name] }))
              } catch {
                // A name the CHILD'S OWN scope registered cannot be restricted
                // from outside, and a preset that mounts a delegation row of its
                // own registers exactly that. Measured live: the child kept
                // `subagent` from its own preset no matter what this side did.
                // The recursion guarantee does not rest on this mask (`maxDepth`
                // refuses a grandchild at the provider), but silence would leave
                // the operator believing the mask worked — so the names that
                // could NOT be masked are reported in health instead.
                unmasked.push(name)
              }
            }
          }
          if (persona !== '' && typeof childCtx.systemPrompt?.section === 'function') {
            // The SAME name as the deployment persona: the scope-chain merge
            // replaces that definition wholesale, so `complete: true` here leaves
            // exactly one complete section — the child's own text — instead of
            // colliding with the parent's.
            disposers.push(childCtx.systemPrompt.section({
              name: 'deployment:persona-prefix',
              order: childCtx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
              text: persona,
              complete: true,
            }))
          }
          state.applied = true
        } catch (error) {
          teardown()
          state.error = error instanceof Error ? error.message : String(error)
          // Recorded HERE for the same reason as the delegation install: startup
          // is deferred, so the caller cannot catch this.
           diagnostics.fail('child rules startup', error)
          throw error
        }
        return teardown
      },
    })
    installStates.set(fiber, state)
    return fiber
  }

  /** Forget one agent's delegation tool, e.g. when its session ends. */
  function forgetAgent(agent) {
    const fiber = delegationFibers.get(agent)
    if (fiber === undefined) return
    delegationFibers.delete(agent)
    void Promise.resolve(fiber.dispose()).catch(() => {})
  }

  /**
   * Reconcile the delegation tool with the current grants.
   * @param force - dispose and rebuild every installation (a settings change can
   *   rewrite the tool's description and its task enum).
   */
  async function syncDelegation(force = false) {
    const config = document()
    if (force) {
      const existing = [...delegationFibers.values()]
      delegationFibers.clear()
      for (const fiber of existing) {
        try {
          await fiber.dispose()
        } catch (error) {
           diagnostics.fail('remove delegation tool', error)
          console.error(`${ROUTER_NAME}: could not remove the delegation tool`)
          console.error(error)
        }
      }
    }
    const agents = ctx.get('agents')
    if (agents === undefined || typeof agents.list !== 'function') return
    let live = []
    try {
      live = agents.list()
    } catch (error) {
      console.error(`${ROUTER_NAME}: could not list agents`)
      console.error(error)
      return
    }
    // Prune first: a session that ended without a disposal event must not keep
    // its fiber — and its tool registration — alive forever.
    const alive = new Set(live)
    for (const agent of [...delegationFibers.keys()]) {
      if (!alive.has(agent)) forgetAgent(agent)
    }
    for (const agent of live) {
      if (delegationFibers.has(agent)) {
        // Revoke a grant that was withdrawn while the process was running.
        if (shouldOwn(agent, config)) continue
        forgetAgent(agent)
        continue
      }
      if (!shouldOwn(agent, config)) continue
      try {
        const fiber = installDelegation(agent)
        if (fiber !== undefined) delegationFibers.set(agent, fiber)
      } catch (error) {
        // Recorded, not only logged: installed: 0 beside granted: true is the
        // symptom of a silent install failure, and the console it went to is not
        // reachable from the settings page or from the health read.
         diagnostics.fail('install delegation tool', error)
        console.error(`${ROUTER_NAME}: could not install the delegation tool`)
        console.error(error)
      }
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    try {
      // A delegated child gets the child-side rules instead of the tools. This
      // listener runs WHILE the delegation call is still in flight, which is what
      // makes the in-flight profile its parent announced available here.
      if (agent.session?.header?.origin === 'subagent') {
        const config = document()
        if (config.enabled !== true) return
        const presetId = presetIdOf(agent)
        if (typeof presetId !== 'string' || config.presets?.[presetId] === undefined) return
        const fiber = installChildRules(agent)
        if (fiber !== undefined) delegationFibers.set(agent, fiber)
        return
      }
      if (!shouldOwn(agent, document())) return
      const fiber = installDelegation(agent)
      if (fiber !== undefined) delegationFibers.set(agent, fiber)
    } catch (error) {
      // Recorded, not only logged: installed: 0 beside granted: true is the
      // symptom of a silent install failure, and the console it went to is not
      // reachable from the settings page or from the health read.
       diagnostics.fail('install delegation tool', error)
      console.error(`${ROUTER_NAME}: could not install the delegation tool`)
      console.error(error)
    }
  })
  ctx.on('agent/disposed', ({ agent }) => { forgetAgent(agent) })
  ctx.effect(() => () => {
    const fibers = [...delegationFibers.values()]
    delegationFibers.clear()
    for (const fiber of fibers) void fiber.dispose()
  }, 'dsh-model-router: delegation tools')
  void syncDelegation()

  // ── the delegation depth policy, enforced where every path meets ──────────
  //
  // `maxDepth` rides the start requests THIS plugin makes, and that is all it
  // governs. A child's own preset composition registers the built-in delegation
  // tool into the CHILD's scope, and a scope-local registration cannot be masked
  // from outside — two live experiments settled that: naming it in a filter's
  // `deny` is refused ("unknown global tool", which drops the whole filter), and
  // an allow list leaves it in place. Measured cost of not knowing: with
  // `childDelegation: false`, a child called `subagent` and a depth-2 grandchild
  // really was created.
  //
  // So the policy is enforced one level down, on the service every delegation
  // path funnels through. The wrapper is installed on the live service instance,
  // removed with the plugin's fiber, and a guard that could NOT be installed is
  // recorded — a guard rail that is silently absent is worse than none.
  let depthGuard = undefined

  /** Refuse a delegation that would exceed the operator's depth budget. */
  function installDepthGuard(subagents, limitOf) {
    const restore = []
    const error = () => {
      throw new Error(
        'this subagent is an executor and does not delegate further; return the parts that need '
        + 'independent work to the parent instead',
      )
    }
    for (const method of ['start', 'startContinuable']) {
      const original = subagents[method]
      if (typeof original !== 'function') continue
      const guarded = function (...args) {
        // `start(provider, request)` and `startContinuable(spec)` differ in both
        // arity and nesting: the request is the second argument of the first, and
        // `spec.request` of the second.
        const request = args.length > 1 ? args[1] : args[0]
        const parent = request?.parent ?? request?.request?.parent
        const depth = parent?.session?.header?.delegationDepth
        if ((typeof depth === 'number' ? depth : 0) >= limitOf()) error()
        return original.apply(this, args)
      }
      try {
        subagents[method] = guarded
        if (subagents[method] !== guarded) throw new Error(`${method} is not writable`)
        restore.push(() => { subagents[method] = original })
      } catch (failure) {
        // Reported, never assumed: another plugin may have frozen the service,
        // and then the depth policy is simply not in force.
        diagnostics.fail('delegation depth guard', failure)
        console.error(`${ROUTER_NAME}: could not guard ${method} against deep delegation`)
      }
    }
    return restore.length === 0
      ? undefined
      : () => { for (const undo of restore.reverse()) undo() }
  }

  /** Install, remove, or leave the depth guard alone, to match the document. */
  function syncDepthGuard() {
    const subagents = ctx.get('subagents')
    const wanted = document().enabled === true && subagents !== undefined
      && typeof subagents.start === 'function'
    if (wanted && depthGuard === undefined) {
      // `undefined` means nothing could be patched: health must then say the
      // policy is NOT in force, which is the whole point of reporting it.
      depthGuard = installDepthGuard(subagents, () => document().childDelegation === true ? 2 : 1)
      if (depthGuard !== undefined) {
        ctx.effect(() => () => {
          depthGuard?.()
          depthGuard = undefined
        }, 'dsh-model-router: delegation depth guard')
      }
      return
    }
    if (!wanted && depthGuard !== undefined) {
      depthGuard()
      depthGuard = undefined
    }
  }

  void syncDepthGuard()

  // ── the health channel ────────────────────────────────────────────────────
  //
  // ONE method, and only because it cannot be anything else: the settings page
  // needs to show what this plugin is doing and WHY it stopped, and runtime
  // state is not settings — writing it into the namespace would persist noise
  // and fire the watchers on every update. Everything the Client half reads as
  // DATA travels the Typert Remote faces (`remote.session.modelCatalog`,
  // `remote.agentPresets`); this endpoint carries only diagnostics.
  //
  // The Client half is a SEPARATE bundle, so it still renders when this half
  // fails to mount: an unreachable endpoint is itself the diagnosis the page
  // shows. That is the one failure an in-process reporter could never report.
  const health = () => ({
    ok: true,
    name: ROUTER_NAME,
    now: Date.now(),
    // The tool names a GRANTED agent can actually see.
    //
    // NOT `ctx.tools.schemas()`: with no scope that answers from the GLOBAL layer
    // alone, and DSH registers its tools in agent scopes and nested contexts, so
    // the global view is legitimately EMPTY — which is exactly why the settings
    // picker stayed unavailable after a restart. The assembled request header is
    // the authoritative list, the same one the model is handed.
    tools: (() => {
      const names = new Set()
      try {
        const agents = ctx.get('agents')
        for (const agent of (typeof agents?.list === 'function' ? agents.list() : [])) {
          for (const name of headerToolList(agent.session)) names.add(name)
        }
      } catch (error) {
        diagnostics.fail('agent tool enumeration', error)
      }
      // This plugin's own tools are never given to a child, so offering them as
      // child tools would be a choice that silently does nothing.
      names.delete(DELEGATION_TOOL)
      names.delete(MESSAGE_TOOL)
      return [...names].sort()
    })(),
    routing: {
      enabled: document().enabled === true,
      tasks: (document().tasks ?? []).length,
      defaultTaskId: document().defaultTaskId ?? "",
      stats: scheduler.stats(),
    },
    delegation: {
      tool: DELEGATION_TOOL,
      provider: DELEGATION_PROVIDER,
      installed: delegationFibers.size,
      // The policy that actually stops a child from delegating further, and
      // whether it is in force. It cannot be expressed by masking the child (its
      // own preset registers a delegation tool the plugin cannot remove) nor by
      // `maxDepth` (that governs only this plugin's own start requests), so it is
      // enforced on the delegation service itself — and reported here, because an
      // uninstalled guard is exactly the state that let a grandchild exist.
      depthGuard: depthGuard !== undefined,
      depthLimit: document().childDelegation === true ? 2 : 1,
      // How many of those fibers have RUN their startup body. `installed` counts
      // fibers that exist; Cordis starts a plugin asynchronously, so a fiber can
      // exist for a moment — or forever, when a service never becomes available
      // in that scope — without having registered anything. That distinction is
      // the difference between "the takeover is live" and "the built-in tool is
      // still the one being called", which a bare `installed` cannot express.
      applied: [...delegationFibers.values()]
        .filter(fiber => installStateOf(fiber)?.applied === true).length,
      // Whether the service this plugin starts children through is visible in
      // the plugin's OWN scope. When it is not, no installation is attempted at
      // all — the second, independent reason `installed` can be 0, and the one
      service: typeof ctx.get('subagents')?.start === 'function',
      childDelegation: document().childDelegation === true,
      // WHY it is or is not installed, per live agent. A bare `installed: 0`
      // cannot be told apart from "no session is open", which is the first
      // question asked whenever the takeover looks inactive.
      agents: (() => {
        const config = document()
        try {
          const agents = ctx.get('agents')
          const live = typeof agents?.list === 'function' ? agents.list() : []
          return live.slice(0, 10).map((agent) => {
            const preset = presetIdOf(agent) ?? null
            const fiber = delegationFibers.get(agent)
            const state = fiber === undefined ? undefined : installStateOf(fiber)
            return {
              id: String(agent.session?.id ?? ''),
              preset,
              origin: agent.session?.header?.origin ?? 'main',
              granted: preset !== null && config.presets?.[preset] !== undefined,
              owned: fiber !== undefined,
              kind: state?.kind ?? null,
              applied: state?.applied === true,
              error: state?.error ?? null,
              // Delegation tools this child's OWN preset registered and no
              // outside mask could remove. Reported rather than hidden: the
              // recursion guarantee rests on `maxDepth`, not on this list being
              // empty, and an operator deserves to know which of the two is
              // actually holding.
              unmasked: state?.unmasked ?? [],
            }
          })
        } catch (error) {
          diagnostics.fail('agent enumeration', error)
          return []
        }
      })(),
    },
    // Where the configuration actually lives, so the page can SAY it instead of
    // leaving the operator to guess which storage is in play.
    configuration: {
      source: store === undefined ? 'settings' : 'files',
      root: store === undefined ? '' : store.root,
      files: store === undefined ? [] : [
        GLOBAL_FILENAME,
        ...(document().tasks ?? []).map(task => `${TASKS_DIRNAME}/${task.id}${FILE_EXT}`),
      ],
      migration,
    },
    ...diagnostics.snapshot(),
  })

  /**
   * The configuration endpoints.
   *
   * `health` is a plain read. `config` is a read too, and a POST replaces the
   * whole document — the page edits a draft and commits it in one atomic write,
   * which is the same shape the settings service offered, so the page's
   * draft/save/cancel logic is unchanged.
   */
  const configGet = () => {
    const { document: value, problems, revision } = readDocument()
    return { ok: true, config: value, problems, revision, source: store === undefined ? 'settings' : 'files' }
  }
  const configPost = async (body) => {
    const candidate = body?.config
    if (candidate === null || typeof candidate !== 'object') {
      return { ok: false, problems: ['no config supplied'] }
    }
    return await writeDocument(candidate, body?.revision)
  }

  const handlers = new Map([["health", health], ["config", configGet]])
  const serve = async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      const method = decodeURIComponent(url.pathname.replace(/^\/api\/dsh-model-router\/?/, "")) || "health"
      if (method === 'config' && (req.method === 'POST' || req.method === 'PUT')) {
        const chunks = []
        for await (const chunk of req) chunks.push(chunk)
        const raw = Buffer.concat(chunks).toString('utf8')
        const result = await configPost(raw.length === 0 ? null : JSON.parse(raw))
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(JSON.stringify(result))
        return
      }
      const handler = handlers.get(method)
      if (handler === undefined) {
        res.writeHead(404, { "content-type": "application/json" })
        res.end(JSON.stringify({ error: `unknown method ${JSON.stringify(method)}` }))
        return
      }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
      res.end(JSON.stringify(await handler()))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: message }))
    }
  }

  if (typeof harness !== "undefined" && typeof harness.handle === "function") {
    ctx.effect(() => harness.handle("health", health), `${ROUTER_NAME}: health handler`)
  }
  // `ctx.inject` waits for the web server instead of sampling it once: this row
  // mounts before the host bundle in some orders, and a route registered against
  // an absent service would never come back.
  const registerRoute = (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: "prefix", path: "/api/dsh-model-router", handler: serve,
    }), `${ROUTER_NAME}: health route`)
  }
  if (typeof ctx.inject === "function") ctx.inject(["webServer"], registerRoute)
  else {
    const webServer = ctx.get("webServer")
    if (webServer !== undefined && typeof webServer.register === "function") {
      ctx.effect(() => webServer.register({
        kind: "prefix", path: "/api/dsh-model-router", handler: serve,
      }), `${ROUTER_NAME}: health route`)
    }
  }

  console.log(`${ROUTER_NAME}: mounted · routing ${document().enabled === true ? "ENABLED" : "disabled"}`)
  // Returns NOTHING on purpose. Cordis reads `apply` RETURN as the plugin effect
  // and accepts only a disposer, a promise, an iterator, or null/undefined;
  // anything else fails the mount with `TypeError: Invalid effect`.
}
