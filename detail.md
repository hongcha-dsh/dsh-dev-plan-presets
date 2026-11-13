# detail — dsh-dev-plan-presets

## 一、机制落点（依据 DSH 0.2.2-rc.1 随包文档）

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

## 二、关键设计约束

1. **`agentPreset` 必须显式写。** 省略时子级"加入父方当前 preset 代际"——也就是继承 `dev-plan` 这套没有仓库工具的 preset，scout 会变成什么都读不了。
2. **平铺 `tool-subagent`，不套 `cordis:group`。** standard 把它们放进 `isolate: workflowEngine` 组，是因为要挂 `workflow-ptc`；本包不挂 workflow，也就不需要那个隔离域。三个实例在同一个 agent 作用域里靠 `toolName` 区分。
3. **每个 preset 自带 `compaction` 组。** web-app 在 host 平面禁用了 `compaction-basic` / `command-compact` / `tool-result-pruner`，由 preset 拥有；`isolate` 的两个键保证每个 preset 拿到自己的实例，不互相抢服务。
4. **persona 必须写 `suffix`。** persona 的 `suffix` 默认为空，且**空会遮蔽部署级 suffix**（不是继承）。本包给每个角色都写了后缀，既是角色收尾规则，也避免"以后部署级后缀被静默吃掉"。
5. **不使用 `tool-workflow` 与 `subagent_fork`。** `tool-workflow` 没有 `agentPreset` 配置项，其 `agent()` 会继承父 preset（= 没有工具）；fork 明确拒绝 `agentPreset`。两者都会让角色退化。
6. **`index.js` 是空壳。** 不注册工具、不注册路由、不注入提示词；存在的意义是让 bundle 在插件页有一行可管理，并在加载时做一次打包自检（缺补丁文件只告警，不让 Host 启动失败）。
7. **persona 不写模板变量。** 循环只注册 `provider` / `model`，未知变量会让**每次请求的提示词组装直接抛错**；本包连 `{{model}}` 都不写，静态检查里也禁止出现 `{{`。

## 三、明确的非目标

- 不做工具掩码插件（B 方案）：能硬隔离，但要额外代码 + 可行性实测；本次按用户选择保持纯静态。
- 不做带 Shell 的 `probe` 角色：Shell 无法按子代理禁写，写了只能靠事后比对检测。
- 不做 `scribe` 的路径白名单：preset 机制没有按路径限写的开关。
- 不改 `standard`、不改默认 preset、不改桥接插件与模型钉。

## 四、未验证项（本机没有安装，故以下均为"待实测"）

- [ ] bundle 装载后三个 preset 是否真的出现在选择器，`order` 10/90/91 的排序是否正确。
- [ ] `dev-plan` 会话的实际工具清单是否只剩 `ask_user_question` / `recon` / `review` / `scribe` / `send_message` / `list_agents` / `interrupt_agent`（含全局插件是否注入额外工具）。
- [ ] `agentOptions` 与 `dsh-subagent-model-pin`（`honorExplicit: false`）并存时，子会话实际路由是否仍为 `dsh-opencode-go / deepseek-v4.1-flash`。
- [ ] `agentPreset: scout` 在委派时能否正确解析（未知 id 只在调用时报错，加载时不报）。
- [ ] 三个 `cordis:group` 压缩行在同一个 agent 作用域内多次挂载是否无冲突。
- [ ] `scribe` 在 workspace-write 沙箱下对项目目录的写入是否被允许，越界时错误是否可读。
- [ ] 插件管理页是否显示本包一行（locale/icon 是否生效）。

## 五、静态验证

`node scripts/verify-presets.mjs`（144 项）：解析四份补丁，检查 preset id/order、工具面白名单、三入口的 `toolName` / `agentPreset` / `provider` / `maxDepth` / 路由、scout 只读开关、scribe 读写开关、persona 合同、打包清单。

它只覆盖**声明**；运行期行为必须按 README「验证」的手工清单逐条确认。
