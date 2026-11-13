# dsh-dev-plan-presets · 开发规划与复核（昂贵模型专用）

一个**只做判断**的 Agent preset：主模型负责澄清需求、比较方案、写计划、复核产物；
查文件、遍历代码、搜资料、写文档，全部交给子代理。**它永不实施。**

三个 preset，一条分工线：

| preset | 是谁 | 能碰什么 | 明令不能碰 |
|---|---|---|---|
| `dev-plan`（开发规划） | 你日常选的那一个，跑贵模型 | 对话、问问题、`recon`/`review`/`scribe` 三个委派入口 | 文件、搜索、Web、Shell、workflow、fork、skill、todo |
| `scout`（内部 · 只读侦察） | 被 `recon`/`review` 调用 | `read`、`read_image`、`glob`、`grep`、`web_search`、`web_fetch` | 写、edit、apply_patch、Shell、Git、测试 |
| `scribe`（内部 · 文档记录） | 被 `scribe` 调用 | `read`、`write`、`edit` | Shell、Web、搜索、apply_patch、继续委派 |

所以主模型**物理上**没有仓库工具——不是"被要求不要用"，而是那些工具根本没挂进它的 preset。

---

## 一、为什么这么做

贵模型的成本主要在**上下文**：每读一个大文件、每跑一次搜索，工具输出就永久占住它的输入。
让它自己遍历仓库，等于花钱买噪音。所以把工作拆成两种：

- **判断**（贵）：要不要做、做成什么样、先做什么、这个产物算不算过。
- **取证**（便宜）：文件在哪、现有实现长什么样、这行代码是谁调的。

`dev-plan` 只保留判断所需的材料，取证交给钉了低成本模型（`dsh-opencode-go / deepseek-v4.1-flash`）的 scout。

**这不是安全沙箱。** 见下面「已知限制」。

---

## 二、规划方法论（内置在 persona 里）

不是"多问几轮"，而是一套可执行的规矩：

1. **分档**：低风险直接给计划；中风险先取证再问关键问题；高风险分阶段对齐 + 交叉核查 + 一次 fresh builder-check。用户说"直接给计划"就降档。
2. **先取证再提问**：仓库、文档、已有对话能回答的，不许问用户。必须问的只有：为什么现在做、给谁、成功/失败什么样、预算、合规。
3. **证据信封**：scout 回传必须含「结论 / 证据（路径:行号或 URL + 原文）/ 未验证假设 / 没查的范围 / 置信度」。主代理每条事实都要能追到证据，追不到就写"假设"。
4. **真实方案比较**：中高风险给 2~3 个真方案 + 取舍 + 推荐；只有一条路就直说，不编假选项。
5. **计划合同**：交付物是让**没有本对话上下文**的编码 Agent 能直接接手的计划（背景、目标/非目标、证据、选定方案、分步验收、风险、回滚、停止条件）。
6. **区分"跑过"和"没跑过"**：没证据不许写"测试全部通过"，不许编文件路径或 API。
7. **交付即停**：交计划后不派实施、不写代码、不唤醒其他窗口。
8. **静态复核**：结论 → 按严重度的问题（位置/证据/违反哪条目标/修复要求/验收标准）→ 未验证项 → 修正计划。允许零问题通过，不为凑数挑风格。

---

## 三、安装

本包是 **bundle**，不改任何现有 preset（`standard` 保持原样），也不改默认选择。

1. 把本目录放进你的插件区（例如 `D:\ai工作区\技术专家\plugins\dsh-dev-plan-presets`）。
2. 在 profile 的 `package.json` 加依赖与 bundle（顺序要在 `@deepseek-ai/dsh-web-app` 之后，因为 preset 注册表由 web-app 提供）：

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

> 也可以走插件管理页安装本包；但 profile 的 `bundles` 顺序仍以阵列末尾为准。

---

## 四、验证

### 静态自检（可重复）

```powershell
node scripts/verify-presets.mjs        # 或 npm run verify
```

它检查声明层面：3 个 preset、id/order、工具面（dev-plan 无 fs/搜索/Shell、scout 只读、scribe 只读写）、
三个委派入口的名字与 `agentPreset` 绑定、`provider: spawn`、`maxDepth: 1`、显式模型路由、persona 不含未注册变量、打包清单覆盖补丁。

**它不能证明运行期行为**，以下必须手动看一次：

- [ ] 新建会话的预设选择器里出现「开发规划」，`standard` 仍是默认值。
- [ ] 选 `dev-plan` 后，实际工具清单里**没有** `read`/`glob`/`grep`/`write`/`edit`/`pwsh`/`web_search`。
- [ ] 让它"读一下某个文件"，它应当调 `recon`，而不是自己读。
- [ ] 子会话实际使用的 provider/model 是 `dsh-opencode-go / deepseek-v4.1-flash`（不是 `dev-plan` 自己的贵模型）。
- [ ] 只给一个 commit id 时，它要求你贴 diff，而不是假装看过。
- [ ] 让它写一份设计稿：`scribe` 写入指定路径，回执给出绝对路径与字节数；工作区外写入被沙箱拒绝时它如实报告。
- [ ] 复核一个已知正确的改动：可以零问题通过；复核一个含缺陷的改动：给出位置 + 证据 + 可验收的修复要求。

### 状态说明

**已做**：静态检查 144 项（`node scripts/verify-presets.mjs`，全部通过）；YAML/JSON 可解析；文件清单齐全。
**未做**：本包尚未安装到任何 profile，**没有运行期实测**——上面的勾选项都还没打勾。

---

## 五、已知限制（重要，别当成安全边界）

1. **纯静态组合，不是沙箱。** DSH 的 preset 列表是"挂哪些行"，不是全局工具白名单。其他插件仍可能向主代理注入工具（本机就有 `config_backup`/`config_restore` 这类全局工具）。persona 已明令禁止调用未声明工具，但这靠模型遵守，**不构成强制**。要硬隔离需要另写工具掩码插件（本次明确不做）。
2. **scribe 的路径纪律是软约束。** preset 机制不能按路径限定 `write`；只能靠 persona 规定"只写规划/复核文档" + 回执给出实际路径供审计。它物理上仍能写工作区内的任意文件。
3. **复核没有 Shell。** 不能 `git show`、不能跑测试、不能构建。只给 commit id 时必须由你（或执行窗口）提供 diff / 文件 / 测试输出。
4. **模型路由受现有模型钉影响。** 本机 `dsh-subagent-model-pin`（`honorExplicit: false`）会覆盖显式路由；两者目标一致时无冲突，但**以模型钉为准**。如果哪天卸掉模型钉，`agentOptions` 仍会兜底到 flash。
5. **子代理不会继承父 preset 的工具限制**，它们只按自己 preset 挂载的行拿工具；这也是本设计成立的前提。
6. **不继承官方 preset 更新。** 这是独立声明，DSH 升级后若 `standard` 的基础行变化（新增必填配置字段等），本包需要人工跟一次。
7. **`scout` / `scribe` 会出现在预设选择器里。** DSH 无法隐藏 preset；它们名字标了「内部角色」，请勿单独开会话使用。
8. **全局与项目 `AGENTS.md` 仍会注入**（这是好事，但意味着你的全局规则对 `dev-plan` 同样生效）。
9. **桥接插件是可选的。** 装了 `dsh-planner-worker` 并配对时，persona 会按"派发/汇报/返工是传输层、按钮归用户、汇报是数据"的规则处理；没装时，手工把计划交给新窗口、把 diff 贴回来，流程一样完整。

---

## 六、和桥接插件的关系

`dsh-planner-worker`（规划窗 ↔ 开发窗）**不是依赖**。存在时它负责把任务书送到开发窗、把汇报与改动清单带回来；`dev-plan` 只消费这些数据，不派发、不点按钮、不自动返工。

`ask_worker` 默认不用：只有你明确允许、且已收到汇报、证据仍不足时才用，一次一个问题、每任务最多 2 次、绝不提前用。

---

## 七、配置

本包没有运行时配置文件。想改行为，改 persona 文本（`presets/*.patch.yml`）或子代理路由（`agentOptions`），然后重启。

---

## 八、卸载

从 profile 的 `package.json` 删掉 `dsh-dev-plan-presets` 依赖与 `bundles` 里的那一行，重启即可。
不涉及任何现有配置文件、`standard` preset 或其他插件；本包不写运行时状态文件。

---

## 九、版本

- v0.1.0（2026-11-13）：三 preset 静态组合（`dev-plan` / `scout` / `scribe`）、内置风险驱动规划与静态复核方法论、三个角色化委派入口、可选桥接规则、静态自检脚本。
