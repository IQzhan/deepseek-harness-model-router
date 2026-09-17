# 逐项功能验证账本

这份文件回答一个问题：**每一个功能项，凭什么说它被验证过。**

写法：每一项都给出**离线断言**（可重复、不花钱、覆盖分支）与**真实验证**（真实会话 / 真实模型 /
真实部署上观察到的证据）。只有离线证据的项会明确标注并说明原因——没有"应该没问题"这种说法。

- 离线套件：`core`（策略核心）、`store`（配置文件）、`host`（适配层）、`wiring`（接线）、
  `package`（包与加载器）、`render`（设置页真实渲染）、`docs`（双语同步）、`portability`（可移植性）、
  `deployed`（本机真实配置）。一条命令跑全部：`node verify.mjs`。
- 真实验证的工具：`verify-live.ps1`（读运行中部署的健康面）与 `session-peek.mjs`
  （读会话日志，`--routes` 看这一轮**实际**跑在哪个模型上、`--tools` 看子会话实际拿到哪些工具、
  `--attempts` 看每次尝试的结局）。**证据取自会话日志与健康面，不取自插件自述。**

## A. 路由判定

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| A1 | 主会话完全不被路由 | `host`：main session never routed | 本会话每轮派发都不消耗 picks（每次 `picks` 增量都等于委派次数） | ✅ |
| A2 | 显式 `[task: id]` 确定性命中 | `host`：directive 命中即不调分类器（LLM 调用计数 0） | 子会话 opener 末尾带标记 → 实跑池内模型（`picks` 精确 +1） | ✅ |
| A3 | 关键词命中 | `host`：keyword 命中不调分类器 | 中文"搜索一下…" → web-research 池模型 | ✅ |
| A4 | 语义分类器兜底 | `host`：one classifier call per turn | 无标记无关键词的英文提示 → web-research 池模型 | ✅ |
| A5 | 分类器关闭 → 默认任务 | `host`：classifier disabled 分支 | `classifier.enabled=false` → 子会话落到 `general` | ✅ |
| A6 | 分类器路由配错 → 降级 | `host`：failed classifier 走默认 | `classifier.model` 设为不存在的模型 → 确实被调用、失败后降级 | ✅ |
| A7 | `classifier.timeoutMs` 生效 | `host`：慢失败不重试 | `timeoutMs=1` → 分类器来不及作答 → 降级默认任务 | ✅ |
| A8 | `classifier.maxInputTokens` 生效 | `host`：输入被裁剪到预算（断言裁剪后的文本与 token 数） | `maxInputTokens=8` → 分类器认不出任务 → 降级且不崩 | ✅ |
| A9 | 分类器输入有界、单条消息 | `host`：`maxTokens>=128`、`messages===1` | 同 A7/A8 的实测（未出现超长/多条） | ✅ |
| A10 | 分类结果整轮固定（重试不重问） | `host`：**重试后仍用本轮分类结果**、分类器只被问一次 | 实测过"重试换了任务"的旧行为，修复后同一轮不再换 | ✅ |
| A11 | `defaultTaskId` 设定/切换 | `core` + `host` | 设为 `web-research` → 未命中走 google 池 | ✅ |
| A12 | `defaultTaskId` 清空 → 保持继承 | `host`：no default keeps inherited | 清空 + 分类器关闭 → 子会话保持父模型，且 `picks` 不增 | ✅ |
| A13 | `tasks[].enabled` 关闭 | `core`：候选过滤 | 关掉 `web-research` → 关键词不再命中它 → 回落默认任务 | ✅ |
| A14 | `enabled` 总开关 | `host`：撤销/恢复授权与工具 | 关闭 → `installed=0/owned=false`；开启 → 重新安装（**零模型调用**） | ✅ |

## B. 模型池与失败处理

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| B1 | smooth weighted 轮转 | `core`：2:1/3:1 精确序列（`abaaba`/`aabaaaba`） | 3:1 池连续 4 次 = `deepseek, deepseek, dashscope, deepseek`（与离线预测一致） | ✅ |
| B2 | `pool[].weight` 配比 | `core`：精确序列 + 计数 | 同上（1:1 会是 2:2，实测是 3:1） | ✅ |
| B3 | `stats` 读数诚实 | `core`：**预测的 next == 实际 pick**；权重为配置值 | 预测首投命中；权重显示 `3,1` 而非累加器（旧版会显示负数） | ✅ |
| B4 | 池内失败转移 | `host`：rotate 到下一个候选 | b-ai 余额 0 → 一次 400 后换到可用候选 | ✅ |
| B5 | 配额类失败 = provider 级 | `host`：quota 跳过同 provider 其余候选 | 跳过 b-ai 另外两个模型，直接换 provider | ✅ |
| B6 | 整池耗尽 → 默认任务 | `host`：ban + fallback | C 系列实测（子会话最终跑在默认任务上并完成） | ✅ |
| B7 | 全部耗尽 → 交回调用方 | `host`：no retry，保持继承 | C0 实测（保持父模型、`picks` 不增） | ✅ |
| B8 | 重试有硬预算（防死循环） | `host`：预算用尽即不再重试 | 修复前实测 **164 次**无限重试；修复后同一场景 **2 次**完成 | ✅ |
| B9 | 失败归因（事件无 `model`） | `host`：用真实事件形状断言池被排空 | 同上（b-ai/quota 两种真实失败都正确归因） | ✅ |
| B10 | 单模型池不消耗重试 | `host`：single-model pool 无候选 | — | ✅ 离线 |

## C. 委派能力（零预设改动）

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| C1 | 运行时注册自己的一对工具 | `host`：注册在 agent 作用域、遮蔽内置 | 授权后工具可用并真的路由（子会话日志为证） | ✅ |
| C2 | 撤销授权 = 销毁 fiber | `host`：撤销后 `owns.size==0`、内置恢复 | 撤销 → `installed=0/owned=false`；恢复 → 重新安装（零模型调用） | ✅ |
| C3 | 屏蔽继承来的委派工具 | `host`：`restrict` 生效、disposer 还原 | 子会话工具表里 `send_message`/`list_agents` 被移除（33→32） | ✅ |
| C4 | 不给子会话安装本插件工具 | `host`：子会话 `owns.size==0` | 子会话工具表无本插件文案（`executor class` 0 次命中） | ✅ |
| C5 | 工具在执行期拒绝子会话 | `host`：subagent caller 被拒 | 见 C7（实测走的是内置工具 + 服务守卫） | ✅ |
| C6 | 深度守卫（服务层拦截） | `host`：实例冻结时走原型、装不上则上报 | `depthGuard=True/depthLimit=1` | ✅ |
| C7 | `childDelegation=false` 时子会话不能再派 | `host`：limit 1、子会话被拒 | 子会话调用内置 `subagent` → **被拒**，且**没有**产生 `depth=2` 会话 | ✅ |
| C8 | `childDelegation=true` 时可多一层 | `host`：limit 2、`maxDepth=2` | 子会话**成功**派出孙子（2 例）；孙子（depth=2）再派**被拒** | ✅ |
| C9 | 守卫装不上不假装生效 | `host`：冻结实例 → `depthGuard=false` + 记降级 | 1.0.3 实测 `start is not writable` → 健康面如实显示 | ✅ |
| C10 | 屏蔽不掉的名单可见 | `host`：`agents[].unmasked` | 子会话仍见 `subagent`（自有层不可屏蔽）→ 见"已知边界" | ✅ |

## D. 子智能体档案

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| D1 | `childPersona` 填入 → 整体替换系统提示 | `host`：`complete:true` 落到子作用域 | 子会话 `system/message` 就是该人格（无其它提示段） | ✅ |
| D2 | `childPersona` 不填 → 继承 | `host`：无声明即不注册 | 未填时子会话 `system/message` 是默认 DSH 提示 | ✅ |
| D3 | `childTools.allow` 逐项勾选生效 | `host`：过滤器形状 = 声明值 | `allow=[read,grep,glob]` → 子会话工具表只有这 3 个 + 自有层 2 个，且真的用它们干活 | ✅ |
| D4 | `childTools.deny` 生效 | `host`：deny 形状 | `deny=[pwsh]` → 子会话工具表无 `pwsh` | ✅ |
| D5 | 声明 childTools 不再丢掉默认白名单 | `host`：deny 折进白名单、且不命名委派工具 | 见 C3（同一机制） | ✅ |

## E. 配置与存储

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| E1 | 文件存储读写（真实文件系统） | `store` 33 条 | 部署运行 `source: files`、4 个文件 | ✅ |
| E2 | 原子写入 + 单文件容错 | `store` | — | ✅ 离线 |
| E3 | 从 `settings.yaml` 迁移 | `store` + `deployed` | 健康面 `migration` 字段为"目录已有配置" | ✅ |
| E4 | 目录轮询热加载（约 1 秒） | `host`：签名变化即重载 | 每次改配置 2 秒内生效（本轮所有实测都靠它） | ✅ |
| E5 | 设置页草稿 + 保存/取消 + 栅栏 | `render` 171 条（草稿、保存栏、冲突） | POST 往返 + 过期 revision 被拒 | ✅ |
| E6 | revision 按内容计算 | `wiring`：同内容重写不动、改回原值 | 纯 touch 内容不变 → revision 不动；改回 → 精确回原值 | ✅ |
| E7 | 测试不污染真实配置 | `wiring` 最后一条：线上 revision 未动 | 每轮实测结束都核对 revision | ✅ |
| E8 | 配置校验（非法值被拒） | `core` 90 条 | POST 非法负载返回 problems（未落盘） | ✅ |

## F. 界面与诊断

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| F1 | 设置分区真实渲染 | `render` 171 条（真实 React + 真实 bundle） | 页面由你确认（我看不到浏览器） | ⚠️ 见下 |
| F2 | 文案中英双语、随语言切换 | `render`：键集合一致、切 en 后无中文、源码除 `COPY.zh` 外无中日韩字符 | 机制与内置插件一致（`ctx.locale`） | ✅ |
| F3 | 健康面字段完整 | `host`：字段与取值 | `verify-live.ps1` 十项断言（含 `depthGuard`） | ✅ |
| F4 | 熔断只计请求路径失败 | `host`：降级 6 条不跳闸、请求路径失败跳闸 | 6 条降级在线时 `breaker=false/consecutive=0` | ✅ |
| F5 | 降级可见（`counted:false`） | `host` | 健康面 `errors[]` 带 `counted` | ✅ |
| F6 | 页面永不空白（错误边界） | `render`：faces 抛错、React 不完整、bundle 加载失败 | — | ✅ 离线 |
| F7 | `health` / `config` 接口 | `host` + `wiring` | 只读读健康面、POST 写配置（本轮所有实测都用它） | ✅ |

## G. 打包、安装与可移植性

| # | 功能项 | 离线断言 | 真实验证 | 结论 |
| --- | --- | --- | --- | --- |
| G1 | 两个真实加载器都能加载 | `package` 29 条 | 部署实际加载（健康面在线） | ✅ |
| G2 | skill 契约（`/` 调用、不进模型目录） | `package` | 已装入 `$DSH_HOME/skills/model-routing` | ✅ |
| G3 | 构建产物读真实配置目录 | `wiring` | 部署 `source: files` | ✅ |
| G4 | 新机器可构建（空 `DSH_HOME`） | — | 实测：空 home 下构建完整跑完、skill 正确装入（1.0.8 修复前会中断） | ✅ |
| G5 | 无绝对路径、无平台专有构造 | `portability` 8 条（含产物） | 同上（构建/测试/文档/产物一起扫） | ✅ |
| G6 | README 双语同步 | `docs`：章节数、代码块、表格、内联代码、配置键、命令全覆盖 | — | ✅ 离线 |
| G7 | LICENSE 为 MIT（英文） | `portability` + `docs` | — | ✅ 离线 |

## 只有离线证据的项（诚实清单）

| 项 | 为什么 |
| --- | --- |
| F1 设置页在**真实浏览器**里的观感 | 171 条断言跑的是真实 bundle + 真实 React，但我没有浏览器可看。它背后的接口、栅栏、文案切换都实测过——**这一项需要你扫一眼**。 |
| `subagent_fork` / `subagent_codex` / `subagent_claude_code` 后端 | 本部署没装这些后端，相关屏蔽/过滤分支只有离线覆盖；深度守卫走同一个服务调用，对它们同样生效。 |
| `ralph` / `workflow` 的委派路径 | 同样经过被守卫的服务，但我只真实驱动了内置 `subagent` 那条路径。 |
| 老/新 DSH 版本、`headless` profile | 能力探测会优雅降级（`capabilities` 字段），但只有离线断言；本机只真实跑过 `web` profile。 |
| `pool[].weight` 的**统计分布**（多轮抽样） | 用确定性办法验证：3:1 池任意连续 4 次必为 3:1，实测与离线预测逐项一致；更大样本只是重复同一结论。 |

## 已知边界（设计内，非缺陷）

- **子会话仍看得见一个委派工具**：它跑的是父预设的副本，那份副本把内置委派工具装进子会话**自己的
  作用域**，外部三种办法都去掉不（deny 会被拒且连带丢掉整个过滤器、白名单留不住、桥接 `restrict`
  报未知工具）。所以保证的形式是"**能用但一定被拒**"，由服务层深度守卫执行。
- **分类器是 LLM**：边界提示的判定可能两次不同；插件保证整轮内不再重问。
