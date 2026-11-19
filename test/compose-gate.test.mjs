/**
 * `ae_compose` / `ae_template` 的门禁接线测试。
 *
 * 这两个工具最终都走 `bridge.runtime('buildScene', scene)`，而那条路径默认
 * 会删掉同名合成。门禁只接在其中一个上，另一个就是现成的绕过通道——所以
 * 这里对两个入口分别钉死，而不是只测它们共用的那个函数。
 *
 * 假 bridge 的备份是**磁盘上真实存在**的文件：门禁会校验它拿到的东西，
 * 一个假路径只能证明校验可被绕过，证明不了保护有效。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../index.js'

function fakeAep(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x20)
  buf.write('RIFX', 0)
  return buf
}

/** Build the plugin against a bridge double and collect the tools it registers. */
function setup(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-compose-'))
  const checkpointDir = join(root, 'dsh-checkpoints')
  mkdirSync(checkpointDir, { recursive: true })

  const state = {
    file: overrides.file !== undefined ? overrides.file : join(root, 'show.aep'),
    saved: overrides.saved ?? true,
    compCount: overrides.compCount ?? 2,
    compNames: overrides.compNames ?? ['Main', 'Alt'],
    checkpointDir,
  }
  if (state.file) writeFileSync(state.file, fakeAep())

  const calls = []
  let seq = 0
  const built = []

  // apply() constructs its own AeBridge; replacing the prototype method is the
  // seam that keeps this test honest — it exercises the real tool `execute`.
  const original = AeBridgeProto.runtime
  AeBridgeProto.runtime = async function runtime(name, payload) {
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
      seq += 1
      if (state.saved === false) {
        return { ok: false, skipped: true, reason: 'untitled-project', hint: 'save first' }
      }
      const checkpoint = join(checkpointDir, `cp${seq}.aep`)
      writeFileSync(checkpoint, fakeAep())
      return { ok: true, source: state.file, checkpoint, dir: checkpointDir, bytes: 4096 }
    }
    if (name === 'buildScene') {
      built.push(payload)
      return { comp: payload?.name ?? 'Comp', id: 1, width: 1920, height: 1080, duration: 8, frameRate: 30, layerCount: 1, layers: [] }
    }
    if (name === 'saveProject') return { path: payload?.path ?? '' }
    return {}
  }

  const tools = new Map()
  apply({
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
    on: () => {},
  }, {})

  const restore = () => {
    AeBridgeProto.runtime = original
    rmSync(root, { recursive: true, force: true })
  }

  return { tools, calls, built, state, checkpointDir, restore }
}

// Imported lazily so the prototype patch above has something to patch.
const { AeBridge } = await import('../lib/bridge.js')
const AeBridgeProto = AeBridge.prototype

/* --------------------------------------------------------------- ae_compose */

test('ae_compose 在空工程建第一个合成时不做备份', async (t) => {
  const { tools, calls, restore } = setup({ compCount: 0, compNames: [] })
  t.after(restore)
  const value = await tools.get('ae_compose').execute({
    scene: { name: 'Intro', layers: [] },
  }, {})
  assert.equal(value.error, '')
  assert.equal(value.gate, '', 'nothing to lose, so nothing to back up')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('ae_compose 替换同名合成前会备份，并把路径回报给用户', async (t) => {
  const { tools, calls, restore } = setup({ compNames: ['Main', 'Intro'] })
  t.after(restore)
  const value = await tools.get('ae_compose').execute({
    scene: { name: 'Intro', layers: [] },
  }, {})
  assert.equal(value.error, '')
  assert.ok(value.gate, 'the gate must report what it protected')
  assert.match(value.gate, /备份/)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 1)
})

test('ae_compose resetProject 在未保存工程上被拒绝，且不执行 buildScene', async (t) => {
  const { tools, calls, built, restore } = setup({ saved: false, file: null, compCount: 3 })
  t.after(restore)
  const value = await tools.get('ae_compose').execute({
    scene: { name: 'Intro', resetProject: true, layers: [] },
  }, {})
  assert.ok(value.error, 'an unbackupable reset must be refused')
  assert.equal(built.length, 0, 'buildScene must not run')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

/* -------------------------------------------------------------- ae_template */

test('ae_template 替换同名合成前同样会备份', async (t) => {
  const { tools, calls, restore } = setup({ compNames: ['Title'] })
  t.after(restore)
  const value = await tools.get('ae_template').execute({
    template: 'title',
    options: { headline: 'Hello' },
  }, {})
  assert.equal(value.error, '')
  assert.ok(value.gate, 'ae_template must not be a bypass around the gate')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 1)
})

test('ae_template 建新合成时不备份', async (t) => {
  const { tools, calls, restore } = setup({ compNames: ['Something else'] })
  t.after(restore)
  const value = await tools.get('ae_template').execute({
    template: 'title',
    options: { headline: 'Hello', compName: 'Fresh' },
  }, {})
  assert.equal(value.error, '')
  assert.equal(value.gate, '')
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})

test('ae_template list 既不建片也不备份', async (t) => {
  const { tools, calls, built, restore } = setup()
  t.after(restore)
  const value = await tools.get('ae_template').execute({ template: 'list' }, {})
  assert.ok(Array.isArray(value.catalog) && value.catalog.length > 0)
  assert.equal(built.length, 0)
  assert.equal(calls.filter((c) => c.name === 'pro:checkpoint').length, 0)
})
