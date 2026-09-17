/**
 * The configuration store: one folder, one file per task, one global file.
 *
 * WHY A STORE AT ALL. The settings service keeps every namespace in the single
 * `settings.yaml` document — `SettingsRegisterOptions` has no storage hook, and
 * `documentPath` is that one file. A configuration that lives in its own folder
 * therefore cannot ride that service; it needs its own reader, writer, watcher
 * and validation.
 *
 * LAYOUT (under `$DSH_HOME`):
 *
 *     model-routing/global.yml      everything that is not per-task
 *     model-routing/tasks/<id>.yml  one task, whole and alone
 *
 * The split is the point: editing one task touches one small file, a diff shows
 * exactly which task changed, and two people can edit two tasks without meeting.
 * `global.yml` holds no task, and a task file holds no global setting, so neither
 * can be edited by accident while reaching for the other.
 *
 * This module owns the FORMAT and the FILESYSTEM, nothing else: no Cordis, no
 * timers, no routing. The adapter supplies validation and reacts to changes.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Folder name under `$DSH_HOME`, beside `settings.yaml`. */
export const STORE_DIRNAME = 'model-routing'
/** File holding every non-task setting. */
export const GLOBAL_FILENAME = 'global.yml'
/** Folder holding one file per task. */
export const TASKS_DIRNAME = 'tasks'
/** Extension for both, so an editor highlights them. */
export const FILE_EXT = '.yml'

/** Header written into a file this store creates, so a reader knows the rules. */
const GLOBAL_HEADER = [
  '# Task routing · global configuration (comments are in Chinese; the field table is in skills/model-routing/SKILL.md)',
  '#',
  '# 由设置页「任务路由」与手工编辑共同维护，改完即生效（无需重启）。',
  '# 任务本身不在这里，每个任务一个文件：tasks/<任务id>.yml',
  '#',
  '# enabled          总开关。false 时本插件不改动任何会话的模型，也不安装委派工具。',
  '# defaultTaskId    未命中任何任务时使用的任务 id。留空 = 没有默认任务（保持继承的模型）。',
  '# childDelegation  子智能体能否再往下派。false（推荐）= 只做执行者。',
  '# classifier       语义分类器：只在「显式指令」与「关键词」都没命中时出场一次。',
  '#   maxInputTokens 每次判定读入的 token 上限（不是字符数）。',
  '#   timeoutMs      单次判定超时；超时/失败直接落到默认任务，不影响对话。',
  '# presets          授权哪些 agent 预设使用本插件；未列出的预设完全不受影响。',
  '',
].join('\n')

/** Header written into a task file this store creates. */
const TASK_HEADER = [
  '# Task routing · one task (comments are in Chinese; the field table is in skills/model-routing/SKILL.md)',
  '#',
  '# 文件名就是任务 id（重命名文件即改 id）。全局配置在 ../global.yml。',
  '#',
  '# description   分类器唯一读到的内容：写清「这个任务是做什么的」。',
  '# keywords      命中即直接路由，不必等分类器。',
  '# pool          模型池：[{ provider, model, weight }]，按权重全局轮转。',
  '# reasoningEffort  可选：off/low/medium/high，覆盖路由默认的推理强度。',
  '# childPersona  可选：本任务的子智能体读这一段系统提示词（整体替换继承来的那段）。',
  '# childTools    可选：{ allow: [...] } 或 { deny: [...] }，限定子智能体可用工具。',
  '',
].join('\n')

/** Whether a value is a plain record. */
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value)

/**
 * A task id that is safe as a file name on every platform.
 *
 * The id is the file name, so it must not be able to escape the folder, collide
 * with the global file, or need escaping to look at. The config schema already
 * restricts ids to `[a-z0-9-]`; this is the same rule applied to the filesystem.
 *
 * @param id - candidate task id.
 * @returns true when the id may become a file name.
 */
export function isSafeTaskId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(id) && id.length <= 64
}

/** The folder layout, derived from one root. */
export function paths(root) {
  return {
    root,
    global: join(root, GLOBAL_FILENAME),
    tasks: join(root, TASKS_DIRNAME),
    task: id => join(root, TASKS_DIRNAME, `${id}${FILE_EXT}`),
  }
}

/**
 * Parse one YAML document, tolerating an empty file.
 *
 * @param text - file contents.
 * @param parse - the YAML parser, injected so this module carries no dependency.
 * @returns the parsed value, or an empty record for a blank file.
 */
function parseDocument(text, parse) {
  if (text.trim().length === 0) return {}
  const value = parse(text)
  if (value === null || value === undefined) return {}
  if (!isRecord(value)) throw new Error('a configuration file must hold a mapping at the top level (key: value)')
  return value
}

/**
 * Read the whole configuration from disk.
 *
 * A missing folder or file is NOT an error: it is the state before the first
 * save, and the caller decides what to do with the emptiness. A file that exists
 * but does not parse IS an error, reported per file so one bad task cannot hide
 * the others.
 *
 * @param root - the store root folder.
 * @param parse - YAML parser.
 * @returns `{ global, tasks, problems, files }`. `problems` are per-file and
 *   non-fatal: the caller keeps the last good value for that file.
 */
export function readConfig(root, parse) {
  const at = paths(root)
  const problems = []
  let global = {}
  const tasks = []

  try {
    global = parseDocument(readFileSync(at.global, 'utf8'), parse)
  } catch (error) {
    if (error?.code !== 'ENOENT') problems.push({ file: GLOBAL_FILENAME, message: messageOf(error) })
  }

  let names = []
  try {
    names = readdirSync(at.tasks)
  } catch (error) {
    if (error?.code !== 'ENOENT') problems.push({ file: TASKS_DIRNAME, message: messageOf(error) })
  }

  for (const name of names.filter(entry => entry.endsWith(FILE_EXT)).sort()) {
    const id = name.slice(0, -FILE_EXT.length)
    try {
      const task = parseDocument(readFileSync(join(at.tasks, name), 'utf8'), parse)
      // The FILE NAME is the authority: a task's id is how it is referenced by
      // `defaultTaskId`, `[task: …]`, and preset grants, so a mismatch between
      // the two would make one of them silently wrong.
      tasks.push({ ...task, id })
    } catch (error) {
      problems.push({ file: `${TASKS_DIRNAME}/${name}`, message: messageOf(error) })
    }
  }
  return { global, tasks, problems, files: { global: at.global, tasks: at.tasks } }
}

/** One human-readable message for any thrown value. */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Write the whole configuration to disk.
 *
 * Every file is written to a temporary name and renamed over its target, so a
 * reader never observes a half-written file — the watcher and a hand-editor are
 * both readers. A task file that is no longer part of the configuration is
 * REMOVED, because it is the configuration: leaving it behind would silently
 * resurrect a deleted task on the next read.
 *
 * @param root - the store root folder.
 * @param config - `{ global, tasks }`.
 * @param stringify - YAML serializer, injected.
 * @returns the file names written.
 */
export function writeConfig(root, config, stringify) {
  const at = paths(root)
  mkdirSync(at.tasks, { recursive: true })
  const written = []

  writeAtomic(at.global, GLOBAL_HEADER + stringify(config.global ?? {}))
  written.push(GLOBAL_FILENAME)

  const wanted = new Set()
  for (const task of config.tasks ?? []) {
    const id = task?.id
    if (!isSafeTaskId(id)) {
      throw new Error(`task id ${JSON.stringify(id)} cannot be a file name (lowercase letters, digits and hyphens only)`)
    }
    if (wanted.has(id)) throw new Error(`task id "${id}" appears twice`)
    wanted.add(id)
    const { id: _ignored, ...rest } = task
    writeAtomic(at.task(id), TASK_HEADER + stringify(rest))
    written.push(`${TASKS_DIRNAME}/${id}${FILE_EXT}`)
  }

  for (const name of readdirSync(at.tasks)) {
    if (!name.endsWith(FILE_EXT)) continue
    if (wanted.has(name.slice(0, -FILE_EXT.length))) continue
    rmSync(join(at.tasks, name), { force: true })
    written.push(`-${TASKS_DIRNAME}/${name}`)
  }
  return written
}

/** Write one file through a temporary sibling, then rename over the target. */
function writeAtomic(target, text) {
  const temporary = `${target}.tmp`
  writeFileSync(temporary, text, 'utf8')
  renameSync(temporary, target)
}

/**
 * Split one resolved configuration document into the store's shape.
 *
 * The inverse of {@link assemble}: the adapter validates the whole document, and
 * this decides which part of it each file receives.
 *
 * @param document - a validated `{ global…, tasks }` document.
 * @returns `{ global, tasks }` ready for {@link writeConfig}.
 */
export function splitDocument(document) {
  const { tasks, ...global } = document ?? {}
  return { global, tasks: Array.isArray(tasks) ? tasks : [] }
}

/**
 * Put the store back into one configuration document.
 *
 * @param stored - the value from {@link readConfig}.
 * @returns a single document, shaped exactly like the one the plugin used to
 *   read out of the settings namespace — so every consumer is unchanged.
 */
export function assemble(stored) {
  return { ...(stored?.global ?? {}), tasks: (stored?.tasks ?? []).map(task => ({ ...task })) }
}

/**
 * Export the `model-routing` section of an existing settings document.
 *
 * Used once, on the first start after this store exists: a deployment that
 * configured the plugin through the settings page must not lose its
 * configuration because the storage moved.
 *
 * @param settingsDocument - the parsed `settings.yaml`.
 * @returns the section, or undefined when there is nothing to migrate.
 */
export function migrateFromSettings(settingsDocument) {
  const section = settingsDocument?.settings?.['model-routing'] ?? settingsDocument?.['model-routing']
  if (!isRecord(section)) return undefined
  const document = splitDocument(section)
  const meaningful = Object.keys(document.global).length > 0 || document.tasks.length > 0
  return meaningful ? document : undefined
}
