/**
 * 门禁的工具层端到端测试。
 *
 * 与 `gate.test.mjs` 的区别：那个测分类器这个纯函数，这个测**真实的工具
 * execute** —— 通过 `apply()` 注册工具，然后调用工具的 `execute`，用一个
 * 假的 bridge 记录「有没有真的去创建备份」。门禁如果只写在文档里，这里会
 * 立刻失败。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { registerProTools } from '../lib/pro-tools.js'
import { guardDestructive, guardSceneBuild, guardScript, classifyScript } from '../lib/gate.js'

/** A minimal byte string that passes the .aep signature check. */
function fakeAep(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x20)
  buf.write('RIFX', 0)
  return buf
}

/**
 * A bridge double that records every runtime call.
 *
 * The checkpoint it hands back is a **real file on disk**: the gate verifies
 * what it is told, so a fake path would only prove that the verification is
 * bypassable. The temp dir is cleaned up by `dispose()`.
 */
function makeBridge(overrides = {}) {
  const calls = []
  const root = mkdtempSync(join(tmpdir(), 'dsh-gate-'))
  const checkpointDir = join(root, 'dsh-checkpoints')
  mkdirSync(checkpointDir, { recursive: true })

  const state = {
    // `?? default` would turn an explicit `null` back into a path, and the
    // "unsaved project" cases would silently test the wrong branch.
    file: overrides.file !== undefined ? overrides.file : join(root, 'show.aep'),
    saved: overrides.saved ?? true,
    compCount: overrides.compCount ?? 2,
    compNames: overrides.compNames ?? ['Main', 'Alt'],
    checkpointDir,
  }
  if (state.file) writeFileSync(state.file, fakeAep())

  let checkpointSeq = 0
  const bridge = {
    root,
    calls,
    async runtime(name, payload) {
      calls.push({ name, payload })
      if (name === 'pro:projectStatus') {
        return {
          file: state.file,
          saved: state.saved,
          compCount: state.compCount,
          compNames: state.compNames,
          checkpointDir: state.checkpointDir,
        }
      }
      if (name === 'pro:checkpoint') {
        checkpointSeq++
        if (state.saved === false) {
          return { ok: false, skipped: true, reason: 'untitled-project', hint: 'save first' }
        }
        const checkpoint = join(checkpointDir, `cp${checkpointSeq}.aep`)
        writeFileSync(checkpoint, fakeAep())
        return {
          ok: true,
          source: state.file,
          checkpoint,
          dir: checkpointDir,
          bytes: 4096,
        }
      }
      if (name === 'pro:restoreCheckpoint') {
        // A real restore reopens the project, so the open file really changes.
        state.file = payload.checkpoint
        return { ok: true, checkpoint: payload.checkpoint, file: payload.checkpoint }
      }
      return {}
    },
  }
  const dispose = () => rmSync(root, { recursive: true, force: true })
  return { bridge, state, calls, dispose }
}

/** Collect the tool definitions that registerProTools produces. */
function collectTools(deps) {
  const tools = new Map()
  registerProTools({
    ...deps,
    register: (definition) => { tools.set(definition.name, definition) },
    defineTool: (definition) => definition,
  })
  return tools
}

const serial = (task) => task()

/* --------------------------------------------------- 分类器接线（正向） */

test('ae_run_script 的分类器判定写操作', () => {
  assert.equal(classifyScript("layer.name = 'x';").isWrite, true)
  assert.equal(classifyScript('return app.version;').isWrite, false)
})

/* ---------------------------------------------- guardDestructive 行为 */

test('guardDestructive 在未保存工程时抛错', async (t) => {
  const { bridge, dispose } = makeBridge({ saved: false, file: null })
  t.after(dispose)
  await assert.rejects(
    () => guardDestructive({ bridge, serial, operation: 'resetProject' }),
    (e) => {
      assert.ok(/CHECKPOINT|保存/.test(e.code ?? e.message))
      return true
    },
  )
})

test('guardDestructive 会真的调用 pro:checkpoint', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const r = await guardDestructive({ bridge, serial, operation: 'resetProject' })
  assert.equal(r.ok, true)
  assert.ok(r.checkpoint, 'must return a checkpoint path')
  assert.ok(calls.some((c) => c.name === 'pro:checkpoint'), 'must actually create a backup')
})

test('guardDestructive 不复用旧备份（fresh 默认）', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  await guardDestructive({ bridge, serial, operation: 'resetProject' })
  const checkpoints = calls.filter((c) => c.name === 'pro:checkpoint')
  assert.equal(checkpoints.length, 1, 'exactly one fresh backup')
})

test('guardDestructive 在备份未通过校验时拒绝', async (t) => {
  const { bridge, dispose } = makeBridge()
  t.after(dispose)
  // A backup that exists but is zero bytes is not protection.
  const broken = {
    ...bridge,
    async runtime(name, payload) {
      if (name === 'pro:checkpoint') {
        const bad = join(bridge.root, 'dsh-checkpoints', 'broken.aep')
        writeFileSync(bad, Buffer.alloc(0))
        return { ok: true, checkpoint: bad, dir: join(bridge.root, 'dsh-checkpoints'), bytes: 0 }
      }
      return bridge.runtime(name, payload)
    },
  }
  await assert.rejects(
    () => guardDestructive({ bridge: broken, serial, operation: 'resetProject' }),
    (e) => e.code === 'CHECKPOINT_INVALID',
  )
})

/* ------------------------------------------- guardSceneBuild 建片门禁 */

test('guardSceneBuild 在空工程建第一个合成时不备份', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ compCount: 0, compNames: [] })
  t.after(dispose)
  const r = await guardSceneBuild({ bridge, serial, compName: 'Intro' })
  assert.equal(r.gated, false)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0, '新建不该复制工程')
})

test('guardSceneBuild 替换同名合成时必须备份', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ compNames: ['Main', 'Intro'] })
  t.after(dispose)
  const r = await guardSceneBuild({ bridge, serial, compName: 'Intro' })
  assert.equal(r.gated, true)
  assert.ok(r.checkpoint)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 1)
})

test('guardSceneBuild 建不同名合成时不备份', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ compNames: ['Main'] })
  t.after(dispose)
  const r = await guardSceneBuild({ bridge, serial, compName: 'Outro' })
  assert.equal(r.gated, false)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('guardSceneBuild 状态探测失败时按有内容处理', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const blind = {
    ...bridge,
    async runtime(name, payload) {
      if (name === 'pro:projectStatus') throw new Error('bridge down')
      return bridge.runtime(name, payload)
    },
  }
  // An unknown project state must not be read as "nothing to lose".
  await assert.rejects(
    () => guardSceneBuild({ bridge: blind, serial, compName: 'Intro' }),
    (e) => e.code === 'CHECKPOINT_UNAVAILABLE',
  )
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('guardSceneBuild resetProject 在空工程上放行、有内容时备份', async (t) => {
  const empty = makeBridge({ compCount: 0, compNames: [], saved: false, file: null })
  t.after(empty.dispose)
  const allowed = await guardSceneBuild({ bridge: empty.bridge, serial, resetProject: true })
  assert.equal(allowed.gated, false)

  const full = makeBridge()
  t.after(full.dispose)
  const guarded = await guardSceneBuild({ bridge: full.bridge, serial, resetProject: true })
  assert.equal(guarded.gated, true)
  assert.ok(guarded.checkpoint)
})

test('guardSceneBuild replace=false 永不备份', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ compNames: ['Intro'] })
  t.after(dispose)
  const r = await guardSceneBuild({ bridge, serial, compName: 'Intro', replace: false })
  assert.equal(r.gated, false)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

/* ------------------------------------------- guardScript 的放行 / 拒绝 */

test('纯读取脚本在未保存工程上照常放行', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ saved: false, file: null })
  t.after(dispose)
  const r = await guardScript({ code: 'return app.version;', bridge, serial })
  assert.equal(r.isWrite, false)
  assert.equal(r.gated, false)
  assert.equal(r.blocked, false, '读脚本毁不掉任何东西，拦它只会教人乱声明 readOnly')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('写脚本在未保存工程上被拦下，而不是抛栈', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ saved: false, file: null })
  t.after(dispose)
  const r = await guardScript({ code: "layer.name = 'x';", bridge, serial })
  assert.equal(r.isWrite, true)
  assert.equal(r.blocked, true)
  assert.ok(r.reason.length > 0, 'the caller needs a reason it can act on')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('写脚本在已保存工程上先备份再放行', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const r = await guardScript({ code: 'comp.bgColor = [0,0,0];', bridge, serial })
  assert.equal(r.isWrite, true)
  assert.equal(r.blocked, false)
  assert.ok(r.checkpoint)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 1)
})

test('声明 readOnly 不能豁免一个真正的写脚本', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const r = await guardScript({ code: 'layer.remove();', readOnly: true, bridge, serial })
  assert.equal(r.isWrite, true, 'a wrong declaration is a mistake, not a licence')
  assert.equal(r.gated, true)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 1)
})

/* ------------------------------------- ae_checkpoint 工具的 list 语义 */

test('ae_checkpoint action=list 不创建备份', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const tool = tools.get('ae_checkpoint')
  assert.ok(tool, 'ae_checkpoint must be registered')

  const value = await tool.execute({ action: 'list' }, {})
  const created = calls.filter((c) => c.name === 'pro:checkpoint')
  assert.equal(created.length, 0, 'list must not create a checkpoint')
  assert.equal(value.action, 'list')
  assert.ok(Array.isArray(value.checkpoints))
})

test('ae_checkpoint action=list 在未保存工程时也不报错', async (t) => {
  const { bridge, calls, dispose } = makeBridge({ saved: false, file: null })
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const tool = tools.get('ae_checkpoint')
  const value = await tool.execute({ action: 'list' }, {})
  assert.equal(value.action, 'list')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

/* --------------------------------- ae_checkpoint 工具的 restore 语义 */

test('ae_checkpoint restore 拒绝跨工程备份', async (t) => {
  const { bridge, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const tool = tools.get('ae_checkpoint')

  const value = await tool.execute({
    action: 'restore',
    checkpoint: 'D:/other-project/dsh-checkpoints/someone-else.aep',
  }, {})

  assert.equal(value.restored, false)
  assert.match(value.reason, /跨工程|拒绝/)
})

test('ae_checkpoint restore 在目标不属于当前工程时不做恢复', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const tool = tools.get('ae_checkpoint')

  await tool.execute({
    action: 'restore',
    checkpoint: 'D:/elsewhere/x.aep',
  }, {})

  assert.equal(
    calls.filter((c) => c.name === 'pro:restoreCheckpoint').length,
    0,
    'restore must not run when ownership fails',
  )
})

test('ae_checkpoint restore 缺少参数时明确拒绝', async (t) => {
  const { bridge, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const value = await tools.get('ae_checkpoint').execute({ action: 'restore' }, {})
  assert.equal(value.restored, false)
  assert.ok(value.reason.length > 0)
})

test('ae_checkpoint restore 会先做安全备份再恢复', async (t) => {
  const { bridge, calls, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  const tool = tools.get('ae_checkpoint')

  // A checkpoint that really exists, inside this project's own directory.
  const target = join(bridge.root, 'dsh-checkpoints', 'restore-me.aep')
  writeFileSync(target, fakeAep())

  const value = await tool.execute({ action: 'restore', checkpoint: target }, {})

  assert.equal(value.restored, true)
  assert.ok(value.safetyBackup, 'a pre-restore safety backup must be recorded')
  const order = calls.map((c) => c.name).filter((n) => n === 'pro:checkpoint' || n === 'pro:restoreCheckpoint')
  assert.deepEqual(order, ['pro:checkpoint', 'pro:restoreCheckpoint'], 'backup must precede the restore')
})

/* ------------------------------------------------ 其它工具的注册回归 */

test('pro 工具集仍然全部注册', async (t) => {
  const { bridge, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  // pro-tools.js 负责的 12 个工具（基础 5 个在 index.js 注册，不在这里）。
  const expected = [
    'ae_animate',
    'ae_apply_ffx_preset',
    'ae_audio_markers',
    'ae_auto_fit_text',
    'ae_capture_preview',
    'ae_checkpoint',
    'ae_essential_graphics',
    'ae_inspect_plugin_params',
    'ae_layers',
    'ae_query',
    'ae_scan_effects',
    'ae_set',
  ].sort()
  assert.deepEqual([...tools.keys()].sort(), expected)
})

test('每个 pro 工具的 output schema 都声明了 render', async (t) => {
  const { bridge, dispose } = makeBridge()
  t.after(dispose)
  const tools = collectTools({ serial, bridge })
  for (const [name, definition] of tools) {
    assert.equal(typeof definition.output?.render, 'function', `${name} missing output.render`)
    assert.ok(definition.output.schema, `${name} missing output.schema`)
  }
})
