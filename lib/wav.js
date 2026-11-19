/**
 * dsh-aftereffects — WAV analysis
 *
 * Reads the *actual samples* out of a PCM WAV file and finds transients, which
 * is what a beat-synced template needs. The previous approach sampled After
 * Effects' `ADBE Audio Levels` property once per frame, which is a level meter,
 * not a waveform: it cannot see anything between frames and it reports silence
 * as a flat line.
 *
 * This module is pure Node — no AE, no native dependency — so it is unit
 * testable against fixture files.
 *
 * Supported: RIFF/WAVE, PCM integer. 8 / 16 / 24 / 32-bit. Any channel count.
 * Everything else returns a typed reason instead of a guess.
 *
 * @module dsh-aftereffects/wav
 */

/** Raised for a file we cannot analyse, with a stable code the tool can report. */
export class WavError extends Error {
  constructor(message, code) {
    super(message)
    this.name = 'WavError'
    this.code = code
  }
}

const WAVE_FORMAT_PCM = 1
const WAVE_FORMAT_IEEE_FLOAT = 3
const WAVE_FORMAT_EXTENSIBLE = 0xfffe

/**
 * Parse the RIFF container into its chunks.
 * @param {Buffer} buf
 * @returns {{format: object, dataOffset: number, dataSize: number}}
 */
function parseRiff(buf) {
  if (buf.length < 12) throw new WavError('file is shorter than a RIFF header', 'WAV_TRUNCATED')
  if (buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new WavError('not a RIFF file (missing "RIFF" magic)', 'WAV_NOT_RIFF')
  }
  const riffSize = buf.readUInt32LE(4)
  if (buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavError('RIFF file is not WAVE (missing "WAVE" form type)', 'WAV_NOT_WAVE')
  }
  // A declared size larger than the file means a truncated download; the chunks
  // we need may still be intact, so this is recorded rather than fatal.
  const declaredEnd = 8 + riffSize
  let fileTruncated = declaredEnd > buf.length

  let offset = 12
  let format = null
  let dataOffset = -1
  let dataSize = 0

  // The chunk list is walked by declared size. A zero-size chunk would loop
  // forever, and a size that runs past the buffer means the file is damaged.
  let guard = 0
  while (offset + 8 <= buf.length) {
    if (guard++ > 10000) throw new WavError('chunk list does not terminate', 'WAV_CHUNK_LOOP')

    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8

    if (id === 'fmt ') {
      if (body + 16 > buf.length) throw new WavError('fmt chunk is truncated', 'WAV_TRUNCATED')
      let audioFormat = buf.readUInt16LE(body)
      const channels = buf.readUInt16LE(body + 2)
      const sampleRate = buf.readUInt32LE(body + 4)
      const byteRate = buf.readUInt32LE(body + 8)
      const blockAlign = buf.readUInt16LE(body + 12)
      const bitsPerSample = buf.readUInt16LE(body + 14)

      // WAVE_FORMAT_EXTENSIBLE hides the real format in the SubFormat GUID.
      if (audioFormat === WAVE_FORMAT_EXTENSIBLE && size >= 40 && body + 26 <= buf.length) {
        const subFormat = buf.readUInt16LE(body + 24)
        if (subFormat === WAVE_FORMAT_PCM || subFormat === WAVE_FORMAT_IEEE_FLOAT) audioFormat = subFormat
      }

      format = { audioFormat, channels, sampleRate, byteRate, blockAlign, bitsPerSample }
    } else if (id === 'data') {
      dataOffset = body
      // Some writers put 0 or a placeholder in the data size. Fall back to
      // "everything from here to the end", which is what such files mean.
      const available = buf.length - body
      dataSize = size === 0 || size > available ? available : size
      if (dataSize <= 0) throw new WavError('data chunk is empty', 'WAV_NO_DATA')
      if (size > available) fileTruncated = true
    }

    // Chunks are word-aligned: an odd size is followed by one pad byte.
    const advance = 8 + size + (size % 2)
    if (advance <= 0) throw new WavError('chunk size is invalid', 'WAV_BAD_CHUNK')
    offset += advance
  }

  if (format === null) throw new WavError('no fmt chunk', 'WAV_NO_FMT')
  if (dataOffset < 0) throw new WavError('no data chunk', 'WAV_NO_DATA')

  return { format, dataOffset, dataSize, fileTruncated }
}

/** Read one sample as a signed float in [-1, 1] for the given format. */
function readSample(buf, pos, bits, audioFormat) {
  if (audioFormat === WAVE_FORMAT_IEEE_FLOAT) {
    if (bits === 32) return buf.readFloatLE(pos)
    if (bits === 64) return buf.readDoubleLE(pos)
    return 0
  }
  switch (bits) {
    case 8:
      // 8-bit WAV is unsigned with a 128 midpoint.
      return (buf.readUInt8(pos) - 128) / 128
    case 16:
      return buf.readInt16LE(pos) / 32768
    case 24: {
      // Assemble the 24 bits as *unsigned* first, then sign-extend by
      // subtracting 2^24. Reading the high byte as signed and shifting it up
      // applies the sign twice, which turned -0.9 into -2.9.
      const u = buf.readUInt16LE(pos) | (buf.readUInt8(pos + 2) << 16)
      const v = (u & 0x800000) ? u - 0x1000000 : u
      return v / 8388608
    }
    case 32:
      return buf.readInt32LE(pos) / 2147483648
    default:
      return 0
  }
}

/**
 * Analyse a WAV file.
 *
 * @param {Buffer} buf the file's bytes
 * @param {object} [options]
 * @param {number} [options.windowMs] analysis window, default 20 ms
 * @param {number} [options.sensitivity] >1 catches fewer peaks; default 1.4
 * @param {number} [options.threshold] absolute floor in [0,1]; default 0.05
 * @param {number} [options.minGapMs] minimum spacing between peaks; default 180 ms
 * @param {number} [options.maxPeaks] cap; default 120
 * @param {boolean} [options.includeWaveform] return the envelope; default false
 * @returns {object} analysis result
 */
export function analyzeWav(buf, options = {}) {
  const { format, dataOffset, dataSize, fileTruncated } = parseRiff(buf)

  const { audioFormat, channels, sampleRate, bitsPerSample } = format
  if (channels <= 0) throw new WavError('channel count is zero', 'WAV_BAD_CHANNELS')
  if (sampleRate <= 0) throw new WavError('sample rate is zero', 'WAV_BAD_SAMPLE_RATE')

  if (audioFormat !== WAVE_FORMAT_PCM && audioFormat !== WAVE_FORMAT_IEEE_FLOAT) {
    throw new WavError(
      `unsupported WAV encoding (format ${audioFormat}); this plugin reads integer PCM and IEEE float only`,
      'WAV_UNSUPPORTED_FORMAT',
    )
  }
  const validBits = audioFormat === WAVE_FORMAT_IEEE_FLOAT ? [32, 64] : [8, 16, 24, 32]
  if (!validBits.includes(bitsPerSample)) {
    throw new WavError(
      `unsupported bit depth ${bitsPerSample}; supported: ${validBits.join(' / ')} bit`,
      'WAV_UNSUPPORTED_DEPTH',
    )
  }

  const bytesPerSample = bitsPerSample / 8
  const frameBytes = bytesPerSample * channels
  const totalFrames = Math.floor(dataSize / frameBytes)
  if (totalFrames <= 0) throw new WavError('no complete sample frames in data chunk', 'WAV_NO_FRAMES')

  const duration = totalFrames / sampleRate

  // One analysis window per `windowMs`. Each window keeps its peak and its RMS:
  // peak alone marks every loud sustained passage, RMS alone misses sharp
  // transients, and a template wants the transient.
  const windowFrames = Math.max(1, Math.round((options.windowMs ?? 20) / 1000 * sampleRate))
  const windowCount = Math.max(1, Math.ceil(totalFrames / windowFrames))

  const peaks = new Float32Array(windowCount)
  const rms = new Float32Array(windowCount)

  let absolutePeak = 0

  for (let w = 0; w < windowCount; w++) {
    const startFrame = w * windowFrames
    const endFrame = Math.min(startFrame + windowFrames, totalFrames)
    let peak = 0
    let sumSquares = 0
    let count = 0

    for (let f = startFrame; f < endFrame; f++) {
      // Channels are mixed by taking the loudest absolute sample: a signal
      // present only on the right channel must not average away on the left.
      let framePeak = 0
      for (let c = 0; c < channels; c++) {
        const pos = dataOffset + (f * channels + c) * bytesPerSample
        if (pos + bytesPerSample > buf.length) break
        const v = readSample(buf, pos, bitsPerSample, audioFormat)
        const a = v < 0 ? -v : v
        if (a > framePeak) framePeak = a
        sumSquares += v * v
        count++
      }
      if (framePeak > peak) peak = framePeak
    }

    peaks[w] = peak
    rms[w] = count > 0 ? Math.sqrt(sumSquares / count) : 0
    if (peak > absolutePeak) absolutePeak = peak
  }

  const windowSeconds = windowFrames / sampleRate
  const silent = absolutePeak < 0.001

  const result = {
    format: {
      encoding: audioFormat === WAVE_FORMAT_IEEE_FLOAT ? 'float' : 'pcm',
      bitsPerSample,
      channels,
      sampleRate,
    },
    duration,
    totalFrames,
    windowMs: windowSeconds * 1000,
    windowCount,
    absolutePeak,
    silent,
    fileTruncated,
    peaks: [],
    stats: null,
  }

  if (silent) {
    // Nothing to detect. Saying so is the honest answer; inventing peaks from a
    // flat line is how the old implementation reported 10 "beats" on silence.
    result.stats = { meanRms: 0, maxRms: 0, threshold: 0 }
    if (options.includeWaveform) result.waveform = buildWaveform(peaks, rms, windowSeconds)
    return result
  }

  let rmsSum = 0
  let rmsMax = 0
  for (let i = 0; i < windowCount; i++) {
    rmsSum += rms[i]
    if (rms[i] > rmsMax) rmsMax = rms[i]
  }
  const meanRms = rmsSum / windowCount

  const sensitivity = options.sensitivity ?? 1.4
  const floor = options.threshold ?? 0.05
  const minGapMs = options.minGapMs ?? 180
  const maxPeaks = Math.max(1, options.maxPeaks ?? 120)

  // A transient is a rise, not just a loud point: the window must be louder
  // than its neighbours and clear both the absolute floor and the local
  // context. The mean-RMS term adapts to quiet versus compressed material.
  const localGate = Math.max(floor, meanRms * sensitivity)
  const minGapWindows = Math.max(1, Math.round(minGapMs / 1000 / windowSeconds))

  const candidates = []
  // The first and last windows are real audio too. A beat on the very first
  // frame of a track — extremely common, the downbeat — was previously skipped
  // because the loop ran 1..n-2 to have two neighbours. Edge windows use their
  // single existing neighbour instead.
  for (let i = 0; i < windowCount; i++) {
    const p = peaks[i]
    if (p < localGate) continue

    const prev = i > 0 ? peaks[i - 1] : 0
    const next = i < windowCount - 1 ? peaks[i + 1] : 0

    // Local maximum of the peak envelope.
    if (p < prev || p < next) continue
    // A transient also has to rise: compare against the quieter neighbour so a
    // sustained loud passage is not chopped into many beats.
    const neighbourFloor = Math.min(prev, next)
    if (p - neighbourFloor < 0.02) continue

    candidates.push({ index: i, time: i * windowSeconds, peak: p, rms: rms[i] })
  }

  // Thin by minimum spacing, keeping the loudest within each gap.
  candidates.sort((a, b) => a.time - b.time)
  const spaced = []
  let cluster = []
  for (const cand of candidates) {
    if (cluster.length === 0) {
      cluster.push(cand)
      continue
    }
    const gap = cand.time - cluster[cluster.length - 1].time
    if (gap < minGapWindows * windowSeconds) {
      cluster.push(cand)
    } else {
      spaced.push(cluster.reduce((a, b) => (b.peak > a.peak ? b : a)))
      cluster = [cand]
    }
  }
  if (cluster.length > 0) spaced.push(cluster.reduce((a, b) => (b.peak > a.peak ? b : a)))

  let selected = spaced
  if (selected.length > maxPeaks) {
    selected = selected.slice().sort((a, b) => b.peak - a.peak).slice(0, maxPeaks).sort((a, b) => a.time - b.time)
  }

  result.peaks = selected.map((c) => ({
    time: Math.round(c.time * 10000) / 10000,
    peak: Math.round(c.peak * 10000) / 10000,
    rms: Math.round(c.rms * 10000) / 10000,
  }))
  result.stats = {
    meanRms: Math.round(meanRms * 10000) / 10000,
    maxRms: Math.round(rmsMax * 10000) / 10000,
    threshold: Math.round(localGate * 10000) / 10000,
    candidates: candidates.length,
  }

  if (options.includeWaveform) result.waveform = buildWaveform(peaks, rms, windowSeconds, options.waveformPoints)

  return result
}

/** Compact envelope for inspecting the shape without shipping every window. */
function buildWaveform(peaks, rms, windowSeconds, points = 200) {
  const n = peaks.length
  const step = Math.max(1, Math.floor(n / points))
  const out = []
  for (let i = 0; i < n; i += step) {
    out.push({
      time: Math.round(i * windowSeconds * 1000) / 1000,
      peak: Math.round(peaks[i] * 1000) / 1000,
      rms: Math.round(rms[i] * 1000) / 1000,
    })
  }
  return out
}

/**
 * Map a time in the source media onto the composition timeline.
 *
 * `stretch` is a percentage (100 = normal). Negative stretch means the layer is
 * reversed, which is where a naive `t + inPoint` flips the answer.
 *
 * @param {number} sourceTime seconds into the source file
 * @param {{inPoint:number, startTime:number, stretch:number, duration:number}} layer
 * @returns {number|null} comp time, or null when it falls outside the layer
 */
export function sourceToCompTime(sourceTime, layer) {
  const stretch = layer.stretch === 0 ? 100 : layer.stretch
  // After Effects: comp time = startTime + (source time - inPointOffset) * (stretch/100)
  // For a layer placed at 0 with stretch 100 and inPoint 0, this is identity.
  const scale = 100 / stretch
  const compTime = layer.startTime + sourceTime * scale
  if (!Number.isFinite(compTime)) return null
  if (compTime < layer.inPoint - 1e-6) return null
  if (compTime > layer.inPoint + layer.duration + 1e-6) return null
  return compTime
}
