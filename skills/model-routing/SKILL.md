---
name: model-routing
description: 任务路由插件的配置助手：增删改任务、模型池、预设授权与子智能体档案。
disable-model-invocation: true
---

# 任务路由配置助手

你正在帮用户修改**任务路由插件**的配置。配置是**文件**，不是设置页里的隐藏状态：改文件即生效，
设置页改的就是同一批文件。

## 0. 先读现状，再动手

```
$DSH_HOME/model-routing/
  global.yml           全局：开关、默认任务、分类器、预设授权
  tasks/<任务id>.yml   每个任务一份，文件名就是 id
```

`$DSH_HOME` 默认是 `~/.dsh`（Windows 上就是当前用户目录下的 `.dsh`）。
**先读 `global.yml` 和 `tasks/` 目录**，改之前必须知道现在有什么，不要凭印象增删。

配置**没有**写在 `settings.yaml` 里；那里已经没有 `model-routing:` 段，别去改它。

## 1. 文件结构与字段

### global.yml

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `enabled` | bool | 总开关。`false` 时本插件不动任何会话的模型，也不安装委派工具 |
| `defaultTaskId` | string | 未命中任何任务时用的任务 id。**留空 = 没有默认任务**，此时未命中的子会话保持它继承的模型 |
| `childDelegation` | bool | 子智能体能否**再往下派**。`false`（推荐）= 子智能体只是执行者 |
| `classifier.enabled` | bool | 语义分类器开关 |
| `classifier.provider` / `.model` | string | 分类器用的模型路由（建议钉一个便宜且稳定的具体模型） |
| `classifier.maxInputTokens` | number | 每次判定的输入上限（**token**，不是字符） |
| `classifier.timeoutMs` | number | 单次判定超时；超时/失败直接落到默认任务，不影响对话 |
| `presets` | map | **授权**哪些 agent 预设使用本插件。`{ diy-smart: { enabled: true } }`。未列出的预设完全不受影响 |

### tasks/<id>.yml

任务 id 由**文件名**决定：只允许小写字母、数字、连字符（`web-search`）。
文件体里**不要**再写 `id`，写了也会被文件名覆盖。

### 首次安装自带的五个样本

只在你**从没保存过配置**时生效（`/health` 的 `configuration.samples` 为 `true`）：五个英文任务
`general` / `web-search` / `bulk` / `drawing` / `modelling`，**池全空**（不替你选模型），每条都有
一句通用 `childPersona`。它们不落盘——页面显示、你保存时才写文件；一旦有任何文件存在，样本再也不
出现，**升级永不覆盖你写的内容**。

**`childTools` 要谨慎用。** 过滤器的失效方式是"整体作废"：只要列表里有**一个名字不在子会话的工具表
里**，provider 会拒绝**整个过滤器**，插件只能丢掉它重试（并在健康面记一条降级）。所以：

- 默认**别写** `childTools`：继承全部工具通常是对的（建模要查规格、绘图要参考、通用任务什么都要）。
- 只写**无歧义**的排除，且只用 DSH 自带、任何部署都有的工具名（`read`/`write`/`edit`/`glob`/`grep`/
  `pwsh`/`web_fetch`/`web_search`）。样本里只有两处：联网搜索不写文件/不开 shell，批量杂务不联网。
- 想给你自己的任务精确划线，就在设置页用**工具勾选**（它读的是 Host 的真实工具表），别凭记忆写名字。

| 字段 | 类型 | 作用 |
| --- | --- | --- |
| `name` | string | 显示名（给人看） |
| `description` | string | **分类器唯一读到的内容**。写清"这个任务是做什么的" |
| `enabled` | bool | 关掉即该任务不参与路由 |
| `keywords` | string[] | 命中即**直接路由**，不必等分类器（省一次调用、100% 确定） |
| `pool` | array | 模型池：`{ provider, model, weight }`。按权重**全局**轮转，不区分会话 |
| `reasoningEffort` | string? | 可选：`off`/`low`/`medium`/`high`/`max`。覆盖路由默认的推理强度；模型没有这一档时**就近向下**取（见下） |
| `childPersona` | string? | 可选：本任务的子智能体读这一段系统提示词（**整体替换**继承来的那段） |
| `childTools` | object? | 可选：`{ allow: [...] }` 或 `{ deny: [...] }`，限定子智能体可用工具 |

## 2. 判定顺序（决定一次子会话请求用哪个模型）

1. 消息里有 `[task: 任务id]` → 直接用
2. 任务的 `keywords` 出现在最近对话文本里 → 用它
3. 前两条都没命中 **且** 分类器已启用 → 问一次分类器
4. 分类器没给候选内的答案 / 未启用 / 失败 → `defaultTaskId`
5. 没有可用默认任务 → 保持子会话继承的模型

池里的模型按权重全局轮转；**一轮内钉住同一个模型**。失败时：池里换下一个 → 整池失败则改用默认任务 →
默认任务也失败则**不再改写路由**，把这一轮交回调用方自己继续。

**推理强度怎么落地**：任务写了 `reasoningEffort` 而池里模型没有那一档时，插件会**就近向下**取
（`max → high → medium → low → off`），而不是丢掉你的设置、也不是让请求失败；模型完全不支持推理时
才不发这个字段。所以：给便宜池写 `low` 是有效的省钱手段，写 `max` 也不会把会话打死（会被降到最近的
可用档）。

## 3. 怎么改

- **加任务**：新建 `tasks/<新id>.yml`，至少写 `name`、`description`、`pool`。id 必须能当文件名。
- **删任务**：删掉那个文件。若它是 `defaultTaskId`，同时把 `defaultTaskId` 清空。
- **改池子**：只改那个任务的 `pool`；权重是相对比例（`2:1` = 前者承担 2/3）。
- **授权预设**：在 `global.yml` 的 `presets` 下加/删预设 id（用 `{ enabled: true }`）。
- 改完保存即可，**约 1 秒内生效**，不需要重启。

## 4. 必须遵守的规则

- **一次只改一类东西**：改池子就别顺手改授权。改完告诉用户你动了哪些文件、哪些字段。
- **不要留下非法状态**：`defaultTaskId` 必须指向一个启用且池非空的任务，否则等于没有默认任务；
  任务 id 不得重复；`childTools` 不能是空对象（`{}` 会被拒绝），也不能 `allow: []`（那意味着不给任何工具）。
- **不要动监听端口、插件行、`settings.yaml` 里其它段**。你要改的只有 `model-routing/` 目录。
- **改之前备份**（把原文件内容读出来放在回复里，或者写成 `<文件>.bak`），用户可能想回退。
- **改完自查**：重新读一遍改过的文件，确认 YAML 合法（缩进、引号），并说明下一次路由会怎么走。

## 5. 常见请求的落点

| 用户说 | 你要改 |
| --- | --- |
| "建模任务用 X 和 Y，X 多一点" | `tasks/modelling.yml` 的 `pool`（权重比） |
| "联网搜索别用 A 了" | `tasks/web-search.yml` 的 `pool` 删掉那条 |
| "以后没命中就用 Z" | `global.yml` 的 `defaultTaskId: Z` |
| "让 diy 预设也用上" | `global.yml` 的 `presets.diy: { enabled: true }` |
| "先关掉这个插件" | `global.yml` 的 `enabled: false`（比停用插件更轻，页面也能看到） |
| "子智能体别自己再派人" | `global.yml` 的 `childDelegation: false` |
| "这个任务的子智能体别联网" | 该任务 `childTools: { deny: [web_search, web_fetch] }` |
| "子智能体要更精炼" | 该任务 `childPersona` 写一段专用提示词（留空即继承） |
| "分类器太贵/太慢" | `global.yml` 的 `classifier.model` 换便宜模型，或 `timeoutMs` 调小 |

## 6. 出问题时

- 页面「任务路由 → 运行状态」会显示配置来源（`files` + 目录路径）、能力探测、最近 Host 错误、
  以及插件是否已**自动停用**。先看那里。
- **"接管是否真的生效"要看三个数**（页面摘要里是「委派工具已生效 N / 已挂载 M 个会话」，
  也可以直接读 `GET /api/dsh-model-router/health` 的 `delegation`）：
  `installed`（登记了几个 fiber）、`applied`（其中启动真的跑过的）、`service`（委派服务在不在
  插件作用域里）。**只有 `installed == applied` 且 `service: true` 才代表接管在生效**；
  `applied < installed` 或某个 agent 的 `error` 非空，就是启动失败——原因会同时进 `errors[]`
  （`where` 为 `delegation startup` 或 `child rules startup`）。
- 不想记命令就跑仓库里的 `pwsh -File verify-live.ps1`：读一次健康面，逐条判 PASS/FAIL。
- 手工编辑出错不会让插件崩：解析失败的那个文件会被报告，其余文件照常加载（该文件保留上一次的好值）。
- 想彻底停掉：`global.yml` 里 `enabled: false`，或给 profile 里 `dsh-model-router` 那一行加
  `disabled: true` 后重启。**这两种都不会动预设文件。**
- **改了 Host 半边的代码必须重启 `dsh web`**：profile 的 live reload 只重读配置（`root: []`，
  不做模块重载），所以不重启就还是在跑旧代码。
