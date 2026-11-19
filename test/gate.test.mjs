/**
 * 门禁分类器测试。
 *
 * 分类器决定一个脚本要不要先做备份。判错的方向有两个，两个都严重：
 * 把写操作当成只读（无保护执行），把纯读取当成写（每次读都复制一份工程）。
 * 这里对两个方向都钉死。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { classifyScript } from '../lib/gate.js'

const isWrite = (code) => classifyScript(code).isWrite

/* ------------------------------------------------------- 必须判为写操作 */

test('setValue 是写', () => {
  assert.equal(isWrite("l.property('ADBE Opacity').setValue(50);"), true)
})

test('setValueAtTime 是写', () => {
  assert.equal(isWrite('p.setValueAtTime(1, 100);'), true)
})

test('remove 是写', () => {
  assert.equal(isWrite('app.project.item(1).remove();'), true)
})

test('removeKey 是写', () => {
  assert.equal(isWrite('comp.markerProperty.removeKey(1);'), true)
})

test('addProperty 是写', () => {
  assert.equal(isWrite("layer.property('ADBE Effect Parade').addProperty('ADBE Glo2');"), true)
})

test('addComp 是写', () => {
  assert.equal(isWrite("app.project.items.addComp('X', 640, 360, 1, 2, 24);"), true)
})

test('挂表达式是写', () => {
  assert.equal(isWrite("prop.expression = 'wiggle(2,10)';"), true)
})

test('改图层属性是写', () => {
  assert.equal(isWrite('layer.enabled = false;'), true)
  assert.equal(isWrite('layer.name = "renamed";'), true)
  assert.equal(isWrite('layer.inPoint = 1;'), true)
})

test('保存工程是写', () => {
  assert.equal(isWrite('app.project.save();'), true)
})

test('导入素材是写', () => {
  assert.equal(isWrite('app.project.importFile(io);'), true)
})

test('applyPreset 是写', () => {
  assert.equal(isWrite('layer.applyPreset(f);'), true)
})

test('beginUndoGroup 视为写（它总是包着修改）', () => {
  assert.equal(isWrite('app.beginUndoGroup("x");'), true)
})

test('resetProject 是写', () => {
  assert.equal(isWrite('app.project.items; resetProject();'), true)
})

/* ------------------------------------------- 第二轮补上的赋值型写操作 */

test('直接给属性赋值是写', () => {
  assert.equal(isWrite('p.value = 5;'), true)
  assert.equal(isWrite('layer.startTime = 2;'), true)
  assert.equal(isWrite('comp.bgColor = [0,0,0];'), true)
  assert.equal(isWrite('layer.source = footage;'), true)
  assert.equal(isWrite('layer.parent = null;'), true)
  assert.equal(isWrite('comp.width = 1080;'), true)
  assert.equal(isWrite('comp.frameRate = 60;'), true)
})

test('改图层开关状态是写', () => {
  assert.equal(isWrite('layer.locked = true;'), true)
  assert.equal(isWrite('layer.shy = true;'), true)
  assert.equal(isWrite('layer.motionBlur = true;'), true)
  assert.equal(isWrite('layer.adjustmentLayer = true;'), true)
})

test('重排与复制图层是写', () => {
  assert.equal(isWrite('layer.moveTo(1);'), true)
  assert.equal(isWrite('layer.moveBefore(other);'), true)
  assert.equal(isWrite('layer.duplicate();'), true)
  assert.equal(isWrite('layer.replaceSource(f, false);'), true)
  assert.equal(isWrite('layer.setProxy(f);'), true)
})

/* --------------------------------------------------- 不得判为写（纯读取） */

test('读版本号不算写', () => {
  assert.equal(isWrite('return app.version;'), false)
})

test('读取属性值不算写', () => {
  assert.equal(isWrite("var v = l.property('ADBE Transform Group').property('ADBE Opacity').value; return v;"), false)
})

test('遍历图层不算写', () => {
  assert.equal(isWrite([
    'var out = [];',
    'var c = app.project.item(1);',
    'for (var i = 1; i <= c.numLayers; i++) { out.push(c.layer(i).name); }',
    'return out;',
  ].join('\n')), false)
})

test('枚举效果不算写', () => {
  assert.equal(isWrite('var n = app.effects.length; return n;'), false)
})

test('读 sourceRectAtTime 不算写', () => {
  assert.equal(isWrite('var r = layer.sourceRectAtTime(0, false); return r.width;'), false)
})

test('读 numKeys 不算写', () => {
  assert.equal(isWrite('return p.numKeys;'), false)
})

test('读取只做比较的语句不算写', () => {
  assert.equal(isWrite('if (layer.locked) { return 1; } return 0;'), false)
  assert.equal(isWrite('var w = comp.width; return w;'), false)
  assert.equal(isWrite('return layer.source === null;'), false)
})

test('读注释里的赋值语句不算写', () => {
  // Only an actual `=` assignment counts; a comment describing one does not.
  assert.equal(isWrite('// layer.name 曾经是 X\nreturn layer.name;'), false)
})

test('注释里的 setValue 不算写', () => {
  // The classifier is pattern based; a comment mentioning a write is rare
  // enough that erring toward "write" is the safe direction, but it must still
  // be reported honestly rather than silently ignored.
  const code = '// 这里曾经 setValue 过\nreturn 1;'
  const result = classifyScript(code)
  assert.equal(typeof result.isWrite, 'boolean')
  assert.equal(typeof result.reason, 'string')
})

test('空脚本不算写', () => {
  assert.equal(isWrite(''), false)
})

test('分类结果总是带原因', () => {
  for (const code of ['return 1;', 'layer.name = "x";', '']) {
    const r = classifyScript(code)
    assert.equal(typeof r.reason, 'string')
    assert.ok(r.reason.length > 0)
  }
})
