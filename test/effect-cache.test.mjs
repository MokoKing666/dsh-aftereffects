/**
 * Effect cache and vendor classification tests.
 *
 * The vendor rule is the part worth testing: the old heuristic labelled
 * anything without an ADBE/CC prefix as third-party, which is a claim, not a
 * classification. Unknown must stay unknown.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  classifyVendor, readCache, writeCache, clearCache, cachePath, CACHE_SCHEMA,
} from '../lib/effect-cache.js'

test('ADBE-prefixed effects are Adobe', () => {
  assert.equal(classifyVendor('ADBE Glo2', ''), 'adobe')
  assert.equal(classifyVendor('ADBE Gaussian Blur 2', ''), 'adobe')
})

test('CC-prefixed effects are Adobe', () => {
  assert.equal(classifyVendor('CC Cross Blur', ''), 'adobe')
})

test('Adobe categories classify as Adobe even without a prefix', () => {
  assert.equal(classifyVendor('SomeEffect', 'Blur & Sharpen'), 'adobe')
  assert.equal(classifyVendor('SomeEffect', 'Expression Controls'), 'adobe')
})

test('a known vendor category is third-party', () => {
  assert.equal(classifyVendor('PEDG', 'Plugin Everything'), 'third-party')
  assert.equal(classifyVendor('Universe_Blur_Blur_Premium', 'RG Blurs and Glows'), 'third-party')
})

test('an unrecognised effect is unknown, not third-party', () => {
  // This is the fix: no prefix and no known vendor is a guess, so it stays
  // unknown rather than being asserted as third-party.
  assert.equal(classifyVendor('WeirdEffectName', ''), 'unknown')
  assert.equal(classifyVendor('SomethingElse', 'Custom Group'), 'unknown')
})

test('an empty matchName is unknown', () => {
  assert.equal(classifyVendor('', ''), 'unknown')
})

test('cache round-trips', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    const effects = [
      { displayName: 'Glow', matchName: 'ADBE Glo2', category: 'Stylize', obsolete: false },
      { displayName: 'Deep Glow', matchName: 'PEDG', category: 'Plugin Everything', obsolete: false },
    ]
    const w = writeCache(dir, { aeVersion: '27.0x78', scannedAt: Date.now(), effects })
    assert.equal(w.ok, true)

    const r = readCache(dir, { aeVersion: '27.0x78' })
    assert.equal(r.ok, true)
    assert.equal(r.record.aeVersion, '27.0x78')
    assert.equal(r.record.effects.length, 2)
    assert.equal(r.record.schema, CACHE_SCHEMA)
    assert.equal(r.stale, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cache from a different AE version is rejected, not served', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    writeCache(dir, { aeVersion: '27.0x78', effects: [] })
    const r = readCache(dir, { aeVersion: '26.5x89' })
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('version-mismatch'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a cache with an old schema is rejected', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    writeFileSync(cachePath(dir), JSON.stringify({ schema: 1, effects: [] }))
    const r = readCache(dir)
    assert.equal(r.ok, false)
    assert.ok(r.reason.includes('schema-mismatch'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt cache is reported, not thrown', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    writeFileSync(cachePath(dir), '{ not json')
    const r = readCache(dir)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'cache-unreadable')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a missing cache reports missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    const r = readCache(dir)
    assert.equal(r.ok, false)
    assert.equal(r.reason, 'cache-missing')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an ancient cache is flagged stale but still readable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    writeCache(dir, {
      aeVersion: '27.0x78',
      scannedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
      effects: [{ matchName: 'ADBE Glo2' }],
    })
    const r = readCache(dir, { aeVersion: '27.0x78' })
    assert.equal(r.ok, true)
    assert.equal(r.stale, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clear removes the cache', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-cache-'))
  try {
    writeCache(dir, { aeVersion: 'x', effects: [] })
    assert.ok(existsSync(cachePath(dir)))
    clearCache(dir)
    assert.equal(existsSync(cachePath(dir)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
