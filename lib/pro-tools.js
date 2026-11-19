/**
 * dsh-aftereffects — pro tool set
 *
 * Seven tools for commercial AE template work. Each one is a thin adapter over
 * the ExtendScript pro pack (`lib/ae-runtime-pro.jsx`), reached through the
 * existing job-queue bridge — no new transport, no CEP dependency.
 *
 *   ae_scan_effects           installed effects, display name <-> matchName
 *   ae_inspect_plugin_params  one effect's parameter tree, CUSTOM_VALUE flagged
 *   ae_apply_ffx_preset       apply an .ffx preset to a layer
 *   ae_capture_preview        render a frame (downsample / solo) for inspection
 *   ae_essential_graphics     expose controllers to EGP, export .mogrt
 *   ae_audio_markers          waveform peaks -> timeline markers
 *   ae_checkpoint             timestamped .aep snapshot
 *
 * @module dsh-aftereffects/pro-tools
 */

const text = (value) => [{ type: 'text', text: String(value) }]

function formatError(error) {
  const lines = [`After Effects 调用失败：${error.message}`]
  if (error.code) lines.push(`code: ${error.code}`)
  if (typeof error.line === 'number' && error.line > 0) {
    lines.push(`extendscript line: ${error.line}`)
    if (error.context) lines.push(`  出错代码：${String(error.context).trim()}`)
  }
  if (error.detail) lines.push(`detail: ${error.detail}`)
  return lines.join('\n')
}

const layerSpecParams = {
  comp: { type: 'string', description: '合成名。省略则用最新的合成。' },
  compId: { type: 'number', description: '合成 id（优先于 comp）。' },
  layerId: { type: 'number', description: '图层 id —— 跨语言/跨版本最稳定的寻址方式。' },
  layerIndex: { type: 'number', description: '图层序号（1 起）。' },
  layerName: { type: 'string', description: '图层显示名。' },
}

/**
 * @param {object} deps
 * @param {(job: object, options?: object) => Promise<any>} deps.serial
 * @param {{ runtime: Function }} deps.bridge
 * @param {(definition: object) => void} deps.register
 * @param {Function} deps.defineTool
 */
export function registerProTools({ serial, bridge, register, defineTool }) {
  /** Call a named pro-pack entry through the shared bridge. */
  const pro = (entry, payload) =>
    serial(() => bridge.runtime(`pro:${entry}`, payload ?? {}))

  /* ------------------------------------------------- ae_scan_effects */

  register(defineTool({
    name: 'ae_scan_effects',
    description: [
      '扫描本机 After Effects 已安装的全部特效（原生 + 第三方，如 Particular / Deep Glow / Saber / Element 3D），导出「显示名 <-> matchName」完整映射。',
      '显示名随 After Effects 语言变化，matchName 不变 —— 脚本里一律用 matchName 寻址，这是中文版 AE 不乱报错的关键。',
      '返回项含 thirdParty 标记，一眼区分「AE 自带」和「装的插件」。可用 query 过滤，includeObsolete 包含已废弃特效。',
      '调用第三方插件前先跑这个，拿到 matchName 再交给 ae_inspect_plugin_params 看参数。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      query: { type: 'string', description: '按显示名/matchName/分类模糊过滤，如 "glow"、"Particular"。' },
      includeObsolete: { type: 'boolean', description: '是否包含 AE 标记为已废弃的特效。默认 false。' },
      limit: { type: 'number', description: '最多返回多少条，默认不限制。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          total: { type: 'number' },
          returned: { type: 'number' },
          skippedObsolete: { type: 'number' },
          thirdPartyCount: { type: 'number' },
          query: {},
          effects: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const rows = Array.isArray(value.effects) ? value.effects : []
        const lines = [
          `已安装特效 **${value.total}** 个，返回 ${value.returned} 条（第三方 ${value.thirdPartyCount} 个）` +
            (value.skippedObsolete > 0 ? `，跳过废弃 ${value.skippedObsolete} 个` : ''),
        ]
        if (rows.length > 0) {
          lines.push('')
          lines.push('| matchName | 显示名 | 第三方 | 分类 |')
          lines.push('| --- | --- | --- | --- |')
          for (const r of rows.slice(0, 60)) {
            lines.push(`| \`${r.matchName}\` | ${r.displayName} | ${r.thirdParty ? '是' : ''} | ${r.category || ''} |`)
          }
          if (rows.length > 60) lines.push(`…还有 ${rows.length - 60} 条，见结构化输出。`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const value = await pro('scanEffects', {
          query: args.query,
          includeObsolete: args.includeObsolete === true,
          limit: args.limit,
        })
        return {
          total: Number(value.total ?? 0),
          returned: Number(value.returned ?? 0),
          skippedObsolete: Number(value.skippedObsolete ?? 0),
          thirdPartyCount: Number(value.thirdPartyCount ?? 0),
          query: value.query ?? null,
          effects: value.effects ?? [],
          error: '',
        }
      } catch (error) {
        return { total: 0, returned: 0, skippedObsolete: 0, thirdPartyCount: 0, query: null, effects: [], error: formatError(error) }
      }
    },
  }))

  /* --------------------------------------- ae_inspect_plugin_params */

  register(defineTool({
    name: 'ae_inspect_plugin_params',
    description: [
      '深度读取某个图层上某个效果的完整参数树，用来安全地驱动第三方插件。',
      '每个参数给出：数字索引 propertyIndex、matchName、propertyType、valueType（OneD/TwoD/ThreeD/COLOR/SHAPE…）。',
      '**customValue=true 的项是 CUSTOM_VALUE —— 二进制黑盒属性，严禁脚本赋值**，赋值会静默损坏或直接抛错；这类参数只能靠 .ffx 预设或手动 UI 设置。',
      '下拉菜单参数会带 menuItems 可选列表。修改参数请用 propertyIndex 或 matchName，不要用中文显示名。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      ...layerSpecParams,
      matchName: { type: 'string', description: '效果 matchName，如 "ADBE Glo2"。与 effectName / effectIndex 三选一。' },
      effectName: { type: 'string', description: '效果显示名（中文版是中文），不推荐但可用。' },
      effectIndex: { type: 'number', description: '效果在图层效果栈里的序号（1 起）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: {},
          effect: {},
          parameterCount: { type: 'number' },
          customValueCount: { type: 'number' },
          warning: { type: 'string' },
          parameters: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const params = Array.isArray(value.parameters) ? value.parameters : []
        const lines = [
          `图层 **${value.layer?.name}** 上的效果 **${value.effect?.name}**（\`${value.effect?.matchName}\`）`,
          `参数 ${value.parameterCount} 个` + (value.customValueCount > 0 ? `，其中 ${value.customValueCount} 个是 CUSTOM_VALUE` : ''),
        ]
        if (value.warning) lines.push('', `⚠️ ${value.warning}`)
        lines.push('')
        lines.push('| idx | 名称 | matchName | 类型 | 值 / 备注 |')
        lines.push('| --- | --- | --- | --- | --- |')
        for (const p of params.slice(0, 40)) {
          let val
          if (p.customValue) val = '**CUSTOM_VALUE — 禁止赋值**'
          else if (p.menuItems) val = (p.menuItems.map((m) => m.name).join(' / ') || '').slice(0, 60)
          else if (p.value !== undefined) val = JSON.stringify(p.value).slice(0, 60)
          else val = ''
          lines.push(`| ${p.propertyIndex} | ${p.name} | \`${p.matchName}\` | ${p.valueType} | ${val} |`)
        }
        if (params.length > 40) lines.push(`…还有 ${params.length - 40} 个参数，见结构化输出。`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const value = await pro('inspectEffectParams', { ...args })
        return {
          layer: value.layer ?? {},
          effect: value.effect ?? {},
          parameterCount: Number(value.parameterCount ?? 0),
          customValueCount: Number(value.customValueCount ?? 0),
          warning: value.warning ?? '',
          parameters: value.parameters ?? [],
          error: '',
        }
      } catch (error) {
        return { layer: {}, effect: {}, parameterCount: 0, customValueCount: 0, warning: '', parameters: [], error: formatError(error) }
      }
    },
  }))

  /* ------------------------------------------ ae_apply_ffx_preset */

  register(defineTool({
    name: 'ae_apply_ffx_preset',
    description: [
      '扫描本机 .ffx 动画预设（含安装目录与用户目录），names 已做 URL 解码，可直接读。',
      '**应用预设（presetPath）需要交互式 AE**：layer.applyPreset() 在无界面实例里会终止进程（已实测），工具会先探测并明确拒绝，同时给出替代方案。',
      '替代方案：用 ae_run_script 按 propertyIndex 直接挂效果并设参数 —— 效果本身完全可脚本化，只有「预设」这个操作依赖 UI。',
      '扫描能力不受限，用来找预设名、学习作者命名与效果组合仍然有用。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      ...layerSpecParams,
      presetPath: { type: 'string', description: '要应用的 .ffx 绝对路径。给了它就直接挂载。' },
      roots: { type: 'string', description: '扫描根目录，多个用分号分隔。省略则扫默认预设目录。' },
      query: { type: 'string', description: '按文件名模糊过滤预设。' },
      limit: { type: 'number', description: '扫描上限，默认 800。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean' },
          preset: { type: 'string' },
          addedEffects: {},
          effectsBefore: { type: 'number' },
          effectsAfter: { type: 'number' },
          scanned: {},
          count: { type: 'number' },
          presets: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        if (value.applied) {
          const lines = [
            `已挂载预设 **${value.preset}**`,
            `效果数：${value.effectsBefore} → ${value.effectsAfter}`,
          ]
          const added = Array.isArray(value.addedEffects) ? value.addedEffects : []
          if (added.length > 0) lines.push(`新增效果：${added.join('、')}`)
          return text(lines.join('\n'))
        }
        const rows = Array.isArray(value.presets) ? value.presets : []
        const lines = [`找到 ${value.count} 个 .ffx 预设`]
        for (const r of rows.slice(0, 40)) lines.push(`  • ${r.name}  \`${r.path}\``)
        if (rows.length > 40) lines.push(`…还有 ${rows.length - 40} 个。`)
        const scanned = Array.isArray(value.scanned) ? value.scanned : []
        if (scanned.length > 0) {
          lines.push('', '扫描目录：')
          for (const s of scanned) lines.push(`  ${s.exists ? '✓' : '✗'} ${s.root}（${s.found}）`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        if (typeof args.presetPath === 'string' && args.presetPath.trim() !== '') {
          // Check first: applyPreset() terminates a headless instance outright
          // (measured on AE 27), so the caller must be told before the host
          // disappears rather than discovering it from a dead heartbeat.
          const caps = await pro('capabilities', {})
          const preset = caps?.applyPreset ?? {}
          if (preset.usable !== true) {
            const reason = String(preset.reason || 'applyPreset() is unavailable in this instance')
            return {
              applied: false, preset: '', addedEffects: [], effectsBefore: 0, effectsAfter: 0,
              scanned: [], count: 0, presets: [],
              error: [
                `无法应用 .ffx 预设：${reason}`,
                '',
                '替代方案（两条都能走通）：',
                '1. 用 `ae_run_script` 直接把效果加上去并按 propertyIndex 设参数 —— 效果本身是可脚本化的，只有「预设」这个操作需要交互式 AE。',
                '2. 需要预设原样效果时，在你自己打开的 After Effects 窗口里挂一次（Effects & Presets 面板），再保存 .aep。',
                '',
                `扫描到的预设仍然可用作参考：先 ae_scan_effects 找 matchName，再 ae_inspect_plugin_params 看参数。`,
              ].join('\n'),
            }
          }
          const value = await pro('applyFfxPreset', { ...args })
          return {
            applied: true,
            preset: String(value.preset ?? ''),
            addedEffects: value.addedEffects ?? [],
            effectsBefore: Number(value.effectsBefore ?? 0),
            effectsAfter: Number(value.effectsAfter ?? 0),
            scanned: [], count: 0, presets: [], error: '',
          }
        }
        const roots = typeof args.roots === 'string' && args.roots.trim() !== ''
          ? args.roots.split(';').map((s) => s.trim()).filter(Boolean)
          : undefined
        const value = await pro('scanPresets', { roots, query: args.query, limit: args.limit })
        return {
          applied: false, preset: '', addedEffects: [], effectsBefore: 0, effectsAfter: 0,
          scanned: value.scanned ?? [], count: Number(value.count ?? 0), presets: value.presets ?? [], error: '',
        }
      } catch (error) {
        return { applied: false, preset: '', addedEffects: [], effectsBefore: 0, effectsAfter: 0, scanned: [], count: 0, presets: [], error: formatError(error) }
      }
    },
  }))

  /* -------------------------------------------- ae_capture_preview */

  register(defineTool({
    name: 'ae_capture_preview',
    description: [
      '渲染当前帧并返回图片路径，供多模态模型肉眼检查：文字溢出、粒子/辉光过曝、构图穿帮。',
      'longEdge 降采样（如 640）让一张图看清全貌又省 context；soloLayerId 单独隔离某层渲染，专治「这层为什么看不见」。',
      'count>1 时按区间连续采样多帧（motion 只有多帧才能判断）。',
      '挂完重型特效或排完版必须跑一次自检。',
    ].join('\n'),
    timeoutMs: 600_000,
    parameters: {
      comp: { type: 'string', description: '合成名。省略用最新的合成。' },
      compId: { type: 'number', description: '合成 id。' },
      output: { type: 'string', description: '单帧 PNG 的绝对路径（count<=1 时必填）。' },
      outputDir: { type: 'string', description: '多帧序列输出目录（count>1 时必填）。' },
      time: { type: 'number', description: '采样时间（秒）。默认当前时间。' },
      longEdge: { type: 'number', description: '长边目标像素，如 640。省略用原始分辨率。' },
      soloLayerId: { type: 'number', description: '只渲染这一层（隔离排查用）。' },
      count: { type: 'number', description: '采样帧数，>1 时走序列模式。默认 1。' },
      startTime: { type: 'number', description: '序列起始时间。' },
      endTime: { type: 'number', description: '序列结束时间。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string' },
          comp: {},
          time: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          bytes: { type: 'number' },
          isolatedLayer: {},
          frames: {},
          count: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        if (Array.isArray(value.frames) && value.frames.length > 0) {
          const lines = [`已渲染 ${value.count} 帧（${value.comp?.name ?? ''}）`]
          for (const f of value.frames) lines.push(`  ${f.time}s → \`${f.path}\``)
          return text(lines.join('\n'))
        }
        const lines = [
          `预览已渲染：\`${value.path}\``,
          `${value.width}x${value.height} · t=${value.time}s · ${Math.round((value.bytes ?? 0) / 1024)} KB`,
        ]
        if (value.isolatedLayer) lines.push(`（已隔离图层：${value.isolatedLayer.name}）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const count = Number(args.count ?? 1)
        if (count > 1) {
          const value = await pro('captureSequence', { ...args })
          return {
            path: '', comp: value.comp ?? '', time: 0, width: 0, height: 0, bytes: 0, isolatedLayer: null,
            frames: value.frames ?? [], count: Number(value.count ?? 0), error: '',
          }
        }
        const value = await pro('capturePreview', { ...args })
        return {
          path: String(value.path ?? ''),
          comp: value.comp ?? {},
          time: Number(value.time ?? 0),
          width: Number(value.width ?? 0),
          height: Number(value.height ?? 0),
          bytes: Number(value.bytes ?? 0),
          isolatedLayer: value.isolatedLayer ?? null,
          frames: [], count: 1, error: '',
        }
      } catch (error) {
        return { path: '', comp: {}, time: 0, width: 0, height: 0, bytes: 0, isolatedLayer: null, frames: [], count: 0, error: formatError(error) }
      }
    },
  }))

  /* ----------------------------------------- ae_essential_graphics */

  register(defineTool({
    name: 'ae_essential_graphics',
    description: [
      '把图层的文案、颜色、滑块、开关等控制器加进「基本图形」面板（Essential Graphics），这是一切可复用 .mogrt 模板的基础。',
      'properties 数组每项用 matchName 或 name 指定属性，例如文字层用 ADBE Text Properties.ADBE Text Document，颜色控制器用 effect 的 matchName。',
      '绑定控制器在无界面实例里可用；**导出 .mogrt 需要交互式 AE**（headless 调用会终止进程，已实测），此时工具会绑定好控制器并明确提示你到 AE 界面里导出。',
      '绑完建议用 ae_capture_preview 看一眼，确认模板占位符在画面里的位置合理。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      ...layerSpecParams,
      properties: { type: 'json', description: '要暴露为控制器的属性数组，如 [{"matchName":"ADBE Text Properties.ADBE Text Document"}]。' },
      output: { type: 'string', description: '导出 .mogrt 的绝对路径。给了就导出。' },
      overwrite: { type: 'boolean', description: '导出时是否覆盖同名文件。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          controllerCount: { type: 'number' },
          results: {},
          exported: { type: 'boolean' },
          path: { type: 'string' },
          bytes: { type: 'number' },
          note: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const lines = [`基本图形控制器共 ${value.controllerCount} 个`]
        const rows = Array.isArray(value.results) ? value.results : []
        for (const r of rows) {
          const label = r.name ?? r.requested?.matchName ?? r.requested?.name ?? ''
          lines.push(`  ${r.ok ? '✓' : '✗'} ${label}${r.ok ? '' : ` — ${r.error ?? ''}`}`)
        }
        if (value.exported) {
          lines.push('', `已导出模板：\`${value.path}\`（${Math.round((value.bytes ?? 0) / 1024)} KB）`)
        } else if (value.note) {
          lines.push('', value.note)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const value = await pro('essentialGraphics', { ...args })
        let exported = false
        let path = ''
        let bytes = 0
        let note = ''
        if (typeof args.output === 'string' && args.output.trim() !== '') {
          // The export call terminates a -noui instance (measured on AE 27), so
          // check before invoking it rather than letting the host disappear.
          const caps = await pro('capabilities', {})
          const eg = caps?.exportMogrt ?? {}
          if (eg.usable !== true) {
            note = [
              `控制器已绑定（${value.controllerCount ?? 0} 个），但无法在这个无界面实例里导出 .mogrt：`,
              String(eg.reason || 'exportAsMotionGraphicsTemplate() is unavailable'),
              '',
              '导出请在你打开的 After Effects 里完成：窗口 → 基本图形 → 导出动态图形模板。',
              '工程已经带着这些控制器，导出即可。',
            ].join('\n')
          } else {
            const ex = await pro('exportTemplate', { ...args })
            exported = ex.ok === true
            path = String(ex.path ?? '')
            bytes = Number(ex.bytes ?? 0)
            if (!exported && ex.error) note = String(ex.error)
          }
        }
        return {
          controllerCount: Number(value.controllerCount ?? 0),
          results: value.results ?? [],
          exported, path, bytes,
          error: '',
          note,
        }
      } catch (error) {
        return { controllerCount: 0, results: [], exported: false, path: '', bytes: 0, error: formatError(error) }
      }
    },
  }))

  /* --------------------------------------------- ae_audio_markers */

  register(defineTool({
    name: 'ae_audio_markers',
    description: [
      '分析音频层的电平波形，在峰值处自动打时间轴 Marker —— 做节奏卡点模板的基础。',
      'sensitivity 越大越挑剔（越少 Marker）；minGap 控制最小间隔秒数，防止 Marker 挤在一起。',
      '默认打在合成 Marker 上，onComp=false 改打图层 Marker。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      ...layerSpecParams,
      sensitivity: { type: 'number', description: '阈值 = 平均值 × sensitivity。默认 1.5，调大更挑剔。' },
      minGap: { type: 'number', description: '两个 Marker 的最小间隔（秒）。默认 0.18。' },
      maxMarkers: { type: 'number', description: '最多打几个，默认 60。' },
      onComp: { type: 'boolean', description: 'true 打合成 Marker（默认），false 打图层 Marker。' },
      clearExisting: { type: 'boolean', description: '打之前是否清空已有 Marker。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sampledFrames: { type: 'number' },
          meanLevel: { type: 'number' },
          threshold: { type: 'number' },
          peaksFound: { type: 'number' },
          markersPlaced: { type: 'number' },
          markerTarget: { type: 'string' },
          times: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const times = Array.isArray(value.times) ? value.times : []
        const lines = [
          `采样 ${value.sampledFrames} 帧，平均电平 ${value.meanLevel}，阈值 ${value.threshold}`,
          `检出 ${value.peaksFound} 个峰值，实际打点 ${value.markersPlaced} 个（${value.markerTarget}）`,
        ]
        if (times.length > 0) lines.push('', `时间点：${times.slice(0, 40).join('s, ')}s${times.length > 40 ? ' …' : ''}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const value = await pro('audioMarkers', { ...args })
        return {
          sampledFrames: Number(value.sampledFrames ?? 0),
          meanLevel: Number(value.meanLevel ?? 0),
          threshold: Number(value.threshold ?? 0),
          peaksFound: Number(value.peaksFound ?? 0),
          markersPlaced: Number(value.markersPlaced ?? 0),
          markerTarget: String(value.markerTarget ?? ''),
          times: value.times ?? [],
          error: '',
        }
      } catch (error) {
        return { sampledFrames: 0, meanLevel: 0, threshold: 0, peaksFound: 0, markersPlaced: 0, markerTarget: '', times: [], error: formatError(error) }
      }
    },
  }))

  /* ------------------------------------------------- ae_checkpoint */

  register(defineTool({
    name: 'ae_checkpoint',
    description: [
      '把当前工程另存为带时间戳的 .aep 备份，防止大批量改层/删层把用户原工程改崩。',
      '先原地保存，再复制副本 —— 打开中的工程仍指向用户原来的文件，不会被改道。',
      '未命名工程（从未保存过）会跳过并提示先保存一次。自动保留最近 keep 份，更早的清理掉。',
      '破坏性操作前先调这个。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      dir: { type: 'string', description: '备份目录。省略则为工程同级的 dsh-checkpoints。' },
      label: { type: 'string', description: '备份标签，如 before-bulk-relayout。' },
      keep: { type: 'number', description: '保留份数，默认 20。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
          hint: { type: 'string' },
          source: { type: 'string' },
          checkpoint: { type: 'string' },
          bytes: { type: 'number' },
          pruned: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        if (value.skipped) {
          return text(`未创建备份：${value.reason}\n${value.hint ?? ''}`)
        }
        const lines = [
          `已创建备份：\`${value.checkpoint}\``,
          `${Math.round((value.bytes ?? 0) / 1024)} KB · 源工程 ${value.source}`,
        ]
        const pruned = Array.isArray(value.pruned) ? value.pruned : []
        if (pruned.length > 0) lines.push(`已清理旧备份 ${pruned.length} 个`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const value = await pro('checkpoint', { ...args })
        return {
          ok: value.ok === true,
          skipped: value.skipped === true,
          reason: String(value.reason ?? ''),
          hint: String(value.hint ?? ''),
          source: String(value.source ?? ''),
          checkpoint: String(value.checkpoint ?? ''),
          bytes: Number(value.bytes ?? 0),
          pruned: value.pruned ?? [],
          error: '',
        }
      } catch (error) {
        return { ok: false, skipped: false, reason: '', hint: '', source: '', checkpoint: '', bytes: 0, pruned: [], error: formatError(error) }
      }
    },
  }))
}

export { formatError as formatProError }
