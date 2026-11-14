# detail — dsh-dev-plan-presets

## 一、这是什么

给昂贵主模型用的「只做判断」preset：规划与静态复核，不实施。

- `dev-plan`：主代理。只保留对话、`recon` / `review` / `scribe` 三个委派入口和子代理管理；不声明任何文件、搜索、Web、Shell 行。
- `scout`：只读子代理，被 `recon` / `review` 调用。只能读文件、读图、搜索、查网页；没有写、没有 Shell、没有 Git 与测试。
- `scribe`：记录子代理，被 `scribe` 调用。只能把主代理定稿的规划/复核文档逐字写入指定路径。

## 二、必须知道的边界（B 方案）

DSH 的 preset 只决定角色挂载哪些插件行，**不是全局工具白名单**。本机全局插件会向所有角色注入
`config_backup` / `config_restore` / `config_sync_*` / `config_import_*` 与 `working_directory` 等工具。

因此本包提供的是：

> **preset 声明层隔离 + persona 明令禁止 + 实际工具面审计。**

不是硬安全隔离。persona 禁止调用未声明工具，但若模型无视提示词，全局注入的工具仍可能被调用。
需要硬隔离请另做工具掩码或全局禁用相关插件——本包明确不做。

同理，`scribe` 的「只写文档」是路径纪律，不是路径白名单。

## 三、机制落点（依据 DSH 0.2.2-rc.1 随包文档）

| 需求 | 用的机制 | 依据（包内文档） |
|---|---|---|
| 声明一个可选 preset | `@deepseek-ai/dsh-agent-preset` 行：`config.id` / `plugins` / `name` / `description` / `order` | `dsh-agent-preset/README.zh.md`「使用此包」 |
| bundle 贡献多份补丁 | `package.json` 的 `dsh.bundle.patch` 接受**数组**，按序应用 | `dsh-web-app/package.json` 的 `dsh.bundle.patch` |
| 主代理没有仓库工具 | preset 的 `plugins` 里**不挂** `dsh-tool-fs` / `-fs-search` / `-web` / `-bash` / `-pwsh` / `-workflow` / `-subagent-fork` | `dsh-tool-fs/README.zh.md`「配置」；`dsh-web-app/cordis.patch.yml`「preset 拥有工具行」 |
| 一个 preset 多个委派入口 | 每个目标挂一个 `dsh-tool-subagent` 实例，`toolName` 必须互不相同 | `dsh-tool-subagent/README.zh.md`「使用此包」 |
| 子代理用独立工具面 | `agentPreset` 字段（**仅进程内 spawn 支持**；fork 与外部后端拒绝） | 同上「选择子级 preset」 |
| 显式低成本路由 | `agentOptions: { provider, model }` | 同上「选择子级 LLM」 |
| 角色路由不用模型自选 | 不设 `allowedAgentPresets`：一个实例只能钉一份 `agentOptions`，且 `agent_preset` 枚举不公开描述 | 同上「选择子级 preset」+「已知限制」 |
| 深度只一层 | `maxDepth: 1`（与 Host 默认一致，显式写死意图） | 同上「受管理的委派」 |
| 只读子代理 | `dsh-tool-fs` 的 `read`/`readImage`/`write`/`edit`/`applyPatch` 独立开关 | `dsh-tool-fs/README.zh.md`「配置」 |
| 压缩长上下文 | 每个 preset 自带 `compaction` 组（`isolate: { compaction, toolResultPruner }`） | `dsh-web-app/presets/standard.patch.yml`（web-app 禁用了 host 的压缩行，preset 必须自挂） |
| 项目规范可注入子代理 | `scout` / `scribe` 也挂 `dsh-agent-instructions` | `dsh-agent-instructions/README.zh.md`「agent 获得的内容」 |
| 人设不丢部署级后缀 | persona 同时写 `prefix` **和** `suffix` | `dsh-persona/README.zh.md`：「省略或空文本会遮蔽掉全局后缀」 |
| 问用户 | `dsh-tool-ask-user`（默认阻塞模式） | `dsh-tool-ask-user/README.zh.md` |
| 子代理管理 | `dsh-tool-subagent-control`：`send_message` / `interrupt_agent` / `list_agents` | `dsh-tool-subagent-control/README.zh.md` |
| 插件页显示本文件 | `locale/*.json` 的 `meta.detail: "detail.md"`；缺省时才回退 README | `dsh-plugin-detail/README.zh.md`「文档顺序」 |

## 四、关键设计约束

1. **`agentPreset` 必须显式写。** 省略时子级"加入父方当前 preset 代际"——也就是继承 `dev-plan` 这套没有仓库工具的 preset，scout 会变成什么都读不了。
2. **平铺 `tool-subagent`，不套 `cordis:group`。** standard 把它们放进 `isolate: workflowEngine` 组，是因为要挂 `workflow-ptc`；本包不挂 workflow，也就不需要那个隔离域。三个实例在同一个 agent 作用域里靠 `toolName` 区分。
3. **每个 preset 自带 `compaction` 组。** web-app 在 host 平面禁用了 `compaction-basic` / `command-compact` / `tool-result-pruner`，由 preset 拥有；`isolate` 的两个键保证每个 preset 拿到自己的实例，不互相抢服务。
4. **persona 必须写 `suffix`。** persona 的 `suffix` 默认为空，且**空会遮蔽部署级 suffix**（不是继承）。本包给每个角色都写了后缀，既是角色收尾规则，也避免"以后部署级后缀被静默吃掉"。
5. **不使用 `tool-workflow` 与 `subagent_fork`。** `tool-workflow` 没有 `agentPreset` 配置项，其 `agent()` 会继承父 preset（= 没有工具）；fork 明确拒绝 `agentPreset`。两者都会让角色退化。
6. **`index.js` 是空壳。** 不注册工具、不注册路由、不注入提示词；存在的意义是让 bundle 在插件页有一行可管理，并在加载时做一次打包自检（缺补丁文件只告警，不让 Host 启动失败）。
7. **persona 不写模板变量。** 循环只注册 `provider` / `model`，未知变量会让**每次请求的提示词组装直接抛错**；本包连 `{{model}}` 都不写，静态检查里也禁止出现 `{{`。

## 五、明确的非目标

- 不做工具掩码插件（B 方案）：能硬隔离，但要额外代码 + 可行性实测；本次按用户选择保持纯静态。
- 不做带 Shell 的 `probe` 角色：Shell 无法按子代理禁写，写了只能靠事后比对检测。
- 不做 `scribe` 的路径白名单：preset 机制没有按路径限写的开关。
- 不改 `standard`、不改默认 preset、不改桥接插件与模型钉、不改插件 `askLimit`。

## 六、未验证项（安装已 applied；以下为运行期待验）

2026-11-14 安装与静态复核（已发生，不是待办）：

- 已通过 `plugin_manager install_bundle` 安装到 desktop profile：target
  `link:D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets`，返回
  `enabled=true, changed=true, application=applied`，版本 `0.1.0`，无 warnings。
- 正式目录复跑 `node scripts/verify-presets.mjs`：**PASS**——静态声明检查 185 通过 / 0 失败，
  `node --check index.js` PASS，`import` + `apply()` smoke PASS（无告警），负向变异 **12/12 检出**。
- 以上只证明**装配成功 + 声明/代码层自检**，**不证明运行期行为**；安装 `applied` 也不等于运行期通过。

以下运行期项**仍未验收**（全部未打勾，不得写成已通过）：

- [ ] 新建会话的预设选择器：三个 preset 是否出现、`order` 10/90/91 的排序是否正确、`standard` 是否仍为默认。
- [ ] `dev-plan` 会话的**实际**工具清单：声明的七个 + 全局注入的 `working_directory` / `config_*`，并确认 persona 禁止后模型不会调用。
- [ ] `agentOptions` 与 `dsh-subagent-model-pin`（`honorExplicit: false`）并存时，子会话实际路由是否仍为 `dsh-opencode-go / deepseek-v4.1-flash`。
- [ ] profile 缺少该 provider/model 时，委派是否在创建子代理时失败（而非静默继承贵模型）。
- [ ] `agentPreset: scout` / `scribe` 在委派时能否正确解析（未知 id 只在调用时报错，加载时不报）。
- [ ] 三个 `cordis:group` 压缩行在同一个 agent 作用域内多次挂载是否无冲突。
- [ ] `scribe` 在 workspace-write 沙箱下对项目目录的写入是否被允许，越界时错误是否可读。
- [ ] 规划/复核行为：`recon` 是否先读后判、`review` 是否给出位置 + 证据 + 可验收的修复要求、`scribe` 回执是否给出绝对路径与字节数。
- [ ] 插件管理页是否显示本包一行，且详细文档来自本文件（`meta.detail`）。

## 七、静态验证

`node scripts/verify-presets.mjs`：声明层合同 + `node --check` + `import`/`apply()` smoke + 负向变异。
2026-11-14 在正式目录复跑 **PASS**：185 通过 / 0 失败，`node --check` 与 `import`/`apply()` smoke 通过，负向变异 12/12 检出。
它仍只覆盖**声明与脚本自检**；运行期行为必须按 README「验证」的手工清单逐条确认。
