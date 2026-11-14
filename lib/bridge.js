/**
 * dsh-aftereffects — After Effects process bridge
 *
 * After Effects has no automation server: the only reliable way to drive it
 * from another process is to run ExtendScript inside it. This module owns that
 * channel.
 *
 *   - `locate()` finds AfterFX.exe (configured path, then the usual install
 *     roots, then the newest non-beta release).
 *   - `ensure()` boots a headless After Effects (`-noui -r <daemon.jsx>`) and
 *     waits for its heartbeat file.
 *   - `call()` drops a job file into the daemon's queue and waits for the
 *     matching result file.
 *
 * The daemon itself is `lib/ae-daemon.jsx`; the API surface it exposes lives in
 * `lib/ae-runtime.jsx`. Both are ES3 ExtendScript and never loaded by Node.
 *
 * @module dsh-aftereffects/bridge
 */

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(HERE, '..')

/** How long a heartbeat may age before the daemon counts as gone. */
const HEARTBEAT_STALE_MS = 15_000

/** How long a freshly spawned After Effects may take to report in. */
const DEFAULT_LAUNCH_TIMEOUT_MS = 120_000

/** How long one job may run before the bridge gives up on it. */
const DEFAULT_JOB_TIMEOUT_MS = 900_000

/** After Effects writes a startup banner; keep it out of the terminal. */
const AE_NOISE = /GPU (Warning|Error)|CRPreferences|Unhandled tagCode|libpng warning|^$/

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

/* -------------------------------------------------------------------------- */
/* locating After Effects                                                     */
/* -------------------------------------------------------------------------- */

function listDir(path) {
  try {
    return readdirSync(path, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Version-aware ordering so "2026" beats "2025" and a Beta loses to a release. */
function versionRank(name) {
  const year = /(\d{4})/.exec(name)
  const beta = /beta/i.test(name) ? -1 : 0
  return [year ? Number(year[1]) : 0, beta]
}

/**
 * Candidate executables, best first. The configured path wins outright; after
 * that we prefer the newest non-beta release installed under Program Files.
 */
function candidates(configured) {
  const found = []
  if (typeof configured === 'string' && configured.trim() !== '') {
    const p = configured.trim()
    // Accept either the install folder or the executable itself.
    found.push(/\.exe$/i.test(p) ? p : join(p, 'Support Files', 'AfterFX.exe'))
    found.push(/\.exe$/i.test(p) ? p : join(p, 'AfterFX.exe'))
  }

  const roots = [
    process.env['PROGRAMFILES'] || 'C:\\Program Files',
    process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)',
    '/Applications',
  ]

  const installs = []
  for (const root of roots) {
    const adobe = root.endsWith('/Applications') ? root : join(root, 'Adobe')
    for (const entry of listDir(adobe)) {
      if (!/^Adobe After Effects/i.test(entry.name)) continue
      installs.push({ name: entry.name, dir: join(adobe, entry.name) })
    }
  }

  installs.sort((a, b) => {
    const ra = versionRank(a.name)
    const rb = versionRank(b.name)
    return rb[0] - ra[0] || rb[1] - ra[1]
  })

  for (const install of installs) {
    found.push(join(install.dir, 'Support Files', 'AfterFX.exe'))
    found.push(join(install.dir, 'AfterFX.exe'))
    found.push(join(install.dir, 'Contents', 'MacOS', 'After Effects'))
  }

  return found
}

/** Absolute path of the After Effects executable, or null when it is not installed. */
export function locate(configured) {
  for (const candidate of candidates(configured)) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
    } catch {
      /* unreadable candidate: keep looking */
    }
  }
  return null
}

/** `aerender.exe` beside a discovered `AfterFX.exe`. */
export function locateAerender(configured) {
  const exe = locate(configured)
  if (exe === null) return null
  const sibling = join(dirname(exe), 'aerender.exe')
  return existsSync(sibling) ? sibling : null
}

/** Default scratch directory: `$DSH_HOME/aftereffects`. */
export function defaultWorkDir() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'aftereffects')
}

/* -------------------------------------------------------------------------- */
/* the bridge                                                                 */
/* -------------------------------------------------------------------------- */

export class AeBridge {
  /**
   * @param {object} options
   * @param {string} [options.executable] configured AfterFX.exe or install folder
   * @param {string} [options.workDir] scratch directory for jobs and results
   * @param {number} [options.launchTimeoutMs]
   * @param {number} [options.jobTimeoutMs]
   * @param {number} [options.keepAliveMs] daemon self-termination budget
   * @param {(line: string) => void} [options.log]
   */
  constructor(options = {}) {
    this.executable = options.executable
    this.launchTimeoutMs = options.launchTimeoutMs ?? DEFAULT_LAUNCH_TIMEOUT_MS
    this.jobTimeoutMs = options.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS
    this.keepAliveMs = options.keepAliveMs ?? 30 * 60 * 1000
    this.log = options.log ?? (() => {})

    // An empty string is a configured-but-blank value, not a directory: fall
    // back to the default rather than rooting the scratch tree at "".
    const configured = typeof options.workDir === 'string' ? options.workDir.trim() : ''
    this.root = configured !== '' ? resolve(configured) : defaultWorkDir()

    this.jobsDir = join(this.root, 'jobs')
    this.resultsDir = join(this.root, 'results')
    this.heartbeatFile = join(this.root, 'heartbeat')
    this.stopFile = join(this.root, 'stop.flag')
    this.daemonLog = join(this.root, 'daemon.log')
    this.fatalFile = join(this.root, 'fatal.txt')

    /** @type {import('node:child_process').ChildProcess | null} */
    this.child = null
    this.launching = null
    this.counter = 0
  }

  /** Create the scratch layout and clear stale queue entries. */
  prepare() {
    mkdirSync(this.jobsDir, { recursive: true })
    mkdirSync(this.resultsDir, { recursive: true })
    for (const dir of [this.jobsDir, this.resultsDir]) {
      for (const entry of listDir(dir)) {
        try {
          rmSync(join(dir, entry.name), { force: true })
        } catch {
          /* a job another process still owns */
        }
      }
    }
    rmSync(this.stopFile, { force: true })
    rmSync(this.fatalFile, { force: true })
    rmSync(this.heartbeatFile, { force: true })
    return this.root
  }

  /** Epoch milliseconds of the last daemon heartbeat, or null. */
  heartbeat() {
    try {
      return Number(readFileSync(this.heartbeatFile, 'utf8').trim())
    } catch {
      return null
    }
  }

  /** Whether a daemon is alive right now. */
  isAlive() {
    const beat = this.heartbeat()
    if (beat === null || !Number.isFinite(beat)) return false
    return Date.now() - beat < HEARTBEAT_STALE_MS
  }

  /** Human-readable daemon state for status reporting. */
  state() {
    const beat = this.heartbeat()
    if (beat === null) return { alive: false, reason: 'no heartbeat', ageMs: null }
    const age = Date.now() - beat
    return {
      alive: age < HEARTBEAT_STALE_MS,
      reason: age < HEARTBEAT_STALE_MS ? 'running' : 'heartbeat stale',
      ageMs: age,
    }
  }

  /** Build the bootstrap script the daemon is launched with. */
  bootstrapScript() {
    const config = {
      root: this.root.replace(/\\/g, '/'),
      runtime: join(HERE, 'ae-runtime.jsx').replace(/\\/g, '/'),
      lifetimeMs: this.keepAliveMs,
    }
    const template = readFileSync(join(HERE, 'ae-daemon.jsx'), 'utf8')
    return template.replace('__DSH_CONFIG__', JSON.stringify(config))
  }

  /** Read the daemon's own fatal report, when it produced one. */
  fatal() {
    try {
      return readFileSync(this.fatalFile, 'utf8').trim()
    } catch {
      return null
    }
  }

  /**
   * Boot a headless After Effects unless one is already answering.
   * Concurrent callers share one launch.
   */
  async ensure() {
    if (this.isAlive()) return { launched: false, alive: true }
    if (this.launching !== null) return this.launching

    this.launching = this.#launch().finally(() => {
      this.launching = null
    })
    return this.launching
  }

  async #launch() {
    const exe = locate(this.executable)
    if (exe === null) {
      const error = new Error(
        'Adobe After Effects was not found. Set `executable` in the plugin config to the AfterFX.exe path, '
        + 'or to the install folder such as C:\\Program Files\\Adobe\\Adobe After Effects 2026.',
      )
      error.code = 'AE_NOT_INSTALLED'
      throw error
    }

    this.prepare()

    const scriptPath = join(this.root, 'daemon-bootstrap.jsx')
    writeFileSync(scriptPath, this.bootstrapScript(), 'utf8')

    this.log(`launching ${exe}`)

    const child = spawn(exe, ['-noui', '-r', scriptPath], {
      detached: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child

    let stderrTail = ''
    const swallow = (chunk) => {
      const body = String(chunk)
      stderrTail = (stderrTail + body).slice(-4000)
      for (const line of body.split(/\r?\n/)) {
        if (line.trim() !== '' && !AE_NOISE.test(line)) this.log(`[ae] ${line}`)
      }
    }
    child.stdout?.on('data', swallow)
    child.stderr?.on('data', swallow)

    let exited = null
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      if (this.child === child) this.child = null
      this.log(`after effects exited code=${code} signal=${signal}`)
    })

    const deadline = Date.now() + this.launchTimeoutMs
    while (Date.now() < deadline) {
      await sleep(400)

      const fatal = this.fatal()
      if (fatal !== null) {
        const error = new Error(`After Effects could not start the runtime: ${fatal}`)
        error.code = 'AE_RUNTIME_FAILED'
        throw error
      }

      if (this.isAlive()) {
        this.log('daemon reported in')
        return { launched: true, alive: true, executable: exe }
      }

      if (exited !== null) {
        const error = new Error(
          `After Effects exited during startup (code ${exited.code}). `
          + 'A running After Effects window blocks the headless instance; close it and retry.',
        )
        error.code = 'AE_EXITED'
        error.detail = stderrTail.slice(-1200)
        throw error
      }
    }

    const error = new Error(
      `After Effects did not report in within ${Math.round(this.launchTimeoutMs / 1000)}s. `
      + 'An already open After Effects window blocks the headless instance; close it and retry.',
    )
    error.code = 'AE_LAUNCH_TIMEOUT'
    throw error
  }

  /** Stop the daemon and wait for the process to go. */
  async stop() {
    mkdirSync(this.root, { recursive: true })
    writeFileSync(this.stopFile, String(Date.now()), 'utf8')
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (this.heartbeat() === null) break
      await sleep(200)
    }
    if (this.child !== null && this.child.exitCode === null) {
      try {
        this.child.kill()
      } catch {
        /* already gone */
      }
    }
    this.child = null
    return { stopped: true }
  }

  /**
   * Run one job against the live daemon.
   *
   * @param {{ runtime?: string, code?: string, payload?: unknown }} job
   * @param {{ timeoutMs?: number, ensure?: boolean }} [options]
   * @returns {Promise<unknown>} the daemon's JSON value
   */
  async call(job, options = {}) {
    if (options.ensure !== false) await this.ensure()

    const id = `${Date.now()}-${(this.counter = (this.counter + 1) % 100000)}-${randomUUID().slice(0, 8)}`
    const jobPath = join(this.jobsDir, `${id}.job`)
    const resultPath = join(this.resultsDir, `${id}.json`)

    writeFileSync(jobPath, JSON.stringify(job), 'utf8')

    const timeout = options.timeoutMs ?? this.jobTimeoutMs
    const deadline = Date.now() + timeout
    let waited = 0

    while (Date.now() < deadline) {
      await sleep(120)
      waited += 120

      let raw = null
      try {
        raw = readFileSync(resultPath, 'utf8')
      } catch {
        // not done yet
      }

      if (raw !== null) {
        let parsed
        try {
          parsed = JSON.parse(raw)
        } catch {
          continue // still being written
        }
        rmSync(resultPath, { force: true })
        if (parsed.ok === true) return parsed.value
        const error = new Error(parsed.error ?? 'After Effects reported a failure')
        error.code = 'AE_JOB_FAILED'
        error.line = parsed.line
        throw error
      }

      // A daemon that died mid-job will never answer; report that instead of
      // waiting out the full timeout.
      if (waited > 5_000 && !this.isAlive()) {
        const fatal = this.fatal()
        const error = new Error(
          fatal !== null
            ? `After Effects stopped while running the job: ${fatal}`
            : 'After Effects stopped while running the job (the daemon heartbeat disappeared).',
        )
        error.code = 'AE_DIED'
        throw error
      }
    }

    rmSync(jobPath, { force: true })
    const error = new Error(`After Effects did not finish within ${Math.round(timeout / 1000)}s.`)
    error.code = 'AE_JOB_TIMEOUT'
    throw error
  }

  /** Named runtime entry (`DSH.<name>`) with a payload. */
  runtime(name, payload, options) {
    return this.call({ runtime: name, payload }, options)
  }

  /** Tail of the daemon log, for diagnostics. */
  logTail(lines = 20) {
    try {
      const text = readFileSync(this.daemonLog, 'utf8')
      return text.trimEnd().split(/\r?\n/).slice(-lines)
    } catch {
      return []
    }
  }
}

export { PACKAGE_ROOT }
