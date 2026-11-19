/**
 * dsh-aftereffects — checkpoint vault
 *
 * A checkpoint is only useful if it is verified. `app.project.save()` followed
 * by `File.copy()` can report success while producing a zero-byte file, and a
 * restore that overwrites the wrong project is worse than no restore at all.
 * Everything here is a precondition, a verification, or a refusal.
 *
 * The AE side creates the copy; this side owns the manifest, integrity checks,
 * listing, and pruning, because those are file-system facts.
 *
 * @module dsh-aftereffects/checkpoint
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** Raised when a destructive operation is attempted without required protection. */
export class CheckpointRequiredError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'CheckpointRequiredError'
    this.code = 'CHECKPOINT_REQUIRED'
    this.detail = detail
  }
}

/** Operations that can destroy a project and therefore need a checkpoint. */
export const HIGH_RISK_OPERATIONS = new Set([
  'resetProject',
  'removeComp',
  'removeLayer',
  'removeLayers',
  'clearEffects',
  'bulkLayerStructure',
  'replaceFootage',
  'restoreCheckpoint',
])

/**
 * Decide whether an operation must be protected.
 * @param {string} operation
 * @param {object} [context] e.g. { layerCount, compCount }
 * @returns {{ required: boolean, why: string }}
 */
export function requiresCheckpoint(operation, context = {}) {
  if (!HIGH_RISK_OPERATIONS.has(operation)) return { required: false, why: '' }

  // A single-layer removal in a 3-layer comp is not the same risk as wiping 40
  // layers, but both are irreversible without a snapshot, so both are gated.
  const counts = []
  if (typeof context.layerCount === 'number') counts.push(`${context.layerCount} layer(s)`)
  if (typeof context.compCount === 'number') counts.push(`${context.compCount} comp(s)`)

  return {
    required: true,
    why: counts.length > 0
      ? `${operation} affects ${counts.join(' and ')} and cannot be undone after the fact`
      : `${operation} is destructive and cannot be undone after the fact`,
  }
}

/** Directory holding a project's checkpoints. */
export function checkpointDir(projectPath, configured) {
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  if (!projectPath) return null
  // Both separators are handled: this runs on Windows and macOS, and a project
  // path may arrive from After Effects using either.
  const lastSep = Math.max(projectPath.lastIndexOf('/'), projectPath.lastIndexOf('\\'))
  if (lastSep < 0) return 'dsh-checkpoints'
  const parent = projectPath.slice(0, lastSep)
  const sep = projectPath[lastSep] === '\\' ? '\\' : '/'
  return `${parent}${sep}dsh-checkpoints`
}

/** Manifest path inside the checkpoint directory. */
function manifestPath(dir) {
  return join(dir, 'manifest.json')
}

function readManifest(dir) {
  const path = manifestPath(dir)
  if (!existsSync(path)) return { schema: 1, checkpoints: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed.checkpoints)) return { schema: 1, checkpoints: [] }
    return parsed
  } catch {
    // A corrupt manifest must not hide the .aep files that do exist; an empty
    // list plus a rebuilt entry on the next checkpoint is the safer reading.
    return { schema: 1, checkpoints: [], corrupt: true }
  }
}

function writeManifest(dir, manifest) {
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(manifestPath(dir), JSON.stringify(manifest, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** SHA-256 of a file, or null when unreadable. */
export function hashFile(path) {
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Verify a checkpoint file is a usable copy.
 *
 * @param {string} path
 * @param {{minBytes?: number, expectHash?: string}} [options]
 * @returns {{ok:boolean, reason?:string, bytes?:number, hash?:string}}
 */
export function verifyCheckpoint(path, options = {}) {
  if (!existsSync(path)) return { ok: false, reason: 'file does not exist' }

  let stat
  try {
    stat = statSync(path)
  } catch (error) {
    return { ok: false, reason: `cannot stat: ${error.message}` }
  }
  if (!stat.isFile()) return { ok: false, reason: 'not a regular file' }

  const minBytes = options.minBytes ?? 1024
  if (stat.size < minBytes) {
    return { ok: false, bytes: stat.size, reason: `only ${stat.size} bytes; an .aep is never this small` }
  }

  // After Effects writes a binary project; the first four bytes are a stable
  // signature ("RIFX" or "AEGP"-family). Checking it catches a file that was
  // created but never filled.
  let head
  try {
    const fd = readFileSync(path, { encoding: null, flag: 'r' })
    head = fd.subarray(0, 4).toString('ascii')
  } catch (error) {
    return { ok: false, bytes: stat.size, reason: `cannot read: ${error.message}` }
  }
  if (!/^(RIFX|AEGP|RIFF)/.test(head)) {
    return {
      ok: false, bytes: stat.size, head,
      reason: `unexpected file signature "${head}"; this does not look like an .aep project`,
    }
  }

  const hash = hashFile(path)
  if (options.expectHash && hash !== options.expectHash) {
    return { ok: false, bytes: stat.size, hash, reason: 'content hash does not match the recorded checkpoint' }
  }

  return { ok: true, bytes: stat.size, hash, head }
}

/** Record one checkpoint in the manifest. */
export function recordCheckpoint(dir, entry) {
  const manifest = readManifest(dir)
  const existing = manifest.checkpoints.findIndex((c) => c.path === entry.path)
  if (existing >= 0) manifest.checkpoints[existing] = entry
  else manifest.checkpoints.push(entry)
  // Newest first, so prune trims the oldest.
  manifest.checkpoints.sort((a, b) => Number(b.createdAt ?? 0) - Number(a.createdAt ?? 0))
  writeManifest(dir, manifest)
  return manifest
}

/** List checkpoints, verifying each file as it is read. */
export function listCheckpoints(projectPath, configured) {
  const dir = checkpointDir(projectPath, configured)
  if (!dir || !existsSync(dir)) return { dir, checkpoints: [] }

  const manifest = readManifest(dir)
  const byPath = new Map(manifest.checkpoints.map((c) => [c.path, c]))

  // Trust the directory listing over the manifest: a file added by hand is
  // still a checkpoint, and a manifest entry whose file is gone is a lie.
  const files = readdirSync(dir).filter((name) => /\.aep$/i.test(name))
  const checkpoints = files.map((name) => {
    const full = join(dir, name)
    const recorded = byPath.get(full) ?? {}
    const verified = verifyCheckpoint(full)
    let createdAt = Number(recorded.createdAt ?? 0)
    if (!createdAt) {
      try { createdAt = statSync(full).mtimeMs } catch { createdAt = 0 }
    }
    return {
      name,
      path: full,
      bytes: verified.bytes ?? 0,
      createdAt,
      label: recorded.label ?? '',
      verified: verified.ok,
      reason: verified.reason ?? '',
      hash: verified.hash ?? '',
    }
  })

  checkpoints.sort((a, b) => b.createdAt - a.createdAt)
  return { dir, checkpoints }
}

/** Keep at most `keep` checkpoints, deleting the oldest verified ones. */
export function pruneCheckpoints(dir, keep) {
  if (!dir || !existsSync(dir)) return { pruned: [] }
  const files = readdirSync(dir)
    .filter((name) => /\.aep$/i.test(name))
    .map((name) => {
      const full = join(dir, name)
      let mtime = 0
      try { mtime = statSync(full).mtimeMs } catch { mtime = 0 }
      return { name, full, mtime }
    })
    .sort((a, b) => b.mtime - a.mtime)

  const pruned = []
  for (const file of files.slice(keep)) {
    try {
      rmSync(file.full, { force: true })
      pruned.push(file.name)
    } catch {
      /* leave it; a failed prune is not worth failing the checkpoint */
    }
  }
  return { pruned }
}

/**
 * Assert that a destructive operation may proceed.
 *
 * This is the program-level gate: the system prompt asks a model to checkpoint,
 * and this function refuses when it did not. A model that skips the call gets an
 * error instead of a destroyed project.
 *
 * @param {{operation:string, projectPath:string|null, lastCheckpoint?:object|null, context?:object}} input
 * @throws {CheckpointRequiredError}
 */
export function assertSafeToProceed(input) {
  const gate = requiresCheckpoint(input.operation, input.context ?? {})
  if (!gate.required) return { ok: true }

  if (!input.projectPath) {
    throw new CheckpointRequiredError(
      `refusing "${input.operation}": the project has never been saved, so no checkpoint can be created. `
        + 'Save the project first (ae_compose with `save`, or Ctrl+S in After Effects), then retry.',
      { operation: input.operation, reason: 'untitled-project' },
    )
  }

  const last = input.lastCheckpoint
  if (!last || !last.verified) {
    throw new CheckpointRequiredError(
      `refusing "${input.operation}": ${gate.why}, and no verified checkpoint exists. `
        + 'Call ae_checkpoint first (it returns `verified: true` and a path), then retry.',
      { operation: input.operation, reason: 'no-checkpoint', why: gate.why },
    )
  }

  return { ok: true, checkpoint: last.path }
}
