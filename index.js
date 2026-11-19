/**
 * dsh-aftereffects — Host half
 *
 * Registers four tools that drive Adobe After Effects through the bridge in
 * `lib/bridge.js`:
 *
 *   ae_status      — is After Effects installed, running, and what can it do
 *   ae_compose     — build a composition from a declarative scene spec
 *   ae_template    — build one from a built-in template
 *   ae_render      — render to MP4 / PNG / QuickTime, or a single still
 *
 * Every tool funnels into the same ExtendScript runtime, so anything the
 * runtime exposes is reachable from a `scene` document.
 *
 * @module dsh-aftereffects
 */

import { AeBridge, locate, locateAerender } from './lib/bridge.js'
import { ASPECT_NAMES, TEMPLATE_NAMES, THEME_NAMES, buildTemplate, templateCatalog } from './lib/templates.js'
import { assertEs3 } from './lib/es3-guard.js'
import { registerProTools } from './lib/pro-tools.js'
import { defineToolSafe } from './lib/tool-def.js'
import { assertSafeToProceed, listCheckpoints } from './lib/checkpoint.js'

/** Identity shown in the plugin inventory. */
export const name = 'dsh-aftereffects'

/** Services this plugin needs; without them it stays inactive. */
export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 205

/**
 * Tool definition builder.
 *
 * `@deepseek-ai/dsh-tools` does not resolve from a bundled plugin, so its
 * `defineTool` degrades to identity and the author DSL (`type: 'json'`,
 * per-property `required: true`) leaks to the gateway, which only understands
 * standard JSON Schema — that produced a 400 on every request. `defineToolSafe`
 * compiles the DSL here instead, with no host import at all.
 */
const defineTool = defineToolSafe

/* -------------------------------------------------------------------------- */
/* helpers                                                                    */
/* -------------------------------------------------------------------------- */

const text = (value) => [{ type: 'text', text: String(value) }]

function formatError(error) {
  const lines = [`After Effects 调用失败：${error.message}`]
  if (error.code) lines.push(`code: ${error.code}`)
  if (error.detail) lines.push(`detail: ${error.detail}`)
  if (typeof error.line === 'number' && error.line > 0) lines.push(`extendscript line: ${error.line}`)
  return lines.join('\n')
}

/** Compact one-line summary of a build result. */
function summarizeScene(result) {
  const lines = [
    `合成 **${result.comp}** ${result.width}x${result.height} · ${result.duration}s @ ${result.frameRate}fps · ${result.layerCount} 层`,
  ]
  const failed = (result.layers ?? []).filter((l) => l.error)
  for (const layer of failed) lines.push(`  ✗ ${layer.spec ?? '?'} — ${layer.error}`)
  if (failed.length === 0) {
    const names = (result.layers ?? []).map((l) => l.name).filter(Boolean)
    if (names.length > 0) {
      lines.push(`  层：${names.slice(0, 12).join('、')}${names.length > 12 ? ` …共 ${names.length} 层` : ''}`)
    }
  }
  return lines.join('\n')
}

function summarizeRender(result) {
  if (result.still === true) {
    return `静帧已导出：${result.file.path}（${Math.round(result.file.size / 1024)} KB，t=${result.time}s）`
  }
  const head = `渲染完成：${result.comp} → ${result.format.toUpperCase()}`
  if (result.file) {
    return `${head}\n文件：${result.file.path}\n大小：${Math.round(result.file.size / 1024)} KB\n耗时：${(result.ms / 1000).toFixed(1)}s`
  }
  return `${head}\n帧序列：${result.dir}（${result.frames} 帧）\n耗时：${(result.ms / 1000).toFixed(1)}s`
}

const EMPTY_SCENE = {
  comp: '', id: 0, width: 0, height: 0, duration: 0, frameRate: 0, layerCount: 0, layers: [], saved: '',
}

/**
 * Find the newest verified checkpoint for a project.
 *
 * The gate needs a file it can trust, so this reads the checkpoint directory
 * and verifies each candidate rather than trusting a name.
 */
async function lastVerifiedCheckpoint(bridge, serial, projectPath) {
  if (!projectPath) return null
  try {
    const status = await serial(() => bridge.runtime('pro:projectStatus', {}))
    const dir = status?.checkpointDir ?? null
    const listed = listCheckpoints(projectPath, dir ?? undefined)
    const newest = listed.checkpoints.find((c) => c.verified)
    return newest ? { path: newest.path, verified: true } : null
  } catch {
    return null
  }
}

/* -------------------------------------------------------------------------- */
/* plugin                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const settings = config ?? {}
  if (settings.enabled === false) return

  const bridge = new AeBridge({
    executable: settings.executable,
    workDir: settings.workDir,
    launchTimeoutMs: settings.launchTimeoutMs,
    jobTimeoutMs: settings.jobTimeoutMs,
    keepAliveMs: settings.keepAliveMs,
  })

  /** Serialise every AE call: After Effects is single-threaded. */
  let queue = Promise.resolve()
  const serial = (task) => {
    const run = queue.then(task, task)
    queue = run.then(() => undefined, () => undefined)
    return run
  }

  const disposers = []
  const register = (definition) => {
    if (typeof ctx.tools?.register !== 'function') return
    disposers.push(ctx.tools.register(defineTool(definition)))
  }

  /* ------------------------------------------------------------ ae_status */

  register({
    name: 'ae_status',
    description: [
      '检查 Adobe After Effects 是否可用，并列出它能做什么。',
      '返回：安装路径、是否已启动无界面实例、AE 版本、可用渲染模板、内置模板与主题列表。',
      '在调用 ae_compose / ae_template / ae_render 之前用它确认环境；也可用来在出错后诊断。',
      'action="start" 会主动启动无界面 After Effects（首次启动约 10-20 秒）。',
    ].join('\n'),
    timeoutMs: 180_000,
    parameters: {
      action: {
        type: 'string',
        description: 'status（默认，只读检查）/ start（启动 AE）/ stop（关闭 AE 实例）',
        enum: ['status', 'start', 'stop'],
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          installed: { type: 'boolean' },
          executable: { type: 'string' },
          aerender: { type: 'string' },
          running: { type: 'boolean' },
          state: { type: 'string' },
          version: { type: 'string' },
          locale: { type: 'string' },
          workDir: { type: 'string' },
          templates: {},
          builtinTemplates: {},
          themes: {},
          aspects: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(`After Effects 状态检查失败：${value.error}`)
        const lines = [value.installed ? `✅ 已安装：${value.executable}` : '❌ 未找到 After Effects']
        if (value.aerender) lines.push(`aerender：${value.aerender}`)
        lines.push(value.running ? `▶ 无界面实例运行中（${value.state}）` : `⏹ 未运行（${value.state}）`)
        if (value.version) lines.push(`AE ${value.version} · ${value.locale}`)
        lines.push(`工作目录：${value.workDir}`)
        if (Array.isArray(value.builtinTemplates) && value.builtinTemplates.length > 0) {
          lines.push('', '内置模板：')
          for (const t of value.builtinTemplates) lines.push(`  • ${t.name} — ${t.summary}`)
        }
        if (Array.isArray(value.themes)) lines.push('', `主题：${value.themes.join(' / ')}`)
        if (Array.isArray(value.aspects)) lines.push(`画幅：${value.aspects.join(' / ')}`)
        if (Array.isArray(value.templates) && value.templates.length > 0) {
          lines.push('', `AE 输出模板（${value.templates.length}）：${value.templates.slice(0, 8).join(' / ')}…`)
        }
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const action = (args?.action ?? 'status').trim().toLowerCase()
      const executable = locate(settings.executable)
      const base = {
        installed: executable !== null,
        executable: executable ?? '',
        aerender: locateAerender(settings.executable) ?? '',
        workDir: bridge.root,
        builtinTemplates: templateCatalog(),
        themes: THEME_NAMES,
        aspects: ASPECT_NAMES,
      }

      if (action === 'stop') {
        await bridge.stop()
        return { ...base, running: false, state: '已停止', templates: [] }
      }

      if (executable === null) {
        return { ...base, running: false, state: '未安装', error: '', templates: [] }
      }

      if (action === 'start') {
        try {
          await bridge.ensure()
        } catch (error) {
          return { ...base, running: false, state: '启动失败', error: formatError(error), templates: [] }
        }
      }

      if (!bridge.isAlive()) {
        return { ...base, running: false, state: '未运行', templates: [] }
      }

      try {
        const env = await serial(() => bridge.runtime('environment', {}))
        return {
          ...base,
          running: true,
          state: '运行中',
          version: String(env.version ?? ''),
          locale: String(env.locale ?? ''),
          templates: Array.isArray(env.templates) ? env.templates : [],
        }
      } catch (error) {
        return { ...base, running: false, state: '无响应', error: formatError(error), templates: [] }
      }
    },
  })

  /* ----------------------------------------------------------- ae_compose */

  register({
    name: 'ae_compose',
    description: [
      '在 After Effects 里按声明式场景文档创建一个合成（composition）。',
      'scene 是一份 JSON：{ name, width, height, fps, duration, background, layers: [...] }。',
      '层类型：text（文字，支持 charReveal 逐字显现、typewriter 打字机）、shape（rect/ellipse/path，支持 trim 描边动画）、solid（纯色）、null（控制器）、footage（导入图片/视频）、precomp（嵌入另一个合成）。',
      '每个层都能带 x/y/scale/rotation/opacity/anchor，以及 animate 数组做关键帧：{ property, from, to, start, end, ease }，property 可取 opacity、scale、position、position.x、rotation、anchor，或 effect:<效果名>:<参数名>。ease 可取 linear、in、out、both、hold。',
      'effects 数组给层加特效，例如 { name: "glow", radius: 40, intensity: 1.5 }；可用效果见 ae_status 的说明或模板源码。',
      '只会新建或替换同名合成，不会清空项目——除非 scene.resetProject 为 true。',
    ].join('\n'),
    timeoutMs: 600_000,
    parameters: {
      scene: {
        type: 'json',
        required: true,
        description: '场景文档。至少给 layers；name/width/height/fps/duration 有默认值（Comp / 1920 / 1080 / 30 / 8）。',
      },
      save: {
        type: 'string',
        description: '可选。合成建好后把项目另存到这个 .aep 绝对路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          comp: { type: 'string' },
          id: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          duration: { type: 'number' },
          frameRate: { type: 'number' },
          layerCount: { type: 'number' },
          layers: {},
          saved: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const lines = [summarizeScene(value)]
        if (value.saved) lines.push(`项目已保存：${value.saved}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const scene = args?.scene
      if (scene === null || typeof scene !== 'object' || Array.isArray(scene)) {
        return { ...EMPTY_SCENE, error: 'scene 必须是对象' }
      }

      // Program-level gate, not a prompt suggestion: resetProject wipes the
      // whole project, so it needs a verified checkpoint first.
      if (scene.resetProject === true) {
        try {
          const gate = await serial(() => bridge.runtime('pro:projectStatus', {}))
          assertSafeToProceed({
            operation: 'resetProject',
            projectPath: gate?.file ?? null,
            lastCheckpoint: await lastVerifiedCheckpoint(bridge, serial, gate?.file ?? null),
            context: { compCount: gate?.compCount ?? undefined },
          })
        } catch (error) {
          return { ...EMPTY_SCENE, error: error.message }
        }
      }

      try {
        const built = await serial(() => bridge.runtime('buildScene', scene))
        let saved = ''
        if (typeof args.save === 'string' && args.save.trim() !== '') {
          const info = await serial(() => bridge.runtime('saveProject', { path: args.save.trim() }))
          saved = info.path
        }
        return {
          comp: String(built.comp ?? ''),
          id: Number(built.id ?? 0),
          width: Number(built.width ?? 0),
          height: Number(built.height ?? 0),
          duration: Number(built.duration ?? 0),
          frameRate: Number(built.frameRate ?? 0),
          layerCount: Number(built.layerCount ?? 0),
          layers: built.layers ?? [],
          saved,
          error: '',
        }
      } catch (error) {
        return { ...EMPTY_SCENE, error: formatError(error) }
      }
    },
  })

  /* ---------------------------------------------------------- ae_template */

  register({
    name: 'ae_template',
    description: [
      '用内置动效模板一键生成合成，不用手写场景文档。',
      `可用模板：${TEMPLATE_NAMES.join('、')}。`,
      '参数按模板不同：title 用 headline/subhead；lower-third 用 name/role；cta 用 label；logo-reveal 用 brand/tagline；countdown 用 from/step；stat 用 value/label；quote 用 quote/author；kinetic 用 words；end-card 用 headline/handle；particles/gradient 是背景板。',
      '通用参数：theme（midnight/sunset/mint/paper/mono）、aspect（16:9/9:16/1:1/4:5/4:3/21:9）、duration、fps、colors（覆盖主题色，如 { accent: "#ff0055" }）、compName。',
      '传 template="list" 只列模板不建合成。',
      '想改细节就改用 ae_compose 直接写场景文档——模板只是它的预设。',
    ].join('\n'),
    timeoutMs: 600_000,
    parameters: {
      template: {
        type: 'string',
        required: true,
        description: `模板名，或 "list"。可选：${TEMPLATE_NAMES.join(', ')}`,
      },
      options: {
        type: 'json',
        description: '模板参数对象，见工具说明。省略则全部用默认值。',
      },
      save: {
        type: 'string',
        description: '可选。建好后把项目另存到这个 .aep 绝对路径。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          template: { type: 'string' },
          catalog: {},
          comp: { type: 'string' },
          id: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          duration: { type: 'number' },
          frameRate: { type: 'number' },
          layerCount: { type: 'number' },
          layers: {},
          saved: { type: 'string' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        if (Array.isArray(value.catalog) && value.catalog.length > 0) {
          const lines = [`内置模板 ${value.catalog.length} 个：`, '']
          for (const item of value.catalog) {
            lines.push(`**${item.name}** — ${item.summary}`)
            lines.push(`  参数：${item.params.join('、')}`)
          }
          return text(lines.join('\n'))
        }
        const lines = [summarizeScene(value)]
        if (value.saved) lines.push(`项目已保存：${value.saved}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const templateName = String(args?.template ?? '').trim()
      if (templateName === 'list') {
        return { template: 'list', catalog: templateCatalog(), ...EMPTY_SCENE, error: '' }
      }
      try {
        const scene = buildTemplate(templateName, args?.options ?? {})
        const built = await serial(() => bridge.runtime('buildScene', scene))
        let saved = ''
        if (typeof args.save === 'string' && args.save.trim() !== '') {
          const info = await serial(() => bridge.runtime('saveProject', { path: args.save.trim() }))
          saved = info.path
        }
        return {
          template: templateName,
          catalog: [],
          comp: String(built.comp ?? ''),
          id: Number(built.id ?? 0),
          width: Number(built.width ?? 0),
          height: Number(built.height ?? 0),
          duration: Number(built.duration ?? 0),
          frameRate: Number(built.frameRate ?? 0),
          layerCount: Number(built.layerCount ?? 0),
          layers: built.layers ?? [],
          saved,
          error: '',
        }
      } catch (error) {
        return { template: templateName, catalog: [], ...EMPTY_SCENE, error: formatError(error) }
      }
    },
  })

  /* ------------------------------------------------------------ ae_render */

  register({
    name: 'ae_render',
    description: [
      '把 After Effects 里的合成渲染成视频或图片。',
      'format=mp4 出 H.264 视频；png 出 PNG 序列；mov 出 QuickTime；还有 avi/tif/psd。',
      '给 stillAt 时只导出一张静帧 PNG，不走渲染队列——用来快速预览某一帧。',
      'comp 省略则用项目里最新的合成。渲染是同步等待的，大合成请留足时间。',
    ].join('\n'),
    timeoutMs: 1_800_000,
    parameters: {
      comp: {
        type: 'string',
        description: '合成名或合成 id。省略则用最新的合成。',
      },
      output: {
        type: 'string',
        required: true,
        description: '输出文件的绝对路径。png 序列给目录下的文件名（不带帧号），实际会生成 <name>_00000.png 之类。',
      },
      format: {
        type: 'string',
        description: '输出格式。默认 mp4。',
        enum: ['mp4', 'png', 'mov', 'avi', 'tif', 'psd'],
      },
      stillAt: {
        type: 'number',
        description: '可选。给一个时间（秒），只导出这一帧 PNG，不渲染整条。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          comp: { type: 'string' },
          format: { type: 'string' },
          template: { type: 'string' },
          status: { type: 'number' },
          done: { type: 'boolean' },
          ms: { type: 'number' },
          still: { type: 'boolean' },
          time: { type: 'number' },
          dir: { type: 'string' },
          frames: { type: 'number' },
          first: { type: 'string' },
          file: {},
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        if (value.error) return text(value.error)
        const lines = [summarizeRender({
          comp: value.comp,
          format: value.format,
          still: value.still === true,
          time: value.time ?? 0,
          ms: value.ms ?? 0,
          file: value.file,
          dir: value.dir,
          frames: value.frames ?? 0,
        })]
        if (value.template) lines.push(`输出模板：${value.template}`)
        if (value.frames > 0 && value.first) lines.push(`首帧：${value.first}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const output = String(args?.output ?? '').trim()
      if (output === '') {
        return {
          comp: '', format: '', template: '', status: 0, done: false, ms: 0,
          still: false, time: 0, dir: '', frames: 0, first: '', file: null, error: 'output 必填',
        }
      }
      try {
        const result = await serial(() => bridge.runtime('render', {
          comp: args?.comp,
          output,
          format: args?.format ?? 'mp4',
          stillAt: args?.stillAt,
          timeout: 1_500_000,
        }, { timeoutMs: 1_700_000 }))
        return {
          comp: String(result.comp ?? ''),
          format: String(result.format ?? ''),
          template: String(result.template ?? ''),
          status: Number(result.status ?? 0),
          done: result.done === true,
          ms: Number(result.ms ?? 0),
          still: result.still === true,
          time: Number(result.time ?? 0),
          dir: String(result.dir ?? ''),
          frames: Number(result.frames ?? 0),
          first: String(result.first ?? ''),
          file: result.file ?? null,
          error: '',
        }
      } catch (error) {
        return {
          comp: '', format: '', template: '', status: 0, done: false, ms: 0,
          still: false, time: 0, dir: '', frames: 0, first: '', file: null, error: formatError(error),
        }
      }
    },
  })

  /* ----------------------------------------------------- ae_run_script */

  register({
    name: 'ae_run_script',
    description: [
      '在 After Effects 里执行任意 ExtendScript，是其余工具的逃生舱。',
      '**发送前会做 ES3 语法预检**：检测到 const / let / 箭头函数 / 模板字符串 / class / for-of / async 等 ES2015+ 语法时，直接在 DSH 侧拦截并指出行号列号——AE 不会执行任何代码，也不会有弹窗。',
      '执行时自动包在 undo 组里，出错返回精确的 e.message、e.line 与出错那一行源码。',
      'payload 会成为脚本里的 payload 变量，用来传参数。返回值必须是可 JSON 序列化的值。',
    ].join('\n'),
    timeoutMs: 600_000,
    parameters: {
      code: { type: 'string', required: true, description: '要执行的 ExtendScript 源码（纯 ES3）。' },
      payload: { type: 'json', description: '传给脚本的 payload 变量。' },
      label: { type: 'string', description: 'undo 组标签，默认 DSH_AE。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          value: {},
          error: { type: 'string' },
          line: { type: 'number' },
          context: { type: 'string' },
          violations: {},
        },
      },
      render: (_args, value) => {
        if (value.ok) {
          const pretty = value.value === null || value.value === undefined
            ? '(无返回值)'
            : JSON.stringify(value.value, null, 2)
          return text(`执行成功：\n${pretty}`)
        }
        const lines = [value.error]
        if (typeof value.line === 'number' && value.line > 0) lines.push(`AE 报错行：${value.line}`)
        if (value.context) lines.push(`出错代码：${value.context}`)
        return text(lines.join('\n'))
      },
    },
    async execute(args) {
      const code = String(args?.code ?? '')
      if (code.trim() === '') {
        return { ok: false, value: null, error: 'code 不能为空', line: -1, context: '', violations: [] }
      }
      // Pre-flight: stop ES2015+ before After Effects ever parses it.
      try {
        assertEs3(code, 'ae_run_script code')
      } catch (error) {
        return {
          ok: false, value: null, error: error.message, line: -1, context: '',
          violations: error.violations ?? [],
        }
      }
      try {
        const value = await serial(() => bridge.runtime('pro:runGuarded', {
          code,
          payload: args?.payload,
          label: args?.label,
        }))
        return { ok: true, value: value ?? null, error: '', line: -1, context: '', violations: [] }
      } catch (error) {
        return {
          ok: false, value: null, error: formatError(error),
          line: typeof error.line === 'number' ? error.line : -1,
          context: typeof error.context === 'string' ? error.context : '',
          violations: [],
        }
      }
    },
  })

  /* -------------------------------------------------------- pro tool set */

  registerProTools({
    serial,
    bridge,
    register,
    defineTool,
  })

  /* ----------------------------------------------------------- prompt note */

  if (typeof ctx.systemPrompt?.section === 'function') {
    disposers.push(ctx.systemPrompt.section({
      name: 'dsh-aftereffects',
      order: SECTION_ORDER,
      text: [
        '本机已装 **dsh-aftereffects**：用 `ae_*` 工具驱动 Adobe After Effects 做商业级模板。',
        '',
        '**工作流**：`ae_status` 看环境 → `ae_template` / `ae_compose` 建合成 → `ae_render` 出片。',
        '**读**：`ae_layers` 拿稳定 `Layer.id` → `ae_query` 按 matchName 点路径读值/关键帧。',
        '**写**：`ae_set` 改值或挂表达式 → `ae_animate` 打关键帧（默认带贝塞尔缓动）。',
        '**第三方插件**：`ae_scan_effects` 拿 matchName → `ae_inspect_plugin_params` 看参数树。',
        '**交付**：`ae_auto_fit_text` 做自适应底栏 → `ae_essential_graphics` 绑控制器 → `ae_audio_markers` 卡点。',
        '',
        '### 硬约束（会被程序拦截，不是建议）',
        '1. **ES3 only**。脚本与表达式都用 `var` + `function`；禁 const / let / 箭头 / 模板字符串 / class / 解构 / for-of / async。`ae_run_script` 与 `ae_set` 的表达式都会在发送前预检，被拦下就按报的行列号改写，不要绕。',
        '2. **`CUSTOM_VALUE` 禁止写入**。`ae_inspect_plugin_params` 里 `customValue: true` 的参数是第三方插件的二进制黑盒，`ae_set` 会直接拒绝。只能改用周边可读参数，或让用户在交互式 AE 里调。',
        '3. **属性寻址**：用完整 matchName 路径（如 `ADBE Transform Group.ADBE Position`）或 `propertyIndex`，**绝不用中文显示名**——显示名随 AE 语言变化。`propertyIndex` 是相对父组的，必须配合 `path` 使用。',
        '4. **字幕框自适应**用 `ae_auto_fit_text`（真实 `sourceRectAtTime()` + `toComp/fromComp` 坐标换算）。**只用于需要自适应的字幕/底栏**；用户明确要固定尺寸时不要强加。禁止写死宽高伪装自适应。',
        '5. **动画默认加缓动**：`ae_animate` 的 `ease` 至少给 `out` 或 `both`。**但用户明确要线性动画时照做**——规则是默认值，不是禁令。',
        '6. **高风险操作先 checkpoint**：`resetProject`、删合成、批量删层、批量清效果、替换素材等。程序级门禁会拒绝没有已验证备份的这类操作。',
        '7. **视觉自检**：挂完重型特效或排完版，用 `ae_capture_preview` 截图（建议 longEdge≈640，多帧用 `count`）。',
        '',
        '### 关于"看图"的诚实说明',
        '`ae_capture_preview` 返回的是**图片文件路径**，图像不会自动进入你的视觉上下文。'
          + '你需要主动调用 `read_image`（传入该路径）才能真正看到画面；如果没有调用，**不要声称你已经完成了视觉检查**。',
        '',
        '### 已知不可用（会明确报错，不要反复尝试）',
        '- `.ffx` 预设应用（`ae_apply_ffx_preset` 的 presetPath）：无界面实例会终止 AE 进程，工具会先检测并拒绝。替代：`ae_run_script` 按 propertyIndex 挂效果设参数。',
        '- `.mogrt` 导出：同上。控制器可以绑，导出需用户在交互式 AE 里做（窗口 → 基本图形 → 导出动态图形模板）。',
        '',
        '无界面实例与用户开着的 AE 窗口冲突：启动超时就先关掉 AE 窗口。',
      ].join('\n'),
    }))
  }

  /* ------------------------------------------------------------- lifecycle */

  ctx.on?.('dispose', () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        /* already gone */
      }
    }
    void bridge.stop().catch(() => {})
  })
}
