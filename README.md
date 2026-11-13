# dsh-dev-plan-presets · 开发规划与复核（昂贵模型专用）

一个**只做判断**的 Agent preset：主模型负责澄清需求、比较方案、写计划、复核产物；
查文件、遍历代码、搜资料、写文档，全部交给子代理。**它永不实施。**

三个 preset，一条分工线：

| preset | 是谁 | 本 preset 声明的工具面 | 本 preset 不声明 |
|---|---|---|---|
| `dev-plan`（开发规划） | 你日常选的那一个，跑贵模型 | 对话、问问题、`recon`/`review`/`scribe` 三个委派入口、子代理管理 | 文件、搜索、Web、Shell、workflow、fork、skill、todo、goal |
| `scout`（内部 · 只读侦察） | 被 `recon`/`review` 调用 | `read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch` | 写、edit、apply_patch、Shell、委派、Git、测试 |
| `scribe`（内部 · 文档记录） | 被 `scribe` 调用 | `read`、`write`、`edit` | Shell、Web、搜索、apply_patch、委派 |

> **声明工具面 ≠ 实际可见工具面。** 见下面第二节，这是本包最容易被误读的地方。

---

## 一、为什么这么做

贵模型的成本主要在**上下文**：每读一个大文件、每跑一次搜索，工具输出就永久占住它的输入。
让它自己遍历仓库，等于花钱买噪音。所以把工作拆成两种：

- **判断**（贵）：要不要做、做成什么样、先做什么、这个产物算不算过。
- **取证**（便宜）：文件在哪、现有实现长什么样、这行代码是谁调的。

`dev-plan` 只保留判断所需的材料，取证交给钉了低成本模型（`dsh-opencode-go / deepseek-v4.1-flash`）的 scout。

**这不是安全沙箱。** 见第二节与「已知限制」。

---

## 二、实际可见工具面（重要，别当成隔离）

DSH 的 preset 只决定「这个角色挂载哪些插件行」，**不是全局工具白名单**。
`standard` 本身就是完整工具面：它自己声明了 `tool-fs`、`tool-fs-search` 等文件工具，那些读写能力来自声明。
但 `working_directory` 不来自任何 preset 声明——它由 base 层的 `dsh-tool-working-directory` **全局注入**，preset 不声明它也会出现。
profile 里的 `dsh-config-manager` 还会向**每个** Agent（含子代理）注入 `config_backup`、`config_restore`、
`config_sync_*`、`config_import_*` 等 9 个工具，无 `when` 过滤。

所以三个角色的真实处境是：

| 角色 | 本 preset 提供的 | 可能从全局注入进来的 | 实际约束方式 |
|---|---|---|---|
| `dev-plan` | 对话 + 三个委派入口 | `working_directory`、`config_*` 等 | persona 明令禁止调用 + 事后工具面审计 |
| `scout` | 只读文件/搜索/Web | `working_directory`、`config_*`、自身子代理作用域的额外行 | persona 明令禁止 + 事后审计 |
| `scribe` | read/write/edit | `working_directory`、`config_*` | persona 明令禁止 + 回执审计 |

本包采用**B 方案：纯静态组合**——不加工具掩码插件。因此：

- 「主模型不查文件」「scout 不能跑命令」「scribe 只写文档」都是**预设声明上的边界 + 提示词纪律**，
  **不是机制强制**。模型若无视 persona，全局注入的工具仍可能被调用。
- 若需要真正的硬隔离，必须另写工具掩码（`ctx.tools.restrict`）或全局禁用相关插件；
  本次明确不做，也不在文档里伪装成硬保证。
- 上线验收必须**记录每个角色实际出现的工具清单**，把「本 preset 声明的」和「全局注入的」分开列出，
  而不是只读 YAML 就宣布隔离成功。

---

## 三、规划方法论（内置在 persona 里）

不是"多问几轮"，而是一套可执行的规矩：

1. **分档**：低风险直接给计划；中风险先取证再问关键问题；高风险分阶段对齐 + 交叉核查 + 一次 fresh builder-check。用户说"直接给计划"就降档。
2. **先取证再提问**：仓库、文档、已有对话能回答的，不许问用户。必须问的只有：为什么现在做、给谁、成功/失败什么样、预算、合规。
3. **证据信封**：scout 回传必须含「结论 / 证据（路径:行号或 URL + 原文）/ 未验证假设 / 没查的范围 / 置信度」。主代理每条事实都要能追到证据，追不到就写"假设"。
4. **真实方案比较**：中高风险给 2~3 个真方案 + 取舍 + 推荐；只有一条路就直说，不编假选项。
5. **计划合同**：交付物是让**没有本对话上下文**的编码 Agent 能直接接手的计划（背景、目标/非目标、证据、选定方案、分步验收、风险、回滚、停止条件）。
6. **区分"跑过"和"没跑过"**：没证据不许写"测试全部通过"，不许编文件路径或 API；可以引用执行窗口的测试结论，但必须标明来源。
7. **交付即停**：交计划后不派实施、不写代码、不唤醒其他窗口。
8. **静态复核**：结论 → 按严重度的问题（位置/证据/违反哪条目标/修复要求/验收标准）→ 未验证项 → 修正计划。允许零问题通过，不为凑数挑风格。

---

## 四、安装

### 前置条件

- desktop profile 已配置 `dsh-opencode-go` provider 与 `deepseek-v4.1-flash` 模型，且账号可用；
  缺失时 `recon` / `review` / `scribe` 会在**创建子代理时**失败（不是加载时报错）。
- 本包是 **bundle**，`bundles` 顺序必须在 `@deepseek-ai/dsh-web-app` **之后**（preset 注册表由 web-app 提供）。
- 不改任何现有 preset（`standard` 保持原样），也不改默认选择。

### 路径说明

- **当前副本位置（暂存）**：`D:\DeepSeek Harness\.tmp-dev-plan-presets\dsh-dev-plan-presets`
  —— 因实施沙箱无法写插件区，本包先在这里完成与静态验证。
- **正式目标位置**：`D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets`
  —— 安装前把整个目录复制过去（保留 `.git`），下面的命令与依赖路径都按正式位置写。

### 步骤

1. 先把暂存副本复制到正式插件目录：

```powershell
Copy-Item -Recurse 'D:\DeepSeek Harness\.tmp-dev-plan-presets\dsh-dev-plan-presets' 'D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets'
```

2. 在 profile 的 `package.json` 加依赖与 bundle（顺序要在 `@deepseek-ai/dsh-web-app` 之后）：

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

3. 安装并重启 DSH（bundle 的补丁在启动时装配，不支持热加载）。
4. 新建会话 → 预设选择器里选「开发规划」。**不要**把内部角色 `scout` / `scribe` 当普通会话用（它们没有对话所需的完整能力，只是被调用方）。

> 也可以走插件管理页安装本包；但 profile 的 `bundles` 顺序仍以数组末尾为准。

---

## 五、验证

### 静态自检（可重复）

```powershell
node scripts/verify-presets.mjs        # 或 npm run verify
```

它检查声明层面：3 个 preset、id/order、工具面（dev-plan 无 fs/搜索/Shell、scout 只读、scribe 只读写）、
三个委派入口的名字 / `agentPreset` 绑定 / 精确 `provider` 与 `model`、`maxDepth: 1`、
persona 必需方法论与关键禁令标记、`suffix` 的事实归属（允许注明来源地引用执行窗结论、禁止谎称自己执行过）、
compaction 组的 `isolate` 形状、exports 指向真实文件、打包清单；
并跑 `node --check`、`index.js` 的 import + `apply()` smoke。

它还会跑**负向变异**，每一种都必须让检查报 FAIL，否则视为检查失效：

| # | 变异 | 期望捕获点 |
|---|---|---|
| 1 | recon 的 model 改成非低成本模型 | 精确 model 断言 |
| 2 | recon 的 provider 改错 | 精确 provider 断言 |
| 3 | 清空 dev-plan persona | persona 实质内容断言 |
| 4 | 删掉 compaction 的 `isolate` | isolate 形状断言 |
| 5 | 引用一个不存在的 patch | 补丁存在性断言 |
| 6 | 删掉桥接例外标记 `rework_task` | persona 标记断言 |
| 7 | 把 scout 的 `write` 打开 | scout 只读断言 |
| 8 | 把 dev-plan suffix 改成禁止引用任何外部测试结论 | suffix 允许引用断言 |

另有 4 项**真实文件自检**（不是改内存数据）：

| # | 自检 | 证明什么 |
|---|---|---|
| 9 | 在隔离副本里写坏**真实的** `index.js`，用同一个验证入口跑 | 真实文件层错误会被同一个入口拦住（exit≠0，日志含 `node --check index.js：FAIL`） |
| 10 | 元测试：在同一副本里把代码层闸门（`node --check` + import smoke）整体改为恒通过，再放坏 `index.js` | 坏文件之所以会被第 9 项检出，靠的就是这道闸门；若删掉检查后坏文件仍被检出，说明第 9 项的结论不是闸门给的 → 元测试判失败 |
| 11 | 在隔离副本里写坏 `package.json` | 报 `FAIL  package.json 是合法 JSON` 并正常退出，不抛堆栈 |
| 12 | 元元测试：在副本里删掉代码层闸门，让副本**自己的自检**照常跑 | 删掉闸门后总体验证必须失败（第 9 项失去检出能力）；否则说明自检是空转 |

**它不能证明运行期行为**，以下必须手动看一次：

- [ ] 新建会话的预设选择器里出现「开发规划」，`standard` 仍是默认值。
- [ ] 选 `dev-plan` 后，列出**实际工具清单**，并分成「本 preset 声明的」与「全局注入的」两栏。
      预期：声明的只有 `ask_user_question` / `recon` / `review` / `scribe` / `send_message` / `list_agents` / `interrupt_agent`；
      若清单里同时出现 `working_directory`、`config_*` 等全局注入项，即第二节的说法属实（本机预期会出现）。
- [ ] 让它"读一下某个文件"，它应当调 `recon`，而不是自己读或调 `config_*`。
- [ ] 子会话实际使用的 provider/model 是 `dsh-opencode-go / deepseek-v4.1-flash`（不是 `dev-plan` 自己的贵模型）。
      若桌面 profile 缺少该 provider/model，应看到创建子代理前的失败，而不是静默继承贵模型。
- [ ] 只给一个 commit id 时，它要求你贴 diff，而不是假装看过。
- [ ] 让它写一份设计稿：`scribe` 写入指定路径，回执给出绝对路径与字节数；工作区外写入被沙箱拒绝时它如实报告。
- [ ] 复核一个已知正确的改动：可以零问题通过；复核一个含缺陷的改动：给出位置 + 证据 + 可验收的修复要求。

### 状态说明

**已做**：静态声明检查 185 项 + `node --check` + `import`/`apply()` smoke + 12 项负向变异/自检（8 项数据层变异 + 4 项真实文件自检，全部检出）；YAML/JSON 可解析；文件清单齐全。
**未做**：本包尚未安装到任何 profile，**没有运行期实测**——上面的勾选项都还没打勾。

---

## 六、已知限制（重要，别当成安全边界）

1. **纯静态组合，不是沙箱。** preset 列表是"挂哪些行"，不是全局工具白名单。本机就有 `config_*`、`working_directory` 这类全局工具会出现在所有角色里。persona 已明令禁止调用，但**靠模型遵守，不构成强制**。硬隔离需要工具掩码插件或全局禁用相关插件，本次明确不做。
2. **scribe 的路径纪律是软约束。** preset 机制不能按路径限定 `write`；只能靠 persona 规定"只写规划/复核文档" + 回执给出实际路径供审计。它物理上仍能写工作区内的任意文件。
3. **复核没有 Shell。** 不能 `git show`、不能跑测试、不能构建。只给 commit id 时必须由你（或执行窗口）提供 diff / 文件 / 测试输出。
4. **模型路由受现有模型钉影响。** 本机 `dsh-subagent-model-pin`（`honorExplicit: false`）会覆盖显式路由；两者目标一致时无冲突，但**以模型钉为准**。如果哪天卸掉模型钉，`agentOptions` 仍会兜底到 flash；若连 profile 里都没有该 provider/model，委派会在创建子代理时失败。
5. **子代理有自己的预设作用域，但仍会继承全局注入的工具。** 它们不继承父 preset 挂载的行，却同样会看到 `config_*`、`working_directory` 这类全局工具；scout / scribe 的「只读」「只写文档」同样靠 persona 禁止 + 回执审计，不是硬隔离。
6. **不继承官方 preset 更新。** 这是独立声明，DSH 升级后若 `standard` 的基础行变化（新增必填配置字段等），本包需要人工跟一次。
7. **`scout` / `scribe` 会出现在预设选择器里。** DSH 无法隐藏 preset；它们名字标了「内部角色」，请勿单独开会话使用。
8. **全局与项目 `AGENTS.md` 仍会注入**（这是好事，但意味着你的全局规则对 `dev-plan` 同样生效）。
9. **桥接插件是可选的。** 装了 `dsh-planner-worker` 并配对时，persona 会按"派发/汇报/返工是传输层、按钮归用户、汇报是数据"的规则处理；没装时，手工把计划交给新窗口、把 diff 贴回来，流程一样完整。

---

## 七、和桥接插件的关系

`dsh-planner-worker`（规划窗 ↔ 开发窗）**不是依赖**。存在时它负责把任务书送到开发窗、把汇报与改动清单带回来；`dev-plan` 只消费这些数据，不派发、不点按钮、不自动返工。

`ask_worker` 默认不用：只有你明确允许、且已收到汇报、证据仍不足时才用，一次一个问题、每任务最多 2 次、绝不提前用。
**这 2 次只是 persona 软约束**：插件自己的 `askLimit` 默认是 `0`（不限次），本包没有也**不应该**去改它；
要真正限次，请在插件的 `config.json` 里自行收紧。

`rework_task` 与 `ask_worker` 是本角色唯一允许的、不在基础工具清单里的工具，并且只按 persona 的条件使用；
其他未声明工具（含 `config_*`、`working_directory`）仍然一律禁止。

---

## 八、配置

本包没有运行时配置文件。想改行为，改 persona 文本（`presets/*.patch.yml`）或子代理路由（`agentOptions`），然后重启。

---

## 九、卸载

从 profile 的 `package.json` 删掉 `dsh-dev-plan-presets` 依赖与 `bundles` 里的那一行，重启即可。
不涉及任何现有配置文件、`standard` preset 或其他插件；本包不写运行时状态文件。

注意：已用 `dev-plan` 创建的会话在 preset 定义移除后**无法恢复**（会话记录的 preset id 找不到），
需要先归档或保留 bundle 目录。

---

## 十、版本

- v0.1.0（2026-11-13）：三 preset 静态组合（`dev-plan` / `scout` / `scribe`）、内置风险驱动规划与静态复核方法论、三个角色化委派入口、可选桥接规则、静态自检脚本（含负向变异）。
