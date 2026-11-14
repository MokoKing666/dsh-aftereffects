/**
 * End-to-end smoke test: template -> scene -> After Effects -> MP4.
 *
 * Run with the bundled Node runtime:
 *   node test/smoke.mjs
 *
 * It uses the real bridge and the real After Effects installation, so it takes
 * about a minute and needs a machine where After Effects is installed and not
 * already running interactively.
 */

import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { AeBridge, locate, locateAerender } from '../lib/bridge.js'
import { TEMPLATE_NAMES, buildTemplate, templateCatalog } from '../lib/templates.js'

const workDir = mkdtempSync(join(tmpdir(), 'dsh-ae-'))

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`)
}

const bridge = new AeBridge({ workDir, keepAliveMs: 240_000, launchTimeoutMs: 180_000 })

try {
  section('installation')
  const exe = locate()
  assert.ok(exe !== null, 'After Effects must be installed for this test')
  console.log('afterfx  :', exe)
  console.log('aerender :', locateAerender() ?? '(none)')

  section('template catalogue')
  const catalog = templateCatalog()
  assert.equal(catalog.length, TEMPLATE_NAMES.length)
  for (const entry of catalog) {
    const scene = buildTemplate(entry.name, {})
    assert.ok(Array.isArray(scene.layers) && scene.layers.length > 0, `${entry.name} produced no layers`)
    assert.ok(scene.width > 0 && scene.height > 0, `${entry.name} has no canvas`)
    assert.ok(scene.duration > 0, `${entry.name} has no duration`)
    console.log(`  ✓ ${entry.name.padEnd(13)} ${scene.width}x${scene.height} ${scene.duration}s ${scene.layers.length} layers`)
  }

  section('booting after effects')
  const launch = await bridge.ensure()
  console.log('launched:', launch.launched, '->', launch.alive)

  const env = await bridge.runtime('environment', {})
  console.log('version :', env.version, '| locale:', env.locale)
  console.log('templates:', (env.templates ?? []).length)

  section('building a composition')
  const scene = buildTemplate('title', {
    headline: 'DSH + AFTER EFFECTS',
    subhead: 'rendered from a chat message',
    theme: 'midnight',
    aspect: '16:9',
    duration: 3,
    fps: 24,
  })
  const built = await bridge.runtime('buildScene', scene)
  assert.ok(built.layerCount > 0, 'composition has no layers')
  const failed = built.layers.filter((l) => l.error)
  assert.equal(failed.length, 0, `layer errors: ${JSON.stringify(failed)}`)
  console.log('comp    :', built.comp, `${built.width}x${built.height}`, `${built.duration}s`)
  console.log('layers  :', built.layers.map((l) => l.name).join(', '))

  section('rendering a still')
  const still = await bridge.runtime('render', {
    comp: built.comp,
    output: join(workDir, 'still.png'),
    format: 'png',
    stillAt: 1.5,
  })
  assert.equal(still.file.exists, true, 'still was not written')
  assert.ok(statSync(still.file.path).size > 1000, 'still looks empty')
  console.log('still   :', still.file.path, still.file.size, 'bytes')

  section('rendering h.264')
  const mp4 = await bridge.runtime('render', {
    comp: built.comp,
    output: join(workDir, 'out.mp4'),
    format: 'mp4',
  }, { timeoutMs: 600_000 })
  assert.equal(mp4.done, true, `render did not finish: status ${mp4.status}`)
  assert.equal(mp4.file.exists, true, 'mp4 was not written')
  const size = statSync(mp4.file.path).size
  assert.ok(size > 5000, `mp4 looks empty (${size} bytes)`)
  console.log('mp4     :', mp4.file.path, size, 'bytes', `in ${mp4.ms}ms`)
  console.log('template:', mp4.template)

  section('png sequence')
  const seq = await bridge.runtime('render', {
    comp: built.comp,
    output: join(workDir, 'frames', 'shot.png'),
    format: 'png',
  }, { timeoutMs: 600_000 })
  // 3s at 24fps is 72 frames; a single file means the frame token was lost.
  assert.ok(seq.frames > 1, `png sequence produced ${seq.frames} frame(s)`)
  assert.ok(existsSync(seq.first), 'first frame missing')
  console.log('frames  :', seq.frames, 'in', seq.dir)
  console.log('first   :', seq.first)

  section('project round trip')
  const aep = join(workDir, 'smoke.aep')
  const saved = await bridge.runtime('saveProject', { path: aep })
  assert.equal(saved.exists, true, 'project was not saved')
  assert.ok(existsSync(aep), 'node cannot see the saved project')
  console.log('aep     :', saved.path, saved.size, 'bytes')

  section('error reporting')
  await assert.rejects(
    () => bridge.runtime('render', { comp: 'no-such-comp', output: join(workDir, 'x.mp4') }),
    (error) => {
      assert.equal(error.code, 'AE_JOB_FAILED')
      console.log('  ✓ unknown comp reported as', error.code, '-', error.message)
      return true
    },
  )

  console.log('\n✅ smoke test passed\n')
} catch (error) {
  console.error('\n❌ smoke test failed\n')
  console.error(error)
  console.error('\ndaemon log tail:')
  for (const line of bridge.logTail(20)) console.error('  ', line)
  process.exitCode = 1
} finally {
  await bridge.stop().catch(() => {})
  rmSync(workDir, { recursive: true, force: true })
}
