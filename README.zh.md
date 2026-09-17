# dsh-model-router

[English](README.md) · **简体中文**

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**按任务分配模型**的路由插件：
被委派出去的子智能体跑在**适合它那件事**的模型上，而你正在对话的这个会话，用的始终是你选的那个模型。

## 它解决什么问题

一个会话只有一个模型，但一次对话里常常同时有**性质完全不同的工作**：三维建模、联网核实、几段话的合并。
用同一个模型做完所有事，要么贵、要么慢、要么不对路。

这个插件只做一件事：**主智能体把一件事派给子智能体时，按那件事的类型挑模型**。它不碰主对话——这是硬约束：

| 会话 | 本插件做什么 |
| --- | --- |
| 你正在对话的主会话 | **完全不动**：模型、工具表、上下文都不改 |
| 被派出去的子智能体 | 按任务从模型池里挑一个（全局按权重轮转，不按会话分片） |
| 子智能体再往下派 | 由 `childDelegation` 决定：关闭（默认）时任何再派都被服务层深度守卫拒绝 |

## 特性

- **零预设改动**：插件在**运行时**把自己的 `subagent` / `subagent_message` 注册进被授权预设的
  agent 作用域，并屏蔽同作用域里的内置委派工具。撤销授权 = 销毁 fiber，预设回到原样，
  **没有任何预设文件被改写过**。
- **同一个子智能体负责到底**：交付后它仍存活，用 `subagent_message` 把修改意见发回**同一个**子
  智能体，而不是另开一个——任务归属始终清晰。
- **配置是文件**：`$DSH_HOME/model-routing/` 下 `global.yml` + 每个任务一个文件。手工改、脚本改、
  设置页改都是同一批文件，约 1 秒内生效。
- **判定确定性优先**：显式 `[task: id]` → 关键词 → 语义分类器 → 默认任务 → 保持继承。前两级命中
  时**一次模型调用都不花**；分类结果在**整轮内固定**，失败重试只换池内候选、不重问分类器。
- **失败分级降级**：池内换下一个候选 → 配额类失败跳过整个 provider → 整池耗尽则用默认任务 →
  都不行就**不再改写路由**，把这一轮交回调用方。重试有硬预算，任何意外失败都不可能无限重试。
- **坏掉能被看见**：设置页运行状态卡片显示配置来源、能力探测、最近错误、是否已自动停用。只有
  **请求路径**上的失败才计入熔断（连续 5 次自动摘除，60 秒后重试）；装不上护栏、查询失败这类
  **降级**照样显示，但不会把路由停掉。
- **界面双语**：设置页文案跟随 DSH 的语言（中文 / English），与内置插件一致。

## 安装

```bash
git clone https://github.com/IQzhan/deepseek-harness-model-router.git
cd deepseek-harness-model-router
node build-router.mjs
```

`build-router.mjs` 做三件事：构建 `package/`、link 进 profile 的 `node_modules`、把随插件的
**skill** link 进 `$DSH_HOME/skills/`。缺东西时它**按顺序退化并说明**，不会中断：

| 缺什么 | 行为 | 影响 |
| --- | --- | --- |
| `@deepseek-ai/schemastery` / `cosmokit`（新机器上还没有） | 跳过内联 | settings 命名空间**兜底**不可用并记为降级；配置文件这条路不受影响 |
| `yaml` | 跳过 link | 运行时需要它解析配置：在该包目录 `npm i`，或用 `dsh plugin add`（会装依赖） |
| profile 里没有 `cordis.patch.yml` | 跳过 profile link | 自己加下面那行 |

在 `$DSH_HOME/profiles/web/cordis.patch.yml` 加一行后**重启 `dsh web`**：

```yaml
- insert:
    - id: dsh-model-router
      name: dsh-model-router
```

等价的一条命令：`dsh plugin --profile web add ./package`。重启后打开 **设置 → 任务路由**，
勾选至少一个预设授权、打开总开关即生效。**插件默认完全关闭**，装上不改变任何现有行为。

## 更新 / 卸载

```bash
git pull && node build-router.mjs      # 更新；重启 dsh web 生效（Host 半边需要重启）
```

卸载：删掉 profile patch 里那一行（或 `dsh plugin --profile web remove dsh-model-router`），
删掉 `$DSH_HOME/profiles/web/node_modules/dsh-model-router` 这个链接；配置想留就留
（`$DSH_HOME/model-routing/`）。**卸载不会恢复任何预设**，因为安装时也没有改过预设。

## 配置

```
$DSH_HOME/model-routing/
  global.yml            开关、默认任务、子智能体能否再分发、分类器、预设授权
  tasks/<任务id>.yml     一个任务：显示名、描述、关键词、模型池、子智能体档案与工具限定
```

字段全表在 [`skills/model-routing/SKILL.md`](skills/model-routing/SKILL.md)：`enabled`、`defaultTaskId`、
`childDelegation`、`classifier` 的 `enabled`/`provider`/`model`/`maxInputTokens`/`timeoutMs`、`presets`
授权，以及每个任务的 `name`/`description`/`enabled`/`keywords`/`pool`（含 `weight`）/
`reasoningEffort`/`childPersona`/`childTools`。它同时是给智能体看的配置手册；设计取舍与踩过的坑在
[`docs/design-notes.md`](docs/design-notes.md)；逐项验证账本在
[`docs/verification.md`](docs/verification.md)。

**让智能体替你改配置**：输入 `/model-routing` 调用随插件安装的 skill。它只在你主动调用时加载，
不进模型目录（`disable-model-invocation: true`），因此不占日常上下文。

## 工作原理（一句话）

DSH 在装配请求时会走 `agent/request` 瀑布流，插件在那里**改写这一轮要用的 provider/model**——
位置在 `llm.prepareCall()` 之前、`request/header` 记录之前。只改写子会话，主会话原样放过。

## 目录结构

| 文件 | 作用 |
| --- | --- |
| `model-routing-config.js` | 纯策略核心：校验、判定阶梯、调度器（可与 Cordis 无关地测试） |
| `model-routing-store.js` | 配置文件读写：原子写入、逐文件容错、从 `settings.yaml` 迁移 |
| `dsh-model-router.host.js` | Cordis 适配层：路由接缝、委派工具、深度守卫、健康接口 |
| `dsh-model-router.client.js` | 设置页（注册进 `settings.section`，文案中英双语） |
| `skills/model-routing/SKILL.md` | 只能 `/` 调用的配置 skill |
| `docs/design-notes.md` | 设计说明：为什么这么做、踩过的坑、实测证据 |
| `docs/verification.md` | 逐项功能 × 测试证据账本（含哪些只在离线验证、为什么） |
| `build-router.mjs` | 构建 + 安装（包、yaml 依赖、skill） |
| `verify.ps1` / `verify.mjs` | 重建 + 跑全部离线套件（PowerShell / 任意平台） |
| `verify-live.ps1` | 验收**正在运行的**部署：读健康面并逐条判 PASS/FAIL（只读、不花 token） |
| `session-peek.mjs` | 读一份会话日志（zstd 拼接帧），证明"这一轮到底跑在哪个模型上" |

## 测试

```bash
node verify.mjs          # 或 pwsh -File verify.ps1：重建 + 跑全部离线套件
```

**测试绝不改写真实配置**：接线套件只**读**部署目录，所有写入用例跑在同一份目录的**临时副本**上，
最后一条断言是"跑完这一套，线上 revision 没有动过"。临时目录在仓库内 `.tmp/`（不写系统临时目录、
不碰 C 盘），跑完即清。

套件：策略核心 · 配置文件（真实文件系统）· 适配层（路由接缝/委派工具/健康面）· 接线（构建产物读
真实配置目录）· 包（两个真实加载器 + skill 契约）· 设置页（真实 React 渲染）· **文档双语同步** ·
**可移植性守卫**（无绝对路径、无平台专有构造）· 本机真实配置。

## 已知边界

- **子会话仍看得见一个委派工具**：子会话跑的是父预设的副本，那份副本把内置委派工具装进子会话
  **自己的作用域**，外部屏蔽不掉（`restrict` 报未知工具，命名它会让整个过滤器失效）。所以保证的
  形式是"**能用但一定被拒**"：任何再派尝试都被服务层深度守卫拒绝（错误文案明确）。
- **子会话没有独立预设**：DSH 的委派路径没有"子会话用哪个预设"这个参数。用任务级 `childPersona`
  与 `childTools` 达到专用化的效果，而不要求你为每个任务建预设。
- **分类器是 LLM**：边界提示的判定可能两次不同；插件保证的是**整轮内不再重问**，不会中途换任务。
- **模型可用性取决于你的账号**：某个任务的池全部不可用（配额/余额）时，这一轮会级联到默认任务；
  默认任务也不可用才交回调用方。

## 许可

[MIT](LICENSE)
