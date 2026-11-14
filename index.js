/**
 * dsh-dev-plan-presets — bundle 入口
 *
 * 本包的价值全在 presets/dev-plan.patch.yml 的那一份 Agent preset 声明里
 * （原内部角色已不再是独立 preset，角色约束以模板形式写在 dev-plan persona 内）。
 * 这个 index.js **不注册任何模型可见工具、不注册 HTTP 路由、不注入提示词**：
 *   1. 让 bundle 在插件管理页有一行，能被看见、禁用、卸载；
 *   2. 加载时做一次打包自检（两个 patch 文件在不在、能不能读出 dev-plan preset id），
 *      缺文件只告警，绝不让 Host 启动失败。
 *
 * 设计取舍见 README「已知限制」：这是纯静态组合（B 方案），不是安全沙箱。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))

const PATCH_FILES = [
  'cordis.patch.yml',
  'presets/dev-plan.patch.yml',
]

const EXPECTED_PRESETS = ['dev-plan']

export function apply(ctx) {
  const warn = (message) => {
    try {
      if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
    } catch {
      // 日志不可用不是启动失败的理由。
    }
  }

  try {
    const found = new Set()
    for (const file of PATCH_FILES) {
      let text
      try {
        text = readFileSync(PLUGIN_DIR + file, 'utf8')
      } catch {
        warn(`[dsh-dev-plan-presets] 缺少补丁文件 ${file}；对应的 preset 不会出现。`)
        continue
      }
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*(?:-\s*)?id:\s*(preset-[A-Za-z0-9-]+)\s*$/.exec(line)
        if (match) found.add(match[1].replace(/^preset-/, ''))
      }
    }
    const missing = EXPECTED_PRESETS.filter((id) => !found.has(id))
    if (missing.length > 0) {
      warn(`[dsh-dev-plan-presets] 补丁里没有找到预期 preset：${missing.join(', ')}`)
    }
  } catch (error) {
    warn(`[dsh-dev-plan-presets] 自检异常（已忽略，不影响启动）：${error instanceof Error ? error.message : String(error)}`)
  }
}
