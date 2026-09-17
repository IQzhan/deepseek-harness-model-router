/**
 * model-routing-config — the pure, runtime-free core of DSH model routing.
 *
 * Everything here is a plain function over plain data: no Cordis, no `ctx`, no
 * services, no I/O. That is deliberate. The routing *policy* (what a task is,
 * which models serve it, how load spreads) is the part that must be reasoned
 * about and tested, so it is separated from the part that talks to the harness.
 * `dsh-model-router.js` is the thin adapter that feeds live Session data in and
 * applies the returned route.
 *
 * THE MODEL
 *   preset ── selects ──► task ── spreads over ──► pool (weighted chain)
 *
 *   · A TASK is a semantic label: "3d-modelling", "web-research". Its
 *     `description` is what the classifier reads, so a task is defined by
 *     meaning, not by an enumerated keyword set.
 *   · A POOL is the ordered, weighted list of models that may serve a task.
 *     Any provider/model in the live catalog is allowed; nothing is hard-coded.
 *   · A PRESET decides which tasks its sessions may use and whether they route
 *     at all. Presets never redefine tasks or pools — the library is global,
 *     the permission is per-preset. That is the whole decoupling.
 *
 * @module model-routing-config
 */

/** Settings namespace this whole feature lives under. */
export const NAMESPACE = 'model-routing'

/**
 * Every field this plugin's configuration declares.
 *
 * Declared as DATA so it can be checked in both directions: one test asserts
 * this covers the document `defaultConfig()` actually ships (the list cannot go
 * stale), another asserts the settings page's own field list covers THIS (a new
 * field cannot ship without a control). Configuration and UI drifting apart is
 * otherwise invisible until someone notices a setting they cannot reach.
 */
export const SCHEMA_FIELDS = {
  root: ['enabled', 'defaultTaskId', 'childDelegation', 'classifier', 'presets', 'tasks'],
  classifier: ['enabled', 'provider', 'model', 'maxInputTokens', 'timeoutMs'],
  task: ['id', 'name', 'description', 'enabled', 'keywords', 'reasoningEffort', 'childPersona', 'childTools', 'pool'],
  pool: ['provider', 'model', 'weight'],
}

/** Task id used when nothing else matched and a fallback is configured. */
export const FALLBACK_TASK_ID = 'general'

/** Stickiness modes, in the order the UI should present them. */
export const STICKINESS_MODES = ['turn', 'session', 'global']

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** The empty document every deployment starts from. */
export function defaultConfig() {
  return {
    enabled: false,
    /**
     * Task id used when nothing else matched. EMPTY MEANS NONE: with no default
     * configured, an unmatched turn keeps the route it already had and the
     * router stays out of the way.
     *
     * This replaced an `isDefault` flag on tasks because a flag could claim to
     * be the default while its pool was empty — a default that exists but
     * cannot serve is indistinguishable, at the point of use, from no default
     * at all. One reference that either resolves to a usable task or does not
     * is the honest shape.
     */
    defaultTaskId: '',
    /**
     * Whether a delegated child may itself delegate.
     *
     * Off by default: a subagent is an executor, and one level of delegation is
     * the shape that keeps routing predictable. On, children may go one level
     * deeper — for work that genuinely divides into independent parts.
     */
    childDelegation: false,
    classifier: {
      enabled: false,
      provider: '',
      model: '',
      maxInputTokens: 4000,
      timeoutMs: 15000,
    },
    presets: {},
    tasks: [],
  }
}

/**
 * The samples written on a FIRST install, and only then.
 *
 * These are templates, not a configuration: every `pool` is empty on purpose, so the
 * router has nothing to route until the operator fills one in, and an upgrade never
 * rewrites what they wrote (the store only ever writes this document when the folder
 * does not exist yet).
 *
 * Five shapes of work cover most of what gets delegated, and each is described
 * GENERICALLY: no framework, no file format, no vendor is named, because a sample that
 * teaches by example is only followed for that example. What each one carries:
 *
 *   · `description` — the only text the semantic classifier reads. It says what the
 *     work IS, which is what a router needs to recognise it.
 *   · `keywords` — a deterministic shortcut, matched against the request text. Written
 *     in English here; put them in the language you actually write requests in, or
 *     leave them empty and let the classifier decide.
 *   · `childPersona` — the child's whole system prompt, replacing the inherited one.
 *     It states what the executor must DELIVER and where its boundary is, in three or
 *     four lines. Keep it short: it is a prompt, not a manual.
 *   · `childTools` — a tool scope, and only where the exclusion is unambiguous.
 *     Deliberately absent from most samples: a name the child cannot see makes the
 *     provider refuse the WHOLE filter, so a scope is worth declaring only when the
 *     task clearly does not need those tools at all.
 *   · `reasoningEffort` — only where the work is genuinely cheap per item.
 */
export function starterConfig() {
  const config = defaultConfig()
  config.tasks = [
    {
      id: 'general',
      name: 'General tasks',
      description: 'Everyday work that does not need a speciality: gather and reshape information, '
        + 'read or edit a few files, answer a question, carry out a small change end to end.',
      enabled: true,
      keywords: [],
      childPersona: [
        'You are the executor for one closed task. Do exactly the part you were given and return the',
        'result to the parent; the parent keeps the coordination and the user conversation.',
        'State what you did, what you verified, and anything you could not determine.',
      ].join('\n'),
      pool: [],
    },
    {
      id: 'web-search',
      name: 'Web search and verification',
      description: 'Look things up on the open web and check them: find current facts, compare sources, '
        + 'confirm or refute a claim, and report where each answer came from.',
      enabled: true,
      keywords: ['search the web', 'look up', 'find out', 'latest', 'verify', 'fact check'],
      childPersona: [
        'You are the executor for one look-up. Answer from sources you actually opened, and cite them;',
        'say plainly when a claim could not be confirmed rather than filling the gap from memory.',
        'Return the finding and its sources. Do not write files or run commands: the parent stores the result.',
      ].join('\n'),
      // A look-up reads and reports; it never needs to write files or drive a shell.
      childTools: { deny: ['write', 'edit', 'pwsh'] },
      pool: [],
    },
    {
      id: 'bulk',
      name: 'High-volume simple work',
      description: 'A large number of small, similar items where one cheap pass per item is enough: '
        + 'rename or reformat in bulk, classify or extract one field, apply the same edit everywhere.',
      enabled: true,
      keywords: ['in bulk', 'for each', 'all of them', 'batch'],
      childPersona: [
        'You are the executor for a large batch of small, similar items. Handle them one by one, give every',
        'item exactly the same treatment, and do not add commentary or extra fields.',
        'Report how many items you processed and list any you had to skip, with the reason.',
      ].join('\n'),
      // Batch work is local: looking things up on the web is not part of it.
      childTools: { deny: ['web_fetch', 'web_search'] },
      // The point of this task: per-item thinking must stay shallow, or the volume is
      // what makes it expensive.
      reasoningEffort: 'low',
      pool: [],
    },
    {
      id: 'drawing',
      name: 'Drawings and diagrams',
      description: 'Produce a visual artefact: diagrams, charts, plots, schematics or illustrations, '
        + 'as a file or as source that renders to one.',
      enabled: true,
      keywords: ['diagram', 'chart', 'plot', 'illustration', 'draw'],
      childPersona: [
        'You are the executor for one drawing. Produce the artefact that was asked for, in a format that',
        'opens without extra setup, and keep it legible at the size it will be used.',
        'State the format you produced, how to open it, and anything the parent must adjust.',
      ].join('\n'),
      pool: [],
    },
    {
      id: 'modelling',
      name: '3D modelling and CAD',
      description: 'Three-dimensional work: parametric parts and assemblies, mechanical design, '
        + 'printable geometry, and exports for printing or machining.',
      enabled: true,
      keywords: ['3d model', 'cad', 'parametric', 'printable', 'step file'],
      childPersona: [
        'You are the executor for one piece of three-dimensional work. Build the part you were given,',
        'keep the geometry parametric where the request allows it, and verify the result is watertight',
        'or otherwise sound before you report.',
        'Report units, key dimensions and the file formats you produced.',
      ].join('\n'),
      pool: [],
    },
  ]
  return config
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────────────────────────────────────

/** Match the settings namespace grammar: lowercase words joined by hyphens. */
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Collect every validation complaint instead of throwing on the first. */
class Report {
  constructor() {
    this.problems = []
    this.warnings = []
  }

  fail(where, message) {
    this.problems.push(`${where}: ${message}`)
  }

  /** A valid document can still be worth telling the user about. */
  warn(where, message) {
    this.warnings.push(`${where}: ${message}`)
  }

  /** Run one check, turning a throw into a collected problem. */
  guard(where, body) {
    try {
      body()
      return true
    } catch (error) {
      this.fail(where, error instanceof Error ? error.message : String(error))
      return false
    }
  }
}

/** Validate a task id. */
function checkId(report, where, id) {
  if (typeof id !== 'string' || id.length === 0) {
    report.fail(where, 'id must be a non-empty string')
    return false
  }
  if (!ID_PATTERN.test(id)) {
    report.fail(where, `id "${id}" must be lowercase hyphenated ([a-z0-9] words joined by "-")`)
    return false
  }
  return true
}

/**
 * The string a `String(undefined)` mistake leaves behind.
 *
 * An earlier build wrote `String(model.id)` where `id` could be absent, so a
 * pool entry could hold the literal text `"undefined"`. The schema stores task
 * entries as `z.any()`, so nothing coerced it back to a real value, and the
 * result was a pool entry that looked configured and could never resolve —
 * reported in the UI as an unavailable route rather than as the corruption it
 * is. Treating these spellings as "absent" both repairs old documents and keeps
 * the mistake from recurring unnoticed.
 */
const NULLISH_SPELLINGS = new Set(['undefined', 'null'])

/**
 * Whether a value is a usable route id.
 * @param value - candidate provider or model id.
 * @returns true only for a non-empty string that is not a stringified nullish.
 */
export function isRouteId(value) {
  return typeof value === 'string' && value.length > 0 && !NULLISH_SPELLINGS.has(value)
}

/**
 * Drop route entries that cannot resolve.
 *
 * Applied at the config boundary so a repaired document is what gets stored,
 * rather than leaving the corruption in the user's settings file forever.
 * @param pool - candidate pool entries.
 * @returns the entries whose provider and model are both usable.
 */
export function sanitizePool(pool) {
  if (!Array.isArray(pool)) return []
  return pool.filter(entry => entry !== null && typeof entry === 'object'
    && isRouteId(entry.provider) && isRouteId(entry.model))
}

/**
 * Repair a document in place-free fashion: unusable route ids are removed from
 * every pool, and a `defaultTaskId` that no longer names a usable task is
 * cleared. Returns a new document; the input is not modified.
 * @param config - candidate document.
 * @returns the repaired document plus what was removed.
 */
export function sanitizeConfig(config) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { config, removed: [] }
  }
  const removed = []
  const tasks = (Array.isArray(config.tasks) ? config.tasks : []).map((task, index) => {
    if (task === null || typeof task !== 'object') return task
    const pool = Array.isArray(task.pool) ? task.pool : []
    const clean = sanitizePool(pool)
    if (clean.length === pool.length) return task
    for (const entry of pool) {
      if (!clean.includes(entry)) {
        removed.push({ task: typeof task.id === 'string' ? task.id : `#${index}`, entry })
      }
    }
    return { ...task, pool: clean }
  })
  const clean = { ...config, tasks }
  // A default that names nothing usable is the same as no default at all, and
  // saying so explicitly is what makes "no default → no routing" reliable.
  if (typeof clean.defaultTaskId === 'string' && clean.defaultTaskId.length > 0) {
    const named = tasks.find(task => task !== null && typeof task === 'object' && task.id === clean.defaultTaskId)
    const usable = named !== undefined && named.enabled !== false
      && Array.isArray(named.pool) && named.pool.length > 0
    if (!usable) clean.defaultTaskId = ''
  }
  return { config: clean, removed }
}

/**
 * Validate a whole configuration document.
 *
 * Returns every problem rather than throwing on the first, because this runs at
 * both the settings boundary (where a user is editing a form and wants all
 * mistakes at once) and the routing hot path (where the answer must be cheap).
 *
 * @param config - candidate document.
 * @returns `{ ok, problems, warnings, byId, defaultTaskId }`, where `byId` and
 *   `defaultTaskId` are safe to use even when `ok` is false, since they are
 *   built only from entries that validated.
 */
export function validateConfig(config) {
  const report = new Report()
  const byId = new Map()
  let defaultTaskId

  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { ok: false, problems: ['config must be an object'], warnings: [], byId, defaultTaskId }
  }
  if (config.enabled !== undefined && typeof config.enabled !== 'boolean') {
    report.fail('enabled', 'must be a boolean')
  }
  if (config.defaultTaskId !== undefined && typeof config.defaultTaskId !== 'string') {
    report.fail('defaultTaskId', 'must be a string (empty means no default task)')
  }
  if (config.childDelegation !== undefined && typeof config.childDelegation !== 'boolean') {
    report.fail('childDelegation', 'must be a boolean')
  }

  const classifier = config.classifier
  if (classifier !== undefined) {
    if (classifier === null || typeof classifier !== 'object') {
      report.fail('classifier', 'must be an object')
    } else {
      if (classifier.enabled !== undefined && typeof classifier.enabled !== 'boolean') {
        report.fail('classifier.enabled', 'must be a boolean')
      }
      for (const field of ['provider', 'model']) {
        if (classifier[field] !== undefined && typeof classifier[field] !== 'string') {
          report.fail(`classifier.${field}`, 'must be a string')
        }
      }
      for (const field of ['maxInputTokens', 'timeoutMs']) {
        const value = classifier[field]
        if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
          report.fail(`classifier.${field}`, 'must be a positive number')
        }
      }
      if (classifier.enabled === true
        && (typeof classifier.provider !== 'string' || classifier.provider.length === 0
          || typeof classifier.model !== 'string' || classifier.model.length === 0)) {
        report.fail('classifier', 'an enabled classifier requires provider and model')
      }
    }
  }

  const presets = config.presets
  if (presets !== undefined) {
    if (presets === null || typeof presets !== 'object' || Array.isArray(presets)) {
      report.fail('presets', 'must be an object keyed by preset id')
    } else {
      for (const [presetId, entry] of Object.entries(presets)) {
        const where = `presets.${presetId}`
        if (!ID_PATTERN.test(presetId)) report.fail(where, 'preset id must be lowercase hyphenated')
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          report.fail(where, 'must be an object')
          continue
        }
        for (const flag of ['exclusive', 'enabled']) {
          if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
            report.fail(`${where}.${flag}`, 'must be a boolean')
          }
        }
        if (entry.tasks !== undefined) {
          if (!Array.isArray(entry.tasks)) {
            report.fail(`${where}.tasks`, 'must be an array of task ids')
          } else {
            const seen = new Set()
            for (const taskId of entry.tasks) {
              if (typeof taskId !== 'string' || taskId.length === 0) {
                report.fail(`${where}.tasks`, 'task ids must be non-empty strings')
              } else if (seen.has(taskId)) {
                report.fail(`${where}.tasks`, `repeats task "${taskId}"`)
              } else {
                seen.add(taskId)
              }
            }
          }
        }
      }
    }
  }

  const tasks = config.tasks
  if (tasks !== undefined) {
    if (!Array.isArray(tasks)) {
      report.fail('tasks', 'must be an array')
    } else {
      const declaredDefaults = []
      for (let index = 0; index < tasks.length; index += 1) {
        const task = tasks[index]
        const where = `tasks[${index}]`
        if (task === null || typeof task !== 'object' || Array.isArray(task)) {
          report.fail(where, 'must be an object')
          continue
        }
        const idOk = checkId(report, where, task.id)
        const label = typeof task.name === 'string' && task.name.length > 0 ? task.name : task.id
        const field = idOk ? `task "${task.id}"` : where

        if (task.name !== undefined && (typeof task.name !== 'string' || task.name.length === 0)) {
          report.fail(field, 'name must be a non-empty string')
        }
        // `description` is the ONLY field the semantic classifier reads, so an
        // enabled task without one is unroutable by meaning.
        if (task.description !== undefined && typeof task.description !== 'string') {
          report.fail(field, 'description must be a string')
        }
        if (task.enabled !== undefined && typeof task.enabled !== 'boolean') {
          report.fail(field, 'enabled must be a boolean')
        }
        // Optional per-task reasoning effort. Absent means "let the route
        // decide", which is NOT the same as inheriting the parent's: a changed
        // provider/model drops the inherited effort, so the adapter applies its
        // own route default (often `high`). A cheap pool therefore pays for
        // heavy reasoning unless the task says otherwise.
        if (task.reasoningEffort !== undefined
          && (typeof task.reasoningEffort !== 'string' || task.reasoningEffort.length === 0)) {
          report.fail(field, 'reasoningEffort must be a non-empty string when present')
        }
        /**
         * Optional child profile.
         *
         * A child composes the PARENT's preset — the delegation path has no
         * per-child preset (`agentPresets.composeFrom(childCtx, parent.ctx)` binds
         * the child's scope to the parent's standing mount). So a task shapes its
         * children through exactly two fields: a persona that REPLACES the
         * inherited one, and a tool filter applied at creation. Absent, the child
         * inherits exactly as before.
         */
        if (task.childPersona !== undefined
          && (typeof task.childPersona !== 'string' || task.childPersona.trim().length === 0)) {
          report.fail(field, 'childPersona must be a non-empty string when present')
        }
        if (task.childTools !== undefined) {
          const tools = task.childTools
          if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
            report.fail(field, 'childTools must be an object')
          } else {
            if (tools.allow === undefined && tools.deny === undefined) {
              report.fail(field, 'childTools must declare allow and/or deny (an empty filter would deny everything)')
            }
            for (const key of ['allow', 'deny']) {
              const list = tools[key]
              if (list !== undefined
                && (!Array.isArray(list) || list.some(name => typeof name !== 'string' || name.length === 0))) {
                report.fail(field, `childTools.${key} must be an array of non-empty tool names`)
              }
            }
            // Two spellings for one field is a trap for every reader that knows
            // only one of them — which is exactly how the settings page came to
            // display a `deny` document as "no tools at all". A document may
            // still declare both (deny subtracts from allow), but the redundancy
            // is stated rather than left for the next reader to misread.
            if (Array.isArray(tools.allow) && tools.allow.length > 0
              && Array.isArray(tools.deny) && tools.deny.length > 0) {
              report.warn(field, 'childTools declares both allow and deny; deny is subtracted from allow')
            }
          }
        }
        if (task.keywords !== undefined) {
          if (!Array.isArray(task.keywords)) {
            report.fail(field, 'keywords must be an array of strings')
          } else if (task.keywords.some(keyword => typeof keyword !== 'string' || keyword.length === 0)) {
            report.fail(field, 'keywords must be non-empty strings')
          }
        }

        const pool = Array.isArray(task.pool) ? task.pool : []
        if (task.pool !== undefined && !Array.isArray(task.pool)) {
          report.fail(field, 'pool must be an array')
        }
        const routes = new Set()
        const usable = []
        for (let slot = 0; slot < pool.length; slot += 1) {
          const candidate = pool[slot]
          const at = `${field}.pool[${slot}]`
          if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
            report.fail(at, 'must be an object with provider and model')
            continue
          }
          if (!isRouteId(candidate.provider)) {
            report.fail(at, 'provider must be a non-empty string')
            continue
          }
          if (!isRouteId(candidate.model)) {
            // Naming the corruption beats a generic message: this is what a
            // stringified `undefined` looks like, and it is repairable.
            report.fail(at, 'model must be a non-empty string'
              + (candidate.model === 'undefined' || candidate.model === 'null'
                ? ' (this looks like a stringified nullish value left by an older build; re-pick the model)'
                : ''))
            continue
          }
          const key = `${candidate.provider}\u0000${candidate.model}`
          if (routes.has(key)) {
            report.fail(at, `repeats route "${candidate.provider}/${candidate.model}"`)
            continue
          }
          routes.add(key)
          usable.push({ ...candidate })
          if (candidate.weight !== undefined
            && (!Number.isFinite(candidate.weight) || candidate.weight <= 0)) {
            report.fail(at, 'weight must be a positive number')
          }
        }
        // An empty pool is a warning, not an error: a user may author a task
        // before choosing its models. It simply never routes until it has one
        // (see `routable`), which is safer than refusing to save the document.
        if (task.enabled !== false && usable.length === 0) {
          report.warn(field, 'has no models yet, so it will not route until one is added')
        }

        if (idOk) {
          if (byId.has(task.id)) {
            report.fail(field, 'duplicate task id')
          } else {
            // Validated entries carry their cleaned pool, so consumers never see
            // a route that cannot resolve.
            byId.set(task.id, { ...task, pool: usable })
          }
        }
      }
    }
  }

  // The default is a REFERENCE. It resolves only when it names a task that is
  // itself able to serve — enabled and holding at least one usable model — so a
  // dangling reference behaves exactly like no default at all.
  const declared = typeof config.defaultTaskId === 'string' ? config.defaultTaskId : ''
  if (declared.length > 0) {
    const named = byId.get(declared)
    if (named === undefined) {
      report.fail('defaultTaskId', `refers to unknown task "${declared}"`)
    } else if (named.enabled === false || named.pool.length === 0) {
      report.warn('defaultTaskId', `task "${declared}" cannot serve, so there is effectively no default task`)
    } else {
      defaultTaskId = declared
    }
  }

  // A preset may only refer to tasks that exist: a typo would otherwise read as
  // "this preset routes nothing", which is silent and wrong.
  if (presets !== undefined && presets !== null && typeof presets === 'object' && !Array.isArray(presets)) {
    for (const [presetId, entry] of Object.entries(presets)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      if (!Array.isArray(entry.tasks)) continue
      for (const taskId of entry.tasks) {
        if (typeof taskId === 'string' && !byId.has(taskId)) {
          report.fail(`presets.${presetId}.tasks`, `refers to unknown task "${taskId}"`)
        }
      }
    }
  }

  return { ok: report.problems.length === 0, problems: report.problems, warnings: report.warnings, byId, defaultTaskId }
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-preset permissions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve one preset's routing permission.
 *
 * Absent configuration means "not routing" — installing the plugin must never
 * change a preset's behaviour on its own. This is the single place the preset
 * plane decides anything, and it decides only *permission*, never policy.
 *
 * @param config - the validated document.
 * @param presetId - the Session's preset id, or `undefined` when it has none.
 * @returns `{ allowed, tasks }`; `tasks` is `null` for "every enabled task".
 */
export function presetPolicy(config, presetId) {
  const entry = presetId === undefined ? undefined : config?.presets?.[presetId]
  if (entry === undefined) return { allowed: false, tasks: null }
  if (entry.enabled === false) return { allowed: false, tasks: null }
  if (entry.exclusive === true) {
    return { allowed: true, tasks: Array.isArray(entry.tasks) ? entry.tasks.slice() : [] }
  }
  return { allowed: true, tasks: null }
}

/** Whether one task is usable under a resolved preset policy. */
function taskAllowed(task, policy) {
  if (task.enabled === false) return false
  if (policy.tasks === null) return true
  return policy.tasks.includes(task.id)
}

/**
 * Whether a task can actually serve a request: permitted by the preset AND
 * holding at least one model. The second half matters because an enabled task
 * with an empty pool is a legal, in-progress editing state — it must simply
 * never be selected, so it can neither shadow the fallback nor send the router
 * looking for a route that does not exist.
 */
function routable(task, policy) {
  return taskAllowed(task, policy) && Array.isArray(task.pool) && task.pool.length > 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Context + the resolution ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The observable facts one routing decision is made from. Built by the adapter
 * from a live Session; kept a plain object so decisions are reproducible.
 *
 * @typedef {object} RoutingContext
 * @property {string|undefined} presetId  the composing preset, inherited by children
 * @property {boolean} isSubagent         a delegated session (or one of its children)
 * @property {string} text                recent conversation text
 * @property {string} toolNames           names in the current request header
 */

/**
 * Tier 1+2, synchronously: an explicit directive in the text, a `[skill: x]`
 * marker, a keyword hit, or a declared tool name.
 *
 * Deterministic tiers run before the classifier because they are free and
 * exact — spending a model call to rediscover what the user already said would
 * be wasteful, and a user who writes "use the web-research task" must win.
 *
 * @param tasks - candidate tasks, in declaration order.
 * @param context - the routing context.
 * @returns the matched task, or `undefined`.
 */
export function matchDeterministic(tasks, context) {
  const text = typeof context.text === 'string' ? context.text : ''
  const tools = typeof context.toolNames === 'string' ? context.toolNames : ''
  const wanted = new Set()
  // An explicit, unambiguous directive: `[task: web-research]`. Both patterns
  // need the global flag: `matchAll` throws on a non-global regex, and the
  // throw would silently collapse this whole tier into the keyword tier below.
  for (const match of text.matchAll(/\[task:\s*([a-z0-9-]+)\s*\]/gi)) wanted.add(match[1].toLowerCase())
  for (const match of text.matchAll(/\[skill:\s*([a-z0-9-]+)\s*\]/gi)) wanted.add(`skill:${match[1].toLowerCase()}`)

  // Each tier is its own pass over every task, because the tiers must not
  // interleave: if task A's keyword is checked before task B's explicit
  // directive, a message that names B still routes to A. Weakest-first inside
  // one loop is the bug this shape prevents.
  for (const task of tasks) if (wanted.has(task.id)) return task
  for (const task of tasks) {
    const skills = Array.isArray(task.skills) ? task.skills : []
    if (skills.some(skill => wanted.has(`skill:${skill}`))) return task
  }
  for (const task of tasks) {
    const keywords = Array.isArray(task.keywords) ? task.keywords : []
    if (keywords.some(keyword => keyword.length > 0 && text.includes(keyword))) return task
  }
  // A tool that only this task declares is as good as an explicit request: the
  // header is the harness's own statement about what this turn can do.
  for (const task of tasks) {
    const taskTools = Array.isArray(task.tools) ? task.tools : []
    if (taskTools.some(tool => tool.length > 0 && tools.includes(tool))) return task
  }
  return undefined
}

/**
 * Rough token count for mixed CJK/Latin text.
 *
 * Deliberately dependency-free and approximate. Budgeting a classifier prompt
 * needs to be roughly right, never exact: the cap exists so a long conversation
 * cannot blow a small model's context, and being 10% conservative costs nothing
 * while pulling in a tokenizer would add a dependency to a module that has none.
 *
 * CJK codepoints count at ~1 token each, everything else at ~4 characters per
 * token — the usual rule of thumb for text that mixes the two.
 *
 * @param text - the candidate text.
 * @returns an estimated token count, never negative.
 */
export function estimateTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return 0
  let cjk = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code >= 0x3040 && code <= 0x30ff) || (code >= 0x3400 && code <= 0x4dbf)
      || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff)
      || (code >= 0xac00 && code <= 0xd7af) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

/**
 * Trim text to a token budget, keeping most of the FRONT.
 *
 * The front is what matters here: a delegated session's first message is the
 * task it was spawned with, while its tail is whatever the last tool result
 * happened to be. For "which task is this", the opening instruction is the
 * strongest signal, so it survives the cut and the tail absorbs what is left.
 *
 * @param text - the candidate text.
 * @param maxTokens - the budget, in estimated tokens.
 * @param headShare - fraction of the budget reserved for the front.
 * @returns the trimmed text, and whether anything was dropped.
 */
export function trimToTokenBudget(text, maxTokens, headShare = 0.6) {
  if (typeof text !== 'string') return { text: '', trimmed: false }
  const budget = Number.isFinite(maxTokens) && maxTokens > 0 ? Math.floor(maxTokens) : 0
  if (budget === 0 || estimateTokens(text) <= budget) return { text, trimmed: false }
  // Derive this text's own characters-per-token ratio instead of assuming one.
  // A fixed ~4 chars/token is right for Latin and wrong for CJK by 3x, and
  // which one a conversation holds is not knowable in advance.
  const perToken = Math.max(1, text.length / Math.max(1, estimateTokens(text)))
  const headBudget = Math.max(1, Math.floor(budget * headShare))
  const tailBudget = Math.max(1, budget - headBudget)
  let headChars = Math.max(1, Math.floor(headBudget * perToken))
  let tailChars = Math.max(1, Math.floor(tailBudget * perToken))
  // The ratio is an average, so a first cut can still overshoot; shrink until
  // the ESTIMATE fits, which is what makes the bound true rather than nominal.
  let candidate = ''
  for (let attempt = 0; attempt < 16; attempt += 1) {
    candidate = `${text.slice(0, headChars)}\n…\n${text.slice(text.length - tailChars)}`
    if (estimateTokens(candidate) <= budget) break
    headChars = Math.max(1, Math.floor(headChars * 0.85))
    tailChars = Math.max(1, Math.floor(tailChars * 0.85))
  }
  return { text: candidate, trimmed: true }
}

/**
 * Assemble what the classifier reads.
 *
 * Bounded by construction: the opener and the recent tail are taken first, the
 * whole thing is trimmed to the token budget, and the prompt adds only one line
 * per candidate task. The input therefore cannot exceed the configured budget
 * however long the conversation has grown.
 *
 * @param rootTask - the message the delegated session was created with, if any.
 * @param recent - the recent conversation tail.
 * @param maxTokens - the configured budget.
 * @returns the text to classify, and whether it was trimmed.
 */
export function classificationInput(rootTask, recent, maxTokens) {
  const parts = []
  const root = typeof rootTask === 'string' ? rootTask.trim() : ''
  const tail = typeof recent === 'string' ? recent.trim() : ''
  if (root.length > 0) parts.push(root)
  // Skip the tail when it IS the opener: a single-message session would
  // otherwise spend its budget saying the same thing twice.
  if (tail.length > 0 && tail !== root) parts.push(tail)
  return trimToTokenBudget(parts.join('\n\n'), maxTokens)
}

/**
 * Build the classifier prompt. Kept here (not in the adapter) so the exact
 * decision procedure is reviewable next to the ladder that uses it.
 *
 * @param tasks - candidate tasks.
 * @param text - the bounded classification input.
 * @returns `{ system, user }` prompt halves.
 */
export function classifierPrompt(tasks, text) {
  const lines = tasks.map(task => (
    `- ${task.id}: ${task.description && task.description.length > 0 ? task.description : task.name}`
  ))
  const system = [
    'You are a task router. Read the conversation excerpt and choose the single task id that best',
    'describes what the assistant is being asked to do.',
    '',
    'Candidate tasks:',
    ...lines,
    '',
    'Reply with ONLY the task id, lowercase, on one line. No punctuation, no explanation.',
    'If no candidate fits, reply with: none',
  ].join('\n')
  return { system, user: text }
}

/** Normalize a classifier reply into one of the candidate ids, or `undefined`. */
export function parseClassifierReply(reply, tasks) {
  if (typeof reply !== 'string') return undefined
  const cleaned = reply.trim().toLowerCase().replace(/[`"'.\s]+$/u, '')
  if (cleaned.length === 0 || cleaned === 'none') return undefined
  const exact = tasks.find(task => task.id === cleaned)
  if (exact !== undefined) return exact
  // Tolerate a model that answered with the id inside a sentence.
  return tasks.find(task => cleaned.includes(task.id))
}

/**
 * The resolution ladder, synchronous tiers only.
 *
 * ## Scope: delegated work only
 *
 * This router never touches the session you are talking to. The model picked in
 * the composer IS the main model — that is the user's decision and nothing here
 * second-guesses it. Routing applies to delegated sessions (and their own
 * children) only, which is the one place a task-shaped choice is both possible
 * and cheap: work handed to a child is already a described, self-contained
 * piece of work.
 *
 * A consequence worth stating: the main agent keeps its tools, its context, and
 * its own model untouched, so a routing mistake can never degrade the
 * conversation itself.
 *
 * ## Tier ordering
 *
 *   1. no route at all          — disabled, not a delegated session, or the
 *                                 preset was never granted
 *   2. deterministic match      — explicit directive, skill, keyword, or tool
 *   3. semantic classification  — async, performed by the caller
 *   4. the configured default   — used whenever tiers 2 and 3 both miss
 *   5. nothing                  — no usable default: keep the inherited route
 *
 * @param config - the document.
 * @param context - the routing context.
 * @returns `{ task, tier }`, where `task` is absent for every "leave it alone".
 */
export function resolveSync(config, context) {
  if (config?.enabled !== true) return { task: undefined, tier: 'disabled' }
  // Only delegated sessions are routed. `isSubagent` is what the session header
  // says about lineage, so a grandchild is included and the main session is not.
  if (context.isSubagent !== true) return { task: undefined, tier: 'not-delegated' }
  const policy = presetPolicy(config, context.presetId)
  if (!policy.allowed) return { task: undefined, tier: 'preset' }

  const { byId, defaultTaskId } = validateConfig(config)
  const candidates = [...byId.values()].filter(task => routable(task, policy))

  const matched = matchDeterministic(candidates, context)
  if (matched !== undefined) return { task: matched, tier: 'deterministic' }

  // The default applies to everything unmatched, which is the whole point of
  // having one: an unrecognized delegated task still lands on a chosen model
  // instead of inheriting whatever the parent happened to use.
  const fallback = defaultTaskId === undefined ? undefined : candidates.find(task => task.id === defaultTaskId)
  return { task: fallback, tier: fallback === undefined ? 'unmatched' : 'default' }
}

/**
 * Tasks a delegated session of this preset may be routed to.
 *
 * Ordered so the classifier sees the default LAST: when the model cannot tell,
 * the cheapest correct answer is the operator's own fallback, and seeing it at
 * the end of the list makes that the natural choice rather than an arbitrary
 * one among equals.
 */
export function candidateTasks(config, presetId) {
  const policy = presetPolicy(config, presetId)
  if (!policy.allowed) return []
  const { byId, defaultTaskId } = validateConfig(config)
  const routableTasks = [...byId.values()].filter(task => routable(task, policy))
  if (defaultTaskId === undefined) return routableTasks
  return [
    ...routableTasks.filter(task => task.id !== defaultTaskId),
    ...routableTasks.filter(task => task.id === defaultTaskId),
  ]
}

// ─────────────────────────────────────────────────────────────────────────────
// Global load balancing
// ─────────────────────────────────────────────────────────────────────────────

/** Read one candidate's positive weight, defaulting to 1. */
export function weightOf(candidate) {
  const weight = candidate?.weight
  return typeof weight === 'number' && Number.isFinite(weight) && weight > 0 ? weight : 1
}

/**
 * Build a scheduler. ONE instance per process.
 *
 * ## Why rotation state is global, and pinning state is not
 *
 * The requirement is that load balances across the whole harness rather than
 * within each conversation: ten sessions running the same task must land on the
 * pool's models in the configured ratio, not each independently start from the
 * first model. So {@link Scheduler#next} keeps exactly one counter vector per
 * task id, shared by every Session, and consults no session state at all —
 * balancing is a property of the deployment.
 *
 * Coherence is a property of a *turn*, so it is kept separately in `pins`:
 * once a turn picks a model, every later step of that turn reads the pin and
 * reuses it. That keeps the prompt prefix cacheable and stops a tool call from
 * changing the voice mid-turn. Pins carry a TTL because turns can be abandoned;
 * the rotation itself never expires.
 *
 * @param options - `{ now, pinTtlMs, pinLimit, scheduleOf }`.
 * @returns a scheduler with `next` and `stats`.
 */
export function createScheduler(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now()
  const pinTtlMs = Number.isFinite(options.pinTtlMs) ? options.pinTtlMs : 30 * 60 * 1000
  const pinLimit = Number.isFinite(options.pinLimit) ? options.pinLimit : 2048
  const scheduleOf = typeof options.scheduleOf === 'function' ? options.scheduleOf : defaultScheduleOf

  /** taskId -> { schedule, weights } — one per process, never per session. */
  const rotations = new Map()
  /** `${sessionId}\0${turn}` -> { taskId, candidate, at } */
  const pins = new Map()
  /** taskId -> number of picks, for the settings UI's readout. */
  const counts = new Map()

  /** Forget the oldest pin once the pin table grows past its limit. */
  function trimPins() {
    if (pins.size <= pinLimit) return
    const oldest = pins.keys().next()
    if (oldest.done !== true) pins.delete(oldest.value)
  }

  /** Drop pins that outlived their TTL, so abandoned turns cannot accumulate. */
  function expirePins() {
    // Insertion order is oldest-first because a hit is re-inserted (see `next`),
    // so the first unexpired pin ends the scan.
    for (const [key, pin] of pins) {
      // `>=` so a TTL of 0 means "expire immediately" rather than "never".
      if (now() - pin.at >= pinTtlMs) pins.delete(key)
      else break
    }
  }

  return {
    /**
     * Pick the model for one (session, turn, task).
     * @param task - the resolved task; `pool` is its weighted chain.
     * @param sessionId - owning Session, used only for the turn pin.
     * @param turn - turn number, or `undefined` when the caller has none.
     * @param stickiness - `turn` | `session` | `global`.
     * @returns the chosen candidate plus whether it was a fresh pick.
     */
    next(task, sessionId, turn, stickiness = 'turn') {
      const pool = Array.isArray(task.pool) ? task.pool : []
      if (pool.length === 0) return { candidate: undefined, fresh: false }
      expirePins()
      const taskId = task.id

      // `global` is the honest no-pin mode: the rotation advances on every
      // request, so consecutive steps of one turn may differ.
      if (stickiness === 'global') {
        const state = rotationFor(taskId, pool)
        const candidate = pick(state)
        counts.set(taskId, (counts.get(taskId) ?? 0) + 1)
        return { candidate, fresh: true }
      }

      const key = `${sessionId}\u0000${turn === undefined ? 'session' : String(turn)}`
      const pin = pins.get(key)
      if (pin !== undefined && pin.taskId === taskId) {
        // The pinned model must still be in the pool: an edit while a turn is
        // in flight must not keep routing to a model the user just removed.
        const still = pool.find(entry => entry.provider === pin.candidate.provider
          && entry.model === pin.candidate.model)
        if (still !== undefined) {
          pins.delete(key)
          pins.set(key, { taskId, candidate: still, at: now() })
          return { candidate: still, fresh: false }
        }
        pins.delete(key)
      }

      const state = rotationFor(taskId, pool)
      const candidate = pick(state)
      counts.set(taskId, (counts.get(taskId) ?? 0) + 1)
      pins.set(key, { taskId, candidate, at: now() })
      trimPins()
      return { candidate, fresh: true }
    },

    /** Advance past the current candidate after a failed request. */
    rotate(task) {
      const pool = Array.isArray(task.pool) ? task.pool : []
      if (pool.length < 2) return false
      pick(rotationFor(task.id, pool))
      return true
    },

    /**
     * Advance past the current candidate and report the one advanced TO.
     *
     * `rotate` alone is not enough to move a retry: the retry's own `next()`
     * call consumes the slot AFTER the advanced one, so it lands back on the
     * model that just failed. Pinning the advanced candidate is what makes the
     * retry actually land somewhere else.
     * @param task - the resolved task whose pool failed.
     * @returns the candidate to retry on, or undefined when the pool cannot rotate.
     */
    rotateTo(task) {
      const pool = Array.isArray(task.pool) ? task.pool : []
      if (pool.length < 2) return undefined
      return pick(rotationFor(task.id, pool))
    },

    /** Pin one exact candidate for a turn, so the next request reuses it. */
    pin(sessionId, turn, taskId, candidate) {
      if (candidate === undefined) return
      const key = `${sessionId}\u0000${turn === undefined ? 'session' : String(turn)}`
      pins.set(key, { taskId, candidate, at: now() })
      trimPins()
    },

    /** Forget one turn's pin so the next request re-picks and advances. */
    unpin(sessionId, turn) {
      pins.delete(`${sessionId}\u0000${turn === undefined ? 'session' : String(turn)}`)
    },

    /**
     * Per-task rotation state, for a settings readout.
     *
     * @param tasks - the live tasks, when the caller has them: every rotation is
     *   then brought up to date first, so a pool that was just edited is not
     *   reported as the pool it used to be. Omitted, only tasks that have already
     *   been picked are described.
     * @returns per task the `picks` count, the CONFIGURED `weights`, the routes
     *   the rotation is built from, and the candidate `pick()` would return next.
     */
    stats(tasks) {
      const out = {}
      const ids = Array.isArray(tasks)
        ? tasks.map(task => task?.id).filter(id => typeof id === 'string')
        : [...rotations.keys()]
      for (const taskId of ids) {
        const task = Array.isArray(tasks) ? tasks.find(entry => entry?.id === taskId) : undefined
        // `rotationFor` is the same function `pick()` uses, so what is described
        // here cannot drift from how the rotation actually advances.
        const state = task === undefined ? rotations.get(taskId) : rotationFor(taskId, task.pool ?? [])
        if (state === undefined) continue
        out[taskId] = {
          picks: counts.get(taskId) ?? 0,
          // The CONFIGURED weights. The running accumulators are internal: they
          // start empty and go NEGATIVE by design (the winner is decremented by
          // the total), so reporting them as "weights" was a lie — measured live,
          // it printed `-11,1,1,…` for a pool of nine.
          weights: state.schedule.map(entry => Math.round(entry.weight * 1000) / 1000),
          candidates: state.schedule.map(entry => `${entry.candidate.provider}/${entry.candidate.model}`),
          // What the NEXT pick returns — computed the way `pick()` computes it
          // (add each weight to its accumulator, then take the largest). Reading
          // the current accumulators instead answers a different question, and the
          // two disagree as soon as the weights are not all equal.
          next: nextCandidate(state),
        }
      }
      return out
    },

    /** Drop all rotation and pin state (used when settings change). */
    reset() {
      rotations.clear()
      pins.clear()
      counts.clear()
    },
  }

  /** Build or rebuild one task's smooth-weighted schedule. */
  function rotationFor(taskId, pool) {
    const state = rotations.get(taskId)
    const samePool = state !== undefined
      && state.schedule.length === pool.length
      && state.schedule.every((entry, index) => entry.candidate.provider === pool[index].provider
        && entry.candidate.model === pool[index].model
        && entry.weight === weightOf(pool[index]))
    if (samePool) return state
    const fresh = { schedule: scheduleOf(pool), weights: [] }
    rotations.set(taskId, fresh)
    return fresh
  }

  /**
   * The candidate `pick()` would return, without advancing the rotation.
   *
   * Mirroring `pick()` exactly matters: the same addition, the same comparison,
   * the same tie-break (the earliest index wins).
   */
  function nextCandidate(state) {
    let best = 0
    let bestValue = Number.NEGATIVE_INFINITY
    for (let index = 0; index < state.schedule.length; index += 1) {
      const value = (state.weights[index] ?? 0) + state.schedule[index].weight
      if (value > bestValue) {
        bestValue = value
        best = index
      }
    }
    return state.schedule[best]?.candidate ?? null
  }

  /**
   * Smooth weighted round-robin (nginx's algorithm) over one rotation vector.
   *
   * Modulo indexing would emit `a a b a a b` for weights 2:1 — technically the
   * right ratio, visibly bursty in practice. Smooth WRR emits `a b a`, which is
   * what "balanced" is supposed to look like request by request.
   */
  function pick(state) {
    let total = 0
    let best = 0
    for (let index = 0; index < state.schedule.length; index += 1) {
      const weight = state.schedule[index].weight
      state.weights[index] = (state.weights[index] ?? 0) + weight
      total += weight
      if (state.weights[index] > state.weights[best]) best = index
    }
    state.weights[best] -= total
    return state.schedule[best].candidate
  }
}

/** Default schedule builder: one weighted entry per pool slot. */
function defaultScheduleOf(pool) {
  return pool.map(candidate => ({ candidate, weight: weightOf(candidate) }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Catalog helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Reconcile configured routes against the models that actually exist.
 *
 * "Every model in the model list is configurable" needs a live check, because
 * the catalog is owned by the provider adapters and changes as settings do. A
 * route whose provider is gone is reported, not silently dropped — the user
 * needs to see that a pool entry stopped resolving.
 *
 * @param config - the document.
 * @param knownRoutes - `[{ provider, model }]` from the live runtime.
 * @returns `{ unknown, poolsWithoutKnownModel }`.
 */
export function reconcile(config, knownRoutes) {
  const known = new Set(knownRoutes.map(route => `${route.provider}\u0000${route.model}`))
  const providers = new Set(knownRoutes.map(route => route.provider))
  const unknown = []
  const poolsWithoutKnownModel = []
  for (const task of Array.isArray(config?.tasks) ? config.tasks : []) {
    let usable = 0
    for (const candidate of Array.isArray(task.pool) ? task.pool : []) {
      if (known.has(`${candidate.provider}\u0000${candidate.model}`)) {
        usable += 1
      } else {
        unknown.push({
          taskId: task.id,
          provider: candidate.provider,
          model: candidate.model,
          reason: providers.has(candidate.provider) ? 'model-not-advertised' : 'provider-not-registered',
        })
      }
    }
    if (usable === 0 && task.enabled !== false) poolsWithoutKnownModel.push(task.id)
  }
  return { unknown, poolsWithoutKnownModel }
}
