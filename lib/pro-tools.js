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

import { assertEs3 } from './es3-guard.js'
import { analyzeWav, WavError } from './wav.js'
import { buildContactSheet, PngError } from './contact-sheet.js'
import { classifyVendor, readCache, writeCache, clearCache, CACHE_SCHEMA } from './effect-cache.js'
import { verifyCheckpoint, recordCheckpoint, pruneCheckpoints, listCheckpoints } from './checkpoint.js'
import { readFileSync, existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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
 * Apply the caller's filters to a cached effect list.
 * A cache read must honour `query` / `includeObsolete` / `limit` exactly as a
 * live scan does, or a cached answer would silently ignore the request.
 */
function filterEffects(rows, args = {}) {
  const query = typeof args.query === 'string' && args.query.trim() !== ''
    ? args.query.trim().toLowerCase()
    : null
  const includeObsolete = args.includeObsolete === true
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 100000

  let skippedObsolete = 0
  const out = []
  for (const row of rows) {
    if (row.obsolete === true && !includeObsolete) {
      skippedObsolete++
      continue
    }
    if (query !== null) {
      const hay = `${row.displayName ?? ''} ${row.matchName ?? ''} ${row.category ?? ''} ${row.vendor ?? ''}`.toLowerCase()
      if (!hay.includes(query)) continue
    }
    out.push(row)
    if (out.length >= limit) break
  }
  return { rows: out, skippedObsolete }
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

  /* ------------------------------------------------------- ae_layers */

  register(defineTool({
    name: 'ae_layers',
    description: [
      '列出一个合成的所有图层，每层带**稳定 id**、类型、变换快照与出入点。',
      '`id` 是持久句柄：改名、重排序都不变，比 index 可靠，是所有后续操作的推荐寻址方式。',
      '可按 type（text/shape/solid/null/footage/camera/light）或 nameFilter 过滤。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      comp: { type: 'string', description: '合成名。省略则用最新的合成。' },
      compId: { type: 'number', description: '合成 id。' },
      type: { type: 'string', description: '只返回该类型图层。' },
      nameFilter: { type: 'string', description: '图层名模糊过滤。' },
      limit: { type: 'number', description: '最多返回多少层，默认不限。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          comp: {}, layerCount: { type: 'number' }, returned: { type: 'number' },
          layers: {}, error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const rows = Array.isArray(value.layers) ? value.layers : []
        const c = value.comp ?? {}
        const lines = [`**${c.name}** ${c.width}x${c.height} · ${value.layerCount} 层`]
        if (rows.length > 0) {
          lines.push('', '| id | idx | 名称 | 类型 | 效果 |')
          lines.push('| --- | --- | --- | --- | --- |')
          for (const r of rows.slice(0, 40)) {
            lines.push(`| ${r.id} | ${r.index} | ${r.name} | ${r.type} | ${r.effects ?? 0} |`)
          }
          if (rows.length > 40) lines.push(`…还有 ${rows.length - 40} 层，见结构化输出。`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const v = await pro('listLayers', { ...args })
        return {
          comp: v.comp ?? {}, layerCount: Number(v.layerCount ?? 0),
          returned: Number(v.returned ?? 0), layers: v.layers ?? [], error: '',
        }
      } catch (error) {
        return { comp: {}, layerCount: 0, returned: 0, layers: [], error: formatError(error) }
      }
    },
  }))

  /* -------------------------------------------------------- ae_query */

  register(defineTool({
    name: 'ae_query',
    description: [
      '读取图层上任意属性的真实值，支持按 matchName 点路径深入嵌套组。',
      'path 例：ADBE Transform Group.ADBE Position；也可用 propertyIndex 数字段。',
      '给 time 时读该时刻的值；有 keyframes 时一并返回全部关键帧与时间点。',
      '**customValue=true 的属性是 CUSTOM_VALUE 黑盒，只读不返回原值**。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      ...layerSpecParams,
      path: { type: 'string', required: true, description: '属性点路径（matchName 链），如 ADBE Transform Group.ADBE Position。' },
      time: { type: 'number', description: '读取该时刻（秒）的值。省略读当前值。' },
      maxKeys: { type: 'number', description: '最多返回多少关键帧，默认 200。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: {}, property: {}, propertyType: { type: 'string' }, valueType: { type: 'string' },
          customValue: { type: 'boolean' }, canSetExpression: { type: 'boolean' },
          isTimeVarying: { type: 'boolean' }, numKeys: { type: 'number' },
          value: {}, keyframes: {}, note: { type: 'string' }, error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const lines = [
          `**${value.layer?.name}** → \`${value.property?.matchName}\`（${value.valueType}）`,
        ]
        if (value.customValue) {
          lines.push('', '⚠️ CUSTOM_VALUE 二进制黑盒，无法读取原值，也无法写入。')
        } else {
          lines.push('', `值：\`${JSON.stringify(value.value)}\``)
        }
        if (value.numKeys > 0) {
          const k = Array.isArray(value.keyframes) ? value.keyframes : []
          lines.push('', `关键帧 ${value.numKeys} 个：`)
          for (const f of k.slice(0, 20)) lines.push(`  ${f.time}s → ${JSON.stringify(f.value)}`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const v = await pro('readProperty', { ...args })
        return {
          layer: v.layer ?? {}, property: v.property ?? {},
          propertyType: String(v.propertyType ?? ''), valueType: String(v.valueType ?? ''),
          customValue: v.customValue === true, canSetExpression: v.canSetExpression === true,
          isTimeVarying: v.isTimeVarying === true, numKeys: Number(v.numKeys ?? 0),
          value: v.value ?? null, keyframes: v.keyframes ?? [], note: v.note ?? '', error: '',
        }
      } catch (error) {
        return { layer: {}, property: {}, propertyType: '', valueType: '', customValue: false,
          canSetExpression: false, isTimeVarying: false, numKeys: 0, value: null,
          keyframes: [], note: '', error: formatError(error) }
      }
    },
  }))

  /* ---------------------------------------------------------- ae_set */

  register(defineTool({
    name: 'ae_set',
    description: [
      '修改图层属性值，或给属性挂表达式。',
      '**拒绝写入 CUSTOM_VALUE** —— 那是第三方插件的二进制状态，赋值会静默损坏，工具会直接报错并提示用 .ffx 预设或改周边可读参数。',
      '给 expression 时挂表达式；表达式同样跑在 AE 的 ES3 引擎上，所以**发送前会做 ES3 预检**，现代语法会被拦下并指出行列。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      ...layerSpecParams,
      path: { type: 'string', required: true, description: '属性点路径（matchName 链）。' },
      value: { type: 'json', description: '要设置的值（数字/数组/颜色）。与 expression 二选一。' },
      expression: { type: 'string', description: '要挂的表达式（纯 ES3）。' },
      time: { type: 'number', description: '在此时刻设值（打关键帧）。省略则改静态值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: {}, property: {}, before: {}, after: {}, expression: { type: 'string' },
          atTime: { type: 'number' }, error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        if (value.expression) {
          return text(`已挂表达式到 **${value.layer?.name}** → \`${value.property?.matchName}\`\n\`\`\`\n${value.expression}\n\`\`\``)
        }
        return text([
          `已修改 **${value.layer?.name}** → \`${value.property?.matchName}\``,
          `  ${JSON.stringify(value.before)} → ${JSON.stringify(value.after)}`,
        ].join('\n'))
      },
    },
    async execute(args) {
      // An expression runs on the same ES3 engine as a script, so it gets the
      // same pre-flight. Without this a single `const` inside an expression
      // takes the whole property evaluation down.
      if (typeof args?.expression === 'string' && args.expression.trim() !== '') {
        try {
          assertEs3(args.expression, `ae_set expression on ${args.path}`)
        } catch (error) {
          return {
            layer: {}, property: {}, before: null, after: null,
            expression: '', atTime: -1, error: error.message,
          }
        }
      }
      try {
        const v = await pro('writeProperty', { ...args })
        return {
          layer: v.layer ?? {}, property: v.property ?? {},
          before: v.before ?? null, after: v.after ?? null,
          expression: String(v.expression ?? ''), atTime: Number(v.atTime ?? -1), error: '',
        }
      } catch (error) {
        return { layer: {}, property: {}, before: null, after: null, expression: '', atTime: -1, error: formatError(error) }
      }
    },
  }))

  /* ------------------------------------------------------ ae_animate */

  register(defineTool({
    name: 'ae_animate',
    description: [
      '给属性打关键帧并施加真实缓动 —— **默认线性是禁用的**，商业模板必须用曲线。',
      'ease: linear / in / out / both（默认）/ hold，或 0.1-100 的显式影响值。',
      '内部用 setTemporalEaseAtKey() 逐个关键帧设置，不是靠默认插值。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      ...layerSpecParams,
      path: { type: 'string', required: true, description: '属性点路径（matchName 链）。' },
      keys: { type: 'json', required: true, description: '关键帧数组 [{time, value}]，time 单位秒。' },
      ease: { type: 'string', description: '缓动类型：linear/in/out/both(默认)/hold，或数字影响值。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          layer: {}, property: {}, keys: { type: 'number' }, ease: { type: 'string' },
          easeApplied: { type: 'number' }, totalKeys: { type: 'number' }, error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        return text([
          `已为 **${value.layer?.name}** → \`${value.property?.matchName}\` 打 ${value.keys} 个关键帧`,
          `缓动：${value.ease}（已应用 ${value.easeApplied}/${value.keys}）`,
          `该属性现有 ${value.totalKeys} 个关键帧`,
        ].join('\n'))
      },
    },
    async execute(args) {
      try {
        const v = await pro('animateProperty', { ...args })
        return {
          layer: v.layer ?? {}, property: v.property ?? {},
          keys: Number(v.keys ?? 0), ease: String(v.ease ?? ''),
          easeApplied: Number(v.easeApplied ?? 0), totalKeys: Number(v.totalKeys ?? 0), error: '',
        }
      } catch (error) {
        return { layer: {}, property: {}, keys: 0, ease: '', easeApplied: 0, totalKeys: 0, error: formatError(error) }
      }
    },
  }))

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
      query: { type: 'string', description: '按显示名/matchName/分类/厂商模糊过滤，如 "glow"、"Particular"。' },
      includeObsolete: { type: 'boolean', description: '是否包含 AE 标记为已废弃的特效。默认 false。' },
      limit: { type: 'number', description: '最多返回多少条，默认不限制。' },
      refresh: { type: 'boolean', description: '强制重新扫描并刷新本地缓存。默认 false（优先用缓存）。' },
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
          cache: { type: 'string' },
          cacheAgeMs: { type: 'number' },
          cacheStale: { type: 'boolean' },
          cachePath: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const rows = Array.isArray(value.effects) ? value.effects : []
        const vendorLabel = (v) => (v === 'adobe' ? 'AE' : v === 'third-party' ? '第三方' : '未知')
        const lines = [
          `已安装特效 **${value.total}** 个，返回 ${value.returned} 条（第三方 ${value.thirdPartyCount} 个）` +
            (value.skippedObsolete > 0 ? `，跳过废弃 ${value.skippedObsolete} 个` : ''),
        ]
        if (value.cache === 'hit') {
          lines.push(`（缓存命中${value.cacheStale ? '，已过期建议 refresh' : ''}：${value.cachePath}）`)
        } else if (value.cache === 'refreshed') {
          lines.push(`（已重新扫描并写入缓存：${value.cachePath}）`)
        }
        if (rows.length > 0) {
          lines.push('')
          lines.push('| matchName | 显示名 | 厂商 | 分类 |')
          lines.push('| --- | --- | --- | --- |')
          for (const r of rows.slice(0, 60)) {
            lines.push(`| \`${r.matchName}\` | ${r.displayName} | ${vendorLabel(r.vendor)} | ${r.category || ''} |`)
          }
          if (rows.length > 60) lines.push(`…还有 ${rows.length - 60} 条，见结构化输出。`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const workDir = bridge.root
        const forceRefresh = args.refresh === true

        // A cache hit avoids an AE round-trip; a miss or a forced refresh scans.
        // The cache is keyed to the AE version, so an entry from another install
        // is never served as current.
        let aeVersion = null
        try {
          const env = await pro('capabilities', {})
          aeVersion = String(env?.aeVersion ?? '')
        } catch {
          aeVersion = null
        }

        if (!forceRefresh && aeVersion !== null) {
          const cached = readCache(workDir, { aeVersion })
          if (cached.ok) {
            const rows = cached.record.effects.map((e) => ({
              ...e,
              vendor: e.vendor ?? classifyVendor(e.matchName, e.category),
            }))
            const filtered = filterEffects(rows, args)
            return {
              total: rows.length,
              returned: filtered.rows.length,
              skippedObsolete: filtered.skippedObsolete,
              thirdPartyCount: rows.filter((e) => e.vendor === 'third-party').length,
              query: args.query ?? null,
              effects: filtered.rows,
              cache: 'hit',
              cacheAgeMs: cached.ageMs,
              cacheStale: cached.stale === true,
              cachePath: cached.path,
              error: '',
            }
          }
        }

        const value = await pro('scanEffects', {
          query: args.query,
          includeObsolete: args.includeObsolete === true,
          limit: args.limit,
        })

        // Vendor is decided here, where the classification table lives. Unknown
        // stays unknown: an effect with no recognisable prefix or category is
        // not asserted to be third-party.
        const rows = (value.effects ?? []).map((e) => ({
          ...e,
          vendor: classifyVendor(e.matchName, e.category),
          thirdParty: classifyVendor(e.matchName, e.category) === 'third-party',
        }))

        const written = writeCache(workDir, {
          aeVersion: aeVersion ?? 'unknown',
          scannedAt: Date.now(),
          effects: rows.map((e) => ({
            index: e.index, displayName: e.displayName, matchName: e.matchName,
            category: e.category, version: e.version, obsolete: e.obsolete,
            vendor: e.vendor, thirdParty: e.thirdParty,
          })),
        })

        return {
          total: Number(value.total ?? rows.length),
          returned: rows.length,
          skippedObsolete: Number(value.skippedObsolete ?? 0),
          thirdPartyCount: rows.filter((e) => e.vendor === 'third-party').length,
          query: value.query ?? null,
          effects: rows,
          cache: written.ok ? 'refreshed' : 'unavailable',
          cacheAgeMs: 0,
          cacheStale: false,
          cachePath: written.path ?? '',
          error: '',
        }
      } catch (error) {
        return {
          total: 0, returned: 0, skippedObsolete: 0, thirdPartyCount: 0, query: null,
          effects: [], cache: 'unavailable', cacheAgeMs: 0, cacheStale: false, cachePath: '',
          error: formatError(error),
        }
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
      maxDepth: { type: 'number', description: '递归深度上限，默认 8，最大 12。' },
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
          maxDepth: { type: 'number' },
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
          if (p.customValue) val = '**CUSTOM_VALUE — 不可读不可写**'
          else if (p.menuItems) val = (p.menuItems.map((m) => m.name).join(' / ') || '').slice(0, 60)
          else if (p.value !== undefined) val = JSON.stringify(p.value).slice(0, 60)
          else val = ''
          lines.push(`| ${p.propertyIndex} | ${p.name} | \`${p.matchName}\` | ${p.valueType} | ${val} |`)
        }
        if (params.length > 40) lines.push(`…还有 ${params.length - 40} 个参数，见结构化输出。`)
        lines.push('', '写参数用 `ae_set`，路径传完整 matchName 链（如 `ADBE Effect Parade.1.ADBE Glo2-0003`）或属性自身的 matchName。')
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
          maxDepth: Number(value.maxDepth ?? 8),
          warning: value.warning ?? '',
          parameters: value.parameters ?? [],
          error: '',
        }
      } catch (error) {
        return { layer: {}, effect: {}, parameterCount: 0, customValueCount: 0, maxDepth: 8, warning: '', parameters: [], error: formatError(error) }
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
      '渲染帧到 PNG 供视觉自检：文字溢出、字幕框边界、辉光过曝、粒子穿帮。',
      'longEdge 降采样（如 640）省 context；soloLayerId 隔离单层，专治「这层为什么看不见」；原尺寸用 longEdge=0，'
        + '原 Solo 与 Resolution Factor 都会自动恢复。',
      'count>1 时按区间采样多帧并**自动合成一张 Contact Sheet**（多帧判断运动比 N 张图省得多）。',
      '',
      '**重要**：返回的是文件**路径**，图像本身不会进入你的视觉上下文。'
        + '要真正看到画面，必须再调用 `read_image`（传 path）。没调 `read_image` 就不要声称看过画面。',
      '只有在 DSH 确实支持图像内容回传时才会内联图像；本插件运行在工具结果只带文本的通道上，所以如实返回 `imageInContext: false`。',
    ].join('\n'),
    timeoutMs: 600_000,
    parameters: {
      comp: { type: 'string', description: '合成名。省略用最新的合成。' },
      compId: { type: 'number', description: '合成 id。' },
      output: { type: 'string', description: '单帧 PNG 的绝对路径（count<=1 时必填）。' },
      outputDir: { type: 'string', description: '多帧序列输出目录（count>1 时必填）。' },
      time: { type: 'number', description: '采样时间（秒）。默认当前时间。' },
      longEdge: { type: 'number', description: '长边目标像素，如 640；0 表示原始分辨率。' },
      soloLayerId: { type: 'number', description: '只渲染这一层（隔离排查用）。' },
      count: { type: 'number', description: '采样帧数，>1 时走序列模式并合成 Contact Sheet。默认 1。' },
      startTime: { type: 'number', description: '序列起始时间。' },
      endTime: { type: 'number', description: '序列结束时间。' },
      sheetOutput: { type: 'string', description: 'Contact Sheet 输出路径。省略则为 outputDir/contact-sheet.png。' },
      columns: { type: 'number', description: 'Contact Sheet 列数。省略按平方根自动排。' },
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
          sheet: {},
          imageInContext: { type: 'boolean' },
          hint: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)

        const hint = value.hint ? ['', value.hint] : []

        if (Array.isArray(value.frames) && value.frames.length > 0) {
          const lines = [`已渲染 ${value.count} 帧并合成 Contact Sheet`]
          const sheet = value.sheet ?? {}
          if (sheet.path) {
            lines.push(`拼图：\`${sheet.path}\`（${sheet.width}x${sheet.height}，${sheet.columns}x${sheet.rows} 格）`)
          }
          for (const f of value.frames) lines.push(`  ${f.time}s → \`${f.path}\``)
          return text([...lines, ...hint].join('\n'))
        }

        const lines = [
          `预览已渲染：\`${value.path}\``,
          `${value.width}x${value.height} · t=${value.time}s · ${Math.round((value.bytes ?? 0) / 1024)} KB`,
        ]
        if (value.isolatedLayer) lines.push(`（已隔离图层：${value.isolatedLayer.name}）`)
        return text([...lines, ...hint].join('\n'))
      },
    },
    async execute(args) {
      const IMAGE_HINT = '图像未内联进视觉上下文。调用 read_image({ file_path: "<上面的路径>" }) 才能真正检查画面。'

      try {
        const count = Number(args.count ?? 1)

        if (count > 1) {
          const value = await pro('captureSequence', { ...args })
          const frames = value.frames ?? []

          // Composite the frames into one sheet: N images to read is a much
          // larger cost than one, and a sheet shows motion in a single glance.
          let sheet = null
          try {
            const loaded = frames
              .filter((f) => existsSync(f.path))
              .map((f) => ({ path: f.path, time: Number(f.time ?? 0), buffer: readFileSync(f.path) }))
            if (loaded.length > 0) {
              const built = buildContactSheet(loaded, {
                columns: args.columns ? Number(args.columns) : undefined,
              })
              const target = typeof args.sheetOutput === 'string' && args.sheetOutput.trim() !== ''
                ? args.sheetOutput.trim()
                : join(String(args.outputDir ?? '.'), 'contact-sheet.png')
              writeFileSync(target, built.png)
              sheet = {
                path: target,
                width: built.width,
                height: built.height,
                columns: built.columns,
                rows: built.rows,
                bytes: built.png.length,
                frameTimes: built.frameTimes,
              }
            }
          } catch (error) {
            // A failed composite must not lose the frames that were captured.
            sheet = null
            const hintExtra = `Contact Sheet 合成失败：${error instanceof PngError ? `${error.code} ${error.message}` : error.message}`
            return {
              path: '', comp: value.comp ?? '', time: 0, width: 0, height: 0, bytes: 0,
              isolatedLayer: null, frames, count: Number(value.count ?? 0), sheet,
              imageInContext: false, hint: `${hintExtra}\n${IMAGE_HINT}`, error: '',
            }
          }

          return {
            path: '', comp: value.comp ?? '', time: 0, width: 0, height: 0, bytes: 0,
            isolatedLayer: null, frames, count: Number(value.count ?? 0), sheet,
            imageInContext: false, hint: IMAGE_HINT, error: '',
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
          frames: [], count: 1, sheet: null,
          imageInContext: false, hint: IMAGE_HINT, error: '',
        }
      } catch (error) {
        return {
          path: '', comp: {}, time: 0, width: 0, height: 0, bytes: 0, isolatedLayer: null,
          frames: [], count: 0, sheet: null, imageInContext: false, hint: '', error: formatError(error),
        }
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
      '从音频素材的 **原始波形** 检测瞬态峰值，并自动在时间轴打 Marker —— 节奏卡点模板的基础。',
      '流程：AE 读取音频图层的源文件路径与时间映射 → Node 直接解析 WAV PCM 采样 → RMS/瞬态检测 → 换算成合成时间 → 写回 Marker。',
      '**不是** 逐帧读 ADBE Audio Levels 那种电平表：那看不到帧间信号，也分不清持续响度与真正重拍。',
      '支持 8/16/24/32-bit 整数 PCM 与 32/64-bit 浮点 WAV；多声道取绝对值最大的声道。',
      'sensitivity 越大越挑剔；threshold 是绝对下限；minGapMs 控制最小间隔；maxMarkers 上限。',
      '默认打在合成 Marker 上，onComp=false 改打图层 Marker；默认不删除已有 Marker。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      ...layerSpecParams,
      sensitivity: { type: 'number', description: '相对平均 RMS 的倍数，越大越挑剔。默认 1.4。' },
      threshold: { type: 'number', description: '绝对振幅下限 0-1，默认 0.05。' },
      minGapMs: { type: 'number', description: '两个 Marker 的最小间隔（毫秒），默认 180。' },
      maxMarkers: { type: 'number', description: '最多打几个，默认 120。' },
      windowMs: { type: 'number', description: '分析窗口大小（毫秒），默认 20。' },
      onComp: { type: 'boolean', description: 'true 打合成 Marker（默认），false 打图层 Marker。' },
      clearExisting: { type: 'boolean', description: '打之前是否清空已有 Marker。默认 false。' },
      includeWaveform: { type: 'boolean', description: '是否在结果里带上波形包络（供检查）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          source: { type: 'string' },
          format: {},
          duration: { type: 'number' },
          silent: { type: 'boolean' },
          peaksFound: { type: 'number' },
          markersPlaced: { type: 'number' },
          markerTarget: { type: 'string' },
          stats: {},
          times: {},
          waveform: {},
          skipped: {},
          error: { type: 'string' },
          code: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(`${value.error}${value.code ? `\ncode: ${value.code}` : ''}`)
        const f = value.format ?? {}
        const lines = [
          `音频源：\`${value.source}\``,
          `${f.encoding ?? '?'} ${f.bitsPerSample ?? '?'}-bit · ${f.channels ?? '?'} 声道 · ${f.sampleRate ?? '?'} Hz · ${value.duration}s`,
        ]
        if (value.silent) {
          lines.push('', '这条音轨全静音（所有采样为 0），没有写入任何 Marker。')
          return text(lines.join('\n'))
        }
        lines.push('', `检出 ${value.peaksFound} 个瞬态峰值，写入 ${value.markersPlaced} 个 Marker（${value.markerTarget}）`)
        const times = Array.isArray(value.times) ? value.times : []
        if (times.length > 0) lines.push(`时间点：${times.slice(0, 40).join(', ')}${times.length > 40 ? ' …' : ''}`)
        const skipped = Array.isArray(value.skipped) ? value.skipped : []
        if (skipped.length > 0) lines.push(`（${skipped.length} 个峰值落在图层范围外，已跳过）`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const empty = {
        source: '', format: {}, duration: 0, silent: false, peaksFound: 0, markersPlaced: 0,
        markerTarget: '', stats: {}, times: [], waveform: [], skipped: [], error: '', code: '',
      }
      try {
        // 1. Ask AE where the audio comes from and how its time maps.
        const info = await pro('audioSource', { ...args })
        if (!info || !info.sourcePath) {
          return { ...empty, error: 'this layer has no file source; only footage-backed audio can be analysed', code: 'NO_SOURCE' }
        }
        if (!existsSync(info.sourcePath)) {
          return { ...empty, source: info.sourcePath, error: `audio source file not found: ${info.sourcePath}`, code: 'SOURCE_MISSING' }
        }
        const ext = String(info.sourcePath).toLowerCase()
        if (!ext.endsWith('.wav')) {
          return {
            ...empty, source: info.sourcePath,
            error: `only WAV is analysed natively (this file is ${ext.split('.').pop()}). `
              + 'Convert it to WAV (PCM), or point the tool at a WAV copy of the same audio.',
            code: 'UNSUPPORTED_CONTAINER',
          }
        }

        // 2. Read and analyse the samples in Node — the real waveform.
        const buf = readFileSync(info.sourcePath)
        const analysis = analyzeWav(buf, {
          sensitivity: args?.sensitivity,
          threshold: args?.threshold,
          minGapMs: args?.minGapMs,
          maxPeaks: args?.maxMarkers,
          windowMs: args?.windowMs,
          includeWaveform: args?.includeWaveform === true,
        })

        if (analysis.silent || analysis.peaks.length === 0) {
          return {
            ...empty,
            source: info.sourcePath,
            format: analysis.format,
            duration: analysis.duration,
            silent: analysis.silent,
            stats: analysis.stats,
            waveform: analysis.waveform ?? [],
            error: '',
          }
        }

        // 3. Map source time onto comp time, dropping anything the layer does
        //    not actually cover.
        const mapping = info.timeMapping ?? {}
        const inPoint = Number(mapping.inPoint ?? 0)
        const outPoint = Number(mapping.outPoint ?? (inPoint + Number(mapping.duration ?? 0)))
        const startTime = Number(mapping.startTime ?? 0)
        const stretch = Number(mapping.stretch ?? 100) || 100
        const scale = 100 / stretch

        const compTimes = []
        const skipped = []
        for (const peak of analysis.peaks) {
          const t = startTime + peak.time * scale
          if (t < inPoint - 1e-6 || t > outPoint + 1e-6) {
            skipped.push({ sourceTime: peak.time, compTime: Math.round(t * 10000) / 10000 })
            continue
          }
          compTimes.push(Math.round(t * 10000) / 10000)
        }

        // 4. Write the markers back through the existing bridge.
        let placed = 0
        if (compTimes.length > 0) {
          const w = await pro('writeMarkers', {
            ...args,
            times: compTimes,
            onComp: args?.onComp !== false,
            clearExisting: args?.clearExisting === true,
          })
          placed = Number(w?.placed ?? 0)
        }

        return {
          source: info.sourcePath,
          format: analysis.format,
          duration: analysis.duration,
          silent: false,
          peaksFound: analysis.peaks.length,
          markersPlaced: placed,
          markerTarget: args?.onComp === false ? 'layer' : 'comp',
          stats: analysis.stats,
          times: compTimes,
          waveform: analysis.waveform ?? [],
          skipped,
          error: '',
          code: '',
        }
      } catch (error) {
        if (error instanceof WavError) {
          return { ...empty, error: error.message, code: error.code }
        }
        return { ...empty, error: formatError(error), code: 'ANALYSIS_FAILED' }
      }
    },
  }))

  /* ------------------------------------------------ ae_auto_fit_text */

  register(defineTool({
    name: 'ae_auto_fit_text',
    description: [
      '让背景矩形自动跟随文字图层的真实字形边界 —— 商业模板字幕框的正确做法。',
      '用 `sourceRectAtTime()` 量文字，再通过 `toComp`/`fromComp` 把边界换算到形状图层的坐标空间，'
        + '同时考虑 Anchor Point、Position、Scale 与 Rotation。',
      'mode=background（默认，需给 shapeLayerId/Name）：把 Rect Size 与 Position 都挂上表达式；'
        + 'mode=text：只把文字图层的 Anchor 改成随字形居中，供其他表达式引用。',
      'paddingX/paddingY 分别控制横纵留白。文字为空或没有字形时**不做任何修改**并说明原因。',
      '这不是写死宽高——表达式每帧重新量，改文案、改字号、中英混排都会自动适应。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      comp: { type: 'string', description: '合成名。省略则用最新的合成。' },
      compId: { type: 'number', description: '合成 id。' },
      textLayerId: { type: 'number', description: '文字图层 id（推荐）。' },
      textLayerName: { type: 'string', description: '文字图层名。' },
      textLayerIndex: { type: 'number', description: '文字图层序号。' },
      shapeLayerId: { type: 'number', description: '背景形状图层 id（background 模式必需）。' },
      shapeLayerName: { type: 'string', description: '背景形状图层名。' },
      paddingX: { type: 'number', description: '水平留白，默认 24。' },
      paddingY: { type: 'number', description: '垂直留白，默认 24。' },
      time: { type: 'number', description: '测量时刻（秒）。省略用当前时间。' },
      mode: { type: 'string', description: 'background（默认）或 text。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          applied: { type: 'boolean' },
          mode: { type: 'string' },
          comp: {}, textLayer: {}, shapeLayer: {},
          padding: {}, bounds: {}, expected: {},
          expressions: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const b = value.bounds ?? {}
        const lines = [
          `模式 ${value.mode} · 文字层 **${value.textLayer?.name}**`,
          `实测字形边界 ${b.width}×${b.height}（left ${b.left}, top ${b.top}）`,
          `留白 ${value.padding?.x}/${value.padding?.y}`,
        ]
        if (value.expected) lines.push(`期望矩形 ${value.expected.width}×${value.expected.height}`)
        if (value.shapeLayer) lines.push(`已挂表达式到形状层 **${value.shapeLayer.name}**`)
        else lines.push('已把 Anchor 改成随字形居中')
        lines.push('', '表达式每帧重新测量，改文案/字号/中英混排都会自动适应。')
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      try {
        const v = await pro('autoFitText', { ...args })
        return {
          applied: v.applied === true,
          mode: String(v.mode ?? ''),
          comp: v.comp ?? {}, textLayer: v.textLayer ?? {}, shapeLayer: v.shapeLayer ?? {},
          padding: v.padding ?? {}, bounds: v.bounds ?? {}, expected: v.expected ?? {},
          expressions: v.expressions ?? {},
          error: v.error ?? '',
        }
      } catch (error) {
        return { applied: false, mode: '', comp: {}, textLayer: {}, shapeLayer: {}, padding: {},
          bounds: {}, expected: {}, expressions: {}, error: formatError(error) }
      }
    },
  }))

  /* ------------------------------------------------- ae_checkpoint */

  register(defineTool({
    name: 'ae_checkpoint',
    description: [
      '创建并**验证**一份带时间戳的工程备份。破坏性操作前必须调用。',
      '流程：确认工程已保存 → 原地 save → 复制副本 → 校验文件存在、字节数合理、.aep 签名正确、记录 SHA-256。',
      '先原地保存再复制，所以打开中的工程仍指向用户原来的文件，不会被改道；绝不覆盖用户原工程。',
      '未命名工程无法备份，返回 checkpoint_unavailable 并拒绝：高风险操作会被程序级门禁挡住。',
      'action=list 列出既有检查点并逐个校验完整性；action=restore 前会先自动再备份一次。',
    ].join('\n'),
    timeoutMs: 300_000,
    parameters: {
      action: { type: 'string', description: 'create（默认）/ list / restore。' },
      dir: { type: 'string', description: '备份目录。省略则为工程同级的 dsh-checkpoints。' },
      label: { type: 'string', description: '备份标签，如 before-bulk-relayout。' },
      keep: { type: 'number', description: '保留份数，默认 20。' },
      checkpoint: { type: 'string', description: 'action=restore 时要恢复的备份绝对路径。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          skipped: { type: 'boolean' },
          reason: { type: 'string' },
          hint: { type: 'string' },
          source: { type: 'string' },
          checkpoint: { type: 'string' },
          bytes: { type: 'number' },
          verified: { type: 'boolean' },
          hash: { type: 'string' },
          pruned: {},
          checkpoints: {},
          dir: { type: 'string' },
          restored: { type: 'boolean' },
          safetyBackup: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)

        if (value.action === 'list') {
          const list = Array.isArray(value.checkpoints) ? value.checkpoints : []
          if (list.length === 0) return text(`没有检查点。目录：\`${value.dir}\``)
          const lines = [`检查点 ${list.length} 个（\`${value.dir}\`）`]
          for (const c of list.slice(0, 20)) {
            const when = c.createdAt ? new Date(c.createdAt).toISOString().replace('T', ' ').slice(0, 19) : '?'
            lines.push(`  ${c.verified ? '✓' : '✗'} ${c.name}  ${Math.round(c.bytes / 1024)} KB  ${when}${c.label ? `  [${c.label}]` : ''}`)
            if (!c.verified) lines.push(`      失效：${c.reason}`)
          }
          if (list.length > 20) lines.push(`…还有 ${list.length - 20} 个`)
          return text(lines.join('\n'))
        }

        if (value.skipped) {
          return text(`未创建备份：${value.reason}\n${value.hint ?? ''}`)
        }

        if (value.action === 'restore') {
          const lines = [
            value.restored ? `已恢复到：\`${value.checkpoint}\`` : `恢复失败：${value.reason || 'unknown'}`,
          ]
          if (value.safetyBackup) lines.push(`恢复前的安全备份：\`${value.safetyBackup}\``)
          return text(lines.join('\n'))
        }

        const lines = [
          `已创建备份并通过校验：\`${value.checkpoint}\``,
          `${Math.round((value.bytes ?? 0) / 1024)} KB · sha256 ${String(value.hash ?? '').slice(0, 12)}…`,
          `源工程 ${value.source}`,
        ]
        const pruned = Array.isArray(value.pruned) ? value.pruned : []
        if (pruned.length > 0) lines.push(`已清理旧备份 ${pruned.length} 个`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const empty = {
        ok: false, action: String(args?.action ?? 'create'), skipped: false, reason: '', hint: '',
        source: '', checkpoint: '', bytes: 0, verified: false, hash: '', pruned: [],
        checkpoints: [], dir: '', restored: false, safetyBackup: '', error: '',
      }
      const action = String(args?.action ?? 'create').toLowerCase()

      try {
        // The AE side owns the file creation; Node owns verification.
        const created = await pro('checkpoint', {
          dir: args?.dir,
          label: args?.label,
          keep: args?.keep,
        })

        if (created?.skipped) {
          return {
            ...empty,
            skipped: true,
            reason: String(created.reason ?? 'untitled-project'),
            hint: String(created.hint ?? ''),
          }
        }

        const dir = String(created?.dir ?? '')
        const path = String(created?.checkpoint ?? '')

        if (action === 'list') {
          const listed = listCheckpoints(created?.source ?? null, args?.dir ?? dir)
          return { ...empty, ok: true, action: 'list', dir: listed.dir ?? dir, checkpoints: listed.checkpoints }
        }

        if (action === 'restore') {
          const target = String(args?.checkpoint ?? '')
          if (!target) return { ...empty, action: 'restore', reason: 'checkpoint path is required' }

          const check = verifyCheckpoint(target)
          if (!check.ok) {
            return { ...empty, action: 'restore', reason: `checkpoint failed verification: ${check.reason}` }
          }
          // Never restore over an unbacked-up project.
          if (!created?.checkpoint) {
            return { ...empty, action: 'restore', reason: 'could not create a safety backup before restoring' }
          }
          const restored = await pro('restoreCheckpoint', { checkpoint: target })
          return {
            ...empty,
            ok: restored?.ok === true,
            action: 'restore',
            checkpoint: target,
            restored: restored?.ok === true,
            safetyBackup: String(created.checkpoint),
            reason: String(restored?.reason ?? ''),
          }
        }

        // create: verify the copy really is a project file
        const verified = verifyCheckpoint(path)
        if (!verified.ok) {
          return {
            ...empty,
            reason: `the copy exists but failed verification: ${verified.reason}`,
            checkpoint: path,
            dir,
            source: String(created?.source ?? ''),
            hint: 'the project was saved in place, but the copy is not a usable project. '
              + 'Do not run destructive operations until a verified checkpoint exists.',
          }
        }

        recordCheckpoint(dir, {
          path,
          label: String(args?.label ?? ''),
          createdAt: Date.now(),
          bytes: verified.bytes,
          hash: verified.hash,
        })
        const { pruned } = pruneCheckpoints(dir, Math.max(1, Number(args?.keep ?? 20)))

        return {
          ...empty,
          ok: true,
          action: 'create',
          source: String(created?.source ?? ''),
          checkpoint: path,
          dir,
          bytes: verified.bytes ?? 0,
          verified: true,
          hash: verified.hash ?? '',
          pruned,
        }
      } catch (error) {
        return { ...empty, action, error: formatError(error) }
      }
    },
  }))
}

export { formatError as formatProError }
