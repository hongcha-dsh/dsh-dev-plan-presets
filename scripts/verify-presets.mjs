#!/usr/bin/env node
/**
 * verify-presets.mjs — 纯静态自检（不启动 DSH、不写任何文件）
 *
 * 检查的是「声明层面」的合同：三份 preset 存在、id/order 对、工具面符合设计、
 * 子代理路由与 preset 绑定正确、persona 不含未注册变量、打包清单覆盖补丁文件。
 *
 * 它不能证明运行期行为（preset 是否真的出现在选择器、子代理是否真的用低成本模型、
 * 全局插件是否注入了额外工具）。那部分见 README「验证」里的手工验收清单。
 *
 * 用法：
 *   node scripts/verify-presets.mjs
 *   node scripts/verify-presets.mjs --verbose
 *
 * 依赖：js-yaml。优先从本机 DSH profile 的 node_modules 借用（DSH 自带），
 * 找不到时提示安装：npm i -D js-yaml
 */

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')

let failures = 0
let passes = 0

function check(ok, label, detail = '') {
  if (ok) {
    passes += 1
    if (VERBOSE) console.log(`PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    failures += 1
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function loadYaml() {
  const homes = [process.env.DSH_HOME, 'D:\\DSH-Home', join(process.env.USERPROFILE ?? '', '.dsh')]
    .filter((h) => typeof h === 'string' && h.length > 0)
  const candidates = []
  for (const home of homes) {
    candidates.push(join(home, 'profiles', 'desktop', 'package.json'))
    candidates.push(join(home, 'profiles', 'desktop', 'node_modules', 'js-yaml', 'package.json'))
  }
  for (const candidate of candidates) {
    try {
      const req = createRequire(pathToFileURL(candidate).href)
      return req('js-yaml')
    } catch {
      // 继续找下一个
    }
  }
  try {
    return createRequire(pathToFileURL(join(ROOT, 'package.json')).href)('js-yaml')
  } catch {
    console.error('无法加载 js-yaml。请在本插件目录执行：npm i -D js-yaml')
    process.exit(2)
  }
}

const yaml = loadYaml()
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8')
const pkg = JSON.parse(read('package.json'))

// ── 1. 打包合同 ──────────────────────────────────────────────────────────────
check(pkg.name === 'dsh-dev-plan-presets', 'package.json name', pkg.name)
check(pkg.version === '0.1.0', 'package.json version', pkg.version)
check(pkg.private === true, 'package.json private=true')
check(pkg.type === 'module', 'package.json type=module')
check(pkg.exports?.['.'] === './index.js', 'exports["."] 指向 index.js')
check(typeof pkg.exports?.['./presets/*.patch.yml'] === 'string', 'exports 暴露 presets/*.patch.yml')

const patchList = pkg.dsh?.bundle?.patch
check(Array.isArray(patchList) && patchList.length === 4, 'dsh.bundle.patch 是含 4 个补丁的数组', JSON.stringify(patchList))

const filesPatterns = pkg.files ?? []
const covered = (rel) =>
  filesPatterns.some((pattern) => {
    if (!pattern.includes('*')) return pattern === rel
    const prefix = pattern.slice(0, pattern.indexOf('*'))
    return rel.startsWith(prefix)
  })
for (const rel of patchList ?? []) {
  check(existsSync(join(ROOT, rel)), `补丁文件存在：${rel}`)
  check(covered(rel.replace(/^\.\//, '')), `files 覆盖：${rel}`)
}
for (const rel of ['index.js', 'README.md', 'detail.md', 'icon.svg', 'locale/zh.json', 'locale/en.json']) {
  check(existsSync(join(ROOT, rel)), `文件存在：${rel}`)
  check(covered(rel), `files 覆盖：${rel}`)
}

// ── 2. 解析补丁 ──────────────────────────────────────────────────────────────
const patches = []
for (const rel of patchList ?? []) {
  let rows
  try {
    rows = yaml.load(read(rel), { schema: yaml.DEFAULT_SCHEMA })
  } catch (error) {
    check(false, `YAML 可解析：${rel}`, error instanceof Error ? error.message : String(error))
    continue
  }
  check(Array.isArray(rows), `YAML 顶层是数组：${rel}`)
  patches.push(...(Array.isArray(rows) ? rows : []))
}

const insertedRows = []
for (const row of patches) {
  if (Array.isArray(row?.insert)) insertedRows.push(...row.insert)
  else insertedRows.push(row)
}

const presetRows = insertedRows.filter((row) => row?.name === '@deepseek-ai/dsh-agent-preset')
const presets = new Map()
for (const row of presetRows) {
  const id = row?.config?.id
  check(typeof id === 'string' && id.length > 0, 'preset 声明有 config.id', String(id))
  if (typeof id === 'string') presets.set(id, row.config)
}
check(presets.size === 3, '恰好声明 3 个 preset', [...presets.keys()].join(', '))
for (const id of ['dev-plan', 'scout', 'scribe']) {
  check(presets.has(id), `存在 preset：${id}`)
}

// 根补丁把本包挂成插件行（可管理、可禁用）
const selfRow = insertedRows.find((row) => row?.name === pkg.name)
check(Boolean(selfRow), '根补丁挂载本包为插件行', selfRow?.id ?? 'missing')

// ── 3. 结构工具 ──────────────────────────────────────────────────────────────
const flatten = (plugins, out = []) => {
  for (const plugin of plugins ?? []) {
    out.push(plugin)
    if (Array.isArray(plugin?.config)) flatten(plugin.config, out)
  }
  return out
}
const byName = (rows, name) => rows.filter((row) => row?.name === name)
const pluginNames = (rows) => rows.map((row) => row?.name).filter(Boolean)

const PRESET_ORDER = { 'dev-plan': 10, scout: 90, scribe: 91 }
for (const [id, config] of presets) {
  check(config.order === PRESET_ORDER[id], `${id} order=${PRESET_ORDER[id]}`, String(config.order))
  check(typeof config.name === 'string' && config.name.length > 0, `${id} 有展示名称`)
  check(typeof config.description === 'string' && config.description.length > 0, `${id} 有描述`)
  check(Array.isArray(config.plugins) && config.plugins.length > 0, `${id} 有 plugins 列表`)
  check(typeof config.id === 'string' && config.id === id, `${id} config.id 与行 id 一致`)
}

// ── 4. persona 合同 ──────────────────────────────────────────────────────────
for (const [id, config] of presets) {
  const rows = flatten(config.plugins)
  const persona = byName(rows, '@deepseek-ai/dsh-persona')[0]
  check(Boolean(persona), `${id} 挂载 persona`)
  const text = persona?.config?.prefix
  const suffix = persona?.config?.suffix
  const minPrefix = id === 'scribe' ? 200 : 400
  check(typeof text === 'string' && text.length > minPrefix, `${id} persona.prefix 是实质内容（>${minPrefix} 字符）`, `${text?.length ?? 0} chars`)
  check(typeof suffix === 'string' && suffix.length > 0, `${id} persona.suffix 非空（否则会遮蔽部署级 suffix）`)
  check(persona?.config?.complete !== true, `${id} 未使用 complete:true`)
  check(!/\{\{/.test(`${text ?? ''}${suffix ?? ''}`), `${id} persona 不含模板变量（避免未知变量让组装抛错）`)
}

// ── 5. dev-plan 工具面 ───────────────────────────────────────────────────────
const devPlan = flatten(presets.get('dev-plan').plugins)
const devPlanNames = pluginNames(devPlan)

const FORBIDDEN_IN_DEV_PLAN = [
  '@deepseek-ai/dsh-tool-fs',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-jobs',
  '@deepseek-ai/dsh-tool-schedule',
  '@deepseek-ai/dsh-tool-goal',
  '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-tool-present',
  '@deepseek-ai/dsh-skill-filesystem',
  '@deepseek-ai/dsh-plan-mode',
]
for (const name of FORBIDDEN_IN_DEV_PLAN) {
  check(!devPlanNames.includes(name), `dev-plan 不挂载 ${name}`)
}

const devPlanForbiddenTools = ['subagent_fork', 'fork']
const subagentRows = byName(devPlan, '@deepseek-ai/dsh-tool-subagent')
check(subagentRows.length === 3, 'dev-plan 恰好 3 个 tool-subagent 实例', String(subagentRows.length))
check(devPlanNames.includes('@deepseek-ai/dsh-tool-subagent-control'), 'dev-plan 挂载 tool-subagent-control')

const toolNames = subagentRows.map((row) => row?.config?.toolName)
check(new Set(toolNames).size === toolNames.length, 'toolName 互不重复', toolNames.join(', '))
check(
  JSON.stringify([...toolNames].sort()) === JSON.stringify(['recon', 'review', 'scribe']),
  'toolName 恰为 recon/review/scribe',
  toolNames.join(', '),
)

const EXPECTED_BINDING = { recon: 'scout', review: 'scout', scribe: 'scribe' }
for (const row of subagentRows) {
  const cfg = row.config ?? {}
  const name = cfg.toolName
  check(cfg.provider === 'spawn', `${name} provider=spawn（只有进程内 spawn 支持 agentPreset）`)
  check(cfg.agentPreset === EXPECTED_BINDING[name], `${name} agentPreset=${EXPECTED_BINDING[name]}`, String(cfg.agentPreset))
  check(cfg.maxDepth === 1, `${name} maxDepth=1`)
  check(cfg.modelSelection === false, `${name} 关闭 modelSelection`)
  check(cfg.modelDiscovery === false, `${name} 关闭 modelDiscovery`)
  check(cfg.allowedAgentPresets === undefined, `${name} 不设 allowedAgentPresets（角色靠工具名路由）`)
  check(
    typeof cfg.agentOptions?.provider === 'string' && cfg.agentOptions.provider.length > 0,
    `${name} 显式 provider 路由`,
    String(cfg.agentOptions?.provider),
  )
  check(
    typeof cfg.agentOptions?.model === 'string' && cfg.agentOptions.model.length > 0,
    `${name} 显式 model 路由`,
    String(cfg.agentOptions?.model),
  )
  check(!devPlanForbiddenTools.includes(name), `dev-plan 没有 fork 类委派工具：${name}`)
}
const referencedPresets = new Set(subagentRows.map((row) => row?.config?.agentPreset))
for (const id of referencedPresets) {
  check(presets.has(id), `agentPreset 引用可解析：${id}`)
}

check(devPlanNames.includes('@deepseek-ai/dsh-tool-ask-user'), 'dev-plan 挂载 tool-ask-user')
check(devPlanNames.includes('@deepseek-ai/dsh-agent-instructions'), 'dev-plan 挂载 agent-instructions')
check(devPlanNames.includes('@deepseek-ai/dsh-time-context'), 'dev-plan 挂载 time-context')

// ── 6. scout 只读合同 ───────────────────────────────────────────────────────
const scout = flatten(presets.get('scout').plugins)
const scoutNames = pluginNames(scout)
check(scoutNames.includes('@deepseek-ai/dsh-agent-instructions'), 'scout 挂载 agent-instructions（项目规范可注入）')
const scoutFs = byName(scout, '@deepseek-ai/dsh-tool-fs')[0]?.config ?? {}
check(scoutFs.read === true && scoutFs.readImage === true, 'scout 可读文本与图片')
check(scoutFs.write === false && scoutFs.edit === false && scoutFs.applyPatch === false, 'scout 关闭 write/edit/applyPatch')
const scoutSearch = byName(scout, '@deepseek-ai/dsh-tool-fs-search')[0]?.config ?? {}
check(typeof scoutSearch.sampleOverCapGlobResults === 'boolean', 'scout fs-search 写了必填 sampleOverCapGlobResults')
const scoutWeb = byName(scout, '@deepseek-ai/dsh-tool-web')[0]?.config ?? {}
check(scoutWeb.fetch === true, 'scout 开启 web_fetch')
for (const forbidden of ['@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-tool-workflow']) {
  check(!scoutNames.includes(forbidden), `scout 不挂载 ${forbidden}`)
}

// ── 7. scribe 记录合同 ──────────────────────────────────────────────────────
const scribe = flatten(presets.get('scribe').plugins)
const scribeNames = pluginNames(scribe)
check(scribeNames.includes('@deepseek-ai/dsh-agent-instructions'), 'scribe 挂载 agent-instructions')
const scribeFs = byName(scribe, '@deepseek-ai/dsh-tool-fs')[0]?.config ?? {}
check(scribeFs.read === true && scribeFs.write === true && scribeFs.edit === true, 'scribe 可 read/write/edit')
check(scribeFs.applyPatch === false, 'scribe 关闭 applyPatch')
check(scribeFs.readImage === false, 'scribe 关闭 readImage（不需要）')
for (const forbidden of [
  '@deepseek-ai/dsh-tool-pwsh',
  '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-tool-workflow',
]) {
  check(!scribeNames.includes(forbidden), `scribe 不挂载 ${forbidden}`)
}

// ── 8. 其他静态合同 ─────────────────────────────────────────────────────────
const indexSource = read('index.js')
check(!/from\s+['"]@deepseek-ai\//.test(indexSource), 'index.js 不 import @deepseek-ai/*（链接安装解析不到宿主包）')
check(!/ctx\.tools\.register/.test(indexSource), 'index.js 不注册模型可见工具')
check(!/webServer/.test(indexSource), 'index.js 不注册 HTTP 路由')

for (const rel of ['locale/zh.json', 'locale/en.json']) {
  try {
    const locale = JSON.parse(read(rel))
    check(typeof locale?.meta?.title === 'string' && locale.meta.title.length > 0, `${rel} 有 meta.title`)
  } catch (error) {
    check(false, `${rel} 是合法 JSON`, error instanceof Error ? error.message : String(error))
  }
}

const gitignore = read('.gitignore')
check(/node_modules/.test(gitignore), '.gitignore 忽略 node_modules')

// ── 9. 汇总 ─────────────────────────────────────────────────────────────────
console.log('')
console.log(`静态检查：${passes} 通过 / ${failures} 失败`)
if (failures > 0) {
  console.log('结论：FAIL')
  process.exit(1)
}
console.log('结论：PASS（声明层面；运行期行为见 README「验证」的手工清单）')
