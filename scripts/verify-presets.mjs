#!/usr/bin/env node
/**
 * verify-presets.mjs — 0.3.0 合同自检（不启动 DSH、不安装、不改 profile）
 *
 * 覆盖五层：
 *   1. 打包层：package.json / exports / files / bundle patch / client manifest；
 *   2. 声明层：动态 preset 的四个委派工具、任意可用预设与回退、主窗工具面、persona 合同；
 *   3. 代码层：node --check + 真实模块 import + 假 ctx 驱动动态注册/守门/设置路由；
 *   4. 文档层：README / detail / locale 必须写清回退、迁移、模型守门与未验证项；
 *   5. 变异层：故意改坏关键点，断言上文检查确实会 FAIL（不是只写 smoke）。
 *
 * 它不能证明运行期宿主行为（preset 是否出现在选择器、子会话是否真的使用目标模型、
 * 设置页在真实 GUI 中是否渲染）。那部分见 README「验证」的手工清单。
 *
 * 用法：
 *   node scripts/verify-presets.mjs
 *   node scripts/verify-presets.mjs --verbose
 *
 * 本脚本不依赖 js-yaml / @deepseek-ai/*，也不启动任何服务器。
 */

import { readFileSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { loadModules, createFakeContext, createFakeRegistry, createFakeWebServer, createFakeConfigEditor, createFakeAgent, callRoute } from './test-harness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VERBOSE = process.argv.includes('--verbose')
const RUNTIME_FILES = ['index.js', 'preset.js', 'settings.js', 'guard.js', 'client.js']
const REQUIRED_FILES = [
  'package.json',
  'index.js',
  'preset.js',
  'settings.js',
  'guard.js',
  'client.js',
  'cordis.patch.yml',
  'locale/zh.json',
  'locale/en.json',
  'icon.svg',
  'README.md',
  'detail.md',
  'docs/flow-redesign.md',
  'LICENSE',
  'scripts/verify-presets.mjs',
  'test/plugin.test.mjs',
]
const SOCIAL_FILES = ['README.md', 'detail.md', 'LICENSE']

const readText = (rel) => {
  try {
    return readFileSync(join(ROOT, rel), 'utf8')
  } catch {
    return null
  }
}

const readJson = (rel) => {
  const text = readText(rel)
  if (text === null) return { value: null, error: `${rel} 不存在` }
  try {
    return { value: JSON.parse(text), error: null }
  } catch (error) {
    return { value: null, error: `${rel} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}` }
  }
}

const flattenPlugins = (plugins, out = []) => {
  for (const row of plugins ?? []) {
    out.push(row)
    if (Array.isArray(row?.config)) flattenPlugins(row.config, out)
  }
  return out
}

const findPresetPlugin = (definition, id) => (definition?.plugins ?? []).find((row) => row?.id === id)
const findTool = (definition, toolName) =>
  flattenPlugins(definition?.plugins).find(
    (row) => row?.name === '@deepseek-ai/dsh-tool-subagent' && row?.config?.toolName === toolName,
  )

const globCovers = (pattern, rel) => {
  if (!pattern.includes('*')) {
    const directory = pattern.replace(/\/+$/, '')
    return pattern === rel || rel.startsWith(`${directory}/`)
  }
  const [prefix, suffix] = pattern.split('*')
  return rel.startsWith(prefix) && rel.endsWith(suffix)
}

const fileCovered = (patterns, rel) => (patterns ?? []).some((pattern) => globCovers(String(pattern), rel))

/** 读取待检查面（真实文件 + 真实模块构建出的两个 definition）。 */
export async function loadSurface() {
  const pkgRead = readJson('package.json')
  const localeZh = readJson('locale/zh.json')
  const localeEn = readJson('locale/en.json')
  const files = {}
  for (const rel of [...new Set([...REQUIRED_FILES, ...SOCIAL_FILES, ...RUNTIME_FILES])]) {
    files[rel] = readText(rel)
  }
  const modules = await loadModules(ROOT)
  const base = { ...modules.settings.DEFAULT_SETTINGS }
  const standardMode = modules.preset.resolveDevelopMode({ requestedMode: 'standard' })
  const fallbackMode = modules.preset.resolveDevelopMode({
    requestedMode: 'deep-ptc',
    presets: [],
    catalogChecked: true,
  })
  const deepPtcMode = modules.preset.resolveDevelopMode({
    requestedMode: 'deep-ptc',
    presets: [{ id: 'deep-ptc', name: '深度 PTC' }],
    catalogChecked: true,
  })
  const customMode = modules.preset.resolveDevelopMode({
    requestedMode: 'team-builder',
    presets: [{ id: 'team-builder', name: '团队施工' }],
    catalogChecked: true,
  })
  const selfMode = modules.preset.resolveDevelopMode({
    requestedMode: 'dev-plan',
    presets: [{ id: 'dev-plan', name: '开发规划与交付' }],
    catalogChecked: true,
  })
  const scoutSelfMode = modules.preset.resolveDevelopMode({
    requestedMode: 'dev-plan-scout',
    presets: [{ id: 'dev-plan-scout' }],
    catalogChecked: true,
  })
  const scribeSelfMode = modules.preset.resolveDevelopMode({
    requestedMode: 'dev-plan-scribe',
    presets: [{ id: 'dev-plan-scribe' }],
    catalogChecked: true,
  })
  const internalActive = { scout: false, scribe: false }
  const standard = modules.preset.buildPresetDefinition({
    settings: base,
    mode: standardMode,
    internalPresets: internalActive,
  })
  const standardFallbackSub = modules.preset.buildPresetDefinition({
    settings: base,
    mode: standardMode,
    internalPresets: { scout: false, scribe: false },
  })
  const noneMode = modules.preset.buildPresetDefinition({
    settings: { ...base, mainToolMode: 'none' },
    mode: standardMode,
    internalPresets: internalActive,
  })
  const readonlyMode = modules.preset.buildPresetDefinition({
    settings: { ...base, mainToolMode: 'readonly' },
    mode: standardMode,
    internalPresets: internalActive,
  })
  const askEditMode = modules.preset.buildPresetDefinition({
    settings: { ...base, mainToolMode: 'ask-edit' },
    mode: standardMode,
    internalPresets: internalActive,
  })
  const fallback = modules.preset.buildPresetDefinition({
    settings: base,
    mode: fallbackMode,
    internalPresets: internalActive,
  })
  const deepPtc = modules.preset.buildPresetDefinition({
    settings: base,
    mode: deepPtcMode,
    internalPresets: internalActive,
  })
  const custom = modules.preset.buildPresetDefinition({
    settings: base,
    mode: customMode,
    internalPresets: internalActive,
  })
  const withEffort = modules.preset.buildPresetDefinition({
    settings: { ...base, childReasoningEffort: 'high' },
    mode: standardMode,
    internalPresets: internalActive,
  })
  const scoutPreset = modules.preset.buildScoutPresetDefinition()
  const scribePreset = modules.preset.buildScribePresetDefinition()
  return {
    root: ROOT,
    pkg: pkgRead.value,
    pkgError: pkgRead.error,
    pkgText: readText('package.json'),
    patchText: readText('cordis.patch.yml'),
    locale: { zh: localeZh.value, en: localeEn.value },
    localeErrors: { zh: localeZh.error, en: localeEn.error },
    readme: readText('README.md'),
    detail: readText('detail.md'),
    files,
    modules,
    standard,
    standardFallbackSub,
    noneMode,
    readonlyMode,
    askEditMode,
    scoutPreset,
    scribePreset,
    fallback,
    deepPtc,
    custom,
    selfFallback: selfMode,
    scoutSelfFallback: scoutSelfMode,
    scribeSelfFallback: scribeSelfMode,
    withEffort,
    constants: {
      presetId: modules.preset.PRESET_ID,
      scoutPresetId: modules.preset.SCOUT_PRESET_ID,
      scribePresetId: modules.preset.SCRIBE_PRESET_ID,
      presetName: modules.preset.PRESET_NAME,
      order: modules.preset.PRESET_ORDER,
      deepPtcId: modules.preset.DEEP_PTC_PRESET_ID,
    },
  }
}

/** 纯检查：给定 surface，返回 { ok, label, detail } 列表。 */
export function checksFor(surface) {
  const results = []
  const check = (ok, label, detail = '') => results.push({ ok: Boolean(ok), label, detail: String(detail) })
  const {
    pkg,
    pkgError,
    files,
    standard,
    standardFallbackSub,
    noneMode,
    readonlyMode,
    askEditMode,
    scoutPreset,
    scribePreset,
    fallback,
    deepPtc,
    custom,
    withEffort,
    readme,
    detail,
    locale,
  } = surface

  // ── 打包层 ────────────────────────────────────────────────────────────────
  check(pkgError === null, 'package.json 是合法 JSON', pkgError ?? '')
  check(pkg?.name === 'dsh-dev-plan-presets', 'package.json name', pkg?.name)
  check(pkg?.version === '0.4.0', 'package.json version=0.4.0', pkg?.version)
  check(pkg?.type === 'module', 'package.json type=module')
  check(pkg?.private === false, 'package.json private=false（可开源发布）', String(pkg?.private))
  check(pkg?.license === 'MIT', 'package.json license=MIT', pkg?.license)
  check(pkg?.engines?.dsh === '>=0.2.2-rc.3', 'package.json engines.dsh 为已验证基线 >=0.2.2-rc.3', String(pkg?.engines?.dsh))

  const patch = pkg?.dsh?.bundle?.patch
  const patchList = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
  check(patchList.length === 1, 'dsh.bundle.patch 只有 1 个补丁', JSON.stringify(patch))
  check(patchList[0] === './cordis.patch.yml', 'dsh.bundle.patch 指向 cordis.patch.yml', String(patchList[0]))
  check(pkg?.dsh?.client?.platform === 'web', 'dsh.client.platform=web')
  check(pkg?.dsh?.client?.immediately === true, 'dsh.client.immediately=true')

  const exportsMap = pkg?.exports ?? {}
  for (const required of ['.', './client', './preset', './settings', './package.json', './cordis.patch.yml', './locale/*.json', './icon']) {
    check(Object.hasOwn(exportsMap, required), `exports 暴露 ${required}`)
  }
  for (const [key, target] of Object.entries(exportsMap)) {
    if (typeof target !== 'string') {
      check(false, `exports ${key} 是字符串`, typeof target)
      continue
    }
    const clean = target.replace(/^\.\//, '')
    const candidates = clean.includes('*')
      ? Object.keys(files).filter((rel) => globCovers(clean, rel))
      : [clean]
    check(
      candidates.length > 0 && candidates.every((rel) => files[rel] !== null && files[rel] !== undefined),
      `exports ${key} 指向真实文件`,
      candidates.join(', ') || '无匹配',
    )
  }
  check(exportsMap['.'] === './index.js', 'exports . 指向 index.js', exportsMap['.'])
  check(exportsMap['./client'] === './client.js', 'exports ./client 指向 client.js', exportsMap['./client'])

  const runtimeFiles = [...RUNTIME_FILES, 'cordis.patch.yml', 'locale/zh.json', 'locale/en.json', 'icon.svg', 'README.md', 'detail.md', 'docs/flow-redesign.md', 'LICENSE']
  for (const rel of runtimeFiles) check(fileCovered(pkg?.files, rel), `files 覆盖 ${rel}`, rel)
  for (const rel of REQUIRED_FILES) check(files[rel] !== null, `文件存在：${rel}`)

  check(!existsSync(join(ROOT, 'presets/dev-plan.patch.yml')), '旧的静态 preset 补丁已删除')
  check(!/\bjs-yaml\b|\byaml\b/.test(String(pkg?.dependencies ?? {})) && !/\bjs-yaml\b/.test(String(pkg?.devDependencies ?? {})), '不依赖 js-yaml')
  check(!Object.keys(pkg?.dependencies ?? {}).some((name) => /deep-ptc|deep_ptc/.test(name)), '不依赖 deep-ptc 包')
  check(!Object.keys(pkg?.dependencies ?? {}).length, '运行期零 dependencies', Object.keys(pkg?.dependencies ?? {}).join(', '))
  check(!/\b@deepseek-ai\//.test(String((pkg?.peerDependencies ?? {}))) && !/\b@deepseek-ai\//.test(String((pkg?.dependencies ?? {}))), '不声明 @deepseek-ai/* 依赖')

  // ── 根补丁：只挂根插件 ────────────────────────────────────────────────────
  const patchText = String(surface.patchText ?? '')
  // 只看非注释行：说明文字里出现 @deepseek-ai/dsh-agent-preset 是允许的。
  const patchActiveText = patchText
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
  check(/id:\s*dev-plan-presets/.test(patchActiveText), '根补丁挂 dev-plan-presets 行')
  check(/name:\s*dsh-dev-plan-presets/.test(patchActiveText), '根补丁 name=dsh-dev-plan-presets')
  check(!/@deepseek-ai\/dsh-agent-preset/.test(patchActiveText), '根补丁不再静态注册 dsh-agent-preset')
  check(!/preset-dev-plan|preset-scout|preset-scribe/.test(patchActiveText), '根补丁没有旧 preset-* 行')
  check(!/scout|scribe/i.test(patchActiveText), '根补丁不引用 scout/scribe')
  check(/developMode:\s*standard/.test(patchText), '根补丁默认 developMode=standard')
  check(/modelGuardMode:\s*pin/.test(patchText), '根补丁默认 modelGuardMode=pin')
  check(/guardAllSubagents:\s*false/.test(patchText), '根补丁默认 guardAllSubagents=false')
  check(/mainToolMode:\s*ask-edit/.test(patchText), '根补丁默认 mainToolMode=ask-edit')
  check(/mainStepWarnThreshold:\s*6/.test(patchText), '根补丁默认 mainStepWarnThreshold=6')
  check(/childProvider:\s*dsh-opencode-go/.test(patchText), '根补丁默认 provider=dsh-opencode-go')
  check(/childModel:\s*deepseek-v4\.1-flash/.test(patchText), '根补丁默认 model=deepseek-v4.1-flash')

  // ── 代码层：只允许宿主解析、不得手改 profile ───────────────────────────────
  const indexSource = String(files['index.js'] ?? '')
  const presetSource = String(files['preset.js'] ?? '')
  const settingsSource = String(files['settings.js'] ?? '')
  const guardSource = String(files['guard.js'] ?? '')
  const clientSource = String(files['client.js'] ?? '')
  for (const [name, source] of [
    ['index.js', indexSource],
    ['preset.js', presetSource],
    ['settings.js', settingsSource],
    ['guard.js', guardSource],
  ]) {
    check(!/from\s+['"]@deepseek-ai\//.test(source), `${name} 不 import @deepseek-ai/*（link 安装可解析）`)
    check(!/from\s+['"](?:js-yaml|yaml)['"]/.test(source), `${name} 不 import yaml 解析器`)
  }
  check(/ctx\.inject\(\['agentPresets'\]/.test(indexSource), 'index.js 通过 ctx.inject 等待 agentPresets')
  check(/registry\.register\(definition\)/.test(indexSource), 'index.js 真的调用 agentPresets.register')
  check(/releaseAll/.test(indexSource) && /child\.effect/.test(indexSource), '动态 preset disposer 交还给 ctx.effect')
  check(/stateVersion/.test(indexSource) && /bumpState/.test(indexSource) && /etag/i.test(indexSource) && /304/.test(indexSource), 'index.js 支持 stateVersion + ETag 304')
  check(/state\.mode\?\.fallback === true \|\| state\.presets\.checked !== true/.test(indexSource), 'index.js scheduleVerification 跳过已命中目标时的冗余二次全量探测')
  check(/prewarmModelCatalog/.test(indexSource) && /installMainStepBudget/.test(indexSource), 'index.js 包含模型目录空闲预热与主窗步数软提醒')
  check(/agent\/created/.test(guardSource), '模型守门监听 agent/created')
  check(/agent\/pre-step/.test(guardSource), '模型守门监听 agent/pre-step')
  check(/kind:\s*'reject'/.test(guardSource), '模型守门越界返回 reject')
  check(/cancel\(\{\s*kind:\s*'user'/.test(guardSource), '模型守门越界 cancel 子代理')
  check(/parent\?\.inject|parent\.inject/.test(guardSource), '模型守门通知父会话')
  check(/parentSession/.test(guardSource) && /origin === 'subagent'/.test(guardSource), '模型守门只认子代理 header')
  check(/agent\/disposed/.test(guardSource), '模型守门监听 agent/disposed 清理 step guard')
  check(/installMainStepBudget/.test(guardSource) && /mainToolMode/.test(guardSource), 'guard.js 提供主窗步数预算软提醒（永不 select/cancel）')
  check(/onDispose/.test(guardSource) && /if \(stopped\) return \{ kind: 'reject' \}/.test(guardSource), 'guard.js 支持 effect 同步清理 steps 与 stopped 前置短路')
  check(
    /guardAllSubagents !== true/.test(guardSource) && /presetForSession/.test(guardSource),
    'guard 默认按父会话 dev-plan 限制，并优先用 presetForSession',
  )
  check(
    /header\.origin === 'subagent'/.test(guardSource) &&
      /delegationDepth/.test(guardSource) &&
      !/if \(header\.parentSession\) return true/.test(guardSource),
    'guard 只认 origin=subagent 或 delegationDepth>0，不把 fork 主对话当子代理',
  )
  check(
    /MODEL_CATALOG_TTL_MS = 60_000/.test(indexSource) &&
      /modelCatalogSnapshot/.test(indexSource) &&
      !/await loadModelCatalog/.test(indexSource),
    '模型目录使用 60s 快照 + 后台刷新，不阻塞 /state',
  )
  check(/const steps = new Map\(\)/.test(guardSource), '模型守门按 agent 跟踪 step guard disposer')
  check(/for \(const dispose of pending\)/.test(guardSource), '模型守门总 disposer 卸载所有已装 step guard')
  check(/configEditor/.test(indexSource) && /editor\.edit/.test(indexSource), '设置保存走 configEditor.edit')
  check(!/cordis\.patch\.yml/.test(indexSource), 'Host 代码不手改 profile 的 cordis.patch.yml')
  check(/originProblem/.test(indexSource) && /sec-fetch-site/.test(indexSource), 'Host 配置写路由做 Origin/Sec-Fetch-Site 校验')
  check(/webServer\.getOrigin\(\)/.test(indexSource), 'Host 配置写路由使用 webServer.getOrigin() 权威 origin')
  check(/origin-not-authoritative/.test(indexSource), 'Host 配置写路由拒绝非监听 Origin')
  check(/LOOPBACK_HOSTS/.test(indexSource), 'Host 配置写路由仅对 loopback 别名做有限等价')
  check(!/restartRequired/.test(indexSource), 'Host 保存成功不再误报 restartRequired')
  check(/mediaTypeOf\(req\) !== 'application\/json'/.test(indexSource), 'Host 配置写路由只接受 application/json')
  for (const code of ['unsupported-media-type', 'forbidden-origin', 'invalid-config', 'config-editor-unavailable']) {
    check(indexSource.includes(`'${code}'`), `Host 配置写路由返回稳定 code ${code}`)
  }
  check(/errorCode: state\.error === null \? null : 'preset-registration-failed'/.test(indexSource), 'Host state 提供 registration 错误 code')
  check(/guardAllSubagents:\s*false/.test(settingsSource), 'settings 默认 guardAllSubagents=false')
  check(/probePresets/.test(indexSource) && /presets:\s*\{/.test(indexSource), 'Host 返回真实预设目录')
  check(/listProviders\(\)/.test(indexSource) && /listModels\(provider\.id\)/.test(indexSource), 'Host 枚举 provider/model 目录')
  check(/const failures = entries/.test(indexSource) && /failure:/.test(indexSource), 'Host 模型目录容忍单个 provider 失败')

  // ── client 设置页 ─────────────────────────────────────────────────────────
  check(/__ModuleLoader__\.load/.test(clientSource), 'client.js 是浏览器模块')
  check(/id:\s*'dsh-dev-plan-presets'/.test(clientSource), 'client.js 模块 id 正确')
  check(/plugins\.row\.config/.test(clientSource), 'client.js 注册 plugins.row.config')
  check(
    /key:\s*'dsh-dev-plan-presets#dev-plan-presets'/.test(clientSource),
    'client 注册 key=dsh-dev-plan-presets#dev-plan-presets',
  )
  check(/fetch\(API \+ '\/state'/.test(clientSource), 'client 读取 Host state 路由')
  check(/fetch\(API \+ '\/config'/.test(clientSource) && /method:\s*'POST'/.test(clientSource), 'client 通过 Host 路由保存配置')
  check(!/subagent-model-pin/.test(clientSource), 'client 不复用旧插件 id/路由')
  for (const marker of ['developMode', 'childProvider', 'childModel', 'childReasoningEffort', 'modelGuardMode', 'killOnViolation', 'honorExplicit', 'audit', 'guardAllSubagents', 'mainToolMode', 'mainStepWarnThreshold']) {
    check(clientSource.includes(marker), `client 设置页包含字段 ${marker}`)
  }
  check(/if-none-match/.test(clientSource) && /304/.test(clientSource) && /stateVersion/.test(clientSource), 'client 支持 ETag/304 与 stateVersion 跳过重渲染')
  check(/FAST_POLL_MS = 700/.test(clientSource) && /IDLE_POLL_MS = 30000/.test(clientSource) && /visibilitychange/.test(clientSource) && !/setInterval\(/.test(clientSource), 'client 使用自适应轮询与不可见暂停')
  check(/React\.useMemo/.test(clientSource) && /timersRef/.test(clientSource) && /AbortController/.test(clientSource), 'client 使用 useMemo 与定时器/请求清理')
  check(/state.presets/.test(clientSource) && /presetRows/.test(clientSource), 'client 从 /state 动态列出预设')
  check(!/value: *'deep-ptc'/.test(clientSource), 'client 不再硬编码 deep-ptc 选项')
  check(
    /state\.modelCatalog/.test(clientSource) &&
      /modelChoices/.test(clientSource) &&
      /providerChoices/.test(clientSource) &&
      /presetChoices/.test(clientSource),
    'client 从 /state 读取模型目录并用纯选择函数',
  )
  check(/htmlFor/.test(clientSource) && /aria-describedby/.test(clientSource), 'client 使用 label for 与帮助文本关联')
  check(/fieldset/.test(clientSource) && /legend/.test(clientSource), 'client 用 fieldset/legend 分组')
  check(/type: *'button'/.test(clientSource), 'client 次级按钮显式 type=button')
  check(!/configEditor/.test(clientSource), 'client 普通文案不出现 configEditor')
  check(!/reasoningEffort（可空）/.test(clientSource), 'client 不把 reasoningEffort 当主标签')
  check(/已回退 standard|Fell back to standard/.test(clientSource), 'client 显式显示回退 standard')
  check(
    ['未安装', '未启用', '已被移除', '加载失败'].every((marker) => clientSource.includes(marker)),
    'client 回退横幅涵盖不可用原因',
  )
  check(
    clientSource.includes('not installed') && clientSource.includes('failed to load'),
    'client 英文回退横幅涵盖不可用原因',
  )
  check(
    clientSource.includes('施工方式列表读取超时') && /setup list timed out/i.test(clientSource),
    'client 显示预设目录超时',
  )
  check(!/#[0-9a-fA-F]{3,8}|rgba?\(/.test(clientSource), 'client 不保留 hex/rgba 字面颜色')
  check(!/navigator\.language/.test(clientSource), 'client 不使用 navigator.language')
  check(
    clientSource.includes('开发规划与交付 · 施工设置') &&
      clientSource.includes('Development planning & delivery · development settings'),
    'client 设置页标题使用预设名「开发规划与交付」',
  )
  check(/getSnapshot/.test(clientSource) && /\.subscribe\(/.test(clientSource), 'client 通过 locale getSnapshot/subscribe 跟随宿主语言')
  check(/return locale\.subscribe/.test(clientSource), 'client 清理语言订阅')
  check(!/outline\s*:/.test(clientSource), 'client 不覆盖宿主焦点环')
  for (const token of [
    '--dsw-alias-border-l2',
    '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary',
    '--dsw-alias-label-tertiary',
    '--dsw-alias-state-error-primary',
    '--dsw-alias-state-success-primary',
    '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-warn-primary',
    '--dsw-alias-button-primary-fill',
    '--dsw-alias-label-on-color',
    '--dsw-alias-card-fill',
    '--dsw-radius-sm',
    '--dsw-radius-xs',
    '--ds-font-family-code',
  ]) {
    check(clientSource.includes(token), `client 使用已核实主题 token ${token}`)
  }
  check(/role:\s*'status'/.test(clientSource) && /role:\s*'alert'/.test(clientSource), 'client 状态/错误使用 role=status/alert')
  check(/aria-live/.test(clientSource), 'client 使用 aria-live')
  check(/buttonDisabled/.test(clientSource) && /not-allowed/.test(clientSource), 'client 按钮有真实禁用态样式')
  check(/未保存修改/.test(clientSource) && /已保存/.test(clientSource), 'client 常显保存状态')
  check(/notice\.kind === 'saved'/.test(clientSource), 'client 仅在 notice.kind=saved 时显示已保存')
  check(!/notice\.ok/.test(clientSource), 'client 不再用 notice.ok 判断成功')
  check(/const update = \(patch\) => \{\s*setNotice\(null\)/.test(clientSource), 'client 修改字段时清除旧通知')
  check(/kind:\s*'discarded'/.test(clientSource) && /已放弃修改/.test(clientSource), 'client 放弃修改有独立 kind/状态')
  check(/无法连接 Host/.test(clientSource) && /Cannot reach the Host/.test(clientSource), 'client network 错误给可执行指引')
  check(/仅 pin/.test(clientSource), 'client honorExplicit 标注仅 pin')
  check(/hostFormatted/.test(clientSource) && /formatted \? raw :/.test(clientSource), 'client 不重复叠加“保存失败”前缀')
  check(/放弃修改并刷新/.test(clientSource), 'client dirty 时刷新明确标记为放弃修改')
  check(/设置路由未注册/.test(clientSource) && /settings route is not registered/i.test(clientSource), 'client 404 给出可执行指引')
  check(/stopped\.current/.test(clientSource), 'client 连续 404 停止自动轮询')
  check(/scheduleRefresh\(600\)/.test(clientSource) && /scheduleRefresh\(1800\)/.test(clientSource), 'client 保存后可在 HMR 404 后重试回读')
  check(/registration === 'pending'/.test(clientSource) && /registration === 'failed'/.test(clientSource) && /registration === 'switching'/.test(clientSource), 'client 显示 pending/failed/switching 状态')
  check(/施工方式/.test(clientSource) && /守门方式/.test(clientSource), 'client 两个模式 label 已区分')
  check(/只记录，不阻止/.test(clientSource) && /记录详细日志/.test(clientSource), 'client 区分守门 audit 与审计日志开关')
  check(/当前生效/.test(clientSource) && /保存后以回读值为准/.test(clientSource), 'client 展示当前生效路由与回读提示')
  check(/overflowWrap/.test(clientSource), 'client 长原因可换行')
  check(/inject:\s*\['slots',\s*'locale'\]/.test(clientSource), 'client 注入 slots 与 locale')

  // ── 动态 preset：standard ────────────────────────────────────────────────
  const standardRows = flattenPlugins(standard?.plugins)
  check(standard?.id === surface.constants.presetId, 'preset id=dev-plan', standard?.id)
  check(standard?.id === 'dev-plan', 'preset id 保持 dev-plan')
  check(standard?.name === '开发规划与交付', 'preset 显示名为「开发规划与交付」', standard?.name)
  check(surface.constants.presetName === '开发规划与交付', 'PRESET_NAME=开发规划与交付', surface.constants.presetName)
  check(standard?.order === 10, 'preset order=10', String(standard?.order))
  check(typeof standard?.description === 'string' && standard.description.length > 0, 'preset 有动态 description')
  check(/standard/.test(standard?.description ?? ''), '默认 description 写明 standard')

  const noneModeRows = flattenPlugins(noneMode?.plugins)
  for (const forbidden of surface.modules.preset.FORBIDDEN_MAIN_PLUGINS) {
    check(!noneModeRows.some((row) => row?.name === forbidden), `主窗(none)不挂载 ${forbidden}`)
  }
  for (const neverMain of [
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
  ]) {
    check(!standardRows.some((row) => row?.name === neverMain), `主窗默认(ask-edit)不挂载 ${neverMain}`)
  }
  for (const required of [
    '@deepseek-ai/dsh-persona',
    '@deepseek-ai/dsh-agent-instructions',
    '@deepseek-ai/dsh-time-context',
    '@deepseek-ai/dsh-tool-ask-user',
    '@deepseek-ai/dsh-tool-subagent-control',
  ]) {
    check(standardRows.some((row) => row?.name === required), `主窗挂载 ${required}`)
  }

  const toolRows = flattenPlugins(standard?.plugins).filter((row) => row?.name === '@deepseek-ai/dsh-tool-subagent')
  check(toolRows.length === 4, '主窗恰好 4 个委派工具', String(toolRows.length))
  const toolNames = toolRows.map((row) => row?.config?.toolName)
  check(JSON.stringify([...toolNames].sort()) === JSON.stringify(['develop', 'recon', 'review', 'scribe']), '四个委派工具是 recon/review/scribe/develop', toolNames.join(', '))
  check(new Set(toolNames).size === toolNames.length, 'toolName 互不重复')
  check(
    toolRows.find((row) => row?.config?.toolName === 'develop')?.config?.agentPreset === 'standard',
    'develop 默认使用 standard',
  )
  for (const name of ['recon', 'review', 'scribe']) {
    check(
      toolRows.find((row) => row?.config?.toolName === name)?.config?.agentPreset === 'standard',
      `${name} 使用 standard（避免在预设下拉暴露额外选项）`,
    )
  }

  // ── mainToolMode 三档与内部轻量子预设插件面 ─────────────────────────────
  const forbiddenSubagentPkgs = [
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-schedule',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-tool-subagent',
    '@deepseek-ai/dsh-plan-mode',
  ]
  const scoutRows = flattenPlugins(scoutPreset?.plugins)
  const scribeRows = flattenPlugins(scribePreset?.plugins)
  for (const pkgName of forbiddenSubagentPkgs) {
    check(!scoutRows.some((r) => r?.name === pkgName), `dev-plan-scout 不含 ${pkgName}`)
    check(!scribeRows.some((r) => r?.name === pkgName), `dev-plan-scribe 不含 ${pkgName}`)
  }
  check(
    scoutRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs')?.config?.applyPatch === false &&
      scoutRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs-search')?.config?.sampleOverCapGlobResults === false &&
      scoutRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-web')?.config?.fetch === true,
    'dev-plan-scout 仅挂载只读 fs/search/web 且带宿主必需配置',
  )
  const scribeCompaction = (scribePreset?.plugins ?? []).find((r) => r?.id === 'compaction')
  check(
    scribeCompaction?.group === true &&
      scribeCompaction?.isolate?.compaction === true &&
      scribeRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs')?.config?.applyPatch === false &&
      !scribeRows.some((r) => r?.name === '@deepseek-ai/dsh-tool-fs-search') &&
      !scribeRows.some((r) => r?.name === '@deepseek-ai/dsh-tool-web'),
    'dev-plan-scribe 仅挂载 tool-fs 且 compaction 带 isolate 隔离组',
  )

  const readonlyRows = flattenPlugins(readonlyMode?.plugins)
  const askEditRows = flattenPlugins(askEditMode?.plugins)
  check(
    readonlyRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs-search')?.config?.sampleOverCapGlobResults === false &&
      !readonlyRows.some((r) => r?.name === '@deepseek-ai/dsh-tool-fs'),
    'mainToolMode=readonly 仅新增带有效配置的 tool-fs-search，不含 tool-fs',
  )
  check(
    askEditRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs')?.config?.applyPatch === false &&
      askEditRows.find((r) => r?.name === '@deepseek-ai/dsh-tool-fs-search')?.config?.sampleOverCapGlobResults === false,
    'mainToolMode=ask-edit 仅新增 tool-fs(applyPatch:false) + 带有效配置的 tool-fs-search',
  )
  for (const pkgName of [
    '@deepseek-ai/dsh-tool-bash',
    '@deepseek-ai/dsh-tool-pwsh',
    '@deepseek-ai/dsh-tool-workflow',
    '@deepseek-ai/dsh-tool-jobs',
    '@deepseek-ai/dsh-tool-schedule',
    '@deepseek-ai/dsh-tool-goal',
    '@deepseek-ai/dsh-tool-skill',
    '@deepseek-ai/dsh-tool-todo',
    '@deepseek-ai/dsh-plan-mode',
  ]) {
    check(!readonlyRows.some((r) => r?.name === pkgName), `readonly 永不挂载 ${pkgName}`)
    check(!askEditRows.some((r) => r?.name === pkgName), `ask-edit 永不挂载 ${pkgName}`)
  }
  for (const row of toolRows) {
    const cfg = row.config ?? {}
    const name = cfg.toolName
    check(cfg.provider === 'spawn', `${name} provider=spawn`)
    check(cfg.maxDepth === 1, `${name} maxDepth=1`, String(cfg.maxDepth))
    check(cfg.modelSelection === false, `${name} 关闭 modelSelection`)
    check(cfg.modelDiscovery === false, `${name} 关闭 modelDiscovery`)
    check(cfg.allowedAgentPresets === undefined, `${name} 不设 allowedAgentPresets`)
    check(
      JSON.stringify(cfg.agentOptions) === JSON.stringify({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' }),
      `${name} agentOptions 与默认设置一致`,
      JSON.stringify(cfg.agentOptions),
    )
  }
  const defaultRoute = JSON.stringify({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash' })
  check(
    toolRows.every((row) => JSON.stringify(row.config.agentOptions) === defaultRoute),
    '四个工具共用同一路由（同一设置真源）',
  )

  // ── 动态 preset：deep-ptc / 回退 / reasoningEffort ────────────────────────
  check(
    findTool(deepPtc, 'develop')?.config?.agentPreset === 'deep-ptc',
    'deep-ptc 模式只把 develop 切到 deep-ptc',
  )
  for (const name of ['recon', 'review', 'scribe']) {
    check(
      findTool(deepPtc, name)?.config?.agentPreset === 'standard',
      `deep-ptc 模式下 ${name} 仍是 standard`,
    )
  }
  check(/deep-ptc/.test(deepPtc?.description ?? ''), 'deep-ptc description 写明模式')
  check(/已回退 standard/.test(fallback?.description ?? ''), '回退 description 写明「已回退 standard」')
  check(
    /没有可用的施工方式|未安装|未启用|已被移除/.test(fallback?.description ?? ''),
    '回退原因涵盖目录缺失而非误断为未安装',
    fallback?.description ?? '',
  )
  check(
    findTool(custom, 'develop')?.config?.agentPreset === 'team-builder',
    '任意有效 preset 可作 develop',
  )
  check(/团队施工/.test(custom?.description ?? ''), '自定义 preset 名称进入 description')
  check(
    surface.selfFallback.fallback === true && /递归派工|内部预设/.test(surface.selfFallback.reason ?? ''),
    'dev-plan 自身被拒绝，避免递归',
  )
  check(
    surface.scoutSelfFallback?.fallback === true && surface.scribeSelfFallback?.fallback === true,
    'dev-plan-scout 与 dev-plan-scribe 也被拒绝作 developMode',
  )
  check(
    surface.modules.settings.DEFAULT_SETTINGS.guardAllSubagents === false,
    '默认 guardAllSubagents=false（只守 dev-plan 子代理）',
  )
  check(/已回退 standard/.test(findPresetPlugin(fallback, 'persona')?.config?.prefix ?? ''), '回退 persona 写明「已回退 standard」')
  check(/回退显式可见/.test(findPresetPlugin(fallback, 'persona')?.config?.prefix ?? ''), '回退说明显式可见')
  check(
    JSON.stringify(findTool(withEffort, 'develop')?.config?.agentOptions) ===
      JSON.stringify({ provider: 'dsh-opencode-go', model: 'deepseek-v4.1-flash', reasoningEffort: 'high' }),
    'childReasoningEffort 非空时进入 agentOptions',
    JSON.stringify(findTool(withEffort, 'develop')?.config?.agentOptions),
  )
  check(
    !Object.hasOwn(findTool(standard, 'develop')?.config?.agentOptions ?? {}, 'reasoningEffort'),
    'childReasoningEffort 为空时省略该键',
  )

  // ── compaction / persona ─────────────────────────────────────────────────
  const compaction = flattenPlugins(standard?.plugins).find((row) => row?.id === 'compaction')
  check(compaction?.group === true, 'compaction 是 group')
  check(compaction?.isolate?.compaction === true && compaction?.isolate?.toolResultPruner === true, 'compaction isolate 两个键都为 true')
  check(
    ['@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact', '@deepseek-ai/dsh-compaction-tool-result-pruner'].every(
      (name) => flattenPlugins(compaction?.config).some((row) => row?.name === name),
    ),
    'compaction 组含三行',
  )

  const personaRow = findPresetPlugin(standard, 'persona')
  const personaPrefix = personaRow?.config?.prefix ?? ''
  const personaSuffix = personaRow?.config?.suffix ?? ''
  const persona = `${personaPrefix}${personaSuffix}`
  const personaLength = personaPrefix.length + personaSuffix.length
  check(
    typeof personaPrefix === 'string' && personaPrefix.length > 1000 && personaLength <= 6000,
    'persona 长度在性能预算内（1000 < total <= 6000 字符）',
    `${personaLength} chars`,
  )
  check(
    !personaPrefix.includes('ROLE-TEMPLATE:SCOUT:BEGIN') && !personaPrefix.includes('ROLE-TEMPLATE:SCRIBE:BEGIN'),
    '主窗 prefix 不再使用旧的千字长模板',
  )
  check(
    personaPrefix.includes('仅给子代理用') &&
      personaPrefix.includes('【仅子代理用 · 侦察/复核约束】') &&
      personaPrefix.includes('【仅子代理用 · 文书落盘约束】'),
    '主窗 persona 嵌入紧凑版子代理模板并标注仅给子代理用',
  )
  check(typeof personaSuffix === 'string' && personaSuffix.length > 100, 'persona.suffix 非空（不遮蔽部署级 suffix）')
  check(!/\{\{/.test(persona), 'persona 不含模板变量')

  const nonePersonaPrefix = findPresetPlugin(noneMode, 'persona')?.config?.prefix ?? ''
  check(nonePersonaPrefix.includes('永不亲自读写仓库、写代码或跑 Shell'), 'persona(none) 说明主窗永不亲自写代码')
  for (const [marker, label] of [
    ['永远禁止跑 Shell/测试命令（无 Shell 工具）', 'persona(默认 ask-edit) 严禁跑 Shell/测试命令'],
    ['必须先获用户本轮明确同意“主窗直接改”', 'persona(默认 ask-edit) 写改必须先获用户同意'],
    ['默认只规划与复核', 'persona 说明默认只规划/复核'],
    ['开工/施工/修复', 'persona 只在用户明确开工时派 develop'],
    ['name=developer', 'persona 固定 developer'],
    ['send_message', 'persona 用 send_message 续派'],
    ['不反复请示', 'persona 普通实现不反复请示'],
    ['独立 review', 'persona 施工后可派独立 review'],
    ['仅范围扩大、风险变化或宿主权限要求', 'persona 仅范围/风险/权限变化重确认'],
    ['不向人类提问', 'develop 不向人类提问'],
    ['不得把子代理自述当自己跑过测试', 'persona 禁止把子代理自述当成自己运行测试'],
    ['同一任务严禁混用 develop 与 rework_task/ask_worker', '双通道互斥'],
    // P0 流程提效与单契约复用
    ['快速路径', 'P0 风险路由含快速路径'],
    ['标准路径', 'P0 风险路由含标准路径'],
    ['高风险路径', 'P0 风险路由含高风险路径'],
    ['歧义', 'P0 判定维度含歧义'],
    ['影响面', 'P0 判定维度含影响面'],
    ['可逆性', 'P0 判定维度含可逆性'],
    ['可验证性', 'P0 判定维度含可验证性'],
    ['必须升级路径', 'P0 证据不足时提高风险等级'],
    ['绝不因验证困难降级', 'P0 绝不因验证困难降级'],
    ['分层变更证据', 'P0 完工必须附分层变更证据'],
    ['只有文件清单或口头摘要不算审过 diff', 'P0 不能只给文件清单'],
    ['不得声称核对过 diff', 'P0 摘要不得冒充 diff 审查'],
    ['补证据', 'P0 缺证据要同一 developer 补证据'],
    ['开工契约', 'P0 一次性开工契约'],
    ['目标', '任务书含目标'],
    ['非目标', '任务书含非目标'],
    ['允许与禁止改动路径', '任务书含允许改动路径'],
    ['接口与兼容约束', '任务书含接口/依赖'],
    ['验收标准', '任务书含验收标准'],
    ['检查命令', '任务书含检查命令'],
    ['风险', '任务书含风险/回退'],
    ['最小切片', 'P0 验收前置含最小切片'],
    ['语法/静态契约', 'P0 验收排序含语法/静态契约'],
    ['针对性测试', 'P0 验收排序含针对性测试'],
    ['必要运行/GUI', 'P0 验收排序含必要运行/GUI'],
    ['静态检查/单测不等于真实运行验收', 'P0 禁止静态检查冒充真实验证'],
    ['非阻塞协作', 'P0 非阻塞协作'],
    ['不轮询', 'P0 主窗不轮询'],
    ['不 `sleep`', 'P0 主窗不忙等'],
    ['不重复施工', 'P0 主窗不重复施工'],
    ['读写 developer 正在改的文件', 'P0 主窗不重复读取 developer 文件'],
    ['developer 仅在阻塞、范围冲突或关键契约决策时打断', 'P0 developer 打断边界'],
    ['verified|partial|failed|未验证', 'P0 汇报含验证状态分级'],
    ['阻塞', 'P0 阻塞问题返工'],
    ['不无限打磨', 'P0 非阻塞建议不无限打磨'],
    ['review 不替代主窗最终审查', 'P0 最终审查责任不外包'],
    ['name=scout', 'recon 首次固定 name=scout 复用上下文'],
    ['文本不是派工', 'P0 文本不是派工'],
    ['实际调用 develop', 'P0 授权后必须实际调用 develop'],
    ['已派出 developer', 'P0 工具接受后才可称已派出'],
    ['未派工：原因', 'P0 未派工如实报告'],
    ['实际调用 send_message', 'P0 返工必须实际 send_message'],
    // 施工目录/权限防护
    ['施工目录边界', 'persona 写明施工目录与权限'],
    ['cwd', 'persona 明确 cwd 参数'],
    ['可写工作区', 'persona 派工前检查可写工作区'],
    ['已存在的父目录', 'persona 允许工作区内未建子目录以父目录 cwd 派工自建'],
    ['working_directory', 'persona 禁止先建后 cd'],
    ['父会话事后提权不扩大已有子代理权限', 'persona 不假设权限会扩大'],
    ['沙箱', 'persona 权限失败记录沙箱模式'],
    ['原错', 'persona 权限失败记录真实错误'],
  ]) {
    check(persona.includes(marker), label, marker)
  }
  check(
    !persona.includes('降低路径等级并补验收'),
    'P0 没有“证据不足就降低路径等级”的回退指令',
  )
  check(
    !/只有改动摘要也算证据|只给文件清单(?:也)?可以/.test(persona),
    'P0 没有“摘要/文件清单就是证据”的错误说法',
  )
  check(
    !/文本也能算派工|没有调用也可以说已派出|文本任务书即视为已派工/.test(persona),
    'P0 没有“文本任务书即视为已派工”的错误说法',
  )

  const scoutPersona = findPresetPlugin(scoutPreset, 'persona')?.config?.prefix ?? ''
  const scribePersona = findPresetPlugin(scribePreset, 'persona')?.config?.prefix ?? ''
  check(
    ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch'].every((tool) => scoutPersona.includes(tool)),
    'dev-plan-scout 内置 persona 声明六项只读工具',
  )
  check(
    scribePersona.includes('read、write、edit') && scribePersona.includes('超出文书子代理职责'),
    'dev-plan-scribe 内置 persona 限定只写规划/复核文档',
  )

  // ── locale / README / detail ─────────────────────────────────────────────
  for (const [name, value, error] of [
    ['locale/zh.json', locale.zh, surface.localeErrors.zh],
    ['locale/en.json', locale.en, surface.localeErrors.en],
  ]) {
    check(error === null, `${name} 是合法 JSON`, error ?? '')
    check(typeof value?.meta?.title === 'string' && value.meta.title.length > 0, `${name} 有 meta.title`)
    check(typeof value?.meta?.description === 'string' && value.meta.description.length > 0, `${name} 有 meta.description`)
    check(value?.meta?.detail === 'detail.md', `${name} meta.detail=detail.md`)
  }
  check(
    locale.zh?.meta?.title === '开发规划与交付模式',
    'locale/zh 插件显示名为「开发规划与交付模式」',
    locale.zh?.meta?.title,
  )
  check(
    locale.en?.meta?.title === 'Development planning & delivery Mode',
    'locale/en 插件显示名为 Development planning & delivery Mode',
    locale.en?.meta?.title,
  )
  for (const marker of ['develop', 'standard', 'deep-ptc', '模型守门']) {
    check(String(locale.zh?.meta?.description ?? '').includes(marker), `locale/zh 说明 ${marker}`)
  }
  for (const marker of ['develop', 'standard', 'deep-ptc', 'model guard']) {
    check(String(locale.en?.meta?.description ?? '').toLowerCase().includes(marker.toLowerCase()), `locale/en 说明 ${marker}`)
  }

  for (const marker of [
    '0.4.0',
    'develop',
    'standard',
    'deep-ptc',
    '仅给子代理用',
    'mainToolMode',
    'ctx.agentPresets.register',
    'cordis.patch.yml 只挂根插件',
    '模型守门',
    '只管理子代理',
    '绝不钉主会话',
    'dsh-subagent-model-pin',
    '先验证本插件，再禁用旧插件',
    '现有会话',
    '新建会话',
    '回退',
    '已回退 standard',
    '未验证',
    'node scripts/verify-presets.mjs',
    'node --test',
  ]) {
    check(String(readme ?? '').includes(marker), `README 含关键说明：${marker}`)
  }
  check(/settings|插件页/.test(String(readme ?? '')), 'README 说明设置入口')
  check(/js-yaml/.test(String(readme ?? '')), 'README 说明不依赖 js-yaml')
  for (const marker of [
    'docs/flow-redesign.md',
    '快速路径',
    '标准路径',
    '高风险路径',
    '一次性开工契约',
    '验收前置',
    '非阻塞协作',
    'verified/partial/failed',
    '实际变更证据',
    '不能只给文件清单',
    '接口/依赖',
    '检查命令',
    '风险/回退',
  ]) {
    check(String(readme ?? '').includes(marker), `README 含 P0 说明：${marker}`)
  }
  check(/接口\/依赖[：:]/.test(String(readme ?? '')), 'README 任务书模板含接口/依赖字段')
  check(/风险\/回退[：:]/.test(String(readme ?? '')), 'README 任务书模板含风险/回退字段')
  check(String(readme ?? '').includes('显示名已定'), 'README 写明显式显示名已定')
  check(!String(readme ?? '').includes('显示名未定'), 'README 不再声称显示名未定')
  check(String(readme ?? '').includes('开发规划与交付'), 'README 使用新显示名')
  for (const marker of ['已安装 → 开发规划与交付模式', '404', '仍无条件注册设置页', 'config-editor-unavailable', '--dsw-alias-', 'guard 卸载', 'dsh-client-locale', 'getOrigin']) {
    check(String(readme ?? '').includes(marker), `README 含 UI/降级/安全说明：${marker}`)
  }

  for (const marker of [
    '0.4.0',
    'develop',
    'standard',
    'deep-ptc',
    '仅给子代理用',
    'mainToolMode',
    '模型守门',
    '已回退 standard',
    '未验证',
    'ctx.agentPresets.register',
  ]) {
    check(String(detail ?? '').includes(marker), `detail.md 含关键说明：${marker}`)
  }
  for (const marker of [
    'docs/flow-redesign.md',
    '快速路径',
    '非阻塞协作',
    'P0',
    '实际变更证据',
    '不能只给文件清单',
    '接口/依赖',
    '检查命令',
    '风险/回退',
  ]) {
    check(String(detail ?? '').includes(marker), `detail.md 含 P0 说明：${marker}`)
  }
  for (const marker of ['已安装 → 开发规划与交付模式', '404', 'application/json', '--dsw-alias-', 'guard']) {
    check(String(detail ?? '').includes(marker), `detail.md 含设置页行为说明：${marker}`)
  }
  check(String(detail ?? '').length > 1000, 'detail.md 是实质文档', `${String(detail ?? '').length} chars`)

  const flowDoc = String(files['docs/flow-redesign.md'] ?? '')
  check(flowDoc.length > 5000, 'docs/flow-redesign.md 是实质开发文档', `${flowDoc.length} chars`)
  for (const marker of [
    '背景与目标',
    'P0 范围与非目标',
    '风险路由矩阵',
    '一次性开工契约',
    'developer 执行与证据报告合同',
    '主窗非阻塞、审查与返工规则',
    '配置与工具影响',
    '可测试的行为断言',
    '真实验证矩阵',
    '与调研报告 P0 的逐项追踪',
    'P0-1',
    'P0-2',
    'P0-3',
    'P0-4',
    'P0-5',
    '不做',
    'P1',
    'P2',
    'verified / partial / failed',
    '主窗最终审查责任不外包',
    '绝不因验证困难降低路径等级',
    '实际变更证据',
    '不能只给文件清单',
    '不得声称审过实际 diff',
  ]) {
    check(flowDoc.includes(marker), `docs/flow-redesign.md 含关键说明：${marker}`)
  }

  return results
}

/** 真实模块行为检查：用假 ctx 驱动，而不是只读源码。 */
async function behaviorChecks() {
  const results = []
  const check = (ok, label, detail = '') => results.push({ ok: Boolean(ok), label, detail: String(detail) })
  const registry = createFakeRegistry()
  const webServer = createFakeWebServer()
  const configEditor = createFakeConfigEditor()
  const ctx = createFakeContext({ registry, webServer, configEditor })
  const modules = await loadModules(ROOT)
  const { index } = modules
  try {
    index.apply(ctx.ctx, { ...modules.settings.DEFAULT_SETTINGS }, { verificationDelayMs: 0 })
    await ctx.flush()
    check(
      registry.definitions.length === 1 &&
        registry.definitions[0]?.id === 'dev-plan',
      'apply 只动态注册 1 个 preset（dev-plan，不在公开列表暴露内部子预设）',
      registry.definitions.map((d) => d.id).join(','),
    )
    check(registry.definitions.some((d) => d.id === 'dev-plan'), '动态注册 id=dev-plan')
    check(typeof webServer.handlers.get === 'function', 'webServer 路由注册接口存在')
    const stateHandler = webServer.handlers.get('/plugins/dev-plan-presets/state')
    check(typeof stateHandler === 'function', '注册 /plugins/dev-plan-presets/state')
    const state = await callRoute(stateHandler, 'GET')
    check(state.code === 200, 'state 路由 GET 200', String(state.code))
    check(state.body?.effectiveMode === 'standard', 'state 默认 effectiveMode=standard', String(state.body?.effectiveMode))
    check(state.body?.fallback?.active === false, 'state 默认无回退')
    check(typeof state.headers?.etag === 'string' && state.headers.etag.length > 0, 'state 响应头带 etag')
    const state304 = await callRoute(stateHandler, 'GET', undefined, { 'if-none-match': state.headers.etag })
    check(state304.code === 304 && state304.body === null, 'state 命中 If-None-Match 返回 304 空体', String(state304.code))

    const configHandler = webServer.handlers.get('/plugins/dev-plan-presets/config')
    check(typeof configHandler === 'function', '注册 /plugins/dev-plan-presets/config')
    const invalid = await callRoute(configHandler, 'POST', { modelGuardMode: 'nonsense' })
    check(invalid.code === 400, 'config 路由拒绝非法枚举（400）', String(invalid.code))
    const valid = await callRoute(configHandler, 'POST', {
      developMode: 'deep-ptc',
      childProvider: 'p',
      childModel: 'm',
      modelGuardMode: 'audit',
    })
    check(valid.code === 200, 'config 路由接受合法配置（200）', String(valid.code))
    check(configEditor.edits.length === 1, 'config 路由通过 configEditor.edit 写回', String(configEditor.edits.length))
    check(configEditor.edits[0]?.next?.developMode === 'deep-ptc', '写回值包含 developMode=deep-ptc')

    const textPlain = await callRoute(configHandler, 'POST', { modelGuardMode: 'audit' }, { 'content-type': 'text/plain' })
    check(textPlain.code === 415, 'config 路由拒绝 text/plain（415）', String(textPlain.code))
    const crossSite = await callRoute(
      configHandler,
      'POST',
      { modelGuardMode: 'audit' },
      { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
    )
    check(crossSite.code === 403, 'config 路由拒绝 cross-site（403）', String(crossSite.code))
    const badOrigin = await callRoute(
      configHandler,
      'POST',
      { modelGuardMode: 'audit' },
      { 'content-type': 'application/json', origin: 'https://evil.example', host: '127.0.0.1:1162' },
    )
    check(badOrigin.code === 403, 'config 路由拒绝错误 Origin（403）', String(badOrigin.code))
    check(configEditor.edits.length === 1, '被拒绝的配置写请求不调用 configEditor', String(configEditor.edits.length))
    const sameOrigin = await callRoute(
      configHandler,
      'POST',
      { modelGuardMode: 'audit' },
      {
        'content-type': 'application/json; charset=utf-8',
        origin: 'http://127.0.0.1:1162',
        host: '127.0.0.1:1162',
        'sec-fetch-site': 'same-origin',
      },
    )
    check(sameOrigin.code === 200, 'config 路由允许同源 Origin', String(sameOrigin.code))
    const noOrigin = await callRoute(configHandler, 'POST', { modelGuardMode: 'audit' }, { 'content-type': 'application/json' })
    check(noOrigin.code === 200, 'config 路由允许无 Origin 的非浏览器客户端', String(noOrigin.code))
    check(configEditor.edits.length === 3, '同源与无 Origin 请求各写入一次', String(configEditor.edits.length))
  } catch (error) {
    check(false, '行为检查执行失败', String(error?.stack ?? error))
  } finally {
    await ctx.dispose()
    check(registry.released.includes('dev-plan'), 'dispose 时交还动态 preset disposer', registry.released.join(', '))
    check(webServer.handlers.size === 0, 'dispose 时移除设置页路由', String(webServer.handlers.size))
    check(!ctx.listeners.get('agent/created')?.length, 'dispose 时移除 agent/created 监听')
  }

  // deep-ptc：entry 只做诊断，registry 才算可用
  {
    const entryRegistry = createFakeRegistry({ rows: [] })
    const entryWeb = createFakeWebServer()
    const entryCtx = createFakeContext({
      registry: entryRegistry,
      webServer: entryWeb,
      entries: [{ id: 'deep-ptc-settings', options: { name: 'dsh-deep-ptc-mode' }, fiber: { state: 1 } }],
    })
    index.apply(entryCtx.ctx, { ...modules.settings.DEFAULT_SETTINGS, developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
    await entryCtx.flush()
    const entryDefinition = entryRegistry.definitions.find((d) => d.id === 'dev-plan')
    check(
      entryDefinition?.plugins.find((row) => row.id === 'tool-subagent-develop')?.config?.agentPreset === 'standard',
      '只有 loader entry（LOADING）时保守回退 standard',
    )
    const entryState = await callRoute(entryWeb.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
    check(entryState.body?.fallback?.active === true, 'entry-only 时 state 显式回退')
    check(/没有可用的施工方式|未安装|未启用|已被移除/.test(entryState.body?.fallback?.reason ?? ''), '回退原因涵盖目录缺失', entryState.body?.fallback?.reason)
    await entryCtx.dispose()
  }
  {
    const goodRegistry = createFakeRegistry({ rows: [{ id: 'deep-ptc' }] })
    const goodCtx = createFakeContext({ registry: goodRegistry })
    index.apply(goodCtx.ctx, { ...modules.settings.DEFAULT_SETTINGS, developMode: 'deep-ptc' }, { verificationDelayMs: 0 })
    await goodCtx.flush()
    const goodDefinition = goodRegistry.definitions.find((d) => d.id === 'dev-plan')
    check(
      goodDefinition?.plugins.find((row) => row.id === 'tool-subagent-develop')?.config?.agentPreset === 'deep-ptc',
      'registry 中存在 deep-ptc 时 develop 使用 deep-ptc',
    )
    check(
      goodDefinition?.plugins.find((row) => row.id === 'tool-subagent-recon')?.config?.agentPreset === 'standard',
      'deep-ptc 时 recon 仍使用 standard',
    )
    await goodCtx.dispose()
  }

  // 守门：pin
  {
    const registry2 = createFakeRegistry()
    const child = createFakeAgent({ id: 'child-x', parentSession: 'main', origin: 'subagent', current: undefined })
    const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'expensive', model: 'big' } })
    const ctx2 = createFakeContext({ registry: registry2, agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) } })
    index.apply(ctx2.ctx, { ...modules.settings.DEFAULT_SETTINGS }, { verificationDelayMs: 0 })
    await ctx2.flush()
    const listener = ctx2.listeners.get('agent/created')?.[0]
    check(typeof listener === 'function', 'pin 模式注册 agent/created')
    listener({ agent: child.agent })
    check(
      child.selects.length === 1 && child.selects[0].provider === 'dsh-opencode-go',
      'pin 模式创建时选择目标路由',
      JSON.stringify(child.selects),
    )
    const decision = await child.stepHandlers[0](
      { modelSelection: { provider: 'other', model: 'expensive' } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    check(decision?.kind === 'reject', 'pre-step 越界返回 reject', JSON.stringify(decision))
    check(child.cancelled.length === 1, 'pre-step 越界 cancel 子代理')
    check(parent.injected.length === 1, 'pre-step 越界通知父会话')
    listener({ agent: parent.agent })
    check(parent.selects.length === 0, '主会话永不被 select')
    check(child.stepHandlers.length === 1, 'pin 创建后 child 有 pre-step 守卫')
    await ctx2.dispose()
    check(child.stepHandlers.length === 0, '插件卸载时真正移除 child 的 pre-step 守卫')
    check(!ctx2.listeners.get('agent/created')?.length, '插件卸载时移除 agent/created 监听')
    check(!ctx2.listeners.get('agent/disposed')?.length, '插件卸载时移除 agent/disposed 监听')
  }

  // 守门：select 不可用时仍保留 guard（kill=false 不 cancel，但后续越界要记录）
  {
    const registry2b = createFakeRegistry()
    const child = createFakeAgent({ id: 'child-no-select', parentSession: 'main', origin: 'subagent', current: undefined, select: null })
    const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
    const web = createFakeWebServer()
    const ctx2b = createFakeContext({
      registry: registry2b,
      webServer: web,
      agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
    })
    index.apply(ctx2b.ctx, { ...modules.settings.DEFAULT_SETTINGS, killOnViolation: false }, { verificationDelayMs: 0 })
    await ctx2b.flush()
    ctx2b.listeners.get('agent/created')[0]({ agent: child.agent })
    check(child.cancelled.length === 0, 'select 缺失 + kill=false 不 cancel 子代理')
    check(child.stepHandlers.length === 1, 'select 缺失 + kill=false 仍装 pre-step 守卫')
    const decision = await child.stepHandlers[0](
      { modelSelection: { provider: 'other', model: 'expensive' } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    check(decision?.kind === 'enter', 'select 缺失 + kill=false 不打断后续 pre-step')
    const state = await callRoute(web.handlers.get('/plugins/dev-plan-presets/state'), 'GET')
    check(state.body?.violations?.some((entry) => /越界/.test(entry.text)), 'select 缺失后守卫仍记录越界')
    await ctx2b.dispose()
  }

  // 守门：audit / off / honorExplicit
  {
    const registry3 = createFakeRegistry()
    const child = createFakeAgent({ id: 'child-a', parentSession: 'main', origin: 'subagent', current: { provider: 'x', model: 'y' } })
    const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
    const ctx3 = createFakeContext({ registry: registry3, agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) } })
    index.apply(ctx3.ctx, { ...modules.settings.DEFAULT_SETTINGS, modelGuardMode: 'audit' }, { verificationDelayMs: 0 })
    await ctx3.flush()
    ctx3.listeners.get('agent/created')[0]({ agent: child.agent })
    check(child.selects.length === 0, 'audit 模式不 select')
    const decision = await child.stepHandlers[0](
      { modelSelection: { provider: 'x', model: 'y' } },
      async () => ({ kind: 'enter', messages: [] }),
    )
    check(decision?.kind === 'enter', 'audit 模式不打断')
    await ctx3.dispose()
  }
  {
    const ctx4 = createFakeContext({ registry: createFakeRegistry() })
    index.apply(
      ctx4.ctx,
      { ...modules.settings.DEFAULT_SETTINGS, modelGuardMode: 'off', mainToolMode: 'none' },
      { verificationDelayMs: 0 },
    )
    await ctx4.flush()
    check(!ctx4.listeners.get('agent/created'), 'off 模式不注册 agent/created')
    await ctx4.dispose()
  }
  {
    const registry5 = createFakeRegistry()
    const child = createFakeAgent({ id: 'child-e', parentSession: 'main', origin: 'subagent', current: { provider: 'explicit', model: 'route' } })
    const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
    const ctx5 = createFakeContext({ registry: registry5, agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) } })
    index.apply(ctx5.ctx, { ...modules.settings.DEFAULT_SETTINGS, honorExplicit: true }, { verificationDelayMs: 0 })
    await ctx5.flush()
    ctx5.listeners.get('agent/created')[0]({ agent: child.agent })
    check(child.selects.length === 0, 'honorExplicit 尊重显式路由（不 select）')
    check(child.stepHandlers.length === 0, 'honorExplicit 不为显式路由挂打断守卫')
    await ctx5.dispose()
  }

  // 守门范围：默认只守 dev-plan 父会话；global 恢复全局；父 preset 未知时跳过。
  {
    const runScope = async (parentPreset, global) => {
      const registry = createFakeRegistry()
      const child = createFakeAgent({ id: 'child-scope', parentSession: 'main', origin: 'subagent', current: undefined })
      const parent = createFakeAgent({
        id: 'main',
        agentPreset: parentPreset,
        current: { provider: 'p', model: 'm' },
      })
      const ctx = createFakeContext({
        registry,
        agents: { get: (id) => (id === 'main' ? parent.agent : child.agent) },
      })
      index.apply(ctx.ctx, { ...modules.settings.DEFAULT_SETTINGS, guardAllSubagents: global }, { verificationDelayMs: 0 })
      await ctx.flush()
      ctx.listeners.get('agent/created')[0]({ agent: child.agent })
      const guarded = child.stepHandlers.length === 1
      await ctx.dispose()
      return guarded
    }
    check((await runScope('dev-plan', false)) === true, '默认守 dev-plan 父会话的子代理')
    check((await runScope('standard', false)) === false, '默认跳过非 dev-plan 父会话')
    check((await runScope(undefined, false)) === false, '父 preset 未知时跳过守门')
    check((await runScope('standard', true)) === true, 'guardAllSubagents=true 恢复全局守门')
  }

  // fork 形主对话：有 parentSession 但 depth 0、无 origin，不得被守。
  {
    const registry = createFakeRegistry()
    const fork = createFakeAgent({
      id: 'fork-main',
      parentSession: 'main',
      isSeeded: true,
      delegationDepth: 0,
      current: undefined,
    })
    const parent = createFakeAgent({ id: 'main', agentPreset: 'dev-plan', current: { provider: 'p', model: 'm' } })
    const ctx = createFakeContext({
      registry,
      agents: { get: (id) => (id === 'main' ? parent.agent : fork.agent) },
    })
    index.apply(ctx.ctx, { ...modules.settings.DEFAULT_SETTINGS, guardAllSubagents: true }, { verificationDelayMs: 0 })
    await ctx.flush()
    ctx.listeners.get('agent/created')[0]({ agent: fork.agent })
    check(fork.selects.length === 0, 'fork 主对话不被 select（即使 global）')
    check(fork.stepHandlers.length === 0, 'fork 主对话不挂 pre-step（即使 global）')
    await ctx.dispose()
  }

  // 模型目录：真实枚举 + 单 provider 失败局部降级。
  {
    const registry = createFakeRegistry()
    const web = createFakeWebServer()
    const llm = {
      listProviders: () => [
        { id: 'alpha', name: 'Alpha' },
        { id: 'broken', name: 'Broken' },
      ],
      listModels: async (id) => {
        if (id === 'broken') throw new Error('missing credentials')
        return [{ id: 'alpha-1', name: 'Alpha One' }]
      },
    }
    const ctx = createFakeContext({ registry, webServer: web, llm })
    index.apply(ctx.ctx, { ...modules.settings.DEFAULT_SETTINGS }, { verificationDelayMs: 0 })
    await ctx.flush()
    const stateHandler = web.handlers.get('/plugins/dev-plan-presets/state')
    await callRoute(stateHandler, 'GET')
    await new Promise((resolve) => setTimeout(resolve, 0))
    await ctx.flush()
    const state = await callRoute(stateHandler, 'GET')
    check(state.body?.modelCatalog?.providers?.length === 2, 'state 返回 2 个 provider', String(state.body?.modelCatalog?.providers?.length))
    check(
      state.body?.modelCatalog?.providers?.find((item) => item.provider === 'alpha')?.models?.[0]?.model === 'alpha-1',
      'state 返回 provider 下的 model',
    )
    check(
      state.body?.modelCatalog?.failures?.some((item) => item.provider === 'broken'),
      '单 provider 失败进入 failures',
    )
    await ctx.dispose()
  }

  return results
}

function syntaxCheck(file) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'ignore' })
  return { ok: result.status === 0, status: result.status, error: result.error?.message }
}

// ── 变异层 ──────────────────────────────────────────────────────────────────
const clone = (value) => JSON.parse(JSON.stringify(value))

const MUTATIONS = [
  {
    name: 'develop 工具被改名（四工具合同破坏）',
    expect: '四个委派工具是 recon/review/scribe/develop',
    mutate(surface) {
      findTool(surface.standard, 'develop').config.toolName = 'subagent'
    },
  },
  {
    name: 'develop 默认改成非 standard',
    expect: 'develop 默认使用 standard',
    mutate(surface) {
      findTool(surface.standard, 'develop').config.agentPreset = 'ptc'
    },
  },
  {
    name: '主窗(none)被加回 fs 工具',
    expect: '主窗(none)不挂载',
    mutate(surface) {
      surface.noneMode.plugins.push({ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' })
    },
  },
  {
    name: 'persona(none) 删掉“永不亲自写代码”',
    expect: 'persona(none) 说明主窗永不亲自写代码',
    mutate(surface) {
      const row = findPresetPlugin(surface.noneMode, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('永不亲自读写仓库、写代码或跑 Shell', '应当亲自写代码')
    },
  },
  {
    name: 'persona(默认 ask-edit) 删掉“必须先获用户本轮明确同意”',
    expect: 'persona(默认 ask-edit) 写改必须先获用户同意',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('必须先获用户本轮明确同意“主窗直接改”', '可以直接改代码')
    },
  },
  {
    name: 'persona 删掉固定 developer 名',
    expect: 'persona 固定 developer',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('name=developer', 'name=worker')
      row.config.suffix = row.config.suffix.replaceAll('name=developer', 'name=worker')
    },
  },
  {
    name: 'persona 删掉“不向人类提问”',
    expect: 'develop 不向人类提问',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('不向人类提问', '可以直接问人类')
    },
  },
  {
    name: '回退描述被静默（删掉“已回退 standard”）',
    expect: '回退 description 写明「已回退 standard」',
    mutate(surface) {
      surface.fallback.description = surface.fallback.description.replaceAll('已回退 standard', 'standard')
    },
  },
  {
    name: '四个工具路由不一致',
    expect: '四个工具共用同一路由',
    mutate(surface) {
      findTool(surface.standard, 'recon').config.agentOptions.model = 'deepseek-chat'
    },
  },
  {
    name: '给 develop 加 allowedAgentPresets',
    expect: '不设 allowedAgentPresets',
    mutate(surface) {
      findTool(surface.standard, 'develop').config.allowedAgentPresets = ['standard', 'deep-ptc']
    },
  },
  {
    name: '根补丁重新静态注册 preset',
    expect: '根补丁不再静态注册 dsh-agent-preset',
    mutate(surface) {
      surface.patchText += "\n- id: preset-dev-plan\n  name: '@deepseek-ai/dsh-agent-preset'\n"
    },
  },
  {
    name: 'README 删掉旧模型钉迁移说明',
    expect: 'README 含关键说明：dsh-subagent-model-pin',
    mutate(surface) {
      surface.readme = surface.readme.replaceAll('dsh-subagent-model-pin', 'some-old-plugin')
    },
  },
  {
    name: 'package.json 增加 deep-ptc 依赖',
    expect: '不依赖 deep-ptc 包',
    mutate(surface) {
      surface.pkg.dependencies = { 'dsh-deep-ptc-mode': '^1.0.0' }
    },
  },
  {
    name: 'client 注册 key 写错',
    expect: 'client 注册 key=dsh-dev-plan-presets#dev-plan-presets',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        'dsh-dev-plan-presets#dev-plan-presets',
        'dsh-subagent-model-pin#subagent-model-pin',
      )
    },
  },
  {
    name: 'persona 超过 6000 字符预算',
    expect: 'persona 长度在性能预算内',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix += '冗余文本'.repeat(1000)
    },
  },
  {
    name: '主窗重新内联 ROLE-TEMPLATE 长模板',
    expect: '主窗 prefix 不再使用旧的千字长模板',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix += '\n===== ROLE-TEMPLATE:SCOUT:BEGIN =====\n'
    },
  },
  {
    name: '子代理模板缺少“仅给子代理用”标注',
    expect: '主窗 persona 嵌入紧凑版子代理模板并标注仅给子代理用',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('仅给子代理用', '给主窗用')
    },
  },
  {
    name: 'dev-plan-scout 混入 bash 工具',
    expect: 'dev-plan-scout 不含 @deepseek-ai/dsh-tool-bash',
    mutate(surface) {
      surface.scoutPreset.plugins.push({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' })
    },
  },
  {
    name: 'ask-edit 混入 bash 工具',
    expect: 'ask-edit 永不挂载 @deepseek-ai/dsh-tool-bash',
    mutate(surface) {
      surface.askEditMode.plugins.push({ id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash' })
    },
  },
  {
    name: '双通道互斥说明被删除',
    expect: '双通道互斥',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll(
        '同一任务严禁混用 develop 与 rework_task/ask_worker',
        '可以同时使用 develop 和 rework_task',
      )
    },
  },
  {
    name: 'README 任务书退回旧 6 项摘要',
    expect: 'README 任务书模板含接口/依赖字段',
    mutate(surface) {
      surface.readme = String(surface.readme)
        .replaceAll('接口/依赖：', '接口：')
        .replaceAll('检查命令：', '命令：')
        .replaceAll('风险/回退：', '风险：')
    },
  },
  {
    name: 'P0 证据不足时改为降低路径等级（风险方向写反）',
    expect: 'P0 没有“证据不足就降低路径等级”的回退指令',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix += '\n- 可验证性：不能证明就降低路径等级并补验收。\n'
    },
  },
  {
    name: 'P0 允许只有改动摘要也算证据',
    expect: 'P0 没有“摘要/文件清单就是证据”的错误说法',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix += '\n只有改动摘要也算证据，主窗可以直接通过。\n'
    },
  },
  {
    name: 'P0 完工证据退化为改动摘要',
    expect: 'P0 完工必须附分层变更证据',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('分层变更证据', '改动摘要')
    },
  },
  {
    name: 'P0 文件清单被当成证据',
    expect: 'P0 不能只给文件清单',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('只有文件清单或口头摘要不算审过 diff', '只给文件清单也可以作为证据')
    },
  },
  {
    name: 'client 回退横幅漏掉加载失败',
    expect: 'client 回退横幅涵盖不可用原因',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('加载失败', '加载中')
    },
  },
  {
    name: 'client 重复叠加保存失败前缀',
    expect: 'client 不重复叠加“保存失败”前缀',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        'formatted ? raw :',
        'false ? raw :',
      )
    },
  },
  {
    name: 'client 保存状态回退为 notice.ok',
    expect: 'client 仅在 notice.kind=saved 时显示已保存',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        "notice.kind === 'saved'",
        'notice.ok',
      )
    },
  },
  {
    name: 'client 修改字段不清旧通知',
    expect: 'client 修改字段时清除旧通知',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        'const update = (patch) => {\n          setNotice(null)\n',
        'const update = (patch) => {\n',
      )
    },
  },
  {
    name: 'client 删除网络错误指引',
    expect: 'client network 错误给可执行指引',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('无法连接 Host', '读取失败')
    },
  },
  {
    name: '配置写路由删除权威 origin 校验',
    expect: 'Host 配置写路由使用 webServer.getOrigin() 权威 origin',
    mutate(surface) {
      surface.files['index.js'] = String(surface.files['index.js']).replaceAll(
        'webServer.getOrigin()',
        'webServer.port',
      )
    },
  },
  {
    name: 'client 恢复硬编码颜色',
    expect: 'client 不保留 hex/rgba 字面颜色',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        'var(--dsw-alias-label-primary)',
        '#333333',
      )
    },
  },
  {
    name: 'client 恢复 navigator.language',
    expect: 'client 不使用 navigator.language',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        "const API = '/plugins/dev-plan-presets'",
        "const API = '/plugins/dev-plan-presets'\nconst legacy = navigator.language",
      )
    },
  },
  {
    name: 'client 404 指引被删除',
    expect: 'client 404 给出可执行指引',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('设置路由未注册', '路由错误')
    },
  },
  {
    name: 'guard 回到 parentSession 判定 fork 为主对话',
    expect: 'guard 只认 origin=subagent 或 delegationDepth>0',
    mutate(surface) {
      surface.files['guard.js'] = String(surface.files['guard.js']).replace(
        "if (header.origin === 'subagent') return true",
        "if (header.parentSession) return true",
      )
    },
  },
  {
    name: '模型目录 TTL 退回 8s（/state 周期性阻塞）',
    expect: '模型目录使用 60s 快照 + 后台刷新',
    mutate(surface) {
      surface.files['index.js'] = String(surface.files['index.js']).replace(
        'MODEL_CATALOG_TTL_MS = 60_000',
        'MODEL_CATALOG_TTL_MS = 8000',
      )
    },
  },
  {
    name: 'client 删除 presetChoices 纯函数',
    expect: 'client 从 /state 读取模型目录并用纯选择函数',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll(
        'presetChoices',
        'removedChoices',
      )
    },
  },
  {
    name: 'guard 不再监听 agent/disposed',
    expect: '模型守门监听 agent/disposed 清理 step guard',
    mutate(surface) {
      surface.files['guard.js'] = String(surface.files['guard.js']).replaceAll("'agent/disposed'", "'agent/ignored'")
    },
  },
  {
    name: '配置写路由删除 Sec-Fetch-Site 校验',
    expect: 'Host 配置写路由做 Origin/Sec-Fetch-Site 校验',
    mutate(surface) {
      surface.files['index.js'] = String(surface.files['index.js']).replaceAll('sec-fetch-site', 'sec-fetch-mode')
    },
  },
  {
    name: 'P0 授权后只写任务书、不实际调用 develop',
    expect: 'P0 授权后必须实际调用 develop',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('实际调用 develop', '实际写任务书')
      row.config.suffix = row.config.suffix.replaceAll('实际调用 develop', '实际写任务书')
    },
  },
  {
    name: 'P0 文本任务书被当成派工事实',
    expect: 'P0 文本不是派工',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('文本不是派工', '文本也能算派工')
      row.config.suffix = row.config.suffix.replaceAll('文本不是派工', '文本也能算派工')
    },
  },
  {
    name: 'P0 工具未接受也可声称已派出',
    expect: 'P0 工具接受后才可称已派出',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('已派出 developer', '已直接派出')
      row.config.suffix = row.config.suffix.replaceAll('已派出 developer', '已直接派出')
    },
  },
  {
    name: 'P0 删除未派工报告',
    expect: 'P0 未派工如实报告',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('未派工：原因', '已派工')
      row.config.suffix = row.config.suffix.replaceAll('未派工：原因', '已派工')
    },
  },
  {
    name: 'preset 显示名回退为旧名',
    expect: 'preset 显示名为「开发规划与交付」',
    mutate(surface) {
      surface.standard.name = '开发规划'
    },
  },
  {
    name: 'locale/zh 插件显示名回退为旧名',
    expect: 'locale/zh 插件显示名为「开发规划与交付模式」',
    mutate(surface) {
      surface.locale.zh.meta.title = '开发规划与交付'
    },
  },
  {
    name: 'client 标题回退为旧名',
    expect: 'client 设置页标题使用预设名「开发规划与交付」',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll(
        '开发规划与交付 · 施工设置',
        '开发规划 · 施工设置',
      )
    },
  },
  {
    name: 'README 重新声称显示名未定',
    expect: 'README 不再声称显示名未定',
    mutate(surface) {
      surface.readme = String(surface.readme).replace('显示名已定', '显示名未定')
    },
  },
  {
    name: 'P0 快速路径被删除',
    expect: 'P0 风险路由含快速路径',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('快速路径', '慢速路径')
    },
  },
  {
    name: 'P0 一次性契约的接口/依赖字段被删除',
    expect: '任务书含接口/依赖',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('接口与兼容约束', '接口')
    },
  },
  {
    name: 'P0 静态检查冒充真实验证的禁令被删除',
    expect: 'P0 禁止静态检查冒充真实验证',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('静态检查/单测不等于真实运行验收', '静态检查可以代表真实验证')
    },
  },
  {
    name: 'P0 主窗非阻塞（不轮询）被删除',
    expect: 'P0 主窗不轮询',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('不轮询', '可以轮询')
    },
  },
  {
    name: 'P0 验证状态分级被改成二值',
    expect: 'P0 汇报含验证状态分级',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('verified|partial|failed|未验证', '通过/失败')
    },
  },
  {
    name: 'P0 最终审查责任被外包',
    expect: 'P0 最终审查责任不外包',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('review 不替代主窗最终审查', '主窗最终审查可外包给 review')
    },
  },
  {
    name: '版本号未更新',
    expect: 'version=0.4.0',
    mutate(surface) {
      surface.pkg.version = '0.3.0'
    },
  },
  {
    name: 'index 恢复冗余二次复检条件',
    expect: 'index.js scheduleVerification 跳过已命中目标时的冗余二次全量探测',
    mutate(surface) {
      surface.files['index.js'] = String(surface.files['index.js']).replace(
        'state.mode?.fallback === true || state.presets.checked !== true',
        "settings.developMode !== 'standard' || state.presets.checked !== true",
      )
    },
  },
  {
    name: 'client 删除 mainToolMode 控件',
    expect: 'client 设置页包含字段 mainToolMode',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('mainToolMode', 'removedMode')
    },
  },
  {
    name: '默认 guardAllSubagents 改成全局',
    expect: 'settings 默认 guardAllSubagents=false',
    mutate(surface) {
      surface.files['settings.js'] = String(surface.files['settings.js']).replace(
        'guardAllSubagents: false,',
        'guardAllSubagents: true,',
      )
    },
  },
  {
    name: 'client 硬编码 deep-ptc 选项',
    expect: 'client 不再硬编码 deep-ptc 选项',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replace(
        "const API = '/plugins/dev-plan-presets'",
        "const API = '/plugins/dev-plan-presets'\nconst legacyPreset = { value: 'deep-ptc' }",
      )
    },
  },
  {
    name: 'client 不再读取模型目录',
    expect: 'client 从 /state 读取模型目录',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('state.modelCatalog', 'state.models')
    },
  },
  {
    name: 'client 删除 label/帮助文本关联',
    expect: 'client 使用 label for 与帮助文本关联',
    mutate(surface) {
      surface.files['client.js'] = String(surface.files['client.js']).replaceAll('htmlFor', 'data-for')
    },
  },
  {
    name: '权限防护规则被删除',
    expect: 'persona 禁止先建后 cd',
    mutate(surface) {
      const row = findPresetPlugin(surface.standard, 'persona')
      row.config.prefix = row.config.prefix.replaceAll('working_directory', 'other_dir')
    },
  },
  {
    name: 'dev-plan 自引用不再回退',
    expect: 'dev-plan 自身被拒绝，避免递归',
    mutate(surface) {
      surface.selfFallback.fallback = false
      surface.selfFallback.reason = ''
    },
  },
  {
    name: '任意 preset 被限制回 standard',
    expect: '任意有效 preset 可作 develop',
    mutate(surface) {
      findTool(surface.custom, 'develop').config.agentPreset = 'standard'
    },
  },
  {
    name: 'Host 不返回预设目录',
    expect: 'Host 返回真实预设目录',
    mutate(surface) {
      surface.files['index.js'] = String(surface.files['index.js']).replaceAll('presets:', 'presetRows:')
    },
  },
  {
    name: '代码里重新引入 @deepseek-ai import',
    expect: 'index.js 不 import @deepseek-ai/*',
    mutate(surface) {
      surface.files['index.js'] = "import z from '@deepseek-ai/schemastery'\n" + surface.files['index.js']
    },
  },
]

async function main() {
  const surface = await loadSurface()
  const results = checksFor(surface)
  for (const item of results) {
    if (!item.ok) console.log(`FAIL  ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    else if (VERBOSE) console.log(`PASS  ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
  }
  const failures = results.filter((item) => !item.ok).length
  console.log('')
  console.log(`静态合同检查：${results.length - failures} 通过 / ${failures} 失败`)

  // 语法层
  let syntaxOk = true
  for (const file of RUNTIME_FILES) {
    const result = syntaxCheck(join(ROOT, file))
    console.log(`node --check ${file}：${result.ok ? 'PASS' : `FAIL（status=${result.status}${result.error ? `, ${result.error}` : ''}）`}`)
    if (!result.ok) syntaxOk = false
  }
  // 元检查：证明 --check 闸门不是恒通过。故意写坏一个临时文件，必须 FAIL。
  const metaDir = join(ROOT, '.verify-tmp')
  mkdirSync(metaDir, { recursive: true })
  const brokenFile = join(metaDir, 'broken-syntax.mjs')
  writeFileSync(brokenFile, 'export const = ;\n', 'utf8')
  const brokenSyntax = syntaxCheck(brokenFile)
  rmSync(metaDir, { recursive: true, force: true })
  const syntaxGateOk = !brokenSyntax.ok
  console.log(`语法闸门自检（坏文件必须 FAIL）：${syntaxGateOk ? 'PASS' : 'FAIL'}`)
  syntaxOk = syntaxOk && syntaxGateOk

  // 行为层
  const behavior = await behaviorChecks()
  for (const item of behavior) {
    if (!item.ok) console.log(`FAIL  ${item.label}${item.detail ? ` — ${item.detail}` : ''}`)
    else if (VERBOSE) console.log(`PASS  ${item.label}`)
  }
  const behaviorFailures = behavior.filter((item) => !item.ok).length
  console.log(`真实模块行为检查：${behavior.length - behaviorFailures} 通过 / ${behaviorFailures} 失败`)

  // 变异层
  let detected = 0
  const missed = []
  for (const mutation of MUTATIONS) {
    const mutated = clone(surface)
    let outcome
    try {
      mutation.mutate(mutated)
      outcome = checksFor(mutated)
    } catch (error) {
      missed.push(`${mutation.name}（变异本身抛错：${String(error?.message ?? error)}）`)
      continue
    }
    const hits = outcome.filter((item) => !item.ok && item.label.includes(mutation.expect))
    if (hits.length > 0) {
      detected += 1
      if (VERBOSE) console.log(`PASS  变异：${mutation.name} ← ${hits.map((item) => item.label).join('；')}`)
    } else {
      missed.push(`${mutation.name}（期望 ${mutation.expect} 报错，实际未报）`)
    }
  }
  console.log(`负向变异：${detected}/${MUTATIONS.length} 检出`)
  for (const item of missed) console.log(`FAIL  ${item}`)

  const ok = failures === 0 && syntaxOk && behaviorFailures === 0 && missed.length === 0
  console.log('')
  console.log(`结论：${ok ? 'PASS（声明层 + 代码层 + 行为层；宿主/GUI 运行期行为见 README「验证」手工清单）' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

const invokedDirectly =
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href
if (invokedDirectly) await main()
