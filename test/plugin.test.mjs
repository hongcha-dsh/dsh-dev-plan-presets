import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  callRoute,
  createFakeAgent,
  createFakeConfigEditor,
  createFakeContext,
  createFakeRegistry,
  createFakeWebServer,
  loadModules,
} from '../scripts/test-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const { settings: S, preset: P, index, guard } = await loadModules(ROOT)

const base = () => ({ ...S.DEFAULT_SETTINGS })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function loadClientTestApi() {
  const previousWindow = globalThis.window
  const previousFlag = globalThis.__DSH_DEV_PLAN_PRESETS_TEST__
  const captured = { module: null }
  globalThis.window = {
    __ModuleLoader__: {
      load(module) {
        captured.module = module
      },
    },
  }
  globalThis.__DSH_DEV_PLAN_PRESETS_TEST__ = true
  try {
    const url =
      pathToFileURL(join(ROOT, 'client.js')).href +
      '?client-test=' +
      Date.now() +
      Math.random().toString(36).slice(2)
    await import(url)
    assert.ok(captured.module, 'client.js 没有调用 __ModuleLoader__.load')
    const fakeReact = {
      createElement: (...args) => ({ args }),
      useState: (initial) => [initial, () => {}],
      useEffect: () => {},
      useRef: (initial) => ({ current: initial }),
      useCallback: (fn) => fn,
      cloneElement: (element) => element,
      Fragment: 'Fragment',
    }
    const api = captured.module.factory(() => fakeReact)
    assert.ok(api.__test, 'client 没有暴露测试用纯选择函数')
    return api.__test
  } finally {
    globalThis.window = previousWindow
    globalThis.__DSH_DEV_PLAN_PRESETS_TEST__ = previousFlag
  }
}

test('默认设置：standard + pin，零 deep-ptc 依赖', () => {
  const value = S.normalizeSettings(undefined)
  assert.equal(value.developMode, 'standard')
  assert.equal(value.modelGuardMode, 'pin')
  assert.equal(value.killOnViolation, true)
  assert.equal(value.honorExplicit, false)
  assert.equal(value.audit, true)
  assert.equal(value.guardAllSubagents, false)
  assert.equal(value.childProvider, 'dsh-opencode-go')
  assert.equal(value.childModel, 'deepseek-v4.1-flash')
  assert.equal(value.childReasoningEffort, '')
  assert.deepEqual(S.routeOf(value), { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' })
})

test('Config 严格校验：默认值通过，非法枚举/空路由被拒绝', () => {
  const ok = S.Config['~standard'].validate({})
  assert.deepEqual(ok.value, base())
  // 任意非空 preset id 都合法；只有空值被拒绝。
  const customMode = S.Config['~standard'].validate({ developMode: 'my-preset' })
  assert.equal(customMode.value.developMode, 'my-preset')
  const emptyMode = S.Config['~standard'].validate({ developMode: '   ' })
  assert.ok(emptyMode.issues.some((issue) => issue.path[0] === 'developMode'))
  const badGuardAll = S.Config['~standard'].validate({ guardAllSubagents: 'yes' })
  assert.ok(badGuardAll.issues.some((issue) => issue.path[0] === 'guardAllSubagents'))
  const goodGuardAll = S.Config['~standard'].validate({ guardAllSubagents: true })
  assert.equal(goodGuardAll.value.guardAllSubagents, true)
  const badGuard = S.Config['~standard'].validate({ modelGuardMode: 'kill' })
  assert.ok(badGuard.issues.some((issue) => issue.path[0] === 'modelGuardMode'))
  const badRoute = S.Config['~standard'].validate({ childProvider: '  ' })
  assert.ok(badRoute.issues.some((issue) => issue.path[0] === 'childProvider'))
  const badEffort = S.Config['~standard'].validate({ childReasoningEffort: 1 })
  assert.ok(badEffort.issues.some((issue) => issue.path[0] === 'childReasoningEffort'))
})

test('standard 定义：四个委派工具、develop=standard、主窗无施工工具', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  assert.equal(definition.id, 'dev-plan')
  assert.equal(definition.name, '开发规划与交付')
  assert.equal(P.PRESET_NAME, '开发规划与交付')
  assert.equal(definition.order, 10)

  const rows = []
  const walk = (plugins) => {
    for (const row of plugins ?? []) {
      rows.push(row)
      if (Array.isArray(row?.config)) walk(row.config)
    }
  }
  walk(definition.plugins)
  for (const forbidden of P.FORBIDDEN_MAIN_PLUGINS) {
    assert.ok(!rows.some((row) => row?.name === forbidden), `主窗不应挂 ${forbidden}`)
  }
  const subagents = rows.filter((row) => row?.name === '@deepseek-ai/dsh-tool-subagent')
  assert.equal(subagents.length, 4)
  assert.deepEqual(
    subagents.map((row) => row.config.toolName).sort(),
    ['develop', 'recon', 'review', 'scribe'],
  )
  for (const row of subagents) {
    const cfg = row.config
    assert.equal(cfg.provider, 'spawn')
    assert.equal(cfg.maxDepth, 1)
    assert.equal(cfg.modelSelection, false)
    assert.equal(cfg.modelDiscovery, false)
    assert.equal(cfg.allowedAgentPresets, undefined)
    assert.deepEqual(cfg.agentOptions, { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' })
    assert.equal(cfg.agentPreset, 'standard')
  }
  assert.equal(subagents.find((row) => row.config.toolName === 'develop').config.agentPreset, 'standard')
})

test('deep-ptc 定义：只有 develop 切到 deep-ptc，其余仍是 standard', () => {
  const mode = P.resolveDevelopMode({
    requestedMode: 'deep-ptc',
    presets: [{ id: 'deep-ptc', name: '深度 PTC' }],
    catalogChecked: true,
  })
  const definition = P.buildPresetDefinition({ settings: base(), mode })
  const rows = []
  const walk = (plugins) => {
    for (const row of plugins ?? []) {
      rows.push(row)
      if (Array.isArray(row?.config)) walk(row.config)
    }
  }
  walk(definition.plugins)
  const byName = Object.fromEntries(
    rows
      .filter((row) => row?.name === '@deepseek-ai/dsh-tool-subagent')
      .map((row) => [row.config.toolName, row.config.agentPreset]),
  )
  assert.deepEqual(byName, {
    recon: 'standard',
    review: 'standard',
    scribe: 'standard',
    develop: 'deep-ptc',
  })
  assert.match(definition.description, /deep-ptc/)
})

test('回退显式可见：standard + 原因，写进 description 与 persona', () => {
  const mode = P.resolveDevelopMode({ requestedMode: 'deep-ptc', presets: [], catalogChecked: true })
  assert.equal(mode.effective, 'standard')
  assert.equal(mode.fallback, true)
  assert.match(mode.reason, /没有可用的施工方式|未安装|未启用|已被移除/)
  const definition = P.buildPresetDefinition({ settings: base(), mode })
  assert.match(definition.description, /已回退 standard/)
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  assert.match(persona, /已回退 standard/)
  assert.match(persona, /不是静默降级/)
})

test('deep-ptc 已注册但激活失败也回退', () => {
  const mode = P.resolveDevelopMode({
    requestedMode: 'deep-ptc',
    presets: [{ id: 'deep-ptc', broken: 'row 3 failed to import' }],
    catalogChecked: true,
  })
  assert.equal(mode.effective, 'standard')
  assert.equal(mode.fallback, true)
  assert.match(mode.reason, /加载失败/)
})

test('apply 动态注册 preset，并在 dispose 时交还 disposer', async () => {
  const registry = createFakeRegistry()
  const ctx = createFakeContext({ registry })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  assert.equal(registry.definitions.length, 1)
  assert.equal(registry.definitions[0].id, 'dev-plan')
  const stateRoute = null
  assert.equal(stateRoute, null)
  await ctx.dispose()
  assert.deepEqual(registry.released, ['dev-plan'])
})

test('state 路由：默认 standard、preset 描述可用', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/state')
  assert.equal(typeof handler, 'function')
  const response = await callRoute(handler, 'GET')
  assert.equal(response.code, 200)
  assert.equal(response.body.version, '0.3.0')
  assert.equal(response.body.effectiveMode, 'standard')
  assert.equal(response.body.fallback.active, false)
  assert.equal(response.body.preset.id, 'dev-plan')
  assert.equal(response.body.config.guardAllSubagents, false)
  assert.equal(response.body.presets.selfId, 'dev-plan')
  assert.match(response.body.preset.description, /standard/)
  await ctx.dispose()
})

test('state 路由：请求 deep-ptc 但宿主没有时显式回退', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/state')
  const response = await callRoute(handler, 'GET')
  assert.equal(response.body.effectiveMode, 'standard')
  assert.equal(response.body.fallback.active, true)
  assert.match(response.body.fallback.reason, /没有可用的施工方式|未安装|未启用|已被移除/)
  assert.equal(response.body.presets.checked, true)
  assert.deepEqual(response.body.presets.rows, [])
  assert.match(response.body.preset.description, /已回退 standard/)
  assert.ok(ctx.loggerCalls.warn.some((line) => line.includes('已回退 standard')))
  assert.equal(registry.definitions[0].plugins.at(-1).config.agentPreset, 'standard')
  await ctx.dispose()
})

test('registry 中实际存在 deep-ptc 时，develop 使用 deep-ptc', async () => {
  const registry = createFakeRegistry({ rows: [{ id: 'deep-ptc' }] })
  const ctx = createFakeContext({
    registry,
    entries: [{ id: 'deep-ptc-settings', options: { name: 'dsh-deep-ptc-mode' }, fiber: { state: 1 } }],
  })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const definition = registry.definitions[0]
  const develop = definition.plugins.find((row) => row.id === 'tool-subagent-develop')
  assert.equal(develop.config.agentPreset, 'deep-ptc')
  assert.equal(definition.plugins.find((row) => row.id === 'tool-subagent-recon').config.agentPreset, 'standard')
  await ctx.dispose()
})

test('目录中没有目标 preset 时回退，不把 loader entry 当可用证据', async () => {
  const registry = createFakeRegistry({ rows: [] })
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({
    registry,
    webServer,
    // LOADING：深度 PTC 已安装并开始加载，但 preset 还没注册，不能据 entry 推断可用。
    entries: [{ id: 'deep-ptc-settings', options: { name: 'dsh-deep-ptc-mode' }, fiber: { state: 1 } }],
  })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const definition = registry.definitions[0]
  assert.equal(definition.plugins.find((row) => row.id === 'tool-subagent-develop').config.agentPreset, 'standard')
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.effectiveMode, 'standard')
  assert.equal(state.body.fallback.active, true)
  assert.match(state.body.fallback.reason, /没有可用的施工方式|未安装|未启用|已被移除/)
  assert.match(state.body.preset.description, /已回退 standard/)
  await ctx.dispose()
})

test('延迟复检可以在 registry 出现 deep-ptc 后把 develop 从 standard 提升到 deep-ptc', async () => {
  const registry = createFakeRegistry({ rows: [] })
  let listCalls = 0
  // 第一次探测时 registry 还没有 deep-ptc；延迟复检时已注册。
  registry.list = async () => {
    listCalls += 1
    return listCalls === 1 ? [] : [{ id: 'deep-ptc' }]
  }
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({
    registry,
    webServer,
    entries: [{ id: 'deep-ptc-settings', options: { name: 'dsh-deep-ptc-mode' }, fiber: { state: 1 } }],
  })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 300 })
  await ctx.flush()
  assert.equal(registry.definitions.length, 1)
  assert.equal(
    registry.definitions[0].plugins.find((row) => row.id === 'tool-subagent-develop').config.agentPreset,
    'standard',
  )

  // 深度 PTC 完成动态注册后，下一次延迟复检应释放旧定义并注册 deep-ptc 版本。
  await sleep(600)
  await ctx.flush()
  assert.ok(registry.definitions.length >= 2)
  const latest = registry.definitions.at(-1)
  assert.equal(latest.plugins.find((row) => row.id === 'tool-subagent-develop').config.agentPreset, 'deep-ptc')
  assert.equal(latest.plugins.find((row) => row.id === 'tool-subagent-recon').config.agentPreset, 'standard')
  assert.ok(registry.released.includes('dev-plan'))
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.effectiveMode, 'deep-ptc')
  assert.equal(state.body.fallback.active, false)
  await ctx.dispose()
})

test('同 effective/fallback 但回退原因变化时，重新发布 preset 描述', async () => {
  const registry = createFakeRegistry({ rows: [] })
  let listCalls = 0
  registry.list = async () => {
    listCalls += 1
    return [{ id: 'deep-ptc', broken: listCalls === 1 ? 'first failure' : 'second failure' }]
  }
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 300 })
  await ctx.flush()
  assert.equal(registry.definitions.length, 1)
  assert.match(registry.definitions[0].description, /first failure/)

  await sleep(600)
  await ctx.flush()
  assert.ok(registry.definitions.length >= 2)
  const latest = registry.definitions.at(-1)
  assert.match(latest.description, /second failure/)
  assert.doesNotMatch(latest.description, /first failure/)
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.effectiveMode, 'standard')
  assert.equal(state.body.fallback.active, true)
  assert.match(state.body.fallback.reason, /second failure/)
  assert.match(state.body.preset.description, /second failure/)
  await ctx.dispose()
})

test('config 路由：用 configEditor 写回，非法值 400 且不写', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const configEditor = createFakeConfigEditor()
  const ctx = createFakeContext({ registry, webServer, configEditor })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/config')

  const invalid = await callRoute(handler, 'POST', { modelGuardMode: 'kill' })
  assert.equal(invalid.code, 400)
  assert.equal(configEditor.edits.length, 0)

  const ok = await callRoute(handler, 'POST', {
    developMode: 'deep-ptc',
    childProvider: 'p',
    childModel: 'm',
    childReasoningEffort: 'high',
    modelGuardMode: 'audit',
    killOnViolation: false,
    honorExplicit: true,
    audit: false,
    guardAllSubagents: true,
  })
  assert.equal(ok.code, 200)
  assert.equal(configEditor.edits.length, 1)
  assert.deepEqual(configEditor.edits[0].next, {
    developMode: 'deep-ptc',
    childProvider: 'p',
    childModel: 'm',
    childReasoningEffort: 'high',
    modelGuardMode: 'audit',
    killOnViolation: false,
    honorExplicit: true,
    audit: false,
    guardAllSubagents: true,
  })
  assert.equal(ok.body.ok, true)
  await ctx.dispose()
})

test('模型守门 pin：子代理被 select，主会话完全不动', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-1', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'expensive', model: 'big' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const ctx = createFakeContext({ registry, agents })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const listener = ctx.listeners.get('agent/created')[0]
  assert.equal(typeof listener, 'function')

  listener({ agent: child.agent })
  assert.deepEqual(child.selects, [{ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }])
  assert.equal(child.stepHandlers.length, 1)

  listener({ agent: parent.agent })
  assert.deepEqual(parent.selects, [])
  assert.equal(parent.stepHandlers.length, 0)
  await ctx.dispose()
})

test('模型守门 pin：pre-step 越界在请求前 reject + cancel + 通知父会话', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-2', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'expensive', model: 'big' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, agents, webServer })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const listener = ctx.listeners.get('agent/created')[0]
  listener({ agent: child.agent })

  const next = async () => ({ kind: 'enter', messages: [] })
  const decision = await child.stepHandlers[0](
    { modelSelection: { provider: 'other', model: 'expensive' } },
    next,
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(child.cancelled.length, 1)
  assert.equal(parent.injected.length, 1)
  assert.match(parent.injected[0].content[0].text, /已中止/)

  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.violations.length, 1)
  assert.match(state.body.violations[0].text, /越界/)
  await ctx.dispose()
})

test('模型守门 audit：只记录，不 select、不打断', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-3', parentSession: 'main', origin: 'subagent', current: { provider: 'x', model: 'y' } })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, agents, webServer })
  index.apply(ctx.ctx, { ...base(), modelGuardMode: 'audit' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const listener = ctx.listeners.get('agent/created')[0]
  listener({ agent: child.agent })
  assert.deepEqual(child.selects, [])
  assert.equal(child.stepHandlers.length, 1)
  const decision = await child.stepHandlers[0](
    { modelSelection: { provider: 'x', model: 'y' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter')
  assert.equal(child.cancelled.length, 0)
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.violations.length, 1)
  await ctx.dispose()
})

test('模型守门 off：不注册监听、不 select、不检查', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-4', parentSession: 'main', origin: 'subagent' })
  const ctx = createFakeContext({ registry })
  index.apply(ctx.ctx, { ...base(), modelGuardMode: 'off' }, { verificationDelayMs: 0 })
  await ctx.flush()
  assert.equal(ctx.listeners.get('agent/created'), undefined)
  assert.deepEqual(child.selects, [])
  assert.equal(child.stepHandlers.length, 0)
  await ctx.dispose()
})

test('config 路由：拒绝 text/plain、cross-site、错误 Origin，且 configEditor 零写入', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const configEditor = createFakeConfigEditor()
  const ctx = createFakeContext({ registry, webServer, configEditor })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/config')

  const textPlain = await callRoute(handler, 'POST', { modelGuardMode: 'audit' }, { 'content-type': 'text/plain' })
  assert.equal(textPlain.code, 415)
  assert.equal(textPlain.body.code, 'unsupported-media-type')

  const crossSite = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
  )
  assert.equal(crossSite.code, 403)
  assert.equal(crossSite.body.code, 'forbidden-origin')

  const badOrigin = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:1162' },
  )
  assert.equal(badOrigin.code, 403)
  assert.equal(badOrigin.body.code, 'forbidden-origin')

  // DNS rebinding 形状：Origin 与 Host 同为攻击者域名，但不在实际监听 origin 上。
  const rebinding = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    { 'content-type': 'application/json', origin: 'http://evil.example:1162', host: 'evil.example:1162' },
  )
  assert.equal(rebinding.code, 403)
  assert.equal(rebinding.body.reason, 'origin-not-authoritative')

  const wrongPort = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    { 'content-type': 'application/json', origin: 'http://127.0.0.1:9999', host: '127.0.0.1:9999' },
  )
  assert.equal(wrongPort.code, 403)
  assert.equal(wrongPort.body.reason, 'origin-not-authoritative')

  const nonListening = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    { 'content-type': 'application/json', origin: 'http://10.1.2.3:1162', host: '10.1.2.3:1162' },
  )
  assert.equal(nonListening.code, 403)
  assert.equal(nonListening.body.reason, 'origin-not-authoritative')

  assert.equal(configEditor.edits.length, 0, '被拒绝的请求不得调用 configEditor')
  await ctx.dispose()
})

test('config 路由：允许同源、localhost/[::1] 同端口别名与无 Origin', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const configEditor = createFakeConfigEditor()
  const ctx = createFakeContext({ registry, webServer, configEditor })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/config')

  const sameOrigin = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    {
      'content-type': 'application/json; charset=utf-8',
      origin: 'http://127.0.0.1:1162',
      host: '127.0.0.1:1162',
      'sec-fetch-site': 'same-origin',
    },
  )
  assert.equal(sameOrigin.code, 200)
  assert.equal(configEditor.edits.length, 1)

  const localhostAlias = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    {
      'content-type': 'application/json',
      origin: 'http://localhost:1162',
      host: 'localhost:1162',
      'sec-fetch-site': 'same-origin',
    },
  )
  assert.equal(localhostAlias.code, 200)
  assert.equal(configEditor.edits.length, 2)

  const ipv6Alias = await callRoute(
    handler,
    'POST',
    { modelGuardMode: 'audit' },
    {
      'content-type': 'application/json',
      origin: 'http://[::1]:1162',
      host: '[::1]:1162',
      'sec-fetch-site': 'same-origin',
    },
  )
  assert.equal(ipv6Alias.code, 200)
  assert.equal(configEditor.edits.length, 3)

  const noOrigin = await callRoute(handler, 'POST', { modelGuardMode: 'audit' }, { 'content-type': 'application/json' })
  assert.equal(noOrigin.code, 200)
  assert.equal(configEditor.edits.length, 4)
  await ctx.dispose()
})

test('插件卸载时 guard 总 disposer 真正移除 child 的 pre-step handler', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-dispose', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.stepHandlers.length, 1)
  await ctx.dispose()
  assert.equal(child.stepHandlers.length, 0, '插件卸载后旧 guard 必须被移除')
})

test('agent/disposed 清理 guard，随后插件卸载保持幂等', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-agent-disposed', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.stepHandlers.length, 1)
  const disposed = ctx.listeners.get('agent/disposed')?.[0]
  assert.equal(typeof disposed, 'function')
  disposed({ agent: child.agent })
  assert.equal(child.stepHandlers.length, 0)
  await ctx.dispose()
  assert.equal(child.stepHandlers.length, 0)
})

test('modelGuardMode=off 不注册 agent/disposed', async () => {
  const ctx = createFakeContext({ registry: createFakeRegistry() })
  index.apply(ctx.ctx, { ...base(), modelGuardMode: 'off' }, { verificationDelayMs: 0 })
  await ctx.flush()
  assert.equal(ctx.listeners.get('agent/created'), undefined)
  assert.equal(ctx.listeners.get('agent/disposed'), undefined)
  await ctx.dispose()
})

test('模型守门 honorExplicit：显式路由不钉也不挂守卫', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({
    id: 'child-5',
    parentSession: 'main', origin: 'subagent',
    current: { provider: 'explicit', model: 'route' },
  })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const ctx = createFakeContext({ registry, agents })
  index.apply(ctx.ctx, { ...base(), honorExplicit: true }, { verificationDelayMs: 0 })
  await ctx.flush()
  const listener = ctx.listeners.get('agent/created')[0]
  listener({ agent: child.agent })
  assert.deepEqual(child.selects, [])
  // 尊重显式路由时不应再挂一个会立刻打断它的守卫。
  assert.equal(child.stepHandlers.length, 0)
  await ctx.dispose()
})

test('模型守门 pin + select 缺失 + kill=false：不 cancel，但保留守卫并记录后续越界', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({
    id: 'child-no-select',
    parentSession: 'main', origin: 'subagent',
    current: undefined,
    select: null,
  })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({
    registry,
    webServer,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, { ...base(), killOnViolation: false }, { verificationDelayMs: 0 })
  await ctx.flush()
  const listener = ctx.listeners.get('agent/created')[0]
  listener({ agent: child.agent })
  assert.equal(child.cancelled.length, 0)
  assert.equal(child.stepHandlers.length, 1, 'select 不可用时仍要装 pre-step 守卫')

  const decision = await child.stepHandlers[0](
    { modelSelection: { provider: 'other', model: 'expensive' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter')
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.ok(state.body.violations.some((entry) => /越界/.test(entry.text)))
  assert.ok(state.body.violations.some((entry) => /model\.select/.test(entry.text)))

  // 主会话仍然完全不受影响。
  listener({ agent: parent.agent })
  assert.equal(parent.selects.length, 0)
  assert.equal(parent.stepHandlers.length, 0)
  await ctx.dispose()
})

test('模型守门 pin + select 抛错 + kill=false：不 cancel，但保留守卫并记录后续越界', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({
    id: 'child-select-throws',
    parentSession: 'main', origin: 'subagent',
    current: undefined,
    select: () => {
      throw new Error('boom')
    },
  })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({
    registry,
    webServer,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, { ...base(), killOnViolation: false }, { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.cancelled.length, 0)
  assert.equal(child.stepHandlers.length, 1, 'select 抛错时仍要装 pre-step 守卫')

  const decision = await child.stepHandlers[0](
    { modelSelection: { provider: 'other', model: 'expensive' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.equal(decision.kind, 'enter')
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.ok(state.body.violations.some((entry) => /钉住子代理路由失败/.test(entry.text)))
  assert.ok(state.body.violations.some((entry) => /越界/.test(entry.text)))
  await ctx.dispose()
})

test('模型守门 pin + select 抛错 + kill=true：仍 cancel 并通知父会话', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({
    id: 'child-select-throws-kill',
    parentSession: 'main', origin: 'subagent',
    current: undefined,
    select: () => {
      throw new Error('boom')
    },
  })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.cancelled.length, 1)
  assert.equal(parent.injected.length, 1)
  assert.equal(child.stepHandlers.length, 1, 'cancel 前已装守卫，但子代理已被中止')
  await ctx.dispose()
})

test('childReasoningEffort 非空时进入 agentOptions 与守门目标', async () => {
  const settings = { ...base(), childReasoningEffort: 'high' }
  const definition = P.buildPresetDefinition({
    settings,
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const develop = definition.plugins.find((row) => row.id === 'tool-subagent-develop')
  assert.deepEqual(develop.config.agentOptions, {
    provider: 'dsh-opencode-go',
    model: 'deepseek-v4.1-flash',
    reasoningEffort: 'high',
  })

  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-6', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const ctx = createFakeContext({ registry, agents })
  index.apply(ctx.ctx, settings, { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.deepEqual(child.selects, [
    { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' },
  ])
  const next = async () => ({ kind: 'enter', messages: [] })
  const wrongEffort = await child.stepHandlers[0](
    { modelSelection: { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' } },
    next,
  )
  assert.deepEqual(wrongEffort, { kind: 'reject' })
  await ctx.dispose()
})

test('audit=false 不写审计日志，但越界仍进入 UI 记录', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({ id: 'child-7', parentSession: 'main', origin: 'subagent' })
  const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
  const agents = { get: (id) => (id === 'main' ? parent.agent : child.agent) }
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, agents, webServer })
  index.apply(ctx.ctx, { ...base(), audit: false }, { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  await child.stepHandlers[0](
    { modelSelection: { provider: 'x', model: 'y' } },
    async () => ({ kind: 'enter', messages: [] }),
  )
  assert.ok(!ctx.loggerCalls.info.some((line) => line.includes('audit')))
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.violations.length, 1)
  await ctx.dispose()
})

test('probePresets 返回真实目录：id/name/description/broken，并区分超时', async () => {
  const registry = createFakeRegistry({
    rows: [
      { id: 'standard', name: 'Standard' },
      { id: 'deep-ptc', name: '深度 PTC', description: 'PTC', broken: 'load failed' },
      { nonsense: true },
    ],
  })
  const ctx = createFakeContext({
    registry,
    entries: [{ id: 'ptc-row', options: { name: 'dsh-deep-ptc-mode' }, fiber: { state: 1 } }],
  })
  const probe = await index.probePresets(ctx.ctx, registry)
  assert.equal(probe.checked, true)
  assert.equal(probe.timedOut, false)
  assert.deepEqual(probe.rows.map((row) => row.id), ['standard', 'deep-ptc'])
  assert.equal(probe.rows[1].name, '深度 PTC')
  assert.equal(probe.rows[1].description, 'PTC')
  assert.equal(probe.rows[1].broken, 'load failed')

  const hanging = createFakeRegistry()
  hanging.list = () => new Promise(() => {})
  const timeoutCtx = createFakeContext({ registry: hanging })
  const timedOut = await index.probePresets(timeoutCtx.ctx, hanging)
  assert.equal(timedOut.checked, false)
  assert.equal(timedOut.timedOut, true)
  assert.deepEqual(timedOut.rows, [])
})

test('P0-1 风险分级：快速/标准/高风险 + 四维判定 + 快速路径不取消必做项', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  for (const marker of ['快速路径', '标准路径', '高风险路径', '歧义', '影响面', '可逆性', '可验证性']) {
    assert.ok(persona.includes(marker), `缺 P0-1 标记：${marker}`)
  }
  assert.match(persona, /快速路径不取消用户开工批准、developer 自验和主窗审查/)
  assert.match(persona, /只选一条最短安全路径，不固定跑瀑布/)
  // 证据不足只能升级风险/补证据，不能反向降级。
  assert.match(persona, /提高风险等级|升级到能补足证据/)
  assert.match(persona, /绝不因验证困难降低路径等级/)
  assert.doesNotMatch(persona, /降低路径等级并补验收/)
})

test('P0-2 一次性开工契约：字段齐全且普通实现不反复批准', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  for (const marker of [
    '一次性开工契约',
    '范围：',
    '非目标：',
    '允许路径：',
    '接口/依赖：',
    '验收条件：',
    '检查命令：',
    '风险/回退：',
  ]) {
    assert.ok(persona.includes(marker), `缺 P0-2 标记：${marker}`)
  }
  assert.match(persona, /普通文件编辑和实现细节不反复等待批准/)
  assert.match(persona, /只有范围扩大、风险变化或宿主权限要求/)
})

test('P0-3 验收前置：最小切片→语法/静态契约→针对性测试→必要运行/GUI，且静态不冒充真实验证', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  const ordered = ['最小切片', '语法/静态契约', '针对性测试', '必要运行/GUI 验收']
  let cursor = -1
  for (const marker of ordered) {
    const index = persona.indexOf(marker)
    assert.ok(index > cursor, `P0-3 顺序错误或缺标记：${marker}`)
    cursor = index
  }
  assert.match(persona, /静态检查不等于真实验证/)
  assert.match(persona, /verified \/ partial \/ failed \/ 未验证/)
})

test('P0-4 非阻塞协作：不轮询/不忙等/不重复施工/不重复读文件，developer 打断边界明确', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  for (const marker of ['非阻塞协作', '不轮询', '不忙等', '不重复施工', '不重复读取']) {
    assert.ok(persona.includes(marker), `缺 P0-4 标记：${marker}`)
  }
  assert.match(persona, /developer 只在阻塞、范围冲突或关键契约需要决策时打断主窗/)
  assert.match(persona, /验收准备、审查基线、资料研究、独立任务/)
})

test('P0-5 证据化审查与严重度返工：实际 diff、阻塞/非阻塞、最终责任不外包', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  for (const marker of ['实际 diff 和关键证据', '阻塞问题', '非阻塞建议', '主窗最终审查责任不外包']) {
    assert.ok(persona.includes(marker), `缺 P0-5 标记：${marker}`)
  }
  assert.match(persona, /send_message 续派同一 developer/)
  assert.match(persona, /不为一两条风格建议无限打磨/)
  assert.match(persona, /recon：只在缺少事实/)
  assert.match(persona, /review：只在高风险/)
  assert.match(persona, /scribe：只在文档属于验收范围/)
  // 实际变更证据闭环：摘要/文件清单不等于 diff 审查。
  for (const marker of ['实际变更证据', '不能只给文件清单', '不得声称审过实际 diff', '补证据']) {
    assert.ok(persona.includes(marker), `缺实际变更证据标记：${marker}`)
  }
  assert.match(persona, /git diff.*等价|等价.*git diff/s)
  assert.match(persona, /修改前后内容/)
  assert.doesNotMatch(persona, /只有改动摘要也算证据|只给文件清单(?:也)?可以/)
})

test('client 回退横幅涵盖不可用原因（中英文）', () => {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  for (const marker of ['已回退 standard', '未安装', '未启用', '已被移除', '加载失败']) {
    assert.ok(source.includes(marker), `client 回退横幅缺标记：${marker}`)
  }
  for (const marker of ['Fell back to standard', 'not installed', 'failed to load']) {
    assert.ok(source.includes(marker), `client 英文回退横幅缺标记：${marker}`)
  }
  // 目录超时同样要有可理解状态，而不是伪装成正常。
  for (const marker of ['施工方式列表读取超时', 'setup list timed out']) {
    assert.ok(source.includes(marker), `client 缺少目录超时状态：${marker}`)
  }
})

test('派工事实：实际 develop/send_message 工具调用才是派工，文本不算', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const personaRow = definition.plugins.find((row) => row.id === 'persona')
  const persona = `${personaRow.config.prefix}${personaRow.config.suffix}`
  for (const marker of [
    '文本不是派工',
    '必须实际调用 develop',
    '只有工具接受后才可说“已派出 developer”',
    '未派工',
    '任务书是 develop 的 prompt 参数',
    '不得停在计划、前言或任务书文本',
    '实际调用 send_message',
  ]) {
    assert.ok(persona.includes(marker), `缺派工事实标记：${marker}`)
  }
  assert.doesNotMatch(persona, /文本也能算派工|没有调用也可以说已派出|文本任务书即视为已派工/)
})

test('插件显示名带模式，预设名保持开发规划与交付', () => {
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale/zh.json'), 'utf8'))
  const en = JSON.parse(readFileSync(join(ROOT, 'locale/en.json'), 'utf8'))
  assert.equal(zh.meta.title, '开发规划与交付模式')
  assert.equal(en.meta.title, 'Development planning & delivery Mode')
  assert.ok(zh.meta.title.endsWith('模式'))
  assert.ok(en.meta.title.endsWith('Mode'))
  assert.equal(P.PRESET_NAME, '开发规划与交付')

  const client = readFileSync(join(ROOT, 'client.js'), 'utf8')
  assert.ok(client.includes('开发规划与交付 · 施工设置'))
  assert.ok(!client.includes('开发规划与交付模式 · 施工设置'), '设置页标题应继续使用 preset 名')

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.ok(readme.includes('开发规划与交付模式'))
  assert.ok(readme.includes('preset 名称仍是「开发规划与交付」'))
  assert.ok(readme.includes('显示名已定'))
  assert.ok(!readme.includes('显示名未定'))
  assert.ok(!readme.includes('界面名称仍是「开发规划」'))
})

test('guard 只认子代理 header：fork 主对话（parentSession + depth 0）不算', () => {
  assert.equal(guard.isSubagentHeader(undefined), false)
  assert.equal(guard.isSubagentHeader({}), false)
  assert.equal(guard.isSubagentHeader({ origin: 'user' }), false)
  // 宿主真实 fork 主对话形状：有 parentSession、isSeeded、delegationDepth:0、无 origin。
  assert.equal(guard.isSubagentHeader({ parentSession: 'main' }), false)
  assert.equal(guard.isSubagentHeader({ parentSession: 'main', isSeeded: true, delegationDepth: 0 }), false)
  assert.equal(guard.isSubagentHeader({ origin: 'subagent' }), true)
  assert.equal(guard.isSubagentHeader({ parentSession: 'main', delegationDepth: 1 }), true)
  assert.equal(guard.isSubagentHeader({ delegationDepth: 0, origin: 'subagent' }), true)
  assert.equal(guard.isSubagentHeader({ delegationDepth: '1' }), false)
})

test('fork 形主对话在 guardAllSubagents true/false 下都不 select、不挂 pre-step', async () => {
  for (const global of [false, true]) {
    const registry = createFakeRegistry()
    const fork = createFakeAgent({
      id: 'fork-main',
      parentSession: 'main',
      isSeeded: true,
      delegationDepth: 0,
      current: undefined,
    })
    const parent = createFakeAgent({
      id: 'main',
      agentPreset: 'dev-plan',
      current: { provider: 'p', model: 'm' },
    })
    const ctx = createFakeContext({
      registry,
      agents: { get: (id) => (id === 'main' ? parent.agent : fork.agent) },
    })
    index.apply(ctx.ctx, { ...base(), guardAllSubagents: global }, { verificationDelayMs: 0 })
    await ctx.flush()
    const listener = ctx.listeners.get('agent/created')[0]
    listener({ agent: fork.agent })
    assert.deepEqual(fork.selects, [], 'fork 主对话不得被 select（global=' + global + '）')
    assert.equal(fork.stepHandlers.length, 0, 'fork 主对话不得挂 pre-step（global=' + global + '）')
    listener({ agent: parent.agent })
    assert.equal(parent.stepHandlers.length, 0, '主会话永不守门')
    await ctx.dispose()
  }
})

test('delegationDepth>0 的真正子代理仍按 dev-plan 范围守门', async () => {
  const registry = createFakeRegistry()
  const child = createFakeAgent({
    id: 'child-depth',
    parentSession: 'main',
    delegationDepth: 1,
    current: undefined,
  })
  const parent = createFakeAgent({
    id: 'main',
    agentPreset: 'dev-plan',
    current: { provider: 'p', model: 'm' },
  })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.selects.length, 1)
  assert.equal(child.stepHandlers.length, 1)
  await ctx.dispose()
})

test('任意有效 develop preset：不再限于 standard/deep-ptc', () => {
  const mode = P.resolveDevelopMode({
    requestedMode: 'team-builder',
    presets: [{ id: 'team-builder', name: '团队施工' }],
    catalogChecked: true,
  })
  assert.equal(mode.effective, 'team-builder')
  assert.equal(mode.fallback, false)
  const definition = P.buildPresetDefinition({ settings: base(), mode })
  const develop = definition.plugins.find((row) => row.id === 'tool-subagent-develop')
  assert.equal(develop.config.agentPreset, 'team-builder')
  assert.match(definition.description, /团队施工/)
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  assert.match(persona, /当前施工子代理模式：团队施工（team-builder）/)
})

test('自引用与缺失/超时：保留配置原值，运行期回退 standard', async () => {
  const selfMode = P.resolveDevelopMode({
    requestedMode: 'dev-plan',
    presets: [{ id: 'dev-plan', name: '开发规划与交付' }],
    catalogChecked: true,
  })
  assert.equal(selfMode.fallback, true)
  assert.match(selfMode.reason, /递归派工/)

  const missing = P.resolveDevelopMode({
    requestedMode: 'removed-preset',
    presets: [],
    catalogChecked: true,
  })
  assert.equal(missing.requested, 'removed-preset')
  assert.equal(missing.effective, 'standard')
  assert.equal(missing.fallback, true)

  const registry = createFakeRegistry({ rows: [] })
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, { ...base(), developMode: 'removed-preset' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  // 配置原值不被静默改写；只有运行期 effective 回退。
  assert.equal(state.body.config.developMode, 'removed-preset')
  assert.equal(state.body.requestedMode, 'removed-preset')
  assert.equal(state.body.effectiveMode, 'standard')
  assert.equal(state.body.fallback.active, true)
  assert.equal(
    registry.definitions[0].plugins.find((row) => row.id === 'tool-subagent-develop').config.agentPreset,
    'standard',
  )
  await ctx.dispose()
})

test('预设目录超时：显式回退并保留 timedOut，供 UI 提示', async () => {
  const registry = createFakeRegistry()
  registry.list = () => new Promise(() => {})
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, { ...base(), developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
  await ctx.flush()
  // probe 会等满 MAX_PROBE_MS，再发布回退结果。
  await sleep(1400)
  await ctx.flush()
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.effectiveMode, 'standard')
  assert.equal(state.body.fallback.active, true)
  assert.equal(state.body.presets.checked, false)
  assert.equal(state.body.presets.timedOut, true)
  assert.match(state.body.fallback.reason, /尚未就绪|读取超时/)
  await ctx.dispose()
})

test('模型目录：枚举 provider/model，单个 provider 失败只局部降级', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const llm = {
    listProviders: () => [
      { id: 'alpha', name: 'Alpha 服务商' },
      { id: 'broken', name: 'Broken 服务商' },
    ],
    listModels: async (id) => {
      if (id === 'broken') throw new Error('missing credentials')
      return [
        { id: 'alpha-1', name: 'Alpha 一号' },
        { id: 'alpha-2' },
      ]
    },
  }
  const ctx = createFakeContext({ registry, webServer, llm })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/state')
  // 第一次 /state 只返回快照并启动后台刷新；第二次读到刷新结果。
  const first = await callRoute(handler, 'GET')
  assert.equal(first.body.modelCatalog.checked, false)
  await sleep(0)
  await ctx.flush()
  const state = await callRoute(handler, 'GET')
  assert.equal(state.body.modelCatalog.checked, true)
  assert.deepEqual(
    state.body.modelCatalog.providers.map((item) => [item.provider, item.models.map((m) => m.model)]),
    [
      ['alpha', ['alpha-1', 'alpha-2']],
      ['broken', []],
    ],
  )
  assert.deepEqual(state.body.modelCatalog.failures.map((item) => item.provider), ['broken'])
  assert.match(state.body.modelCatalog.failures[0].message, /missing credentials/)
  assert.equal(state.body.modelCatalog.providers[0].models[0].name, 'Alpha 一号')
  await ctx.dispose()
})

test('模型目录失败与旧路由：目录不可用时不改旧值，也不伪装成目录正常', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const configEditor = createFakeConfigEditor()
  const llm = {
    listProviders: () => {
      throw new Error('catalog exploded')
    },
    listModels: async () => [],
  }
  const ctx = createFakeContext({ registry, webServer, configEditor, llm })
  index.apply(
    ctx.ctx,
    { ...base(), childProvider: 'legacy-provider', childModel: 'legacy-model' },
    { verificationDelayMs: 0 },
  )
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/state')
  await callRoute(handler, 'GET')
  await sleep(0)
  await ctx.flush()
  const state = await callRoute(handler, 'GET')
  assert.equal(state.body.modelCatalog.checked, false)
  assert.match(state.body.modelCatalog.error, /catalog exploded/)
  assert.equal(state.body.config.childProvider, 'legacy-provider')
  assert.equal(state.body.config.childModel, 'legacy-model')
  assert.equal(state.body.route.provider, 'legacy-provider')
  assert.equal(state.body.route.model, 'legacy-model')

  // 目录失败不会把旧值改成默认值：原样提交视为 unchanged，不触发写回。
  const unchanged = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/config'), 'POST', {
    childProvider: 'legacy-provider',
    childModel: 'legacy-model',
    childReasoningEffort: '',
  })
  assert.equal(unchanged.code, 200)
  assert.equal(unchanged.body.unchanged, true)
  assert.equal(configEditor.edits.length, 0)

  // 用户明确改成另一组值时仍可保存，且不会因目录失败被拒绝或改写。
  const saved = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/config'), 'POST', {
    childProvider: 'other-provider',
    childModel: 'other-model',
    childReasoningEffort: '',
  })
  assert.equal(saved.code, 200)
  assert.equal(configEditor.edits.length, 1)
  assert.equal(configEditor.edits[0].next.childProvider, 'other-provider')
  await ctx.dispose()
})

test('守门范围矩阵：默认只守 dev-plan 父会话，global 开关恢复全局，主会话永不守', async () => {
  const scenarios = [
    { name: 'dev-plan 父会话', parentPreset: 'dev-plan', global: false, guarded: true },
    { name: '非 dev-plan 父会话', parentPreset: 'standard', global: false, guarded: false },
    { name: '父会话 preset 未知', parentPreset: undefined, global: false, guarded: false },
    { name: '非 dev-plan + global', parentPreset: 'standard', global: true, guarded: true },
    { name: 'dev-plan + global', parentPreset: 'dev-plan', global: true, guarded: true },
  ]
  for (const scenario of scenarios) {
    const registry = createFakeRegistry()
    const child = createFakeAgent({ id: 'child', parentSession: 'main', origin: 'subagent', current: undefined })
    const parent = createFakeAgent({
      id: 'main',
      agentPreset: scenario.parentPreset,
      current: { provider: 'p', model: 'm' },
    })
    const ctx = createFakeContext({
      registry,
      agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
    })
    index.apply(ctx.ctx, { ...base(), guardAllSubagents: scenario.global }, { verificationDelayMs: 0 })
    await ctx.flush()
    ctx.listeners.get('agent/created')[0]({ agent: child.agent })
    assert.equal(
      child.stepHandlers.length,
      scenario.guarded ? 1 : 0,
      `${scenario.name} 的守门范围错误`,
    )
    await ctx.dispose()
  }

  // registry.presetForSession 优先于 header，且主会话即使 global 也不守。
  const registry = createFakeRegistry({ presetForSession: () => 'dev-plan' })
  const child = createFakeAgent({
    id: 'child-priority',
    parentSession: 'main', origin: 'subagent',
    current: undefined,
  })
  const parent = createFakeAgent({
    id: 'main',
    agentPreset: 'standard',
    current: { provider: 'p', model: 'm' },
  })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.stepHandlers.length, 1, 'presetForSession 应优先于 header')
  assert.equal(parent.stepHandlers.length, 0, '主会话永不守门')
  await ctx.dispose()
})

test('施工目录/权限规则写入主代理 persona', () => {
  const definition = P.buildPresetDefinition({
    settings: base(),
    mode: P.resolveDevelopMode({ requestedMode: 'standard' }),
  })
  const persona = definition.plugins.find((row) => row.id === 'persona').config.prefix
  for (const marker of [
    '施工目录与权限',
    '工具创建参数',
    'cwd',
    '可写工作区',
    '不得先以其他目录 spawn',
    'working_directory / cd',
    '不假设已有子代理权限会随之扩大',
    '沙箱模式',
    '真实错误原文',
  ]) {
    assert.ok(persona.includes(marker), `缺权限防护标记：${marker}`)
  }
  assert.match(persona, /目标目录不在可写范围/)
  assert.match(persona, /停止派工/)
})

test('设置页契约：动态预设/模型下拉、原生控件、label 关联与守门范围开关', () => {
  const source = readFileSync(join(ROOT, 'client.js'), 'utf8')
  for (const marker of [
    'state.presets',
    'presetRows',
    'state.modelCatalog',
    'providers',
    'guardAllSubagents',
    'htmlFor',
    'aria-describedby',
    'fieldset',
    'legend',
    "type: 'button'",
    '同时管理其他插件的子代理',
    '服务商',
    '模型',
  ]) {
    assert.ok(source.includes(marker), `设置页缺契约标记：${marker}`)
  }
  // 不再硬编码 deep-ptc 选项，也不再使用自由文本 provider/model 输入。
  assert.ok(!source.includes("value: 'deep-ptc'"), '不应硬编码 deep-ptc 选项')
  assert.ok(!/childProvider:\s*'\s*'/.test(source), '不应把 provider 当自由文本初始化')
  assert.ok(!source.includes('configEditor'), '普通文案不应出现 configEditor')
  assert.ok(!source.includes('reasoningEffort（可空）'), '不应把 reasoningEffort 当主标签')
  assert.ok(!/onChange:\s*save/.test(source), '选择变化不得自动保存')
})

test('state 返回真实预设目录：名称、broken 与自定义预设生效', async () => {
  const registry = createFakeRegistry({
    rows: [
      { id: 'dev-plan', name: '开发规划与交付' },
      { id: 'team-builder', name: '团队施工', description: '团队预设' },
      { id: 'broken-preset', name: '损坏预设', broken: 'import failed' },
    ],
  })
  const webServer = createFakeWebServer()
  const ctx = createFakeContext({ registry, webServer })
  index.apply(ctx.ctx, { ...base(), developMode: 'team-builder' }, { verificationDelayMs: 0 })
  await ctx.flush()
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(state.body.effectiveMode, 'team-builder')
  assert.equal(state.body.modeName, '团队施工')
  assert.deepEqual(state.body.presets.rows.map((row) => row.id), ['dev-plan', 'team-builder', 'broken-preset'])
  assert.equal(state.body.presets.rows[1].name, '团队施工')
  assert.equal(state.body.presets.rows[2].broken, 'import failed')
  assert.equal(
    registry.definitions[0].plugins.find((row) => row.id === 'tool-subagent-develop').config.agentPreset,
    'team-builder',
  )
  await ctx.dispose()

  const brokenRegistry = createFakeRegistry({
    rows: [{ id: 'broken-preset', name: '损坏预设', broken: 'import failed' }],
  })
  const brokenWeb = createFakeWebServer()
  const brokenCtx = createFakeContext({ registry: brokenRegistry, webServer: brokenWeb })
  index.apply(brokenCtx.ctx, { ...base(), developMode: 'broken-preset' }, { verificationDelayMs: 0 })
  await brokenCtx.flush()
  const brokenState = await callRoute(brokenWeb.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  assert.equal(brokenState.body.effectiveMode, 'standard')
  assert.equal(brokenState.body.fallback.active, true)
  assert.match(brokenState.body.fallback.reason, /加载失败/)
  assert.equal(brokenState.body.config.developMode, 'broken-preset')
  await brokenCtx.dispose()
})

test('presetForSession 返回 null 时回退 header.agentPreset 判断守门范围', async () => {
  const registry = createFakeRegistry({ presetForSession: () => null })
  const child = createFakeAgent({ id: 'child-fallback', parentSession: 'main', origin: 'subagent', current: undefined })
  const parent = createFakeAgent({
    id: 'main',
    agentPreset: 'dev-plan',
    current: { provider: 'p', model: 'm' },
  })
  const ctx = createFakeContext({
    registry,
    agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
  })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  ctx.listeners.get('agent/created')[0]({ agent: child.agent })
  assert.equal(child.stepHandlers.length, 1, 'header.agentPreset=dev-plan 时应守门')
  await ctx.dispose()
})

test('模型目录刷新不阻塞 /state：慢 provider 下状态立即返回快照', async () => {
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const llm = {
    listProviders: () => [{ id: 'slow', name: 'Slow' }],
    listModels: () => new Promise(() => {}),
  }
  const ctx = createFakeContext({ registry, webServer, llm })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0 })
  await ctx.flush()
  const started = Date.now()
  const state = await callRoute(webServer.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
  const elapsed = Date.now() - started
  assert.ok(elapsed < 500, `/state 不应等待 listModels，实际 ${elapsed}ms`)
  assert.equal(state.body.modelCatalog.checked, false)
  assert.equal(state.body.modelCatalog.providers.length, 0)
  await ctx.dispose()
})

test('设置页静置 60s：模型全量枚举至多 2 次（初始 + 一次刷新）', async () => {
  let clock = 0
  let listCalls = 0
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const llm = {
    listProviders: () => [{ id: 'p', name: 'P' }],
    listModels: async () => {
      listCalls += 1
      return [{ id: 'm', name: 'M' }]
    },
  }
  const ctx = createFakeContext({ registry, webServer, llm })
  index.apply(ctx.ctx, base(), { verificationDelayMs: 0, now: () => clock })
  await ctx.flush()
  const handler = webServer.handlers.get('/plugins/dev-plan-presets/state')

  await callRoute(handler, 'GET')
  await sleep(0)
  await ctx.flush()
  assert.equal(listCalls, 1, '首次 /state 应触发一次初始枚举')

  for (let t = 4000; t <= 56000; t += 4000) {
    clock = t
    await callRoute(handler, 'GET')
    await sleep(0)
    await ctx.flush()
    assert.equal(listCalls, 1, `t=${t}ms 时不应重复全量枚举`)
  }

  clock = 60000
  await callRoute(handler, 'GET')
  await sleep(0)
  await ctx.flush()
  assert.equal(listCalls, 2, '60s 时应至多刷新一次')
  await ctx.dispose()
})

test('client 行为：broken/自身/旧值禁用，确实来自真实 client 纯函数', async () => {
  const api = await loadClientTestApi()
  const T = (cn) => cn
  const choices = api.presetChoices(
    [
      { id: 'dev-plan', name: '开发规划与交付' },
      { id: 'broken-preset', name: '损坏方式', broken: 'import failed' },
      { id: 'team-builder', name: '团队施工' },
    ],
    'broken-preset',
    'dev-plan',
    T,
  )
  const byValue = Object.fromEntries(choices.map((choice) => [choice.value, choice]))
  assert.equal(byValue.standard.disabled, undefined)
  assert.equal(byValue['dev-plan'].disabled, true, 'dev-plan 自身必须禁用')
  assert.equal(byValue['broken-preset'].disabled, true, 'broken 项必须禁用')
  assert.equal(byValue['team-builder'].disabled, undefined)
  assert.match(byValue['broken-preset'].label, /不可用/)
  assert.match(byValue['dev-plan'].label, /不能选自己/)

  const legacy = api.presetChoices([{ id: 'team-builder', name: '团队施工' }], 'removed-preset', 'dev-plan', T)
  assert.equal(legacy.find((choice) => choice.value === 'removed-preset').disabled, true)
})

test('client 行为：provider→model 联动取首个模型，旧 provider/model 禁用', async () => {
  const api = await loadClientTestApi()
  const T = (cn) => cn
  const providers = [
    { provider: 'alpha', name: 'Alpha', models: [{ model: 'a1', name: 'A1' }, { model: 'a2' }] },
    { provider: 'beta', name: 'Beta', models: [{ model: 'b1' }] },
  ]
  assert.equal(api.firstModelOf(providers, 'beta'), 'b1')
  assert.equal(api.firstModelOf(providers, 'missing'), '')

  const providerOptions = api.providerChoices(providers, 'legacy', T)
  assert.equal(providerOptions.find((choice) => choice.value === 'legacy').disabled, true)
  assert.equal(providerOptions.find((choice) => choice.value === 'alpha').label, 'Alpha（alpha）')

  const modelOptions = api.modelChoices(providers[0].models, 'gone', T)
  assert.equal(modelOptions.find((choice) => choice.value === 'gone').disabled, true)
  assert.equal(modelOptions.find((choice) => choice.value === 'a1').label, 'A1（a1）')
})
