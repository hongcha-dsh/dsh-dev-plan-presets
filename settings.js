/**
 * 插件设置的唯一真源。
 *
 * 这里同时承担三个职责，避免 UI、preset 定义、模型守门各拿一份默认值漂移：
 *   1. DEFAULT_SETTINGS：所有字段的默认值（standard + pin，零第三方依赖）；
 *   2. normalizeSettings()：把任意来源的 raw config 收敛成完整、类型正确的设置；
 *   3. Config：Cordis 可用的 Standard Schema（`~standard` 协议），
 *      在激活 / 配置写回时校验候选值，非法值直接拒绝，不做静默纠正。
 *
 * 注意：本文件不 import 任何 @deepseek-ai/* 包。插件以 link 方式安装时，
 * 宿主包不保证能从插件目录解析到；Config 手写 Standard Schema 即可，
 * 不需要 @deepseek-ai/schemastery 依赖。
 */

/**
 * 施工子代理 preset 不再有固定枚举：任何宿主已注册的 preset id 都是候选值。
 * 这里不定义白名单，可用性由 Host 对照 agentPresets 目录在运行期判断。
 */

/** 模型守门模式。off = 完全不管；audit = 只记录；pin = 钉住并可按设置打断。 */
export const GUARD_MODES = Object.freeze(['off', 'audit', 'pin'])

/** 默认路由：与 0.2.0 及旧 dsh-subagent-model-pin 保持一致。 */
export const DEFAULT_CHILD_PROVIDER = 'dsh-opencode-go'
export const DEFAULT_CHILD_MODEL = 'deepseek-v4.1-flash'

/**
 * 完整默认设置。
 * 默认 standard 且 modelGuardMode=pin：不要求宿主安装深度 PTC，同时保留模型防错。
 */
export const DEFAULT_SETTINGS = Object.freeze({
  /** 施工子代理 preset id：任意宿主已注册 preset；standard（默认，零额外依赖）始终可用。 */
  developMode: 'standard',
  /** 四个委派工具共用的子代理 provider。 */
  childProvider: DEFAULT_CHILD_PROVIDER,
  /** 四个委派工具共用的子代理 model。 */
  childModel: DEFAULT_CHILD_MODEL,
  /** 可选 reasoningEffort；空串表示省略该字段。 */
  childReasoningEffort: '',
  /** off / audit / pin。 */
  modelGuardMode: 'pin',
  /** pin 模式下发现越界时，是否 reject 当前 step、cancel 子代理并通知父会话。 */
  killOnViolation: true,
  /** 是否尊重子代理创建时的显式非父级路由（默认 false：一律钉住）。 */
  honorExplicit: false,
  /** 是否写结构化审计日志（只含路由与事件，不含任何凭据）。 */
  audit: true,
  /**
   * false（默认）只管理 dev-plan 父会话派出的子代理；true 恢复旧的全局子代理守门。
   * 主会话始终不守门。
   */
  guardAllSubagents: false,
})

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmptyString = (value) =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined

/**
 * 把任意 raw config 收敛成完整设置；非法枚举/空值回落到默认值。
 * 该函数用于运行期容错（例如旧版本配置）；需要拒绝非法输入时先用 validateSettings()。
 * @param {unknown} raw
 * @returns {typeof DEFAULT_SETTINGS}
 */
export function normalizeSettings(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const developMode = nonEmptyString(input.developMode)
  return {
    // 保留用户保存的原值（含后来失效的 preset id），可用性在运行期判断，不静默改写配置。
    developMode: developMode === undefined ? DEFAULT_SETTINGS.developMode : developMode,
    childProvider: nonEmptyString(input.childProvider) ?? DEFAULT_SETTINGS.childProvider,
    childModel: nonEmptyString(input.childModel) ?? DEFAULT_SETTINGS.childModel,
    childReasoningEffort:
      typeof input.childReasoningEffort === 'string' ? input.childReasoningEffort.trim() : '',
    modelGuardMode: GUARD_MODES.includes(input.modelGuardMode)
      ? input.modelGuardMode
      : DEFAULT_SETTINGS.modelGuardMode,
    killOnViolation:
      input.killOnViolation === undefined
        ? DEFAULT_SETTINGS.killOnViolation
        : input.killOnViolation === true,
    honorExplicit:
      input.honorExplicit === undefined
        ? DEFAULT_SETTINGS.honorExplicit
        : input.honorExplicit === true,
    audit: input.audit === undefined ? DEFAULT_SETTINGS.audit : input.audit === true,
    guardAllSubagents:
      input.guardAllSubagents === undefined
        ? DEFAULT_SETTINGS.guardAllSubagents
        : input.guardAllSubagents === true,
  }
}

/**
 * 严格校验：供 Config 使用，非法值返回 Standard Schema issues。
 * @param {unknown} raw
 * @returns {{ value: typeof DEFAULT_SETTINGS } | { issues: Array<{ message: string, path?: string[] }> }}
 */
export function validateSettings(raw) {
  const input = isPlainObject(raw) ? raw : {}
  const issues = []
  const issue = (path, message) => issues.push({ message, path: [path] })

  // 不再限制为两项：任何非空 preset id 都允许保存；Host 运行期对照真实目录决定是否回退。
  if (input.developMode !== undefined && nonEmptyString(input.developMode) === undefined) {
    issue('developMode', 'must be a non-empty preset id')
  }
  for (const field of ['childProvider', 'childModel']) {
    if (input[field] !== undefined && nonEmptyString(input[field]) === undefined) {
      issue(field, 'must be a non-empty string')
    }
  }
  if (
    input.childReasoningEffort !== undefined &&
    input.childReasoningEffort !== null &&
    typeof input.childReasoningEffort !== 'string'
  ) {
    issue('childReasoningEffort', 'must be a string (empty string = provider default)')
  }
  if (input.modelGuardMode !== undefined && !GUARD_MODES.includes(input.modelGuardMode)) {
    issue('modelGuardMode', `must be one of ${GUARD_MODES.join(', ')}`)
  }
  for (const field of ['killOnViolation', 'honorExplicit', 'audit', 'guardAllSubagents']) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean') {
      issue(field, 'must be a boolean')
    }
  }
  if (issues.length > 0) return { issues }
  return { value: normalizeSettings(input) }
}

/**
 * Cordis Standard Schema：激活与配置写回都会走这里。
 * `simplify` 让 Loader 持久化时写入规范化后的普通对象。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-dev-plan-presets',
    validate: validateSettings,
  },
  simplify: (value) => normalizeSettings(value),
}

/**
 * 四个委派工具共用的 agentOptions。
 * 空 childReasoningEffort 必须省略该键，而不是写空串，否则适配器可能拒绝。
 * @param {typeof DEFAULT_SETTINGS} settings
 * @returns {{ provider: string, model: string, reasoningEffort?: string }}
 */
export function routeOf(settings) {
  const normalized = normalizeSettings(settings)
  const route = { provider: normalized.childProvider, model: normalized.childModel }
  if (normalized.childReasoningEffort.length > 0) {
    route.reasoningEffort = normalized.childReasoningEffort
  }
  return route
}

/**
 * 判断路由是否命中目标（用于模型守门）。
 * 目标带 reasoningEffort 时必须一致；目标不带时不强求子代理 effort 为空，
 * 因为适配器/父级可能解析出默认 effort，把它当成越界会误伤。
 * @param {unknown} got
 * @param {{ provider?: string, model?: string, reasoningEffort?: string }} want
 */
export function routeMatches(got, want) {
  if (!got || typeof got !== 'object') return false
  if (got.provider !== want.provider || got.model !== want.model) return false
  if (want.reasoningEffort && got.reasoningEffort !== want.reasoningEffort) return false
  return true
}
