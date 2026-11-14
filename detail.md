# detail — dsh-dev-plan-presets

## 一、这是什么

给昂贵主模型用的「只做判断」preset：规划与静态复核，不实施。

- `dev-plan`：唯一注册的主代理 preset。只保留对话、`recon` / `review` / `scribe` 三个委派入口和子代理管理；
  不声明任何文件、搜索、Web、Shell 行。
- `recon` / `review`：委派到宿主内置 `standard` preset 的子代理，派遣 prompt 开头携带「侦察/复核角色模板」。
- `scribe`：委派到 `standard` 的子代理，派遣 prompt 开头携带「文书角色模板」。

v0.1.0 曾有三份 preset（`dev-plan` + 两个内部角色）。方案 B 已删除后两份：角色文字迁入 `dev-plan` persona，
成为带稳定标记的固定模板（`===== ROLE-TEMPLATE:SCOUT:BEGIN/END =====`、
`===== ROLE-TEMPLATE:SCRIBE:BEGIN/END =====`），由主代理在每次派遣时逐字附带。

## 二、必须知道的边界（方案 B）

DSH 的 preset 只决定角色挂载哪些插件行，**不是全局工具白名单**。本机全局插件会向所有角色注入
`config_backup` / `config_restore` / `config_sync_*` / `config_import_*` 与 `working_directory` 等工具。

`tool-subagent` 的实例配置**不接受 `persona` / `toolFilter`**——DSH 文档写明“包含 `persona` 或 `toolFilter`
的工具配置在加载时会报迁移错误”。因此方案 B 无法给每个实例声明独立人设，只能把角色约束放进任务 prompt。

所以本包现在提供的是：

> **主代理的声明级工具面 + 子代理的任务级提示词模板 + 实际工具面审计。**

不是硬安全隔离。`standard` 子代理实际拥有 Shell、搜索、写文件、委派等完整工具；模板禁止越界，
但若模型无视提示词，这些能力仍会被调用。需要硬隔离请另做工具掩码或全局禁用相关插件——本包明确不做。
同理，`scribe` 的「只写文档」是路径纪律，不是路径白名单。
另外，`standard` 的 persona、项目/全局 `AGENTS.md` 或技能目录可能带来额外能力与指令；模板只约束任务正文，
不覆盖这些来源，要求子代理在更高优先级指令与角色边界冲突时停止并报告，不擅自越界执行。

## 三、机制落点

| 需求 | 用的机制 | 依据 / 备注 |
|---|---|---|
| 声明一个可选 preset | `@deepseek-ai/dsh-agent-preset` 行：`config.id` / `plugins` / `name` / `description` / `order` | `dsh-agent-preset/README.zh.md` |
| bundle 贡献补丁 | `package.json` 的 `dsh.bundle.patch` 数组，按序应用；本包现为 2 项 | `dsh-web-app/package.json` |
| 主代理没有仓库工具 | preset 的 `plugins` 不挂 `dsh-tool-fs` / `-fs-search` / `-web` / `-bash` / `-pwsh` / `-workflow` / `-subagent-fork` | `dsh-tool-fs/README.zh.md`「配置」 |
| 一个 preset 多个委派入口 | 每个目标挂一个 `dsh-tool-subagent` 实例，`toolName` 互不相同 | `dsh-tool-subagent/README.zh.md` |
| 子代理跑完整工具面 | `agentPreset: standard`（宿主内置；**仅进程内 spawn 支持**） | 同上「选择子级 preset」；`dsh-web-app/presets/standard.patch.yml` |
| 角色边界（只读 / 限定写入） | **任务级模板**：主代理在每次派遣 prompt 开头逐字附带；不是声明级隔离 | 同上；实例不接受 `persona` |
| 显式低成本路由 | `agentOptions: { provider, model }` | 同上「选择子级 LLM」 |
| 角色路由不用模型自选 | 不设 `allowedAgentPresets`：一个实例只能钉一份 `agentOptions`，枚举不公开描述 | 同上「选择子级 preset」+「已知限制」 |
| 深度只一层 | `maxDepth: 1`（与 Host 默认一致，显式写死意图） | 同上「受管理的委派」 |
| 压缩长上下文 | `dev-plan` 自带 `compaction` 组（`isolate: { compaction, toolResultPruner }`） | `dsh-web-app/presets/standard.patch.yml`（web-app 禁用 host 压缩行，preset 必须自挂） |
| 子代理读到项目规范 | `standard` 自带 `dsh-agent-instructions`，无需本包再声明 | `standard.patch.yml` |
| 人设不丢部署级后缀 | `dev-plan` persona 同时写 `prefix` **和** `suffix` | `dsh-persona/README.zh.md`：空文本会遮蔽全局后缀 |
| 问用户 | `dsh-tool-ask-user` | `dsh-tool-ask-user/README.zh.md` |
| 子代理管理 | `dsh-tool-subagent-control`：`send_message` / `interrupt_agent` / `list_agents` | `dsh-tool-subagent-control/README.zh.md` |
| 插件页显示本文件 | `locale/*.json` 的 `meta.detail: "detail.md"` | `dsh-plugin-detail/README.zh.md` |

## 四、关键设计约束

1. **`agentPreset` 必须显式写。** 省略时子级“加入父方当前 preset 代际”——也就是继承 `dev-plan` 这套没有仓库工具的
   preset，子代理会变成什么都读不了。现在三个实例都显式写 `standard`。
2. **角色模板必须由主代理附带，不能靠子代理自己取。** 模板存在 `dev-plan` persona 里，不在任何子代理配置里；
   主代理省略或压缩模板时，子代理只剩任务正文。静态检查只能证明模板文本存在，不能证明真的被附带。
3. **平铺 `tool-subagent`，不套 `cordis:group`。** `standard` 把它们放进 `isolate: workflowEngine` 组是因为要挂
   `workflow-ptc`；本包不挂 workflow。三个实例在同一个 agent 作用域里靠 `toolName` 区分。
4. **`compaction` 组只保留一份。** 删掉 scout/scribe 后只剩 `dev-plan` 的压缩组；`isolate` 的两个键保证实例独立。
5. **persona 必须写 `suffix`。** 空 `suffix` 会遮蔽部署级 suffix（不是继承）。本包保留了主代理的后缀。
6. **不使用 `tool-workflow` 与 `subagent_fork`。** workflow 没有 `agentPreset` 配置项，其 `agent()` 会继承父 preset
   （= 没有工具）；fork 明确拒绝 `agentPreset`。两者都会让角色退化。
7. **`index.js` 是空壳。** 不注册工具、不注册路由、不注入提示词；存在意义是让 bundle 在插件页有一行可管理，
   并在加载时做一次打包自检（缺补丁文件只告警，不让 Host 启动失败）。自检现在只期待 `dev-plan`。
8. **persona 不写模板变量。** 循环只注册 `provider` / `model`，未知变量会让每次请求的提示词组装直接抛错；
   本包连 `{{model}}` 都不写，静态检查禁止出现 `{{`。
9. **模板标记必须稳定。** 验证脚本按 `ROLE-TEMPLATE:SCOUT/SCRIBE:BEGIN/END` 抽取正文；改模板时不要改标记行，
   否则模板合同检查会失败（这是有意的）。
10. **每次派遣重复携带模板，是固定 token 成本。** 模板越长，子代理输入越贵；压缩模板会削掉职责，
    两者只能权衡，不能两全。

## 五、明确的非目标

- 不做工具掩码插件（B 方案）：能硬隔离，但要额外代码 + 可行性实测；本次按用户选择保持纯静态。
- 不通过核心 hook 给每个子代理注入 persona（需要改 DSH 核心，明确排除）。
- 不做带 Shell 的 `probe` 角色。
- 不做 `scribe` 的路径白名单：机制没有按路径限写的开关。
- 不改 `standard`、不改默认 preset、不改桥接插件与模型钉、不改插件 `askLimit`。
- 不新增其他插件、不安装/卸载、不为本次变更强制重启（热应用已完成）；git 提交由后续收尾步骤单独执行。

## 六、未验证项（静态验证已做；以下为运行期待验）

2026-11-14 迁移后的静态复核（已实际执行）：

- `node scripts/verify-presets.mjs`：**PASS**——静态声明检查 195 通过 / 0 失败，
  `node --check index.js` PASS，`import` + `apply()` smoke PASS（无告警），负向变异 **25/25 检出**（含 5 个语义变异）。
- `git diff --check`：PASS。
- 以上只证明**声明/文档/代码层自检**，不证明运行期行为。独立定向复核在生产副本复跑结果一致：195/0、25/25，
  5 个语义变异全部复现为失败。
- 安装状态分层：上次安装操作记录是 `0.1.0 / applied`；同 link 的 `install_bundle` 返回 no-op
  （`changed=false`、`application=failed`、`error.code=already-installed`，未改配置）；随后 `set_bundle`
  禁用→启用两次均为 `changed=true` / `application=applied` / `warnings=[]`，热应用成功。管理器 live listing
  已读为 `0.2.0`、`enabled/installed=true`，rows 只有 `dev-plan-presets` + `preset-dev-plan`，
  没有旧 `scout` / `scribe` 的注册行。`list_bundles` 的行列表本身不能当作重装配证据，装配证据是
  `set_bundle` 的 `application=applied`。
- 运行中的行为（新建会话选择器、实际派遣与模板附带）仍需用户手工验收，不得写成已通过。

以下运行期项**仍未验收**（全部未打勾，不得写成已通过）：

- [ ] 新建会话后，预设选择器只剩「开发规划」，`standard` 仍默认；旧的内部角色入口消失。
- [ ] `dev-plan` 会话的实际工具清单：声明的七个 + 全局注入的 `working_directory` / `config_*`；
      确认模型在 persona 禁止后不调用。
- [ ] `recon` / `review` 子会话的第一条任务消息以 `===== ROLE-TEMPLATE:SCOUT:BEGIN =====` 开头且模板完整；
      `scribe` 以 `===== ROLE-TEMPLATE:SCRIBE:BEGIN =====` 开头。**这是最关键的一项**。
- [ ] 子会话实际工具清单出现 Shell / 搜索 / 写文件 / 委派（证明 `agentPreset: standard` 生效），
      同时确认模板禁止后模型不越界。出现这些工具是预期的，不是 bug。
- [ ] `standard` persona / 项目 `AGENTS.md` / 技能目录存在时：`recon` / `review` 仍只读、不跑 Shell、不再委派；
      `scribe` 只写指定规划文档；更高优先级指令要求越界时停止并报告冲突，不擅自执行。
- [ ] `agentOptions` 与 `dsh-subagent-model-pin`（`honorExplicit: false`）并存时，子会话实际路由仍为
      `dsh-opencode-go / deepseek-v4.1-flash`。
- [ ] profile 缺少该 provider/model 时，委派在创建子代理时失败（而非静默继承贵模型）。
- [ ] `maxDepth: 1` 在子代理尝试再委派时按预期阻止下钻。
- [ ] `scribe` 在 workspace-write 沙箱下对项目目录的写入是否被允许，越界时错误是否可读。
- [ ] 规划/复核行为：`recon` 是否先读后判、`review` 是否给出位置 + 证据 + 可验收的修复要求、
      `scribe` 回执是否给出绝对路径与字节数。
- [ ] 插件管理页是否显示本包一行，且详细文档来自本文件（`meta.detail`）。

## 七、静态验证

`node scripts/verify-presets.mjs`：声明层合同 + `node --check` + `import`/`apply()` smoke + 负向变异
（21 个数据层变异 + 4 项真实文件自检，含 5 个“关键词还在、语义被改坏”的模板边界变异）。
2026-11-14 迁移后复跑 **PASS**：195 通过 / 0 失败，`node --check` 与 `import`/`apply()` smoke 通过，
负向变异 25/25 检出。关键模板边界用精确整句、编号规则与邻近语境断言，不是关键词出现即通过；但它仍只覆盖
**声明、文档与脚本自检**，不能证明“全部关键合同”在运行期被遵守，也不能证明模板一定被逐字附带。模板是否被真实附带、
standard 子代理实际有哪些工具，必须按 README「验证」的手工清单逐条确认。
