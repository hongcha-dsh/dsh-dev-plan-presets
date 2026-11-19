/**
 * 子代理模型守门（吸收 dsh-subagent-model-pin 的核心能力）。
 *
 * 语义：
 *   - 只管理子代理：有 parentSession 或 origin=subagent 的 Agent；主会话永不 select、永不 reject。
 *   - 创建时按 modelGuardMode 决定：pin=选中目标路由；audit=只记录 would-pin；off=什么都不做。
 *   - 每个被管理的子代理挂 agent/pre-step 守卫，逐步核对即将发请求的 modelSelection；
 *     pin + killOnViolation 时在发请求前 reject、cancel 子代理并通知父会话；audit 只记录。
 *   - honorExplicit=true 时，创建时检测到子代理被显式指定了非父级路由就不钉、也不挂守卫，
 *     避免“说尊重却仍然打断”的自相矛盾。
 *   - 审计只记录路由、事件与 agent id，不记录任何凭据。
 *
 * 本文件不 import Node 内置模块，也不 import @deepseek-ai/*，便于单测。
 */

import { DEFAULT_SETTINGS, routeMatches, routeOf } from './settings.js'
import { PRESET_ID } from './preset.js'

const MAX_TEXT = 240
const shortId = (value) => (typeof value === 'string' ? value.slice(0, 12) : '')

/**
 * 判断一个 session header 是否代表子代理。
 * @param {{ parentSession?: string, origin?: string } | undefined} header
 */
export function isSubagentHeader(header) {
  if (!header || typeof header !== 'object') return false
  // fork 主对话也会带 parentSession（delegationDepth:0、无 origin），不能据此当子代理。
  if (header.origin === 'subagent') return true
  const depth = header.delegationDepth
  return typeof depth === 'number' && Number.isFinite(depth) && depth > 0
}

/** 取父会话对象；拿不到就返回 undefined（调用方应跳过守门，避免误伤）。 */
const parentSessionOf = (ctx, agent) => {
  try {
    const parentId = agent?.session?.header?.parentSession
    if (!parentId) return undefined
    return ctx.get('agents')?.get?.(parentId)?.session
  } catch {
    return undefined
  }
}

/**
 * 读取会话当前 preset：优先 agentPresets.presetForSession(session)（含已不在 roster 的历史选择），
 * 回退 session.header.agentPreset。拿不到时返回 undefined，调用方必须跳过守门。
 */
export function presetOfSession(ctx, session) {
  if (!session) return undefined
  try {
    const registry = ctx.get('agentPresets')
    if (typeof registry?.presetForSession === 'function') {
      const preset = registry.presetForSession(session)
      if (typeof preset === 'string' && preset.length > 0) return preset
    }
  } catch {
    /* 回退 header */
  }
  const fromHeader = session?.header?.agentPreset
  return typeof fromHeader === 'string' && fromHeader.length > 0 ? fromHeader : undefined
}

/**
 * 默认守门范围：只管理父会话 preset=dev-plan 的子代理；guardAllSubagents=true 时恢复全局。
 * 父会话或 preset 无法可靠判断时返回 false（宁可跳过，也不误伤其他插件）。
 */
export function shouldGuardAgent(ctx, agent, settings) {
  if (settings?.guardAllSubagents === true) return true
  const parent = parentSessionOf(ctx, agent)
  if (!parent) return false
  return presetOfSession(ctx, parent) === PRESET_ID
}

const parentRouteOf = (ctx, agent) => {
  try {
    const parentId = agent?.session?.header?.parentSession
    if (!parentId) return undefined
    const parent = ctx.get('agents')?.get?.(parentId)
    const current = parent?.model?.current?.()
    if (!current?.provider || !current?.model) return undefined
    return { provider: current.provider, model: current.model }
  } catch {
    return undefined
  }
}

const notifyParent = (ctx, agent, text) => {
  try {
    const parentId = agent?.session?.header?.parentSession
    if (!parentId) return
    const parent = ctx.get('agents')?.get?.(parentId)
    if (typeof parent?.inject !== 'function') return
    parent.inject({
      content: [{ type: 'text', text }],
      source: { kind: 'dev-plan-presets' },
    })
  } catch {
    /* 通知失败不能反过来破坏守门 */
  }
}

const describeRoute = (route) =>
  route && route.provider && route.model ? `${route.provider}/${route.model}` : '(unknown)'

const stopChild = (ctx, agent, reason, hooks) => {
  try {
    if (typeof agent?.cancel === 'function') agent.cancel({ kind: 'user' })
  } catch {
    /* ignore */
  }
  notifyParent(
    ctx,
    agent,
    `⚠️ [dev-plan-presets] 子代理 ${shortId(agent?.id)} ${reason}，已中止。`,
  )
  hooks?.audit?.('stopped', { agent: shortId(agent?.id), reason })
}

const recordViolation = (hooks, agent, got, want, detail) => {
  const entry = {
    at: new Date().toISOString(),
    agent: shortId(agent?.id),
    session: shortId(agent?.session?.id),
    from: describeRoute(got),
    want: describeRoute(want),
    text: String(detail).slice(0, MAX_TEXT),
  }
  try {
    hooks?.recordViolation?.(entry)
  } catch {
    /* ignore */
  }
}

const violationText = (got, want) =>
  `越界使用模型 ${describeRoute(got)}（应为 ${describeRoute(want)}）`

/**
 * 给一个子代理装逐步守卫。
 * 监听器注册在 agent.ctx 上，但**返回值必须由插件自己的生命周期持有**：
 * agent 作用域销毁和插件卸载两边都会调用同一个幂等 disposer。
 * @returns 幂等卸载函数；注册失败时返回 undefined。
 */
const installStepGuard = (ctx, agent, settings, hooks, target, onDispose) => {
  let stopped = false
  let active = true
  const handler = async (payload, next) => {
    if (settings.modelGuardMode === 'off') return next()
    if (stopped) return { kind: 'reject' }
    const decision = await next()
    try {
      if (decision?.kind === 'reject') return decision
      if (settings.modelGuardMode === 'off') return decision
      if (stopped) return { kind: 'reject' }
      const got = payload?.modelSelection
      if (routeMatches(got, target)) return decision
      const detail = violationText(got, target)
      recordViolation(hooks, agent, got, target, detail)
      hooks?.audit?.('violation', {
        agent: shortId(agent?.id),
        from: describeRoute(got),
        want: describeRoute(target),
      })
      if (settings.modelGuardMode === 'pin' && settings.killOnViolation) {
        stopped = true
        stopChild(ctx, agent, detail, hooks)
        return { kind: 'reject' }
      }
      return decision
    } catch {
      return decision
    }
  }
  let off
  try {
    off = agent.ctx.on('agent/pre-step', handler)
  } catch (error) {
    hooks?.warn?.(`无法为子代理 ${shortId(agent?.id)} 安装模型守卫：${String(error?.message ?? error)}`)
    return undefined
  }
  const dispose = () => {
    if (!active) return
    active = false
    try {
      if (typeof off === 'function') off()
    } catch {
      /* ignore */
    }
    try {
      if (typeof onDispose === 'function') onDispose(agent)
    } catch {
      /* ignore */
    }
  }
  // agent 作用域销毁时也释放；插件总 disposer 会先/后调用同一个 dispose，靠 active 幂等。
  try {
    if (typeof agent.ctx.effect === 'function') agent.ctx.effect(() => dispose)
  } catch {
    /* 没有 effect 时至少还有插件总 disposer */
  }
  return dispose
}

/**
 * 处理一个 agent/created 事件。导出以便单测直接调用。
 * @param {any} ctx
 * @param {any} agent
 * @param {import('./settings.js').DEFAULT_SETTINGS} settings
 * @param {{ recordViolation?: Function, audit?: Function, warn?: Function }} hooks
 * @param {{ provider: string, model: string, reasoningEffort?: string }} [target]
 * @param {(agent: any) => void} [onDispose]
 */
export function onAgentCreated(
  ctx,
  agent,
  settings,
  hooks = {},
  target = routeOf(settings),
  onDispose,
) {
  if (!agent || settings.modelGuardMode === 'off') return
  const header = agent.session?.header
  // 主会话在这里被挡掉：没有父会话，也不是 origin=subagent。
  if (!isSubagentHeader(header)) return

  // 默认只守 dev-plan 父会话派出的子代理；判断不了父会话 preset 时不守门。
  if (settings.guardAllSubagents !== true) {
    const parent = parentSessionOf(ctx, agent)
    const preset = parent ? presetOfSession(ctx, parent) : undefined
    if (preset !== PRESET_ID) {
      if (preset === undefined) {
        hooks?.audit?.('guard-skip-unknown-parent-preset', {
          agent: shortId(agent?.id),
          parentFound: Boolean(parent),
        })
      }
      return
    }
  }

  const mode = settings.modelGuardMode
  const current = (() => {
    try {
      return agent.model?.current?.()
    } catch {
      return undefined
    }
  })()

  if (mode === 'audit') {
    const dispose = installStepGuard(ctx, agent, settings, hooks, target, onDispose)
    hooks?.audit?.('would-pin', {
      agent: shortId(agent?.id),
      from: describeRoute(current),
      want: describeRoute(target),
    })
    return dispose
  }

  const parentRoute = parentRouteOf(ctx, agent)
  const explicit = Boolean(
    current &&
      parentRoute &&
      (current.provider !== parentRoute.provider || current.model !== parentRoute.model),
  )
  if (explicit && settings.honorExplicit) {
    hooks?.audit?.('skip-explicit', {
      agent: shortId(agent?.id),
      from: describeRoute(current),
      want: describeRoute(target),
    })
    return
  }

  // pin：守卫必须在 select 尝试之前装好。这样即使 select 不存在/抛错且 kill=false，
  // 后续 pre-step 仍能记录越界，而不是变成完全不设防。
  const dispose = installStepGuard(ctx, agent, settings, hooks, target, onDispose)

  // 已经在目标路由上：保留守卫防后续漂移即可。
  if (routeMatches(current, target)) {
    hooks?.audit?.('already', { agent: shortId(agent?.id), want: describeRoute(target) })
    return dispose
  }

  const model = agent.model
  if (typeof model?.select !== 'function') {
    const detail = '当前 DSH 不支持 agent.model.select，无法钉住子代理路由'
    recordViolation(hooks, agent, current, target, detail)
    if (settings.killOnViolation) stopChild(ctx, agent, detail, hooks)
    return dispose
  }

  try {
    model.select({ ...target })
    hooks?.audit?.('pinned', {
      agent: shortId(agent?.id),
      from: describeRoute(current),
      want: describeRoute(target),
    })
  } catch (error) {
    const detail = `钉住子代理路由失败：${String(error?.message ?? error)}`
    recordViolation(hooks, agent, current, target, detail)
    if (settings.killOnViolation) stopChild(ctx, agent, detail, hooks)
  }
  return dispose
}

/**
 * 安装全局 agent/created 监听，并跟踪每个子代理的 step guard。
 * 总 disposer 同时解绑事件监听和所有已装守卫：插件 HMR/卸载后旧设置不能继续拦截仍运行的 agent。
 * @returns 幂等总卸载函数。
 */
export function installModelGuard(ctx, settings, hooks = {}) {
  if (settings.modelGuardMode === 'off') return () => {}
  const target = routeOf(settings)
  const steps = new Map()
  let active = true

  const release = (agent) => {
    const dispose = steps.get(agent)
    if (dispose === undefined) return
    steps.delete(agent)
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }

  const listener = (payload) => {
    const agent = payload?.agent
    try {
      const dispose = onAgentCreated(ctx, agent, settings, hooks, target, (targetAgent) => {
        steps.delete(targetAgent)
      })
      if (typeof dispose === 'function' && agent && typeof agent === 'object') {
        release(agent)
        steps.set(agent, dispose)
      }
    } catch (error) {
      hooks?.warn?.(`模型守门处理 agent 失败：${String(error?.message ?? error)}`)
    }
  }
  const disposedListener = (payload) => {
    try {
      release(payload?.agent)
    } catch {
      /* ignore */
    }
  }

  const offs = []
  try {
    offs.push(ctx.on('agent/created', listener))
    offs.push(ctx.on('agent/disposed', disposedListener))
  } catch (error) {
    hooks?.warn?.(`无法注册模型守门：${String(error?.message ?? error)}`)
  }

  return () => {
    if (!active) return
    active = false
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* ignore */
      }
    }
    const pending = [...steps.values()]
    steps.clear()
    for (const dispose of pending) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}

const turnSignatureOf = (agent, payload) => {
  if (payload && payload.turnId !== undefined) return `turn:${String(payload.turnId)}`
  if (payload && payload.userMessageId !== undefined) {
    return `userMsg:${String(payload.userMessageId)}`
  }
  const messages = agent?.session?.messages
  if (!Array.isArray(messages)) return 'default'
  let userCount = 0
  let lastUserId = ''
  for (const msg of messages) {
    if (msg?.role === 'user' && msg?.source?.kind !== 'dev-plan-presets') {
      userCount += 1
      if (msg.id !== undefined) lastUserId = String(msg.id)
    }
  }
  return `users:${userCount}:${lastUserId}`
}

/**
 * 主会话步数预算软提醒（独立于 modelGuardMode）。
 * 仅在 settings.mainToolMode !== 'none' 时激活；
 * 仅监听非子代理且 preset=dev-plan 的主会话，在单轮连续步数超阈值时温和注入提示，
 * 绝不调用 agent.model.select、绝不 cancel、绝不 reject。
 *
 * @returns 幂等总卸载函数。
 */
export function installMainStepBudget(ctx, settings, hooks = {}) {
  const mode = settings?.mainToolMode ?? DEFAULT_SETTINGS.mainToolMode
  if (mode === 'none') return () => {}
  const threshold =
    Number.isInteger(settings?.mainStepWarnThreshold) && settings.mainStepWarnThreshold >= 2
      ? settings.mainStepWarnThreshold
      : 6

  const tracked = new Map()
  let active = true

  const release = (agent) => {
    const dispose = tracked.get(agent)
    if (dispose === undefined) return
    tracked.delete(agent)
    try {
      dispose()
    } catch {
      /* ignore */
    }
  }

  const attach = (agent) => {
    if (!agent || typeof agent.ctx?.on !== 'function') return
    if (isSubagentHeader(agent.session?.header)) return
    if (presetOfSession(ctx, agent.session) !== PRESET_ID) return

    let stepCount = 0
    let warned = false
    let lastTurn = ''
    let lastStepAt = 0
    let stepActive = true

    let off
    try {
      off = agent.ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next()
        try {
          if (decision?.kind === 'reject') return decision
          const now = Date.now()
          const turn = turnSignatureOf(agent, payload)
          if (turn !== lastTurn || (lastStepAt > 0 && now - lastStepAt > 60_000)) {
            lastTurn = turn
            stepCount = 0
            warned = false
          }
          lastStepAt = now
          stepCount += 1
          if (stepCount > threshold && !warned) {
            warned = true
            const message =
              `💡 [dev-plan-presets] 当前主模型在本轮已连续执行 ${stepCount} 步（提醒阈值 ${threshold}），` +
              `建议将后续探索或修改转交 recon / develop 子代理以节省主模型额度。`
            hooks?.audit?.('main-step-budget-warn', {
              agent: shortId(agent?.id),
              steps: stepCount,
              threshold,
              mode,
            })
            if (typeof agent?.inject === 'function') {
              agent.inject({
                content: [{ type: 'text', text: message }],
                source: { kind: 'dev-plan-presets' },
              })
            }
          }
        } catch {
          /* 软提醒绝不中断主会话 */
        }
        return decision
      })
    } catch {
      return
    }

    const dispose = () => {
      if (!stepActive) return
      stepActive = false
      tracked.delete(agent)
      try {
        if (typeof off === 'function') off()
      } catch {
        /* ignore */
      }
    }

    release(agent)
    tracked.set(agent, dispose)
    try {
      if (typeof agent.ctx.effect === 'function') agent.ctx.effect(() => dispose)
    } catch {
      /* ignore */
    }
  }

  const createdListener = (payload) => {
    try {
      attach(payload?.agent)
    } catch {
      /* ignore */
    }
  }
  const disposedListener = (payload) => {
    try {
      release(payload?.agent)
    } catch {
      /* ignore */
    }
  }

  const offs = []
  try {
    offs.push(ctx.on('agent/created', createdListener))
    offs.push(ctx.on('agent/disposed', disposedListener))
  } catch (error) {
    hooks?.warn?.(`无法注册主窗步数提醒：${String(error?.message ?? error)}`)
  }

  return () => {
    if (!active) return
    active = false
    for (const off of offs) {
      try {
        if (typeof off === 'function') off()
      } catch {
        /* ignore */
      }
    }
    const pending = [...tracked.values()]
    tracked.clear()
    for (const dispose of pending) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  }
}
