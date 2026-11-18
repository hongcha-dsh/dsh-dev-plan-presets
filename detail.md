# dsh-dev-plan-presets 详情

## 一、这是什么

一个给昂贵主模型用的 DSH Agent preset 包。主窗只做规划、派工与复核，实际施工交给 `develop` 子代理；内置子代理模型守门，避免子代理误继承昂贵主模型。

0.3.0 的结构变化：

- 从「bundle 里静态写一份 `@deepseek-ai/dsh-agent-preset` 行」改为「Host 插件在运行时 `ctx.agentPresets.register()` 动态注册」；
- 新增 `develop` 委派工具，让主窗直接派工、收汇报、派独立复核、再返工给同一 `developer`；
- 新增插件设置页（`plugins.row.config`）与 Host 路由：施工方式从宿主已安装的任意 DSH 预设中选择，provider/model 从宿主目录联动选择；
- 吸收 `dsh-subagent-model-pin` 的子代理模型守门能力；
- preset 真源从 YAML 迁移到 `preset.js`，运行期不依赖 `js-yaml` 或 `@deepseek-ai/schemastery`。

内部 preset id 仍是 `dev-plan`；插件管理器显示名是「开发规划与交付模式」（英文 Development planning & delivery Mode），preset 名称仍是「开发规划与交付」。

## 二、四个委派工具

| 工具 | 用途 | preset |
|---|---|---|
| `recon` | 查证、遍历、搜索仓库事实 | `standard` |
| `review` | 独立复核、证伪关键事实 | `standard` |
| `scribe` | 定稿文档逐字落盘 | `standard` |
| `develop` | 实际施工、跑测试、修缺陷 | 任意可用预设（默认 `standard`） |

四个实例都是：

- `provider: spawn`（只有进程内 spawn 支持 `agentPreset`）；
- `maxDepth: 1`；
- `modelSelection: false`、`modelDiscovery: false`；
- 不设 `allowedAgentPresets`；
- `agentOptions` 来自同一设置真源（`childProvider` / `childModel` / 可选 `childReasoningEffort`）。

`recon` / `review` / `scribe` 永远绑定 `standard`；只有 `develop` 随设置切换。所选预设由宿主 `agentPresets` 目录决定，设置页不维护第二份白名单。

## 三、主窗合同

主窗 persona 的硬规则：

1. 自身永不亲自写代码；
2. 默认只规划与复核，只有用户明确说「开工 / 施工 / 修复」才可派 `develop`；授权后必须实际调用 `develop`，只写/展示任务书、说“准备派工”不算派工；
3. 派工事实以工具调用为准：任务书是 `develop` 的 prompt 参数，不是聊天交付；只有工具接受后才可称“已派出 developer”，之后结束回合等自动通知；`develop` 不可用/调用失败/未发生必须报告“未派工”及原因，不得假装成功；返工必须实际调用 `send_message`；
4. 首次开发固定 `name=developer`，后续追问/返工用 `send_message` 续派同一个 developer，不反复新建；
5. 收到汇报后可派独立 `review`，问题直接返工给同一 developer，不依赖双窗按钮；
6. 只有扩大范围、越权或不可逆风险才问用户；
7. 用户已明确批准开工时，不重复请求同一个开工批准；
8. 同一任务不得同时使用 `develop` 和 `rework_task` / `ask_worker`；
9. 不能把子代理自述当作自己已经运行测试；
10. 派 `develop` 必须在创建参数 `cwd` 中传真实施工目录；派工前检查当前会话可写范围，不在范围内或无法确认时停止派工，不得先建后 cd，也不假设父会话事后提权会扩大已有子代理权限。

`develop` 的任务书必须自足，完整模板以 [docs/flow-redesign.md](docs/flow-redesign.md) 为唯一合同：目标、非目标、验收标准、允许改动路径、接口/依赖、检查命令、风险/回退、完成定义、实际变更证据、汇报格式。完工汇报必须附可审查的真实 diff（新文件/非 Git 给修改前后内容或等价证据），不能只给文件清单；主窗只拿到摘要时不得声称审过实际 diff，应先 send_message 要同一 developer 补证据。汇报固定含改动、真实命令与输出、自验收、风险、假设与未验证项、阻塞项、实际变更证据。子代理不向人类提问；缺信息或冲突在汇报里单列并停止相关动作。

## 四、设置

设置入口：插件 → 已安装 → 开发规划与交付模式 → 包含组件 → 点插件行标题/右箭头（`plugins.row.config`，key=`dsh-dev-plan-presets#dev-plan-presets`；入口不一定显示 “Configure”）。

| 字段 | 默认 | 说明 |
|---|---|---|
| `developMode` | `standard` | 施工子代理 preset：任意已注册预设；损坏/自身项禁用 |
| `childProvider` | `dsh-opencode-go` | 四个工具共用；从宿主目录选择 |
| `childModel` | `deepseek-v4.1-flash` | 四个工具共用；随 provider 联动 |
| `childReasoningEffort` | 空 | 空 = 省略该键 |
| `modelGuardMode` | `pin` | off / audit / pin |
| `killOnViolation` | `true` | pin 下越界是否打断 |
| `honorExplicit` | `false` | 是否尊重子代理显式路由 |
| `audit` | `true` | 是否写审计日志 |
| `guardAllSubagents` | `false` | 默认只守 dev-plan 子代理；勾选后全局 |

保存链路：Client → `/plugins/dev-plan-presets/config` → 严格 Standard Schema 校验 → `configEditor.edit(entry, ...)` → profile patch → Loader 重建。不手改 profile 的 `cordis.patch.yml`，也不在插件目录写 `config.json`。

配置是普通非 volatile 字段：保存后插件重建，preset 重新动态注册；现有会话保留旧代际，新建会话使用新设置。`configEditor.edit` 会 await reconcile；保存返回时已尝试重建/应用新配置，前端以回读值为准。

设置页行为：

- `/state` 404 时显示“重启 DSH 并确认插件行启用”的指引并停止自动轮询，手动刷新可重试；网络错误显示“确认 DSH 运行/插件启用，点刷新重试”，原始错误作 mono 次要文本；
- POST 仅接受 `application/json`（允许 charset），否则 415；cross-site 或 Origin 与请求 Host / `webServer.getOrigin()` 实际监听 origin 不一致返回 403（127.0.0.1 / localhost / [::1] 同端口有限等价），被拒绝请求不调用 configEditor；反代改写 Origin/Host 本轮不支持；
- 语言跟随宿主 `ctx.locale`，主题只用已核实的 `--dsw-alias-*` / `--dsw-radius-*` token；
- guard 由插件总 disposer 跟踪，插件卸载/HMR 会移除所有已装 `agent/pre-step` 守卫。

## 五、施工方式与回退

默认 `standard`：完全不需要深度 PTC，零额外依赖。

设置页“施工方式”下拉读取宿主 `agentPresets` 目录：

1. 列出真实预设的名称与 id；`standard` 始终可选。
2. `dev-plan` 自身禁用，避免 develop 递归派工。
3. 带 broken 诊断的预设显示但禁用，并说明加载失败。
4. 已保存的预设后来被移除/损坏时保留配置原值，页面提示；运行期先回退 `standard`，不静默改写配置。

可用性只认 registry 中已注册且无 broken 的目标预设；目录读取超时或不可用时显式回退 `standard`：
- Host warning；
- 动态 preset `description` 写「已回退 standard」与原因；
- 主窗 persona 写「当前施工子代理模式：已回退 standard」；
- 设置页黄色横幅显示原因。

启动后延迟复检一次：目标预设完成注册后把 `develop` 提升回所选值；期间先走安全路径。回退状态对模型和用户都可见，不是静默降级。

## 六、流程提效（P0）

完整开发/验收合同见 [docs/flow-redesign.md](docs/flow-redesign.md)。P0 只改提示词与流程，不新增设置/工具/依赖：

- **风险分级**：按歧义、影响面、可逆性、可验证性选快速/标准/高风险路径；快速路径不取消用户开工批准、developer 自验和主窗审查。
- **一次性开工契约**：范围、非目标、允许路径、接口/依赖、验收条件、检查命令、风险/回退一次写清；普通实现不反复等待批准，只有范围扩大、风险变化或宿主权限要求才重新确认。
- **验收前置与成本排序**：最小切片 → 语法/静态契约 → 针对性测试 → 必要运行/GUI；静态检查不等于真实验证。
- **非阻塞协作**：主窗不轮询、不忙等、不重复施工、不重复读取 developer 正在修改的文件；developer 只在阻塞、范围冲突或关键契约决策时打断主窗。
- **证据化报告与严重度返工**：developer 汇报 verified/partial/failed/未验证；主窗审实际 diff 与关键证据，阻塞问题 send_message 给同一 developer，非阻塞建议不无限打磨。

`recon` 仅缺事实时调用，`review` 仅高风险/确有需要时调用，`scribe` 仅文档属于验收或用户需要时调用；主窗最终审查责任不外包。

## 七、模型守门

- 默认只管理父会话 preset 为 `dev-plan` 的子代理；判断优先用 `agentPresets.presetForSession(session)`，回退 `session.header.agentPreset`，都拿不到时跳过，避免误伤其他插件。
- 只认真正的子代理 header：`origin: 'subagent'` 或数值 `delegationDepth > 0`；带 `parentSession` 但 depth 0 的 fork 主对话不守。
- 勾选“同时管理其他插件的子代理”（`guardAllSubagents=true`）后恢复旧的全局子代理守门；主会话始终不守门。
- `pin`：创建时先装 `agent/pre-step` 守卫，再尝试 `agent.model.select()` 到目标路由；越界在发请求前 `reject`、`cancel` 并通知父会话。select 不可用或抛错时，`kill=false` 仍保留守卫做后续记录，`kill=true` 才 cancel。
- `audit`：只记录，不 select、不打断。
- `off`：完全不注册守门监听。
- `honorExplicit`：显式非父级路由不钉、也不挂会打断它的守卫。
- `audit` 日志只含事件、agent id 与路由，不含凭据。

与旧插件并存时，若两边都开全局守门，请保持目标路由一致，并在验证新插件后禁用旧插件，避免双重打断。

## 八、与旧插件迁移

1. 安装并启用本插件，保留 `dsh-subagent-model-pin`；
2. 新建会话验证 recon / review / scribe / develop 与守门记录；
3. 确认无误后先验证本插件，再禁用旧插件，重启或等 HMR；
4. 旧插件的 `config.json` / `pin.jsonl` 不再被读取，可保留作历史。

## 九、机制与取舍

| 需求 | 机制 |
|---|---|
| 动态切换施工 preset | `ctx.agentPresets.register(definition)` |
| 配置变更重建 | 普通 Config → Loader 重启插件；旧会话保留旧 revision |
| 不静态重复注册 | `cordis.patch.yml` 只挂根插件 |
| 设置页 | Client `plugins.row.config` + Host `/state` `/config` 路由 |
| 配置持久化 | `ctx.get('configEditor').edit(ctx.fiber.entry, ...)` |
| 严格校验 | 手写 Standard Schema（`Config['~standard']`） |
| 回退探测 | registry 中存在且无 broken 的目标 preset 才算可用；loader entry 不再作证据；一次延迟复检 |
| 模型目录 | Host `llm.listProviders()` + `listModels(provider.id)`；单 provider 失败局部降级 |
| 模型守门 | `agent/created` + `agent/pre-step`；默认只守 dev-plan 子代理，主会话永不守 |
| 清理 | `ctx.on` / `ctx.effect` / `child.effect` / `agent.ctx` |

不做的：

- 不做工具掩码或硬安全隔离；
- 不修改 `standard` preset、不修改桥接插件、不修改旧模型钉插件；
- 不写旧的 `presets/dev-plan.patch.yml`；
- 不在运行期解析 YAML；
- 不依赖深度 PTC 才能使用默认路径。

## 十、验证与未验证项

已执行（2026-11-18）：

- `node scripts/verify-presets.mjs`：静态 **472 / 0**、行为 **55 / 0**、负向变异 **58/58**、`node --check` 全 PASS；
- `node --test --experimental-test-isolation=none`：**56 个单元测试**；
- `node --check`：index.js / preset.js / settings.js / guard.js / client.js；
- `npm pack --dry-run`：17 个文件，dry-run 通过。

真实 Host 证据：

- 同版本 install 首次 `already-installed`；按 `nextStep` 执行 `remove_bundle → install_bundle` 后 remove `applied`、install `stage=enable changed=true application=applied warnings=[]`；旧 `include:preset-dev-plan` 消失，`include:dev-plan-presets` active。
- `GET /plugins/dev-plan-presets/state` 从 404 变为 HTTP 200：`registration=active`、`preset.id=dev-plan`、`error=null`、`warnings=[]`；初始 standard，`deepPtc.available=true / presetPresent=true / checked=true`。
- 真实 `POST /config`：`{}` → 200 unchanged；cross-site Origin+Sec-Fetch-Site → 403 forbidden-origin；text/plain → 415 unsupported-media-type；随后 state 配置不变。
- 真实 POST `{"developMode":"deep-ptc"}` → 200 applying=true；state requested/effective=deep-ptc、fallback.active=false、description 显示 deep-ptc。当前本机配置保留 deep-ptc 供新会话验收。
- 来源校验真实 POST（均为 `{}` 无变化）：Origin=`http://127.0.0.1:1162` + same-origin → 200 unchanged；请求 127.0.0.1、Host/Origin=localhost → 200 unchanged（真实 loopback alias）；Host/Origin=evil.example + same-origin → 403 origin-not-authoritative（DNS rebinding 形状）；Origin 端口 9999 而 Host 1162 → 403 origin-mismatch。
- 普通 guard 冒烟 session `3f5e944a-7e6e-4feb-aa51-c03b161a2878`：descriptor 初始 `kimi-coding/kimi-k3.1-pro`，后续 `model/selection` 与 `request/header.config` 为 `dsh-opencode-go/deepseek-v4.1-flash`，`turn/end` completed。这证明真实创建时 pin 与实际请求路由，但不是 dev-plan/develop 测试，也不是越界 cancel 测试。
- **真实 dev-plan 成功会话（快速路径）**：主会话 `a582aad3-bad8-4a89-b915-f9c35c9cb2ed` 选择 dev-plan，模型为 `kimi-coding/kimi-k3.1-pro`；真实 `tool/call develop`（`name=developer`）结果为 `started subagent developer`，子会话 `92bdd971-9fd3-4ec3-9e98-316ec3eb9fa1` 的 `agentPreset/selected=deep-ptc`，descriptor/request headers 为 `dsh-opencode-go/deepseek-v4.1-flash`，实际 `run_code` + PTC dispatch，三轮 completed。主窗仅 3 次工具调用（develop + send_message×2），两次都是同一 developer（目录修正 + phase-2）；`result.txt` 为 phase-2，证据含改前/改后内容/字节/二次读取与 diff。由此可标真实通过：快速路径、实际派工、deep-ptc develop、同一 developer 续派、证据化汇报；不宣称标准/高风险路径或固定提效比例。
- **旧 guard 迁移/新 guard**：`set_plugin` 精确 `include:subagent-model-pin` 后 applied/warnings=[]；旧行 `enabled=false/fiberPhase=null`，`include:dev-plan-presets` active；独立 guard-solo 子会话 `93055ad8-4946-423e-9f71-fddbe399d4f8` 初始 kimi，随后 selection/header 为 opencode-go/deepseek-v4.1-flash，turn completed。证明旧 guard 关闭后新 guard 单独 pin；仍不是越界 cancel 测试。
- 真实 dev-plan 失败样本（回归来源，不是通过证据）：session `4ac35a5d-491b-4bcc-9120-a7f31b1726c7` 只有任务书文本与“已派出”声称，无 `develop` 工具调用、无子代理、无产物，`turn/end` completed。修复后必须用新会话验证实际 `develop` 调用，不能把该会话写成通过。

自检覆盖：四个工具、standard 默认、任意有效预设只切 develop、自引用/损坏/缺失回退且保留配置原值、主窗无施工工具、固定 developer 续派、双通道互斥、模型守门 pin/audit/off/honorExplicit、默认 dev-plan 范围与 global 开关矩阵、预设目录超时、模型目录枚举与单 provider 失败、旧路由保留、guard 卸载、设置路由读写/来源校验、设置页 label/帮助文本/动态下拉契约、打包文件完整，以及 P0 五条（风险路由、一次性契约、验收排序、非阻塞协作、证据化返工）与施工 `cwd`/权限防护的文本/变异/单元测试。

**未验证**（不得写成已通过）：

- 插件页“已安装 → 开发规划与交付模式 → 包含组件 → 行标题/右箭头”入口、设置页真实渲染、明暗主题、语言切换、ARIA/焦点环；
- 设置页 404 降级/停止轮询/手动刷新/network 指引的真实浏览器表现；
- 真实浏览器交互（按钮/焦点/提示）；无 Origin 非浏览器客户端、非监听 host、更多代理/地址形态（真实 HTTP 已覆盖 same-origin、localhost alias、DNS rebinding 形状、错误端口；fake req 全矩阵不等于真实浏览器）；
- 标准/高风险真实任务；主窗未做独立全盘审计，实际提效比例未观察；
- 真实越界 cancel 与父会话通知；
- 缺少 provider/model 时的报错与恢复；
- 预设下拉与 provider→model 联动在真实浏览器中的渲染、键盘操作、长列表与局部失败提示；
- 新增 `guardAllSubagents` 在真实 Host 会话中的范围验证（默认 dev-plan / 勾选全局）。

Host/state 路由、快速路径真实 dev-plan 成功会话（实际 develop/deep-ptc/同一 developer/证据）与普通 guard 冒烟已通过；不等于标准/高风险、越界 cancel 或 GUI 全流程通过。

## 十一、许可证

MIT。
