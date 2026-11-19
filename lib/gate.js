/**
 * dsh-aftereffects — 统一执行门禁
 *
 * `checkpoint.js` 提供判定规则和一个纯函数 gate；这个模块负责把它接到
 * 真正的执行路径上。区别很重要：一个门禁如果在执行前没有被调用，它就只是
 * 一个可以被忽略的建议。
 *
 * 覆盖范围（本轮实测确认的真实破坏性路径）：
 *   - `ae_compose` 替换同名合成（默认行为，删掉旧合成）
 *   - `ae_compose` 的 `scene.resetProject`（清空整个工程）
 *   - `ae_run_script`：默认视为写操作，除非显式声明只读
 *
 * 门禁的判定输入必须是**当前**工程状态：一个昨天做的备份不能为今天的
 * resetProject 背书，所以除非调用方要求 `reuseSeconds` 内刚做过的备份，
 * 否则每次高风险操作都会做一份新鲜的。
 *
 * @module dsh-aftereffects/gate
 */

import { requiresCheckpoint, listCheckpoints, verifyCheckpoint } from './checkpoint.js'

/** 一份备份在多少秒内可以被重复使用，避免同一批操作反复复制大文件。 */
export const REUSE_WINDOW_MS = 10 * 60 * 1000

/**
 * 通过 bridge 读取当前工程状态。
 * @param {object} bridge
 * @param {(task: Function) => Promise<any>} serial
 * @returns {Promise<{file: string|null, saved: boolean, compCount: number, compNames: string[], checkpointDir: string|null}>}
 */
export async function readProjectStatus(bridge, serial) {
  try {
    const status = await serial(() => bridge.runtime('pro:projectStatus', {}))
    return {
      file: status?.file ?? null,
      saved: status?.saved === true,
      compCount: Number(status?.compCount ?? 0),
      compNames: Array.isArray(status?.compNames) ? status.compNames.map(String) : [],
      checkpointDir: status?.checkpointDir ?? null,
    }
  } catch {
    // A status read failure must not be read as "safe". `compNames: null` is the
    // honest signal: "unknown", not "empty" — the caller must not read it as
    // "there is nothing to replace".
    return { file: null, saved: false, compCount: 0, compNames: null, checkpointDir: null }
  }
}

/**
 * 找一个仍然有效的备份：属于当前工程、通过校验、且足够新。
 * @returns {Promise<{path:string, verified:boolean}|null>}
 */
export async function findUsableCheckpoint(projectPath, configuredDir, options = {}) {
  if (!projectPath) return null
  const windowMs = options.reuseWithinMs ?? REUSE_WINDOW_MS

  let listed
  try {
    listed = listCheckpoints(projectPath, configuredDir ?? undefined)
  } catch {
    return null
  }

  const now = Date.now()
  for (const candidate of listed.checkpoints) {
    if (!candidate.verified) continue
    const age = now - Number(candidate.createdAt ?? 0)
    // An ancient checkpoint is still a valid file, but "an old backup exists" is
    // not the same claim as "this operation is protected". Only a recent one
    // satisfies the reuse window; otherwise the caller makes a fresh one.
    if (!Number.isFinite(age) || age > windowMs) continue
    const verify = verifyCheckpoint(candidate.path)
    if (!verify.ok) continue
    return { path: candidate.path, verified: true, ageMs: age }
  }
  return null
}

/**
 * 在破坏性操作之前强制建立（或复用）一份**已验证**的备份。
 *
 * @param {object} input
 * @param {object} input.bridge
 * @param {(task: Function) => Promise<any>} input.serial
 * @param {string} input.operation 见 HIGH_RISK_OPERATIONS
 * @param {object} [input.context]
 * @param {boolean} [input.fresh] 忽略可复用窗口，强制新建备份
 * @param {number} [input.keep] 保留份数
 * @returns {Promise<{ok:boolean, checkpoint?:string, reused?:boolean, reason?:string}>}
 * @throws {CheckpointRequiredError} 无法建立可信保护时
 */
export async function guardDestructive(input) {
  const { bridge, serial, operation, context = {}, fresh = true, keep = 20 } = input

  // 1. 判断这个操作是否真的需要保护。不需要就立即返回——否则每次普通写入
  //    都会复制一份工程，保护变成噪音，噪音会被绕过。
  const gate = requiresCheckpoint(operation, context)
  if (!gate.required) {
    return { ok: true, reused: true, checkpoint: null, reason: 'not-a-high-risk-operation' }
  }

  const status = await readProjectStatus(bridge, serial)

  // 2. 未保存的工程无法备份，直接拒绝。不能因为"没有东西可备份"就放行。
  if (!status.file) {
    const error = new Error(
      `拒绝执行 ${operation}：工程尚未保存，无法创建可信备份。`
        + '先保存一次（ae_compose 的 save 参数，或在 AE 里 Ctrl+S），再重试。',
    )
    error.code = 'CHECKPOINT_UNAVAILABLE'
    throw error
  }

  // 3. 只有明确允许复用时才找旧备份；默认每次做新鲜的。
  const existing = fresh ? null : await findUsableCheckpoint(status.file, status.checkpointDir)
  if (existing && existing.verified) {
    return { ok: true, checkpoint: existing.path, reused: true }
  }

  // 4. 创建备份并校验。校验失败就等于没有保护。
  const created = await serial(() => bridge.runtime('pro:checkpoint', { keep }))
  if (!created || created.skipped === true) {
    const error = new Error(
      `无法为 ${operation} 创建备份：${created?.reason ?? 'checkpoint returned nothing'}。`
        + '先把工程保存一次，再重试。',
    )
    error.code = 'CHECKPOINT_UNAVAILABLE'
    throw error
  }

  const path = String(created.checkpoint ?? '')
  const verify = verifyCheckpoint(path)
  if (!verify.ok) {
    const error = new Error(
      `为 ${operation} 创建的备份未通过校验：${verify.reason}。操作已拒绝。`,
    )
    error.code = 'CHECKPOINT_INVALID'
    throw error
  }

  return { ok: true, checkpoint: path, reused: false, bytes: verify.bytes }
}

/**
 * Decide whether a `buildScene` call must be gated, and gate it.
 *
 * Two real destructive paths in the AE runtime, both handled here so every
 * caller (ae_compose, ae_template) gets the same protection:
 *
 *   1. `scene.resetProject === true` wipes the whole project.
 *   2. `buildScene` deletes an existing comp with the same name unless
 *      `scene.replace === false` — that is the default, so a plain re-build is
 *      destructive and must not be mistaken for "just adding a comp".
 *
 * A build that creates the first comp in an empty project is not gated: there
 * is nothing to lose, and demanding a backup for it would make the protection
 * noise — and noise gets routed around.
 *
 * @param {object} input
 * @param {object} input.bridge
 * @param {(task: Function) => Promise<any>} input.serial
 * @param {string} [input.compName] name the scene will use
 * @param {boolean} [input.resetProject]
 * @param {boolean} [input.replace] scene.replace; undefined means "the default", i.e. true
 * @returns {Promise<{gated:boolean, checkpoint?:string, reason:string}>}
 * @throws 当无法建立可信保护时
 */
export async function guardSceneBuild(input) {
  const { bridge, serial } = input
  const willReset = input.resetProject === true
  const willReplace = input.replace !== false

  if (!willReset && !willReplace) {
    return { gated: false, reason: 'replace=false 且未要求清空工程，不会删除任何已有内容' }
  }

  const status = await readProjectStatus(bridge, serial)

  let atRisk
  if (willReset) {
    // resetProject deletes everything, so any content at all is enough to
    // require protection — including an unsaved project holding work.
    atRisk = status.compCount > 0 || status.saved
  } else {
    atRisk = willReplaceSomething(status.compNames, input.compName)
  }

  if (!atRisk) {
    return {
      gated: false,
      reason: willReset
        ? '工程是空的，resetProject 没有可毁内容'
        : `工程里没有同名合成 ${input.compName ?? '(未命名)'}，本次只是新建`,
    }
  }

  const guarded = await guardDestructive({
    bridge,
    serial,
    operation: willReset ? 'resetProject' : 'replaceComp',
    context: { compCount: status.compCount },
    fresh: true,
  })

  return {
    gated: true,
    checkpoint: guarded.checkpoint,
    reason: `${willReset ? 'resetProject' : '替换同名合成'} 前已备份`,
  }
}

/**
 * Will this build delete an existing comp?
 *
 * `compNames === null` means the status probe failed, and a failed probe must
 * never be read as "nothing to lose" — the answer is then "yes, assume it will".
 */
function willReplaceSomething(compNames, compName) {
  if (compNames === null) return true
  const name = typeof compName === 'string' ? compName.trim() : ''
  if (name === '') return false
  return compNames.includes(name)
}

/**
 * `ae_run_script` 的写操作判定。
 *
 * Conservative on purpose: a script is treated as a write unless the caller says
 * otherwise, and the declaration is not taken on trust for statements that can
 * obviously destroy state. Both directions are checked — an explicit `readOnly`
 * cannot excuse a `remove()`.
 */
/**
 * 匹配 `.property =` 这种**赋值**，而不是 `.property ==` / `===` / `>=`。
 *
 * `\s*=` 这种写法把 `layer.source === null` 也判成了写操作——纯读取被拦下，
 * 使用者学会的是随手声明 readOnly，保护就被绕过去了。所以断言后面必须
 * 不是 `=`，前面必须不是比较运算符的一部分。
 */
function assignment(property) {
  return new RegExp(`\\.${property}\\s*=(?!=)`)
}

const WRITE_PATTERNS = [
  /\bsetValue(AtTime)?\s*\(/,
  // `\b` before `.` never matches (`.` is not a word character), so these are
  // anchored on the optional receiver instead. Missing that turned `remove()`
  // and `addProperty()` into "reads", which would have skipped the gate.
  /\.remove\s*\(/,
  /\.removeKey\s*\(/,
  /\.addProperty\s*\(/,
  /\.addText\s*\(/,
  /\.addShape\s*\(/,
  /\.addSolid\s*\(/,
  /\.addComp\s*\(/,
  /\.addCamera\s*\(/,
  /\.addLight\s*\(/,
  /\.addNull\s*\(/,
  /\.applyPreset\s*\(/,
  /\.setValue\s*\(/,
  // Assignments. Each of these mutates the project just as surely as
  // `setValue()` does, so a script containing one must not be waved through as
  // a read — and a comparison must not be mistaken for one.
  assignment('expression'),
  assignment('enabled'),
  assignment('solo'),
  assignment('inPoint'),
  assignment('outPoint'),
  assignment('startTime'),
  assignment('name'),
  assignment('value'),
  assignment('time'),
  assignment('width'),
  assignment('height'),
  assignment('duration'),
  assignment('frameRate'),
  assignment('bgColor'),
  assignment('active'),
  assignment('shy'),
  assignment('locked'),
  assignment('guideLayer'),
  assignment('adjustmentLayer'),
  assignment('threeDLayer'),
  assignment('motionBlur'),
  assignment('collapseTransformation'),
  assignment('source'),
  assignment('parent'),
  assignment('label'),
  assignment('comment'),
  /\.moveTo\s*\(/,
  /\.moveBefore\s*\(/,
  /\.moveAfter\s*\(/,
  /\.duplicate\s*\(/,
  /\.replaceSource\s*\(/,
  /\.setProxy\s*\(/,
  /app\.project\.save\s*\(/,
  /app\.project\.importFile\s*\(/,
  /app\.beginUndoGroup\s*\(/,
  /\bimportFile\s*\(/,
  /\bresetProject\b/,
]

/**
 * @param {string} code
 * @returns {{isWrite: boolean, reason: string}}
 */
export function classifyScript(code) {
  const src = String(code ?? '')
  for (const pattern of WRITE_PATTERNS) {
    if (pattern.test(src)) {
      return { isWrite: true, reason: `匹配到写操作模式 ${pattern.source}` }
    }
  }
  return { isWrite: false, reason: '未检测到写操作模式' }
}

/**
 * Decide whether a `ae_run_script` call must be gated, and gate it.
 *
 * The rule has to distinguish two situations that look alike but are not:
 *
 *   - A script that **writes** cannot be allowed to run unprotected. If no
 *     verified backup can be made, the call is refused — this is the whole
 *     point of the gate.
 *   - A script that only **reads** destroys nothing, so refusing it protects
 *     nothing and only teaches the caller to declare `readOnly` reflexively.
 *     Reads are therefore never blocked; they run with a note instead.
 *
 * The caller's `readOnly` declaration can only ever *weaken* nothing: a
 * declared-read-only script that contains a write pattern is still treated as a
 * write, because that declaration is a mistake, not a licence.
 *
 * @param {object} input
 * @param {string} input.code
 * @param {boolean} [input.readOnly] caller's declaration
 * @param {object} [input.bridge]
 * @param {Function} [input.serial]
 * @returns {Promise<{isWrite:boolean, gated:boolean, blocked?:boolean, checkpoint?:string, reason:string}>}
 */
export async function guardScript(input) {
  const { code, readOnly = false } = input
  const verdict = classifyScript(code)

  // A declared read-only script that contains a write pattern is a mistake, not
  // a licence to skip the gate — `verdict.isWrite` wins in both directions.
  if (!verdict.isWrite) {
    return {
      isWrite: false,
      gated: false,
      blocked: false,
      reason: readOnly === true
        ? '已声明只读且未检测到写操作'
        : `未检测到写操作，按只读放行（${verdict.reason}）`,
    }
  }

  if (!input.bridge || !input.serial) {
    // No bridge available: the caller is a unit test exercising classification.
    return { isWrite: true, gated: false, blocked: false, reason: verdict.reason }
  }

  try {
    const guarded = await guardDestructive({
      bridge: input.bridge,
      serial: input.serial,
      operation: 'ae_run_script',
      context: { declaredReadOnly: readOnly, detectedWrite: true },
    })

    return {
      isWrite: true,
      gated: true,
      blocked: false,
      checkpoint: guarded.checkpoint,
      reused: guarded.reused,
      reason: verdict.reason,
    }
  } catch (error) {
    // A write that cannot be protected is refused — the caller gets a clear
    // reason and a way out, not a thrown stack it has to interpret.
    if (error.code === 'CHECKPOINT_UNAVAILABLE' || error.code === 'CHECKPOINT_INVALID') {
      return {
        isWrite: true,
        gated: true,
        blocked: true,
        reason: error.message,
      }
    }
    throw error
  }
}
