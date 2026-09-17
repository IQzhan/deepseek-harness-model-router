/**
 * dsh-model-router — Client half: the "Task routing" settings page.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Routing for DELEGATED sessions only. The model picked in the composer is the
 * main model and nothing here changes it; this page decides which model a
 * subagent uses, based on what that subagent was asked to do.
 *
 * ── How it talks to the Host ─────────────────────────────────────────────────
 * Through the SAME client services every shipped settings page uses, which is
 * why this half carries no transport of its own:
 *
 *   · `ctx.settingsScope.bind({ namespace })` — a reactive mirror of the
 *     `model-routing` namespace, written with `set()`. The Host half owns the
 *     namespace; this is the browser's window onto it.
 *   · `ctx.remote.session` — the Typert gateway, so the model catalog travels the
 *     wire the whole app already uses.
 *
 * An earlier version invented its own JSON route (`/api/dsh-model-router/…`) and
 * a `host.call` global. Neither exists for a bundled client plugin — `host.call`
 * is a DYNAMIC-sandbox builtin — so every read failed and the page sat on its
 * loading line forever. Using the shipped services also means the Host half needs
 * no RPC surface at all: routing is a Host-side hook on `agent/request`, and the
 * page only reads and writes the document.
 *
 * ── The nav label and icon ───────────────────────────────────────────────────
 * `settings.section` registration carries `label` (the nav text) — omitting it
 * left a blank row, which is the "missing title". The ICON is different: the
 * shell picks it from a hardcoded id table in `SettingsRoot.tsx` and falls back
 * to the settings gear; the contract has no icon field, so a third-party section
 * cannot supply one through registration.
 *
 * @module dsh-model-router/client
 */

/**
 * Builtins, resolved once.
 *
 * A dynamic Cordis package receives `React`, `styles`, and `ctx` as free
 * variables of its evaluated body. A bundled client plugin receives none of
 * them: `window.__ModuleLoader__` passes only `require`. Resolving both
 * environments here keeps one source for both loaders.
 */
const ReactLib = typeof React !== 'undefined' ? React : require('react')

const stylesApi = typeof styles !== 'undefined' ? styles : {
  insert(css) {
    if (typeof document === 'undefined') return () => {}
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'dsh-model-router')
    tag.textContent = css
    document.head.appendChild(tag)
    return () => { tag.remove() }
  },
}

function E(type, props, ...children) {
  return ReactLib.createElement(type, props, ...children)
}


// -- i18n copy
const NS = 'settings.modelRouter'
const COPY = {zh: {
  'nav.label': '任务路由', 'header.title': '任务路由',
  'header.subtitle': '为子智能体按任务挑选模型。主对话用的始终是你在输入框旁选的那个模型，本插件不碰它。',
  'error.renderFailed.title': '设置页渲染失败',
  'error.renderFailed.detail': '插件本体仍在运行：路由与委派由 Host 半边负责，这个报错只影响本页显示。完整堆栈已打到浏览器控制台。',
  'error.connectHostFailed.title': '设置页无法连接 Host',
  'error.connectHostFailed.detail': 'Host 半边仍然正常工作，其他设置页也照常。',
  'error.mirrorUnavailable.title': '设置镜像不可用',
  'error.mirrorUnavailable.detail': '这一页需要 settingsScope 提供的设置镜像；它没有出现，所以本页只读不写。',
  'error.mirrorReadWriteError.title': '设置镜像读写出错',
  'error.mirrorReadWriteError.detail': '这一页仍然渲染，但读写设置可能不生效。Host 半边与路由本身不受影响。',
  'error.configUnreadable.title': '配置不可读写',
  'error.configUnreadable.detail': 'Host 半边还没有注册 model-routing 命名空间，或者当前连接把偏好保存在进程内（memory 模式）。请确认插件已随 profile 加载，然后刷新页面。',
  'error.saveFailed.title': '保存失败',
  'error.catalogReadFailed.title': '读取模型目录失败',
  'status.loading': '载入中…', 'status.active': '生效中', 'status.inactive': '未生效', 'status.readOnly': '只读',
  'status.healthTitle': '运行状态',
  'status.healthSubtitle': 'Host 半边自己报告的：能力探测、最近错误、以及它是否已把自己停用。',
  'status.hostNoResponse': 'Host 半边没有回应',
  'status.routerOn': '已启用', 'status.routerOff': '未启用',
  'common.listSeparator': '、',
  'status.failureEntry': '{id}（{count} 次）',
  'status.summary': 'Host 半边在线 · 路由{routing} · {tasks} 个任务 · 委派工具已生效 {applied} / 已挂载 {installed} 个会话',
  'status.breaker': '本插件已自动停用（连续失败 {consecutive} 次，阈值 {threshold}）：{reason}。约 60 秒后自动重试；改动任意设置可立即重置。',
  'status.presetSummary': '{presets} 个预设已授权 · {tasks} 个任务 · {models} 个可用模型',
  'status.masterOff': '总开关未开：子智能体不会被路由',
  'status.noPresets': '还没有授权任何预设：请到「按预设授权」勾选至少一个',
  'status.missingCapMsg': '以下能力在当前 DSH 版本里没找到，相关功能已自动降级：{missing}。路由本身不依赖它们；委派工具的安装依赖 agents / subagents / tools。',
  'status.strugglingMsg': '这些 provider 最近请求失败较多，池里含它们会白烧一次重试：{failures}。',
  'status.errorCount': '最近 {count} 条 Host 错误',
  'status.refreshHealth': '刷新 Host 状态',
  'status.disablePlugin': '停用本插件', 'status.enablePlugin': '启用本插件',
  'status.emergencyClose': '紧急关闭（设置页也打不开时）：编辑 ',
  'status.emergencyPath': '%DSH_HOME%\\profiles\\web\\cordis.patch.yml',
  'status.emergencyApply': '——把 ',
  'status.emergencyToLine': ' 加到这一行：',
  'status.emergencyValue': 'disabled: true',
  'status.emergencyAction': '，重启 dsh web 即可。预设文件与其它设置都不会被改动。',
  'notice.saved': '已保存（{count} 项）',
  'notice.noUnsaved': '没有未保存的修改', 'notice.unsavedLabel': '未保存：',
  'btn.cancel': '取消', 'btn.save': '保存', 'btn.saving': '保存中…',
  'btn.saveTitleWrite': '把本次修改作为一个原子操作写入', 'btn.saveTitleNotWritable': '当前连接不可写',
  'cascade.title': '判定顺序', 'cascade.subtitle': '每一次子智能体的请求按下面的顺序判定，命中即停。',
  'cascade.rule1.label': '显式指令 —— ',
  'cascade.rule1.before': '消息里出现 ', 'cascade.rule1.code': '[task: 任务id]',
  'cascade.rule1.after': '，直接使用它。',
  'cascade.rule2.label': '关键词 —— ', 'cascade.rule2.desc': '该任务配置的关键词出现在最近的对话文本里。',
  'cascade.rule3.label': '语义分类 —— ', 'cascade.rule3.desc': '上面两条都没命中、且分类器已启用时，用一个廉价模型把这段文本归到某个任务的「描述」上。',
  'cascade.rule4.label': '默认任务 —— ', 'cascade.rule4.desc': '以上都没命中时用它。',
  'cascade.rule5.label': '都不适用 —— ', 'cascade.rule5.desc': '没有可用的默认任务时，保持子智能体原本继承的模型不变。',
  'cascade.hintExact': '「都没命中」的准确含义：没有显式指令、没有关键词命中、分类器没有给出候选内的答案。分类器每轮最多调用一次，同一轮的后续步骤复用该结果，所以一次工具调用不会中途换模型；分类器未启用、超时或答非所问时直接落到默认任务——缺席只会退化成默认，不会让这一轮失败。',
  'cascade.hintFallback': '模型失败时的退路：先在同一任务池内换下一个模型重试；整个池都失败时改用默认任务；默认任务也失败时不再改写路由，这一轮交回调用方自己继续。',
  'delegation.title': '委派工具',
  'delegation.subtitle': '本插件自己提供 subagent（派活）与 subagent_message（把修改意见发回同一个子智能体），并屏蔽同作用域内的内置委派工具——预设文件不需要任何改动。',
  'delegation.allowRedistribution': '允许子智能体再分发（默认关闭）',
  'delegation.redistributeHint': '关闭时（推荐）：子智能体是执行者，只干被派给它的活，不再往下派；需要拆分时它把拆分结果交回主智能体。开启时子智能体可以再往下派一层。无论开关如何，子智能体都不会拿到委派工具本身，层级由授权与作用域决定，不靠提示词约束。',
  'delegation.sustainableHint': '子智能体默认可持续：交付后仍然存活，主智能体用 subagent_message 把修改意见或下一步发回同一个子智能体，不必另开一个——任务归属因此始终清晰。若当前 DSH 的 spawn 后端不支持可持续子会话，插件会自动退回一次性委派，并把工具描述改成"每次委派都是一个新子智能体"，不会承诺做不到的事。',
  'masterSwitch.title': '总开关与默认任务',
  'masterSwitch.subtitle': '配置写在 Host 的设置文档里，重启后依然有效，与插件是否出现在左下角无关。',
  'masterSwitch.enableLabel': '启用任务路由', 'masterSwitch.enableHint': '只影响子智能体；关闭时任何会话的模型都不会被改动',
  'masterSwitch.defaultTaskLabel': '默认任务',
  'masterSwitch.noDefaultOption': '不设默认（没命中就不路由）',
  'masterSwitch.noDefaultMsg': '当前没有默认任务：只有明确命中的子智能体才会被路由，其余保持继承的模型。',
  'masterSwitch.defaultUsage': '未命中时使用「{taskId}」。该任务被停用或模型池为空时，等同于没有默认任务。',
  'classifier.title': '语义分类器',
  'classifier.subtitle': '只在前两条规则都没命中时才被问到，用于覆盖关键词写不出来的任务。',
  'classifier.enableLabel': '启用分类器', 'classifier.modelLabel': '分类模型',
  'classifier.inputLimitLabel': '每次判定的输入上限（tokens）',
  'classifier.timeoutLabel': '超时（ms）',
  'classifier.hint': '分类器只读到：子智能体的最初指令 + 最近几条消息，再按这个上限截断——所以无论对话多长，输入都不会超过它。判定本身很短（候选任务每个一行 + 一句回复），上限给 2000～4000 就够；这里填的是估算 token 数，中英混排按各自密度折算。',
  'taskPool.title': '任务与模型池',
  'taskPool.subtitle': '「描述」是分类器唯一读到的内容，写清这个任务是做什么的。池内多个模型按权重全局轮转，不区分会话。',
  'taskPool.noTasks': '还没有任务。点下面的「新建任务」开始。',
  'task.idPlaceholder': '任务 id：小写连字符。可在消息里用 [task: id] 直接指定',
  'task.badgeDefault': '默认', 'task.badgeDisabled': '已停用',
  'task.makeDefault': '设为默认', 'task.cancelDefault': '取消默认', 'task.delete': '删除',
  'task.nameLabel': '显示名', 'task.namePlaceholder': '例如：3D 建模',
  'task.keywordsLabel': '关键词（逗号分隔，可选）', 'task.keywordsPlaceholder': '命中即直接路由，不必等分类器',
  'task.descLabel': '描述（分类器读这段文字做判断）',
  'task.descPlaceholder': '例如：三维建模、CAD、机械结构设计、导出 STL/STEP、3D 打印件设计',
  'task.onLabel': '启用',
  'childProfile.title': '子智能体档案', 'childProfile.subtitle': '不设置就完全继承父预设',
  'childProfile.promptLabel': '提示词（留空 = 继承父预设）',
  'childProfile.promptPlaceholder': '这个任务的子智能体只读这一段系统提示词。留空则完全继承父预设。',
  'childProfile.fillTemplate': '填入通用执行者模板', 'childProfile.isTemplateBadge': '已是模板',
  'childProfile.clearBtn': '清空（回到继承）',
  'childProfile.reasoningEffortLabel': '推理强度', 'childProfile.reasoningDefault': '跟随路由默认（默认）',
  'childProfile.toolFilterLabel': '限制子智能体可用工具',
  'childProfile.toolFilterWarn': '读不到工具清单：请确认 Host 半边已重启',
  'childProfile.toolFilterHint': '不勾选 = 继承父预设的全部工具',
  'childProfile.hint': '子智能体没有自己的预设——它继承父预设。这两项是让它专用于本任务的办法：提示词会整体替换继承来的那段（作用域同名遮蔽 + complete），工具只留你勾的。无论怎么设置，子智能体都拿不到委派工具，能否再细分只由「委派工具」开关决定。',
  'pool.title': '模型池',
  'pool.modelCount': '{count} 个模型 · 权重合计 {total}',
  'pool.emptyBadge': '空池不会路由',
  'pool.weightHint': '权重是相对比例：2 与 1 表示它承担三分之二的流量；轮转是全局的，不区分会话',
  'pool.addModel': '+ 添加模型',
  'newTaskButton': '+ 新建任务',
  'authPreset.title': '按预设授权',
  'authPreset.subtitle': '任务库和模型池是全局的；这里只决定哪些预设允许使用路由。未勾选的预设完全不受影响。',
  'authPreset.emptyRoster': '预设清单为空：这台机器上一个可用预设都没有。先在「预设」页建一个，或确认 agent-presets 已配置。',
  'authPreset.rosterError': '读不到预设清单：{error}。Host 半边仍然正常工作，其他设置也照常保存。',
  'authPreset.exclusiveNone': '（无任务）',
  'authPreset.toggleAll': '改为全部任务',
  'authPreset.exclusiveSelect': '仅限指定任务',
  'preview.title': '路由预览',
  'preview.subtitle': '输入一句话，看看一个子智能体接到它时会落到哪个任务。纯本地判定，不发送任何请求。',
  'preview.noGrantOption': '（未授权预设）',
  'preview.placeholder': '例如：帮我用 FreeCAD 建一个齿轮',
  'catalog.title': '模型目录',
  'catalog.subtitle': '与输入框旁的模型选择器同源：Host 通过各 provider 适配器解析出的可用模型。池与分类器的选项都取自这里。',
  'catalog.loading': '读取中…',
  'catalog.modelCount': '可用模型 {count} 个，覆盖 {providers} 个 provider。',
  'catalog.refreshBtn': '刷新模型列表',
  'catalog.showAll': '查看全部可用模型',
  'routeProblem.corrupt': '这条路由此前版本的 bug 写坏了（model 是字符串 "undefined"）——请重新选择模型',
  'routeProblem.missing': '模型目录里找不到这条路由（{route}）——provider 可能已被移除，或模型已下架',
  'modelPicker.emptyLabel': '— 选择模型 —', 'modelPicker.emptyTitle': '选择一个模型',
  'modelOption.format': '{name}（{id}）',
  'weightTitle': '权重：相对比例。2 表示它承担的流量是权重 1 的两倍',
  'removeModelTitle': '移除这个模型',
  'fetchRoute.error': 'modelCatalog 远程接口不可用',
  'fetchRoute.readFailed': '模型目录读取失败',
  'fetchRoute.failDetail': '目录读取失败',
  'fetchPreset.error': 'agentPresets 远程接口不可用',
  'fetchPreset.readFailed': '预设清单读取失败',
  'fetchPreset.formatterror': '预设清单格式无法识别',
  'saveBar.errorsJoined': '保存失败',
  'healthConn.error': 'Host 状态接口返回 {code}：Host 半边可能没有挂载或已崩溃',
  'healthConn.noFetch': '当前环境没有 fetch，无法读取 Host 状态',
  'persona.template.line1': '你是被委派的执行者，只负责交付给你的那一个闭包任务。',
  'persona.template.line2': '只使用你手上的工具，在该任务范围内工作；不要越过它去处理主智能体的事务。',
  'persona.template.line3': '任务说明就是你收到的全部背景——需要外部信息就自己取，取不到就说明缺什么，不要猜。',
  'persona.template.line4': '交付时给出结论、依据与已验证的范围；未验证的部分明确标注。',
  'defaultTaskName': '新任务',
  'result.disabled': '判定结果：disabled（总开关未开）',
  'result.presetNotGranted': '判定结果：preset（该预设未授权，不会路由）',
  'result.explicitDirective': '判定结果：deterministic · 任务：{id}（来自 [task: …] 指令）',
  'result.keywordHit': '判定结果：deterministic · 任务：{id}（关键词命中）',
  'result.defaultWithClassifier': '判定结果：语义分类 → default · 任务：{id}（分类器会先被问一次；答案不在候选内时落到这里）',
  'result.defaultWithoutClassifier': '判定结果：default · 任务：{id}（分类器未启用）',
  'result.unmatched': '判定结果：unmatched（没有命中，也没有可用的默认任务 → 保持继承的模型）',
  'presets.exclusiveLabel': '仅限 {tasks}',
}, en: {
  'nav.label': 'Task Routing', 'header.title': 'Task Routing',
  'header.subtitle': 'Pick models per-task for sub-agents. The main conversation always uses the model you choose beside the input box — this plugin doesn\'t touch it.',
  'error.renderFailed.title': 'Settings Page Render Failed',
  'error.renderFailed.detail': 'The plugin itself still runs: routing and delegation are handled by the Host side. This error only affects this page\'s display. Full stack traces are logged to the browser console.',
  'error.connectHostFailed.title': 'Cannot Connect to Host',
  'error.connectHostFailed.detail': 'The Host side is still working normally; other settings pages continue to function.',
  'error.mirrorUnavailable.title': 'Settings Mirror Unavailable',
  'error.mirrorUnavailable.detail': 'This page requires a settings mirror from settingsScope; since it is not available, the page is read-only.',
  'error.mirrorReadWriteError.title': 'Settings Read/Write Error',
  'error.mirrorReadWriteError.detail': 'This page still renders, but read/write operations may not take effect. The Host side and routing itself are unaffected.',
  'error.configUnreadable.title': 'Configuration Unreadable',
  'error.configUnreadable.detail': 'The Host side has not registered the model-routing namespace yet, or the current connection persists preferences in-process (memory mode). Confirm the plugin loads with your profile, then refresh the page.',
  'error.saveFailed.title': 'Save Failed',
  'error.catalogReadFailed.title': 'Failed to Read Model Catalog',
  'status.loading': 'Loading…', 'status.active': 'Active', 'status.inactive': 'Inactive', 'status.readOnly': 'Read-only',
  'status.healthTitle': 'Runtime Status',
  'status.healthSubtitle': 'Reported by the Host side itself: capability probes, recent errors, and whether it disabled itself.',
  'status.hostNoResponse': 'Host side not responding',
  'status.routerOn': 'enabled', 'status.routerOff': 'disabled',
  'common.listSeparator': ', ',
  'status.failureEntry': '{id} ({count} failures)',
  'status.summary': 'Host side online · routing {routing} · {tasks} tasks · delegation active in {applied} of {installed} sessions',
  'status.breaker': 'This plugin auto-disabled itself ({consecutive} consecutive failures, threshold {threshold}): {reason}. It retries in about 60 seconds; any settings change resets the count immediately.',
  'status.presetSummary': '{presets} presets authorized · {tasks} tasks · {models} models available',
  'status.masterOff': 'The master switch is off: sub-agents will not be routed',
  'status.noPresets': 'No preset is authorized yet: tick at least one under "Presets Authorization"',
  'status.missingCapMsg': 'The following capabilities were not found in this DSH version; related features have been automatically downgraded: {missing}. Routing itself does not depend on them; delegation tool installation depends on agents / subagents / tools.',
  'status.strugglingMsg': 'These providers have had many recent failures; pools containing them waste retries: {failures}.',
  'status.errorCount': 'Recent {count} Host errors',
  'status.refreshHealth': 'Refresh Host Status',
  'status.disablePlugin': 'Disable Plugin', 'status.enablePlugin': 'Enable Plugin',
  'status.emergencyClose': 'Emergency disable (when even this settings page will not open): edit ',
  'status.emergencyPath': '%DSH_HOME%\\profiles\\web\\cordis.patch.yml',
  'status.emergencyApply': ' — add ',
  'status.emergencyToLine': ' to the line for ',
  'status.emergencyValue': 'disabled: true',
  'status.emergencyAction': ', then restart dsh web. Preset files and other settings are untouched.',
  'notice.saved': 'Saved ({count} items)',
  'notice.noUnsaved': 'No unsaved changes', 'notice.unsavedLabel': 'Unsaved: ',
  'btn.cancel': 'Cancel', 'btn.save': 'Save', 'btn.saving': 'Saving…',
  'btn.saveTitleWrite': 'Write this change as an atomic operation', 'btn.saveTitleNotWritable': 'Current connection is not writable',
  'cascade.title': 'Evaluation Order', 'cascade.subtitle': 'Each sub-agent request is evaluated in order below; the first hit wins.',
  'cascade.rule1.label': 'Explicit directive — ',
  'cascade.rule1.before': 'A message containing ', 'cascade.rule1.code': '[task: task-id]',
  'cascade.rule1.after': ' uses it directly.',
  'cascade.rule2.label': 'Keywords — ', 'cascade.rule2.desc': 'Keywords configured for the task appear in the recent conversation text.',
  'cascade.rule3.label': 'Semantic classification — ', 'cascade.rule3.desc': 'Neither of the above matched and the classifier is enabled: a cheap model classifies this text into a task description.',
  'cascade.rule4.label': 'Default task — ', 'cascade.rule4.desc': 'Used when none of the above matches.',
  'cascade.rule5.label': 'None applicable — ', 'cascade.rule5.desc': 'When no default task is available, the sub-agent keeps its inherited model unchanged.',
  'cascade.hintExact': 'Meaning of "no match": no explicit directive, no keyword hit, and the classifier didn\'t produce a candidate within scope. The classifier is called at most once per round; subsequent steps reuse the result, so a single tool invocation won\'t switch models mid-flight. If the classifier is disabled, times out, or answers off-topic, control falls through to the default — absence degrades to default rather than failing the round.',
  'cascade.hintFallback': 'Model failure fallback: first retry with the next model in the same task pool; if the entire pool fails, fall back to the default task; if the default task also fails, stop rewriting the route and let the caller continue for this round.',
  'delegation.title': 'Delegation Tools',
  'delegation.subtitle': 'This plugin provides its own subagent (dispatch) and subagent_message (send feedback back to the sub-agent), and shadows the built-in delegation tools within the same scope — preset files need no changes.',
  'delegation.allowRedistribution': 'Allow sub-agents to redistribute work (default off)',
  'delegation.redistributeHint': 'When off (recommended): sub-agents are executors who do only what they\'re dispatched to and don\'t dispatch further; they return decomposition results to the main agent. When on, sub-agents may dispatch one level deeper. Regardless, sub-agents never receive the delegation tool itself; hierarchy is determined by authorization and scope, not prompt constraints.',
  'delegation.sustainableHint': 'Sub-agents are persistent by default: they remain alive after delivery, and the main agent sends modification notes or next steps back to the same sub-agent via subagent_message instead of opening a new one — keeping task ownership clear throughout. If the current DSH\'s spawn backend doesn\'t support persistent sub-sessions, the plugin automatically falls back to one-shot delegation and changes the tool description to "each dispatch is a new sub-agent", without promising what cannot be delivered.',
  'masterSwitch.title': 'Master Switch & Default Task',
  'masterSwitch.subtitle': 'Configuration lives in the Host settings document and survives restarts, independent of whether the plugin appears in the bottom-left corner.',
  'masterSwitch.enableLabel': 'Enable task routing', 'masterSwitch.enableHint': 'Affects sub-agents only; when off, no session model will be changed',
  'masterSwitch.defaultTaskLabel': 'Default task',
  'masterSwitch.noDefaultOption': 'No default (don\'t route when unmatched)',
  'masterSwitch.noDefaultMsg': 'No default task set: only explicitly-matched sub-agents will be routed; others keep their inherited model.',
  'masterSwitch.defaultUsage': 'On mismatch, use "{taskId}". When the task is disabled or its model pool is empty, it acts as though no default task exists.',
  'classifier.title': 'Semantic Classifier',
  'classifier.subtitle': 'Only consulted when neither of the first two rules matched, to cover tasks that keywords alone cannot express.',
  'classifier.enableLabel': 'Enable classifier', 'classifier.modelLabel': 'Classification model',
  'classifier.inputLimitLabel': 'Input limit per evaluation (tokens)',
  'classifier.timeoutLabel': 'Timeout (ms)',
  'classifier.hint': 'The classifier sees only: the sub-agent\'s initial instruction plus the most recent messages, truncated to this limit. No matter how long the conversation is, input won\'t exceed it. Evaluation itself is brief (one line per candidate task + a reply); a limit of 2000–4000 is sufficient. Enter estimated token count; mixed-language density is converted accordingly.',
  'taskPool.title': 'Tasks & Model Pool',
  'taskPool.subtitle': 'The description is the only content the classifier reads — write clearly what the task does. Models in the pool rotate globally by weight, regardless of session.',
  'taskPool.noTasks': 'No tasks yet. Click "New Task" below to get started.',
  'task.idPlaceholder': 'Task id: lowercase hyphens. Use [task: id] in messages to specify directly.',
  'task.badgeDefault': 'Default', 'task.badgeDisabled': 'Disabled',
  'task.makeDefault': 'Set as default', 'task.cancelDefault': 'Cancel default', 'task.delete': 'Delete',
  'task.nameLabel': 'Display name', 'task.namePlaceholder': 'e.g., 3D Modeling',
  'task.keywordsLabel': 'Keywords (comma-separated, optional)', 'task.keywordsPlaceholder': 'Directly routes on match, no need to wait for classifier',
  'task.descLabel': 'Description (classifier reads this for decisions)',
  'task.descPlaceholder': 'e.g., 3D modeling, CAD, mechanical structure design, STL/STEP export, 3D printed part design',
  'task.onLabel': 'Enable',
  'childProfile.title': 'Sub-agent Profile', 'childProfile.subtitle': 'If unset, fully inherits from the parent preset',
  'childProfile.promptLabel': 'Prompt (leave blank = inherit parent preset)',
  'childProfile.promptPlaceholder': 'This task\'s sub-agents read only this system prompt. Leave blank to fully inherit the parent preset.',
  'childProfile.fillTemplate': 'Fill generic executor template', 'childProfile.isTemplateBadge': 'Already template',
  'childProfile.clearBtn': 'Clear (back to inherit)',
  'childProfile.reasoningEffortLabel': 'Reasoning effort', 'childProfile.reasoningDefault': 'Follow route default (default)',
  'childProfile.toolFilterLabel': 'Limit sub-agent available tools',
  'childProfile.toolFilterWarn': 'Cannot read tool list: please confirm the Host side has restarted',
  'childProfile.toolFilterHint': 'Unchecked = inherit all tools from parent preset',
  'childProfile.hint': 'Sub-agents have no separate presets — they inherit the parent. These two controls let you specialize them for this task: the prompt replaces the inherited one entirely (scope shadowing + complete), and only the tools you check remain. No matter the setting, sub-agents never receive the delegation tool; further subdivision depends solely on the "Delegation Tools" toggle.',
  'pool.title': 'Model Pool',
  'pool.modelCount': '{count} models · Total weight {total}',
  'pool.emptyBadge': 'Empty pool won\'t route',
  'pool.weightHint': 'Weights are relative ratios: 2 vs 1 means it takes two-thirds of the traffic; rotation is global, regardless of session.',
  'pool.addModel': '+ Add Model',
  'newTaskButton': '+ New Task',
  'authPreset.title': 'Presets Authorization',
  'authPreset.subtitle': 'The task library and model pool are global; here you decide which presets may use routing. Unchecked presets are completely unaffected.',
  'authPreset.emptyRoster': 'Preset roster is empty: no usable presets exist on this machine. Create one on the "Presets" page first, or confirm agent-presets is configured.',
  'authPreset.rosterError': 'Cannot read preset roster: {error}. The Host side remains healthy; other settings save normally.',
  'authPreset.exclusiveNone': '(no tasks)',
  'authPreset.toggleAll': 'Switch to all tasks',
  'authPreset.exclusiveSelect': 'Assign specific tasks only',
  'preview.title': 'Routing Preview',
  'preview.subtitle': 'Enter a sentence to see which task a sub-agent would land on. Pure local evaluation — no requests sent.',
  'preview.noGrantOption': '(no authorized preset)',
  'preview.placeholder': 'e.g., Help me build a gear with FreeCAD',
  'catalog.title': 'Model Catalog',
  'catalog.subtitle': 'Same source as the model picker beside the input: available models resolved by the Host through each provider adapter. Pool and classifier options all come from here.',
  'catalog.loading': 'Reading…',
  'catalog.modelCount': '{count} available models covering {providers} providers.',
  'catalog.refreshBtn': 'Refresh Model List',
  'catalog.showAll': 'View all available models',
  'routeProblem.corrupt': 'This route was corrupted by a bug in a previous version (model became the string "undefined") — please reselect the model',
  'routeProblem.missing': 'This route is missing from the model catalog ({route}) — the provider may have been removed, or the model has been delisted',
  'modelPicker.emptyLabel': '— Select Model —', 'modelPicker.emptyTitle': 'Select a model',
  'modelOption.format': '{name} ({id})',
  'weightTitle': 'Weight: relative ratio. 2 means it handles twice the traffic of weight 1.',
  'removeModelTitle': 'Remove this model',
  'fetchRoute.error': 'modelCatalog remote interface unavailable',
  'fetchRoute.readFailed': 'Model catalog read failed',
  'fetchRoute.failDetail': 'Catalog read failed',
  'fetchPreset.error': 'agentPresets remote interface unavailable',
  'fetchPreset.readFailed': 'Preset roster read failed',
  'fetchPreset.formatterror': 'Preset roster format unrecognized',
  'saveBar.errorsJoined': 'Save failed',
  'healthConn.error': 'Host status endpoint returned {code}: Host side may not be mounted or has crashed',
  'healthConn.noFetch': 'Current environment has no fetch; unable to read Host status',
  'persona.template.line1': 'You are a delegated executor, responsible only for delivering the one closed task given to you.',
  'persona.template.line2': 'Use only the tools at hand, work within this task; do not cross over to handle the main agent\'s matters.',
  'persona.template.line3': 'The task instructions are all the background you receive — if you need external information, fetch it yourself; if you can\'t, say what\'s missing. Don\'t guess.',
  'persona.template.line4': 'Deliver conclusions, evidence, and verified scope; unverified parts should be clearly labeled.',
  'defaultTaskName': 'New Task',
  'result.disabled': 'Result: disabled (master switch not on)',
  'result.presetNotGranted': 'Result: preset (this preset not granted, will not route)',
  'result.explicitDirective': 'Result: deterministic · Task: {id} (from [task: …] directive)',
  'result.keywordHit': 'Result: deterministic · Task: {id} (keyword hit)',
  'result.defaultWithClassifier': 'Result: semantic classification → default · Task: {id} (classifier asked first; answer not in candidates falls here)',
  'result.defaultWithoutClassifier': 'Result: default · Task: {id} (classifier not enabled)',
  'result.unmatched': 'Result: unmatched (nothing matched, and no default task available → keep inherited model)',
  'presets.exclusiveLabel': 'Limited to {tasks}',
}}
/**
 * The copy bridge.
 *
 * `t` is resolved at CALL time and points at the harness's own translate function
 * once `apply` has run, which is what makes a language switch take effect on the
 * next render instead of at plugin load. The defaults keep a component renderable
 * before that wiring exists (and in a test): Chinese, because that is the language
 * every key is authored in.
 */
const localeBridge = { t: key => COPY.zh[key] ?? key, subscribe: () => () => {}, revision: 0 }

/** The active language's copy for one key. */
function t(key) {
  return localeBridge.t(key)
}

/** Component-side hook: re-renders this subtree when the harness language changes. */
function useCopy() {
  const [, force] = ReactLib.useState(0)
  ReactLib.useEffect(() => localeBridge.subscribe(() => force(n => n + 1)), [])
  return localeBridge.t
}

/** Settings namespace the Host half registers. */
const NAMESPACE = 'model-routing'

/** Section identity: order 12 seats it between Models (10) and Plugins (15). */
const SECTION = { name: 'settings.section', id: NAMESPACE, order: 12 }

/**
 * The nav glyph: a routing fork — one path in, two out, one carrying the model
 * marker. Drawn on the same 16px grid and stroke weight as the shipped outline
 * icons, in `currentColor` so it follows the theme.
 *
 * Applied by overriding `background-image` on this section's own nav row, keyed
 * by its id. If the shell ever marks the row differently the override simply
 * stops applying and the default gear returns — it cannot break the row.
 */
const NAV_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none"'
  + ' stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M1.9 8h3.2"/><circle cx="6.4" cy="8" r="1.5"/>'
  + '<path d="M7.9 7.1 10.4 4.6h2.1"/><path d="M7.9 8.9l2.5 2.5h2.1"/>'
  + '<circle cx="13.9" cy="4.6" r="1.4"/><circle cx="13.9" cy="11.4" r="1.4"/></svg>'

const NAV_ICON_URL = `url("data:image/svg+xml,${encodeURIComponent(NAV_ICON)}")`

const STYLES = `
.dsh-mr { display:flex; flex-direction:column; gap:22px; font-size:13px; line-height:1.55; }
/* Every control is border-box: without it a 100%-width textarea adds its own
   padding and border on top and overflows the panel by exactly that much,
   which is what the description box was doing. */
.dsh-mr *, .dsh-mr *::before, .dsh-mr *::after { box-sizing:border-box; }
.dsh-mr-head { display:flex; flex-direction:column; gap:6px; }
.dsh-mr-head h2 { margin:0; font-size:17px; font-weight:650; letter-spacing:.2px; }
.dsh-mr-head p { margin:0; opacity:.7; font-size:12px; }
.dsh-mr-status { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

.dsh-mr-card { border:1px solid var(--dsh-border, rgba(128,128,128,.3)); border-radius:10px; padding:18px 20px; }
.dsh-mr-card > h3 { margin:0 0 4px; font-size:13.5px; font-weight:650; }
.dsh-mr-card > .dsh-mr-sub { margin:0 0 14px; opacity:.68; font-size:12px; }

.dsh-mr-row { display:flex; align-items:center; gap:10px; min-height:30px; flex-wrap:wrap; }
.dsh-mr-row + .dsh-mr-row { margin-top:10px; }
.dsh-mr-row > label.dsh-mr-key { flex:0 0 104px; opacity:.78; }
.dsh-mr-hint { opacity:.65; font-size:12px; }
.dsh-mr-error { color:#e5534b; }
.dsh-mr-empty { opacity:.65; font-size:12px; }

/* One consistent control look, and a focus ring that reads in both themes:
   a border-only focus was nearly invisible on a dark panel. */
.dsh-mr input[type=text], .dsh-mr input[type=number], .dsh-mr select, .dsh-mr textarea {
  background:var(--dsh-input-bg, rgba(128,128,128,.08)); color:inherit;
  border:1px solid var(--dsh-border, rgba(128,128,128,.42)); border-radius:7px;
  padding:7px 10px; font:inherit; min-width:0; max-width:100%;
}
.dsh-mr textarea { width:100%; resize:vertical; min-height:64px; line-height:1.5; }
.dsh-mr input:hover, .dsh-mr select:hover, .dsh-mr textarea:hover {
  border-color:var(--dsh-border-strong, rgba(128,128,128,.62));
}
.dsh-mr input:focus, .dsh-mr select:focus, .dsh-mr textarea:focus {
  outline:none; border-color:var(--dsh-accent, #4a9eff);
  box-shadow:0 0 0 2px color-mix(in srgb, var(--dsh-accent, #4a9eff) 25%, transparent);
}
.dsh-mr input:disabled, .dsh-mr select:disabled, .dsh-mr textarea:disabled { opacity:.55; cursor:not-allowed; }
.dsh-mr-grow { flex:1 1 180px; min-width:0; }

.dsh-mr button { background:var(--dsh-button-bg, rgba(128,128,128,.1)); color:inherit;
  border:1px solid var(--dsh-border, rgba(128,128,128,.42)); border-radius:7px;
  padding:7px 14px; font:inherit; cursor:pointer; white-space:nowrap; }
.dsh-mr button:hover { border-color:var(--dsh-accent, #4a9eff); }
.dsh-mr button:disabled { opacity:.5; cursor:not-allowed; }
.dsh-mr button.dsh-mr-danger:hover { border-color:#e5534b; color:#e5534b; }
.dsh-mr button.dsh-mr-icon { padding:6px 10px; line-height:1; }

/* A task: identity stacked on top, model pool below, both full width. A
   two-column grid here squeezed the description into a narrow strip. */
.dsh-mr-task { border:1px solid var(--dsh-border, rgba(128,128,128,.22)); border-radius:9px;
  padding:14px; margin-top:14px; background:var(--dsh-surface-alt, rgba(128,128,128,.035)); }
.dsh-mr-task:first-of-type { margin-top:0; }
.dsh-mr-task-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:12px; }
.dsh-mr-task-head input[type=text] { width:158px; font-weight:600; }
/* One field per row: two columns made the keyword box and the name box fight
   for the same line and left both too narrow to read. */
.dsh-mr-grid2 { display:grid; grid-template-columns:1fr; gap:14px; }
.dsh-mr-field { display:flex; flex-direction:column; gap:5px; min-width:0; }
.dsh-mr-field > span { font-size:11px; opacity:.62; }
.dsh-mr-field input, .dsh-mr-field select { width:100%; }

.dsh-mr-pool { margin-top:14px; border-top:1px dashed var(--dsh-border, rgba(128,128,128,.3)); padding-top:12px; }
.dsh-mr-pool-head { display:flex; align-items:baseline; gap:10px; margin-bottom:10px; flex-wrap:wrap; }
.dsh-mr-pool-head strong { font-size:12.5px; font-weight:650; }
.dsh-mr-pool-head span { font-size:11.5px; opacity:.62; }

/* Fixed-width weight + button; only the select flexes, so nothing is pushed
   past the panel's right edge. */
.dsh-mr-model { display:grid; grid-template-columns:minmax(0,1fr) 84px 36px; gap:10px; align-items:center; }
.dsh-mr-model + .dsh-mr-model { margin-top:8px; }
.dsh-mr-model select { width:100%; }
.dsh-mr-weight { display:flex; align-items:center; }
.dsh-mr-weight input { width:100%; text-align:center; }
.dsh-mr-missing { grid-column:1 / -1; font-size:11px; color:#d29922; margin-top:-2px; }

.dsh-mr-badge { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.4)); white-space:nowrap; }
.dsh-mr-badge.warn { border-color:#d29922; color:#d29922; }
.dsh-mr-badge.bad { border-color:#e5534b; color:#e5534b; }
.dsh-mr-badge.ok { border-color:#3fb950; color:#3fb950; }

.dsh-mr-problems { border-color:#e5534b; }
.dsh-mr-preset { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:12px; align-items:center; min-height:32px; }
.dsh-mr-preset + .dsh-mr-preset { margin-top:8px; }
.dsh-mr-preset code { font-size:12px; }
.dsh-mr-diag { margin-top:12px; font-size:11px; opacity:.7; }
.dsh-mr-diag summary { cursor:pointer; }
.dsh-mr-diag pre { white-space:pre-wrap; word-break:break-all; margin:8px 0 0; font-size:11px; }

.dsh-mr-help { display:flex; flex-direction:column; gap:12px; }
.dsh-mr-help ol { margin:0; padding-left:20px; display:flex; flex-direction:column; gap:9px; }
.dsh-mr-help li code { font-size:11.5px; padding:1px 5px; border-radius:4px; background:rgba(128,128,128,.16); }
/* The save bar sticks to the top of the scrolling panel: always reachable,
   and opaque so content cannot read through it while scrolling. */
.dsh-mr-savebar { position:sticky; top:0; z-index:3; display:flex; align-items:center;
  justify-content:space-between; gap:12px; flex-wrap:wrap;
  margin:0 0 18px; padding:10px 14px; border-radius:9px;
  border:1px solid var(--dsh-border, rgba(128,128,128,.34));
  background:var(--dsh-surface, Canvas); box-shadow:0 2px 10px rgba(0,0,0,.10); }
.dsh-mr-savebar.dirty { border-color:var(--dsh-accent, #4a9eff); }
.dsh-mr-savebar-state { font-size:12.5px; opacity:.85; min-width:0; overflow-wrap:anywhere; }
.dsh-mr-savebar-actions { display:flex; gap:8px; flex:0 0 auto; }
.dsh-mr button.dsh-mr-primary { border-color:var(--dsh-accent, #4a9eff);
  background:color-mix(in srgb, var(--dsh-accent, #4a9eff) 18%, transparent); font-weight:600; }
.dsh-mr button:disabled { opacity:.5; cursor:default; }
/* One vertical rhythm for stacked fields.
   Ad-hoc per-element margins are exactly what let a button sit flush against the
   field below it. With a single stack the gap is decided once and every child
   inherits it, so a control added later cannot reintroduce the collision. */
.dsh-mr-stack { display:flex; flex-direction:column; gap:14px; margin-top:12px; }
.dsh-mr-stack > * { margin:0; }
/* The click-only tool picker: a wrapped row of toggles, no typing anywhere. */
.dsh-mr-tools { display:flex; flex-wrap:wrap; gap:6px; }
/* Width follows the NAME: a chip is exactly as wide as its label needs, and a
   long identifier never wraps in the middle. A fixed width would clip short
   names and mangle long ones. */
.dsh-mr-tool { display:inline-flex; align-items:center; gap:6px; padding:4px 10px;
  max-width:100%; white-space:nowrap;
  border:1px solid var(--dsh-border, rgba(128,128,128,.4)); border-radius:999px;
  background:var(--dsh-input-bg, rgba(128,128,128,.08)); cursor:pointer; font-size:12px; }
.dsh-mr-tool code { overflow:hidden; text-overflow:ellipsis; }
.dsh-mr-tool.on { border-color:var(--dsh-accent, #4a9eff);
  background:color-mix(in srgb, var(--dsh-accent, #4a9eff) 16%, transparent); }
.dsh-mr-tool input { margin:0; flex:0 0 auto; }
.dsh-mr-help .dsh-mr-q { font-weight:600; opacity:.92; }

/* See NAV_ICON. The shell's glyph table has no entry for a third-party
   section and the registration contract has no icon field, so the row's own
   background carries this one. */
[data-settings-section="${NAMESPACE}"] svg,
[data-section-id="${NAMESPACE}"] svg { opacity:0 }
[data-settings-section="${NAMESPACE}"],
[data-section-id="${NAMESPACE}"] {
  background-image:${NAV_ICON_URL}; background-repeat:no-repeat;
  background-position:14px center; background-size:16px 16px;
}
`

// ─────────────────────────────────────────────────────────────────────────────
// The document
// ─────────────────────────────────────────────────────────────────────────────

/** The empty document, mirroring the Host's `defaultConfig()`. */
function emptyConfig() {
  return {
    enabled: false,
    defaultTaskId: '',
    classifier: { enabled: false, provider: '', model: '', maxInputTokens: 4000, timeoutMs: 15000 },
    presets: {},
    tasks: [],
  }
}

/** Coerce whatever the mirror holds into a document this page can render. */
function asConfig(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return emptyConfig()
  const base = emptyConfig()
  return {
    enabled: value.enabled === true,
    defaultTaskId: typeof value.defaultTaskId === 'string' ? value.defaultTaskId : '',
    classifier: value.classifier !== null && typeof value.classifier === 'object'
      ? { ...base.classifier, ...value.classifier }
      : base.classifier,
    presets: value.presets !== null && typeof value.presets === 'object' && !Array.isArray(value.presets)
      ? value.presets
      : {},
    tasks: Array.isArray(value.tasks) ? value.tasks : [],
  }
}

/** Read one nested field defensively. */
function at(object, path, fallback) {
  let cursor = object
  for (const key of path) {
    if (cursor === null || typeof cursor !== 'object') return fallback
    cursor = cursor[key]
  }
  return cursor === undefined ? fallback : cursor
}

/** Whether a route id is usable — mirrors the Host's `isRouteId`. */
function isRouteId(value) {
  return typeof value === 'string' && value.length > 0 && value !== 'undefined' && value !== 'null'
}

const routeKey = (provider, model) => `${provider}\u0000${model}`

function parseRouteKey(value) {
  const parts = String(value).split('\u0000')
  return { provider: parts[0], model: parts.slice(1).join('\u0000') }
}

// ─────────────────────────────────────────────────────────────────────────────
// Primitives
// ─────────────────────────────────────────────────────────────────────────────

function Toggle(props) {
  return E('div', { className: 'dsh-mr-row' },
    E('input', {
      type: 'checkbox',
      id: props.id,
      checked: props.checked === true,
      disabled: props.disabled === true,
      onChange: event => props.onChange(event.target.checked),
    }),
    E('label', { htmlFor: props.id, style: { flex: '0 0 auto', opacity: 1 } }, props.label),
    props.hint === undefined ? null : E('span', { className: 'dsh-mr-hint' }, props.hint))
}

function Card(props) {
  return E('section', { className: props.bad === true ? 'dsh-mr-card dsh-mr-problems' : 'dsh-mr-card' },
    props.title === undefined ? null : E('h3', null, props.title),
    props.subtitle === undefined ? null : E('p', { className: 'dsh-mr-sub' }, props.subtitle),
    props.children)
}

function Field(props) {
  return E('label', { className: 'dsh-mr-field' },
    E('span', null, props.label),
    props.children)
}

/**
 * Why a pool entry cannot be used, or `undefined` when it is fine.
 *
 * Both cases are reported rather than silently dropped, because a pool entry
 * that looks configured and can never resolve is worse than a visible error:
 * the task simply never routes, with nothing to explain it.
 *
 * @param candidate - one pool entry.
 * @param knownRoutes - route keys the live catalog advertises.
 * @returns a repair hint, or `undefined` when the entry is usable.
 */
function routeProblem(candidate, knownRoutes) {
  const providerOk = isRouteId(candidate?.provider)
  const modelOk = isRouteId(candidate?.model)
  if (!providerOk || !modelOk) {
    return t('routeProblem.corrupt')
  }
  if (!knownRoutes.has(routeKey(candidate.provider, candidate.model))) {
    return t('routeProblem.missing').replace('{route}', `${candidate.provider}/${candidate.model}`)
  }
  return undefined
}

/** One provider+model+weight row inside a task's pool. */
function ModelRow(props) {
  const { groups, candidate, index, knownRoutes, disabled, onChange, onRemove } = props
  const usable = isRouteId(candidate.provider) && isRouteId(candidate.model)
  const value = usable ? routeKey(candidate.provider, candidate.model) : ''
  const problem = routeProblem(candidate, knownRoutes)
  return E('div', { className: 'dsh-mr-model' },
    E('select', {
      value,
      disabled: disabled === true,
      title: value === '' ? t('modelPicker.emptyTitle') : `${candidate.provider}/${candidate.model}`,
      onChange: event => {
        if (event.target.value === '') return
        onChange({ ...parseRouteKey(event.target.value), weight: candidate.weight ?? 1 })
      },
    },
      E('option', { value: '' }, t('modelPicker.emptyLabel')), 
      ...modelOptions(groups)),
    E('div', { className: 'dsh-mr-weight' },
      E('input', {
        type: 'number',
        min: 1,
        step: 1,
        disabled: disabled === true,
        value: String(candidate.weight ?? 1),
        title: t('weightTitle'),
        onChange: event => onChange({
          ...candidate,
          weight: Math.max(1, Math.trunc(Number(event.target.value)) || 1),
        }),
      })),
    E('button', {
      type: 'button',
      className: 'dsh-mr-icon dsh-mr-danger',
      disabled: disabled === true,
      title: t('removeModelTitle'),
      onClick: () => onRemove(index),
    }, '\u00d7'),
    problem === undefined ? null : E('div', { className: 'dsh-mr-missing' }, problem))
}

/**
 * Local, synchronous preview of the cascade.
 *
 * Deliberately not a Host call: the deterministic ladder is pure, so running it
 * here answers instantly and cannot disagree with the Host. The only tier it
 * cannot run is the classifier, and it says so.
 */
function describePreview(config, text, presetId) {
  if (config.enabled !== true) return t('result.disabled')
  const grant = presetId === '' ? undefined : config.presets[presetId]
  if (grant === undefined) return t('result.presetNotGranted')
  const allowed = (task) => {
    if (task.enabled === false) return false
    if (!Array.isArray(task.pool) || task.pool.length === 0) return false
    if (grant.exclusive === true) return Array.isArray(grant.tasks) && grant.tasks.includes(task.id)
    return true
  }
  const candidates = config.tasks.filter(task => task !== null && typeof task === 'object' && allowed(task))
  const directive = /\[task:\s*([a-z0-9-]+)\s*\]/i.exec(text)
  const explicit = directive === null
    ? undefined
    : candidates.find(task => task.id === directive[1].toLowerCase())
  if (explicit !== undefined) return t('result.explicitDirective').replace('{id}', explicit.id)
  const keyword = candidates.find(task => Array.isArray(task.keywords)
    && task.keywords.some(word => typeof word === 'string' && word.length > 0 && text.includes(word)))
  if (keyword !== undefined) return t('result.keywordHit').replace('{id}', keyword.id)
  const fallback = config.defaultTaskId === ''
    ? undefined
    : candidates.find(task => task.id === config.defaultTaskId)
  if (fallback !== undefined) {
    const classifier = at(config, ['classifier', 'enabled'], false) === true
    return (classifier ? t('result.defaultWithClassifier') : t('result.defaultWithoutClassifier'))
      .replace('{id}', fallback.id)
  }
  return t('result.unmatched')
}

// ─────────────────────────────────────────────────────────────────────────────
// The page
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Host's model catalog -> picker routes.
 *
 * `remote.session.modelCatalog()` is the SAME catalog the composer's model
 * picker draws, so a model the page offers is one the Host has already resolved
 * through its adapters. Reading declared settings instead was wrong twice over:
 * it listed models from providers that cannot serve, and it missed every model
 * a provider discovers at runtime.
 */
function catalogFromModelCatalog(catalog) {
  const routes = []
  const seen = new Set()
  const push = (provider, model, name, providerName) => {
    if (typeof provider !== 'string' || provider.length === 0) return
    if (typeof model !== 'string' || model.length === 0) return
    const key = routeKey(provider, model)
    if (seen.has(key)) return
    seen.add(key)
    routes.push({
      provider,
      // The group carries the provider's DISPLAY name ("B.AI"), which is what a
      // human recognises; the id stays for the stored route.
      providerName: typeof providerName === 'string' && providerName.length > 0 ? providerName : provider,
      model,
      name: typeof name === 'string' && name.length > 0 ? name : model,
    })
  }
  for (const group of catalog?.groups ?? []) {
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      push(group?.id, model?.id, model?.name, group?.name)
    }
  }
  return routes
}

/**
 * One option label: the model's NAME reads first, its id only disambiguates.
 *
 * The id is what the config stores, so it must stay reachable — two providers
 * can offer the same display name, and a pool entry that says only "GLM 5.3
 * Flash" does not tell you which route it is.
 *
 * @param model - `{ id, name }` from the Host catalog.
 * @returns the label text.
 */
function modelOptionLabel(model) {
  const id = typeof model?.id === 'string' ? model.id : ''
  const name = typeof model?.name === 'string' && model.name.length > 0 && model.name !== id
    ? model.name
    : undefined
  return name === undefined
    ? id
    : t('modelOption.format').replace('{name}', name).replace('{id}', id)
}

/**
 * The `<optgroup>` list shared by every model picker on the page.
 *
 * One definition, so a pool entry and the classifier route are labelled the
 * same way and cannot drift apart.
 *
 * @param groups - `{ id, name, models: [{ id, name }] }[]` from the catalog.
 * @returns React children, ready to spread into a `<select>`.
 */
function modelOptions(groups) {
  return (groups ?? []).map(group => E('optgroup', { key: group.id, label: group.name },
    (group.models ?? []).map(model => E('option', {
      key: routeKey(group.id, model.id),
      value: routeKey(group.id, model.id),
    }, modelOptionLabel(model)))))
}

/**
 * @param props - owner props plus the injected faces: `scope` (settings mirror),
 *   `session` (the Host model catalog) and `roster` (preset ids).
 */
/**
 * Fetch the picker's routes from the Host catalog.
 *
 * Never throws: a dead or refused face must degrade to an error line on the
 * page, not to a blank card. A provider whose catalog failed is reported while
 * the providers that answered still contribute — a pool that silently lost a
 * model would be worse than one that says which provider is missing.
 *
 * @param sessionFace - `ctx.remote.session`.
 * @returns `{ routes, error }`, where `error` is '' when everything answered.
 */
async function fetchRoutes(sessionFace) {
  try {
    const response = await sessionFace?.modelCatalog?.()
    if (response === undefined) return { routes: [], error: t('fetchRoute.error') }
    if (response.ok !== true) {
      const code = response.error?.code ?? ''
      const message = response.error?.message ?? t('fetchRoute.readFailed')
      return { routes: [], error: code.length > 0 ? `${code}: ${message}` : message }
    }
    const failures = (response.value?.failures ?? [])
      .map(failure => `${failure?.name || failure?.id}: ${failure?.message ?? t('fetchRoute.failDetail')}`)
    return { routes: catalogFromModelCatalog(response.value), error: failures.join(t('common.listSeparator')) }
  } catch (failure) {
    return { routes: [], error: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * @param props - owner props plus the injected faces: `scope` (settings mirror),
 *   `session` (the Host model catalog) and `roster` (preset ids).
 */
/**
 * The preset ids this deployment offers, from the REMOTE face.
 *
 * `ctx.get('agentPresets')` is a Host service and is always undefined inside a
 * bundled Client plugin — that was the whole "读不到预设清单" failure. Every
 * shipped Client plugin reads the roster through `remote.agentPresets.list()`.
 *
 * @param face - `ctx.remote.agentPresets`.
 * @returns `{ ids, error }`, where `error` is '' when the roster answered.
 */
async function fetchPresets(face) {
  if (face === undefined || typeof face.list !== 'function') {
    return { ids: [], error: t('fetchPreset.error') }
  }
  try {
    const response = await face.list()
    if (response?.ok !== true) {
      const code = response?.error?.code ?? ''
      const message = response?.error?.message ?? t('fetchPreset.readFailed')
      return { ids: [], error: code.length > 0 ? `${code}: ${message}` : message }
    }
    // `list()` answers with the roster entries; tolerate a wrapper so a shape
    // change cannot silently empty the grant list again.
    const listed = Array.isArray(response.value) ? response.value : response.value?.presets
    if (!Array.isArray(listed)) return { ids: [], error: t('fetchPreset.formatterror') }
    return {
      ids: listed
        .filter(preset => typeof preset?.id === 'string' && preset.broken === undefined)
        .map(preset => preset.id),
      error: '',
    }
  } catch (failure) {
    return { ids: [], error: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * Drop the optional task fields a form left empty.
 *
 * "Empty" and "absent" must be the SAME thing in the saved document: the schema
 * rejects `childPersona: ''` and `childTools: {}`, so writing an emptied control
 * straight through would make the SAVE fail with a validation error the operator
 * cannot see the cause of. Removing the key is what "inherit" means anyway.
 *
 * @param task - the task after a control changed it.
 * @returns the same task with empty optional fields removed.
 */
function normalizeTask(task) {
  const next = { ...task }
  const blank = value => value === undefined || value === null || value === ''
    || (Array.isArray(value) && value.length === 0)
    || (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
  for (const field of ['reasoningEffort', 'childPersona']) {
    if (field in next && blank(next[field])) delete next[field]
  }
  // `childTools` needs its own rule: `{ allow: [] }` is a NON-empty object that
  // means "no tools at all" — the one value that must never be saved, because it
  // is never what un-ticking the last box meant. An empty filter is inheritance.
  const tools = next.childTools
  if (tools !== null && typeof tools === 'object') {
    const emptyList = list => !Array.isArray(list) || list.length === 0
    if (emptyList(tools.allow) && emptyList(tools.deny)) delete next.childTools
  }
  return next
}

/**
 * The built-in executor persona a task can adopt with one click.
 *
 * Generic on purpose: it says how to behave as a delegated executor, not what
 * the task is — the task's own `prompt` carries that. The operator can always
 * switch to 自定义 and write their own.
 */
/**
 * The executor template, resolved at CALL time so a language switch reaches it.
 *
 * It is a function rather than a constant because the text it fills is copy:
 * freezing it at module load would hand a Chinese template to an English reader.
 */
function executorPersona() {
  return [
    t('persona.template.line1'),
    t('persona.template.line2'),
    t('persona.template.line3'),
    t('persona.template.line4'),
  ].join('\n')
}

/**
 * What a freshly switched-on tool filter starts with: the ordinary work tools
 * that exist. Starting from "everything" would be a trap — most of the list is
 * coordination and delegation machinery the child should not have.
 *
 * @param names - the tool names the Host actually has.
 * @returns the initial allow list, never empty (an empty allow denies every tool).
 */
function defaultChildTools(names) {
  const available = Array.isArray(names) ? names : []
  const picked = DEFAULT_CHILD_TOOLS.filter(name => available.includes(name))
  return picked.length > 0 ? picked : available.slice(0, 1)
}

/** What a freshly enabled tool filter keeps, before the operator ticks boxes. */
const DEFAULT_CHILD_TOOLS = ['read', 'write', 'edit', 'glob', 'grep']

/**
 * Reasoning efforts a task may pin, as a click-only list.
 *
 * The adapter owns the vocabulary, so this is a convenience list, not a closed
 * set: an unknown value still reaches the adapter, which is the authority. The
 * empty option means "let the route decide".
 */
const REASONING_EFFORTS = ['off', 'low', 'medium', 'high']

/**
 * Every configuration path this page edits.
 *
 * Declared as data so it can be CHECKED against the plugin's own schema instead
 * of being a claim in a comment: `test-render.mjs` asserts this list covers
 * `SCHEMA_FIELDS` from the policy core, and the core asserts its own declaration
 * covers the document it actually ships. A field added to the core without a
 * control here fails that test — which is the only reliable way to stop the
 * settings page and the configuration from drifting apart.
 */
const EDITABLE_PATHS = [
  'enabled',
  'defaultTaskId',
  'childDelegation',
  'classifier.enabled',
  'classifier.provider',
  'classifier.model',
  'classifier.maxInputTokens',
  'classifier.timeoutMs',
  'presets',
  'tasks[].id',
  'tasks[].name',
  'tasks[].description',
  'tasks[].enabled',
  'tasks[].keywords',
  'tasks[].reasoningEffort',
  'tasks[].childPersona',
  'tasks[].childTools',
  'tasks[].pool',
  'tasks[].pool[].provider',
  'tasks[].pool[].model',
  'tasks[].pool[].weight',
]

/**
 * Canonical JSON for a settings document, with keys sorted at every level.
 *
 * The draft is built by spreading the stored document, so key order normally
 * matches — but "normally" is not a guarantee to compare values with. Sorting
 * makes the comparison about content only.
 *
 * @param value - any JSON-shaped value.
 * @returns its canonical text.
 */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
}

/** Whether two documents hold the same content, ignoring key order. */
function sameConfig(left, right) {
  if (left === null || right === null) return left === right
  return canonical(left) === canonical(right)
}

/** Top-level fields whose content differs. */
function diffFields(baseline, draft) {
  if (baseline === null || draft === null) return []
  const names = [...new Set([...Object.keys(baseline), ...Object.keys(draft)])]
  return names.filter(name => canonical(baseline[name]) !== canonical(draft[name]))
}

/**
 * The atomic mutation that turns `baseline` into `draft`.
 *
 * Top-level fields only: the namespace's `mutate` takes paths, and every field
 * this page edits is a top-level one, so a handful of `set` ops is both the
 * simplest expression of "save my edits" and the one that cannot half-apply —
 * the service gives all ops one revision fence and one persistence decision. A
 * field that disappeared is `unset`, so it re-inherits the composition layer
 * instead of being written back as a stale copy.
 *
 * @param baseline - the document the draft started from.
 * @param draft - the document to persist.
 * @returns ordered path operations, empty when nothing changed.
 */
function diffOps(baseline, draft) {
  return diffFields(baseline, draft).map(name => (name in draft
    ? { op: 'set', path: [name], value: draft[name] }
    : { op: 'unset', path: [name] }))
}

/**
 * A configuration mirror with the SAME surface as `ctx.settingsScope.bind(...)`.
 *
 * The configuration moved out of `settings.yaml` into its own folder, so the
 * settings mirror can no longer be its source — but the page's logic is draft +
 * revision fence + one atomic commit, which files serve just as well.
 * Reproducing the surface (`getSnapshot` / `subscribe` / `mutate` / `start`)
 * keeps every consumer unchanged: the editor, the save bar and the conflict
 * fence all keep working, and exactly one place knows about HTTP.
 *
 * @param doFetch - the platform fetch.
 * @param pollMs - how often to look for a change made elsewhere.
 * @returns the mirror.
 */
function createConfigMirror(doFetch, pollMs = 1500) {
  let snapshot = {
    status: 'loading', value: null, revision: 0,
    writable: typeof doFetch === 'function', mode: 'host', source: '', root: '',
  }
  const listeners = new Set()
  const publish = (next) => {
    snapshot = next
    for (const listener of listeners) {
      try {
        listener()
      } catch (error) {
        console.error('dsh-model-router: a configuration listener threw')
        console.error(error)
      }
    }
  }

  /** One read. Never throws: an unreachable Host is a state, not an exception. */
  const load = async () => {
    if (typeof doFetch !== 'function') {
      publish({ ...snapshot, status: 'unavailable' })
      return
    }
    try {
      const answer = await doFetch('/api/dsh-model-router/config', {
        headers: { accept: 'application/json' }, cache: 'no-store',
      })
      const body = answer?.ok === true ? await answer.json() : null
      if (body?.ok !== true) {
        publish({ ...snapshot, status: 'unavailable' })
        return
      }
      // A read that changes nothing must NOT publish: republishing the same
      // revision on every poll would re-render the page under the operator's
      // cursor — the bug this design exists to remove.
      if (snapshot.value !== null && body.revision === snapshot.revision) return
      publish({
        status: 'ready',
        value: body.config,
        revision: body.revision ?? 0,
        writable: true,
        mode: 'host',
        source: body.source ?? 'files',
        root: body.root ?? '',
      })
    } catch (error) {
      console.error('dsh-model-router: could not read the configuration')
      console.error(error)
      publish({ ...snapshot, status: 'unavailable' })
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Commit the whole document, fenced by the revision the draft started from. */
    async mutate(ops, expectedRevision, document) {
      const answer = await doFetch('/api/dsh-model-router/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: document ?? ops, revision: expectedRevision }),
      })
      const result = answer?.ok === true
        ? await answer.json()
        : { ok: false, problems: [`HTTP ${answer?.status ?? '?'}`] }
      if (result?.ok !== true) {
        const problems = Array.isArray(result?.problems) ? result.problems : [t('saveBar.errorsJoined')]
        throw new Error(problems.join(t('common.listSeparator')))
      }
      await load()
    },
    /** Begin polling; returns the stopper. */
    start() {
      // Nothing to poll without fetch, and an interval that can never succeed is
      // also a timer that keeps a process alive after its work is done.
      if (typeof doFetch !== 'function') return () => {}
      void load()
      const handle = setInterval(() => { void load() }, pollMs)
      return () => clearInterval(handle)
    },
  }
}

/**
 * The error boundary, built on FIRST USE rather than at module load.
 *
 * A class extending `React.Component` at module scope couples the whole bundle
 * to React being present and complete the moment the module is evaluated: any
 * partial React (a test loader's stub, a host that resolves the external late)
 * turns into `Class extends value undefined` and the plugin contributes NOTHING
 * at all — worse than any render error it was meant to catch. Creating it lazily
 * keeps module evaluation independent of React.
 *
 * @returns the boundary component class.
 */
let SectionBoundaryClass
function sectionBoundary() {  if (SectionBoundaryClass !== undefined) return SectionBoundaryClass

  /**
   * Catches ANY render-time throw in this section and shows it as a card.
   *
   * A settings section that throws renders as an EMPTY PANEL: the nav row is
   * there, the page is blank, and nothing anywhere says why. That is the worst
   * possible failure for a page whose job is to explain itself, and it is
   * unrecoverable from the outside — the operator cannot even tell which plugin
   * did it. This boundary converts that into a readable error while the section
   * keeps its frame.
   */
  SectionBoundaryClass = class SectionBoundary extends ReactLib.Component {
    constructor(props) {
      super(props)
      this.state = { error: null }
    }

    static getDerivedStateFromError(error) {
      return { error }
    }

    componentDidCatch(error, info) {
      const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error('dsh-model-router: the settings section threw while rendering')
      console.error(detail)
      console.error(info?.componentStack ?? '')
    }

    render() {
      if (this.state.error === null) return this.props.children
      const error = this.state.error
      return E('div', { className: 'dsh-mr' },
        E('h2', null, t('header.title')),
        E(Card, { bad: true, title: t('error.renderFailed.title') },
          E('div', { className: 'dsh-mr-error' },
            error instanceof Error ? error.message : String(error)),
          E('div', { className: 'dsh-mr-hint' },
            t('error.renderFailed.detail'))))
    }
  }
  return SectionBoundaryClass
}

/**
 * Read an OPTIONAL Cordis service, including the dotted Remote namespaces.
 *
 * `ctx.remote.agentPresets` is not a plain property: the gateway publishes each
 * namespace as a service named `remote.<ns>`, and reading an undeclared one off
 * the `remote` object can throw the very "cannot get property … without inject"
 * error that has already bitten this plugin once — during `inject()`, where it
 * costs the entire panel. `ctx.get(name)` is the sanctioned accessor for an
 * optional service and answers `undefined` instead of throwing.
 *
 * @param ctx - the plugin context.
 * @param name - exact service name, e.g. `remote.agentPresets`.
 * @returns the service, or undefined when it is absent.
 */
function optionalFace(ctx, name) {
  try {
    const face = ctx.get?.(name)
    return face === null ? undefined : face
  } catch {
    return undefined
  }
}

/**
 * Ask the Host half how it is doing.
 *
 * The Host half is a SEPARATE bundle on a separate plane: when it fails to
 * mount, nothing in this page can know except by asking. An unreachable or 404
 * endpoint is therefore not "no data" — it IS the diagnosis, and it is the one
 * failure an in-process reporter could never report.
 *
 * @param doFetch - the platform `fetch`, injected so tests need no global.
 * @returns `{ status, health, error }`; `status` is an HTTP code, 0 for a
 *   transport failure, or -1 when this environment has no fetch at all.
 */
async function fetchHealth(doFetch) {
  if (typeof doFetch !== 'function') {
    return { status: -1, health: null, error: t('healthConn.noFetch') }
  }
  try {
    const response = await doFetch('/api/dsh-model-router/health', {
      headers: { accept: 'application/json' },
      cache: 'no-store',
    })
    if (response?.ok !== true) {
      return {
        status: response?.status ?? 0,
        health: null,
        error: t('healthConn.error').replace('{code}', String(response?.status ?? '?')),
      }
    }
    const health = await response.json()
    return { status: 200, health, error: '' }
  } catch (failure) {
    return { status: 0, health: null, error: failure instanceof Error ? failure.message : String(failure) }
  }
}

/**
 * The classifier fields this page owns.
 *
 * Writing the whole `classifier` object back preserves any key an older build
 * left in the document — `maxInputChars` survived several rounds that way, and a
 * dead key in a settings file is a lie about what the plugin actually reads. The
 * write path rebuilds the object from the fields the adapter uses.
 *
 * @param current - the stored classifier object.
 * @param patch - fields to change.
 * @returns the classifier to persist.
 */
function classifierPatch(current, patch) {
  const base = current !== null && typeof current === 'object' ? current : {}
  const text = (value, fallback) => (typeof value === 'string' ? value : (typeof fallback === 'string' ? fallback : ''))
  return {
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : base.enabled === true,
    provider: text(patch.provider, base.provider),
    model: text(patch.model, base.model),
    maxInputTokens: Number(patch.maxInputTokens ?? base.maxInputTokens) || 4000,
    timeoutMs: Number(patch.timeoutMs ?? base.timeoutMs) || 15000,
  }
}

/**
 * Turn a health answer into exactly what the card shows.
 *
 * Pure, and separate from the JSX on purpose: the fetch runs in an effect, so a
 * server-side render never sees the data, and a page whose diagnostics are only
 * exercised in a browser is a page whose diagnostics are never tested.
 *
 * @param state - `{ status, health, error }` from {@link fetchHealth}.
 * @returns the lines and flags the card renders.
 */
function healthView(state) {
  const health = state?.health ?? null
  const reachable = state?.status === 200 && health !== null
  if (!reachable) {
    return {
      reachable: false,
      bad: true,
      summary: state?.error === undefined || state.error === '' ? t('status.hostNoResponse') : state.error,
      breaker: '', missing: [], struggling: [], errors: [], detail: '',
    }
  }
  const breaker = health.breaker ?? {}
  // A fiber is tracked the moment it exists, but Cordis starts a plugin
  // asynchronously: `applied` is how many have actually RUN their startup. The
  // two numbers differ only while an install is pending or stuck, and showing
  // the pair is what turns "已挂载 0" from a mystery into a diagnosis. An older
  // host reports no `applied` at all, so it falls back to the installed count
  // rather than displaying a misleading zero.
  const installed = health.delegation?.installed ?? 0
  const applied = typeof health.delegation?.applied === 'number' ? health.delegation.applied : installed
  const missing = Object.entries(health.capabilities ?? {})
    .filter(([, present]) => present !== true)
    .map(([name]) => name)
  const struggling = Object.entries(health.providers ?? {})
    .filter(([, entry]) => (entry?.failures ?? 0) >= 3)
    .map(([id, entry]) => t('status.failureEntry').replace('{id}', id).replace('{count}', String(entry.failures)))
  return {
    reachable: true,
    bad: breaker.tripped === true || missing.length > 0,
    summary: t('status.summary')
      .replace('{routing}', health.routing?.enabled === true ? t('status.routerOn') : t('status.routerOff'))
      .replace('{tasks}', String(health.routing?.tasks ?? 0))
      .replace('{applied}', String(applied))
      .replace('{installed}', String(installed)),
    breaker: breaker.tripped === true
      ? t('status.breaker')
        .replace('{consecutive}', String(breaker.consecutive ?? 0))
        .replace('{threshold}', String(breaker.threshold ?? 0))
        .replace('{reason}', breaker.reason ?? '')
      : '',
    missing,
    struggling,
    errors: Array.isArray(health.errors) ? health.errors : [],
    detail: '',
  }
}

function TaskRoutingSection(props) {
  // Subscription only: the hook re-renders this subtree when the harness language
  // changes, and every t(...) call below then resolves against the new dictionary.
  useCopy()
  const { scope, presets, session, fault } = props
  // A face that could not even be built is a diagnosis, not a crash: the page
  // still renders and says which face failed.
  if (typeof fault === 'string' && fault.length > 0) {
    return E('div', { className: 'dsh-mr' },
      E('h2', null, t('header.title')),
      E(Card, { bad: true, title: t('error.connectHostFailed.title') },
        E('div', { className: 'dsh-mr-error' }, fault),
        E('div', { className: 'dsh-mr-hint' },
          t('error.connectHostFailed.detail'))))
  }
  if (scope === undefined || typeof scope.subscribe !== 'function'
    || typeof scope.getSnapshot !== 'function') {
    return E('div', { className: 'dsh-mr' },
      E('h2', null, t('header.title')),
      E(Card, { bad: true, title: t('error.mirrorUnavailable.title') },
        E('div', { className: 'dsh-mr-hint' },
          t('error.mirrorUnavailable.detail'))))
  }
  // Every read of the settings mirror is TOTAL: a throwing face must not be
  // able to take the panel down. `useSyncExternalStore` calls both of these
  // during render, so an escaping throw here IS the blank page — and a blank
  // page says nothing about which plugin caused it.
  //
  // The message lives in a REF, not state: the reader runs during render, and
  // setting state there would be a render-phase update. A ref written before the
  // fallback is returned is already visible to the JSX built later in the SAME
  // pass, and the console error is deduplicated because this reader runs on
  // every render.
  const mirrorError = ReactLib.useRef('')
  const loggedFaceError = ReactLib.useRef('')
  const noteFaceFailure = ReactLib.useCallback((what, failure) => {
    const message = failure instanceof Error ? failure.message : String(failure)
    const summary = `${what}: ${message}`
    mirrorError.current = summary
    if (loggedFaceError.current !== summary) {
      loggedFaceError.current = summary
      console.error(`dsh-model-router: settings mirror ${what} failed`)
      console.error(failure)
    }
    return message
  }, [])
  const subscribe = ReactLib.useCallback(listener => {
    try {
      const unsubscribe = scope.subscribe(listener)
      return typeof unsubscribe === 'function' ? unsubscribe : () => {}
    } catch (failure) {
      noteFaceFailure('subscribe', failure)
      return () => {}
    }
  }, [scope, noteFaceFailure])
  const readSnapshot = ReactLib.useCallback(() => {
    try {
      const next = scope.getSnapshot()
      if (next !== null && typeof next === 'object') return next
      noteFaceFailure('getSnapshot', new Error(`returned ${typeof next}`))
    } catch (failure) {
      noteFaceFailure('getSnapshot', failure)
    }
    // A snapshot shaped like a mirror that has not synced yet: the page renders
    // its "unavailable" state, plus the reason above it.
    return { status: 'unavailable', value: null, revision: 0, writable: false, mode: undefined }
  }, [scope, noteFaceFailure])
  // Three arguments, not two: without the server snapshot React refuses to
  // render this component outside the browser, which makes the page
  // untestable and breaks any future server-side pass.
  const snapshot = ReactLib.useSyncExternalStore(subscribe, readSnapshot, readSnapshot)
  const [catalog, setCatalog] = ReactLib.useState(null)
  const [catalogError, setCatalogError] = ReactLib.useState('')
  const [rosterIds, setRosterIds] = ReactLib.useState([])
  const [rosterError, setRosterError] = ReactLib.useState('')
  const [healthState, setHealthState] = ReactLib.useState({ status: -1, health: null, error: '' })
  // The edit session: a local draft, the document it started from, and the
  // revision that fences the save.
  const [draft, setDraft] = ReactLib.useState(null)
  const [baseline, setBaseline] = ReactLib.useState(null)
  const [draftRevision, setDraftRevision] = ReactLib.useState(0)
  const [saving, setSaving] = ReactLib.useState(false)
  const [conflict, setConflict] = ReactLib.useState('')
  const [saveError, setSaveError] = ReactLib.useState('')
  const [notice, setNotice] = ReactLib.useState('')
  const [previewText, setPreviewText] = ReactLib.useState('')
  const [previewPreset, setPreviewPreset] = ReactLib.useState('')
  const timer = ReactLib.useRef(null)
  const revision = snapshot.revision

  /**
   * Poll the Host half's own report.
   *
   * Deliberately reached over HTTP rather than the settings namespace: runtime
   * state written into settings would persist noise and re-fire the watchers.
   * The absence of an answer is the most important thing this can learn — it is
   * how a half that failed to mount becomes visible instead of silent.
   */
  const loadHealth = ReactLib.useCallback(async () => {
    setHealthState(await fetchHealth(typeof fetch === 'function' ? fetch : undefined))
  }, [])
  ReactLib.useEffect(() => { void loadHealth() }, [loadHealth, revision])

  /**
   * The picker's model list, from the Host's own catalog.
   *
   * `remote.session.modelCatalog()` is the authoritative list: the Host resolves
   * it through its adapters, and the composer's model picker draws the same one.
   * Earlier attempts were wrong in turn — `llm.listModels` does not exist on the
   * Client face at all, and reading the models out of the settings document
   * showed entries from providers that cannot serve while missing everything a
   * provider discovers at runtime.
   */
  const loadCatalog = ReactLib.useCallback(async () => {
    const { routes, error } = await fetchRoutes(session)
    setCatalog({ routes })
    setCatalogError(error)
  }, [session])

  // The roster is loaded here rather than injected: `apply` runs once, long
  // before this page mounts, so an injected array would freeze at whatever the
  // roster happened to be at startup — including empty.
  const loadPresets = ReactLib.useCallback(async () => {
    const { ids, error } = await fetchPresets(presets)
    setRosterIds(ids)
    setRosterError(error)
  }, [presets])

  ReactLib.useEffect(() => { void loadPresets() }, [loadPresets, revision])

  ReactLib.useEffect(() => { void loadCatalog() }, [loadCatalog])
  ReactLib.useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current) }, [])

  // ── the edit session ──────────────────────────────────────────────────────
  //
  // Every input edits a LOCAL draft. Nothing is written while typing, which is
  // what fixes the caret jumping to the end: the field's value no longer comes
  // back from a persisted round trip. The draft is committed by ONE atomic
  // mutation, and Cancel simply drops it.
  const stored = asConfig(snapshot.value)
  const writable = snapshot.writable === true && snapshot.mode === 'host'
  const dirty = draft !== null && !sameConfig(draft, baseline)
  /** Fields the draft changes, for the save bar's summary and the diff. */
  const changedFields = draft === null ? [] : diffFields(baseline, draft)

  ReactLib.useEffect(() => {
    // Adopt the stored document when there is nothing to lose, and never while
    // the operator has unsaved edits: silently replacing a draft is how edits
    // disappear.
    if (draft === null || (!dirty && revision !== draftRevision)) {
      setDraft(stored)
      setBaseline(stored)
      setDraftRevision(revision)
      setConflict('')
    }
  }, [revision, draft, dirty, draftRevision, stored])

  /** Edit the draft. The only way any control changes anything. */
  const edit = (mutate) => {
    setNotice('')
    setSaveError('')
    setDraft(current => (current === null ? current : mutate(current)))
  }

  // Everything below reads the DRAFT, so a control never displays a value that
  // came back from a write it just made.
  const config = draft ?? stored

  /** Commit the draft as one atomic namespace mutation. */
  const save = async () => {
    if (draft === null || !dirty || saving) return
    const ops = diffOps(baseline, draft)
    if (ops.length === 0) return
    setSaving(true)
    setSaveError('')
    try {
      // The revision read when this draft started is the fence: a write from
      // another tab (or another page) makes this one fail loudly instead of
      // silently clobbering it.
      // The document is passed whole: files have no partial write, and the Host
      // validates the entire document before replacing the folder.
      await scope.mutate(ops, draftRevision, draft)
      setBaseline(draft)
      setNotice(t('notice.saved').replace('{count}', String(changedFields.length)))
    } catch (failure) {
      setSaveError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setSaving(false)
    }
  }

  /** Drop the draft: back to exactly what the Host has. */
  const cancel = () => {
    setDraft(baseline)
    setNotice('')
    setSaveError('')
    setConflict('')
  }

  const heading = E('div', { className: 'dsh-mr-head' },
    E('h2', null, t('header.title')),
    E('p', null, t('header.subtitle')))

  /**
   * The save bar.
   *
   * Sticky at the TOP of the panel, because that is the one place always on
   * screen whatever the scroll position — a bar at the bottom of a long page is
   * invisible exactly while it is needed. It states the edit state in words
   * ("未保存的修改：…"), so there is no guessing about whether a click was
   * committed, and it is the ONLY path that writes.
   */
  const saveBar = E('div', { className: dirty ? 'dsh-mr-savebar dirty' : 'dsh-mr-savebar' },
    E('span', { className: 'dsh-mr-savebar-state' },
      dirty
        ? `${t('notice.unsavedLabel')}${changedFields.join(t('common.listSeparator'))}`
        : (notice === '' ? t('notice.noUnsaved') : notice)),
    E('span', { className: 'dsh-mr-savebar-actions' },
      dirty ? E('button', { type: 'button', onClick: cancel, disabled: saving }, t('btn.cancel')) : null,
      E('button', {
        type: 'button',
        className: 'dsh-mr-primary',
        onClick: () => void save(),
        disabled: !dirty || saving || !writable,
        title: writable ? t('btn.saveTitleWrite') : t('btn.saveTitleNotWritable'),
      }, saving ? t('btn.saving') : t('btn.save'))))

  /** A broken settings mirror is stated on the page, never swallowed. */

  /**
   * Why the mirror is unusable, when the reader itself failed.
   *
   * Built here rather than at the bottom because BOTH early returns below have
   * to carry it: a mirror that throws lands in the `unavailable` branch, which
   * is exactly the case where the reason matters most.
   */
  const mirrorBanner = mirrorError.current === ''
    ? null
    : E(Card, { bad: true, title: t('error.mirrorReadWriteError.title') },
      E('div', { className: 'dsh-mr-error' }, mirrorError.current),
      E('div', { className: 'dsh-mr-hint' },
        t('error.mirrorReadWriteError.detail')))

  // A mirror that never took a section, or a connection keeping preferences
  // process-local: say so instead of rendering an empty form.
  if (snapshot.status === 'loading') {
    return E('div', { className: 'dsh-mr' }, heading, mirrorBanner,
      E('div', { className: 'dsh-mr-empty' }, t('status.loading')))
  }
  if (snapshot.status === 'unavailable') {
    return E('div', { className: 'dsh-mr' }, heading, mirrorBanner,
      E(Card, { bad: true, title: t('error.configUnreadable.title') },
        E('div', { className: 'dsh-mr-hint' },
          t('error.configUnreadable.detail'))))
  }

  // Group the flat route list by provider, preserving first-seen order so the
  // picker reads in the same order the settings document declares.
  const providerOrder = []
  const providerModels = new Map()
  for (const route of catalog?.routes ?? []) {
    if (!providerModels.has(route.provider)) {
      providerOrder.push(route.provider)
      providerModels.set(route.provider, [])
    }
    providerModels.get(route.provider).push({ id: route.model, name: route.name })
  }
  const groups = providerOrder.map(provider => ({
    id: provider,
    // The provider's display name, so the optgroup reads "B.AI" not "b-ai".
    name: (catalog?.routes ?? []).find(route => route.provider === provider)?.providerName ?? provider,
    models: providerModels.get(provider),
  }))
  // Built once and shared by both pickers, so a pool entry and the classifier
  // route are labelled identically — by NAME, with the stored id beside it.
  const knownRoutes = new Set((catalog?.routes ?? []).map(route => routeKey(route.provider, route.model)))

  const tasks = config.tasks
  const defaultTaskId = config.defaultTaskId
  const taskIds = tasks
    .filter(task => task !== null && typeof task === 'object' && isRouteId(task.id))
    .map(task => task.id)
  const presetIds = Array.isArray(rosterIds) ? rosterIds : []
  const grants = config.presets
  const grantedPresets = presetIds.filter(presetId => grants[presetId] !== undefined)
  const active = config.enabled === true && grantedPresets.length > 0

  const setTasks = (next) => edit(current => ({ ...current, tasks: next }))
  const updateTask = (index, patch) => setTasks(
    tasks.map((task, at2) => (at2 === index ? normalizeTask({ ...task, ...patch }) : task)))
  const setPool = (index, pool) => setTasks(
    tasks.map((task, at2) => (at2 === index ? { ...task, pool } : task)))

  const addTask = () => {
    let suffix = tasks.length + 1
    while (tasks.some(task => task.id === `task-${suffix}`)) suffix += 1
    setTasks([...tasks, {
      id: `task-${suffix}`, name: t('defaultTaskName'), description: '', enabled: true, keywords: [], pool: [],
    }])
  }

  /** Append a model the pool does not already use. */
  const addModel = (index) => {
    const pool = Array.isArray(tasks[index].pool) ? tasks[index].pool : []
    const free = (catalog?.routes ?? []).find(route => !pool.some(
      entry => entry.provider === route.provider && entry.model === route.model,
    ))
    if (free === undefined) return
    setPool(index, [...pool, { provider: free.provider, model: free.model, weight: 1 }])
  }

  const classifierProvider = at(config, ['classifier', 'provider'], '')
  const classifierModel = at(config, ['classifier', 'model'], '')
  const classifierValue = isRouteId(classifierProvider) && isRouteId(classifierModel)
    ? routeKey(classifierProvider, classifierModel)
    : ''

  // ── the Host half's own report ────────────────────────────────────────────
  const view = healthView(healthState)
  /**
   * Tool names the Host actually has, straight from its own health report.
   *
   * Choosing names from a list is what keeps the tool filter click-only. It also
   * removes the one footgun in that setting: a spawn request naming a tool the
   * child cannot see fails loudly, so a hand-typed name is a config that breaks
   * delegation at runtime.
   */
  const toolNames = Array.isArray(healthState.health?.tools) ? healthState.health.tools : []

  const healthCard = E(Card, {
    title: t('status.healthTitle'),
    subtitle: t('status.healthSubtitle'),
    bad: view.bad,
  },
    E('div', { className: view.reachable ? 'dsh-mr-hint' : 'dsh-mr-error' }, view.summary),

    // A tripped breaker is the plugin having disabled ITSELF: say so plainly,
    // because the visible symptom is otherwise just "routing stopped working".
    view.breaker === ''
      ? null
      : E('div', { className: 'dsh-mr-hint', style: { marginTop: '10px' } }, view.breaker),

    view.missing.length === 0
      ? null
      : E('div', { className: 'dsh-mr-hint', style: { marginTop: '10px' } },
        t('status.missingCapMsg').replace('{missing}', view.missing.join(t('common.listSeparator')))),

    view.struggling.length === 0
      ? null
      : E('div', { className: 'dsh-mr-hint', style: { marginTop: '10px' } },
        t('status.strugglingMsg').replace('{failures}', view.struggling.join(t('common.listSeparator')))),

    view.errors.length === 0
      ? null
      : E('details', { className: 'dsh-mr-diag', style: { marginTop: '10px' } },
        E('summary', null, t('status.errorCount').replace('{count}', String(view.errors.length))),
        E('pre', null, view.errors
          .map(entry => `${new Date(entry.at).toLocaleTimeString()}  ${entry.where}  ${entry.message}`)
          .join('\n'))),

    E('div', { className: 'dsh-mr-row', style: { marginTop: '12px' } },
      E('button', { type: 'button', onClick: () => void loadHealth() }, t('status.refreshHealth')),
      E('button', {
        type: 'button',
        onClick: () => edit(current => ({ ...current, enabled: current.enabled !== true })),
      }, config.enabled === true ? t('status.disablePlugin') : t('status.enablePlugin'))),

    E('div', { className: 'dsh-mr-hint', style: { marginTop: '10px' } },
      t('status.emergencyClose'),
      E('code', null, t('status.emergencyPath')),
      t('status.emergencyApply'),
      E('code', null, t('status.emergencyValue')),
      t('status.emergencyToLine'),
      E('code', null, 'dsh-model-router'),
      t('status.emergencyAction')))

  return E('div', { className: 'dsh-mr' },
    heading,
    saveBar,
    mirrorBanner,
    E('div', { className: 'dsh-mr-status' },
      E('span', { className: active ? 'dsh-mr-badge ok' : 'dsh-mr-badge warn' },
        active ? t('status.active') : t('status.inactive')),
      E('span', { className: 'dsh-mr-hint' },
        active
          ? t('status.presetSummary')
            .replace('{presets}', String(grantedPresets.length))
            .replace('{tasks}', String(tasks.length))
            .replace('{models}', String(catalog?.routes.length ?? 0))
          : config.enabled !== true
            ? t('status.masterOff')
            : t('status.noPresets')),
      // Closes the span, the status row, AND the root div's argument list is
      // still open — the cards below stay children of that div.
      writable ? null : E('span', { className: 'dsh-mr-badge warn' }, t('status.readOnly'))),

    saveError === '' ? null : E(Card, { bad: true, title: t('error.saveFailed.title') },
      E('div', { className: 'dsh-mr-error' }, saveError)),
    catalogError === '' ? null : E(Card, { bad: true, title: t('error.catalogReadFailed.title') },
      E('div', { className: 'dsh-mr-error' }, catalogError)),

    healthCard,

    E(Card, {
      title: t('cascade.title'),
      subtitle: t('cascade.subtitle'),
    },
      E('div', { className: 'dsh-mr-help' },
        E('ol', null,
          E('li', null,
            E('span', { className: 'dsh-mr-q' }, t('cascade.rule1.label')), 
            t('cascade.rule1.before'), E('code', null, t('cascade.rule1.code')), t('cascade.rule1.after')),
          E('li', null,
            E('span', { className: 'dsh-mr-q' }, t('cascade.rule2.label')), 
            t('cascade.rule2.desc')),
          E('li', null,
            E('span', { className: 'dsh-mr-q' }, t('cascade.rule3.label')), 
            t('cascade.rule3.desc')),
          E('li', null,
            E('span', { className: 'dsh-mr-q' }, t('cascade.rule4.label')), 
             E('span', null, t('cascade.rule4.desc'))),
          E('li', null,
            E('span', { className: 'dsh-mr-q' }, t('cascade.rule5.label')), 
            t('cascade.rule5.desc')))),
      E('div', { className: 'dsh-mr-hint' },
        t('cascade.hintExact')),
      E('div', { className: 'dsh-mr-hint' },
        t('cascade.hintFallback'))),

    E(Card, {
      title: t('delegation.title'),
      subtitle: t('delegation.subtitle'),
    },
      E(Toggle, {
        id: 'mr-child-delegation',
        checked: at(config, ['childDelegation'], false) === true,
        disabled: !writable,
        onChange: value => edit(current => ({ ...current, childDelegation: value })),
      }, t('delegation.allowRedistribution')),
      E('div', { className: 'dsh-mr-hint' },
        t('delegation.redistributeHint')),
      E('div', { className: 'dsh-mr-hint' },
        t('delegation.sustainableHint'))),

    E(Card, {
      title: t('masterSwitch.title'),
      subtitle: t('masterSwitch.subtitle'),
    },
      E(Toggle, {
        id: 'mr-enabled',
        label: t('masterSwitch.enableLabel'),
        checked: config.enabled,
        disabled: !writable,
        hint: t('masterSwitch.enableHint'),
        onChange: value => edit(current => ({ ...current, enabled: value })),
      }),
      E('div', { className: 'dsh-mr-row' },
        E('label', { className: 'dsh-mr-key' }, t('masterSwitch.defaultTaskLabel')), 
        E('select', {
          className: 'dsh-mr-grow',
          value: defaultTaskId,
          disabled: !writable,
          onChange: event => edit(current => ({ ...current, defaultTaskId: event.target.value })),
        },
          E('option', { value: '' }, t('masterSwitch.noDefaultOption')), 
          ...taskIds.map(taskId => E('option', { key: taskId, value: taskId }, taskId)))),
      E('div', { className: 'dsh-mr-hint' },
        defaultTaskId === ''
          ? t('masterSwitch.noDefaultMsg')
          : t('masterSwitch.defaultUsage').replace('{taskId}', defaultTaskId))),

    E(Card, {
      title: t('classifier.title'),
      subtitle: t('classifier.subtitle'),
    },
      E(Toggle, {
        id: 'mr-classifier',
        label: t('classifier.enableLabel'),
        checked: at(config, ['classifier', 'enabled'], false) === true,
        disabled: !writable,
        onChange: value => edit(current => ({ ...current, classifier: classifierPatch(current.classifier, { enabled: value }) })),
      }),
      E('div', { className: 'dsh-mr-row' },
        E('label', { className: 'dsh-mr-key' }, t('classifier.modelLabel')), 
        E('select', {
          className: 'dsh-mr-grow',
          value: classifierValue,
          disabled: !writable,
          onChange: event => {
            if (event.target.value === '') return
            const route = parseRouteKey(event.target.value)
            edit(current => ({ ...current, classifier: classifierPatch(current.classifier, { provider: route.provider, model: route.model }) }))
          },
        },
          E('option', { value: '' }, t('modelPicker.emptyLabel')), 
          ...modelOptions(groups))),
      E('div', { className: 'dsh-mr-grid2' },
        E(Field, { label: t('classifier.inputLimitLabel') },
          E('input', {
            type: 'number', min: 500, step: 500,
            value: String(at(config, ['classifier', 'maxInputTokens'], 4000)),
            disabled: !writable,
            onChange: event => edit(current => ({ ...current, classifier: classifierPatch(current.classifier, {
              maxInputTokens: Math.max(500, Number(event.target.value) || 4000),
            }) })),
          })),
        E(Field, { label: t('classifier.timeoutLabel') },
          E('input', {
            type: 'number', min: 1000, step: 1000,
            value: String(at(config, ['classifier', 'timeoutMs'], 15000)),
            disabled: !writable,
            onChange: event => edit(current => ({ ...current, classifier: classifierPatch(current.classifier, {
              timeoutMs: Number(event.target.value) || 15000,
            }) })),
          }))),
      E('div', { className: 'dsh-mr-hint' },
        t('classifier.hint'))),

    E(Card, {
      title: t('taskPool.title'),
      subtitle: t('taskPool.subtitle'),
    },
      tasks.length === 0
        ? E('div', { className: 'dsh-mr-empty' }, t('taskPool.noTasks'))
        : tasks.map((task, index) => {
          const pool = Array.isArray(task.pool) ? task.pool : []
          const total = pool.reduce((sum, entry) => sum + (Number(entry.weight) || 1), 0)
          const isDefault = defaultTaskId !== '' && task.id === defaultTaskId
          return E('div', { className: 'dsh-mr-task', key: `${task.id}-${index}` },
            E('div', { className: 'dsh-mr-task-head' },
              E('input', {
                type: 'text', value: task.id ?? '', disabled: !writable,
                title: t('task.idPlaceholder'),
                onChange: event => updateTask(index, {
                  id: event.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                }),
              }),
              isDefault ? E('span', { className: 'dsh-mr-badge ok' }, t('task.badgeDefault')) : null,
              task.enabled === false ? E('span', { className: 'dsh-mr-badge warn' }, t('task.badgeDisabled')) : null,
              E('span', { style: { flex: '1 1 auto' } }),
              E('button', {
                type: 'button', disabled: !writable,
                onClick: () => edit(current => ({ ...current, defaultTaskId: isDefault ? '' : task.id })),
              }, isDefault ? t('task.cancelDefault') : t('task.makeDefault')),
              E('button', {
                type: 'button', className: 'dsh-mr-danger', disabled: !writable,
                onClick: () => setTasks(tasks.filter((_, at2) => at2 !== index)),
              }, t('task.delete'))),

            E('div', { className: 'dsh-mr-grid2' },
              E(Field, { label: t('task.nameLabel') },
                E('input', {
                  type: 'text', value: task.name ?? '', disabled: !writable,
                  placeholder: t('task.namePlaceholder'),
                  onChange: event => updateTask(index, { name: event.target.value }),
                })),
              E(Field, { label: t('task.keywordsLabel') },
                E('input', {
                  type: 'text', disabled: !writable,
                  value: Array.isArray(task.keywords) ? task.keywords.join(', ') : '',
                  placeholder: t('task.keywordsPlaceholder'),
                  onChange: event => updateTask(index, {
                    keywords: event.target.value.split(',').map(word => word.trim()).filter(word => word.length > 0),
                  }),
                }))),

            E('div', { className: 'dsh-mr-field', style: { marginTop: '12px' } },
              E('span', null, t('task.descLabel')),
              E('textarea', {
                value: task.description ?? '', disabled: !writable,
                placeholder: t('task.descPlaceholder'),
                onChange: event => updateTask(index, { description: event.target.value }),
              })),

            E('div', { className: 'dsh-mr-row', style: { marginTop: '12px' } },
              E('input', {
                type: 'checkbox', id: `mr-task-on-${index}`,
                checked: task.enabled !== false, disabled: !writable,
                onChange: event => updateTask(index, { enabled: event.target.checked }),
              }),
              E('label', { htmlFor: `mr-task-on-${index}` }, t('task.onLabel'))),

            // ── the child profile: what this task's subagents look like ──────
            E('div', { className: 'dsh-mr-pool' },
              E('div', { className: 'dsh-mr-pool-head' },
                E('strong', null, t('childProfile.title')),
                E('span', null, t('childProfile.subtitle'))),

              E('div', { className: 'dsh-mr-stack' },
              // Persona: ONE control, no mode selector. A mode selector cannot
              // represent "custom, still empty" at all — choosing it left the
              // select showing a different option and nothing else happened,
              // because the mode was DERIVED from the text. A textarea whose
              // placeholder is the template, plus a click-to-fill button, has no
              // such state: empty means inherit, and that is visible.
              E('div', { className: 'dsh-mr-field', style: { marginTop: '12px' } },
                E('span', null, t('childProfile.promptLabel')),
                E('textarea', {
                  value: task.childPersona ?? '', disabled: !writable,
                  placeholder: t('childProfile.promptPlaceholder'),
                  onChange: event => updateTask(index, { childPersona: event.target.value }),
                }),
                E('div', { className: 'dsh-mr-row', style: { marginTop: '8px' } },
                  E('button', {
                    type: 'button', disabled: !writable,
                    onClick: () => updateTask(index, { childPersona: executorPersona() }),
                  }, t('childProfile.fillTemplate')),
                  task.childPersona === executorPersona()
                    ? E('span', { className: 'dsh-mr-badge ok' }, t('childProfile.isTemplateBadge'))
                    : null,
                  at(task, ['childPersona'], '') === ''
                    ? null
                    : E('button', {
                      type: 'button', disabled: !writable,
                      onClick: () => updateTask(index, { childPersona: '' }),
                    }, t('childProfile.clearBtn')))),

              E('div', { className: 'dsh-mr-row' },
                E('label', { className: 'dsh-mr-key' }, t('childProfile.reasoningEffortLabel')),
                E('select', {
                  className: 'dsh-mr-grow',
                  disabled: !writable,
                  value: at(task, ['reasoningEffort'], ''),
                  onChange: event => updateTask(index, { reasoningEffort: event.target.value }),
                },
                  E('option', { value: '' }, t('childProfile.reasoningDefault')),
                  ...REASONING_EFFORTS.map(effort => E('option', { key: effort, value: effort }, effort)))),

              // Tools: a switch plus tags, not a dropdown. A set of independently
              // selectable values belongs on screen as chips — a select hides the
              // options behind a click, hides the current selection behind a
              // label, and adds a mode state that has to be kept consistent with
              // the data. Chips show every option AND the current choice at once.
              E('div', { className: 'dsh-mr-row' },
                E('input', {
                  type: 'checkbox', id: `mr-child-tools-${index}`,
                  checked: at(task, ['childTools'], null) !== null,
                  disabled: !writable || toolNames.length === 0,
                  onChange: event => updateTask(index, {
                    childTools: event.target.checked ? { allow: defaultChildTools(toolNames) } : null,
                  }),
                }),
                E('label', { htmlFor: `mr-child-tools-${index}` }, t('childProfile.toolFilterLabel')),
                toolNames.length === 0
                  ? E('span', { className: 'dsh-mr-badge warn' }, t('childProfile.toolFilterWarn'))
                  : E('span', { className: 'dsh-mr-hint' }, t('childProfile.toolFilterHint'))),

              at(task, ['childTools'], null) === null || toolNames.length === 0
                ? null
                : E('div', { className: 'dsh-mr-tools' },
                  toolNames.map(name => {
                    const allowed = at(task, ['childTools', 'allow'], [])
                    const on = Array.isArray(allowed) && allowed.includes(name)
                    return E('label', { key: name, className: on ? 'dsh-mr-tool on' : 'dsh-mr-tool' },
                      E('input', {
                        type: 'checkbox', checked: on, disabled: !writable,
                        onChange: event => {
                          const base = Array.isArray(allowed) ? allowed : []
                          const next = event.target.checked
                            ? [...base, name]
                            : base.filter(entry => entry !== name)
                          // An empty allow list would mean "no tools at all", which
                          // is never what ticking the last box off means. Off is
                          // off: the switch above turns itself off instead.
                          updateTask(index, { childTools: next.length === 0 ? null : { allow: next } })
                        },
                      }),
                      E('code', null, name))
                  })),

              E('div', { className: 'dsh-mr-hint' },
                t('childProfile.hint')))),

            E('div', { className: 'dsh-mr-pool' },
              E('div', { className: 'dsh-mr-pool-head' },
                E('strong', null, t('pool.title')),
                E('span', null, t('pool.modelCount').replace('{count}', String(pool.length)).replace('{total}', String(total))),
                pool.length === 0 ? E('span', { className: 'dsh-mr-badge warn' }, t('pool.emptyBadge')) : null,
                pool.length > 1
                  ? E('span', { className: 'dsh-mr-hint' },
                    pool.map(entry => `${entry.model || '?'} ${Math.round(((Number(entry.weight) || 1) / total) * 100)}%`)
                      .join(' · '))
                  : null),
              pool.map((candidate, slot) => E(ModelRow, {
                key: `${slot}-${candidate.provider}-${candidate.model}`,
                groups, knownRoutes, candidate, index: slot, disabled: !writable,
                onChange: next => setPool(index, pool.map((entry, at2) => (at2 === slot ? next : entry))),
                onRemove: slotIndex => setPool(index, pool.filter((_, at2) => at2 !== slotIndex)),
              })),
              E('div', { className: 'dsh-mr-row', style: { marginTop: '12px' } },
                E('button', { type: 'button', disabled: !writable, onClick: () => addModel(index) }, t('pool.addModel')),
                E('span', { className: 'dsh-mr-hint' },
                  t('pool.weightHint')))))
        }),
      E('div', { className: 'dsh-mr-row', style: { marginTop: '16px' } },
        E('button', { type: 'button', disabled: !writable, onClick: addTask }, t('newTaskButton')))),

    E(Card, {
      title: t('authPreset.title'),
      subtitle: t('authPreset.subtitle'),
    },
      presetIds.length === 0
        ? E('div', { className: 'dsh-mr-empty' },
          rosterError === ''
            ? t('authPreset.emptyRoster')
            : t('authPreset.rosterError').replace('{error}', rosterError))
        : presetIds.map(presetId => {
          const on = grants[presetId] !== undefined
          return E('div', { className: 'dsh-mr-preset', key: presetId },
            E('input', {
              type: 'checkbox', id: `mr-preset-${presetId}`, checked: on, disabled: !writable,
              onChange: event => {
                const next = { ...grants }
                if (event.target.checked) next[presetId] = { enabled: true }
                else delete next[presetId]
                edit(current => ({ ...current, presets: next }))
              },
            }),
            E('label', { htmlFor: `mr-preset-${presetId}`, style: { minWidth: 0 } },
              E('code', null, presetId),
              grants[presetId]?.exclusive === true
                ? E('span', { className: 'dsh-mr-badge', style: { marginLeft: '8px' } },
                  t('presets.exclusiveLabel').replace('{tasks}', (grants[presetId].tasks ?? []).join(', ') || t('authPreset.exclusiveNone')))
                : null),
            on ? E('button', {
              type: 'button', disabled: !writable,
              onClick: () => {
                const next = { ...grants }
                next[presetId] = grants[presetId]?.exclusive === true
                  ? { enabled: true }
                  : { enabled: true, exclusive: true, tasks: taskIds }
                edit(current => ({ ...current, presets: next }))
              },
            }, grants[presetId]?.exclusive === true ? t('authPreset.toggleAll') : t('authPreset.exclusiveSelect')) : null)
        })),

    E(Card, {
      title: t('preview.title'),
      subtitle: t('preview.subtitle'),
    },
      E('div', { className: 'dsh-mr-row' },
        E('select', {
          value: previewPreset,
          onChange: event => setPreviewPreset(event.target.value),
        },
          E('option', { value: '' }, t('preview.noGrantOption')),
          ...presetIds.map(presetId => E('option', { key: presetId, value: presetId }, presetId))),
        E('input', {
          type: 'text', className: 'dsh-mr-grow', value: previewText,
          placeholder: t('preview.placeholder'),
          onChange: event => setPreviewText(event.target.value),
        })),
      previewText === '' ? null : E('div', { className: 'dsh-mr-hint', style: { marginTop: '10px' } },
        describePreview(config, previewText, previewPreset))),

    E(Card, {
      title: t('catalog.title'),
      subtitle: t('catalog.subtitle'),
    },
      E('div', { className: 'dsh-mr-hint' },
        catalog === null ? t('catalog.loading')
          : t('catalog.modelCount').replace('{count}', String(catalog.routes.length)).replace('{providers}', String(new Set(catalog.routes.map(route => route.provider)).size))),
      E('div', { className: 'dsh-mr-row', style: { marginTop: '12px' } },
        E('button', { type: 'button', onClick: () => void loadCatalog() }, t('catalog.refreshBtn'))),
      catalog === null || catalog.routes.length === 0
        ? null
        : E('details', { className: 'dsh-mr-diag' },
          E('summary', null, t('catalog.showAll')),
          E('pre', null, catalog.routes
            .map(route => `${route.provider} / ${route.model}${route.name === route.model ? '' : `  (${route.name})`}`)
            .join('\n')))),

    notice === '' ? null : E('div', { className: 'dsh-mr-hint' }, notice),
  )
}
// ─────────────────────────────────────────────────────────────────────────────
// Plugin face
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Client services this half needs. Declared so the module system and Cordis wait
 * for them: `remote` carries the Typert gateway namespaces this page reads
 * (`remote.session`, `remote.agentPresets`).
 *
 * `settingsScope` is deliberately absent: the configuration lives in its own
 * folder rather than in a settings namespace, so the page's source is the Host's
 * configuration endpoint — see `createConfigMirror`.
 */
export const inject = ['slots', 'locale', 'remote', 'remote.session']

/**
 * Names the page exposes for testing.
 *
 * The settings page is a closed component tree registered into a slot, so the
 * only way to assert on its decisions is to reach the pure helpers directly.
 * `routeProblem` in particular makes a broken pool entry VISIBLE, and a
 * regression there is invisible in rendered HTML (the `<select>` has no
 * matching option either way) — so it needs a direct test.
 */
export const __testing = {
  routeProblem, describePreview, asConfig, isRouteId, catalogFromModelCatalog, fetchRoutes,
  fetchPresets, fetchHealth, healthView, classifierPatch, modelOptionLabel, modelOptions,
  sectionBoundary, optionalFace, canonical, sameConfig, diffFields, diffOps,
  EDITABLE_PATHS, executorPersona, EXECUTOR_PERSONA: executorPersona(),
  DEFAULT_CHILD_TOOLS, normalizeTask, defaultChildTools,
  createConfigMirror, NAMESPACE,
}

export function apply(ctx) {
  ctx.effect(() => stylesApi.insert(STYLES), 'dsh-model-router: settings styles')
  // The copy follows the harness language. Registering the dictionary on this fiber
  // makes it disappear with the plugin; the bridge then resolves every string
  // through the harness's own translate function, so switching language in the
  // settings page changes this page on the next render.
  ctx.effect(() => ctx.locale.register(NS, COPY), 'dsh-model-router: copy dictionaries')
  if (typeof ctx.locale.bind === 'function') localeBridge.t = ctx.locale.bind(NS)
  if (typeof ctx.locale.subscribe === 'function') {
    localeBridge.subscribe = listener => ctx.locale.subscribe(listener)
    localeBridge.revision = ctx.locale.getSnapshot?.().revision ?? 0
  }

  // The configuration mirror
  //
  // Resolved through `ctx.get` so a test — or a future in-process provider — can
  // supply one with the same surface, and created here rather than inside
  // `inject()` so its polling lifetime belongs to this fiber.
  const scope = optionalFace(ctx, 'modelRoutingConfig')
    ?? createConfigMirror(typeof fetch === 'function' ? fetch : undefined)
  ctx.effect(() => scope.start?.() ?? (() => {}), 'dsh-model-router: configuration polling')

  // `ctx.slots` — the injected accessor, exactly as the shipped client plugins
  // use it. `ctx.get('slots')` returns undefined here, which is why this row
  // once mounted and then contributed nothing.
  ctx.slots.inject(SECTION.name, () => ctx.slots.register({
    ...SECTION,
    // Without `label` the nav row renders no text at all.
    label: () => t('nav.label'),
    // Resolving the faces must NEVER throw. `inject()` runs while the section is
    // being registered, so a throwing getter here costs the WHOLE panel — the
    // blank-page failure this page has now suffered twice, with nothing on
    // screen to say which plugin caused it. A failure becomes a `fault` string
    // and the page renders it instead.
    inject: () => {
      try {
        return {
          scope,
          // The Host's model catalog — the same face the composer's picker reads.
          // Resolved through `ctx.get` first: the dotted namespace service is the
          // supported accessor, and the property read is only a fallback.
          session: optionalFace(ctx, 'remote.session') ?? ctx.remote?.session,
          // The preset roster. A REMOTE face: the Host service of the same name
          // is invisible to a bundled Client plugin.
          presets: optionalFace(ctx, 'remote.agentPresets') ?? ctx.remote?.agentPresets,
        }
      } catch (failure) {
        console.error('dsh-model-router: could not resolve the settings faces')
        console.error(failure)
        return { fault: failure instanceof Error ? failure.message : String(failure) }
      }
    },
  }, props => E(sectionBoundary(), null, E(TaskRoutingSection, props))))
}

export default { apply, inject }
