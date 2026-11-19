/**
 * dsh-aftereffects — self-contained tool definition builder
 *
 * `@deepseek-ai/dsh-tools` is not resolvable from a bundled plugin, so its
 * `defineTool` silently degrades to an identity function. That is dangerous
 * rather than merely inconvenient: the author-facing parameter DSL
 * (`type: 'json'`, `required: true`, `oneOf`) then reaches the gateway as-is,
 * the gateway only understands standard JSON Schema, and every request fails
 * with a 400.
 *
 * So this module compiles the DSL itself. Nothing here imports the host — the
 * output is plain JSON Schema and a plain definition object, which is what both
 * the gateway and `ctx.tools.register` actually consume.
 *
 * Supported author DSL per property:
 *   { type, description, title, default, enum, items, properties, required,
 *     oneOf, additionalProperties, examples }
 * `type: 'json'` means "any JSON value" and becomes `{}`.
 *
 * @module dsh-aftereffects/tool-def
 */

/** Every type the gateway accepts. `json` is author-side only. */
const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Compile one author node into standard JSON Schema.
 * @param {unknown} node
 * @returns {object}
 */
function compileNode(node) {
  if (node === null || node === undefined) return {}
  if (typeof node !== 'object' || Array.isArray(node)) return {}

  const out = {}

  // `json` is the author escape hatch for "any value": the empty schema.
  const type = node.type
  if (type === 'json') {
    // any value at all; annotations still travel.
    copyAnnotations(node, out)
    return out
  }
  if (typeof type === 'string') {
    if (!JSON_SCHEMA_TYPES.has(type)) {
      // Unknown type would itself be a 400 at the gateway. Widening to "any"
      // is the safe reading: better a permissive schema than a rejected tool.
      copyAnnotations(node, out)
      return out
    }
    out.type = type
  }

  if (typeof node.description === 'string') out.description = node.description
  if (typeof node.title === 'string') out.title = node.title
  if (node.default !== undefined) out.default = node.default
  if (node.examples !== undefined) out.examples = node.examples

  if (Array.isArray(node.enum)) out.enum = node.enum.slice()
  if (node.const !== undefined) out.const = node.const

  if (Array.isArray(node.oneOf)) {
    out.oneOf = node.oneOf.map((member) => compileNode(member))
  }

  if (node.items !== undefined) out.items = compileNode(node.items)

  if (Array.isArray(node.required)) {
    // A `required` array is only meaningful on an object node.
    out.required = node.required.slice()
  }

  if (node.properties !== undefined && typeof node.properties === 'object' && node.properties !== null) {
    const props = {}
    for (const [key, value] of Object.entries(node.properties)) {
      props[key] = compileNode(value)
    }
    out.properties = props
    if (out.type === undefined) out.type = 'object'
  }

  if (typeof node.additionalProperties === 'boolean' || typeof node.additionalProperties === 'object') {
    out.additionalProperties =
      typeof node.additionalProperties === 'object' ? compileNode(node.additionalProperties) : node.additionalProperties
  }

  return out
}

function copyAnnotations(node, out) {
  if (typeof node.description === 'string') out.description = node.description
  if (typeof node.title === 'string') out.title = node.title
  if (node.default !== undefined) out.default = node.default
  if (node.examples !== undefined) out.examples = node.examples
}

/**
 * Compile the author parameter map into an object-rooted JSON Schema.
 *
 * `required: true` on a property is lifted into the object's `required` array,
 * which is where JSON Schema expects it — a per-property `required` boolean is
 * not standard and is exactly what a strict gateway rejects.
 *
 * @param {Record<string, object>} spec
 * @returns {{ type: 'object', properties: object, required?: string[], additionalProperties: boolean }}
 */
export function compileParameters(spec) {
  const properties = {}
  const required = []

  for (const [name, node] of Object.entries(spec ?? {})) {
    const compiled = compileNode(node)
    if (node && node.required === true) required.push(name)
    // `required` is not a property-level keyword; it must not leak through.
    delete compiled.required
    properties[name] = compiled
  }

  const schema = { type: 'object', properties, additionalProperties: false }
  if (required.length > 0) schema.required = required
  return schema
}

/** Compile an output schema (already JSON Schema shaped, but tolerate DSL). */
export function compileOutputSchema(schema) {
  const compiled = compileNode(schema)
  if (compiled.type === undefined && compiled.oneOf === undefined) compiled.type = 'object'
  return compiled
}

/**
 * Build a definition that both `ctx.tools.register` and the gateway accept.
 *
 * @param {object} options
 * @param {string} options.name
 * @param {string} options.description
 * @param {Record<string, object>} [options.parameters] author parameter DSL
 * @param {{ schema: object, render: (args: any, value: any) => any[] }} options.output
 * @param {(args: any, exec: any) => Promise<any>} options.execute
 * @param {number} [options.timeoutMs]
 * @param {(args: any) => boolean} [options.isConcurrencySafe]
 * @returns {object} registry-ready definition
 */
export function defineToolSafe(options) {
  if (typeof options?.name !== 'string' || options.name === '') {
    throw new Error('defineToolSafe: name is required')
  }
  if (typeof options.execute !== 'function') {
    throw new Error(`defineToolSafe(${options.name}): execute is required`)
  }
  if (!options.output || typeof options.output.render !== 'function') {
    throw new Error(`defineToolSafe(${options.name}): output.render is required`)
  }

  const parameters = compileParameters(options.parameters)
  const outputSchema = compileOutputSchema(options.output.schema)

  return {
    name: options.name,
    description: String(options.description ?? ''),
    parameters,
    output: {
      schema: outputSchema,
      render: options.output.render,
      ...(typeof options.output.presentationMeta === 'function'
        ? { presentationMeta: options.output.presentationMeta }
        : {}),
    },
    ...(typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? { timeoutMs: options.timeoutMs } : {}),
    ...(typeof options.isConcurrencySafe === 'function' ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      return options.execute(args, exec)
    },
  }
}
