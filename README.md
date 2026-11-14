# dsh-dev-plan-presets · 开发规划与复核（昂贵模型专用）

一个**只做判断**的 Agent preset：主模型负责澄清需求、比较方案、写计划、复核产物；
查文件、遍历代码、搜资料、写文档，全部交给子代理。**它永不实施。**

当前只注册 **1 个 preset**：`dev-plan`（开发规划）。原来的两个内部角色不再是独立 preset，
改成两段固定**角色模板**，由 `dev-plan` 在每次派遣时逐字附在子代理 prompt 开头。

> 本包只注册 dev-plan 这一个 preset；内部角色的能力边界改由派遣模板承载。

| 入口 | 实际绑定 | 角色约束来自哪里 |
|---|---|---|
| `dev-plan`（开发规划） | 唯一注册的 preset，跑贵模型 | persona（本包声明） |
| `recon` / `review` | `tool-subagent` → `agentPreset: standard` | 派遣 prompt 开头的「侦察/复核角色模板」 |
| `scribe` | `tool-subagent` → `agentPreset: standard` | 派遣 prompt 开头的「文书角色模板」 |

> **一句话边界：** `standard` 子代理拥有完整工具面（含 Shell、搜索、写文件、委派）；
> 模板里的“只读”“只写文档”是**任务级提示词约束**，不是声明级工具隔离，也不是安全沙箱。
> 详见第二节与「已知限制」。

---

## 一、为什么是现在这个形态：方案 A / 方案 B 的取舍

最初（v0.1.0）是方案 A：注册 `dev-plan` / `scout` / `scribe` 三个 preset，靠“每个 preset 声明自己的工具行”
来实现声明级隔离——`scout` 只声明读/搜索/Web，`scribe` 只声明 read/write/edit。

方案 A 的问题：

- 预设选择器里多出两个“内部角色”，容易被当成普通会话打开；
- 角色定义分散在三份 patch 里，`standard` 升级时要逐份跟；
- 用户真正想要的只是一个入口：「开发规划」。

方案 B（用户明确选择，当前实现）：

- **只注册 `dev-plan`**，删除 `scout` / `scribe` 的 patch、exports、`files`、`dsh.bundle.patch` 与 `index.js` 注册路径；
- 两个角色的职责、证据合同、禁止事项、输出格式原样搬进 `dev-plan` 的 persona，成为两段带稳定标记的固定模板；
- 三个委派实例统一 `agentPreset: standard`，保留 `toolName`、`provider: spawn`、`maxDepth: 1`、
  `modelSelection: false`、`modelDiscovery: false` 与显式 `dsh-opencode-go / deepseek-v4.1-flash` 路由；
- 主代理工具面不变：仍然只有 `ask_user_question` / `recon` / `review` / `scribe` / `send_message` /
  `list_agents` / `interrupt_agent`，不增加 fs / 搜索 / Web / Shell。

**取舍（用户已知并接受）：** 用“声明级工具隔离”换“入口干净 + 角色定义集中”。
代价是 `standard` 的 Shell、搜索、写文件、委派能力对三个子代理都真实可用；只读/限定写入降为
**提示词约束**，靠子代理遵守 + 事后审计。这不是等价迁移，也不是安全边界。
`maxDepth: 1`、显式低成本路由、模型钉兼容这些**机制**约束仍然保留。

为什么不用别的做法：`tool-subagent` 的实例配置**不支持 `persona` / `toolFilter`**
（DSH 文档明确写了“包含 `persona` 或 `toolFilter` 的工具配置在加载时会报迁移错误”），
所以“给每个实例单独配人设”这条路当前不存在；要恢复声明级隔离只能保留方案 A 的独立 preset，
或者改核心/加新插件——两者都被明确排除。

---

## 二、实际可见工具面（重要，别当成隔离）

DSH 的 preset 只决定「这个角色挂载哪些插件行」，**不是全局工具白名单**。
`standard` 本身就是完整工具面：它自己声明了 `tool-bash` / `tool-pwsh` / `tool-fs` / `tool-fs-search` /
`tool-jobs` / `tool-schedule` / `tool-skill` / `tool-goal` / `tool-web` / 委派与 workflow 等行。
实际能力以运行期组合为准（profile 可能禁用某些行或再追加插件），但方向是：这些能力对三个子代理都真实存在。
此外 `working_directory` 由 base 层全局注入，profile 里的 `dsh-config-manager` 还会向**每个** Agent
（含子代理）注入 `config_backup`、`config_restore`、`config_sync_*`、`config_import_*` 等 9 个工具。

所以三个角色的真实处境是：

| 角色 | 本包声明的 | 实际还能看到 | 约束方式 |
|---|---|---|---|
| `dev-plan` | 对话 + 三个委派入口 + 子代理管理 | `working_directory`、`config_*` 等全局注入 | persona 明令禁止 + 事后工具面审计 |
| `recon` / `review` | 只声明了“委派到 standard” | **standard 的完整工具面** + 全局注入 | 任务模板禁止越界 + 事后审计 |
| `scribe` | 只声明了“委派到 standard” | **standard 的完整工具面** + 全局注入 | 任务模板禁止越界 + 回执审计 |

本包仍然是**B 方案：纯静态组合**——不加工具掩码插件。因此：

- `scout` 只读、`scribe` 限定读写**不再是独立 preset 的声明级工具隔离**，而是任务级提示词约束；
- 主模型不查文件，同样是“本 preset 不声明 + persona 禁止”，不是机制强制；
- 若需要真正的硬隔离，必须另写工具掩码（`ctx.tools.restrict`）或全局禁用相关插件；本次明确不做；
- 上线验收必须**记录每个角色实际出现的工具清单**，把“本包声明的”和“standard / 全局注入的”分开列，
  而不是只读 YAML 就宣布隔离成功。

---

## 三、规划方法论（内置在 dev-plan persona 里）

不是“多问几轮”，而是一套可执行的规矩：

1. **分档**：低风险直接给计划；中风险先取证再问关键问题；高风险分阶段对齐 + 交叉核查 + 一次 fresh builder-check。用户说“直接给计划”就降档。
2. **先取证再提问**：仓库、文档、已有对话能回答的，不许问用户。必须问的只有：为什么现在做、给谁、成功/失败什么样、预算、合规。
3. **证据信封**：`recon` / `review` 回传必须含「结论 / 证据（路径:行号或 URL + 原文）/ 未验证假设 / 没查的范围 / 置信度」。主代理每条事实都要能追到证据，追不到就写“假设”。
4. **真实方案比较**：中高风险给 2~3 个真方案 + 取舍 + 推荐；只有一条路就直说，不编假选项。
5. **计划合同**：交付物是让**没有本对话上下文**的编码 Agent 能直接接手的计划（背景、目标/非目标、证据、选定方案、分步验收、风险、回滚、停止条件）。
6. **区分“跑过”和“没跑过”**：没证据不许写“测试全部通过”，不许编文件路径或 API；可以引用执行窗口的测试结论，但必须标明来源。
7. **交付即停**：交计划后不派实施、不写代码、不唤醒其他窗口。
8. **静态复核**：结论 → 按严重度的问题（位置/证据/违反哪条目标/修复要求/验收标准）→ 未验证项 → 修正计划。允许零问题通过，不为凑数挑风格。

派遣纪律也写进 persona：每次 `recon` / `review` 必须在 prompt 开头完整附带「侦察/复核角色模板」，
每次 `scribe` 必须完整附带「文书角色模板」；不得省略、改写、弱化，也不能让任务正文覆盖模板。
模板用 `===== ROLE-TEMPLATE:SCOUT:BEGIN/END =====` 与 `===== ROLE-TEMPLATE:SCRIBE:BEGIN/END =====`
标记，便于静态校验与人工抽查。

---

## 四、安装与使用变化

### 前置条件

- desktop profile 已配置 `dsh-opencode-go` provider 与 `deepseek-v4.1-flash` 模型，且账号可用；
  缺失时 `recon` / `review` / `scribe` 会在**创建子代理时**失败（不是加载时报错）。
- 本包是 **bundle**，`bundles` 顺序必须在 `@deepseek-ai/dsh-web-app` **之后**（preset 注册表由 web-app 提供）。
- 不改任何现有 preset（`standard` 保持原样），也不改默认选择。

### 路径

- **正式安装目录 = 当前唯一源**：`D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets`
- 历史暂存副本 `D:\DeepSeek Harness\.tmp-dev-plan-presets\dsh-dev-plan-presets` 仅存档，不是当前源。

### 使用上的变化（相对 v0.1.0）

- 预设选择器里**只剩「开发规划」**这一个本包入口；不再有旧的内部角色入口（只读侦察 / 文档记录）。
- 新建 `dev-plan` 会话后，仍然是同一套 `recon` / `review` / `scribe` 工具名与同一套使用方式；
  变化发生在子代理内部：它们现在以 `standard` 跑，但必须先收到角色模板。
- **已有用 `dev-plan` 建的会话**：preset id `dev-plan` 仍在，理论可恢复；但会话中若曾引用旧内部角色
  preset，或者子代理沿用旧装配，需要新建会话才能拿到新模板行为。
- **已有用 `scout` / `scribe` 当会话 preset 的旧会话**：这两个 id 已不存在，**无法恢复**；
  需要保留 bundle 历史版本或先归档会话。
- 包版本从 `0.1.0` 升到 `0.2.0`（破坏性迁移）。安装状态要分层看，别混为一谈：
  - **上次安装操作记录**：`0.1.0 / applied`（旧 `pnpm.log` 里的事实，只说明上一次操作，不代表当前磁盘状态）；
  - **本次重装 no-op**：对同一 link target 再跑 `install_bundle` 返回 `changed=false`、`application=failed`、
    `error.code=already-installed`。这是 **no-op**，不是功能失败，也未改配置；确认实际 apply 的是随后的重挂操作。
  - **本次热应用记录**：`set_bundle` 先 `enabled=false` 再 `enabled=true`，两次都是 `changed=true`、
    `application=applied`、`warnings=[]`，说明禁用/启用重挂已真实热应用成功，本次变更不需要强制重启；
  - **插件管理器 live listing**：热应用后精确读为 `dsh-dev-plan-presets 0.2.0`、`enabled/installed=true`、
    `source=link:D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets`，rows 只有 `dev-plan-presets` + `preset-dev-plan`，
    没有旧 `scout` / `scribe` 的注册行。这证明**插件组合与声明行已热应用**；
  - **运行期行为**：新建会话 GUI 选择器与实际派遣行为仍需用户手动验收（见第五节清单）。`list_bundles`
    的行列表本身不能当作重装配证据——本次的装配证据是 `set_bundle` 的 `changed=true/application=applied`。
  安装历史 `0.1.0 / applied` 与上述 no-op 说明保留，用于区分“上次安装操作”与“本次热应用”。

### 让改动生效

- 当前 profile 依赖是 `link:D:/ai工作区/技术专家/plugins/dsh-dev-plan-presets`，所以磁盘文件已经变了；
- bundle 补丁（`dsh.bundle.patch` 从 4 个减到 2 个）与 preset 注册表是在装配时读的，需要一次真实 apply 才会刷新；
- 本次已通过插件管理器 `set_bundle` 的禁用/启用完成重挂：两次 `application=applied`、`warnings=[]`，随后 live
  listing 为 `0.2.0` 且 rows 只剩 `dev-plan-presets` + `preset-dev-plan`，因此**本次变更无需为了装配而强制重启**。
  装配证据要用 `set_bundle` 的 `application=applied`（或装配日志），不能只看 `list_bundles` 的行列表。
- 仍然要**新建会话**才能验证选择器与实际派遣；在用户手工验收前，旧会话里看到的旧形态不能拿来做验收结论。

### 步骤（迁移重装时参考；正式目录已就绪，不要重复覆盖）

1. 在 profile 的 `package.json` 加依赖与 bundle（顺序在 `@deepseek-ai/dsh-web-app` 之后）：

```json
{
  "dependencies": {
    "dsh-dev-plan-presets": "link:D:/ai工作区/技术专家/plugins/dsh-dev-plan-presets"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "...其他现有 bundle...",
        "dsh-dev-plan-presets"
      ]
    }
  }
}
```

2. 安装 / 重装配：优先走插件管理器（可热应用）；手工改 profile 时，bundle 补丁在启动时装配，需要重启。
3. **新建会话** → 预设选择器里选「开发规划」。本包不再提供可单独打开的内部角色会话。

---

## 五、验证

### 静态自检（可重复）

```powershell
node scripts/verify-presets.mjs        # 或 npm run verify
```

它检查：

- **只注册 1 个 preset（dev-plan）**；`scout` / `scribe` 的文件、exports、`files`、`bundle.patch`、
  `index.js` 引用、注册行全部不存在；`presets/` 目录只剩 `dev-plan.patch.yml`；
- 三个委派实例都是 `agentPreset: standard`，且 `provider` / `model` / `maxDepth` / `modelSelection` /
  `modelDiscovery` 未被改动，`allowedAgentPresets` 仍不设；
- 主代理工具面没有 fs / 搜索 / Web / Shell，仍挂载对话、ask-user、subagent-control；
- 两个角色模板存在、带稳定标记；关键允许/禁止边界用**精确整句、编号规则与邻近语境**断言，不是关键词出现即通过：
  侦察模板的允许工具清单解析成集合后必须恰好是六项、只读定位必须是原句；文书模板按编号断言规则 3（限定文档写入）、
  规则 5（禁 Shell/Web/搜索/委派）、规则 6（禁 `config_*`/`working_directory`），并要求规则数恰好 6 条；
- 派遣指令分别绑定 `recon`/`review` 与 `scribe`，并要求逐字附带、不得省略/改写、冲突以模板为准；
- 两段模板与派遣纪律都要求：不得因 `standard` 的工具、persona、项目 `AGENTS.md` 或技能目录出现更多能力而扩大角色边界；
  更高优先级指令与角色边界冲突时停止相关动作并向主代理报告，不擅自越界；
- 文档没有“已注册三 preset / 内部角色 preset / 声明级只读隔离”等陈旧说法；
- 安装状态文档区分“上次安装操作记录 0.1.0/applied”“管理器 live listing 0.2.0”“运行期组合待验证”，
  且不把 `list_bundles` 当重装配证据；
- 打包层：exports 指向真实文件且不再暴露 scout/scribe、`dsh.bundle.patch` 是 2 个补丁、`files` 覆盖；
- 生产断言读取的是实际 `presets/dev-plan.patch.yml`（行带来源标记），不是测试夹具；
- `node --check index.js` 与 `import` + `apply()` smoke。

这些断言能抓住“关键词还在、语义已被改坏”的常见变异，但它们仍然是**静态文本检查**：既不能证明“全部关键合同”
在运行期被遵守，也不能证明主代理一定逐字附带模板。后两者只能靠子会话抽查。

它还会跑**负向变异**，每一种都必须让检查报 FAIL，否则视为检查失效：

| # | 变异 | 期望捕获点 |
|---|---|---|
| 1 | recon 的 model 改成非低成本模型 | 精确 model 断言 |
| 2 | recon 的 provider 改错 | 精确 provider 断言 |
| 3 | agentPreset 改回 `scout` | `agentPreset=standard` 断言 |
| 4 | `maxDepth` 放宽到 2 | `maxDepth=1` 断言 |
| 5 | 清空 dev-plan persona | persona 实质内容断言 |
| 6 | 整段删除侦察/复核模板 | 模板存在且完整断言 |
| 7 | 整段删除文书模板 | 模板存在且完整断言 |
| 8 | 删除“recon/review 附带模板”的绑定行 | 派遣绑定断言 |
| 9 | 把 fs 工具行加回主代理 | 主代理工具面断言 |
| 10 | 重新注册 scout preset | “只注册 1 个 preset”断言 |
| 11 | 复活已删除的 scout 补丁文件 | 已删除文件不存在断言 |
| 12 | 删掉 compaction 的 `isolate` | isolate 形状断言 |
| 13 | 引用一个不存在的 patch | 补丁存在性断言 |
| 14 | 删掉桥接例外标记 `rework_task` | persona 标记断言 |
| 15 | 把 dev-plan suffix 改成禁止引用任何外部测试结论 | suffix 允许引用断言 |
| 16 | README 恢复“已注册 scout/scribe preset”的陈旧说法 | 文档陈旧说法断言 |
| 17 | 侦察模板把“只读侦察”改成“可写侦察” | 只读定位精确句断言 |
| 18 | 侦察允许清单追加 `write` | 允许工具集合恰好六项断言（集合解析，不是关键词） |
| 19 | 删除文书模板“不使用 Shell/Web/搜索/委派”规则 | 文书规则 5 精确断言 |
| 20 | 删除文书模板“禁止 `config_*`/`working_directory`”规则 | 文书规则 6 精确断言 |
| 21 | 文书模板把“只写规划/复核文档”改成“可写任意文件” | 文书规则 3 限定文档写入断言 + “任意文件”负向断言 |

另有 4 项**真实文件自检**（不是改内存数据）：

| # | 自检 | 证明什么 |
|---|---|---|
| 22 | 在隔离副本里写坏**真实的** `index.js`，用同一个验证入口跑 | 真实文件层错误会被同一个入口拦住（exit≠0，日志含 `node --check index.js：FAIL`） |
| 23 | 元测试：在同一副本里把代码层闸门（`node --check` + import smoke）整体改为恒通过，再放坏 `index.js` | 坏文件之所以会被第 22 项检出，靠的就是这道闸门；删掉检查后坏文件仍被检出，说明第 22 项的结论不是闸门给的 → 元测试判失败 |
| 24 | 在隔离副本里写坏 `package.json` | 报 `FAIL  package.json 是合法 JSON` 并正常退出，不抛堆栈 |
| 25 | 元元测试：在副本里删掉代码层闸门，让副本**自己的自检**照常跑 | 删掉闸门后总体验证必须失败（第 22 项失去检出能力）；否则说明自检是空转 |

### 本次迁移后的静态验证记录（2026-11-14，已实际执行）

| 项 | 结果 |
|---|---|
| `node scripts/verify-presets.mjs` | **PASS**：195 通过 / 0 失败 |
| `node --check index.js` | **PASS** |
| `import` + `apply()` smoke | **PASS**（无告警） |
| 负向变异 / 真实文件自检 | **25/25 检出**（21 数据层 + 4 真实文件） |
| 独立定向复核（生产副本复跑） | **PASS**：195/0、25/25；5 个语义变异全部复现为失败 |
| `git diff --check` | **PASS**（无空白错误） |
| 版本 / 打包 | `0.2.0`；`dsh.bundle.patch` 2 项；`presets/` 仅 `dev-plan.patch.yml` |

### 仍需运行期验收（尚未执行，不得写成已通过）

**静态自检不能证明运行期行为**，也不能证明主代理真的逐字附了模板。以下必须在**重新装配后的新建会话**里手动看：

- [ ] 预设选择器里只有「开发规划」这一个本包入口（`standard` 仍是默认）；旧的内部角色不再出现。
- [ ] 选 `dev-plan` 后列出**实际工具清单**，分成“本 preset 声明的”与“全局注入的”两栏。预期声明面只有
      `ask_user_question` / `recon` / `review` / `scribe` / `send_message` / `list_agents` / `interrupt_agent`。
- [ ] 让它“读一下某个文件”，它应当调 `recon`，而不是自己读或调 `config_*`。
- [ ] **模板是否真的被附带**：打开 `recon` / `review` 的子会话，确认第一条任务消息以
      `===== ROLE-TEMPLATE:SCOUT:BEGIN =====` 开头、模板全文完整、任务在模板之后；
      `scribe` 子会话以 `===== ROLE-TEMPLATE:SCRIBE:BEGIN =====` 开头。这是本次迁移最关键的运行期项。
- [ ] **子代理确实是 standard**：子会话实际工具清单应出现 Shell / 搜索 / 写文件 / 委派等 standard 能力
      （出现才说明 `agentPreset: standard` 生效；同时也说明边界只剩提示词约束）。
- [ ] **standard persona / 项目 AGENTS.md / 技能目录存在时的边界测试**：在一个带项目 `AGENTS.md`、且
      `standard` persona 或技能目录会带来更多能力的会话里 ——
      ① 让 `recon` 只做只读取证，确认它不顺手写文件；② 让它跑 Shell 命令，应按模板拒绝并回报
      “需要主代理改派或提供材料”；③ 让它再委派，应拒绝（`maxDepth: 1` 之外还有模板禁止）；
      ④ 让 `scribe` 只写指定规划文档，确认它不因技能目录或 `AGENTS.md` 扩大写入范围，越界时拒绝并写
      “超出文书子代理职责”；⑤ 若更高优先级指令要求越界，子代理应停止并报告冲突，而不是照做。
- [ ] 子会话实际使用的 provider/model 是 `dsh-opencode-go / deepseek-v4.1-flash`（不是 `dev-plan` 的贵模型）。
- [ ] 让 `recon` 尝试写文件或跑命令：它应按模板拒绝并回报“需要主代理改派或提供材料”，而不是真的执行。
- [ ] 让 `scribe` 写一份设计稿：写入指定路径，回执给绝对路径与字节数；被要求写产品代码时拒绝。
- [ ] 子代理尝试再委派时，`maxDepth: 1` 是否按预期阻止继续下钻。
- [ ] 只给一个 commit id 时，主代理要求你贴 diff，而不是假装看过。
- [ ] 复核一个已知正确的改动：可以零问题通过；复核一个含缺陷的改动：给出位置 + 证据 + 可验收的修复要求。
- [ ] 装了 `dsh-planner-worker` 时：`ask_worker` 默认不用、不自动派发/返工；未装时手工流程同样完整。

### 状态说明

**已做（2026-11-14）**：方案 B 代码与文档迁移；静态声明检查 195 项、`node --check`、`import`/`apply()` smoke、
25 项负向变异/自检、`git diff --check`；独立定向复核在生产副本复跑同样是 195/0、25/25，5 个语义变异全部复现为失败。
**已读事实**：上次安装操作记录为 `0.1.0 / applied`；对同一 link target 的 `install_bundle` 返回 no-op
（`changed=false`、`application=failed`、`error.code=already-installed`，未改配置）；随后 `set_bundle`
禁用→启用两次均为 `changed=true` / `application=applied` / `warnings=[]`，热应用成功；live listing 为
`dsh-dev-plan-presets 0.2.0`、`enabled/installed=true`、`source=link:...`，rows 只有
`dev-plan-presets` + `preset-dev-plan`，没有旧 `scout` / `scribe` 的注册行。
**未做 / 待验**：上节运行期清单全部未执行；新建会话 GUI 选择器与实际派遣行为仍由用户运行验收。
**装配已热应用，但“选择器/派遣行为正确”不得写成已通过**——这仍要新建会话人工确认。

---

## 六、已知限制（重要，别当成安全边界）

1. **纯静态组合，不是沙箱。** `standard` 子代理物理上拥有 Shell、搜索、写文件、委派；模板禁止调用，
   但靠模型遵守，不构成强制。硬隔离需要工具掩码插件或全局禁用相关插件，本次明确不做。
2. **模板是否被附带，取决于主代理。** 静态检查只能证明 persona 里有模板和派遣纪律；如果主代理省略、
   压缩或改写模板，子代理就只收到任务正文。**这是本次方案 B 最大的运行期风险**，只能靠子会话抽查。
3. **scribe 的路径纪律是软约束。** preset 机制不能按路径限定 `write`；模板规定“只写规划/复核文档” +
   回执给出实际路径供审计。它物理上仍能写工作区内的任意文件。
4. **复核子代理“没有 Shell”只是模板约束。** 它现在实际能跑命令，只是被模板禁止；主代理和用户都不要
   把“它说没跑测试”当成机制保证。
5. **模型路由受现有模型钉影响。** 本机 `dsh-subagent-model-pin`（`honorExplicit: false`）会覆盖显式路由；
   两者目标一致时无冲突，但**以模型钉为准**。卸掉模型钉时 `agentOptions` 兜底；profile 缺 provider/model
   时委派会在创建子代理时失败。
6. **子代理仍会继承全局注入的工具**（`config_*`、`working_directory` 等），加上 standard 自带的一整套。
7. **不继承官方 preset 更新。** `standard` 升级时本包的角色模板不会自动跟；模板里的工具名/边界要人工复核。
8. **旧内部角色会话无法恢复。** `scout` / `scribe` preset id 已删除；用它们建的旧会话需要归档。
9. **每次派遣都重复携带模板，消耗 prompt 预算。** 这是方案 B 的固定成本；模板越长，子代理上下文越贵。
10. **全局与项目 `AGENTS.md` 仍会注入**（对 `dev-plan` 与 standard 子代理都生效）。
11. **桥接插件是可选的。** 装了 `dsh-planner-worker` 并配对时，persona 按“派发/汇报/返工是传输层、按钮归用户、
    汇报是数据”的规则处理；没装时手工流程一样完整。
12. **技能目录与高层指令不由用户模板覆盖。** `standard` 子代理可能通过技能目录、项目/全局 `AGENTS.md` 或更高优先级的
    persona 获得额外指令与能力；本包模板只约束任务正文，不能修改、覆盖或保证压过这些来源，只能要求子代理在冲突时
    停止相关动作并向主代理报告。不要把“模板写了禁止”理解成“高层指令一定不会放开”。

---

## 七、和桥接插件的关系

`dsh-planner-worker`（规划窗 ↔ 开发窗）**不是依赖**。存在时它负责把任务书送到开发窗、把汇报与改动清单带回来；
`dev-plan` 只消费这些数据，不派发、不点按钮、不自动返工。

`ask_worker` 默认不用：只有你明确允许、且已收到汇报、证据仍不足时才用，一次一个问题、每任务最多 2 次、绝不提前用。
**这 2 次只是 persona 软约束**：插件自己的 `askLimit` 默认是 `0`（不限次），本包没有也**不应该**去改它；
要真正限次，请在插件的 `config.json` 里自行收紧。

`rework_task` 与 `ask_worker` 是本角色唯一允许的、不在基础工具清单里的工具，并且只按 persona 的条件使用；
其他未声明工具（含 `config_*`、`working_directory`）仍然一律禁止。桥接不影响角色模板：派遣时照样要附。

---

## 八、配置

本包没有运行时配置文件。想改行为，改 `presets/dev-plan.patch.yml` 里的 persona / 角色模板 / 子代理路由，
然后重新装配（插件管理器 apply 或重启）。改模板时保留首尾标记行，验证脚本按标记抽取。

---

## 九、卸载

从 profile 的 `package.json` 删掉 `dsh-dev-plan-presets` 依赖与 `bundles` 里的那一行，重启即可。
不涉及任何现有配置文件、`standard` preset 或其他插件；本包不写运行时状态文件。

注意：已用 `dev-plan` 创建的会话在 preset 定义移除后**无法恢复**（会话记录的 preset id 找不到），
需要先归档或保留 bundle 目录。

---

## 十、版本

- v0.2.0（2026-11-14）：**方案 B 迁移**。只注册 `dev-plan`；删除 `scout` / `scribe` 的 patch、exports、
  `files`、`bundle.patch` 与注册路径；角色文字迁入 `dev-plan` persona，成为两段带稳定标记的派遣模板；
  三个委派实例 `agentPreset` 改为 `standard`，路由/深度/模型发现开关不变。静态验证 195 通过 / 0 失败，
  负向变异 25/25（含 5 个语义变异），独立定向复核结论一致。安装状态：上次操作记录 `0.1.0 / applied`；
  同 link 重装为 no-op（`already-installed`，未改配置）；随后禁用/启用重挂两次 `application=applied`，
  live listing 已读为 `0.2.0`、rows 只剩 `dev-plan-presets` + `preset-dev-plan`；运行期选择器与派遣行为
  仍待新建会话人工验收。
- v0.1.0（2026-11-13）：三 preset 静态组合（`dev-plan` / `scout` / `scribe`）、内置风险驱动规划与静态复核方法论、
  三个角色化委派入口、可选桥接规则、静态自检脚本（含负向变异）。
- 2026-11-14（安装记录，未改包版本）：正式目录经插件管理器安装到 desktop profile（`applied`，`0.1.0`，无 warnings）。
  这是**上次安装操作**的记录，不是当前磁盘版本；此后同 link 的 `install_bundle` 是 no-op（`already-installed`），
  实际生效来自随后的禁用/启用重挂，管理器 live listing 另行读为 `0.2.0`（见第四节）。
