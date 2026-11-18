// dsh-dev-plan-presets — Client module: the settings page for this plugin row.
// Registers into `plugins.row.config` keyed by "<package>#<rowId>". The page
// reads the Host state route, saves through the Host config route (which
// validates and writes back to the profile patch), and follows the host locale.
// Colours/radii use only the verified --dsw-alias-* / --dsw-radius-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-dev-plan-presets',
  factory(require) {
    try {
      const React = require('react')
      const h = React.createElement
      const API = '/plugins/dev-plan-presets'

      const styles = {
        root: {
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          padding: '4px 0 12px',
          color: 'var(--dsw-alias-label-primary)',
        },
        card: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderRadius: 'var(--dsw-radius-sm)',
          padding: '12px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          background: 'var(--dsw-alias-card-fill)',
        },
        head: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
        legend: {
          fontSize: 13,
          fontWeight: 600,
          padding: '0 4px',
          color: 'var(--dsw-alias-label-primary)',
        },
        title: { fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-primary)' },
        hint: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', lineHeight: 1.55 },
        status: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
        row: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
        field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 168, flex: '1 1 168px' },
        label: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        control: {
          padding: '4px 7px',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-1)',
          border: '1px solid var(--dsw-alias-border-l3)',
          borderRadius: 'var(--dsw-radius-xs)',
          font: 'inherit',
          fontSize: 12,
          width: '100%',
          boxSizing: 'border-box',
        },
        controlDisabled: { opacity: 0.55, cursor: 'not-allowed' },
        check: { display: 'flex', gap: 7, alignItems: 'center', fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
        button: {
          padding: '4px 14px',
          color: 'var(--dsw-alias-label-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          border: '1px solid var(--dsw-alias-border-l3)',
          borderRadius: 'var(--dsw-radius-xs)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 12,
        },
        primary: {
          padding: '4px 14px',
          color: 'var(--dsw-alias-label-on-color)',
          background: 'var(--dsw-alias-button-primary-fill)',
          border: '1px solid var(--dsw-alias-button-primary-fill)',
          borderRadius: 'var(--dsw-radius-xs)',
          cursor: 'pointer',
          font: 'inherit',
          fontSize: 12,
        },
        buttonDisabled: { opacity: 0.55, cursor: 'not-allowed' },
        banner: {
          border: '1px solid var(--dsw-alias-border-l2)',
          borderLeft: '3px solid var(--dsw-alias-state-warn-primary)',
          background: 'var(--dsw-alias-state-warn-tertiary)',
          borderRadius: 'var(--dsw-radius-sm)',
          padding: '8px 10px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--dsw-alias-label-primary)',
        },
        errorBox: {
          border: '1px solid var(--dsw-alias-state-error-primary)',
          background: 'var(--dsw-alias-bg-layer-2)',
          borderRadius: 'var(--dsw-radius-sm)',
          padding: '8px 10px',
          fontSize: 12,
          lineHeight: 1.55,
          color: 'var(--dsw-alias-label-primary)',
        },
        mono: {
          fontFamily: 'var(--ds-font-family-code)',
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
          overflowWrap: 'anywhere',
          wordBreak: 'break-word',
        },
        dot: (kind) => ({
          width: 8,
          height: 8,
          borderRadius: 'var(--dsw-radius-xs)',
          background:
            kind === 'error'
              ? 'var(--dsw-alias-state-error-primary)'
              : kind === 'ready'
                ? 'var(--dsw-alias-state-success-primary)'
                : 'var(--dsw-alias-state-idle-primary)',
          display: 'inline-block',
          flex: '0 0 auto',
        }),
        noticeOk: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.5 },
        noticeError: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary)', lineHeight: 1.5 },
      }

      const FIELD_LABELS = {
        developMode: ['施工方式', 'Development setup'],
        modelGuardMode: ['守门方式', 'Guard behavior'],
        childProvider: ['子代理服务商', 'Subagent provider'],
        childModel: ['子代理模型', 'Subagent model'],
        childReasoningEffort: ['推理强度', 'Reasoning effort'],
        killOnViolation: ['越界时立即停止', 'Stop on violation'],
        honorExplicit: ['尊重子代理自己选的模型', 'Honor an explicit child model'],
        audit: ['记录详细日志', 'Write detailed logs'],
        guardAllSubagents: ['同时管理其他插件的子代理', 'Also govern subagents from other plugins'],
      }

      function useActiveLocale(locale) {
        const read = () => {
          try {
            return String(locale?.getSnapshot?.().active ?? 'en')
          } catch {
            return 'en'
          }
        }
        const [active, setActive] = React.useState(read)
        React.useEffect(() => {
          if (typeof locale?.subscribe !== 'function') return undefined
          const sync = () => setActive(read())
          sync()
          return locale.subscribe(sync)
        }, [locale])
        return active
      }

      function useHostState() {
        const [state, setState] = React.useState(null)
        const [error, setError] = React.useState(null)
        const stopped = React.useRef(false)

        const load = React.useCallback(async (force = false) => {
          if (stopped.current && force !== true) return null
          try {
            const response = await fetch(API + '/state', { cache: 'no-store' })
            if (response.status === 404) {
              stopped.current = true
              setError({ kind: 'not-found' })
              return null
            }
            let json = null
            try {
              json = await response.json()
            } catch {
              throw new Error('invalid JSON response')
            }
            if (!response.ok) {
              setError({
                kind: 'http',
                status: response.status,
                message: (json && (json.error || json.code)) || 'HTTP ' + response.status,
              })
              return null
            }
            stopped.current = false
            setState(json)
            setError(null)
            return json
          } catch (cause) {
            setError({ kind: 'network', message: String((cause && cause.message) || cause) })
            return null
          }
        }, [])

        React.useEffect(() => {
          load(true)
          const timer = setInterval(() => {
            if (!stopped.current) load(false)
          }, 4000)
          return () => clearInterval(timer)
        }, [load])

        return {
          state,
          error,
          stopped: stopped.current,
          refresh: () => load(true),
        }
      }

      function fieldLabel(path, T) {
        const key = Array.isArray(path) && path.length > 0 ? String(path[0]) : ''
        const pair = FIELD_LABELS[key]
        if (pair) return T(pair[0], pair[1])
        return key || T('配置字段', 'configuration field')
      }

      function formatHostError(body, status, T) {
        const code = body && body.code
        if (code === 'invalid-config') {
          const issues = Array.isArray(body.issues) ? body.issues : []
          if (issues.length === 0) return T('配置校验失败。', 'Configuration validation failed.')
          const parts = issues.map((issue) => {
            const key = Array.isArray(issue.path) && issue.path.length > 0 ? String(issue.path[0]) : ''
            return FIELD_LABELS[key]
              ? fieldLabel(issue.path, T) + ': ' + T('取值不合法', 'invalid value')
              : String(issue.message || issue)
          })
          return T('配置校验失败：', 'Configuration validation failed: ') + parts.join('；')
        }
        if (code === 'config-editor-unavailable') {
          return T(
            '当前环境不允许从页面保存。请到插件管理里修改这一行配置。',
            'This environment does not allow saving from this page. Edit this plugin row in plugin management instead.',
          )
        }
        if (code === 'unsupported-media-type') {
          return T('保存请求格式不被接受（需要 application/json）。', 'The save request was rejected (application/json required).')
        }
        if (code === 'forbidden-origin') {
          return T('保存请求被拒绝：来源校验未通过，请从 DSH 页面重试。', 'The save request was rejected by the origin check; retry from the DSH page.')
        }
        if (code === 'invalid-json' || code === 'invalid-body') {
          return T('保存请求内容不是合法的配置对象。', 'The save request was not a valid configuration object.')
        }
        if (code === 'body-too-large') {
          return T('保存请求过大。', 'The save request was too large.')
        }
        if (code === 'method-not-allowed') {
          return T('保存请求方法不被接受。', 'The save request method was rejected.')
        }
        return (body && body.error) || 'HTTP ' + status
      }

      function Field(props) {
        const id = props.id
        const hintId = props.hint && id ? id + '-hint' : undefined
        const child = React.cloneElement(props.children, {
          id,
          ...(hintId ? { 'aria-describedby': hintId } : null),
        })
        return h(
          'div',
          { style: styles.field },
          h('label', { htmlFor: id, style: styles.label }, props.label),
          child,
          hintId ? h('span', { id: hintId, style: styles.hint }, props.hint) : null,
        )
      }

      function phaseOf(state, error) {
        if (error || (state && (state.error || state.registration === 'failed'))) return 'error'
        if (!state || state.registration === 'pending' || state.registration === 'switching') return 'loading'
        return 'ready'
      }

      /** 纯选择项构造：不依赖 React，供组件与行为测试共用。 */
      const firstModelOf = (providers, providerId) => {
        const entry = (Array.isArray(providers) ? providers : []).find(
          (item) => item && item.provider === providerId,
        )
        return entry && Array.isArray(entry.models) && entry.models[0] ? entry.models[0].model : ''
      }

      const presetChoices = (rows, current, selfId, T) => {
        const choices = [
          {
            value: 'standard',
            label: 'standard — ' + T('默认，零额外依赖', 'default, no extra dependency'),
          },
        ]
        const seen = new Set(['standard'])
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!row || typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) continue
          seen.add(row.id)
          const label = row.name && row.name !== row.id ? row.name + '（' + row.id + '）' : row.id
          if (row.id === selfId) {
            choices.push({
              value: row.id,
              label: label + ' — ' + T('不能选自己', 'cannot use itself'),
              disabled: true,
            })
          } else if (row.broken) {
            choices.push({
              value: row.id,
              label: label + ' — ' + T('不可用（加载失败）', 'unavailable (failed to load)'),
              disabled: true,
            })
          } else {
            choices.push({ value: row.id, label })
          }
        }
        if (current && !seen.has(current)) {
          choices.push({
            value: current,
            label: current + ' — ' + T('已保存，但宿主目录中不可用', 'saved, but unavailable on this host'),
            disabled: true,
          })
        }
        return choices
      }

      const providerChoices = (providers, current, T) => {
        const choices = []
        const seen = new Set()
        for (const entry of Array.isArray(providers) ? providers : []) {
          if (!entry || typeof entry.provider !== 'string' || entry.provider.length === 0) continue
          seen.add(entry.provider)
          const label =
            entry.name && entry.name !== entry.provider
              ? entry.name + '（' + entry.provider + '）'
              : entry.provider
          choices.push({ value: entry.provider, label })
        }
        if (current && !seen.has(current)) {
          choices.push({
            value: current,
            label: current + ' — ' + T('已保存，但目录中找不到', 'saved, but missing from the catalog'),
            disabled: true,
          })
        }
        return choices
      }

      const modelChoices = (models, current, T) => {
        const choices = []
        const seen = new Set()
        for (const entry of Array.isArray(models) ? models : []) {
          if (!entry || typeof entry.model !== 'string' || entry.model.length === 0) continue
          seen.add(entry.model)
          const label =
            entry.name && entry.name !== entry.model ? entry.name + '（' + entry.model + '）' : entry.model
          choices.push({ value: entry.model, label })
        }
        if (current && !seen.has(current)) {
          choices.push({
            value: current,
            label: current + ' — ' + T('已保存，但目录中找不到', 'saved, but missing from the catalog'),
            disabled: true,
          })
        }
        return choices
      }

      const renderChoices = (choices) =>
        choices.map((choice) =>
          h(
            'option',
            { key: choice.value, value: choice.value, disabled: choice.disabled },
            choice.label,
          ),
        )


      function SettingsSummary(props) {
        const isZh = useActiveLocale(props.locale).toLowerCase().startsWith('zh')
        const T = (cn, en) => (isZh ? cn : en)
        return h(
          'span',
          null,
          T(
            '设置施工方式、子代理服务商与模型，以及模型守门的范围。',
            'Choose the development setup, the subagent provider and model, and how far the model guard applies.',
          ),
        )
      }

      function SettingsPage(props) {
        const locale = props.locale
        const isZh = useActiveLocale(locale).toLowerCase().startsWith('zh')
        const T = (cn, en) => (isZh ? cn : en)
        const { state, error, refresh } = useHostState()
        const [draft, setDraft] = React.useState(null)
        const [dirty, setDirty] = React.useState(false)
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)

        const config = state && state.config ? state.config : null
        React.useEffect(() => {
          if (config && !dirty) setDraft({ ...config })
        }, [config, dirty])

        const update = (patch) => {
          setNotice(null)
          setDirty(true)
          setDraft((previous) => ({ ...(previous || config || {}), ...patch }))
        }

        const save = async () => {
          if (!draft) return
          setBusy(true)
          setNotice(null)
          try {
            const response = await fetch(API + '/config', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(draft),
            })
            let json = null
            try {
              json = await response.json()
            } catch {
              json = null
            }
            if (!response.ok) {
              const failure = new Error(formatHostError(json, response.status, T))
              failure.hostFormatted = true
              throw failure
            }
            setDirty(false)
            setDraft(json && json.config ? json.config : draft)
            setNotice({
              kind: json && json.unchanged ? 'unchanged' : 'saved',
              text: json && json.unchanged
                ? T('配置没有变化。', 'No changes.')
                : T(
                    '已保存并正在应用；现有会话继续使用当前设置，新建会话才会使用新设置。',
                    'Saved and applying; existing sessions keep their current settings, while new sessions use the new ones.',
                  ),
            })
            setTimeout(refresh, 600)
            setTimeout(refresh, 1800)
          } catch (cause) {
            // 保存会触发插件重建，连接可能短暂断开；重读一次若已是草稿值就按成功显示。
            let applied = false
            try {
              const latest = await refresh()
              applied =
                latest &&
                latest.config &&
                JSON.stringify(latest.config) === JSON.stringify(draft)
            } catch {
              applied = false
            }
            if (applied) {
              setDirty(false)
              setNotice({
                kind: 'saved',
                text: T(
                  '已保存并正在应用；现有会话继续使用当前设置，新建会话才会使用新设置。',
                  'Saved and applying; existing sessions keep their current settings, while new sessions use the new ones.',
                ),
              })
            } else {
              const raw = String((cause && cause.message) || cause)
              const formatted = cause && cause.hostFormatted
              setNotice({
                kind: 'error',
                text: formatted ? raw : T('保存失败：', 'Save failed: ') + raw,
              })
            }
          } finally {
            setBusy(false)
          }
        }

        const discardAndRefresh = () => {
          if (dirty) {
            setDirty(false)
            setDraft(config ? { ...config } : null)
            setNotice({ kind: 'discarded', text: T('已放弃未保存的修改。', 'Unsaved changes discarded.') })
          }
          refresh()
        }

        const mode = state ? state.effectiveMode : null
        const modeName = state && state.modeName ? state.modeName : mode
        const fallback = Boolean(state && state.fallback && state.fallback.active)
        const presetsState = state && state.presets ? state.presets : null
        const presetRows = presetsState && Array.isArray(presetsState.rows) ? presetsState.rows : []
        const selfId = (presetsState && presetsState.selfId) || 'dev-plan'
        const modelCatalog = state && state.modelCatalog ? state.modelCatalog : null
        const providers = modelCatalog && Array.isArray(modelCatalog.providers) ? modelCatalog.providers : []
        const catalogFailures = modelCatalog && Array.isArray(modelCatalog.failures) ? modelCatalog.failures : []
        const preset = state && state.preset ? state.preset : null
        const violations = (state && state.violations) || []
        const route = state && state.route ? state.route : null
        const phase = phaseOf(state, error)
        const registration = state ? state.registration : null

        const providerId = draft ? draft.childProvider : route ? route.provider : ''
        const providerEntry = providers.find((entry) => entry && entry.provider === providerId)
        const models = providerEntry && Array.isArray(providerEntry.models) ? providerEntry.models : []
        const providerKnown = providers.some((entry) => entry && entry.provider === providerId)
        const modelId = draft ? draft.childModel : route ? route.model : ''
        const modelKnown = models.some((entry) => entry && entry.model === modelId)

        const changeProvider = (nextProvider) => {
          const firstModel = firstModelOf(providers, nextProvider)
          update(
            firstModel
              ? { childProvider: nextProvider, childModel: firstModel }
              : { childProvider: nextProvider },
          )
        }

        let statusText = T('状态读取中…', 'Loading state…')
        if (error && error.kind === 'not-found') {
          statusText = T('设置页面不可用', 'Settings page unavailable')
        } else if (error) {
          statusText = T('状态读取失败', 'State read failed')
        } else if (state && state.error) {
          statusText = T('施工配置加载失败', 'Development setup failed to load')
        } else if (state && registration === 'pending') {
          statusText = T('尚未注册', 'Not registered yet')
        } else if (state && registration === 'switching') {
          statusText = T('切换中…', 'Switching…')
        } else if (state && registration === 'failed') {
          statusText = T('注册失败', 'Registration failed')
        } else if (state && registration === 'disposed') {
          statusText = T('已卸载', 'Disposed')
        } else if (state) {
          statusText = mode
            ? T('当前施工方式：', 'Development setup: ') +
              (modeName || mode) +
              (fallback ? T('（已回退）', ' (fallback)') : '')
            : T('已同步', 'Synced')
        }

        const readErrorText =
          error && error.kind === 'not-found'
            ? T(
                'Host 未加载新版插件或设置路由未注册。请重启 DSH，并确认本插件行已启用；已停止自动重试，点“刷新”可重试。',
                'The Host has not loaded the updated plugin or its settings route is not registered. Restart DSH and confirm this plugin row is enabled. Auto-retry stopped; select Refresh to retry.',
              )
            : error && error.kind === 'network'
              ? T(
                  '无法连接 Host。请确认 DSH 正在运行、插件已启用，然后点“刷新”重试。',
                  'Cannot reach the Host. Confirm DSH is running and the plugin is enabled, then select Refresh to retry.',
                )
              : error
                ? T('读取状态失败（HTTP ', 'State read failed (HTTP ') + (error.status || '?') + '）。'
                : ''
        const readErrorDetail = error && error.kind !== 'not-found' ? String(error.message || '') : ''

        const saveStateText = busy
          ? T('保存中…', 'Saving…')
          : dirty
            ? T('未保存修改', 'Unsaved changes')
            : notice && notice.kind === 'saved'
              ? T('已保存', 'Saved')
              : notice && notice.kind === 'discarded'
                ? T('已放弃修改', 'Changes discarded')
                : notice && notice.kind === 'error'
                  ? T('保存失败', 'Save failed')
                  : error
                    ? T('读取失败', 'Read failed')
                    : state
                      ? T('已同步', 'Synced')
                      : T('未加载', 'Not loaded')

        const guardMode = draft ? draft.modelGuardMode : 'pin'
        const guardHint =
          guardMode === 'audit'
            ? T('只记录用错模型的情况，不阻止。', 'Records model mismatches without blocking them.')
            : guardMode === 'off'
              ? T('完全不管理子代理模型，也不记录。', 'No subagent model management or logging.')
              : T('发现子代理用错模型就按下面的选择停止或记录。', 'Stops or records a subagent that uses the wrong model, per the choices below.')

        const presetCatalogText = !presetsState
          ? ''
          : presetsState.checked
            ? presetRows.length === 0
              ? T('宿主没有返回可用的施工方式，当前先按 standard 运行。', 'The host returned no available setups; standard is used for now.')
              : ''
            : presetsState.timedOut
              ? T(
                  '施工方式列表读取超时或失败' +
                    (presetsState.error ? '：' + presetsState.error : '') +
                    '，稍后会自动复检；当前先按 standard 运行。',
                  'The setup list timed out or failed' +
                    (presetsState.error ? ': ' + presetsState.error : '') +
                    ' and will retry shortly; standard is used for now.',
                )
              : T('施工方式列表尚未读取。', 'The setup list has not been read yet.')

        const selectedPresetRow = draft
          ? presetRows.find((row) => row && row.id === draft.developMode)
          : undefined
        const selectedPresetText = (() => {
          if (!draft) return ''
          if (draft.developMode === selfId) {
            return T(
              'develop 不能使用“开发规划与交付”自身，运行时会回退 standard。',
              'develop cannot use “Development planning & delivery” itself; standard is used at runtime.',
            )
          }
          if (selectedPresetRow && selectedPresetRow.broken) {
            return T('这个施工方式加载失败，暂不可用：', 'This setup failed to load: ') + selectedPresetRow.broken
          }
          const catalogReady = presetsState && presetsState.checked === true
          if (draft.developMode !== 'standard' && catalogReady && !selectedPresetRow) {
            return T(
              '已保存的施工方式“' + draft.developMode + '”当前不在宿主目录中；配置会保留，运行时会先回退 standard。',
              'The saved setup “' + draft.developMode + '” is not in the host catalog. The setting is kept, and standard is used at runtime.',
            )
          }
          return ''
        })()

        const catalogText = !modelCatalog
          ? T('模型列表读取中…', 'Loading the model list…')
          : modelCatalog.checked !== true && !modelCatalog.error
            ? T('模型列表读取中…', 'Loading the model list…')
            : modelCatalog.error === 'llm-unavailable'
            ? T(
                '当前环境没有可读取的模型目录。已保存的服务商与模型会保留，不会自动改成别的。',
                'No model catalog is available in this environment. Saved provider and model are kept unchanged.',
              )
            : modelCatalog.error
              ? T('模型目录读取失败：', 'Model catalog failed: ') +
                modelCatalog.error +
                T('。已保存的值会保留。', ' Saved values are kept.')
              : providers.length === 0
                ? T('宿主没有返回可用的服务商，已保存的值会保留。', 'The host returned no providers; saved values are kept.')
                : catalogFailures.length > 0
                  ? T('部分服务商读取失败：', 'Some providers failed to load: ') +
                    catalogFailures.map((item) => item.provider).join('、') +
                    T('；它们下面的模型列表可能不完整。', '; their model lists may be incomplete.')
                  : ''

        const unavailableRouteText =
          providerId && !providerKnown
            ? T(
                '当前保存的服务商不在目录中（可能已卸载或改名）；保存不会自动替换它。',
                'The saved provider is missing from the catalog (removed or renamed?). Saving will not replace it.',
              )
            : modelId && providerKnown && !modelKnown
              ? T(
                  '当前保存的模型不在此服务商的列表中；保存不会自动替换它。',
                  'The saved model is not in this provider’s list. Saving will not replace it.',
                )
              : ''

        return h(
          'div',
          { style: styles.root },

          h(
            'div',
            { style: styles.head },
            h('span', { style: styles.dot(phase) }),
            h('span', { style: styles.title }, T('开发规划与交付 · 施工设置', 'Development planning & delivery · development settings')),
            h('span', { style: styles.status, role: 'status', 'aria-live': 'polite' }, statusText),
          ),
          h(
            'div',
            { style: styles.hint },
            T(
              '主窗口只做规划、派工与复核，永不亲自写代码；develop 子代理负责施工并直接向主窗口汇报。',
              'The main window only plans, dispatches, and reviews; it never writes code. The develop subagent implements and reports back directly.',
            ),
          ),

          readErrorText
            ? h(
                'div',
                { style: styles.errorBox, role: 'alert' },
                h('div', null, readErrorText),
                readErrorDetail ? h('div', { style: styles.mono }, readErrorDetail) : null,
              )
            : null,

          state && state.error
            ? h(
                'div',
                { style: styles.errorBox, role: 'alert' },
                h(
                  'div',
                  null,
                  state.errorCode === 'preset-registration-failed'
                    ? T('施工配置加载失败；详情见插件日志。', 'The development setup failed to load; see the plugin log for details.')
                    : T('插件错误：', 'Plugin error: '),
                ),
                h('div', { style: styles.mono }, String(state.error)),
              )
            : null,

          fallback
            ? h(
                'div',
                { style: styles.banner, role: 'status' },
                h('strong', null, T('已回退 standard。', 'Fell back to standard. ')),
                T(
                  ' 你选择的方式当前不可用（可能未安装、未启用、已被移除或加载失败）；develop 临时使用 standard，其他子代理不受影响。原因：',
                  ' The selected setup is currently unavailable (not installed, disabled, removed, or failed to load); develop uses standard for now. Other subagents are unaffected. Reason: ',
                ),
                h('span', { style: styles.mono }, (state.fallback && state.fallback.reason) || ''),
              )
            : null,

          mode && mode !== 'standard' && !fallback
            ? h(
                'div',
                { style: styles.hint },
                T(
                  '只有 develop 使用“' + (modeName || mode) + '”；recon / review / scribe 仍为 standard。',
                  'Only develop uses “' + (modeName || mode) + '”; recon / review / scribe stay on standard.',
                ),
              )
            : null,

          h(
            'fieldset',
            { style: { ...styles.card, margin: 0, minWidth: 0 } },
            h('legend', { style: styles.legend }, T('施工子代理', 'Development subagent')),
            h('div', { style: styles.hint }, T('只有 develop 使用这里的选择。', 'Only develop uses this choice.')),
            draft
              ? h(
                  React.Fragment,
                  null,
                  h(
                    Field,
                    {
                      id: 'dev-plan-presets-develop-mode',
                      label: T('施工方式', 'Development setup'),
                      hint: T('列表中包含宿主已安装的施工方式；不可用的项会标明原因。', 'The list contains setups installed on this host; unavailable entries explain why.'),
                    },
                    h(
                      'select',
                      {
                        name: 'developMode',
                        style: { ...styles.control, ...(busy ? styles.controlDisabled : null) },
                        value: draft.developMode,
                        disabled: busy,
                        onChange: (event) => update({ developMode: event.target.value }),
                      },
                      renderChoices(presetChoices(presetRows, draft.developMode, selfId, T)),
                    ),
                  ),
                  presetCatalogText
                    ? h('div', { style: styles.hint, role: 'status' }, presetCatalogText)
                    : null,
                  selectedPresetText
                    ? h('div', { style: styles.banner, role: 'status' }, selectedPresetText)
                    : null,
                  h(
                    'div',
                    { style: styles.row },
                    h(
                      Field,
                      {
                        id: 'dev-plan-presets-provider',
                        label: T('服务商', 'Provider'),
                        hint: T('子代理使用的模型服务商。', 'Model provider used by subagents.'),
                      },
                      h(
                        'select',
                        {
                          name: 'childProvider',
                          style: { ...styles.control, ...(busy ? styles.controlDisabled : null) },
                          value: providerId,
                          disabled: busy || providers.length === 0,
                          onChange: (event) => changeProvider(event.target.value),
                        },
                        renderChoices(providerChoices(providers, providerId, T)),
                      ),
                    ),
                    h(
                      Field,
                      {
                        id: 'dev-plan-presets-model',
                        label: T('模型', 'Model'),
                        hint: T('所选服务商下可用的模型。', 'A model available under the selected provider.'),
                      },
                      h(
                        'select',
                        {
                          name: 'childModel',
                          style: { ...styles.control, ...(busy ? styles.controlDisabled : null) },
                          value: modelId,
                          disabled: busy || models.length === 0,
                          onChange: (event) => update({ childModel: event.target.value }),
                        },
                        renderChoices(modelChoices(models, modelId, T)),
                      ),
                    ),
                  ),
                  catalogText
                    ? h('div', { style: styles.hint, role: 'status' }, catalogText)
                    : null,
                  unavailableRouteText
                    ? h('div', { style: styles.banner, role: 'status' }, unavailableRouteText)
                    : null,
                  h(
                    Field,
                    {
                      id: 'dev-plan-presets-effort',
                      label: T('推理强度（可选）', 'Reasoning effort (optional)'),
                      hint: T('留空就使用服务商默认值。', 'Leave empty to use the provider default.'),
                    },
                    h('input', {
                      name: 'childReasoningEffort',
                      style: { ...styles.control, ...(busy ? styles.controlDisabled : null) },
                      value: draft.childReasoningEffort || '',
                      disabled: busy,
                      spellCheck: false,
                      placeholder: T('留空 = 服务商默认', 'empty = provider default'),
                      onChange: (event) => update({ childReasoningEffort: event.target.value }),
                    }),
                  ),
                )
              : h('div', { style: styles.hint }, T('加载中…', 'Loading…')),
            route
              ? h(
                  'div',
                  { style: styles.hint },
                  T('当前生效：', 'Currently effective: '),
                  h(
                    'span',
                    { style: styles.mono },
                    route.provider + ' / ' + route.model + (route.reasoningEffort ? ' / ' + route.reasoningEffort : ''),
                  ),
                )
              : null,
            h(
              'div',
              { style: styles.hint },
              T(
                '这四个委派工具（recon / review / scribe / develop）共用同一服务商与模型；只影响子代理，不动主会话。保存后以回读值为准。',
                'All four delegation tools (recon / review / scribe / develop) share this provider and model. It affects subagents only, never the main session. Trust the read-back value after saving.',
              ),
            ),
          ),

          h(
            'fieldset',
            { style: { ...styles.card, margin: 0, minWidth: 0 } },
            h('legend', { style: styles.legend }, T('模型守门', 'Model guard')),
            h(
              'div',
              { style: styles.hint },
              T('只管理子代理，主会话永远不受影响。', 'Governs subagents only; the main session is never touched.'),
            ),
            draft
              ? h(
                  React.Fragment,
                  null,
                  h(
                    Field,
                    {
                      id: 'dev-plan-presets-guard-mode',
                      label: T('守门方式', 'Guard behavior'),
                    },
                    h(
                      'select',
                      {
                        name: 'modelGuardMode',
                        style: { ...styles.control, ...(busy ? styles.controlDisabled : null) },
                        value: draft.modelGuardMode,
                        disabled: busy,
                        onChange: (event) => update({ modelGuardMode: event.target.value }),
                      },
                      h('option', { value: 'pin' }, 'pin — ' + T('发现用错就停止（默认）', 'stop a mismatch (default)')),
                      h('option', { value: 'audit' }, 'audit — ' + T('只记录，不阻止', 'record only, never block')),
                      h('option', { value: 'off' }, 'off — ' + T('不管理模型', 'no model management')),
                    ),
                  ),
                  h('div', { style: styles.hint }, guardHint),
                  h(
                    'div',
                    { style: styles.row },
                    h(
                      'label',
                      { style: styles.check, htmlFor: 'dev-plan-presets-guard-all' },
                      h('input', {
                        id: 'dev-plan-presets-guard-all',
                        name: 'guardAllSubagents',
                        type: 'checkbox',
                        checked: Boolean(draft.guardAllSubagents),
                        disabled: busy,
                        onChange: (event) => update({ guardAllSubagents: event.target.checked }),
                      }),
                      T('同时管理其他插件的子代理', 'Also govern subagents from other plugins'),
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.hint },
                    T(
                      '默认只管理“开发规划与交付”会话派出的子代理；勾选后管理所有子代理。',
                      'By default only subagents started from “Development planning & delivery” sessions are governed; check this to govern every subagent.',
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.row },
                    h(
                      'label',
                      { style: styles.check },
                      h('input', {
                        type: 'checkbox',
                        name: 'killOnViolation',
                        checked: Boolean(draft.killOnViolation),
                        disabled: busy || draft.modelGuardMode !== 'pin',
                        onChange: (event) => update({ killOnViolation: event.target.checked }),
                      }),
                      T('越界时立即停止（仅 pin）', 'Stop on violation (pin only)'),
                    ),
                    h(
                      'label',
                      { style: styles.check },
                      h('input', {
                        type: 'checkbox',
                        name: 'honorExplicit',
                        checked: Boolean(draft.honorExplicit),
                        disabled: busy || draft.modelGuardMode !== 'pin',
                        onChange: (event) => update({ honorExplicit: event.target.checked }),
                      }),
                      T('尊重子代理自己选的模型（仅 pin）', 'Honor an explicit child model (pin only)'),
                    ),
                    h(
                      'label',
                      { style: styles.check },
                      h('input', {
                        type: 'checkbox',
                        name: 'audit',
                        checked: Boolean(draft.audit),
                        disabled: busy || draft.modelGuardMode === 'off',
                        onChange: (event) => update({ audit: event.target.checked }),
                      }),
                      T('记录详细日志', 'Write detailed logs'),
                    ),
                  ),
                  h(
                    'div',
                    { style: styles.hint },
                    T(
                      '“audit”守门方式只是不阻止越界；“记录详细日志”是单独的日志开关，off 时不可用，日志只含模型与事件，不含凭据。',
                      'The “audit” guard behavior only avoids blocking; “write detailed logs” is a separate switch, unavailable in off mode, and contains models and events but no credentials.',
                    ),
                  ),
                )
              : null,
          ),

          h(
            'div',
            { style: styles.row },
            h(
              'button',
              {
                type: 'button',
                style: {
                  ...styles.primary,
                  ...(busy || !draft || !dirty ? styles.buttonDisabled : null),
                },
                disabled: busy || !draft || !dirty,
                'aria-busy': busy,
                'aria-disabled': busy || !draft || !dirty,
                title: !dirty ? T('没有未保存的修改', 'No unsaved changes') : undefined,
                onClick: save,
              },
              busy ? T('保存中…', 'Saving…') : T('保存', 'Save'),
            ),
            h(
              'button',
              {
                type: 'button',
                style: { ...styles.button, ...(busy ? styles.buttonDisabled : null) },
                disabled: busy,
                onClick: discardAndRefresh,
              },
              dirty ? T('放弃修改并刷新', 'Discard changes and refresh') : T('刷新', 'Refresh'),
            ),
            h(
              'span',
              { style: styles.status, role: 'status', 'aria-live': 'polite' },
              saveStateText,
            ),
            notice
              ? h(
                  'span',
                  {
                    style: notice.kind === 'error' ? styles.noticeError : styles.noticeOk,
                    role: notice.kind === 'error' ? 'alert' : 'status',
                    'aria-live': notice.kind === 'error' ? 'assertive' : 'polite',
                  },
                  notice.text,
                )
              : null,
          ),

          h(
            'div',
            { style: styles.hint },
            T(
              '保存后插件会重新加载；现有会话继续使用当前设置，新建会话才会使用新设置。',
              'Saving reloads the plugin; existing sessions keep their current settings, and new sessions use the new ones.',
            ),
          ),

          preset
            ? h(
                'div',
                { style: styles.card },
                h(
                  'div',
                  { style: styles.row },
                  h('span', { style: styles.title }, T('当前运行说明', 'Current runtime description')),
                  h('span', { style: styles.mono }, preset.id),
                ),
                h('div', { style: styles.hint }, preset.description),
              )
            : null,

          h(
            'div',
            { style: styles.card },
            h(
              'div',
              { style: styles.row },
              h('span', { style: styles.title }, T('越界记录', 'Violations')),
              h('span', { style: styles.hint }, violations.length === 0 ? T('暂无', 'none') : String(violations.length)),
            ),
            violations.length === 0
              ? h('div', { style: styles.hint }, T('还没有子代理跑过非目标模型。', 'No subagent has used a non-target model.'))
              : violations.map((entry, index) =>
                  h(
                    'div',
                    { key: index, style: styles.hint },
                    h('span', { style: styles.mono }, (entry.at || '') + ' · '),
                    (entry.text || '') +
                      ' ' +
                      T('（实际 ', '(actual ') +
                      (entry.from || '?') +
                      ' → ' +
                      T('期望 ', 'want ') +
                      (entry.want || '?') +
                      '）',
                  ),
                ),
          ),
        )
      }

      function SettingsEntry(props) {
        if (props && props.view === 'summary') {
          return h(SettingsSummary, { locale: props.locale })
        }
        return h(SettingsPage, { locale: props.locale })
      }

      const exportedModule = {
        inject: ['slots', 'locale'],
        apply(ctx) {
          try {
            ctx.slots.inject('plugins.row.config', () =>
              ctx.slots.register(
                {
                  name: 'plugins.row.config',
                  id: 'dev-plan-presets-config',
                  key: 'dsh-dev-plan-presets#dev-plan-presets',
                  order: 10,
                },
                (props) => h(SettingsEntry, { ...props, locale: ctx.locale }),
              ),
            )
          } catch (error) {
            try {
              console.error('[dsh-dev-plan-presets] client slot registration failed', error)
            } catch {
              /* ignore */
            }
          }
        },
      }
      // 仅测试开关打开时暴露纯选择函数；生产模块对象不变。
      if (globalThis.__DSH_DEV_PLAN_PRESETS_TEST__ === true) {
        exportedModule.__test = { presetChoices, providerChoices, modelChoices, firstModelOf }
      }
      return exportedModule
    } catch (error) {
      try {
        console.error('[dsh-dev-plan-presets] client factory failed', error)
      } catch {
        /* ignore */
      }
      throw error
    }
  },
})
