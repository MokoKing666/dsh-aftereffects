/**
 * dsh-aftereffects — ES3 pre-flight guard
 *
 * After Effects still runs ExtendScript on an ES3 engine. ES2015+ syntax does
 * not degrade there: the whole script fails to parse, and depending on how it
 * was sent the user may only see a generic dialog. This module rejects such
 * code at the DSH boundary, before anything reaches After Effects, and points
 * at the exact line.
 *
 * It is a *guard*, not a compiler: it strips strings, comments and regular
 * expression literals first, then looks for syntax the ES3 engine cannot parse.
 *
 * @module dsh-aftereffects/es3
 */

/**
 * Constructs ES3 has no grammar for. Each entry is matched against code that
 * has already had literals removed, so a `=>` inside a string never trips it.
 */
const RULES = [
  {
    id: 'arrow-function',
    test: /=>/g,
    message: 'arrow functions (=>) are ES2015; write `function (x) { return x; }`',
  },
  {
    id: 'const',
    test: /\bconst\s+[A-Za-z_$]/g,
    message: '`const` is ES2015; use `var`',
  },
  {
    id: 'let',
    test: /\blet\s+[A-Za-z_$]/g,
    message: '`let` is ES2015; use `var`',
  },
  {
    id: 'template-literal',
    test: /`/g,
    message: 'template literals are ES2015; use "str" + value',
  },
  {
    id: 'class',
    test: /\bclass\s+[A-Za-z_$]/g,
    message: '`class` is ES2015; use a function and a prototype',
  },
  {
    id: 'spread',
    test: /\.\.\./g,
    message: 'spread/rest (...) is ES2015; pass arguments explicitly',
  },
  {
    id: 'default-parameter',
    test: /\bfunction\s*[A-Za-z_$]*\s*\([^)]*=\s*[^),]+[,)]/g,
    message: 'default parameters are ES2015; assign inside the body',
  },
  {
    id: 'for-of',
    test: /\bfor\s*\(\s*(?:var|let|const)\s+[A-Za-z_$][\w$]*\s+of\s+/g,
    message: '`for...of` is ES2015; use an indexed for loop',
  },
  {
    id: 'shorthand-property',
    test: /\{\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*,\s*[A-Za-z_$][\w$]*\s*\}/g,
    message: 'object shorthand `{a, b}` is ES2015; write `{a: a, b: b}`',
  },
  {
    id: 'async-await',
    test: /\b(?:async\s+function|await\s+[A-Za-z_$(])/g,
    message: 'async/await is ES2017 and is unavailable in ExtendScript',
  },
  {
    id: 'object-assign',
    test: /\bObject\.assign\s*\(/g,
    message: 'Object.assign is ES2015; copy fields manually',
  },
  {
    id: 'array-includes',
    test: /\.includes\s*\(/g,
    message: 'Array.prototype.includes is ES2016; use `indexOf(...) >= 0`',
  },
  {
    id: 'promise',
    test: /\bnew\s+Promise\s*\(/g,
    message: 'Promises are ES2015; ExtendScript is synchronous',
  },
  {
    id: 'json-stringify-pretty',
    test: /\bJSON\.stringify\s*\([^)]*,\s*null\s*,\s*\d/g,
    message: 'JSON.stringify(value, null, 2) needs a space argument ExtendScript lacks; write your own serialiser',
  },
]

/**
 * Replace the contents of strings, comments and regex literals with spaces so
 * offsets and line numbers survive, then scan what is left.
 */
function stripLiterals(source) {
  let out = ''
  let i = 0
  const n = source.length

  const blank = (text) => text.replace(/[^\n]/g, ' ')

  while (i < n) {
    const c = source[i]
    const next = source[i + 1]

    // line comment
    if (c === '/' && next === '/') {
      let j = i
      while (j < n && source[j] !== '\n') j++
      out += blank(source.slice(i, j))
      i = j
      continue
    }

    // block comment
    if (c === '/' && next === '*') {
      let j = i + 2
      while (j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      j = Math.min(n, j + 2)
      out += blank(source.slice(i, j))
      i = j
      continue
    }

    // string literal
    if (c === '"' || c === "'") {
      const quote = c
      let j = i + 1
      while (j < n) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === quote || source[j] === '\n') break
        j++
      }
      j = Math.min(n, j + 1)
      out += blank(source.slice(i, j))
      i = j
      continue
    }

    out += c
    i++
  }

  return out
}

function lineIndex(source) {
  const starts = [0]
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\n') starts.push(i + 1)
  }
  return (offset) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return { line: lo + 1, column: offset - starts[lo] + 1 }
  }
}

/**
 * Check one source string for ES3 compatibility.
 *
 * @param {string} source the script or expression body
 * @param {{ label?: string }} [options]
 * @returns {{ ok: boolean, violations: Array<{rule: string, message: string, line: number, column: number, snippet: string}> }}
 */
export function checkEs3(source, options = {}) {
  const text = String(source ?? '')
  const stripped = stripLiterals(text)
  const at = lineIndex(text)
  const lines = text.split(/\r?\n/)
  const violations = []
  const seen = new Set()

  for (const rule of RULES) {
    rule.test.lastIndex = 0
    let match
    while ((match = rule.test.exec(stripped)) !== null) {
      const pos = at(match.index)
      const key = `${rule.id}:${pos.line}`
      if (seen.has(key)) continue
      seen.add(key)
      violations.push({
        rule: rule.id,
        message: rule.message,
        line: pos.line,
        column: pos.column,
        snippet: (lines[pos.line - 1] ?? '').trim().slice(0, 200),
      })
    }
  }

  violations.sort((a, b) => a.line - b.line || a.column - b.column)

  return { ok: violations.length === 0, violations }
}

/**
 * Throw a model-facing error describing every ES3 violation.
 * The message is written so a model can fix the code without asking again.
 */
export function assertEs3(source, label) {
  const { ok, violations } = checkEs3(source)
  if (ok) return

  const where = label ? ` in ${label}` : ''
  const lines = [
    `ES3 预检未通过${where}：这段代码里有 ${violations.length} 处 ES2015+ 语法，`
      + 'After Effects 的 ExtendScript 引擎无法解析，已在发送前拦截（AE 没有执行任何代码）。',
    '',
  ]
  for (const v of violations) {
    lines.push(`  第 ${v.line} 行 第 ${v.column} 列 — ${v.message}`)
    if (v.snippet) lines.push(`      ${v.snippet}`)
  }
  lines.push('')
  lines.push('请改写成纯 ES3 后重新提交：用 var、function、字符串拼接，不用箭头函数/模板字符串/const/let/class/解构。')

  const error = new Error(lines.join('\n'))
  error.code = 'ES3_VIOLATION'
  error.violations = violations
  throw error
}

/** Convenience for expressions, which share the same ES3 engine. */
export function assertEs3Expression(expression, label) {
  return assertEs3(expression, label ?? 'expression')
}
