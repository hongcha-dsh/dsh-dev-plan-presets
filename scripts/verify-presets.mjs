#!/usr/bin/env node
/**
 * verify-presets.mjs — 静态合同自检（不启动 DSH、不安装、不改 profile）
 *
 * 覆盖四层：
 *   1. 声明层：三份 preset 的工具面、委派绑定、精确模型路由、compaction 形状、persona 要求。
 *   2. 打包层：exports 指向真实文件、dsh.bundle.patch 完整、files 覆盖。
 *   3. 代码层：node --check + 动态 import + apply() smoke。
 *   4. 变异层：故意改坏关键点，断言检查确实会 FAIL——防止检查“恒真”。
 *
 * 它不能证明运行期行为（preset 是否出现在选择器、子代理是否真的用低成本模型、
 * 全局插件注入了哪些工具）。那部分见 README「验证」的手工清单。
 *
 * 用法：
 *   node scripts/verify-presets.mjs
 *   node scripts/verify-presets.mjs --verbose
 *
 * 依赖：js-yaml。优先借用本机 DSH profile 里的副本。
 */

import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, cpSync, openSync, closeSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
const EXPECTED_ROUTE = { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }

const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'presets/dev-plan.patch.yml',
  'presets/scout.patch.yml',
  'presets/scribe.patch.yml',
  'README.md',
  'detail.md',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'scripts/verify-presets.mjs',
  '.gitignore',
]

const PERSONA_MARKERS = {
  'dev-plan': [
    '分档',
    '低风险',
    '中风险',
    '高风险',
    '证据',
    '假设',
    '方案',
    'builder-check',
    'commit',
    'diff',
    '未运行测试',
    'config_',
    'working_directory',
    'rework_task',
    'ask_worker',
    'askLimit',
  ],
  scout: ['路径:行号', '置信度', '没有找到证据', 'config_', 'working_directory'],
  scribe: ['逐字', '拒绝', 'config_', 'working_directory'],
}

export function loadYaml() {
  const homes = [process.env.DSH_HOME, 'D:\\DSH-Home', join(process.env.USERPROFILE ?? '', '.dsh')].filter(
    (home) => typeof home === 'string' && home.length > 0,
  )
  for (const home of homes) {
    for (const anchor of [join(home, 'profiles', 'desktop', 'package.json'), join(home, 'profiles', 'desktop', 'node_modules', 'js-yaml', 'package.json')]) {
      try {
        return createRequire(pathToFileURL(anchor).href)('js-yaml')
      } catch {
        // 试下一个
      }
    }
  }
  try {
    return createRequire(pathToFileURL(join(ROOT, 'package.json')).href)('js-yaml')
  } catch {
    return null
  }
}

export function loadData(root = ROOT, yaml = loadYaml()) {
  const readText = (rel) => {
    try {
      return readFileSync(join(root, rel), 'utf8')
    } catch {
      return null
    }
  }

  const pkgText = readText('package.json')
  let pkg = {}
  let pkgError = null
  if (pkgText === null) {
    pkgError = 'package.json 不存在'
  } else {
    try {
      pkg = JSON.parse(pkgText)
    } catch (error) {
      pkgError = error instanceof Error ? error.message : String(error)
      pkg = {}
    }
  }
  const patchList = Array.isArray(pkg?.dsh?.bundle?.patch) ? [...pkg.dsh.bundle.patch] : []

  const files = {}
  for (const rel of REQUIRED_FILES) files[rel] = readText(rel)
  for (const rel of patchList) {
    const clean = rel.replace(/^\.\//, '')
    if (!(clean in files)) files[clean] = readText(clean)
  }

  const parsed = {}
  const rows = []
  if (yaml) {
    for (const rel of patchList) {
      const text = files[rel.replace(/^\.\//, '')]
      if (typeof text !== 'string') {
        parsed[rel] = { status: 'missing' }
        continue
      }
      try {
        const value = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA })
        parsed[rel] = { status: 'ok', value }
        if (Array.isArray(value)) {
          for (const row of value) {
            if (Array.isArray(row?.insert)) rows.push(...row.insert)
            else rows.push(row)
          }
        } else {
          parsed[rel] = { status: 'not-array', value }
        }
      } catch (error) {
        parsed[rel] = { status: 'parse-error', error: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  return { root, pkg, pkgText, pkgError, patchList, files, parsed, rows, yaml }
}

const flatten = (plugins, out = []) => {
  for (const plugin of plugins ?? []) {
    out.push(plugin)
    if (Array.isArray(plugin?.config)) flatten(plugin.config, out)
  }
  return out
}
const byName = (rows, name) => rows.filter((row) => row?.name === name)
const pluginNames = (rows) => rows.map((row) => row?.name).filter(Boolean)

export function findPresetRow(data, id) {
  return data.rows.find((row) => row?.name === '@deepseek-ai/dsh-agent-preset' && row?.config?.id === id)
}
export function findPersonaRow(data, id) {
  const preset = findPresetRow(data, id)
  return flatten(preset?.config?.plugins).find((row) => row?.name === '@deepseek-ai/dsh-persona')
}
export function findSubagentRow(data, toolName) {
  const preset = findPresetRow(data, 'dev-plan')
  return flatten(preset?.config?.plugins).find(
    (row) => row?.name === '@deepseek-ai/dsh-tool-subagent' && row?.config?.toolName === toolName,
  )
}

export function checksFor(data) {
  const results = []
  const check = (ok, label, detail = '') => results.push({ ok: Boolean(ok), label, detail: String(detail) })
  const { pkg, pkgText, pkgError, patchList, files, parsed, rows, yaml } = data

  // ── 打包层 ────────────────────────────────────────────────────────────────
  check(typeof pkgText === 'string', 'package.json 存在')
  check(pkgError === null, 'package.json 是合法 JSON', pkgError ?? '')
  check(pkg.name === 'dsh-dev-plan-presets', 'package.json name', pkg.name)
  check(pkg.version === '0.1.0', 'package.json version', pkg.version)
  check(pkg.private === true, 'package.json private=true')
  check(pkg.type === 'module', 'package.json type=module')

  const exportsMap = pkg.exports ?? {}
  for (const [key, target] of Object.entries(exportsMap)) {
    if (typeof target !== 'string') {
      check(false, `exports ${key} 是字符串`, typeof target)
      continue
    }
    const clean = target.replace(/^\.\//, '')
    const samples = clean.includes('*')
      ? Object.keys(files).filter((rel) => {
          const [prefix, suffix] = clean.split('*')
          return rel.startsWith(prefix) && rel.endsWith(suffix)
        })
      : [clean]
    check(
      samples.length > 0 && samples.every((rel) => typeof files[rel] === 'string'),
      `exports ${key} 指向真实存在的文件`,
      samples.join(', ') || '无匹配文件',
    )
  }
  check(exportsMap['./package.json'] === './package.json', 'exports 暴露 ./package.json')

  check(Array.isArray(patchList) && patchList.length === 4, 'dsh.bundle.patch 是含 4 个补丁的数组', JSON.stringify(patchList))
  for (const rel of patchList) {
    const clean = rel.replace(/^\.\//, '')
    check(typeof files[clean] === 'string', `补丁文件存在：${rel}`)
    const patterns = pkg.files ?? []
    const covered = patterns.some((pattern) =>
      pattern.includes('*')
        ? clean.startsWith(pattern.slice(0, pattern.indexOf('*'))) && clean.endsWith(pattern.slice(pattern.indexOf('*') + 1))
        : pattern === clean,
    )
    check(covered, `files 覆盖：${rel}`)
  }
  for (const rel of REQUIRED_FILES) {
    check(typeof files[rel] === 'string', `文件存在：${rel}`)
  }

  // ── YAML 解析 ─────────────────────────────────────────────────────────────
  if (!yaml) {
    check(false, '能加载 js-yaml')
    return results
  }
  for (const rel of patchList) {
    const entry = parsed[rel]
    check(entry?.status === 'ok', `YAML 可解析且顶层是数组：${rel}`, entry?.status === 'parse-error' ? entry.error : entry?.status)
  }

  // ── preset 声明 ───────────────────────────────────────────────────────────
  const presetRows = byName(rows, '@deepseek-ai/dsh-agent-preset')
  const presets = new Map()
  for (const row of presetRows) {
    const id = row?.config?.id
    check(typeof id === 'string' && id.length > 0, 'preset 声明有 config.id', String(id))
    if (typeof id === 'string') presets.set(id, row.config)
  }
  check(presets.size === 3, '恰好声明 3 个 preset', [...presets.keys()].join(', '))
  for (const id of ['dev-plan', 'scout', 'scribe']) check(presets.has(id), `存在 preset：${id}`)

  const selfRow = rows.find((row) => row?.name === pkg.name)
  check(Boolean(selfRow), '根补丁把本包挂成插件行', selfRow?.id ?? 'missing')

  const PRESET_ORDER = { 'dev-plan': 10, scout: 90, scribe: 91 }
  for (const [id, config] of presets) {
    check(config.order === PRESET_ORDER[id], `${id} order=${PRESET_ORDER[id]}`, String(config.order))
    check(typeof config.name === 'string' && config.name.length > 0, `${id} 有展示名称`)
    check(typeof config.description === 'string' && config.description.length > 0, `${id} 有描述`)
    check(Array.isArray(config.plugins) && config.plugins.length > 0, `${id} 有 plugins 列表`)
    check(config.id === id, `${id} config.id 与查表键一致`)
  }

  // ── persona 合同 ──────────────────────────────────────────────────────────
  for (const id of ['dev-plan', 'scout', 'scribe']) {
    const persona = findPersonaRow(data, id)
    const text = persona?.config?.prefix
    const suffix = persona?.config?.suffix
    check(Boolean(persona), `${id} 挂载 persona`)
    check(typeof text === 'string' && text.length > 400, `${id} persona.prefix 是实质内容（>400 字符）`, `${text?.length ?? 0} chars`)
    check(typeof suffix === 'string' && suffix.length > 0, `${id} persona.suffix 非空（否则会遮蔽部署级 suffix）`)
    check(persona?.config?.complete !== true, `${id} 未使用 complete:true`)
    check(!/\{\{/.test(`${text ?? ''}${suffix ?? ''}`), `${id} persona 不含模板变量`)

    const markers = PERSONA_MARKERS[id] ?? []
    const missing = markers.filter((marker) => !`${text ?? ''}${suffix ?? ''}`.includes(marker))
    check(missing.length === 0, `${id} persona 包含必需方法论/禁令标记`, `缺：${missing.join(', ') || '无'}`)
    check(!/不是[\u201c"]被要求不要用/.test(text ?? ''), `${id} persona 没有“不是被要求不要用”这类错误硬保证`)
  }

  const devPlanSuffix = findPersonaRow(data, 'dev-plan')?.config?.suffix ?? ''
  check(
    /可以引用/.test(devPlanSuffix) && /执行窗口/.test(devPlanSuffix) && /来源/.test(devPlanSuffix),
    'dev-plan suffix 允许注明来源地引用执行窗口结论',
  )
  check(/不得声称自己执行/.test(devPlanSuffix), 'dev-plan suffix 禁止本预设谎称自己执行过')
  check(!/任何消息都不得宣称执行过/.test(devPlanSuffix), 'dev-plan suffix 没有一刀切禁止引用外部测试结论')

  // ── compaction 形状 ───────────────────────────────────────────────────────
  for (const id of ['dev-plan', 'scout', 'scribe']) {
    const preset = presets.get(id)
    const rows = flatten(preset?.plugins)
    const group = rows.find((row) => row?.id === 'compaction')
    const children = pluginNames(Array.isArray(group?.config) ? group.config : [])
    check(Boolean(group && group.group === true), `${id} compaction 是 group`)
    check(group?.isolate?.compaction === true && group?.isolate?.toolResultPruner === true, `${id} compaction isolate 两个键都为 true`)
    check(
      ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner'].every((name) =>
        children.includes(name),
      ),
      `${id} compaction 组含三行`,
      children.join(', '),
    )
  }

  // ── dev-plan 工具面 ───────────────────────────────────────────────────────
  const devPlanRows = flatten(presets.get('dev-plan')?.plugins)
  const devPlanNames = pluginNames(devPlanRows)
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
    '@deepseek-ai/dsh-tool-subagent-fork',
    '@deepseek-ai/dsh-skill-filesystem',
    '@deepseek-ai/dsh-plan-mode',
  ]
  for (const name of FORBIDDEN_IN_DEV_PLAN) {
    check(!devPlanNames.includes(name), `dev-plan 不挂载 ${name}`)
  }
  for (const required of [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-time-context',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-subagent-control',
  ]) {
    check(devPlanNames.includes(required), `dev-plan 挂载 ${required}`)
  }

  const subagentRows = byName(devPlanRows, '@deepseek-ai/dsh-tool-subagent')
  check(subagentRows.length === 3, 'dev-plan 恰好 3 个 tool-subagent 实例', String(subagentRows.length))
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
    check(cfg.agentOptions?.provider === EXPECTED_ROUTE.provider, `${name} provider 精确为 ${EXPECTED_ROUTE.provider}`, String(cfg.agentOptions?.provider))
    check(cfg.agentOptions?.model === EXPECTED_ROUTE.model, `${name} model 精确为 ${EXPECTED_ROUTE.model}`, String(cfg.agentOptions?.model))
  }
  for (const id of new Set(subagentRows.map((row) => row?.config?.agentPreset))) {
    check(presets.has(id), `agentPreset 引用可解析：${id}`)
  }

  // ── scout 只读合同 ────────────────────────────────────────────────────────
  const scoutRows = flatten(presets.get('scout')?.plugins)
  const scoutNames = pluginNames(scoutRows)
  check(scoutNames.includes('@deepseek-ai/dsh-agent-instructions'), 'scout 挂载 agent-instructions（项目规范可注入）')
  const scoutFs = byName(scoutRows, '@deepseek-ai/dsh-tool-fs')[0]?.config ?? {}
  check(scoutFs.read === true && scoutFs.readImage === true, 'scout 可读文本与图片')
  check(scoutFs.write === false && scoutFs.edit === false && scoutFs.applyPatch === false, 'scout 关闭 write/edit/applyPatch')
  const scoutSearch = byName(scoutRows, '@deepseek-ai/dsh-tool-fs-search')[0]?.config ?? {}
  check(typeof scoutSearch.sampleOverCapGlobResults === 'boolean', 'scout fs-search 写了必填 sampleOverCapGlobResults')
  const scoutWeb = byName(scoutRows, '@deepseek-ai/dsh-tool-web')[0]?.config ?? {}
  check(scoutWeb.fetch === true, 'scout 开启 web_fetch')
  for (const forbidden of [
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-fs-edit',
  ]) {
    check(!scoutNames.includes(forbidden), `scout 不挂载 ${forbidden}`)
  }

  // ── scribe 记录合同 ───────────────────────────────────────────────────────
  const scribeRows = flatten(presets.get('scribe')?.plugins)
  const scribeNames = pluginNames(scribeRows)
  check(scribeNames.includes('@deepseek-ai/dsh-agent-instructions'), 'scribe 挂载 agent-instructions')
  const scribeFs = byName(scribeRows, '@deepseek-ai/dsh-tool-fs')[0]?.config ?? {}
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

  // ── index.js 静态 ─────────────────────────────────────────────────────────
  const indexSource = files['index.js'] ?? ''
  check(!/from\s+['"]@deepseek-ai\//.test(indexSource), 'index.js 不 import @deepseek-ai/*（链接安装解析不到宿主包）')
  check(!/ctx\.tools\.register/.test(indexSource), 'index.js 不注册模型可见工具')
  check(!/webServer/.test(indexSource), 'index.js 不注册 HTTP 路由')

  // ── locale / 文档 ─────────────────────────────────────────────────────────
  for (const rel of ['locale/zh.json', 'locale/en.json']) {
    let locale = null
    try {
      locale = JSON.parse(files[rel] ?? '')
    } catch (error) {
      check(false, `${rel} 是合法 JSON`, error instanceof Error ? error.message : String(error))
      continue
    }
    check(typeof locale?.meta?.title === 'string' && locale.meta.title.length > 0, `${rel} 有 meta.title`)
    check(typeof locale?.meta?.description === 'string' && locale.meta.description.length > 0, `${rel} 有 meta.description`)
    check(locale?.meta?.detail === 'detail.md', `${rel} 的 meta.detail 指向 detail.md`)
  }
  const zhDescription = (() => {
    try {
      return JSON.parse(files['locale/zh.json'] ?? '{}')?.meta?.description ?? ''
    } catch {
      return ''
    }
  })()
  check(!/跑命令/.test(String(zhDescription)), 'locale/zh 描述不谎称 scout 能跑命令', String(zhDescription).slice(0, 40))

  const readme = files['README.md'] ?? ''
  for (const marker of ['实际可见工具面', 'config_', 'working_directory', 'dsh-opencode-go', 'deepseek-v4.1-flash', 'askLimit', '软约束']) {
    check(readme.includes(marker), `README 含关键说明：${marker}`)
  }
  check(!/不是[\u201c"]被要求不要用[\u201d"]/.test(readme), 'README 没有“不是被要求不要用”这类错误硬保证')

  const detailDoc = files['detail.md'] ?? ''
  check(detailDoc.length > 500, 'detail.md 是实质文档', `${detailDoc.length} chars`)
  check(detailDoc.includes('不是硬安全隔离'), 'detail.md 明示不是硬安全隔离')

  check(/node_modules/.test(files['.gitignore'] ?? ''), '.gitignore 忽略 node_modules')

  return results
}

// ── 变异层：故意改坏，断言检查会失败 ──────────────────────────────────────────
const clone = (value) => JSON.parse(JSON.stringify(value))

const MUTATIONS = [
  {
    name: '子代理路由被改成非低成本模型',
    expect: 'model 精确为',
    mutate(data) {
      findSubagentRow(data, 'recon').config.agentOptions.model = 'deepseek-chat'
    },
  },
  {
    name: 'recon 的 provider 被改错',
    expect: 'provider 精确为',
    mutate(data) {
      findSubagentRow(data, 'recon').config.agentOptions.provider = 'other-provider'
    },
  },
  {
    name: 'dev-plan persona 被清空',
    expect: 'persona.prefix 是实质内容',
    mutate(data) {
      findPersonaRow(data, 'dev-plan').config.prefix = ''
    },
  },
  {
    name: 'compaction 的 isolate 被删除',
    expect: 'compaction isolate 两个键都为 true',
    mutate(data) {
      const preset = findPresetRow(data, 'dev-plan')
      const group = flatten(preset.config.plugins).find((row) => row?.id === 'compaction')
      delete group.isolate
    },
  },
  {
    name: '引用一个不存在的 patch',
    expect: '补丁文件存在',
    mutate(data) {
      data.patchList.push('./presets/ghost.patch.yml')
    },
  },
  {
    name: '桥接例外标记被删除',
    expect: 'persona 包含必需方法论/禁令标记',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replaceAll('rework_task', 'removed_tool')
    },
  },
  {
    name: 'scout 被打开 write',
    expect: 'scout 关闭 write/edit/applyPatch',
    mutate(data) {
      const scout = findPresetRow(data, 'scout')
      const fsRow = flatten(scout.config.plugins).find((row) => row?.name === '@deepseek-ai/dsh-tool-fs')
      fsRow.config.write = true
    },
  },
  {
    name: 'dev-plan suffix 被改成禁止引用任何外部测试结论',
    expect: 'suffix 允许注明来源地引用执行窗口结论',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.suffix = '任何消息都不得宣称执行过测试，也不得引用执行窗口提供的测试结论。\n'
    },
  },
]

function runSyntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  return { ok: result.status === 0, status: result.status, error: result.error?.message }
}

/** 跑一个 node 子进程，stdout/stderr 直接写入文件（不用管道，避免受限沙箱的 EPERM）。 */
function runNodeToFile(args, cwd, env, logFile) {
  const fd = openSync(logFile, 'w')
  try {
    const result = spawnSync(process.execPath, args, { cwd, env, stdio: ['ignore', fd, fd] })
    return { status: result.status, error: result.error?.message }
  } finally {
    closeSync(fd)
  }
}

function copyBundle(dest) {
  const EXCLUDED_TOP = new Set(['.git', '.verify-tmp', '.verify-copies', '.verify-log.txt'])
  cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => {
      const rel = src.slice(ROOT.length).replace(/^[\\/]/, '')
      if (rel === '') return true
      return !EXCLUDED_TOP.has(rel.split(/[\\/]/)[0])
    },
  })
}

function runVerifyEntry(dir) {
  const logFile = join(dir, '.verify-log.txt')
  const result = runNodeToFile(
    [join(dir, 'scripts', 'verify-presets.mjs')],
    dir,
    { ...process.env, VERIFY_SKIP_SELFCHECK: '1' },
    logFile,
  )
  let output = ''
  try {
    output = readFileSync(logFile, 'utf8')
  } catch {
    output = ''
  }
  return { status: result.status, output, error: result.error }
}

const BROKEN_INDEX = 'export function apply(ctx) {\n  const x = {\n\n'

/**
 * 真实文件层自检：在隔离副本里改坏真实文件，用**同一个验证入口**跑，而不是只检查一个生产代码永远不读的临时文件。
 * 第 2 项是元测试：把代码层闸门整体改为恒通过，若坏文件仍被检出，说明第 1 项的结论不是闸门给的。
 */
function runSelfChecks() {
  const items = []
  // 只为元元测试保留一层递归：再深的副本不再跑自检
  const depth = Number(process.env.VERIFY_SELFCHECK_DEPTH ?? '0')
  // 副本必须放在包目录之外：cpSync 不允许把目录复制进它自己的子目录
  const base = join(dirname(ROOT), '.verify-copies')
  rmSync(base, { recursive: true, force: true })
  mkdirSync(base, { recursive: true })
  try {
    const brokenDir = join(base, 'broken-index')
    copyBundle(brokenDir)
    writeFileSync(join(brokenDir, 'index.js'), BROKEN_INDEX, 'utf8')
    const broken = runVerifyEntry(brokenDir)
    items.push({
      name: '隔离副本写坏真实 index.js，同一验证入口检出',
      ok: broken.status !== 0 && broken.output.includes('node --check index.js：FAIL'),
      detail: `exit=${broken.status}${broken.error ? `, ${broken.error}` : ''}`,
    })

    const gateDir = join(base, 'no-code-layer')
    copyBundle(gateDir)
    writeFileSync(join(gateDir, 'index.js'), BROKEN_INDEX, 'utf8')
    const verifyPath = join(gateDir, 'scripts', 'verify-presets.mjs')
    const gateSource = readFileSync(verifyPath, 'utf8')
    // 带换行与缩进定位，避免命中本函数里的匹配字符串
    const syntaxPatched = gateSource.replace(
      '\n  const syntax = runSyntaxCheck(indexFile)',
      '\n  const syntax = { ok: true }',
    )
    const smokePatched = syntaxPatched.replace(
      '\n    const mod = await import(moduleUrl)',
      '\n    const mod = { apply: () => {} }',
    )
    const patched = syntaxPatched !== gateSource && smokePatched !== syntaxPatched
    writeFileSync(verifyPath, smokePatched, 'utf8')
    const gate = patched ? runVerifyEntry(gateDir) : { status: null, error: '闸门替换未命中' }
    items.push({
      name: '删掉代码层闸门后坏 index.js 不再被检出（证明闸门承重）',
      ok: patched && gate.status === 0,
      detail: patched ? `exit=${gate.status}` : gate.error,
    })

    const pkgDir = join(base, 'broken-package-json')
    copyBundle(pkgDir)
    writeFileSync(join(pkgDir, 'package.json'), '{ "name": "dsh-dev-plan-presets", "version": ', 'utf8')
    const pkgRun = runVerifyEntry(pkgDir)
    const cleanFail = pkgRun.output.includes('FAIL  package.json 是合法 JSON')
    const hasStack = /\n\s+at\s|SyntaxError/.test(pkgRun.output)
    items.push({
      name: '坏 package.json 干净 FAIL（无堆栈）',
      ok: pkgRun.status !== 0 && cleanFail && !hasStack,
      detail: `exit=${pkgRun.status}, 命中FAIL=${cleanFail}, 堆栈=${hasStack}`,
    })

    // 4) 元元测试：在副本里删掉代码层闸门后，让副本自己的自检照常运行 →
    //    自检第 1 项无法再检出坏 index.js，于是总体验证必须失败（证明自检本身承重）
    if (depth < 1) {
      const blindDir = join(base, 'gate-removed-selfcheck')
      copyBundle(blindDir)
      const blindVerifyPath = join(blindDir, 'scripts', 'verify-presets.mjs')
      const blindSource = readFileSync(blindVerifyPath, 'utf8')
      const blindPatched = blindSource
        .replace('\n  const syntax = runSyntaxCheck(indexFile)', '\n  const syntax = { ok: true }')
        .replace('\n    const mod = await import(moduleUrl)', '\n    const mod = { apply: () => {} }')
      writeFileSync(blindVerifyPath, blindPatched, 'utf8')
      const blindLog = join(blindDir, '.verify-log.txt')
      const blind = runNodeToFile(
        [blindVerifyPath],
        blindDir,
        { ...process.env, VERIFY_SELFCHECK_DEPTH: String(depth + 1) },
        blindLog,
      )
      let blindOut = ''
      try {
        blindOut = readFileSync(blindLog, 'utf8')
      } catch {
        blindOut = ''
      }
      const blindPatchedOk = blindPatched !== blindSource
      items.push({
        name: '删掉代码层闸门后总体验证失败（自检失去检出能力）',
        ok: blindPatchedOk && blind.status !== 0 && blindOut.includes('隔离副本写坏真实 index.js'),
        detail: blindPatchedOk ? `exit=${blind.status}` : '闸门替换未命中',
      })
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
  return items
}

async function main() {
  const yaml = loadYaml()
  if (!yaml) {
    console.error('无法加载 js-yaml。请在本插件目录执行：npm i -D js-yaml')
    process.exit(2)
  }

  const data = loadData(ROOT, yaml)
  const results = checksFor(data)
  for (const item of results) {
    if (!item.ok) console.log(`FAIL  ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    else if (VERBOSE) console.log(`PASS  ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  const failures = results.filter((item) => !item.ok).length
  const passes = results.length - failures
  console.log('')
  console.log(`静态声明检查：${passes} 通过 / ${failures} 失败`)

  // 语法 + import/apply smoke
  const indexFile = resolve(ROOT, 'index.js')
  const syntax = runSyntaxCheck(indexFile)
  console.log(`node --check index.js：${syntax.ok ? 'PASS' : `FAIL（status=${syntax.status}${syntax.error ? `, ${syntax.error}` : ''}）`}`)

  let smokeOk = true
  let smokeDetail = 'ok'
  try {
    const moduleUrl = `${pathToFileURL(indexFile).href}?verify=${Date.now()}`
    const mod = await import(moduleUrl)
    if (typeof mod.apply !== 'function') throw new Error('未导出 apply')
    const warnings = []
    mod.apply({ logger: { warn: (message) => warnings.push(String(message)) } })
    smokeDetail = warnings.length === 0 ? '无告警' : `告警 ${warnings.length} 条：${warnings.join(' | ')}`
    smokeOk = warnings.length === 0
  } catch (error) {
    smokeOk = false
    smokeDetail = error instanceof Error ? error.message : String(error)
  }
  console.log(`import + apply() smoke：${smokeOk ? 'PASS' : 'FAIL'}（${smokeDetail}）`)

  // 变异检查
  let detected = 0
  const missed = []
  const detectedNames = []
  for (const mutation of MUTATIONS) {
    const mutated = clone(data)
    try {
      mutation.mutate(mutated)
    } catch (error) {
      missed.push(`${mutation.name}（变异本身抛错：${error instanceof Error ? error.message : String(error)}）`)
      continue
    }
    const outcome = checksFor(mutated).filter((item) => !item.ok)
    const hit = outcome.some((item) => item.label.includes(mutation.expect))
    if (hit) {
      detected += 1
      detectedNames.push(mutation.name)
    } else missed.push(`${mutation.name}（期望 ${mutation.expect} 报错，实际未报）`)
  }

  // 自检（真实文件层）：默认跑；嵌套调用时跳过，避免递归
  const selfChecks = process.env.VERIFY_SKIP_SELFCHECK === '1' ? [] : runSelfChecks()
  for (const item of selfChecks) {
    if (item.ok) {
      detected += 1
      detectedNames.push(item.name)
    } else missed.push(`${item.name}（${item.detail}）`)
  }

  const totalMutations = MUTATIONS.length + selfChecks.length
  console.log(`负向变异：${detected}/${totalMutations} 检出`)
  if (VERBOSE) for (const name of detectedNames) console.log(`PASS  变异：${name}`)
  for (const item of missed) console.log(`FAIL  ${item}`)

  const ok = failures === 0 && syntax.ok && smokeOk && missed.length === 0
  console.log('')
  console.log(`结论：${ok ? 'PASS（声明层 + 代码层；运行期行为见 README「验证」的手工清单）' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (invokedDirectly) {
  await main()
}
