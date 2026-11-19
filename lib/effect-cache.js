/**
 * dsh-aftereffects — effect scan cache
 *
 * Enumerating every installed effect costs an After Effects round-trip and is
 * the same answer until someone installs or removes a plugin. This caches it,
 * keyed by the AE version that produced it, so a stale cache from a different
 * install can never be served as current.
 *
 * The file lives in the plugin's own work directory — never inside the user's
 * project, never inside the git checkout.
 *
 * @module dsh-aftereffects/effect-cache
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bumped when the cached record's shape changes; older files are discarded. */
export const CACHE_SCHEMA = 2

/** How long a cache entry is trusted before a refresh is suggested. */
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

/**
 * Classify an effect's vendor without guessing.
 *
 * The previous heuristic — "not ADBE/CC ⇒ third-party" — is wrong: After
 * Effects ships effects under many other prefixes, and third-party plugins
 * sometimes do use them. Only a positive signal earns a vendor; everything else
 * is `unknown` rather than a false claim either way.
 *
 * @param {string} matchName
 * @param {string} category the effect's own category string, when available
 * @returns {'adobe'|'third-party'|'unknown'}
 */
export function classifyVendor(matchName, category) {
  const mn = String(matchName ?? '')
  const cat = String(category ?? '')

  // Adobe's own effects use these matchName prefixes, plus a set of shipped
  // effect families that do not carry a prefix at all.
  const ADOBE_PREFIXES = [
    /^ADBE /, /^CC /, /^Pseudo\//, /^CINEMA /, /^Mocha /, /^Cycore/,
  ]
  const ADOBE_CATEGORIES = [
    /^Obsolete/i, /^Transition/i, /^Color Correction/i, /^Blur & Sharpen/i,
    /^Distort/i, /^Generate/i, /^Perspective/i, /^Stylize/i, /^Text/i,
    /^3D Channel/i, /^Audio/i, /^Channel/i, /^Expression Controls/i,
    /^Keying/i, /^Matte/i, /^Noise & Grain/i, /^Simulation/i, /^Time/i,
    /^Utility/i, /^Immersive Video/i,
  ]

  for (const re of ADOBE_PREFIXES) if (re.test(mn)) return 'adobe'
  for (const re of ADOBE_CATEGORIES) if (re.test(cat)) return 'adobe'

  // A category that names a plugin vendor is a positive third-party signal.
  // Only the categories a real install reports are listed; an unknown category
  // stays unknown.
  const VENDOR_CATEGORIES = [
    /Plugin Everything/i, /Red Giant/i, /RG /i, /Trapcode/i, /Video Copilot/i,
    /Boris FX/i, /Sapphire/i, /Mocha Pro/i, /Element 3D/i, /Rowbyte/i,
    /aescripts/i, /VideoHive/i, /Motion Array/i, /Animated Emoji/i, /Mettle/i,
    /^FX Console/i, /Universe/i, /Particular/i, /Saber/i, /Optical Flares/i,
  ]
  for (const re of VENDOR_CATEGORIES) if (re.test(cat)) return 'third-party'

  // A category that is clearly *not* one of Adobe's groups, and names no known
  // vendor, is still most likely third-party — but saying so is a guess, so it
  // stays unknown and the caller can filter on `category` instead.
  return 'unknown'
}

/** Absolute path of the cache file inside the work directory. */
export function cachePath(workDir) {
  return join(workDir, 'effect-cache.json')
}

/**
 * Read the cache.
 * @returns {{ok:false, reason:string, path:string} | {ok:true, record:object}}
 */
export function readCache(workDir, { aeVersion } = {}) {
  const path = cachePath(workDir)
  if (!existsSync(path)) return { ok: false, reason: 'cache-missing', path }

  let record
  try {
    record = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return { ok: false, reason: 'cache-unreadable', path }
  }

  if (record?.schema !== CACHE_SCHEMA) {
    return { ok: false, reason: `cache-schema-mismatch (found ${record?.schema}, want ${CACHE_SCHEMA})`, path }
  }
  // A cache produced by a different After Effects install describes a different
  // set of effects. Serving it would be worse than a miss.
  if (aeVersion !== undefined && record.aeVersion !== aeVersion) {
    return { ok: false, reason: `cache-version-mismatch (cached ${record.aeVersion}, running ${aeVersion})`, path }
  }
  if (!Array.isArray(record.effects)) {
    return { ok: false, reason: 'cache-malformed', path }
  }

  const ageMs = Date.now() - Number(record.scannedAt ?? 0)
  return {
    ok: true,
    path,
    ageMs,
    stale: !Number.isFinite(ageMs) || ageMs > CACHE_TTL_MS,
    record,
  }
}

/** Persist a scan result. Never throws: a cache write failure must not fail the scan. */
export function writeCache(workDir, record) {
  const path = cachePath(workDir)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const payload = {
      schema: CACHE_SCHEMA,
      aeVersion: record.aeVersion,
      scannedAt: record.scannedAt ?? Date.now(),
      total: record.effects?.length ?? 0,
      effects: record.effects ?? [],
    }
    writeFileSync(path, JSON.stringify(payload), 'utf8')
    return { ok: true, path, bytes: statSync(path).size }
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error) }
  }
}

/** Remove the cache. */
export function clearCache(workDir) {
  const path = cachePath(workDir)
  try {
    rmSync(path, { force: true })
    return { ok: true, path }
  } catch (error) {
    return { ok: false, path, error: String(error?.message ?? error) }
  }
}
