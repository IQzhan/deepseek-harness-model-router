# dsh-model-router

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供**按任务分配模型**的路由插件：
被委派出去的子智能体跑在**适合它那件事**的模型上，而你正在对话的这个会话，用的始终是你在输入框旁选的那个模型。

> **English at a glance** — Task-aware model routing for DeepSeek Harness. Delegated subagents run
> on the model that fits *their* task; the session you are talking to keeps the model you picked.
> It supplies its own `subagent` / `subagent_message` tools at runtime, so **no agent preset is ever
> edited**, and the configuration lives in files beside `settings.yaml` (one file per task).
> Install: `git clone` → `node build-router.mjs` → add one row to the profile patch → restart.

---

## 它解决什么问题

一个会话里只有一个模型，但一次对话里往往同时存在**性质完全不同的工作**：有人要三维建模，
有人要联网核实，有人只是把几段话合并。用同一个模型做完所有事，要么贵、要么慢、要么不对路。

这个插件只做一件事：**当主智能体把一件事派给子智能体时，按那件事的类型挑模型**。
它不碰主对话——这一点是硬约束，不是默认值：

| 会话 | 本插件做什么 |
| --- | --- |
| 你正在对话的主会话 | **完全不动**。模型、工具表、上下文都不改 |
| 被派出去的子智能体 | 按任务从模型池里挑一个模型（全局按权重轮转） |
| 子智能体再往下派的会话 | 默认**不可能**：子智能体拿不到委派工具 |

## 特性

- **零预设改动**：插件在**运行时**把自己的 `subagent` / `subagent_message` 工具注册进被授权预设的
  agent 作用域，并把同作用域里的内置委派工具屏蔽掉。撤销授权 = 销毁注册，预设回到原样，
  **没有任何预设文件被改写过**。
- **同一个子智能体负责到底**：交付后它仍然存活，主智能体用 `subagent_message` 把修改意见或下一步
  发回**同一个**子智能体，而不是另开一个——任务归属始终清晰。
- **配置是文件**：`$DSH_HOME/model-routing/` 下 `global.yml` + 每个任务一个文件。手工改、脚本改、
  设置页改都是同一批文件，约 1 秒内生效。
- **判定确定性优先**：显式 `[task: id]` → 关键词 → 语义分类器 → 默认任务 → 保持继承。前两级
  命中时**一次模型调用都不花**。
- **失败三级降级**：池内换下一个模型 → 整个池失败则用默认任务 → 都不行就**不再改写路由**，
  把这一轮交回调用方自己继续。
- **坏掉能被看见**：设置页有运行状态卡片（配置来源、能力探测、最近错误、是否已自动停用）；
  连续失败 5 次会**自动把自己从请求路径里摘出去**。支持一键停用，以及不改任何预设的紧急停用。

## 安装

```bash
git clone https://github.com/IQzhan/deepseek-harness-model-router.git
cd deepseek-harness-model-router
node build-router.mjs
```

`build-router.mjs` 会做三件事：构建 `package/`、把它 link 进 profile 的 `node_modules`、
把随插件附带的 **skill** link 进 `$DSH_HOME/skills/`。

然后在 `$DSH_HOME/profiles/web/cordis.patch.yml` 里加上这一行，并**重启 `dsh web`**：

```yaml
- insert:
    - id: dsh-model-router
      name: dsh-model-router
```

不想手改文件的话，等价的一条命令：

```bash
dsh plugin --profile web add ./package
```

重启后打开 **设置 → 任务路由**：勾选至少一个预设授权，打开总开关，就生效了。
（插件默认**完全关闭**，装上不会改变任何现有行为。）

## 更新

```bash
git pull
node build-router.mjs     # 重建 + 重新 link 包与 skill
```

重启 `dsh web` 即可。客户端界面随页面刷新更新，Host 半边需要重启。

**重启后想知道"到底生效了没有"**，跑这一条（只读、不花 token）：

```powershell
pwsh -File verify-live.ps1          # 默认 http://127.0.0.1:3080，-Port 换端口，-Json 看原始健康面
```

它会逐条判 PASS/FAIL：Host 是否在线、路由是否启用、委派服务是否可见、
**每个已授权会话是否真的被接管并启动了**、登记数与启动数是否相等、最近有无报错。
离线套件证明"代码是对的"，这条命令证明"这台机器上真的在跑"——两者不是一回事。

**想知道某一轮"实际跑在哪个模型上"**，读那份会话日志（插件自己的报告不算证据，日志算）：

```bash
node session-peek.mjs <会话 id> --routes     # 继承了哪条路由、开场指令、真正发出的请求头、结束原因
node session-peek.mjs <会话 id> --types      # 这份日志里有哪些记录类型（新 schema 靠它发现，不靠猜）
```

## 卸载

1. 从 `cordis.patch.yml` 删掉上面那一行（或 `dsh plugin --profile web remove dsh-model-router`）；
2. 删掉 `$DSH_HOME/profiles/web/node_modules/dsh-model-router` 这个链接；
3. 想连配置一起清掉就删 `$DSH_HOME/model-routing/`；想留着，下次装回来还在。

**卸载不会恢复任何预设**，因为安装时也没有改过任何预设。

## 配置

```
$DSH_HOME/model-routing/
  global.yml            开关、默认任务、子智能体能否再分发、分类器、预设授权
  tasks/<任务id>.yml     一个任务：显示名、描述、关键词、模型池、以及它的子智能体档案
```

**权威字段表在 [`skills/model-routing/SKILL.md`](skills/model-routing/SKILL.md)**（它同时是给智能体看的
配置手册）；设计取舍与实现细节在 [`docs/design-notes.md`](docs/design-notes.md)。

要点：

- `description` 是**分类器唯一读到的内容**，写清"这个任务是做什么的"。
- `pool` 是 `{ provider, model, weight }` 列表，权重是相对比例，**全局**轮转（不区分会话），
  一轮内钉住同一个模型。
- `presets` 决定**哪些 agent 预设允许使用本插件**；没列出的预设完全不受影响。
- 每个任务可选：`reasoningEffort`、`childPersona`（整体替换子智能体的系统提示）、
  `childTools`（限定子智能体可用工具）。

### 让智能体替你改配置

插件带一个**只能主动调用**的 skill：在对话框里输入 `/model-routing`。
它刻意设为 `disable-model-invocation: true`——**不会**出现在模型的技能目录里，不会自己冒出来，
只有你显式叫它时才加载，确保与模型的日常决策解耦。

## 工作原理

```
        你的会话（模型你选，插件不碰）
                 │
                 │ 主智能体判断这件事该派出去
                 ▼
        subagent 工具（本插件提供）
                 │  显式 task，或由分类器判断
                 ▼
        子智能体 ← 从该任务的模型池里取一个模型（全局加权轮转）
                 │  交付
                 ▼
        主智能体验收 ── subagent_message ──► 同一个子智能体继续改
```

判定顺序（命中即停）：

1. 消息里有 `[task: 任务id]` → 直接用
2. 任务的 `keywords` 出现在最近对话文本里 → 用它
3. 前两条都没命中 **且** 分类器已启用 → 问一次分类器（每轮最多一次，结果缓存）
4. 分类器没给候选内的答案 / 未启用 / 失败 → `defaultTaskId`
5. 没有可用默认任务 → 保持子智能体继承的模型

## 目录结构

| 路径 | 内容 |
| --- | --- |
| `model-routing-config.js` | 策略核心：校验、判定阶梯、加权轮转、分类器读写。纯逻辑，无 Cordis、无 IO |
| `model-routing-store.js` | 配置文件：读取、原子写入、按文件报错、从 settings.yaml 一次性迁移 |
| `dsh-model-router.host.js` | Cordis 适配层：路由接缝、委派工具、健康接口、配置读写接口 |
| `dsh-model-router.client.js` | 设置页（注册进 `settings.section` 的客户端 bundle） |
| `skills/model-routing/SKILL.md` | 只能 `/` 调用的配置 skill |
| `docs/design-notes.md` | 设计说明：为什么这么做、踩过的坑、验证方式 |
| `build-router.mjs` | 构建 + 安装（包、yaml 依赖、skill） |
| `verify.ps1` | 重建 + 跑全部离线套件 |
| `verify-live.ps1` | 验收**正在运行的**部署：读健康面并逐条判 PASS/FAIL（只读、不花 token） |
| `session-peek.mjs` | 读一份会话日志（zstd 拼接帧），用它验证"这一轮到底跑在哪个模型上" |

## 测试

```bash
node test-model-routing-config.mjs   # 策略核心
node test-store.mjs                  # 配置文件（真实文件系统）
node test-router-host.mjs            # 适配层（跑真实构建产物）
node test-store-wiring.mjs           # 构建产物读真实配置目录（只读）+ 在临时副本上验证手改与 revision 栅栏
node test-package.mjs                # 两个真实加载器 + skill 契约
node test-render.mjs                 # 设置页（真实 React 渲染）
node test-deployed-config.mjs        # 本机真实配置
node test-live-nondeepseek.mjs       # 真实联网调用（不可达的 host 自动跳过）
```

合计 7 个套件、533 条断言。测试里刻意包含**敌意环境**（remote 访问抛错、配置目录有坏文件、
工具名不存在、revision 冲突、React 不完整、**插件的启动被延迟甚至失败**、**模型不支持被声明的
推理强度**），这些用例抓到过多个真 bug，包括"工具清单被逐字符拆开"、"内联模块在加载期解构未定义
的 fs 导致整个插件挂载失败"，以及"接管其实在工作、健康面却报 `installed: 0`"（根因：Cordis 异步
启动插件，拿"启动跑没跑"当登记条件就会丢掉一个活的安装；见 `docs/design-notes.md` 5.2.2(d)）。

**测试绝不改写真实配置**：接线套件只**读**部署目录，所有会写入的用例（手改文件、revision 栅栏）
都跑在同一份目录的**临时副本**上，最后一条断言就是"跑完这一套，线上 revision 没有动过"。

## 已知边界

- **子会话不继承父会话之外的预设选择**：DSH 的委派路径里没有"子会话用哪个预设"这个参数，子会话跑的
  是父会话的预设。本插件用**任务级 `childPersona`**（整体替换系统提示）与 `childTools`（限定工具）
  达到"专用精炼"的效果，而不要求你为每个任务建预设。
- **主智能体愿不愿意派活**受提示词影响，不是 100% 保证。本插件把委派规则写进**工具描述**里
  （这是唯一能穿过 `complete: true` 人格抑制的通道），但它是强偏置而不是强制。
- **语义分类器是普通嵌套调用**：不在会话里、不占上下文、每轮最多一次；失败只会退化成默认任务。
- 仓库当前为 **private**，测试完成后再公开。

## 许可

尚未指定许可证。公开分发前请先选定一个（例如 MIT / Apache-2.0），并在此处与 `LICENSE` 文件里写明。
