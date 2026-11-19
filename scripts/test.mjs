/**
 * `npm test` — unit tests first, then the AE integration suite when it can run.
 *
 * The integration half needs a real After Effects install and no interactive
 * AE window. When that is not available it is reported as NOT RUN, never as a
 * pass: a green build must not imply AE was exercised.
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { locate } from '../lib/bridge.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function run(label, args) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`)
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit' })
  if (result.error) {
    console.error(`  could not start: ${result.error.message}`)
    return false
  }
  return result.status === 0
}

/* ------------------------------------------------------------------ unit */

const unitFiles = readdirSync(join(ROOT, 'test'))
  .filter((name) => name.endsWith('.test.mjs'))
  .map((name) => join('test', name))

const unitOk = run(`unit tests (${unitFiles.length} files)`, ['--test', ...unitFiles])
if (!unitOk) {
  console.error('\nunit tests failed — stopping before the integration suite')
  process.exit(1)
}

/* ----------------------------------------------------------- integration */

const exe = locate()
if (exe === null) {
  console.log('\n── AE integration ─────────────────────────────────────────────')
  console.log('  NOT RUN — After Effects is not installed on this machine')
  console.log('\nunit suite passed; integration NOT RUN')
  process.exit(0)
}

console.log('\n── AE integration ─────────────────────────────────────────────')
console.log(`  After Effects found: ${exe}`)
const integrationOk = run('integration', [join('scripts', 'test-ae.mjs')])

if (!integrationOk) {
  console.error('\nAE integration failed')
  process.exit(1)
}

console.log('\nall suites passed')
