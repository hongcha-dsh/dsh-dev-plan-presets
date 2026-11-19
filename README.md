# dsh-dev-plan-presets

给 DeepSeek Harness（DSH）用的「开发规划与交付」Agent preset 包：昂贵主模型只做规划、派工与复核；实际施工交给 `develop` 子代理并直接汇报；内置子代理模型守门，避免子代理误继承昂贵主模型。

当前版本 **0.4.0**。在 0.3.0「Host 插件动态注册 + 设置页 + 子代理模型守门」基础上，0.4.0 聚焦全局提速与工程优化：主窗 persona 精简至 ≤ 6,000 字符（将紧凑版 `recon`/`review`/`scribe` 约束融入主预设并明确标注**仅给子代理用**，不在 DSH 预设列表暴露多余子预设选项）；新增可选受控的 `mainToolMode`（`none` / `readonly` / `ask-edit`，永不挂 Shell）与步数提醒阈值 `mainStepWarnThreshold`；设置页改用 `stateVersion`/`stateTag` + ETag `304` 与 700ms/30s 自适应轮询及目录空闲预热。内部 preset id 仍是 `dev-plan`；插件管理器显示名是「开发规划与交付模式」，preset 名称仍是「开发规划与交付」。

- [这个包解决什么问题](#这个包解决什么问题)
- [安装](#安装)
- [四个委派工具](#四个委派工具)
- [主窗行为合同](#主窗行为合同)
- [流程提效（P0）](#流程提效p0)
- [插件设置](#插件设置)
- [施工子代理：从宿主预设中选择](#施工子代理从宿主预设中选择)
- [模型守门](#模型守门)
- [迁移：从 dsh-subagent-model-pin 过来](#迁移从-dsh-subagent-model-pin-过来)
- [架构与实现](#架构与实现)
- [已知限制](#已知限制)
- [验证](#验证)
- [开发](#开发)
- [许可证](#许可证)

## 这个包解决什么问题

昂贵主模型如果亲手读仓库、跑命令、写代码，会同时烧钱和制造不可复核的改动。本包把工作拆成两个角色：

1. **主窗（dev-plan）**：只规划、派工、复核。它不挂载 fs / 搜索 / Web / Shell / workflow / skill / todo / goal 等施工工具，自身**永不亲自写代码**。
2. **子代理**：`recon` / `review` 负责取证与复核，`scribe` 负责文档落盘，`develop` 负责实际施工。四个工具都在进程内 spawn，`maxDepth=1`，并共用同一套子代理模型路由。

0.2.x 只有前三个委派工具，施工通常靠另一个窗口或桥接插件。0.3.0 增加 `develop`，让主窗可以直接派工、收汇报、派独立复核、再返工给同一个 `developer`，不再依赖双窗按钮。

## 安装

本包是普通 DSH bundle，`package.json` 里声明 `dsh.bundle.patch` 和 `dsh.client`。用插件管理器安装本地目录：

```
插件 → Add plugin → 选择本目录
```

安装后启用 `dsh-dev-plan-presets` bundle，然后新建会话并选择「开发规划与交付」。包内没有安装脚本、没有构建步骤、运行期零 `dependencies`。

环境要求：

- DSH `>=0.2.2-rc.3`（`package.json` 的 `engines.dsh`；当前验证基线是 0.2.2-rc.3）；
- 已在 `dsh-base` / Web 或 Desktop profile 中启用 `@deepseek-ai/dsh-agent-preset-registry`（官方 base 自带）；
- Client 设置页还需要 `@deepseek-ai/dsh-client-locale`（Web/Desktop 默认启用）。缺失时设置入口不注册；Host 的 preset 注册、模型守门、状态/保存路由不依赖它。
- 主窗需要有 `agentPresets`、`webServer`、`configEditor` 服务；缺少时按真实降级运行，不会让 Host 启动失败：
  - 缺 `agentPresets`：不动态注册 preset，其余 Host 守门/设置路由仍按可用服务运行；
  - 缺 `webServer`：Client 仍无条件注册设置页，但 `/state` 与 `/config` 路由不存在，页面显示 404 指引、停止自动轮询，点“刷新”重试；
  - 缺 `configEditor`：页面可读状态，保存返回 503（code=`config-editor-unavailable`），需通过插件管理修改本行配置。

## 四个委派工具

| 工具 | 用途 | 子代理 preset | 工具面 |
|---|---|---|---|
| `recon` | 查证、遍历、搜索仓库事实 | `standard` | 完整 standard（由嵌入主预设的紧凑模板约束只读，仅给子代理用） |
| `review` | 独立复核、找问题、证伪关键事实 | `standard` | 完整 standard（由嵌入主预设的紧凑模板约束只读，仅给子代理用） |
| `scribe` | 把定稿文档逐字落盘 | `standard` | 完整 standard（由嵌入主预设的紧凑模板约束写入范围，仅给子代理用） |
| `develop` | 实际施工、跑测试、修缺陷 | 任意可用预设（默认 `standard`） | 由所选 preset 决定 |

四个工具的共同配置：

- `provider: spawn`，只用进程内 spawn（只有它支持 `agentPreset`）；
- `maxDepth: 1`，子代理不能再往下派；
- `modelSelection: false`、`modelDiscovery: false`，模型路由由插件设置钉死，不暴露给模型自选；
- 不设 `allowedAgentPresets`；
- `agentOptions` 来自同一份设置真源：`childProvider` / `childModel` / 可选 `childReasoningEffort`。

`recon` / `review` / `scribe` 始终运行于 `standard`，并将紧凑版角色约束融入主预设且明确标注**仅给子代理用**（避免在 DSH 宿主预设列表出现多余的内部预设）；只有 `develop` 会随设置切换。`dev-plan` 等内部 id 在 `developMode` 选择器与运行期自引用保护中禁用。

## 主窗行为合同

主窗 persona（`preset.js` 生成）固定这些规则：

- 自身永不亲自写代码：不调用 `write` / `edit` / `apply_patch` / `pwsh` / `bash`，不直接改仓库。
- 默认只规划与复核。只有用户明确说「开工 / 施工 / 修复 / 做吧 / 开始实现」这类授权时，才可调用 `develop`；授权后必须实际调用 `develop`，只写/展示任务书、说“准备派工”不算派工。
- 派工事实以工具调用为准：任务书是 `develop` 的 prompt 参数，不是聊天交付；只有工具接受后才可称“已派出 developer”，之后结束回合等自动完成通知。`develop` 不可用、调用失败或没有发生，必须如实报告“未派工”及原因，不能输出假装成功的流程汇总；返工也必须实际调用 `send_message`。
- 首次开发固定 `name=developer`；同一任务的追问、返工、补充验收，一律用 `send_message` 续派同一个 `developer`，不反复新建子代理。
- 收到施工汇报后，主窗先自己做静态复核与证据核对；只有高风险改动或确有独立复核价值时，才另派独立 `review`；review 的问题直接 `send_message` 返工给同一 `developer`，不依赖双窗按钮。
- 只有扩大范围、越权改动、不可逆风险（删数据、改生产配置、强推 Git、改权限/密钥等）才问用户；普通实现细节由 developer 在任务书边界内决定。
- 用户已经通过主窗明确批准开工时，不再重复请求同一个开工批准。
- 同一任务不得同时使用 `develop` 和 `rework_task` / `ask_worker`；两条通道混用会造成双重派发。
- 主窗不能把子代理自述当作自己已经运行测试；引用时必须写明「按 developer 汇报」。
- 主窗没有 fs/search/Shell/Git 工具：developer 的完工汇报必须随附可审查的实际变更证据（优先真实 diff；新文件/非 Git 提供修改前后内容或等价证据）。只有摘要或文件清单时，主窗不得声称审过实际 diff，应先 `send_message` 要同一 developer 补证据。
- **施工目录在创建时固定**：派 `develop` 必须在工具参数 `cwd` 中传本任务的真实施工目录，不能只在任务书里写路径，也不能省略后让子代理继承当前目录。
- **派工前检查可写范围**：目标目录不在当前会话可写工作区、或无法确认时可写，停止派工并向用户说明，不先创建再试。
- **不得先建后 cd**：不允许先以其他目录 spawn，再让 developer 用 `working_directory` / `cd` 绕过权限；子代理权限在创建时固定，父会话事后提权不会扩大已有子代理权限。需要新权限时停止并请用户/主窗处理，不反复重派；权限失败记录实际 cwd、沙箱模式与真实错误。

`develop` 的任务书要求自足，完整模板以 [docs/flow-redesign.md](docs/flow-redesign.md) 为唯一合同，至少包含：

```text
目标：
非目标：
验收标准：
允许改动路径：
接口/依赖：
检查命令：
风险/回退：
完成定义：
实际变更证据：真实 diff / 修改前后内容 / 等价证据，不能只给文件清单
汇报格式：
```

施工汇报固定包含：改动、真实命令与输出、自验收、风险、假设与未验证项、阻塞项、实际变更证据。子代理不向人类提问；缺信息或与任务书冲突时，在汇报里单列并停止相关动作。

## 流程提效（P0）

0.3.0 的 persona 内置了 P0 流程合同，详细开发/验收文档见 [docs/flow-redesign.md](docs/flow-redesign.md)。P0 本身不新增设置项、工具或依赖，只改变主窗与 developer 的协作方式；设置页新增的预设/模型联动与守门范围属于另一项已批准改动：

1. **风险分级**：按歧义、影响面、可逆性、可验证性选快速路径、标准路径、高风险路径。快速路径减少不必要的侦察、独立 review 和文档，但不取消用户开工批准、developer 自验和主窗审查。
2. **一次性开工契约**：范围、非目标、允许路径、接口/依赖、验收条件、检查命令、风险/回退一次写清；用户批准一次覆盖整个已批准范围，普通实现不反复等待批准，只有范围扩大、风险变化或宿主权限要求才重新确认。
3. **验收前置与成本排序**：最小切片 → 语法/静态契约 → 针对性测试 → 必要运行/GUI 验收；静态检查不等于真实验证。
4. **非阻塞协作**：依赖自动完成通知；主窗不轮询、不忙等、不重复施工、不重复读取 developer 正在修改的文件；等待期间只做验收准备/资料研究等非冲突工作。developer 只在阻塞、范围冲突或关键契约决策时打断主窗。
5. **证据化报告与严重度返工**：developer 汇报真实命令/结果、verified/partial/failed 或未验证项、风险与假设；主窗审实际 diff 和关键证据，阻塞问题用 `send_message` 续派同一 developer，非阻塞建议不无限打磨。

明确不做：P1/P2（受控双 developer、持久化任务卡、指标、DAG/Team/重型运行时）、自动降低模型档位、默认双 developer。`recon` 仅缺事实时调用，`review` 仅高风险/确有需要时调用，`scribe` 仅文档属于验收或用户需要时调用；主窗最终审查责任不外包。

## 插件设置

设置入口：**插件 → 已安装 → 开发规划与交付模式 → 包含组件 → 点插件行标题/右箭头**。设置页注册在 `plugins.row.config`，key 是 `dsh-dev-plan-presets#dev-plan-presets`；入口文案由宿主插件页决定，不一定出现 “Configure” 字样。

设置页字段：

| 字段 | 默认 | 含义 |
|---|---|---|
| `developMode` | `standard` | 施工子代理 preset：任意宿主已注册的预设；设置页下拉列出真实目录，损坏/自身项禁用 |
| `childProvider` | `dsh-opencode-go` | 四个委派工具共用的子代理 provider；设置页从宿主目录选择 |
| `childModel` | `deepseek-v4.1-flash` | 四个委派工具共用的子代理 model；随 provider 联动选择 |
| `childReasoningEffort` | 空 | 可选 reasoning effort；空串表示省略该键 |
| `modelGuardMode` | `pin` | `off` / `audit` / `pin` |
| `killOnViolation` | `true` | pin 模式下越界是否 reject + cancel + 通知父会话 |
| `honorExplicit` | `false` | 是否尊重子代理创建时的显式非父级路由 |
| `audit` | `true` | 是否写结构化审计日志（只含路由与事件，不含凭据） |
| `guardAllSubagents` | `false` | 默认只守 `dev-plan` 父会话派出的子代理；勾选后恢复全局子代理守门 |
| `mainToolMode` | `ask-edit` | 主窗工具权限：`ask-edit`（默认，小范围只读核验 + 经用户当轮明确同意后允许 `read`/`edit`/`write` 局部微改，永不挂 Shell）/ `readonly`（仅 `glob`/`grep` 定点检索，不可改文件）/ `none`（纯规划派工，最省主模型额度） |
| `mainStepWarnThreshold` | `6` | 仅在 `mainToolMode !== 'none'` 时生效（`2..30` 整数）：单轮连续步数超阈值只温和提醒转交子代理，绝不 `select`/`cancel`/`reject` 主会话 |

保存路径：Client → Host `/plugins/dev-plan-presets/config` → 严格校验（手写 Standard Schema）→ `ctx.get('configEditor').edit(entry, ...)` → 写回 profile patch → Loader 重建插件。**不手改 profile 的 `cordis.patch.yml`**，也不在插件目录另写 `config.json`。设置页自己的读取/展示走 `/plugins/dev-plan-presets/state`。

配置是普通（非 volatile）字段：保存后插件重建，`cordis.patch.yml` 只挂根插件，preset 由新的 `apply` 重新动态注册。**现有会话保留旧代际**（registry 的 revision 语义），要使用新设置请**新建会话**。`configEditor.edit` 会写入 profile patch 并 await reconcile；保存返回时已尝试重建/应用新配置，前端以回读值为准。

### 设置页行为与安全

- **404/网络降级**：Host 未加载新版插件或 `/state` 路由未注册时，页面显示“重启 DSH 并确认插件行启用”的可执行指引，并停止自动轮询；手动“刷新”可重试，保存后的定时回读也会在 HMR 短暂 404 后继续重试。无法连接 Host 时显示“确认 DSH 运行与插件启用，点刷新重试”，原始错误作为 mono 次要文本。
- **语言与主题**：Client 跟随宿主 `ctx.locale.getSnapshot().active`（非 zh 回退英文），语言切换后实时更新；颜色/边框/圆角只用已验证的 `--dsw-alias-*` / `--dsw-radius-*` 与 `--ds-font-family-code`，不写 hex/rgba，不引组件库。
- **写请求来源/类型**：`POST /config` 只接受 `application/json`（允许 charset），否则 415；`Sec-Fetch-Site: cross-site` 或 Origin 与请求 Host / `webServer.getOrigin()` 实际监听 origin 不一致返回 403（127.0.0.1 / localhost / [::1] 同端口做有限等价）；同源与无 Origin 的非浏览器客户端放行。反代改写 Host/Origin 的场景本轮不支持，需保持权威监听地址。被拒绝的请求不会调用 `configEditor`。
- **错误本地化**：Host 返回稳定 `code`（如 `invalid-config`、`config-editor-unavailable`、`forbidden-origin`、`unsupported-media-type`）；Client 按 code 与校验 path 本地化常见错误，未知错误保留原始 fallback。
- **目录状态**：预设下拉来自 `/state.presets`（含 `broken` 与自身 id）；模型下拉来自 `/state.modelCatalog`（provider 联动、单 provider 失败进 `failures`）。目录读取中、为空、局部失败、旧值不在目录中都有独立提示，且不会自动保存。
- **guard 卸载**：每个子代理的 `agent/pre-step` guard 由插件已持有的 disposer 跟踪；插件 HMR/卸载会解绑 `agent/created`、`agent/disposed` 并卸载所有已装 guard，旧设置不会在重载后继续拦截仍运行的子代理。

## 施工子代理：从宿主预设中选择

### 默认：standard（零额外依赖）

`develop` 使用宿主内置 `standard` preset。它拥有完整工具面（Shell、文件、搜索、委派等），由 persona 与任务书约束行为。本包不要求宿主安装任何第三方深度 PTC 插件。

### 其他已安装预设

设置页的“施工方式”下拉直接读取宿主 `agentPresets` 目录，列出真实可用的预设名称与 id：

1. `standard` 始终可选，作为零依赖默认值。
2. 宿主目录中的其他预设按真实名称/id 展示；`dev-plan` 自身禁用，避免 develop 递归派工。
3. 带 `broken` 诊断的预设仍显示但禁用，并标明“加载失败”；不会假装可选。
4. 已保存的预设后来被移除、禁用或损坏时，**配置原值保留**，页面明确提示；运行期先回退 `standard`，不会静默改写用户配置。

可用性只认 registry 的事实：目标 preset 必须已注册且没有 broken 诊断。目录读取超时或不可用时先显式回退 `standard`，启动后做一次延迟复检；深度 PTC 完成注册后会把 `develop` 提升回所选预设。回退不是静默降级：preset description 与主窗 persona 都写明「已回退 standard」及原因，设置页也显示横幅。

### 模型选择

设置页的“服务商 / 模型”是联动的原生下拉，数据来自 Host 对当前 `llm` 服务的实时枚举：

- 先选 provider，再选该 provider 下的 model；显示友好名称，同时保存真实 id。
- 单个 provider 读取失败只影响它自己，页面显示“部分服务商读取失败”；目录采用 60s 快照 + 后台刷新，`/state` 不等待全量枚举。
- 目录读取失败或为空时，已保存的 provider/model 原样保留并提示不可用；不会自动改成别的模型，也不把目录失败伪装成保存成功。
- 保存仍走原有 `provider/model/reasoningEffort` 数据结构，配置接口兼容。

## 模型守门

0.3.0 吸收了旧插件 `dsh-subagent-model-pin` 的核心能力，但**只保留一套**，避免同时安装两个 guard：

- **默认只管理子代理（本预设范围）**：只有父会话 preset 为 `dev-plan` 的子代理才会被 select / 检查；其他插件、其他会话派出的子代理默认不碰。
- **只认真正的子代理**：头部必须有 `origin: 'subagent'` 或数值 `delegationDepth > 0`；带 `parentSession` 但 `delegationDepth:0` 的 fork 主对话不会被当成子代理。判断父会话 preset 时优先用 `agentPresets.presetForSession(session)`（包含不在当前 roster 的历史选择），回退 `session.header.agentPreset`；两者都拿不到时跳过守门，避免误伤。
- **可选全局管理**：勾选“同时管理其他插件的子代理”（`guardAllSubagents=true`）后恢复旧插件的全局语义，管理所有子代理。
- **主会话永不守门**：没有父会话、也不是 `origin: 'subagent'` 的 Agent 一律跳过，绝不钉主会话。
- **创建时选路由**：`pin` 模式下对子代理调用 `agent.model.select()`，路由来自 `childProvider` / `childModel` / 可选 `childReasoningEffort`。
- **逐步核查**：每个被管理的子代理挂 `agent/pre-step` 守卫，在请求发出前核对 `modelSelection`；越界时：
  - `pin` + `killOnViolation: true`：`reject` 当前 step、`cancel` 子代理、向父会话 `inject` 一条警告；
  - `pin` + `killOnViolation: false`：只记录；
  - `audit`：只记录，不干预；
  - `off`：完全不注册守门监听。
  守卫在创建时、`model.select()` 尝试之前就装好：即使 DSH 不支持 select 或 select 抛错，`killOnViolation=false` 也保留守卫，后续越界仍会记录；`kill=true` 才 cancel + 通知。
- **honorExplicit**：创建时检测到子代理被显式指定了非父级路由，就不钉、也不挂会立刻打断它的守卫。默认 `false`，即一律钉住。
- **审计**：`audit: true` 时写结构化日志，只包含事件、agent id、实际/目标路由；不记录 API Key、token 或任何凭据。无法判断父会话 preset 时会记一条 `guard-skip-unknown-parent-preset` 诊断。
- **越界记录**：设置页展示最近 20 条（内存），不落盘、不跨进程保留。

与旧插件并存时，如果两边都开启全局守门，请让目标路由一致并尽快只保留一套 guard；本插件默认的 dev-plan 范围不会影响其他插件。

## 迁移：从 dsh-subagent-model-pin 过来

旧插件 `dsh-subagent-model-pin` 是全局子代理守门；本插件默认只守 `dev-plan` 父会话的子代理，只有显式勾选全局开关后才与旧插件等价。**不要长期同时启用两个全局 guard**：两边目标路由不一致时会互相 `select`，甚至互相打断。

建议顺序：

1. 先安装/启用本插件，保留旧插件；
2. 新建会话，选择「开发规划与交付」，验证 `recon` / `review` / `scribe` 正常、`develop` 可派工、模型守门记录正常；
3. 确认无误后，**先验证本插件，再禁用旧插件**（Plugins 页把 `dsh-subagent-model-pin` 关闭），然后重启或等 HMR 生效；
4. 旧插件的 `pin.jsonl` / `config.json` 可以保留作历史，不再被读取；本插件不读取也不写入这些文件。

如果两个插件暂时并存，请让两边的目标路由保持一致（默认都是 `dsh-opencode-go / deepseek-v4.1-flash`），以减少冲突。

## 架构与实现

```
index.js              Host 插件：动态 preset、模型守门、HTTP 设置路由
preset.js             dev-plan 的 JS 真源：description / persona / 四个工具
settings.js           设置默认值、normalize、Standard Schema（Config）、路由
guard.js              子代理模型守门
client.js             Client 设置页（plugins.row.config）
cordis.patch.yml      只挂根插件一行
locale/{zh,en}.json   插件页标题/描述
detail.md             插件详情文档
scripts/verify-presets.mjs  静态 + 行为 + 变异自检
test/plugin.test.mjs  node:test 单元测试
```

关键取舍：

- **不用 YAML 声明 preset**：0.3.0 需要在安装时切换施工子代理 preset，静态 YAML 做不到；同时避免运行期引入 `js-yaml`（link 安装时插件目录经常解析不到它）。
- **cordis.patch.yml 只挂根插件**：preset 由 `ctx.agentPresets.register()` 动态注册；`child.effect` 持有并交还 register 返回的 disposer，插件卸载/重建时旧代际被正确释放。如果根补丁再静态注册 `@deepseek-ai/dsh-agent-preset`，会与动态注册重名。
- **手写 Config（Standard Schema）**：不 import `@deepseek-ai/schemastery`，因此不需要宿主包解析，也不需要 peerDependency。`validate` 严格拒绝非法枚举/空路由，`simplify` 让 Loader 持久化普通对象。
- **设置页保存走 configEditor**：Client 只负责显示草稿与调用 Host 路由；Host 用 `ctx.get('configEditor').edit(ctx.fiber.entry, ...)` 写回 profile patch，校验失败不落盘。
- **不依赖深度 PTC**：默认 `standard` 路径完全不要求 `dsh-deep-ptc-mode`；`deep-ptc` 只是可选分支。
- **动态注册清理**：`ctx.inject(['agentPresets'])` + `child.effect`；`ctx.inject(['webServer'])` + `webCtx.effect`；模型守门用 `ctx.on('agent/created')`，子代理逐步守卫注册在 `agent.ctx` 上，随 agent 作用域销毁。

## 已知限制

1. **不是安全沙箱**：preset 只决定挂哪些插件行，不是全局工具白名单。`standard` 子代理仍拥有 Shell / 搜索 / 写文件 / 委派等真实工具；角色边界靠 persona 与任务书约束，不是机制隔离。需要硬隔离请另做工具掩码。
2. **模型守门默认只管本预设的子代理**：默认只处理父会话为 `dev-plan` 的子代理；要影响所有子代理必须显式勾选全局开关。与旧 `dsh-subagent-model-pin` 并存且都开全局时会形成双 guard，迁移完成前请保持路由一致，完成后禁用旧插件。
3. **预设目录探测是保守的**：可用性只认 registry 中已注册且无 broken 的目标 preset；loader entry 不再作为可用证据。目录尚未返回时先回退 standard，启动后延迟复检一次；若目标 preset 在复检之后才注册，本代际不会自动再提升，重新保存设置或重启 Host 可重试。
4. **现有会话不迁移**：配置变更只影响新会话；旧会话保留旧 preset 代际。需要新设置时新建会话。
5. **设置页只做了源码级与假 ctx 行为验证**：真实浏览器渲染、插件行“已安装 → 开发规划与交付模式 → 包含组件 → 行标题/右箭头”入口、语言切换、404 降级、保存后 HMR 重建时序仍需在 GUI 中人工验收（见下）。
6. **审计只在内存/日志**：不写 `pin.jsonl`，不做跨进程持久化；重启后越界记录清空。
7. **显示名已定**：插件管理器/市场显示为「开发规划与交付模式」（英文 Development planning & delivery Mode）；preset 名称仍是「开发规划与交付」，内部 id 是 `dev-plan`。
8. **不覆盖 git 提交**：`develop` 的默认完成边界包含「不执行 git add/commit/push」，需要提交时由用户明确要求。

## 验证

### 静态 / 单元（已执行，2026-11-18）

```
node scripts/verify-presets.mjs
node --test --experimental-test-isolation=none
node --check index.js
node --check preset.js
node --check settings.js
node --check guard.js
node --check client.js
```

结果：**56/56 单元测试通过**；verify **472 静态 / 0 失败、55 行为 / 0 失败、58/58 负向变异检出**；5 个 `node --check` 全 PASS；`npm pack --dry-run` **17 个文件，dry-run 通过**。

验证范围：

- 打包层：package.json / exports / files / bundle patch / client manifest / locale / LICENSE；
- 声明层：四个委派工具、standard 默认、任意有效预设只切 develop、自引用/损坏/缺失回退且保留配置原值、persona 合同（含施工 cwd/权限防护）、角色模板；
- 代码层：`node --check`、真实模块 import、假 ctx 驱动动态注册/释放、模型守门（pin/audit/off/honorExplicit）、guard 卸载、设置路由读写、配置写来源/类型拒绝（含 configEditor 零写入）；
- 界面层：静态检查主题 token、locale 订阅、404 指引、ARIA、动态预设/模型下拉契约、label for 与 aria-describedby、fieldset/legend、禁用/未保存状态与入口文案；
- 变异层：故意改坏关键点（工具名、默认 preset、主窗工具、persona 禁令、施工 cwd/权限规则、回退文案、任意预设解析、自引用保护、守门默认范围、模型目录枚举、client key、硬编码 deep-ptc、label 关联、硬编码颜色、guard 卸载、来源校验等），确认自检会 FAIL。

### 真实 Host 证据（2026-11-18）

**安装 / 装配**

- 同版本 install 首次返回 `already-installed`；按 `nextStep` 执行 `remove_bundle → install_bundle` 后，remove 为 `applied`，install 为 `stage=enable`、`changed=true`、`application=applied`、`warnings=[]`。
- plugin rows 中旧 `include:preset-dev-plan` 已消失，`include:dev-plan-presets` 为 active。

**真实 HTTP（127.0.0.1:1162）**

- `GET /plugins/dev-plan-presets/state` 从旧 404 变为 **HTTP 200**；`registration=active`、`preset.id=dev-plan`、`error=null`、`warnings=[]`。
- 初始 state 为 `standard`；`deepPtc.available=true`、`presetPresent=true`、`checked=true`。
- `POST /config` 无变化 JSON `{}` → **200 unchanged**；cross-site `Origin` + `Sec-Fetch-Site` → **403 forbidden-origin**；`text/plain` → **415 unsupported-media-type**；随后 state 配置不变。
- `POST /config` JSON `{"developMode":"deep-ptc"}` → **200 applying=true**；随后 state 的 `requested/effective=deep-ptc`、`fallback.active=false`、`registration=active`、description 显示 deep-ptc。当前本机配置保留 deep-ptc，供新会话验收。
- 来源校验真实 POST（均为 `{}` 无变化、不写配置）：
  - `Origin=http://127.0.0.1:1162` + `Sec-Fetch-Site: same-origin` → **200 unchanged**；
  - 请求 `127.0.0.1:1162`，Host/Origin 都是 `localhost:1162` → **200 unchanged**（真实 loopback alias 通过）；
  - Host/Origin 都是 `evil.example:1162`，`Sec-Fetch-Site: same-origin` → **403 origin-not-authoritative**（真实 DNS rebinding 形状被拒绝）；
  - `Origin=http://127.0.0.1:9999`，请求 Host=`127.0.0.1:1162` → **403 origin-mismatch**。

**真实 guard 冒烟（普通子代理，不是 dev-plan / develop）**

- session id `3f5e944a-7e6e-4feb-aa51-c03b161a2878`：`subagent/descriptor` 初始 `agentProvider=kimi-coding` / `agentModel=kimi-k3.1-pro`；后续 `model/selection` 与 `request/header.config` 都是 `dsh-opencode-go/deepseek-v4.1-flash`；`turn/end` 为 completed。
- 这证明真实创建时的 pin 与实际请求路由（不是假 ctx），但**不是** dev-plan/develop 测试，也**不是**越界 cancel 测试。

**真实 dev-plan 成功会话（快速路径，2026-11-18）**

- 主会话 `a582aad3-bad8-4a89-b915-f9c35c9cb2ed`：`agent-preset/selected=dev-plan`；`model/selection` 与 `request/header.config` 为 `kimi-coding/kimi-k3.1-pro`；request tools 含 `develop`/`send_message`。
- 真实 `tool/call develop`，`name=developer`，工具结果 `started subagent developer`；`subagent/catalog` childId `92bdd971-9fd3-4ec3-9e98-316ec3eb9fa1`，name `developer`。
- 主窗仅 3 次工具调用：`develop` 一次 + `send_message` 两次；无 `recon`/`review`/`scribe`，无 `ask_user_question`。第一次 `send_message` 修正目录前置假设，第二次让同一 developer 做 phase-2；两次工具结果均为 `message delivered to agent developer`。
- 子会话 `92bdd971-9fd3-4ec3-9e98-316ec3eb9fa1`：`header.parentSession` 为主会话，`agentPreset=deep-ptc`，`agent-preset/selected=deep-ptc`；descriptor/request headers 为 `dsh-opencode-go/deepseek-v4.1-flash`；实际 `run_code` + PTC dispatch，三轮 `turn/end` completed。
- `result.txt` 由主窗 `read` 确认为 phase-2；子代理证据含 phase-1 创建/检查、第二阶段改前 phase-1 guard、改后 phase-2 精确内容/字节/二次读取，最终 `-phase-1/+phase-2` diff。
- 因此可标真实通过：快速路径、实际 `develop` 派工、`develop` 实际使用 deep-ptc、同一 developer 续派、证据化汇报。**不**宣称标准/高风险路径通过；主窗没有做独立全盘审计，实际提效比例也未观察。

**旧 guard 迁移与独立新 guard**

- `set_plugin` 第一次用 `subagent-model-pin` 得 `unknown-plugin`；按 `nextStep` 用精确 `include:subagent-model-pin` 后 `changed=true`/`application=applied`/`warnings=[]`。
- `list_plugins` 中旧 `include:subagent-model-pin` 为 `enabled=false`/`fiberPhase=null`；`include:dev-plan-presets` 仍 active。
- 独立 guard-solo 子会话 `93055ad8-4946-423e-9f71-fddbe399d4f8`：descriptor 初始 `kimi-coding/kimi-k3.1-pro`；随后 `model/selection` 与 `request/header.config` 都是 `dsh-opencode-go/deepseek-v4.1-flash`；`turn/end` completed。这证明旧 guard 关闭后新 guard 单独能 pin 并用于真实请求；仍不是越界 cancel 测试。

**真实 dev-plan 失败样本（回归来源，不是通过证据）**

- session `4ac35a5d-491b-4bcc-9120-a7f31b1726c7`：`agent-preset/selected=dev-plan`，主窗输出完整任务书并声称“已派出 developer”，但日志**无任何实际 `develop` 工具调用、无子代理、无 result.txt**，`turn/end` 却 completed，目标目录无产物。
- 这说明“文本任务书 = 派工完成”的歧义真实存在；本轮已改为“实际工具调用并接受才是唯一派工事实”。修复后必须用新会话验证真实 `develop` 调用，不能把这个失败会话写成通过。

### 仍未验证（不得写成已通过）

- [ ] **0.4.0 新增真机 Host 验收项**：
  - [ ] 通过 `plugin_manager` 重新安装/启用 0.4.0 后，新建 `dev-plan` 会话，验证 `recon` 实际使用 `dev-plan-scout` 且主窗不再输出千字模板；
  - [ ] 对比真实任务体感耗时（规划输出长度、首次 `recon` 到回复耗时、`develop` 派工前等待时间）；
  - [ ] 在设置页分别切换 `mainToolMode` 为 `readonly` 与 `ask-edit`，新建会话验证主窗只读定位与“经用户同意后局部微改”行为，且主会话模型不被守门篡改；
  - [ ] 验证设置页打开时模型列表即时显示、DevTools Network 面板稳态下不再每 4 秒刷 `/state`（转为 30s 保活 + `304`）。
- [ ] 插件页“已安装 → 开发规划与交付模式 → 包含组件 → 行标题/右箭头”入口、设置页真实渲染、明暗主题、语言切换、ARIA 与原生焦点环；
- [ ] 设置页 404 降级、连续 404 停止轮询、手动刷新与 network 错误指引在真实浏览器中的表现（Host 路由已 200，但客户端 UI 未验）；
- [ ] 真实浏览器交互（按钮/焦点/提示）；无 Origin 非浏览器客户端保存、非监听 host、更多代理/地址形态（真实 HTTP 已覆盖 same-origin、localhost loopback alias、DNS rebinding 形状、错误端口；fake req 全矩阵不能替代真实浏览器）；
- [ ] 预设下拉与 provider→model 联动在真实浏览器中的渲染、键盘操作、长列表与局部失败提示；
- [ ] `guardAllSubagents` 在真实 Host 会话中的范围验证（默认只守 dev-plan，勾选后全局）；
- [ ] 标准路径与高风险路径的真实任务；主窗未做独立全盘审计，实际提效比例/固定百分比未观察；
- [ ] 真实越界 cancel 与父会话通知（guard 冒烟只证明路由 pin，不是越界打断）；
- [ ] profile 缺少目标 provider/model 时的报错文本与可恢复性。

Host/state 路由、快速路径真实 dev-plan 成功会话（含实际 develop/deep-ptc/同一 developer 续派/证据化汇报）与普通 guard 冒烟已通过；这不等于标准/高风险路径、真实越界 cancel、GUI 或固定提效比例通过。

## 开发

```sh
node scripts/verify-presets.mjs          # 静态 + 行为 + 变异自检
node --test --experimental-test-isolation=none  # 56 个单元测试
```

Windows 受限沙箱里 `node --test` 默认会为每个测试文件 spawn 子进程并捕获管道输出，可能直接 `EPERM`。本包用 `--experimental-test-isolation=none` 让测试在单进程内跑；普通开发机上去掉该参数也可以。本包运行期零依赖；测试和自检只用 Node 内置模块。不要为了跑测试给插件加 `js-yaml`：preset 真源已经是 JS。

改 persona / 模板时注意：

- 主窗 `persona.prefix + persona.suffix` 预算上限为 **6,000 字符**，避免长 prompt 拖慢 TTFT 与推理 CoT；
- 正常启用内部子预设时，主窗 `prefix` 不得再内联 `ROLE-TEMPLATE:SCOUT:BEGIN` / `ROLE-TEMPLATE:SCRIBE:BEGIN`；
- `dev-plan-scout` 与 `dev-plan-scribe` 绝不挂载 `bash`/`pwsh`/`workflow`/`jobs`/`schedule`/`goal`/`skill`/`todo`/`subagent`/`plan-mode`；
- persona 不写 `{{...}}` 模板变量。

## 许可证

MIT。见 [LICENSE](LICENSE)。
