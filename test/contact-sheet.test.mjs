/**
 * Contact sheet tests.
 *
 * The decoder is validated against a PNG this repository encodes itself (a
 * round trip proves encode and decode agree), and the compositor against a
 * known cell layout. A real After Effects capture is exercised separately in
 * the integration test, because that PNG must be produced by AE.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { decodePng, encodePng, buildContactSheet, PngError } from '../lib/contact-sheet.js'

/** Build a solid-colour RGBA image of the given size. */
function solid(width, height, [r, g, b, a]) {
  const px = new Uint8ClampedArray(width * height * 4)
  for (let i = 0; i < px.length; i += 4) {
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a
  }
  return px
}

test('encode then decode round-trips pixel-exactly', () => {
  const w = 7
  const h = 5
  const px = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < px.length; i++) px[i] = (i * 37) & 0xff

  const png = encodePng(w, h, px)
  const back = decodePng(png)

  assert.equal(back.width, w)
  assert.equal(back.height, h)
  assert.deepEqual(Array.from(back.pixels), Array.from(px))
})

test('a non-PNG buffer is refused with a code', () => {
  assert.throws(() => decodePng(Buffer.from('GIF89a not png')), (e) => {
    assert.ok(e instanceof PngError)
    assert.equal(e.code, 'PNG_NOT_PNG')
    return true
  })
})

test('a truncated PNG reports incomplete rather than decoding garbage', () => {
  const png = encodePng(4, 4, solid(4, 4, [10, 20, 30, 255]))
  const cut = png.subarray(0, Math.floor(png.length * 0.7))
  assert.throws(() => decodePng(cut), (e) => {
    assert.ok(
      ['PNG_TRUNCATED', 'PNG_INCOMPLETE', 'PNG_NO_DATA'].includes(e.code),
      `expected a truncation code, got ${e.code}`,
    )
    return true
  })
})

test('contact sheet lays out cells on a grid with grey gutters', () => {
  const frames = [0, 1, 2, 3].map((i) => ({
    path: `f${i}.png`,
    time: i * 0.5,
    buffer: encodePng(10, 6, solid(10, 6, [255, 0, 0, 255])),
  }))

  const sheet = buildContactSheet(frames, { columns: 2, gap: 2 })
  assert.equal(sheet.columns, 2)
  assert.equal(sheet.rows, 2)
  assert.equal(sheet.cell.width, 10)
  assert.equal(sheet.cell.height, 6)
  // 2 columns * 10 + 3 gaps * 2 = 26
  assert.equal(sheet.width, 26)
  // 2 rows * 6 + 3 gaps * 2 = 18
  assert.equal(sheet.height, 18)

  const decoded = decodePng(sheet.png)
  assert.equal(decoded.width, 26)
  assert.equal(decoded.height, 18)

  // The gutter pixel at (0,0) must be grey, not the cell colour.
  assert.equal(decoded.pixels[0], 74)
  // A pixel inside the first cell must be the cell colour.
  const at = ((2 + 1) * 26 + (2 + 1)) * 4
  assert.equal(decoded.pixels[at], 255)
  assert.equal(decoded.pixels[at + 1], 0)
})

test('transparent regions composite onto grey, not onto black', () => {
  const frames = [{
    path: 'a.png',
    time: 0,
    buffer: encodePng(4, 4, solid(4, 4, [0, 0, 0, 0])), // fully transparent
  }]
  const sheet = buildContactSheet(frames, { columns: 1, gap: 0 })
  const decoded = decodePng(sheet.png)
  // Where the transparent cell sits, the result is the grey ground.
  assert.equal(decoded.pixels[0], 74, 'transparent area must show the grey ground')
  assert.equal(decoded.pixels[3], 255, 'sheet is opaque')
})

test('frame times are carried through for labelling', () => {
  const frames = [0.25, 0.5].map((t) => ({
    path: `f${t}.png`,
    time: t,
    buffer: encodePng(2, 2, solid(2, 2, [1, 2, 3, 255])),
  }))
  const sheet = buildContactSheet(frames, { columns: 2 })
  assert.deepEqual(sheet.frameTimes, [0.25, 0.5])
})

test('an empty frame list is refused', () => {
  assert.throws(() => buildContactSheet([]), (e) => {
    assert.equal(e.code, 'SHEET_NO_FRAMES')
    return true
  })
})

test('cells of differing sizes are scaled into the first cell size', () => {
  const frames = [
    { path: 'a', time: 0, buffer: encodePng(10, 10, solid(10, 10, [255, 0, 0, 255])) },
    { path: 'b', time: 1, buffer: encodePng(5, 5, solid(5, 5, [0, 0, 255, 255])) },
  ]
  const sheet = buildContactSheet(frames, { columns: 2, gap: 0 })
  assert.equal(sheet.cell.width, 10)
  // The smaller frame occupies its cell rather than leaving a hole.
  const decoded = decodePng(sheet.png)
  const secondCellX = 10 + 5 // inside the second cell
  const idx = (5 * 20 + secondCellX) * 4
  assert.equal(decoded.pixels[idx + 2], 255, 'second cell should hold the blue frame')
})
