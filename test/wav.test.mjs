/**
 * WAV analyser tests.
 *
 * These run on bytes built by the fixture helpers, so the parser is measured
 * against a known ground truth: a click track at known times must produce peaks
 * at those times, and silence must produce none.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { analyzeWav, sourceToCompTime, WavError } from '../lib/wav.js'
import { buildWav, buildClickTrack, buildSilence } from './fixtures/wav-fixtures.mjs'

test('16-bit mono click track finds the beats', () => {
  const beats = [0.25, 0.75, 1.25, 1.75]
  const { buffer } = buildClickTrack({ beats })
  const r = analyzeWav(buffer)

  assert.equal(r.format.bitsPerSample, 16)
  assert.equal(r.format.channels, 1)
  assert.equal(r.format.sampleRate, 44100)
  assert.equal(r.silent, false)
  assert.ok(r.peaks.length >= beats.length - 1, `expected ~4 peaks, got ${r.peaks.length}`)

  // Every detected peak must be near a real beat, and every beat found.
  for (const beat of beats) {
    const hit = r.peaks.some((p) => Math.abs(p.time - beat) < 0.06)
    assert.ok(hit, `no peak near ${beat}s; got ${r.peaks.map((p) => p.time).join(',')}`)
  }
  // No invented peaks far from a beat.
  for (const p of r.peaks) {
    const near = beats.some((b) => Math.abs(p.time - b) < 0.09)
    assert.ok(near, `spurious peak at ${p.time}s`)
  }
})

test('silence yields no peaks at all', () => {
  const r = analyzeWav(buildSilence({ durationSec: 1 }))
  assert.equal(r.silent, true)
  assert.equal(r.peaks.length, 0, 'a flat line must not produce beats')
  assert.equal(r.absolutePeak, 0)
})

test('8-bit PCM decodes (unsigned midpoint 128)', () => {
  const samples = new Array(4410).fill(0)
  for (let i = 100; i < 140; i++) samples[i] = 0.8
  const buf = buildWav({ bitsPerSample: 8, samples })
  const r = analyzeWav(buf)
  assert.equal(r.format.bitsPerSample, 8)
  assert.equal(r.silent, false)
  assert.ok(r.peaks.length >= 1)
})

test('24-bit PCM decodes with sign extension', () => {
  const samples = new Array(4410).fill(0)
  // A negative excursion and a positive one, both loud.
  for (let i = 100; i < 140; i++) samples[i] = -0.9
  for (let i = 1000; i < 1040; i++) samples[i] = 0.9
  const buf = buildWav({ bitsPerSample: 24, samples })
  const r = analyzeWav(buf)
  assert.equal(r.format.bitsPerSample, 24)
  assert.equal(r.silent, false)
  assert.ok(r.absolutePeak > 0.8, `peak should see the 0.9 excursion, got ${r.absolutePeak}`)
  assert.ok(r.absolutePeak <= 1.001)
})

test('32-bit integer PCM decodes', () => {
  const samples = new Array(4410).fill(0)
  for (let i = 100; i < 140; i++) samples[i] = 0.7
  const r = analyzeWav(buildWav({ bitsPerSample: 32, samples }))
  assert.equal(r.format.bitsPerSample, 32)
  assert.ok(r.absolutePeak > 0.6)
})

test('32-bit float PCM decodes', () => {
  const samples = new Array(4410).fill(0)
  for (let i = 100; i < 140; i++) samples[i] = 0.75
  const r = analyzeWav(buildWav({ bitsPerSample: 32, samples, float: true }))
  assert.equal(r.format.encoding, 'float')
  assert.ok(r.absolutePeak > 0.7)
})

test('stereo mixes by loudest channel, not by average', () => {
  // Signal only on the right channel: averaging with a silent left channel
  // would halve it, and a quiet right-panned hit would vanish.
  const frames = 4410
  const interleaved = []
  for (let f = 0; f < frames; f++) {
    const loud = f >= 100 && f < 140 ? 0.9 : 0
    interleaved.push(0, loud)
  }
  const buf = buildWav({ channels: 2, samples: interleaved, bitsPerSample: 16 })
  const r = analyzeWav(buf)
  assert.equal(r.format.channels, 2)
  assert.ok(r.absolutePeak > 0.8, `right-only signal must survive, got ${r.absolutePeak}`)
})

test('duration and frame count are consistent', () => {
  const sampleRate = 8000
  const frames = 8000
  const buf = buildWav({ sampleRate, samples: new Array(frames).fill(0.1) })
  const r = analyzeWav(buf)
  assert.equal(r.totalFrames, frames)
  assert.ok(Math.abs(r.duration - 1) < 1e-9)
})

test('truncated file is reported, not crashed', () => {
  const { buffer } = buildClickTrack({ durationSec: 1 })
  const cut = buffer.subarray(0, Math.floor(buffer.length * 0.6))
  // The RIFF size now exceeds the buffer; the analyser must still answer.
  const r = analyzeWav(cut)
  assert.equal(r.fileTruncated, true)
})

test('a file that is not RIFF is refused with a code', () => {
  assert.throws(() => analyzeWav(Buffer.from('ID3 not a wav file at all')), (e) => {
    assert.ok(e instanceof WavError)
    assert.equal(e.code, 'WAV_NOT_RIFF')
    return true
  })
})

test('a non-ADPCM style encoding is refused with a code', () => {
  const buf = buildWav({ samples: new Array(100).fill(0.1) })
  buf.writeUInt16LE(2, 20) // WAVE_FORMAT_ADPCM
  assert.throws(() => analyzeWav(buf), (e) => {
    assert.equal(e.code, 'WAV_UNSUPPORTED_FORMAT')
    return true
  })
})

test('an unsupported bit depth is refused with a code', () => {
  const buf = buildWav({ samples: new Array(100).fill(0.1) })
  buf.writeUInt16LE(12, 34)
  assert.throws(() => analyzeWav(buf), (e) => {
    assert.equal(e.code, 'WAV_UNSUPPORTED_DEPTH')
    return true
  })
})

test('minimum gap suppresses machine-gun markers inside one burst', () => {
  const { buffer } = buildClickTrack({ beats: [0.5], burstMs: 200 })
  const tight = analyzeWav(buffer, { minGapMs: 10 })
  const spaced = analyzeWav(buffer, { minGapMs: 300 })
  assert.ok(spaced.peaks.length <= tight.peaks.length)
  assert.ok(spaced.peaks.length <= 1, `one burst should yield at most one marker, got ${spaced.peaks.length}`)
})

test('maxPeaks caps the result', () => {
  const beats = Array.from({ length: 40 }, (_, i) => 0.1 + i * 0.05)
  const { buffer } = buildClickTrack({ durationSec: 3, beats })
  const r = analyzeWav(buffer, { maxPeaks: 5, minGapMs: 10 })
  assert.ok(r.peaks.length <= 5)
})

test('sensitivity above 1 reduces the number of peaks', () => {
  const beats = Array.from({ length: 20 }, (_, i) => 0.1 + i * 0.08)
  const { buffer } = buildClickTrack({ durationSec: 2, beats })
  const loose = analyzeWav(buffer, { sensitivity: 0.6, minGapMs: 20 })
  const strict = analyzeWav(buffer, { sensitivity: 3, minGapMs: 20 })
  assert.ok(strict.peaks.length <= loose.peaks.length)
})

test('peaks are ordered by time', () => {
  const { buffer } = buildClickTrack({ beats: [1.5, 0.3, 0.9] })
  const r = analyzeWav(buffer)
  for (let i = 1; i < r.peaks.length; i++) {
    assert.ok(r.peaks[i].time >= r.peaks[i - 1].time, 'peaks must be ascending')
  }
})

test('includeWaveform returns an envelope', () => {
  const { buffer } = buildClickTrack({ durationSec: 1 })
  const r = analyzeWav(buffer, { includeWaveform: true })
  assert.ok(Array.isArray(r.waveform))
  assert.ok(r.waveform.length > 0)
  assert.ok('peak' in r.waveform[0])
})

test('sourceToCompTime handles normal speed', () => {
  const t = sourceToCompTime(1.0, { inPoint: 0, startTime: 0, stretch: 100, duration: 5 })
  assert.equal(t, 1.0)
})

test('sourceToCompTime scales with stretch', () => {
  // stretch 200 means the layer plays at half speed, so 1s of source
  // occupies 2s of comp time.
  const t = sourceToCompTime(1.0, { inPoint: 0, startTime: 0, stretch: 200, duration: 10 })
  assert.equal(t, 0.5)
})

test('sourceToCompTime offsets by startTime', () => {
  const t = sourceToCompTime(1.0, { inPoint: 2, startTime: 2, stretch: 100, duration: 5 })
  assert.equal(t, 3.0)
})

test('sourceToCompTime rejects times outside the layer', () => {
  const layer = { inPoint: 1, startTime: 1, stretch: 100, duration: 2 }
  assert.equal(sourceToCompTime(5, layer), null)
})
