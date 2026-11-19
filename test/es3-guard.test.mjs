/**
 * ES3 pre-flight guard tests.
 *
 * Two failure modes matter equally: missing real ES2015+ syntax (the script
 * fails inside After Effects with no useful message) and flagging valid ES3
 * (the model is told to rewrite code that was already correct). Both are
 * tested here, including the tricky cases — regex literals, division, strings
 * and comments that merely contain the keywords.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { checkEs3, assertEs3 } from '../lib/es3-guard.js'

const rules = (src) => checkEs3(src).violations.map((v) => v.rule)

/* ------------------------------------------------------------- must flag */

test('flags const', () => {
  assert.ok(rules('const a = 1;').includes('const'))
})

test('flags let', () => {
  assert.ok(rules('let b = 2;').includes('let'))
})

test('flags arrow functions', () => {
  assert.ok(rules('var f = function (x) { return x }\nvar g = (y) => y * 2;').includes('arrow-function'))
})

test('flags template literals', () => {
  assert.ok(rules('var s = `a${b}`;').includes('template-literal'))
})

test('flags class', () => {
  assert.ok(rules('class Foo {}').includes('class'))
})

test('flags spread and rest', () => {
  assert.ok(rules('var a = [1, ...b];').includes('spread'))
})

test('flags default parameters', () => {
  assert.ok(rules('function f(a, b = 2) { return a + b }').includes('default-parameter'))
})

test('flags for...of', () => {
  assert.ok(rules('for (var x of list) { }').includes('for-of'))
})

test('flags destructuring', () => {
  assert.ok(rules('var [a, b] = pair;').includes('destructuring'))
  assert.ok(rules('var {a, b} = obj;').includes('destructuring'))
})

test('flags generator functions', () => {
  assert.ok(rules('function* gen() { yield 1; }').includes('generator'))
})

test('flags optional chaining', () => {
  assert.ok(rules('var v = obj?.prop;').includes('optional-chaining'))
})

test('flags nullish coalescing', () => {
  assert.ok(rules('var v = a ?? b;').includes('nullish-coalescing'))
})

test('flags exponent operator', () => {
  assert.ok(rules('var v = 2 ** 8;').includes('exponent-operator'))
})

test('flags async and await', () => {
  assert.ok(rules('async function f() { await g(); }').includes('async-await'))
})

test('flags Object.assign', () => {
  assert.ok(rules('Object.assign(a, b);').includes('object-assign'))
})

test('flags Array.includes', () => {
  assert.ok(rules('var found = list.includes(x);').includes('array-includes'))
})

test('flags JSON.stringify with a space argument', () => {
  assert.ok(rules('JSON.stringify(v, null, 2);').includes('json-stringify-pretty'))
})

/* --------------------------------------------------------- must NOT flag */

test('does not flag const/let inside a string', () => {
  assert.deepEqual(rules("var s = 'const let arrow => template `';"), [])
  assert.deepEqual(rules('var s = "class function* function";'), [])
})

test('does not flag keywords inside line comments', () => {
  assert.deepEqual(rules('// const x = 1; let y = 2; arrow => \nvar a = 1;'), [])
})

test('does not flag keywords inside block comments', () => {
  assert.deepEqual(rules('/*\n const a = 1;\n let b = 2;\n class C {}\n*/\nvar x = 1;'), [])
})

test('does not flag a regex literal that contains keywords', () => {
  assert.deepEqual(rules('var re = /const|let|class/;'), [])
  assert.deepEqual(rules('var re = /=>/;'), [])
})

test('does not flag division as the start of a regex', () => {
  assert.deepEqual(rules('var ratio = width / height;\nvar half = total / 2;'), [])
})

test('does not flag a regex after return', () => {
  assert.deepEqual(rules('function f() { return /abc/.test(s); }'), [])
})

test('accepts ordinary ES3', () => {
  const src = [
    'var a = 1;',
    'var b = [1, 2, 3];',
    'function add(x, y) { return x + y; }',
    'for (var i = 0; i < b.length; i++) { a += b[i]; }',
    'var obj = { key: "value", other: 2 };',
    'var s = "a" + a + "b";',
    'if (a > 0 && b) { a = Math.pow(a, 2); }',
  ].join('\n')
  assert.deepEqual(rules(src), [], 'valid ES3 must produce no violations')
})

test('Chinese strings and comments do not trip the scanner', () => {
  const src = [
    '// 这是一个中文注释，里面提到 const 和箭头函数 => 也不该误报',
    'var 名称 = "中文文本 const";',
    '/* 多行中文注释 let class */',
    'var 结果 = 名称 + "拼接";',
  ].join('\n')
  assert.deepEqual(rules(src), [], 'Chinese content must be inert')
})

test('regex containing a slash inside a character class', () => {
  assert.deepEqual(rules('var re = /[/]const/;'), [])
})

/* --------------------------------------------------------------- report */

test('violations carry line and column', () => {
  const r = checkEs3('var ok = 1;\nconst bad = 2;')
  assert.equal(r.ok, false)
  assert.equal(r.violations.length, 1)
  assert.equal(r.violations[0].line, 2)
  assert.equal(r.violations[0].column, 1)
  assert.ok(r.violations[0].snippet.includes('const bad'))
})

test('multiple violations are ordered by position', () => {
  const r = checkEs3('const a = 1;\nlet b = (x) => x;')
  assert.ok(r.violations.length >= 3)
  for (let i = 1; i < r.violations.length; i++) {
    const prev = r.violations[i - 1]
    const cur = r.violations[i]
    assert.ok(cur.line > prev.line || (cur.line === prev.line && cur.column >= prev.column))
  }
})

test('assertEs3 throws a model-facing error with the violations attached', () => {
  assert.throws(() => assertEs3('const a = 1;', 'test snippet'), (e) => {
    assert.equal(e.code, 'ES3_VIOLATION')
    assert.ok(Array.isArray(e.violations))
    assert.ok(e.message.includes('第 1 行'), 'message should name the line in Chinese')
    assert.ok(e.message.includes('test snippet'), 'message should name the label')
    return true
  })
})

test('assertEs3 is silent for valid ES3', () => {
  assert.doesNotThrow(() => assertEs3('var a = 1;'))
})

test('an empty source is valid', () => {
  assert.equal(checkEs3('').ok, true)
  assert.equal(checkEs3('   \n\t ').ok, true)
})

/* ---------------------------------------------------- expression realism */

test('a realistic sourceRectAtTime expression passes', () => {
  const expr = [
    'var t = thisComp.layer("字幕");',
    'var r = t.sourceRectAtTime(time, false);',
    '[r.width + 48, r.height + 48];',
  ].join('\n')
  assert.deepEqual(rules(expr), [])
})

test('a realistic typewriter expression passes', () => {
  const expr = [
    'var s = "Hello";',
    'var n = Math.min(s.length, Math.max(0, Math.floor(time * 24)));',
    's.substr(0, n);',
  ].join('\n')
  assert.deepEqual(rules(expr), [])
})

test('an ES6 expression is caught before it reaches AE', () => {
  const expr = 'const t = thisComp.layer("x"); [t.width]'
  const r = checkEs3(expr)
  assert.equal(r.ok, false)
  assert.ok(r.violations.some((v) => v.rule === 'const'))
})
