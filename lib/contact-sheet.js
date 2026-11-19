/**
 * dsh-aftereffects — contact sheet
 *
 * Composites several captured frames into one image so a model spends one
 * image's worth of attention on a motion check instead of N.
 *
 * Written in plain Node: no canvas, no sharp, no native module. A decompressor
 * and a compositor for the subset of PNG that After Effects' `saveFrameToPng`
 * actually emits — 8-bit RGB/RGBA, non-interlaced — plus the zlib the platform
 * already ships. Anything outside that subset is reported rather than guessed.
 *
 * @module dsh-aftereffects/contact-sheet
 */

import { inflateSync, deflateSync } from 'node:zlib'

/** A PNG we cannot composite, with the reason. */
export class PngError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'PngError'
    this.code = code
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Decode an 8-bit non-interlaced PNG into RGBA pixels.
 * @param {Buffer} buf
 * @returns {{width:number, height:number, pixels:Uint8ClampedArray}}
 */
export function decodePng(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new PngError('not a PNG (signature mismatch)', 'PNG_NOT_PNG')
  }

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat = []

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const body = offset + 8
    if (body + length > buf.length) throw new PngError(`chunk ${type} exceeds file length`, 'PNG_TRUNCATED')

    if (type === 'IHDR') {
      width = buf.readUInt32BE(body)
      height = buf.readUInt32BE(body + 4)
      bitDepth = buf.readUInt8(body + 8)
      colorType = buf.readUInt8(body + 9)
      interlace = buf.readUInt8(body + 12)
    } else if (type === 'IDAT') {
      idat.push(buf.subarray(body, body + length))
    } else if (type === 'IEND') {
      break
    }
    offset = body + length + 4 // skip CRC
  }

  if (width <= 0 || height <= 0) throw new PngError('IHDR missing or zero-sized', 'PNG_BAD_IHDR')
  if (bitDepth !== 8) {
    throw new PngError(
      `only 8-bit PNG is supported (this file is ${bitDepth}-bit); 16-bit PNGs cannot be composited here`,
      'PNG_UNSUPPORTED_DEPTH',
    )
  }
  if (interlace !== 0) throw new PngError('interlaced PNG is not supported', 'PNG_INTERLACED')

  // 0 grey, 2 RGB, 3 palette, 4 grey+alpha, 6 RGBA
  const channelsByType = { 0: 1, 2: 3, 4: 2, 6: 4 }
  const channels = channelsByType[colorType]
  if (channels === undefined) {
    throw new PngError(`unsupported colour type ${colorType}`, 'PNG_UNSUPPORTED_COLOR')
  }
  if (idat.length === 0) throw new PngError('no IDAT data', 'PNG_NO_DATA')

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const expected = height * (stride + 1)
  if (raw.length < expected) {
    throw new PngError(
      `image data is short (${raw.length} of ${expected} bytes); the file may still be being written`,
      'PNG_INCOMPLETE',
    )
  }

  const out = new Uint8ClampedArray(width * height * 4)
  const prior = new Uint8Array(stride)
  const current = new Uint8Array(stride)
  let pos = 0

  for (let y = 0; y < height; y++) {
    const filter = raw[pos]
    pos += 1
    current.set(raw.subarray(pos, pos + stride))
    pos += stride

    // The five PNG filters, applied in place against the prior row.
    switch (filter) {
      case 0: break
      case 1:
        for (let i = channels; i < stride; i++) current[i] = (current[i] + current[i - channels]) & 0xff
        break
      case 2:
        for (let i = 0; i < stride; i++) current[i] = (current[i] + prior[i]) & 0xff
        break
      case 3:
        for (let i = 0; i < stride; i++) {
          const left = i >= channels ? current[i - channels] : 0
          current[i] = (current[i] + ((left + prior[i]) >> 1)) & 0xff
        }
        break
      case 4:
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? current[i - channels] : 0
          const b = prior[i]
          const c = i >= channels ? prior[i - channels] : 0
          const p = a + b - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - b)
          const pc = Math.abs(p - c)
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
          current[i] = (current[i] + pred) & 0xff
        }
        break
      default:
        throw new PngError(`unknown row filter ${filter}`, 'PNG_BAD_FILTER')
    }

    for (let x = 0; x < width; x++) {
      const s = x * channels
      const d = (y * width + x) * 4
      if (channels === 4) {
        out[d] = current[s]; out[d + 1] = current[s + 1]; out[d + 2] = current[s + 2]; out[d + 3] = current[s + 3]
      } else if (channels === 3) {
        out[d] = current[s]; out[d + 1] = current[s + 1]; out[d + 2] = current[s + 2]; out[d + 3] = 255
      } else if (channels === 2) {
        out[d] = current[s]; out[d + 1] = current[s]; out[d + 2] = current[s]; out[d + 3] = current[s + 1]
      } else {
        out[d] = current[s]; out[d + 1] = current[s]; out[d + 2] = current[s]; out[d + 3] = 255
      }
    }

    prior.set(current)
  }

  return { width, height, pixels: out }
}

/** Minimal PNG encoder for 8-bit RGBA, one IDAT. */
export function encodePng(width, height, rgba) {
  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const compressed = deflateSync(raw)

  const chunks = []
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.writeUInt8(8, 8)   // bit depth
  ihdr.writeUInt8(6, 9)   // RGBA
  ihdr.writeUInt8(0, 10)  // deflate
  ihdr.writeUInt8(0, 11)  // adaptive filtering
  ihdr.writeUInt8(0, 12)  // no interlace
  chunks.push(chunk('IHDR', ihdr))
  chunks.push(chunk('IDAT', compressed))
  chunks.push(chunk('IEND', Buffer.alloc(0)))

  return Buffer.concat([PNG_SIGNATURE, ...chunks])
}

function chunk(type, body) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([typeBuf, body])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0)
  return Buffer.concat([len, typeBuf, body, crc])
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const GREY = [74, 74, 74, 255]

/**
 * Composite frames into one labelled sheet.
 *
 * The background is mid-grey rather than black or white: a captured frame keeps
 * the composition's alpha, and "nothing drawn here" is a finding the reader must
 * be able to tell apart from "black fill" or "white fill".
 *
 * @param {Array<{path:string, time:number, buffer:Buffer}>} frames
 * @param {{columns?:number, gap?:number}} [options]
 * @returns {{width:number, height:number, png:Buffer, columns:number, rows:number, cell:{width:number,height:number}}}
 */
export function buildContactSheet(frames, options = {}) {
  if (!Array.isArray(frames) || frames.length === 0) {
    throw new PngError('no frames to composite', 'SHEET_NO_FRAMES')
  }

  const decoded = frames.map((f) => {
    const img = decodePng(f.buffer)
    // Cells are sized from the first frame; a different size is scaled by
    // nearest-neighbour below rather than rejected, so a sequence captured at a
    // changing resolution still produces a sheet.
    return { ...f, img }
  })

  const cellW = decoded[0].img.width
  const cellH = decoded[0].img.height
  const columns = Math.max(1, Math.min(decoded.length, options.columns ?? Math.ceil(Math.sqrt(decoded.length))))
  const rows = Math.ceil(decoded.length / columns)
  const gap = options.gap ?? 2

  const sheetW = columns * cellW + (columns + 1) * gap
  const sheetH = rows * cellH + (rows + 1) * gap
  const out = new Uint8ClampedArray(sheetW * sheetH * 4)

  for (let i = 0; i < out.length; i += 4) {
    out[i] = GREY[0]; out[i + 1] = GREY[1]; out[i + 2] = GREY[2]; out[i + 3] = 255
  }

  decoded.forEach((frame, i) => {
    const col = i % columns
    const row = Math.floor(i / columns)
    const ox = gap + col * (cellW + gap)
    const oy = gap + row * (cellH + gap)
    const { img } = frame

    for (let y = 0; y < cellH; y++) {
      const sy = Math.min(img.height - 1, Math.floor((y / cellH) * img.height))
      for (let x = 0; x < cellW; x++) {
        const sx = Math.min(img.width - 1, Math.floor((x / cellW) * img.width))
        const s = (sy * img.width + sx) * 4
        const d = ((oy + y) * sheetW + ox + x) * 4
        const a = img.pixels[s + 3] / 255
        // Composite over the grey, so a transparent region reads as "empty"
        // instead of inheriting whatever background the viewer happens to use.
        out[d] = Math.round(img.pixels[s] * a + GREY[0] * (1 - a))
        out[d + 1] = Math.round(img.pixels[s + 1] * a + GREY[1] * (1 - a))
        out[d + 2] = Math.round(img.pixels[s + 2] * a + GREY[2] * (1 - a))
        out[d + 3] = 255
      }
    }
  })

  return {
    width: sheetW,
    height: sheetH,
    png: encodePng(sheetW, sheetH, out),
    columns,
    rows,
    cell: { width: cellW, height: cellH },
    frameTimes: decoded.map((f) => f.time),
  }
}
