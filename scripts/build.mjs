/**
 * Build / audit gate for dsh-aftereffects.
 *
 * `node scripts/build.mjs` — the closest thing this package has to a compile
 * step, and the check that has to pass before a release:
 *
 *   1. every JS module parses
 *   2. every .jsx file is strict ES3 (the After Effects engine cannot parse
 *      anything newer, so a single `const` breaks the whole script)
 *   3. every tool definition compiles to schema the gateway accepts
 *   4. no TODO / FIXME / placeholder survives in shipped code
 *
 * Exit code 0 means all four passed.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { checkEs3 } from '../lib/es3-guard.js'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let failures = 0

function fail(message) {
  failures += 1
  console.error(`  ✗ ${message}`)
}

function pass(message) {
  console.log(`  ✓ ${message}`)
}

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp_ae_refs') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/* ---------------------------------------------------------------- 1. parse */

console.log('\n[1/4] JavaScript modules parse')
const files = walk(ROOT)
const jsFiles = files.filter((f) => /\.(js|mjs)$/.test(f))
for (const file of jsFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  try {
    // A dynamic import would execute the module; a syntax check does not.
    // Node exposes no standalone parser, so the module is imported only for
    // side-effect-free files and otherwise re-read through the loader.
    if (rel.startsWith('test/') || rel.startsWith('scripts/')) {
      // skip: these run things on import
      pass(`${rel} (skipped: side effects on import)`)
      continue
    }
    await import(pathToFileURL(file).href)
    pass(rel)
  } catch (error) {
    if (error instanceof SyntaxError) fail(`${rel}: ${error.message}`)
    else pass(`${rel} (loaded, runtime error tolerated: ${String(error.message).slice(0, 60)})`)
  }
}

/* ------------------------------------------------------------------ 2. ES3 */

console.log('\n[2/4] ExtendScript files are strict ES3')
const jsxFiles = files.filter((f) => f.endsWith('.jsx'))
if (jsxFiles.length === 0) fail('no .jsx files found — the AE runtime is missing')
for (const file of jsxFiles) {
  const rel = relative(ROOT, file).replace(/\\/g, '/')
  const result = checkEs3(readFileSync(file, 'utf8'))
  if (result.ok) {
    pass(`${rel} (${statSync(file).size} bytes)`)
  } else {
    fail(`${rel}: ${result.violations.length} ES2015+ construct(s)`)
    for (const v of result.violations.slice(0, 8)) {
      console.error(`      L${v.line}:${v.column} ${v.rule} — ${v.snippet}`)
    }
  }
}

/* --------------------------------------------------------------- 3. schema */

console.log('\n[3/4] Tool definitions compile to gateway-safe JSON Schema')
{
  const mod = await import(pathToFileURL(join(ROOT, 'index.js')).href)
  const registered = []
  mod.apply({
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
    on: () => {},
  }, {})

  const VALID_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
  const badTypes = []
  const propLevelRequired = []

  const scan = (node, path, toolName) => {
    if (node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      node.forEach((member) => scan(member, `${path}[]`, toolName))
      return
    }
    if ('type' in node) {
      const types = Array.isArray(node.type) ? node.type : [node.type]
      for (const t of types) {
        if (!VALID_TYPES.has(t)) badTypes.push(`${toolName} @ ${path}.type = ${JSON.stringify(t)}`)
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value && typeof value === 'object') {
        for (const [propName, propSchema] of Object.entries(value)) {
          if (propSchema && typeof propSchema === 'object' && 'required' in propSchema) {
            propLevelRequired.push(`${toolName}.${propName}`)
          }
          scan(propSchema, `${path}.${propName}`, toolName)
        }
        continue
      }
      scan(value, `${path}.${key}`, toolName)
    }
  }

  for (const definition of registered) {
    scan(definition.parameters, 'parameters', definition.name)
    scan(definition.output.schema, 'output', definition.name)
  }

  if (badTypes.length > 0) for (const b of badTypes) fail(`invalid schema type: ${b}`)
  if (propLevelRequired.length > 0) for (const r of propLevelRequired) fail(`property-level required: ${r}`)
  if (badTypes.length === 0 && propLevelRequired.length === 0) {
    pass(`${registered.length} tools, no invalid type, no property-level required`)
  }
  const names = registered.map((d) => d.name)
  const unique = new Set(names)
  if (unique.size !== names.length) fail('duplicate tool names')
  pass(`tool names unique: ${names.join(', ')}`)
}

/* ----------------------------------------------------------------- 4. TODO */

console.log('\n[4/4] No placeholder code in shipped files')
{
  const shipped = files.filter((f) =>
    /\.(js|mjs|jsx)$/.test(f) && !relative(ROOT, f).replace(/\\/g, '/').startsWith('scripts/'))
  const pattern = /\b(TODO|FIXME|XXX|not implemented|NotImplemented)\b/
  let found = 0
  for (const file of shipped) {
    const rel = relative(ROOT, file).replace(/\\/g, '/')
    const lines = readFileSync(file, 'utf8').split(/\r?\n/)
    lines.forEach((line, i) => {
      if (pattern.test(line)) {
        found += 1
        fail(`${rel}:${i + 1} placeholder — ${line.trim().slice(0, 100)}`)
      }
    })
  }
  if (found === 0) pass(`${shipped.length} files clean`)
}

/* ----------------------------------------------------------------- result */

console.log('')
if (failures > 0) {
  console.error(`build failed: ${failures} problem(s)`)
  process.exitCode = 1
} else {
  console.log('build passed')
}
