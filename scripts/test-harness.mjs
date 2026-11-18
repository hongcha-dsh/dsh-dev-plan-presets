/**
 * 测试夹具：不启动 DSH、不读 profile，只用最小 Cordis 形状驱动真实插件代码。
 *
 * 覆盖的是“代码真的会做什么”：
 *   - apply() 是否真的注册了 preset、是否交还 disposer；
 *   - agent/created 是否只碰子代理；
 *   - agent/pre-step 越界是否 reject + cancel + 通知父会话；
 *   - HTTP 设置路由是否真的读写配置；
 *   - 回退是否真的写进 description/persona。
 */

import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 加载真实模块（每次带 cache-bust，避免多测试互相污染）。 */
export async function loadModules(root) {
  const stamp = `?test=${Date.now()}-${Math.random().toString(36).slice(2)}`
  const url = (file) => pathToFileURL(join(root, file)).href + stamp
  return {
    settings: await import(url('settings.js')),
    preset: await import(url('preset.js')),
    guard: await import(url('guard.js')),
    index: await import(url('index.js')),
  }
}

const noopLogger = () => ({ warn() {}, info() {}, error() {} })

/**
 * 创建最小 Context。
 * @param {object} options
 * @param {any} [options.config]
 * @param {any[]} [options.entries] loader entries
 * @param {any} [options.registry] agentPresets
 * @param {any} [options.agents] ctx.get('agents')
 * @param {any} [options.configEditor]
 * @param {any} [options.webServer]
 */
export function createFakeContext(options = {}) {
  const disposers = []
  const pending = []
  const listeners = new Map()
  const injectQueue = []
  const loggerCalls = { info: [], warn: [], error: [] }
  const logger = options.logger ?? {
    info: (...args) => loggerCalls.info.push(args.map(String).join(' ')),
    warn: (...args) => loggerCalls.warn.push(args.map(String).join(' ')),
    error: (...args) => loggerCalls.error.push(args.map(String).join(' ')),
  }
  const services = new Map()
  if (options.registry) services.set('agentPresets', options.registry)
  if (options.agents) services.set('agents', options.agents)
  if (options.configEditor) services.set('configEditor', options.configEditor)
  if (options.webServer) services.set('webServer', options.webServer)
  if (options.llm) services.set('llm', options.llm)

  const context = {
    logger,
    fiber: { entry: options.entry ?? { id: 'dev-plan-presets', options: { config: options.config } } },
    loader: { entries: () => options.entries ?? [] },
    get(name) {
      return services.get(name)
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
      const off = () => {
        const current = listeners.get(event) ?? []
        const index = current.indexOf(handler)
        if (index >= 0) current.splice(index, 1)
      }
      disposers.push(off)
      return off
    },
    effect(body) {
      let result
      try {
        result = body()
      } catch {
        return () => {}
      }
      if (result && typeof result.then === 'function') {
        pending.push(result)
        result.then((dispose) => {
          if (typeof dispose === 'function') disposers.push(dispose)
        })
        return () => {}
      }
      if (result && typeof result[Symbol.iterator] === 'function' && typeof result !== 'function') {
        const yielded = []
        try {
          for (const dispose of result) if (typeof dispose === 'function') yielded.push(dispose)
        } catch {
          /* ignore */
        }
        disposers.push(() => {
          for (const dispose of yielded.reverse()) dispose()
        })
        return () => {}
      }
      if (typeof result === 'function') {
        disposers.push(result)
        return result
      }
      return () => {}
    },
    inject(deps = [], callback) {
      const run = (child) => {
        try {
          callback(child)
        } catch (error) {
          loggerCalls.error.push(String(error?.message ?? error))
        }
      }
      const ready = deps.every((dep) => services.has(dep))
      if (ready) {
        const child = makeChild(context, services, deps)
        run(child)
        return () => {}
      }
      injectQueue.push({ deps, run, services })
      return () => {}
    },
    provide(name, service) {
      services.set(name, service)
      for (const item of [...injectQueue]) {
        if (item.deps.every((dep) => item.services.has(dep))) {
          injectQueue.splice(injectQueue.indexOf(item), 1)
          item.run(makeChild(context, item.services, item.deps))
        }
      }
    },
  }

  return {
    ctx: context,
    services,
    loggerCalls,
    listeners,
    effects: disposers,
    async flush() {
      for (let round = 0; round < 6; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, 0))
        const settled = [...pending]
        pending.length = 0
        await Promise.allSettled(settled)
      }
    },
    async dispose() {
      for (const dispose of disposers.reverse()) {
        try {
          await dispose()
        } catch {
          /* cleanup best effort */
        }
      }
    },
  }
}

function makeChild(parent, services, deps) {
  const child = Object.create(parent)
  for (const dep of deps) {
    if (dep === 'agentPresets') child.agentPresets = services.get(dep)
    if (dep === 'webServer') child.webServer = services.get(dep)
  }
  return child
}

export function createFakeRegistry({ rows = [], registerError, presetForSession } = {}) {
  return {
    definitions: [],
    released: [],
    rows,
    async list() {
      return this.rows
    },
    async register(definition) {
      if (registerError) throw registerError
      this.definitions.push(definition)
      return async () => {
        this.released.push(definition.id)
      }
    },
    presetForSession(session) {
      if (typeof presetForSession === 'function') return presetForSession(session)
      return session?.header?.agentPreset ?? null
    },
  }
}

export function createFakeConfigEditor() {
  return {
    edits: [],
    async edit(entry, change) {
      const next = change({}, {})
      this.edits.push({ entry, next })
    },
  }
}

export function createFakeWebServer(options = {}) {
  const handlers = new Map()
  const origin = options.origin ?? 'http://127.0.0.1:1162'
  return {
    handlers,
    getOrigin() {
      return origin
    },
    register(route) {
      handlers.set(route.path, route.handler)
      return () => handlers.delete(route.path)
    },
  }
}

export function createFakeAgent(options = {}) {
  const selects = []
  const cancelled = []
  const injected = []
  const stepHandlers = []
  const agentEffects = []
  const header = {}
  if (options.parentSession) header.parentSession = options.parentSession
  if (options.origin) header.origin = options.origin
  if (options.agentPreset) header.agentPreset = options.agentPreset
  if (options.delegationDepth !== undefined) header.delegationDepth = options.delegationDepth
  if (options.isSeeded !== undefined) header.isSeeded = options.isSeeded
  const model = { current: () => options.current }
  if (options.select !== null) {
    model.select = options.select ?? ((route) => selects.push({ ...route }))
  }
  const agent = {
    id: options.id ?? 'child-1',
    session: { id: `session-${options.id ?? 'child-1'}`, header },
    model,
    cancel: (cause) => cancelled.push(cause),
    inject: (message) => injected.push(message),
    ctx: {
      on(event, handler) {
        if (event === 'agent/pre-step') stepHandlers.push(handler)
        return () => {
          const index = stepHandlers.indexOf(handler)
          if (index >= 0) stepHandlers.splice(index, 1)
        }
      },
      effect(body) {
        const result = body()
        if (typeof result === 'function') agentEffects.push(result)
        return result
      },
    },
  }
  return { agent, selects, cancelled, injected, stepHandlers, agentEffects }
}

/** 构造一个只实现 state/config 路由所需的 req/res。 */
export async function callRoute(handler, method, body, headers = {}) {
  return await new Promise((resolve, reject) => {
    const res = {
      code: 200,
      headers: {},
      writeHead(code, headers) {
        this.code = code
        this.headers = headers ?? {}
      },
      end(payload) {
        try {
          resolve({ code: this.code, headers: this.headers, body: payload ? JSON.parse(payload) : null })
        } catch (error) {
          reject(error)
        }
      },
    }
    const requestHeaders = { ...headers }
    // 大多数测试提交 JSON；显式传 headers 可覆盖为 text/plain 等。
    if (body !== undefined && requestHeaders['content-type'] === undefined) {
      requestHeaders['content-type'] = 'application/json'
    }
    const req = {
      method,
      headers: requestHeaders,
      async *[Symbol.asyncIterator]() {
        if (body !== undefined) yield typeof body === 'string' ? body : JSON.stringify(body)
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}
