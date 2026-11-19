/**
 * dsh-dev-plan-presets — Host 插件入口（0.4.0）
 *
 * 本包做四件事：
 *   1. 用 ctx.agentPresets.register() 动态注册 dev-plan preset：Cordis 配置变更后插件重建，
 *      新会话使用新代际，旧会话保留旧代际（registry 的既有语义）。
 *   2. 维护四个委派工具（recon / review / scribe / develop）的配置真源；
 *      develop 的 agentPreset 取自宿主 agentPresets 目录中的任意可用 preset。
 *   3. 吸收 dsh-subagent-model-pin 的模型守门：默认只管理 dev-plan 父会话的子代理，
 *      guardAllSubagents=true 时恢复全局子代理守门；创建时选路由、agent/pre-step 逐步核查、
 *      越界在发请求前 reject + cancel + 通知父会话。
 *   4. 暴露 /plugins/dev-plan-presets/state 与 /config 两个 HTTP 路由，
 *      供 Client 设置页读取预设目录、模型目录、回退原因、越界记录，并通过 configEditor 写回配置。
 *
 * 运行期不 import js-yaml，也不 import @deepseek-ai/* 包：link 安装时插件目录解析不到宿主包。
 * 所有注册/监听都通过 ctx.effect / ctx.on 清理；动态 preset 的 disposer 也交还给 effect。
 */

import {
  Config,
  normalizeSettings,
  routeOf,
  validateSettings,
} from './settings.js'
import {
  DEEP_PTC_PRESET_ID,
  INTERNAL_PRESET_IDS,
  PRESET_ID,
  buildPresetDefinition,
  resolveDevelopMode,
} from './preset.js'
import { installMainStepBudget, installModelGuard } from './guard.js'

export { Config }
export const name = 'dev-plan-presets'
export const version = '0.4.0'
export const DEEP_PTC_PACKAGE_NAME = 'dsh-deep-ptc-mode'

const MAX_VIOLATIONS = 50
const MAX_WARNINGS = 20
const DEFAULT_VERIFY_DELAY_MS = 2000
let instanceSeq = 0

const isPlainObject = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** 兼容旧 UI/调用方：从目录行里汇总 deep-ptc 状态（新逻辑不再依赖它判断可用性）。 */
function summarizePreset(rows, id) {
  const row = (rows ?? []).find((item) => item?.id === id)
  return {
    available: Boolean(row) && !(typeof row.broken === 'string' && row.broken.length > 0),
    presetPresent: Boolean(row),
    ...(row?.broken ? { broken: row.broken } : {}),
  }
}

const MAX_PROBE_MS = 1200

/** 带超时的 promise：保留真实拒绝原因，不把失败伪装成超时。 */
const withTimeout = (promise, ms, message) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    if (typeof timer?.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })

/** 只等一小会儿：registry.list() 在 Host 启动期可能等 Loader 收敛，不能让它拖死注册。 */
const settleWithin = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), ms)
    if (typeof timer?.unref === 'function') timer.unref()
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(undefined)
      },
    )
  })

/**
 * 探测宿主 agentPresets 目录。目录是唯一事实源：
 *   - checked=true 且 rows 含目标 id、没有 broken，才算可用；
 *   - 读取超时/异常时 checked=false、rows=[]，调用方显式回退 standard 并稍后复检；
 *   - loader entry 不再参与可用性判断。
 * @returns {Promise<{ checked: boolean, timedOut: boolean, error?: string, rows: Array<{id:string,name:string,description:string,broken?:string}> }>}
 */
export async function probePresets(ctx, registry) {
  let checked = false
  let timedOut = false
  let error
  let rows = []
  try {
    const listed = await settleWithin(registry?.list?.(), MAX_PROBE_MS)
    if (Array.isArray(listed)) {
      checked = true
      rows = listed
        .filter((row) => isPlainObject(row) && typeof row.id === 'string' && row.id.trim().length > 0)
        .map((row) => ({
          id: row.id.trim(),
          name: typeof row.name === 'string' ? row.name.trim() : '',
          description: typeof row.description === 'string' ? row.description : '',
          ...(typeof row.broken === 'string' && row.broken.length > 0 ? { broken: row.broken } : {}),
        }))
    } else {
      timedOut = true
    }
  } catch (cause) {
    timedOut = true
    error = String(cause?.message ?? cause).slice(0, 200)
  }
  return { checked, timedOut, rows, ...(error === undefined ? {} : { error }) }
}

const send = (res, code, payload, extraHeaders = {}) => {
  let body
  try {
    body = JSON.stringify(payload)
  } catch (error) {
    body = JSON.stringify({ error: `序列化响应失败：${String(error?.message ?? error)}` })
    code = 500
  }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...extraHeaders,
  })
  res.end(body)
}

const etagMatches = (headerValue, etag) => {
  if (typeof headerValue !== 'string' || headerValue.trim().length === 0) return false
  const bare = etag.replace(/^"|"$/g, '')
  return headerValue
    .split(',')
    .map((part) => part.trim().replace(/^W\//i, ''))
    .some((part) => part === '*' || part === etag || part === bare)
}

const readBody = async (req, limit) => {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > limit) throw new Error('body too large')
  }
  return body
}

const mediaTypeOf = (req) =>
  String(req?.headers?.['content-type'] ?? '')
    .split(';')[0]
    .trim()
    .toLowerCase()

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1'])
const normalizeHost = (host) => String(host).replace(/^\[|\]$/g, '').toLowerCase()
const defaultPort = (protocol) => (protocol === 'https:' ? '443' : '80')
const endpointOf = (url) => ({
  protocol: url.protocol.toLowerCase(),
  host: normalizeHost(url.hostname),
  port: url.port || defaultPort(url.protocol),
})
const sameEndpoint = (left, right) =>
  left.protocol === right.protocol &&
  left.port === right.port &&
  (left.host === right.host ||
    (LOOPBACK_HOSTS.has(left.host) && LOOPBACK_HOSTS.has(right.host)))

/**
 * 浏览器跨源写保护。只做来源校验，不替代宿主认证：
 *  - Sec-Fetch-Site: cross-site 直接拒绝；
 *  - 带 Origin 时，Origin 必须同时匹配请求 Host 和 webServer.getOrigin() 的实际监听 origin；
 *    127.0.0.1 / localhost / [::1] 同端口视为有限等价，避免正常本机别名被误伤；
 *  - 没有 Origin 的非浏览器客户端放行（仍受宿主认证约束）；
 *  - 反代改写 Host/Origin 的场景不在本轮支持，需保持权威监听地址。
 * @returns 问题代码或 null
 */
const originProblem = (req, authoritativeOrigin) => {
  const site = String(req?.headers?.['sec-fetch-site'] ?? '').toLowerCase()
  if (site === 'cross-site') return 'cross-site'
  const origin = req?.headers?.origin
  if (origin === undefined || origin === null || origin === '') return null
  let originUrl
  try {
    originUrl = new URL(String(origin))
  } catch {
    return 'invalid-origin'
  }
  const hostHeader = String(req?.headers?.host ?? '')
  if (hostHeader === '') return 'invalid-host'
  let hostUrl
  try {
    hostUrl = new URL(`${originUrl.protocol}//${hostHeader}`)
  } catch {
    return 'invalid-host'
  }
  const originEndpoint = endpointOf(originUrl)
  if (!sameEndpoint(originEndpoint, endpointOf(hostUrl))) return 'origin-mismatch'
  if (authoritativeOrigin === undefined || authoritativeOrigin === null || authoritativeOrigin === '') {
    return 'authority-unavailable'
  }
  let authorityUrl
  try {
    authorityUrl = new URL(String(authoritativeOrigin))
  } catch {
    return 'authority-unavailable'
  }
  if (!sameEndpoint(originEndpoint, endpointOf(authorityUrl))) return 'origin-not-authoritative'
  return null
}

/**
 * Host 插件入口。
 * @param {any} ctx Cordis Context
 * @param {any} rawConfig Loader 配置（由 Config 校验/规范化）
 * @param {{ verificationDelayMs?: number, prewarmDelayMs?: number, prewarmModelCatalog?: boolean, now?: () => number }} [runtime] 仅测试用的运行参数
 */
export function apply(ctx, rawConfig, runtime = {}) {
  const settings = normalizeSettings(rawConfig)
  const cachedRoute = routeOf(settings)
  const now = typeof runtime?.now === 'function' ? runtime.now : () => Date.now()
  const instanceId = `${++instanceSeq}-${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
  const violations = []
  const warnings = []
  let stateVersion = 1
  const currentStateTag = () => `${instanceId}-${stateVersion}`
  const bumpState = () => {
    stateVersion += 1
  }
  const state = {
    settings,
    mode: null,
    definition: null,
    preset: null,
    internalPresets: { scout: false, scribe: false },
    presets: { checked: false, timedOut: false, rows: [] },
    deepPtc: { available: false, checked: false },
    registration: 'pending',
    error: null,
  }

  const log = (level, message) => {
    try {
      const fn = ctx.logger?.[level]
      if (typeof fn === 'function') fn.call(ctx.logger, `[dev-plan-presets] ${message}`)
    } catch {
      /* 日志不可用不是失败理由 */
    }
  }

  const rememberWarning = (message) => {
    warnings.unshift(String(message))
    if (warnings.length > MAX_WARNINGS) warnings.length = MAX_WARNINGS
    bumpState()
  }

  const audit = (event, detail) => {
    if (!settings.audit) return
    log('info', `audit ${event} ${JSON.stringify(detail ?? {})}`)
  }

  const recordViolation = (entry) => {
    violations.unshift(entry)
    if (violations.length > MAX_VIOLATIONS) violations.length = MAX_VIOLATIONS
    bumpState()
    log('warn', `模型守门：${entry?.text ?? '子代理越界'}`)
  }

  // ── 1. 模型守门（只管子代理；off 时完全不注册监听）──────────────────────────
  ctx.effect(
    () =>
      installModelGuard(ctx, settings, {
        recordViolation,
        audit,
        warn: (message) => {
          rememberWarning(message)
          log('warn', message)
        },
      }),
    'dev-plan-presets: model guard',
  )

  // ── 1b. 主会话步数预算软提醒（独立于 modelGuardMode，永不改模型/不取消）────
  ctx.effect(
    () =>
      installMainStepBudget(ctx, settings, {
        audit,
        warn: (message) => {
          rememberWarning(message)
          log('warn', message)
        },
      }),
    'dev-plan-presets: main step budget',
  )

  // ── 2. 动态 preset 注册（等 agentPresets 服务可用）──────────────────────────
  const delayMs = Number.isFinite(runtime?.verificationDelayMs)
    ? Math.max(0, Number(runtime.verificationDelayMs))
    : DEFAULT_VERIFY_DELAY_MS

  ctx.inject(['agentPresets'], (child) => {
    const registry = child.agentPresets
    let disposed = false
    let releases = []
    let queue = Promise.resolve()
    let timer

    const releaseAll = async () => {
      const current = releases
      releases = []
      for (let i = current.length - 1; i >= 0; i -= 1) {
        try {
          await current[i]()
        } catch (error) {
          log('warn', `释放动态 preset 失败：${String(error?.message ?? error)}`)
        }
      }
    }

    const enqueue = (task) => {
      queue = queue
        .then(async () => {
          if (disposed) return
          await task()
        })
        .catch((error) => {
          const message = String(error?.message ?? error)
          state.registration = 'failed'
          state.error = message
          bumpState()
          rememberWarning(message)
          log('error', `注册 dev-plan preset 失败：${message}`)
        })
      return queue
    }

    const publish = async (probe) => {
      if (disposed) return
      const mode = resolveDevelopMode({
        requestedMode: settings.developMode,
        presets: probe?.rows ?? [],
        catalogChecked: probe?.checked === true,
        catalogError: probe?.error,
      })
      state.mode = mode
      state.presets = {
        checked: probe?.checked === true,
        timedOut: probe?.timedOut === true,
        rows: probe?.rows ?? [],
        ...(probe?.error === undefined ? {} : { error: probe.error }),
      }
      state.deepPtc = {
        ...summarizePreset(probe?.rows, DEEP_PTC_PRESET_ID),
        checked: probe?.checked === true,
        ...(probe?.timedOut ? { registryTimedOut: true } : {}),
      }

      state.internalPresets = { scout: false, scribe: false }

      const definition = buildPresetDefinition({
        settings,
        mode,
        internalPresets: state.internalPresets,
      })
      if (mode.fallback) {
        const message = `施工子代理已回退 standard：${mode.reason}`
        rememberWarning(message)
        log('warn', message)
      } else if (mode.effective === 'standard') {
        log('info', '施工子代理使用 standard preset。')
      } else {
        log('info', `施工子代理使用 ${mode.effective} preset（宿主预设目录已确认可用）。`)
      }

      const unregister = await registry.register(definition)
      if (typeof unregister !== 'function') {
        throw new Error('agentPresets.register 没有返回 disposer')
      }
      if (disposed) {
        await unregister()
        return
      }
      releases = [unregister]
      state.definition = definition
      state.preset = {
        id: definition.id,
        name: definition.name,
        description: definition.description,
      }
      state.registration = 'active'
      state.error = null
      bumpState()
    }

    const switchTo = async (probe) => {
      if (disposed) return
      const next = resolveDevelopMode({
        requestedMode: settings.developMode,
        presets: probe?.rows ?? [],
        catalogChecked: probe?.checked === true,
        catalogError: probe?.error,
      })
      const unchanged =
        state.mode !== null &&
        state.mode.effective === next.effective &&
        state.mode.fallback === next.fallback &&
        state.mode.reason === next.reason
      if (unchanged) {
        state.presets = {
          checked: probe?.checked === true,
          timedOut: probe?.timedOut === true,
          rows: probe?.rows ?? [],
          ...(probe?.error === undefined ? {} : { error: probe.error }),
        }
        state.deepPtc = {
          ...summarizePreset(probe?.rows, DEEP_PTC_PRESET_ID),
          checked: probe?.checked === true,
          ...(probe?.timedOut ? { registryTimedOut: true } : {}),
        }
        bumpState()
        return
      }
      // effective/fallback 相同但 reason 变了也要重新发布：description/persona 带着回退原因。
      state.registration = 'switching'
      bumpState()
      await releaseAll()
      await publish(probe)
    }

    const scheduleVerification = () => {
      const needsRecheck = state.mode?.fallback === true || state.presets.checked !== true
      if (!needsRecheck || delayMs <= 0) return
      timer = setTimeout(() => {
        timer = undefined
        enqueue(async () => {
          if (disposed) return
          const probe = await probePresets(ctx, registry)
          if (disposed) return
          await switchTo(probe)
        })
      }, delayMs)
      // 不阻止进程退出；Cordis 卸载时会清理。
      if (typeof timer?.unref === 'function') timer.unref()
    }

    // 卸载：先标记，等队列收敛，再按逆序交还动态 preset 的 disposer。
    child.effect(
      () =>
        async () => {
          disposed = true
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
          await queue.catch(() => {})
          await releaseAll()
          state.registration = 'disposed'
          bumpState()
        },
      'dev-plan-presets: dynamic preset',
    )

    enqueue(async () => {
      const probe = await probePresets(ctx, registry)
      if (disposed) return
      await publish(probe)
      scheduleVerification()
    })
  })

  // ── 3. 设置页 HTTP 路由（webServer 可选）────────────────────────────────────
  const MODEL_CATALOG_TTL_MS = 60_000
  let modelCatalog = { checked: false, providers: [], failures: [], error: null }
  let modelCatalogUpdatedAt = Number.NEGATIVE_INFINITY
  let modelCatalogInFlight

  /**
   * 枚举当前可用 provider / model。单个 provider 失败只影响它自己：
   * 其余 provider 仍返回，失败项进 failures，前端能区分“目录空”和“局部失败”。
   * 该函数只由后台刷新调用，/state 永远不 await 它。
   */
  const refreshModelCatalog = () => {
    if (modelCatalogInFlight) return modelCatalogInFlight
    modelCatalogInFlight = (async () => {
      const llm = (() => {
        try {
          return ctx.get('llm')
        } catch {
          return undefined
        }
      })()
      if (!llm || typeof llm.listProviders !== 'function') {
        modelCatalog = { checked: false, providers: [], failures: [], error: 'llm-unavailable' }
        modelCatalogUpdatedAt = now()
        bumpState()
        return modelCatalog
      }
      let providers
      try {
        providers = llm.listProviders()
      } catch (error) {
        modelCatalog = {
          checked: false,
          providers: [],
          failures: [],
          error: String(error?.message ?? error),
        }
        modelCatalogUpdatedAt = now()
        bumpState()
        return modelCatalog
      }
      const normalized = (Array.isArray(providers) ? providers : [])
        .filter((provider) => isPlainObject(provider) && typeof provider.id === 'string' && provider.id.length > 0)
        .map((provider) => ({
          id: provider.id,
          name:
            typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : provider.id,
        }))
      // 并行枚举，单个 provider 超时/失败只影响它自己。
      const entries = await Promise.all(
        normalized.map(async (provider) => {
          try {
            const models = await withTimeout(llm.listModels(provider.id), 3000, '模型列表读取超时')
            if (!Array.isArray(models)) throw new Error('模型列表返回了非数组')
            return {
              provider: provider.id,
              name: provider.name,
              models: models
                .filter((model) => isPlainObject(model) && typeof model.id === 'string' && model.id.length > 0)
                .map((model) => ({
                  model: model.id,
                  name:
                    typeof model.name === 'string' && model.name.length > 0 ? model.name : model.id,
                })),
            }
          } catch (error) {
            return {
              provider: provider.id,
              name: provider.name,
              models: [],
              failure: String(error?.message ?? error).slice(0, 200),
            }
          }
        }),
      )
      const out = entries.map(({ failure, ...entry }) => entry)
      const failures = entries
        .filter((entry) => typeof entry.failure === 'string')
        .map((entry) => ({ provider: entry.provider, message: entry.failure }))
      modelCatalog = { checked: true, providers: out, failures, error: null }
      modelCatalogUpdatedAt = now()
      bumpState()
      return modelCatalog
    })()
      .catch((error) => {
        // 后台失败必须落到状态里，且不能产生未处理拒绝。
        modelCatalog = {
          checked: false,
          providers: [],
          failures: [],
          error: String(error?.message ?? error).slice(0, 200),
        }
        modelCatalogUpdatedAt = now()
        bumpState()
        return modelCatalog
      })
      .finally(() => {
        modelCatalogInFlight = undefined
      })
    return modelCatalogInFlight
  }

  /**
   * 同步返回最后一次目录快照；超过 TTL 时只启动后台刷新，不阻塞 /state。
   * 60s TTL 保证设置页静置 60s 最多“初始 + 一次刷新”两轮全量枚举。
   */
  const modelCatalogSnapshot = () => {
    if (now() - modelCatalogUpdatedAt >= MODEL_CATALOG_TTL_MS) {
      void refreshModelCatalog()
    }
    return modelCatalog
  }

  const buildState = async () => ({
    version,
    stateVersion,
    stateTag: currentStateTag(),
    config: state.settings,
    route: cachedRoute,
    requestedMode: state.mode?.requested ?? settings.developMode,
    effectiveMode: state.mode?.effective ?? null,
    modeName: state.mode?.name ?? null,
    internalPresets: { ...state.internalPresets },
    fallback: {
      active: state.mode?.fallback === true,
      reason: state.mode?.reason ?? '',
    },
    presets: {
      checked: state.presets.checked === true,
      timedOut: state.presets.timedOut === true,
      selfId: PRESET_ID,
      disabledIds: INTERNAL_PRESET_IDS,
      rows: state.presets.rows,
      ...(typeof state.presets.error === 'string' ? { error: state.presets.error } : {}),
    },
    modelCatalog: modelCatalogSnapshot(),
    deepPtc: {
      presetId: DEEP_PTC_PRESET_ID,
      packageName: DEEP_PTC_PACKAGE_NAME,
      ...state.deepPtc,
    },
    preset: state.preset,
    registration: state.registration,
    error: state.error,
    errorCode: state.error === null ? null : 'preset-registration-failed',
    violations: violations.slice(0, 20),
    warnings: warnings.slice(0, 10),
  })

  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(function* devPlanPresetRoutes() {
        const webServer = webCtx.webServer
        const offState = webServer.register({
          kind: 'exact',
          path: '/plugins/dev-plan-presets/state',
          handler: async (req, res) => {
            if (req.method !== 'GET' && req.method !== 'HEAD') {
              send(res, 405, { error: 'method not allowed', code: 'method-not-allowed' })
              return
            }
            try {
              const snapshot = modelCatalogSnapshot()
              void snapshot
              const etag = `"${currentStateTag()}"`
              if (etagMatches(req?.headers?.['if-none-match'], etag)) {
                res.writeHead(304, {
                  etag,
                  'cache-control': 'no-store',
                })
                res.end()
                return
              }
              send(res, 200, await buildState(), { etag })
            } catch (error) {
              send(res, 500, { error: String(error?.message ?? error), code: 'internal-error' })
            }
          },
        })

        const offConfig = webServer.register({
          kind: 'exact',
          path: '/plugins/dev-plan-presets/config',
          handler: async (req, res) => {
            if (req.method !== 'POST') {
              send(res, 405, { error: 'method not allowed', code: 'method-not-allowed' })
              return
            }
            let authoritativeOrigin
            try {
              authoritativeOrigin = webServer.getOrigin()
            } catch {
              authoritativeOrigin = undefined
            }
            const originIssue = originProblem(req, authoritativeOrigin)
            if (originIssue !== null) {
              send(res, 403, {
                error: `origin rejected: ${originIssue}`,
                code: 'forbidden-origin',
                reason: originIssue,
              })
              return
            }
            if (mediaTypeOf(req) !== 'application/json') {
              send(res, 415, {
                error: 'content-type must be application/json',
                code: 'unsupported-media-type',
              })
              return
            }
            try {
              let body
              try {
                body = await readBody(req, 16384)
              } catch (error) {
                if (String(error?.message ?? error).includes('too large')) {
                  send(res, 413, { error: 'request body too large', code: 'body-too-large' })
                  return
                }
                throw error
              }
              let parsed
              try {
                parsed = body.trim().length === 0 ? {} : JSON.parse(body)
              } catch {
                send(res, 400, { error: 'request body is not valid JSON', code: 'invalid-json' })
                return
              }
              const patch = isPlainObject(parsed?.settings) ? parsed.settings : parsed
              if (!isPlainObject(patch)) {
                send(res, 400, { error: 'config body must be a JSON object', code: 'invalid-body' })
                return
              }
              const current = normalizeSettings(state.settings)
              // 先校验“当前值 + 补丁”的原始对象，再取规范化结果：
              // 直接校验 normalize 后的值会把非法枚举悄悄改成默认值，等于接受脏输入。
              const checked = validateSettings({ ...current, ...patch })
              if (checked.issues) {
                send(res, 400, {
                  error: 'invalid config',
                  code: 'invalid-config',
                  issues: checked.issues,
                })
                return
              }
              const next = checked.value
              const entry = ctx.fiber?.entry
              const editor = ctx.get('configEditor')
              if (!entry || typeof editor?.edit !== 'function') {
                send(res, 503, {
                  error:
                    'configEditor 不可用：当前 profile 没有可写的 root patch。请通过插件管理/配置编辑修改本行配置。',
                  code: 'config-editor-unavailable',
                })
                return
              }
              if (JSON.stringify(next) === JSON.stringify(current)) {
                send(res, 200, { ok: true, unchanged: true, config: next })
                return
              }
              await editor.edit(entry, () => ({ ...next }))
              // configEditor.edit 已写入 profile patch 并 await reconcileProfilePatches：
              // 它返回时 Loader 已尝试重建/应用新配置，不存在“没有 HMR 就只是落盘”的分支。
              send(res, 200, { ok: true, config: next, applying: true })
            } catch (error) {
              send(res, 500, { error: String(error?.message ?? error), code: 'internal-error' })
            }
          },
        })

        const prewarmEnabled = runtime?.prewarmModelCatalog !== false
        const prewarmDelayMs = Number.isFinite(runtime?.prewarmDelayMs)
          ? Math.max(0, Number(runtime.prewarmDelayMs))
          : 300
        let prewarmTimer
        if (prewarmEnabled) {
          prewarmTimer = setTimeout(() => {
            prewarmTimer = undefined
            if (now() - modelCatalogUpdatedAt >= MODEL_CATALOG_TTL_MS) {
              void refreshModelCatalog()
            }
          }, prewarmDelayMs)
          if (typeof prewarmTimer?.unref === 'function') prewarmTimer.unref()
        }

        yield () => {
          if (prewarmTimer !== undefined) {
            clearTimeout(prewarmTimer)
            prewarmTimer = undefined
          }
          try {
            offState()
          } catch {
            /* ignore */
          }
          try {
            offConfig()
          } catch {
            /* ignore */
          }
        }
      }, 'dev-plan-presets: settings routes')
    } catch (error) {
      rememberWarning(`无法注册设置页路由：${String(error?.message ?? error)}`)
      log('warn', `无法注册设置页路由：${String(error?.message ?? error)}`)
    }
  })
}

export { PRESET_ID }
