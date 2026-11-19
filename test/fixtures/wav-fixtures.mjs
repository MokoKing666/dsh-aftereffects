/**
 * Fixture builders for the WAV analyser tests.
 *
 * The point of writing WAV files by hand here is that the parser under test
 * must be exercised against bytes, not against a library that already agreed
 * with itself. Each builder produces the exact RIFF layout it claims.
 */

/** Build a PCM WAV with the given samples (already interleaved, in [-1,1]). */
export function buildWav({ sampleRate = 44100, channels = 1, bitsPerSample = 16, samples = [], float = false }) {
  const bytesPerSample = bitsPerSample / 8
  const dataSize = samples.length * bytesPerSample
  const fmtSize = 16
  const headerSize = 12 + 8 + fmtSize + 8
  const buf = Buffer.alloc(headerSize + dataSize)

  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(4 + 8 + fmtSize + 8 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')

  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(fmtSize, 16)
  buf.writeUInt16LE(float ? 3 : 1, 20)
  buf.writeUInt16LE(channels, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28)
  buf.writeUInt16LE(channels * bytesPerSample, 32)
  buf.writeUInt16LE(bitsPerSample, 34)

  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)

  let pos = 44
  for (const s of samples) {
    if (float) {
      buf.writeFloatLE(s, pos)
    } else if (bitsPerSample === 8) {
      buf.writeUInt8(Math.max(0, Math.min(255, Math.round(s * 128 + 128))), pos)
    } else if (bitsPerSample === 16) {
      buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32768))), pos)
    } else if (bitsPerSample === 24) {
      const v = Math.max(-8388608, Math.min(8388607, Math.round(s * 8388608)))
      const u = v < 0 ? v + 0x1000000 : v
      buf.writeUInt16LE(u & 0xffff, pos)
      buf.writeUInt8((u >> 16) & 0xff, pos + 2)
    } else if (bitsPerSample === 32) {
      buf.writeInt32LE(Math.max(-2147483648, Math.min(2147483647, Math.round(s * 2147483648))), pos)
    }
    pos += bytesPerSample
  }

  return buf
}

/**
 * A click track: silence with short loud bursts at the requested times.
 * This is what a beat-sync template is actually driven by, so the detector has
 * a ground truth to be measured against.
 */
export function buildClickTrack({ sampleRate = 44100, durationSec = 2, beats = [0.25, 0.75, 1.25, 1.75], amplitude = 0.9, burstMs = 20 }) {
  const total = Math.floor(sampleRate * durationSec)
  const samples = new Float64Array(total)
  const burstLen = Math.floor((burstMs / 1000) * sampleRate)
  for (const beat of beats) {
    const start = Math.floor(beat * sampleRate)
    for (let i = 0; i < burstLen && start + i < total; i++) {
      // A decaying burst reads as a transient, not a square wave edge.
      const envelope = 1 - i / burstLen
      samples[start + i] = amplitude * envelope
    }
  }
  return { buffer: buildWav({ sampleRate, channels: 1, bitsPerSample: 16, samples: Array.from(samples) }), beats }
}

/** Pure silence. */
export function buildSilence({ sampleRate = 44100, durationSec = 1 }) {
  const total = Math.floor(sampleRate * durationSec)
  return buildWav({ sampleRate, channels: 1, bitsPerSample: 16, samples: new Array(total).fill(0) })
}
