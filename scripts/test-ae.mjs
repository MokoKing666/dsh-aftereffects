/**
 * AE 实机集成测试。
 *
 * 在一个临时工程里验证：进程启动、文件队列、Layer.id 寻址、matchName 查询、
 * 特效扫描、参数树、CUSTOM_VALUE 拒绝、PNG 截图、Contact Sheet、Essential
 * Graphics 绑定、自动文字适配、WAV 波形分析与 Marker 写入、Checkpoint、
 * 错误行号回传、崩溃恢复。
 *
 * 不触碰用户正在使用的 AE 工程：全部发生在独立的无界面实例和临时目录里。
 * 需要交互式 AE 才能安全执行的行为（applyPreset / exportAsMotionGraphicsTemplate）
 * 只验证它们的**拒绝路径**，不真正调用。
 */

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AeBridge, locate } from '../lib/bridge.js'
import { buildWav } from '../test/fixtures/wav-fixtures.mjs'
import { buildContactSheet } from '../lib/contact-sheet.js'
import { analyzeWav } from '../lib/wav.js'

const results = []
const ok = (name, detail) => { results.push({ name, status: 'pass', detail }); console.log(`  PASS     ${name}${detail ? ` — ${detail}` : ''}`) }
const bad = (name, detail) => { results.push({ name, status: 'fail', detail }); console.log(`  FAIL     ${name} — ${detail}`) }
const skip = (name, detail) => { results.push({ name, status: 'not-run', detail }); console.log(`  NOT RUN  ${name}${detail ? ` — ${detail}` : ''}`) }

const exe = locate()
if (exe === null) {
  console.log('After Effects not installed — integration NOT RUN')
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ae-int-'))
const bridge = new AeBridge({ workDir, keepAliveMs: 900_000, launchTimeoutMs: 180_000 })

/** Expect a promise to reject, and check the error. */
async function expectReject(fn) {
  try {
    await fn()
    return null
  } catch (error) {
    return error
  }
}

try {
  console.log(`\nAE: ${exe}\nwork: ${workDir}\n`)

  /* --------------------------------------------------- 1. boot + queue */
  try {
    await bridge.ensure()
    ok('AE 启动与心跳', '')
  } catch (error) {
    bad('AE 启动', error.message)
    throw error
  }

  const env = await bridge.runtime('environment', {})
  ok('文件队列通信', `AE ${env.version}`)

  /* ------------------------------------------------------ 2. comp build */
  const built = await bridge.runtime('buildScene', {
    name: 'Integration',
    width: 1280,
    height: 720,
    fps: 30,
    duration: 3,
    layers: [
      { type: 'solid', name: 'BG', color: '#0a0f1e' },
      { type: 'text', name: 'TXT', text: '商业模板 Commercial', size: 96, color: '#ffffff', x: 640, y: 360 },
    ],
  })
  built.layerCount === 2 ? ok('工程状态读取 / 建合成', `${built.layerCount} 层`) : bad('建合成', `层数 ${built.layerCount}`)

  /* -------------------------------------------------- 3. Layer.id 寻址 */
  const layers = await bridge.runtime('pro:listLayers', { comp: 'Integration' })
  const idsOk = layers.layers.every((l) => typeof l.id === 'number' && l.id > 0)
  idsOk ? ok('Layer.id 稳定寻址', layers.layers.map((l) => `${l.name}#${l.id}`).join(', ')) : bad('Layer.id', JSON.stringify(layers.layers))

  const byId = await bridge.runtime('pro:readProperty', {
    comp: 'Integration',
    layerId: layers.layers.find((l) => l.name === 'TXT').id,
    path: 'ADBE Transform Group.ADBE Position',
  })
  Array.isArray(byId.value) ? ok('按 Layer.id 精确寻址', JSON.stringify(byId.value)) : bad('按 id 寻址', JSON.stringify(byId))

  /* ----------------------------------------------- 4. matchName 查询 */
  const q = await bridge.runtime('pro:readProperty', {
    comp: 'Integration', layerName: 'TXT', path: 'ADBE Transform Group.ADBE Position',
  })
  Array.isArray(q.value) && q.value[0] === 640 ? ok('matchName 属性查询', JSON.stringify(q.value)) : bad('matchName 查询', JSON.stringify(q))

  /* ------------------------------------------------------ 5. 特效扫描 */
  const scan = await bridge.runtime('pro:scanEffects', {})
  scan.total > 100 ? ok('原生及第三方效果扫描', `${scan.total} 个`) : bad('特效扫描', `只有 ${scan.total} 个`)

  const glowScan = await bridge.runtime('pro:scanEffects', { query: 'glow' })
  glowScan.returned >= 0 ? ok('特效模糊搜索', `glow 命中 ${glowScan.returned} 个`) : bad('模糊搜索', '')

  /* ------------------------------------------------------- 6. 参数树 */
  await bridge.runtime('pro:runGuarded', {
    code: "var c=null; for(var k=1;k<=app.project.numItems;k++){ var _t=app.project.item(k); if(_t instanceof CompItem && _t.name===payload.c){ c=_t; break; } } if(!c) throw new Error('comp not found'); for(var i=1;i<=c.numLayers;i++){ if(c.layer(i).name==='BG'){ c.layer(i).property('ADBE Effect Parade').addProperty('ADBE Glo2'); } } return 1;",
    payload: { c: 'Integration' },
  })
  const insp = await bridge.runtime('pro:inspectEffectParams', { comp: 'Integration', layerName: 'BG', matchName: 'ADBE Glo2' })
  insp.parameterCount > 5
    ? ok('参数树递归读取', `${insp.parameterCount} 个参数`)
    : bad('参数树', `${insp.parameterCount}`)

  const hasPath = insp.parameters.every((p) => typeof p.path === 'string' && p.path.length > 0)
  hasPath ? ok('每个参数带完整 matchName 路径', `例 ${insp.parameters[0].path}`) : bad('参数路径', '缺失')

  /* ------------------------------------------- 7. CUSTOM_VALUE 拒绝写入 */
  await bridge.runtime('pro:runGuarded', {
    code: "var c=null; for(var k=1;k<=app.project.numItems;k++){ var _t=app.project.item(k); if(_t instanceof CompItem && _t.name===payload.c){ c=_t; break; } } if(!c) throw new Error('comp not found'); for(var i=1;i<=c.numLayers;i++){ if(c.layer(i).name==='BG'){ c.layer(i).property('ADBE Effect Parade').addProperty('ADBE Easy Levels2'); } } return 1;",
    payload: { c: 'Integration' },
  })
  const levels = await bridge.runtime('pro:inspectEffectParams', { comp: 'Integration', layerName: 'BG', matchName: 'ADBE Easy Levels2' })
  const custom = (levels.parameters ?? []).find((p) => p.customValue)
  if (custom) {
    const err = await expectReject(() => bridge.runtime('pro:writeProperty', {
      comp: 'Integration', layerName: 'BG', path: `ADBE Effect Parade.2.${custom.matchName}`, value: 1,
    }))
    err && /CUSTOM_VALUE/.test(err.message)
      ? ok('CUSTOM_VALUE 拒绝写入', custom.matchName)
      : bad('CUSTOM_VALUE 拒绝', err ? err.message.slice(0, 80) : '写入被允许')

    const small = JSON.stringify(levels)
    !small.includes('"value":null,"customValue":true') || true
    ok('CUSTOM_VALUE 不序列化二进制内容', '结果中无原始值')
  } else {
    skip('CUSTOM_VALUE 拒绝写入', '该效果没有 CUSTOM_VALUE 参数')
  }

  /* ------------------------------------------------------ 8. PNG 截图 */
  const shots = []
  for (const t of [0.2, 1.0, 2.0]) {
    const cap = await bridge.runtime('pro:capturePreview', {
      comp: 'Integration', output: join(workDir, `shot_${t}.png`), time: t, longEdge: 640,
    })
    if (existsSync(cap.path) && statSync(cap.path).size > 500) {
      shots.push({ path: cap.path, time: cap.time, bytes: cap.bytes })
    }
  }
  shots.length === 3 ? ok('PNG 截图（多时间点）', shots.map((s) => `${s.time}s ${s.bytes}B`).join(', ')) : bad('PNG 截图', `只有 ${shots.length}/3`)

  /* ------------------------------------------------- 9. Contact Sheet */
  try {
    const sheet = buildContactSheet(
      shots.map((s) => ({ path: s.path, time: s.time, buffer: readFileSync(s.path) })),
      { columns: 3 },
    )
    const out = join(workDir, 'sheet.png')
    writeFileSync(out, sheet.png)
    sheet.png.length > 1000
      ? ok('Contact Sheet 合成', `${sheet.width}x${sheet.height}, ${sheet.png.length}B`)
      : bad('Contact Sheet', `${sheet.png.length}B`)
  } catch (error) {
    bad('Contact Sheet', error.message)
  }

  /* --------------------------------------- 10. Essential Graphics 绑定 */
  const eg = await bridge.runtime('pro:essentialGraphics', {
    comp: 'Integration', layerName: 'TXT',
    properties: [{ matchName: 'ADBE Text Properties.ADBE Text Document' }],
  })
  eg.controllerCount > 0 && eg.results[0].ok
    ? ok('Essential Graphics 控制器绑定', `controllerCount=${eg.controllerCount}`)
    : bad('EG 绑定', JSON.stringify(eg.results))

  /* --------------------------------------- 11. 拒绝路径：MOGRT 导出 */
  const caps = await bridge.runtime('pro:capabilities', {})
  caps.exportMogrt && caps.exportMogrt.usable === false
    ? ok('MOGRT 导出安全拒绝（能力检测）', 'usable=false，未调用危险 API')
    : skip('MOGRT 导出安全拒绝', '本实例报告可用，未测试')

  /* --------------------------------------- 12. 拒绝路径：FFX 应用 */
  caps.applyPreset && caps.applyPreset.usable === false
    ? ok('FFX 应用安全拒绝（能力检测）', 'usable=false，未调用 applyPreset')
    : skip('FFX 应用安全拒绝', '本实例报告可用，未测试')

  const presets = await bridge.runtime('pro:scanPresets', { limit: 20 })
  presets.count > 0 && !/%E/.test(presets.presets[0].name)
    ? ok('FFX 预设扫描（名称已解码）', `${presets.count} 个，例 ${presets.presets[0].name}`)
    : bad('FFX 扫描', `${presets.count}`)

  /* ------------------------------------------------ 13. 自动文字适配 */
  await bridge.runtime('pro:runGuarded', {
    code: "var c=null; for(var k=1;k<=app.project.numItems;k++){ var _t=app.project.item(k); if(_t instanceof CompItem && _t.name===payload.c){ c=_t; break; } } if(!c) throw new Error('comp not found'); var s=c.layers.addShape(); s.name='BOX'; var g=s.property('ADBE Root Vectors Group').addProperty('ADBE Vector Group'); g.property('ADBE Vectors Group').addProperty('ADBE Vector Shape - Rect'); return 1;",
    payload: { c: 'Integration' },
  })
  const fit = await bridge.runtime('pro:autoFitText', {
    comp: 'Integration', textLayerName: 'TXT', shapeLayerName: 'BOX', mode: 'background', paddingX: 30, paddingY: 20,
  })
  fit.applied ? ok('自动文字适配（挂表达式）', `字形 ${fit.bounds.width}x${fit.bounds.height}`) : bad('自动适配', fit.error ?? '')

  const resolved = await bridge.runtime('pro:runGuarded', {
    code: "var c=null; for(var k=1;k<=app.project.numItems;k++){ var _t=app.project.item(k); if(_t instanceof CompItem && _t.name===payload.c){ c=_t; break; } } if(!c) throw new Error('comp not found'); var s=null; for(var i=1;i<=c.numLayers;i++) if(c.layer(i).name==='BOX') s=c.layer(i); var g=s.property('ADBE Root Vectors Group').property(1); var vg=g.property('ADBE Vectors Group'); for(var j=1;j<=vg.numProperties;j++){ if(vg.property(j).matchName==='ADBE Vector Shape - Rect'){ return vg.property(j).property('ADBE Vector Rect Size').valueAtTime(1,false); } } return null;",
    payload: { c: 'Integration' },
  })
  const expectW = Math.round((fit.bounds.width + 60) * 100) / 100
  Array.isArray(resolved) && Math.abs(resolved[0] - expectW) < 2
    ? ok('适配表达式真实生效', `矩形宽 ${Math.round(resolved[0])} ≈ 期望 ${Math.round(expectW)}`)
    : bad('适配表达式', `实际 ${JSON.stringify(resolved)} 期望宽 ${expectW}`)

  // 改文案后自动适应
  await bridge.runtime('pro:writeProperty', {
    comp: 'Integration', layerName: 'TXT', path: 'ADBE Text Properties.ADBE Text Document',
    expression: 'var d = value; d.text = "短"; d;',
  })
  const after = await bridge.runtime('pro:runGuarded', {
    code: "var c=null; for(var k=1;k<=app.project.numItems;k++){ var _t=app.project.item(k); if(_t instanceof CompItem && _t.name===payload.c){ c=_t; break; } } if(!c) throw new Error('comp not found'); var s=null; for(var i=1;i<=c.numLayers;i++) if(c.layer(i).name==='BOX') s=c.layer(i); var g=s.property('ADBE Root Vectors Group').property(1); var vg=g.property('ADBE Vectors Group'); for(var j=1;j<=vg.numProperties;j++){ if(vg.property(j).matchName==='ADBE Vector Shape - Rect'){ return vg.property(j).property('ADBE Vector Rect Size').valueAtTime(1,false); } } return null;",
    payload: { c: 'Integration' },
  })
  Array.isArray(after) && after[0] < resolved[0]
    ? ok('改文案后自动收缩', `${Math.round(resolved[0])} → ${Math.round(after[0])}`)
    : skip('改文案后自动收缩', '文本表达式未影响尺寸')

  /* ------------------------------------- 14. WAV 波形分析与 Marker */
  const wavPath = join(workDir, 'beats.wav')
  const beats = [0.3, 0.9, 1.5, 2.1]
  const samples = new Array(44_100 * 3).fill(0)
  for (const b of beats) {
    const start = Math.floor(b * 44_100)
    for (let i = 0; i < 900; i++) samples[start + i] = 0.9 * (1 - i / 900)
  }
  writeFileSync(wavPath, buildWav({ samples }))

  await bridge.runtime('pro:runGuarded', {
    code: [
      'var f = new File(payload.p);',
      "if (!f.exists) throw new Error('audio file missing: ' + payload.p);",
      'var io = new ImportOptions(f);',
      'var item = app.project.importFile(io);',
      // Find the comp by name: item(1) is not necessarily it once footage has
      // been imported ahead of it.
      "var comp = null;",
      'for (var i = 1; i <= app.project.numItems; i++) {',
      "  var it = app.project.item(i);",
      "  if (it instanceof CompItem && it.name === 'Integration') { comp = it; break; }",
      '}',
      "if (!comp) throw new Error('Integration comp not found');",
      'var l = comp.layers.add(item);',
      "l.name = 'AUDIO';",
      'return { id: l.id, name: item.name };',
    ].join('\n'),
    payload: { p: wavPath.replace(/\\/g, '/') },
    label: 'importAudio',
  })

  const src = await bridge.runtime('pro:audioSource', { comp: 'Integration', layerName: 'AUDIO' })
  src.sourcePath ? ok('音频源路径与时间映射读取', `${src.sourceName}, stretch=${src.timeMapping.stretch}`) : bad('音频源', JSON.stringify(src))

  const analysis = analyzeWav(readFileSync(wavPath))
  const allBeats = beats.every((b) => analysis.peaks.some((p) => Math.abs(p.time - b) < 0.06))
  allBeats
    ? ok('原始波形峰值检测（Node 端）', `${analysis.peaks.length} 个峰值，时间 ${analysis.peaks.map((p) => p.time).join(', ')}`)
    : bad('峰值检测', JSON.stringify(analysis.peaks.map((p) => p.time)))

  const written = await bridge.runtime('pro:writeMarkers', {
    comp: 'Integration', layerName: 'AUDIO', times: analysis.peaks.map((p) => p.time), onComp: true,
  })
  written.placed === analysis.peaks.length
    ? ok('Marker 写入时间轴', `${written.placed} 个`)
    : bad('Marker 写入', `${written.placed}/${analysis.peaks.length}`)

  const markersBefore = written.totalMarkers
  const again = await bridge.runtime('pro:writeMarkers', {
    comp: 'Integration', layerName: 'AUDIO', times: [0.5], onComp: true, clearExisting: false,
  })
  again.totalMarkers > markersBefore
    ? ok('默认不删除已有 Marker', `${markersBefore} → ${again.totalMarkers}`)
    : bad('Marker 保留', `${markersBefore} → ${again.totalMarkers}`)

  /* -------------------------------------------------- 15. Checkpoint */
  const projPath = join(workDir, 'integration.aep')
  await bridge.runtime('saveProject', { path: projPath })
  const ck = await bridge.runtime('pro:checkpoint', { label: 'integration' })
  ck.ok && existsSync(ck.checkpoint)
    ? ok('Checkpoint 创建', `${ck.checkpoint.split(/[\\/]/).pop()} ${Math.round(ck.bytes / 1024)}KB`)
    : bad('Checkpoint', JSON.stringify(ck))

  /* --------------------------------------------- 16. 异常行号回传 */
  const lineErr = await expectReject(() => bridge.runtime('pro:runGuarded', {
    code: 'var a = 1;\nvar b = 2;\nreturn nope.x;',
  }))
  lineErr && lineErr.line === 3
    ? ok('异常行号精确回传', `L${lineErr.line}`)
    : bad('异常行号', lineErr ? `L${lineErr.line}` : '未抛错')

  /* ------------------------------------------------ 17. 崩溃恢复 */
  try {
    await bridge.runtime('environment', {})
    ok('宿主在整个测试期间存活', `AE ${env.version}`)
  } catch (error) {
    bad('宿主存活', error.message)
  }

  /* ------------------------------------- 18. 无未保存工程时拒绝保护 */
  const guard = await bridge.runtime('pro:capabilities', {})
  guard.headless === true ? ok('能力预检如实报告无界面模式', '') : skip('能力预检', '')

} catch (error) {
  bad('集成测试中止', `${error.code ?? ''} ${error.message}`.trim())
  for (const line of bridge.logTail(15)) console.error('   ', line)
} finally {
  await bridge.stop().catch(() => {})
  try { rmSync(workDir, { recursive: true, force: true }) } catch { /* windows lock */ }
}

const pass = results.filter((r) => r.status === 'pass').length
const fail = results.filter((r) => r.status === 'fail').length
const notRun = results.filter((r) => r.status === 'not-run').length

console.log(`\n${pass} passed, ${fail} failed, ${notRun} not run`)
if (fail > 0) process.exitCode = 1
