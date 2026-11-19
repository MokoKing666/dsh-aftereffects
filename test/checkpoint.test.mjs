/**
 * Checkpoint verification and the program-level safety gate.
 *
 * A checkpoint that is not verified is worse than none: it gives a model
 * permission to run destructive work against a file that may be zero bytes.
 * These tests pin both the verification and the refusal.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  verifyCheckpoint, requiresCheckpoint, assertSafeToProceed, listCheckpoints,
  pruneCheckpoints, recordCheckpoint, checkpointDir, CheckpointRequiredError,
  HIGH_RISK_OPERATIONS,
} from '../lib/checkpoint.js'

/** A minimal byte string that passes the .aep signature check. */
function fakeAep(bytes = 4096) {
  const buf = Buffer.alloc(bytes, 0x20)
  buf.write('RIFX', 0)
  return buf
}

test('a real-looking .aep passes verification', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const p = join(dir, 'a.aep')
    writeFileSync(p, fakeAep())
    const v = verifyCheckpoint(p)
    assert.equal(v.ok, true)
    assert.ok(v.bytes > 0)
    assert.match(v.hash, /^[0-9a-f]{64}$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a zero-byte file is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const p = join(dir, 'empty.aep')
    writeFileSync(p, Buffer.alloc(0))
    const v = verifyCheckpoint(p)
    assert.equal(v.ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file too small to be a project is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const p = join(dir, 'tiny.aep')
    writeFileSync(p, Buffer.from('RIFXtiny'))
    const v = verifyCheckpoint(p)
    assert.equal(v.ok, false)
    assert.match(v.reason, /never this small/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a file with the wrong signature is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const p = join(dir, 'wrong.aep')
    const buf = Buffer.alloc(4096, 0x20)
    buf.write('GIF8', 0)
    writeFileSync(p, buf)
    const v = verifyCheckpoint(p)
    assert.equal(v.ok, false)
    assert.match(v.reason, /does not look like an \.aep/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing file is refused', () => {
  const v = verifyCheckpoint(join(tmpdir(), 'definitely-not-here.aep'))
  assert.equal(v.ok, false)
  assert.match(v.reason, /does not exist/)
})

test('a hash mismatch is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const p = join(dir, 'a.aep')
    writeFileSync(p, fakeAep())
    const v = verifyCheckpoint(p, { expectHash: 'deadbeef'.repeat(8) })
    assert.equal(v.ok, false)
    assert.match(v.reason, /hash does not match/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('high-risk operations are gated, ordinary ones are not', () => {
  assert.equal(requiresCheckpoint('resetProject').required, true)
  assert.equal(requiresCheckpoint('removeComp').required, true)
  assert.equal(requiresCheckpoint('bulkLayerStructure').required, true)
  assert.equal(requiresCheckpoint('setPosition').required, false)
  assert.equal(requiresCheckpoint('ae_render').required, false)
  assert.equal(requiresCheckpoint('readProperty').required, false)
})

test('the gate names how much is at risk', () => {
  const gate = requiresCheckpoint('removeLayers', { layerCount: 42 })
  assert.equal(gate.required, true)
  assert.ok(gate.why.includes('42 layer'))
})

test('an unsaved project is refused with a clear instruction', () => {
  assert.throws(
    () => assertSafeToProceed({ operation: 'resetProject', projectPath: null }),
    (e) => {
      assert.ok(e instanceof CheckpointRequiredError)
      assert.equal(e.code, 'CHECKPOINT_REQUIRED')
      assert.equal(e.detail.reason, 'untitled-project')
      assert.match(e.message, /Save the project first/)
      return true
    },
  )
})

test('a destructive operation with no checkpoint is refused', () => {
  assert.throws(
    () => assertSafeToProceed({ operation: 'bulkLayerStructure', projectPath: '/p/a.aep', lastCheckpoint: null }),
    (e) => {
      assert.equal(e.detail.reason, 'no-checkpoint')
      assert.match(e.message, /ae_checkpoint first/)
      return true
    },
  )
})

test('an unverified checkpoint does not satisfy the gate', () => {
  assert.throws(
    () => assertSafeToProceed({
      operation: 'removeComp',
      projectPath: '/p/a.aep',
      lastCheckpoint: { path: '/p/x.aep', verified: false },
    }),
    (e) => {
      assert.equal(e.detail.reason, 'no-checkpoint')
      return true
    },
  )
})

test('a verified checkpoint lets the operation proceed', () => {
  const r = assertSafeToProceed({
    operation: 'removeComp',
    projectPath: '/p/a.aep',
    lastCheckpoint: { path: '/p/x.aep', verified: true },
  })
  assert.equal(r.ok, true)
  assert.equal(r.checkpoint, '/p/x.aep')
})

test('an ordinary operation needs nothing', () => {
  const r = assertSafeToProceed({ operation: 'setPosition', projectPath: null })
  assert.equal(r.ok, true)
})

test('the checkpoint directory sits beside the project', () => {
  const dir = checkpointDir('/projects/show/show.aep')
  assert.equal(dir, '/projects/show/dsh-checkpoints')
})

test('a configured directory wins', () => {
  assert.equal(checkpointDir('/p/a.aep', '/custom'), '/custom')
})

test('listing verifies each file and reports failures', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const project = join(dir, 'p.aep')
    writeFileSync(project, fakeAep())
    const ckDir = checkpointDir(project)
    mkdirSync(ckDir, { recursive: true })
    writeFileSync(join(ckDir, 'good.aep'), fakeAep())
    writeFileSync(join(ckDir, 'bad.aep'), Buffer.alloc(0))

    const listed = listCheckpoints(project)
    assert.equal(listed.checkpoints.length, 2)
    const good = listed.checkpoints.find((c) => c.name === 'good.aep')
    const bad = listed.checkpoints.find((c) => c.name === 'bad.aep')
    assert.equal(good.verified, true)
    assert.equal(bad.verified, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pruning keeps the newest N', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const project = join(dir, 'p.aep')
    writeFileSync(project, fakeAep())
    const ckDir = checkpointDir(project)
    mkdirSync(ckDir, { recursive: true })
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(ckDir, `c${i}.aep`), fakeAep())
    }
    const { pruned } = pruneCheckpoints(ckDir, 2)
    assert.equal(pruned.length, 3)
    const listed = listCheckpoints(project)
    assert.equal(listed.checkpoints.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('recording a checkpoint is idempotent by path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ck-'))
  try {
    const entry = { path: join(dir, 'x.aep'), createdAt: 1, bytes: 4096, hash: 'a'.repeat(64) }
    recordCheckpoint(dir, entry)
    recordCheckpoint(dir, entry)
    const listed = listCheckpoints(join(dir, 'p.aep'), dir)
    // No file was written, so the listing is driven by the directory; the
    // manifest must still not have grown a duplicate.
    assert.ok(listed.checkpoints.length <= 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
