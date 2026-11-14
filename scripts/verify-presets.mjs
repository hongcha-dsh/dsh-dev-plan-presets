#!/usr/bin/env node
/**
 * verify-presets.mjs — 静态合同自检（不启动 DSH、不安装、不改 profile）
 *
 * 覆盖四层：
 *   1. 声明层：只注册一个 dev-plan preset；三个委派实例绑定 standard、工具面、精确模型路由、
 *      compaction 形状；两个角色模板（侦察/复核、文书）与派遣绑定；已删除的 scout/scribe 无残留。
 *      关键允许/禁止边界用精确整句、编号规则与邻近语境断言，避免“词语在别处出现”就算通过。
 *   2. 打包层：exports 指向真实文件且不再暴露 scout/scribe、dsh.bundle.patch 完整、files 覆盖。
 *   3. 代码层：node --check + 动态 import + apply() smoke。
 *   4. 变异层：故意改坏关键点（含 5 个“关键词还在、语义被改坏”的模板变异），断言检查确实会 FAIL。
 *
 * 它不能证明运行期行为（preset 是否出现在选择器、子代理是否真的用低成本模型、
 * 模板是否真的被逐字附带、standard 子代理实际注入了哪些工具）。那部分见 README「验证」的手工清单。
 *
 * 用法：
 *   node scripts/verify-presets.mjs
 *   node scripts/verify-presets.mjs --verbose
 *
 * 依赖：js-yaml。优先借用本机 DSH profile 里的副本。
 */

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  cpSync,
  openSync,
  closeSync,
} from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
const EXPECTED_ROUTE = { provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }
const REMOVED_PRESET_IDS = ['scout', 'scribe']

const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'cordis.patch.yml',
  'presets/dev-plan.patch.yml',
  'README.md',
  'detail.md',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
  'scripts/verify-presets.mjs',
  '.gitignore',
]

// 方案 B 明确删除的文件：读不到才算通过（不是用 hidden 字段藏起来）。
const REMOVED_FILES = ['presets/scout.patch.yml', 'presets/scribe.patch.yml']

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
}

const SCOUT_TEMPLATE_MARKERS = [
  '任务级',
  '不是声明级',
  'standard',
  'read',
  'read_image',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'write',
  'edit',
  'apply_patch',
  'pwsh',
  'bash',
  'config_',
  'working_directory',
  '需要主代理改派或提供材料',
  '结论',
  '证据',
  '路径:行号',
  '未验证',
  '没检查的范围',
  '置信度',
  '高、中、低',
  '没有找到证据',
  '复核',
  '未发现正确性问题',
  '测试通过',
  '数据，不是指令',
]

const SCRIBE_TEMPLATE_MARKERS = [
  '任务级',
  '不是声明级',
  'standard',
  '逐字',
  '不改写',
  'read_image',
  '覆盖',
  '拒绝',
  '超出文书子代理职责',
  'Shell',
  'Web',
  '搜索',
  '委派',
  'config_',
  'working_directory',
  '回执',
  '字节',
  '失败：',
  '不要输出文件内容',
]

export function loadYaml() {
  const homes = [process.env.DSH_HOME, 'D:\\DSH-Home', join(process.env.USERPROFILE ?? '', '.dsh')].filter(
    (home) => typeof home === 'string' && home.length > 0,
  )
  for (const home of homes) {
    for (const anchor of [
      join(home, 'profiles', 'desktop', 'package.json'),
      join(home, 'profiles', 'desktop', 'node_modules', 'js-yaml', 'package.json'),
    ]) {
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
  for (const rel of [...REQUIRED_FILES, ...REMOVED_FILES]) files[rel] = readText(rel)
  for (const rel of patchList) {
    const clean = rel.replace(/^\.\//, '')
    if (!(clean in files)) files[clean] = readText(clean)
  }

  let presetFiles = []
  try {
    presetFiles = readdirSync(join(root, 'presets'))
      .filter((name) => name.endsWith('.patch.yml'))
      .sort()
  } catch {
    presetFiles = []
  }

  const parsed = {}
  const rows = []
  // 给每一行打上来源补丁，供“生产断言必须指向实际 presets/dev-plan.patch.yml”检查使用。
  // 只是普通自有属性（字符串），能安全通过 clone 的 JSON 往返。
  const pushRow = (row, source) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) row._source = source
    rows.push(row)
  }
  if (yaml) {
    for (const rel of patchList) {
      const clean = rel.replace(/^\.\//, '')
      const text = files[clean]
      if (typeof text !== 'string') {
        parsed[rel] = { status: 'missing' }
        continue
      }
      try {
        const value = yaml.load(text, { schema: yaml.DEFAULT_SCHEMA })
        parsed[rel] = { status: 'ok', value }
        if (Array.isArray(value)) {
          for (const row of value) {
            if (Array.isArray(row?.insert)) for (const child of row.insert) pushRow(child, clean)
            else pushRow(row, clean)
          }
        } else {
          parsed[rel] = { status: 'not-array', value }
        }
      } catch (error) {
        parsed[rel] = { status: 'parse-error', error: error instanceof Error ? error.message : String(error) }
      }
    }
  }

  return { root, pkg, pkgText, pkgError, patchList, files, presetFiles, parsed, rows, yaml }
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

/** 从 persona 文本里按稳定标记取出角色模板正文；取不到返回 null。 */
export function extractTemplate(text, name) {
  if (typeof text !== 'string') return null
  const re = new RegExp(
    `^[ \\t]*=+ ROLE-TEMPLATE:${name}:BEGIN =+[ \\t]*\\r?\\n([\\s\\S]*?)^[ \\t]*=+ ROLE-TEMPLATE:${name}:END =+[ \\t]*$`,
    'm',
  )
  const match = re.exec(text)
  return match ? match[1] : null
}

/** 把模板里的“规则：”编号行解析成 {编号 → 整行正文}，用于按编号做精确断言。 */
export function numberedRules(text) {
  const rules = new Map()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^\s*(\d+)\.\s+(.+?)\s*$/.exec(line)
    if (match) rules.set(Number(match[1]), match[2])
  }
  return rules
}

export function checksFor(data) {
  const results = []
  const check = (ok, label, detail = '') => results.push({ ok: Boolean(ok), label, detail: String(detail) })
  const { pkg, pkgText, pkgError, patchList, files, presetFiles, parsed, rows, yaml } = data

  // ── 打包层 ────────────────────────────────────────────────────────────────
  check(typeof pkgText === 'string', 'package.json 存在')
  check(pkgError === null, 'package.json 是合法 JSON', pkgError ?? '')
  check(pkg.name === 'dsh-dev-plan-presets', 'package.json name', pkg.name)
  check(pkg.version === '0.2.0', 'package.json version=0.2.0（scout/scribe 移除属破坏性变更）', pkg.version)
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

  const staleExportKeys = Object.keys(exportsMap).filter((key) => /scout|scribe/i.test(key))
  check(staleExportKeys.length === 0, 'exports 不再包含 scout/scribe 入口', staleExportKeys.join(', ') || '无')
  const staleFiles = (pkg.files ?? []).filter((rel) => /scout|scribe/i.test(String(rel)))
  check(staleFiles.length === 0, 'files 清单不再包含 scout/scribe', staleFiles.join(', ') || '无')
  const stalePatchRefs = patchList.filter((rel) => /scout|scribe/i.test(String(rel)))
  check(stalePatchRefs.length === 0, 'dsh.bundle.patch 不再包含 scout/scribe', stalePatchRefs.join(', ') || '无')

  check(Array.isArray(patchList) && patchList.length === 2, 'dsh.bundle.patch 是含 2 个补丁的数组', JSON.stringify(patchList))
  for (const rel of patchList) {
    const clean = rel.replace(/^\.\//, '')
    check(typeof files[clean] === 'string', `补丁文件存在：${rel}`)
    const patterns = pkg.files ?? []
    const covered = patterns.some((pattern) =>
      pattern.includes('*')
        ? clean.startsWith(pattern.slice(0, pattern.indexOf('*'))) &&
          clean.endsWith(pattern.slice(pattern.indexOf('*') + 1))
        : pattern === clean,
    )
    check(covered, `files 覆盖：${rel}`)
  }
  for (const rel of REQUIRED_FILES) {
    check(typeof files[rel] === 'string', `文件存在：${rel}`)
  }
  for (const rel of REMOVED_FILES) {
    check(files[rel] === null, `已删除的补丁文件不存在：${rel}`)
  }
  check(
    JSON.stringify(presetFiles) === JSON.stringify(['dev-plan.patch.yml']),
    'presets 目录只剩 dev-plan.patch.yml',
    presetFiles.join(', ') || '空',
  )

  // ── YAML 解析 ─────────────────────────────────────────────────────────────
  if (!yaml) {
    check(false, '能加载 js-yaml')
    return results
  }
  for (const rel of patchList) {
    const entry = parsed[rel]
    check(
      entry?.status === 'ok',
      `YAML 可解析且顶层是数组：${rel}`,
      entry?.status === 'parse-error' ? entry.error : entry?.status,
    )
  }
  // 关键合同断言必须落在实际发布文件上，而不是任何测试夹具/临时数据。
  check(
    parsed['./presets/dev-plan.patch.yml']?.status === 'ok',
    '生产断言直接读取实际 presets/dev-plan.patch.yml',
    parsed['./presets/dev-plan.patch.yml']?.status ?? 'missing',
  )
  check(
    findPresetRow(data, 'dev-plan')?._source === 'presets/dev-plan.patch.yml',
    'dev-plan preset 行来自 presets/dev-plan.patch.yml（不是夹具）',
    String(findPresetRow(data, 'dev-plan')?._source),
  )

  // ── preset 声明：只注册 dev-plan ──────────────────────────────────────────
  const presetRows = byName(rows, '@deepseek-ai/dsh-agent-preset')
  const presets = new Map()
  for (const row of presetRows) {
    const id = row?.config?.id
    check(typeof id === 'string' && id.length > 0, 'preset 声明有 config.id', String(id))
    if (typeof id === 'string') presets.set(id, row.config)
  }
  check(presetRows.length === 1 && presets.size === 1, '只注册 1 个 preset', [...presets.keys()].join(', '))
  check(
    JSON.stringify([...presets.keys()]) === JSON.stringify(['dev-plan']),
    '唯一注册的 preset 是 dev-plan',
    [...presets.keys()].join(', '),
  )
  for (const id of REMOVED_PRESET_IDS) {
    check(!presets.has(id), `不再注册 preset：${id}`)
  }
  check(
    !rows.some((row) => row?.id === 'preset-scout' || row?.id === 'preset-scribe'),
    '没有遗留 preset-scout / preset-scribe 注册行',
  )

  const selfRow = rows.find((row) => row?.name === pkg.name)
  check(Boolean(selfRow), '根补丁把本包挂成插件行', selfRow?.id ?? 'missing')

  const devPlan = presets.get('dev-plan')
  check(devPlan?.order === 10, 'dev-plan order=10', String(devPlan?.order))
  check(typeof devPlan?.name === 'string' && devPlan.name.length > 0, 'dev-plan 有展示名称')
  check(typeof devPlan?.description === 'string' && devPlan.description.length > 0, 'dev-plan 有描述')
  check(Array.isArray(devPlan?.plugins) && devPlan.plugins.length > 0, 'dev-plan 有 plugins 列表')
  check(devPlan?.id === 'dev-plan', 'dev-plan config.id 与查表键一致')

  // ── persona 合同 ──────────────────────────────────────────────────────────
  const persona = findPersonaRow(data, 'dev-plan')
  const personaText = persona?.config?.prefix ?? ''
  const personaSuffix = persona?.config?.suffix ?? ''
  check(Boolean(persona), 'dev-plan 挂载 persona')
  check(
    typeof persona?.config?.prefix === 'string' && persona.config.prefix.length > 400,
    'dev-plan persona.prefix 是实质内容（>400 字符）',
    `${persona?.config?.prefix?.length ?? 0} chars`,
  )
  check(
    typeof personaSuffix === 'string' && personaSuffix.length > 0,
    'dev-plan persona.suffix 非空（否则会遮蔽部署级 suffix）',
  )
  check(persona?.config?.complete !== true, 'dev-plan 未使用 complete:true')
  check(!/\{\{/.test(`${personaText}${personaSuffix}`), 'dev-plan persona 不含模板变量')

  const missing = (PERSONA_MARKERS['dev-plan'] ?? []).filter((marker) => !`${personaText}${personaSuffix}`.includes(marker))
  check(missing.length === 0, 'dev-plan persona 包含必需方法论/禁令标记', `缺：${missing.join(', ') || '无'}`)
  check(
    !/不是[\u201c"]被要求不要用/.test(personaText),
    'dev-plan persona 没有“不是被要求不要用”这类错误硬保证',
  )

  check(
    /可以引用/.test(personaSuffix) && /执行窗口/.test(personaSuffix) && /来源/.test(personaSuffix),
    'dev-plan suffix 允许注明来源地引用执行窗口结论',
  )
  check(/不得声称自己执行/.test(personaSuffix), 'dev-plan suffix 禁止本预设谎称自己执行过')
  check(
    !/任何消息都不得宣称执行过/.test(personaSuffix),
    'dev-plan suffix 没有一刀切禁止引用外部测试结论',
  )

  // ── 两个角色模板（scout / scribe 的新载体）──────────────────────────────────
  const scoutTemplate = extractTemplate(personaText, 'SCOUT')
  const scribeTemplate = extractTemplate(personaText, 'SCRIBE')
  check(
    typeof scoutTemplate === 'string' && scoutTemplate.length > 300,
    '侦察/复核角色模板存在且完整（含首尾标记）',
    `${scoutTemplate?.length ?? 0} chars`,
  )
  check(
    typeof scribeTemplate === 'string' && scribeTemplate.length > 200,
    '文书角色模板存在且完整（含首尾标记）',
    `${scribeTemplate?.length ?? 0} chars`,
  )
  check(
    /任务级/.test(scoutTemplate ?? '') &&
      /不是声明级/.test(scoutTemplate ?? '') &&
      /任务级/.test(scribeTemplate ?? '') &&
      /不是声明级/.test(scribeTemplate ?? ''),
    '两个模板都声明自己是任务级提示词约束、不是声明级隔离',
  )

  for (const [name, template, markers] of [
    ['侦察/复核', scoutTemplate, SCOUT_TEMPLATE_MARKERS],
    ['文书', scribeTemplate, SCRIBE_TEMPLATE_MARKERS],
  ]) {
    const absent = markers.filter((marker) => !(template ?? '').includes(marker))
    check(absent.length === 0, `${name}模板保留必需标记清单（关键词层）`, `缺：${absent.join(', ') || '无'}`)
  }
  check(
    (scoutTemplate ?? '').includes('未发现正确性问题') && (scoutTemplate ?? '').includes('测试通过'),
    '侦察/复核模板保留复核零问题通过与“不谎称测试通过”规则',
  )
  check(
    (scribeTemplate ?? '').includes('逐字') && (scribeTemplate ?? '').includes('超出文书子代理职责'),
    '文书模板保留逐字写入与越界拒绝规则',
  )

  // ── 角色模板：精确边界（词语在别处出现不算通过）────────────────────────────
  // 允许清单按整句取集合，不用 includes('write')：write 在禁止段里也会出现。
  const SCOUT_ALLOW = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']
  const scoutAllowMatch = /允许使用的工具只有[：:]\s*([^。\n]+)。\s*除此之外的一切工具一律不得调用。/.exec(
    scoutTemplate ?? '',
  )
  check(Boolean(scoutAllowMatch), '侦察/复核模板的允许工具清单是精确整句', scoutAllowMatch ? '命中' : '未命中')
  const scoutAllow = scoutAllowMatch
    ? scoutAllowMatch[1].split(/[、,，]/).map((item) => item.trim()).filter(Boolean)
    : []
  check(
    JSON.stringify(scoutAllow) === JSON.stringify(SCOUT_ALLOW),
    '侦察/复核模板允许工具集合精确为六项（追加 write 即失败）',
    scoutAllow.join(', ') || '空',
  )
  check(
    /你是只读侦察与复核子代理，负责为主代理取证。/.test(scoutTemplate ?? ''),
    '侦察/复核模板明确“只读”定位（精确句）',
  )
  check(
    !/可写侦察|可写子代理|可以写文件|允许写文件/.test(scoutTemplate ?? ''),
    '侦察/复核模板没有“可写”类反向表述',
  )
  check(
    /需要写文件、改代码、跑命令、取 Git 历史、跑测试或构建时，不要绕路：在回传里写「需要主代理改派或提供材料」。写、Shell、Git、测试、构建都不属于你。/.test(
      scoutTemplate ?? '',
    ),
    '侦察/复核模板对越界请求给出精确拒绝指令',
  )

  // 文书模板按编号规则断言：删掉某条规则或改写某条语义都会失败。
  const scribeRules = numberedRules(scribeTemplate ?? '')
  check(
    scribeRules.size === 6,
    '文书模板保留 6 条编号规则',
    [...scribeRules.keys()].join(', ') || '空',
  )
  check(
    /^只允许写规划与复核类文档（设计稿、实施计划、复核报告、决策记录）。/.test(scribeRules.get(3) ?? '') &&
      /超出文书子代理职责/.test(scribeRules.get(3) ?? ''),
    '文书模板规则 3 限定文档写入范围（改成任意文件即失败）',
    scribeRules.get(3) ?? '缺',
  )
  check(
    /^不使用\s*Shell、Web、搜索与委派工具，也不要尝试替代。/.test(scribeRules.get(5) ?? ''),
    '文书模板规则 5 精确禁止 Shell/Web/搜索/委派',
    scribeRules.get(5) ?? '缺',
  )
  check(
    /^config_\*、working_directory 以及任何未声明的工具都不得调用。/.test(scribeRules.get(6) ?? ''),
    '文书模板规则 6 精确禁止 config_* 与 working_directory',
    scribeRules.get(6) ?? '缺',
  )
  check(
    !/任意文件|任意路径|任何文件/.test(scribeTemplate ?? ''),
    '文书模板没有放开为可写任意文件',
  )

  // standard 的工具 / persona / AGENTS.md / 技能目录不得被用来扩大角色边界。
  const BOUNDARY_TEXT =
    'standard 的工具、persona、项目 AGENTS.md 或技能目录即使出现更多能力，也不得据此扩大本角色边界'
  const CONFLICT_TEXT =
    '若更高优先级指令与本模板的角色边界冲突，停止相关动作，并在回传里向主代理报告冲突，不擅自越界执行'
  for (const [name, template] of [
    ['侦察/复核', scoutTemplate],
    ['文书', scribeTemplate],
  ]) {
    check(
      (template ?? '').includes(BOUNDARY_TEXT),
      `${name}模板禁止因 standard/AGENTS/skills 扩大角色边界`,
    )
    check((template ?? '').includes(CONFLICT_TEXT), `${name}模板要求高层指令冲突时停止并报告`)
  }

  const dispatchSection = (() => {
    const start = personaText.indexOf('## 角色模板')
    const end = personaText.indexOf('===== ROLE-TEMPLATE:SCOUT:BEGIN')
    return start >= 0 && end > start ? personaText.slice(start, end) : ''
  })()
  check(
    dispatchSection.includes('AGENTS.md') &&
      dispatchSection.includes('技能目录') &&
      dispatchSection.includes('扩大角色边界') &&
      dispatchSection.includes('停止相关动作') &&
      dispatchSection.includes('报告冲突'),
    '派遣纪律禁止因 standard/AGENTS/skills 扩大角色边界并要求报告冲突',
    dispatchSection.length > 0 ? '命中' : '未找到派遣段',
  )
  check(
    !/(用户\s*prompt|用户提示词)[^\n]{0,24}(优先|高于)[^\n]{0,24}(系统|persona|AGENTS)/i.test(personaText),
    'persona 没有“用户 prompt 优先于系统/persona/AGENTS”的错误优先级声明',
  )

  check(
    /recon\s*与\s*review[^\n]*侦察\/复核角色模板/.test(personaText) &&
      /scribe[^\n]*文书角色模板/.test(personaText),
    '派遣指令分别绑定 recon/review 与 scribe',
  )
  check(
    /每次调用都完整附带/.test(personaText) &&
      /(不能|不得)省略/.test(personaText) &&
      /以模板为准/.test(personaText) &&
      /不放宽模板/.test(personaText),
    '派遣纪律要求逐字附带、不得省略/改写、冲突以模板为准',
  )
  check(
    /standard preset/.test(personaText) &&
      /不是机制强制/.test(personaText) &&
      /Shell/.test(personaText) &&
      /写文件/.test(personaText),
    'persona 诚实说明 standard 子代理拥有完整工具面、模板只是提示词约束',
  )

  // ── compaction 形状 ───────────────────────────────────────────────────────
  const compactionRows = flatten(devPlan?.plugins)
  const compactionGroup = compactionRows.find((row) => row?.id === 'compaction')
  const compactionChildren = pluginNames(Array.isArray(compactionGroup?.config) ? compactionGroup.config : [])
  check(Boolean(compactionGroup && compactionGroup.group === true), 'dev-plan compaction 是 group')
  check(
    compactionGroup?.isolate?.compaction === true && compactionGroup?.isolate?.toolResultPruner === true,
    'dev-plan compaction isolate 两个键都为 true',
  )
  check(
    ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner'].every(
      (name) => compactionChildren.includes(name),
    ),
    'dev-plan compaction 组含三行',
    compactionChildren.join(', '),
  )

  // ── dev-plan 工具面（不因角色模板迁移而放宽）────────────────────────────────
  const devPlanRows = flatten(devPlan?.plugins)
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

  for (const row of subagentRows) {
    const cfg = row.config ?? {}
    const name = cfg.toolName
    check(cfg.provider === 'spawn', `${name} provider=spawn（只有进程内 spawn 支持 agentPreset）`)
    check(cfg.agentPreset === 'standard', `${name} agentPreset=standard`, String(cfg.agentPreset))
    check(cfg.maxDepth === 1, `${name} maxDepth=1`, String(cfg.maxDepth))
    check(cfg.modelSelection === false, `${name} 关闭 modelSelection`)
    check(cfg.modelDiscovery === false, `${name} 关闭 modelDiscovery`)
    check(cfg.allowedAgentPresets === undefined, `${name} 不设 allowedAgentPresets（角色靠工具名路由）`)
    check(
      cfg.agentOptions?.provider === EXPECTED_ROUTE.provider,
      `${name} agentOptions.provider 精确为 ${EXPECTED_ROUTE.provider}`,
      String(cfg.agentOptions?.provider),
    )
    check(
      cfg.agentOptions?.model === EXPECTED_ROUTE.model,
      `${name} agentOptions.model 精确为 ${EXPECTED_ROUTE.model}`,
      String(cfg.agentOptions?.model),
    )
    check(
      JSON.stringify(cfg.agentOptions) === JSON.stringify(EXPECTED_ROUTE),
      `${name} agentOptions 只含 provider/model 两个键`,
      JSON.stringify(cfg.agentOptions),
    )
  }
  check(!presets.has('standard'), 'agentPreset=standard 指向宿主内置 preset，不由本包注册')

  // ── 已删除 preset 的注册路径全部清理 ──────────────────────────────────────
  const indexSource = files['index.js'] ?? ''
  check(!/scout|scribe/i.test(indexSource), 'index.js 不再引用 scout/scribe（注册路径已清理）')
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
    check(
      typeof locale?.meta?.description === 'string' && locale.meta.description.length > 0,
      `${rel} 有 meta.description`,
    )
    check(locale?.meta?.detail === 'detail.md', `${rel} 的 meta.detail 指向 detail.md`)
  }
  const zhDescription = (() => {
    try {
      return JSON.parse(files['locale/zh.json'] ?? '{}')?.meta?.description ?? ''
    } catch {
      return ''
    }
  })()
  const enDescription = (() => {
    try {
      return JSON.parse(files['locale/en.json'] ?? '{}')?.meta?.description ?? ''
    } catch {
      return ''
    }
  })()
  check(!/只读的\s*scout/.test(String(zhDescription)), 'locale/zh 不把 scout 说成独立只读 preset', String(zhDescription).slice(0, 40))
  check(/模板/.test(String(zhDescription)), 'locale/zh 描述说明角色靠模板携带')
  check(/template/i.test(String(enDescription)), 'locale/en 描述说明角色靠 template 携带')
  check(
    /完整工具面/.test(String(zhDescription)) &&
      /任务级提示词约束/.test(String(zhDescription)) &&
      /不是工具\/权限隔离/.test(String(zhDescription)),
    'locale/zh 说明 standard 保留完整工具面、模板只是任务级提示词约束',
    String(zhDescription).slice(0, 60),
  )
  check(
    /full tool surface/i.test(String(enDescription)) &&
      /task-level prompt constraints/i.test(String(enDescription)) &&
      /not tool or permission isolation/i.test(String(enDescription)),
    'locale/en 说明 standard 保留完整工具面、模板只是任务级提示词约束',
    String(enDescription).slice(0, 80),
  )

  const readme = files['README.md'] ?? ''
  for (const marker of [
    '方案 A',
    '方案 B',
    '取舍',
    '只注册',
    'dev-plan',
    '角色模板',
    'standard',
    '提示词',
    '声明级',
    '任务级',
    '实际可见工具面',
    'config_',
    'working_directory',
    'dsh-opencode-go',
    'deepseek-v4.1-flash',
    'askLimit',
    '软约束',
    'AGENTS.md',
    '技能目录',
    '高层指令',
  ]) {
    check(readme.includes(marker), `README 含关键说明：${marker}`)
  }
  check(
    /只注册\s*1?\s*个\s*preset/.test(readme) || /只注册\s*`?dev-plan`?/.test(readme),
    'README 明确当前只注册 dev-plan',
  )
  check(
    /不再是独立 preset 的声明级/.test(readme) ||
      (/不再是独立 preset/.test(readme) && /声明级/.test(readme) && /提示词约束/.test(readme)),
    'README 说明 scout/scribe 不再是独立 preset 的声明级隔离',
  )
  check(
    /上次安装操作记录/.test(readme) && /0\.1\.0\s*\/\s*applied/.test(readme),
    'README 区分上次安装操作记录为 0.1.0/applied',
  )
  check(
    /live listing/.test(readme) && /0\.2\.0/.test(readme) && /enabled\/installed=true/.test(readme),
    'README 记录管理器 live listing 已读为 0.2.0/enabled/installed',
  )
  check(
    /list_bundles/.test(readme) && /(不是|不能当|不能当作?)[^\n]{0,12}重装配证据/.test(readme),
    'README 说明 list_bundles 不是重装配证据',
  )
  check(
    /no-op/.test(readme) &&
      (/确认[^\n]{0,20}(apply|重装配)|(apply|重装配)[^\n]{0,20}确认/.test(readme)),
    'README 说明同 link 重装 no-op 需确认实际 apply',
  )
  check(
    !/(插件管理器|管理器)(仍然|仍|还是)[^\n]{0,12}(旧|0\.1\.0)/.test(readme) &&
      !/运行中的装配(仍然|仍|还是)[^\n]{0,12}旧/.test(readme),
    'README 不再声称插件管理器或运行装配停留在旧 0.1.0',
  )
  const README_STALE = [
    /内部角色\s*·\s*只读侦察/,
    /内部角色\s*·\s*文档记录/,
    /preset-scout/,
    /preset-scribe/,
    /注册(了)?\s*(三个|3\s*个)\s*preset/,
    /三个 preset，一条分工线/,
    /插件管理器仍是旧/,
    /运行中的装配仍是旧/,
    /管理器没有重新 apply、没有重启/,
  ]
  const readmeStale = README_STALE.filter((re) => re.test(readme)).map(String)
  check(readmeStale.length === 0, 'README 不把 scout/scribe 描述为已注册 preset', readmeStale.join(', ') || '无')
  check(!/不是[\u201c"]被要求不要用[\u201d"]/.test(readme), 'README 没有“不是被要求不要用”这类错误硬保证')

  const detailDoc = files['detail.md'] ?? ''
  check(detailDoc.length > 500, 'detail.md 是实质文档', `${detailDoc.length} chars`)
  for (const marker of ['方案 B', '只注册', '角色模板', 'standard', '任务级', '不是硬安全隔离']) {
    check(detailDoc.includes(marker), `detail.md 含关键说明：${marker}`)
  }
  const detailStale = README_STALE.filter((re) => re.test(detailDoc)).map(String)
  check(detailStale.length === 0, 'detail.md 不把 scout/scribe 描述为已注册 preset', detailStale.join(', ') || '无')
  check(
    /live listing/.test(detailDoc) && /0\.2\.0/.test(detailDoc) && /0\.1\.0\s*\/\s*applied/.test(detailDoc),
    'detail.md 区分上次安装记录与 live listing',
  )

  check(/node_modules/.test(files['.gitignore'] ?? ''), '.gitignore 忽略 node_modules')

  return results
}

// ── 变异层：故意改坏，断言检查会失败 ──────────────────────────────────────────
const clone = (value) => JSON.parse(JSON.stringify(value))

const REMOVE_TEMPLATE = (text, name) =>
  String(text).replace(
    new RegExp(
      `^[ \\t]*=+ ROLE-TEMPLATE:${name}:BEGIN =+[ \\t]*\\r?\\n[\\s\\S]*?^[ \\t]*=+ ROLE-TEMPLATE:${name}:END =+[ \\t]*$\\r?\\n?`,
      'm',
    ),
    '',
  )

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
    name: 'agentPreset 被改回 scout（误改 standard / 遗留绑定）',
    expect: 'agentPreset=standard',
    mutate(data) {
      findSubagentRow(data, 'review').config.agentPreset = 'scout'
    },
  },
  {
    name: 'maxDepth 被放宽到 2',
    expect: 'maxDepth=1',
    mutate(data) {
      findSubagentRow(data, 'scribe').config.maxDepth = 2
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
    name: '侦察/复核角色模板被整段删除',
    expect: '侦察/复核角色模板存在且完整',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = REMOVE_TEMPLATE(persona.config.prefix, 'SCOUT')
    },
  },
  {
    name: '文书角色模板被整段删除',
    expect: '文书角色模板存在且完整',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = REMOVE_TEMPLATE(persona.config.prefix, 'SCRIBE')
    },
  },
  {
    name: '派遣绑定行被删除（recon/review 不再要求附带模板）',
    expect: '派遣指令分别绑定 recon/review 与 scribe',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        /^[ \t]*1\. recon 与 review：[^\n]*\r?\n/m,
        '',
      )
    },
  },
  {
    name: '把 fs 工具行加回主代理',
    expect: 'dev-plan 不挂载 @deepseek-ai/dsh-tool-fs',
    mutate(data) {
      const preset = findPresetRow(data, 'dev-plan')
      preset.config.plugins.push({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' })
    },
  },
  {
    name: '重新注册 scout preset（遗留注册路径）',
    expect: '只注册 1 个 preset',
    mutate(data) {
      data.rows.push({
        name: '@deepseek-ai/dsh-agent-preset',
        config: { id: 'scout', name: '内部角色 · 只读侦察', order: 90, plugins: [] },
      })
    },
  },
  {
    name: '已删除的 scout 补丁文件被复活',
    expect: '已删除的补丁文件不存在',
    mutate(data) {
      data.files['presets/scout.patch.yml'] = '# resurrected\n'
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
    name: 'dev-plan suffix 被改成禁止引用任何外部测试结论',
    expect: 'suffix 允许注明来源地引用执行窗口结论',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.suffix = '任何消息都不得宣称执行过测试，也不得引用执行窗口提供的测试结论。\n'
    },
  },
  {
    name: 'README 恢复声称注册 scout/scribe preset 的陈旧说法',
    expect: 'README 不把 scout/scribe 描述为已注册 preset',
    mutate(data) {
      data.files['README.md'] += '\n| `scout`（内部角色 · 只读侦察） | 被 recon 调用 | read/grep | 写、Shell |\n'
    },
  },
  // ── 语义变异：词还在，但边界被改坏。逐条必须被精确/结构断言抓住。──────────────
  {
    name: '侦察模板把“只读侦察”改成“可写侦察”',
    expect: '侦察/复核模板明确“只读”定位',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        '你是只读侦察与复核子代理',
        '你是可写侦察与复核子代理',
      )
    },
  },
  {
    name: '侦察允许清单追加 write',
    expect: '侦察/复核模板允许工具集合精确为六项',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        '允许使用的工具只有：read、read_image、glob、grep、web_search、web_fetch。',
        '允许使用的工具只有：read、read_image、glob、grep、web_search、web_fetch、write。',
      )
    },
  },
  {
    name: '删除文书模板“不使用 Shell/Web/搜索/委派”规则',
    expect: '文书模板规则 5 精确禁止',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        /^[ \t]*5\. 不使用 Shell、Web、搜索与委派工具[^\n]*\r?\n/m,
        '',
      )
    },
  },
  {
    name: '删除文书模板“禁止 config_*/working_directory”规则',
    expect: '文书模板规则 6 精确禁止',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        /^[ \t]*6\. config_\*、working_directory[^\n]*\r?\n/m,
        '',
      )
    },
  },
  {
    name: '文书模板把“只写规划/复核文档”改成“可写任意文件”',
    expect: '文书模板规则 3 限定文档写入范围',
    mutate(data) {
      const persona = findPersonaRow(data, 'dev-plan')
      persona.config.prefix = persona.config.prefix.replace(
        /^[ \t]*3\. 只允许写规划与复核类文档[^\n]*\r?\n/m,
        '                3. 可以写任意文件，包括产品代码、配置、依赖与脚本。\n',
      )
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
  console.log(
    `node --check index.js：${syntax.ok ? 'PASS' : `FAIL（status=${syntax.status}${syntax.error ? `, ${syntax.error}` : ''}）`}`,
  )

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
    const hits = outcome.filter((item) => item.label.includes(mutation.expect))
    if (hits.length > 0) {
      detected += 1
      detectedNames.push(`${mutation.name} ← ${hits.map((item) => item.label).join('；')}`)
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
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (invokedDirectly) {
  await main()
}
