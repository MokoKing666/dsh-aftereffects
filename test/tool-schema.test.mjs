/**
 * 工具定义的参数完整性。
 *
 * 这条测试的由来是一个真实缺陷：`pro-tools.js` 先调 `defineTool(...)`，
 * 返回的定义再交给 `index.js` 的 `register`，`register` 里又调一次
 * `defineTool`。第二次编译把已编译的 schema 当成「参数名 → 定义」的映射，
 * 于是 `ae_layers` / `ae_query` / `ae_set` 等 12 个工具的**参数定义全部消失**，
 * 网关收到的是一个只含 `type` / `properties` / `additionalProperties`
 * 三个假参数名的 schema。
 *
 * 构建审计没抓到，因为它只验证 `type` 的取值合法——三个假参数的 `{}` 也是
 * 合法 schema。所以这里检查的是**语义**：每个工具都得有它该有的参数。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

/** Register the plugin and collect the definitions the gateway would receive. */
function collect() {
  const tools = new Map()
  apply({
    tools: { register: (definition) => { tools.set(definition.name, definition); return () => {} } },
    systemPrompt: { section: () => () => {} },
    on: () => {},
  }, {})
  return tools
}

/** Schema keywords that must never appear as a parameter NAME. */
const SCHEMA_KEYWORDS = ['properties', 'additionalProperties', 'required', 'items', 'enum', 'oneOf']

/**
 * 重复编译的精确指纹：参数**节点本身**看起来是一份完整的 object schema。
 *
 * 不能用"参数名里有没有 `properties`"来判断——`ae_essential_graphics.properties`
 * 和 `ae_layers.type` 都是真实参数。真正的症状是：那个参数的值是
 * `{type:'object', properties:{...}}` 这种整份 schema 的形状，而一个正常的
 * 参数值应该只有 `{type, description, ...}`。
 */
test('没有工具的参数是重复编译的产物', () => {
  const tools = collect()
  for (const [name, definition] of tools) {
    const keys = Object.keys(definition.parameters.properties)
    // 三个键同时出现 = 整个参数表被当成了「参数名 → 定义」的映射再编译一次。
    const triple = keys.includes('type') && keys.includes('properties') && keys.includes('additionalProperties')
    assert.ok(!triple, `${name} 的参数是重复编译的产物：${keys.join(', ')}`)

    for (const [param, node] of Object.entries(definition.parameters.properties)) {
      const isNestedSchema = node && typeof node === 'object'
        && node.type === 'object'
        && node.properties !== undefined
      assert.ok(
        !isNestedSchema,
        `${name}.${param} 的值是一整份 object schema —— 参数被重复编译了`,
      )
    }
  }
})

test('ae_layers 的 type 参数是真的，不是 schema 泄漏', () => {
  const tools = collect()
  const node = tools.get('ae_layers').parameters.properties.type
  assert.equal(node.type, 'string', 'ae_layers.type 应是一个字符串参数（按图层类型过滤）')
  assert.ok(node.description, 'ae_layers.type 应带说明，而不是空 schema')
})

test('每个工具都至少声明一个参数', () => {
  const tools = collect()
  for (const [name, definition] of tools) {
    const keys = Object.keys(definition.parameters.properties)
    assert.ok(keys.length > 0, `${name} 一个参数都没有，网关会拒绝任何调用`)
  }
})

test('参数 schema 是 object 根节点且禁止多余字段', () => {
  const tools = collect()
  for (const [name, definition] of tools) {
    assert.equal(definition.parameters.type, 'object', `${name} 参数根节点不是 object`)
    assert.equal(definition.parameters.additionalProperties, false, `${name} 应禁止未声明参数`)
  }
})

test('每个参数都带类型，或是明确的开放 schema', () => {
  const tools = collect()
  const ANNOTATION_ONLY = new Set(['description', 'title', 'default', 'examples'])
  for (const [name, definition] of tools) {
    for (const [param, node] of Object.entries(definition.parameters.properties)) {
      if (typeof node.type === 'string') {
        assert.notEqual(node.type, 'json', `${name}.${param} 泄漏了作者侧 type: json`)
        continue
      }
      // `type: 'json'` compiles to the empty schema — "any JSON value". A node
      // holding nothing but annotations is that open schema, and it is correct.
      const structural = Object.keys(node).filter((key) => !ANNOTATION_ONLY.has(key))
      assert.equal(
        structural.length, 0,
        `${name}.${param} 既没有 type，又带了非注解键 ${structural.join(', ')}：${JSON.stringify(node)}`,
      )
    }
  }
})

test('必填参数被提升到 required 数组', () => {
  const tools = collect()
  const compose = tools.get('ae_compose')
  assert.ok(compose.parameters.required.includes('scene'), 'ae_compose 的 scene 必须是必填')
  const render = tools.get('ae_render')
  assert.ok(render.parameters.required.includes('output'), 'ae_render 的 output 必须是必填')
  const script = tools.get('ae_run_script')
  assert.ok(script.parameters.required.includes('code'), 'ae_run_script 的 code 必须是必填')
})

test('参数级 required 布尔值不会泄漏到属性 schema 里', () => {
  const tools = collect()
  for (const [name, definition] of tools) {
    for (const [param, node] of Object.entries(definition.parameters.properties)) {
      assert.equal(
        node.required, undefined,
        `${name}.${param} 上残留了属性级 required —— 严格的网关会拒绝整条请求`,
      )
    }
  }
})

test('关键工具保留了它的核心参数', () => {
  const tools = collect()
  const expect = {
    ae_layers: ['comp', 'layerId', 'type', 'nameFilter'],
    ae_query: ['comp', 'layerId', 'path', 'time'],
    ae_set: ['comp', 'layerId', 'path', 'value', 'expression'],
    ae_animate: ['comp', 'layerId', 'path', 'keys', 'ease'],
    ae_scan_effects: ['query', 'includeObsolete', 'refresh'],
    ae_capture_preview: ['comp', 'output', 'time', 'longEdge'],
    ae_audio_markers: ['comp', 'layerId', 'sensitivity', 'maxMarkers'],
    ae_checkpoint: ['action', 'dir', 'label', 'keep', 'checkpoint'],
  }
  for (const [name, params] of Object.entries(expect)) {
    const definition = tools.get(name)
    assert.ok(definition, `${name} 没有注册`)
    const keys = Object.keys(definition.parameters.properties)
    for (const param of params) {
      // ae_layers 的 layerId 来自共用的 layerSpecParams，只有部分工具用到。
      if (name === 'ae_layers' && param === 'layerId') continue
      assert.ok(keys.includes(param), `${name} 丢了参数 ${param}（现有：${keys.join(', ')}）`)
    }
  }
})
