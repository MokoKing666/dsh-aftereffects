/**
 * dsh-aftereffects — built-in motion-graphics templates
 *
 * A template is a pure function of its parameters: it returns a *scene spec*,
 * the declarative document that `DSH.buildScene` turns into a composition. No
 * ExtendScript lives here, so a template can be read, diffed and tested as
 * plain data.
 *
 * Scene spec shape (all lengths in composition pixels, all times in seconds):
 *
 *   { name, width, height, fps, duration, background, layers: [LayerSpec] }
 *
 * LayerSpec is one of
 *   { type: 'text',   text, size, color, align, x, y, animate: [...], ... }
 *   { type: 'shape',  shape: 'rect'|'ellipse'|'path', w, h, fill, stroke, ... }
 *   { type: 'solid',  color, w, h, ... }
 *   { type: 'null',   name, ... }
 *
 * `animate` entries are `{ property, from, to, start, end, ease }` where
 * `property` is `opacity`, `scale`, `position`, `position.x`, `rotation`,
 * `anchor`, or `effect:<Effect name>:<Parameter name>`.
 *
 * @module dsh-aftereffects/templates
 */

/* ------------------------------------------------------------------ canvas */

/** Named output shapes. `w`/`h` are what the composition is built at. */
export const ASPECTS = {
  '16:9': { w: 1920, h: 1080 },
  '9:16': { w: 1080, h: 1920 },
  '1:1': { w: 1080, h: 1080 },
  '4:5': { w: 1080, h: 1350 },
  '4:3': { w: 1440, h: 1080 },
  '21:9': { w: 2520, h: 1080 },
}

export const ASPECT_NAMES = Object.keys(ASPECTS)

/** Theme presets; every template accepts an override per field. */
export const THEMES = {
  midnight: { bg: '#0b1020', fg: '#ffffff', accent: '#4c8dff', muted: '#8a93a8' },
  sunset: { bg: '#1a0b14', fg: '#fff4ec', accent: '#ff6b4a', muted: '#c99a8b' },
  mint: { bg: '#07140f', fg: '#f2fff9', accent: '#2ee6a8', muted: '#7fb8a3' },
  paper: { bg: '#f5f2ea', fg: '#15161a', accent: '#e0453a', muted: '#6b6a63' },
  mono: { bg: '#000000', fg: '#ffffff', accent: '#ffffff', muted: '#9a9a9a' },
}

export const THEME_NAMES = Object.keys(THEMES)

/* ----------------------------------------------------------------- helpers */

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

function theme(name, overrides) {
  const base = THEMES[name] ?? THEMES.midnight
  return { ...base, ...(overrides ?? {}) }
}

function canvas(options) {
  const aspect = ASPECTS[options.aspect ?? '16:9'] ?? ASPECTS['16:9']
  return {
    width: isNum(options.width) ? options.width : aspect.w,
    height: isNum(options.height) ? options.height : aspect.h,
    fps: isNum(options.fps) ? options.fps : 30,
  }
}

/** Type scale relative to composition height, so 9:16 does not get tiny text. */
function typeScale(height) {
  return height / 1080
}

function splitWords(value) {
  return String(value ?? '').trim().split(/\s+/).filter(Boolean)
}

/** Round to 2dp so generated documents stay readable and diffable. */
function round(v) {
  return Math.round(v * 100) / 100
}

/* --------------------------------------------------------------- templates */

/**
 * Bold headline with an accent rule and an optional subhead.
 * The workhorse: thumbnails, chapter cards, section breaks.
 */
function title(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 5
  const headline = options.headline ?? options.text ?? 'Your headline'
  const subhead = options.subhead ?? ''
  const cx = c.width / 2
  const cy = c.height / 2

  const layers = [
    {
      type: 'solid',
      name: 'Background',
      color: th.bg,
      animate: [{ property: 'opacity', from: 0, to: 100, start: 0, end: 0.4, ease: 'out' }],
    },
    {
      type: 'shape',
      name: 'Accent rule',
      shape: 'rect',
      w: Math.round(c.width * 0.34),
      h: Math.round(6 * s),
      fill: th.accent,
      x: cx,
      y: cy + 120 * s,
      animate: [
        { property: 'scale.x', from: 0, to: 100, start: 0.15, end: 0.9, ease: 'out' },
        { property: 'opacity', from: 0, to: 100, start: 0.15, end: 0.4, ease: 'out' },
      ],
    },
    {
      type: 'text',
      name: 'Headline',
      text: headline,
      size: Math.round(104 * s),
      color: th.fg,
      align: 'center',
      x: cx,
      y: cy - 40 * s,
      charReveal: { start: 0.25, duration: round(Math.min(1.2, dur * 0.35)) },
      animate: [
        { property: 'scale', from: 94, to: 100, start: 0.1, end: 1.1, ease: 'out' },
        { property: 'opacity', from: 0, to: 100, start: 0.1, end: 0.55, ease: 'out' },
      ],
    },
  ]

  if (subhead !== '') {
    layers.push({
      type: 'text',
      name: 'Subhead',
      text: subhead,
      size: Math.round(38 * s),
      color: th.muted,
      align: 'center',
      x: cx,
      y: cy + 220 * s,
      animate: [
        { property: 'opacity', from: 0, to: 100, start: 0.9, end: 1.5, ease: 'out' },
        { property: 'position.y', from: cy + 250 * s, to: cy + 220 * s, start: 0.9, end: 1.6, ease: 'out' },
      ],
    })
  }

  if (options.outro !== false) {
    layers.push({
      type: 'solid',
      name: 'Outro fade',
      color: '#000000',
      opacity: 0,
      animate: [{ property: 'opacity', from: 0, to: 100, start: round(Math.max(0, dur - 0.6)), end: dur, ease: 'in' }],
    })
  }

  return {
    name: options.compName ?? 'Title',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers,
  }
}

/** Name + role bar that slides in from the left. */
function lowerThird(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 5
  const person = options.name ?? options.headline ?? 'Jane Doe'
  const role = options.role ?? options.subhead ?? 'Designer'

  const barW = Math.round(c.width * 0.42)
  const barH = Math.round(150 * s)
  const x = Math.round(c.width * 0.06)
  const y = Math.round(c.height * 0.72)

  return {
    name: options.compName ?? 'Lower third',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers: [
      { type: 'solid', name: 'Background', color: th.bg },
      {
        type: 'shape',
        name: 'Bar',
        shape: 'rect',
        w: barW,
        h: barH,
        fill: th.accent,
        x,
        y,
        animate: [{ property: 'scale.x', from: 0, to: 100, start: 0.3, end: 0.9, ease: 'out' }],
      },
      {
        type: 'shape',
        name: 'Rule',
        shape: 'rect',
        w: Math.round(barW * 0.96),
        h: Math.round(4 * s),
        fill: th.fg,
        x: x + Math.round(barW * 0.02),
        y: y + barH / 2 + 14 * s,
        animate: [{ property: 'scale.x', from: 0, to: 100, start: 0.45, end: 1.1, ease: 'out' }],
      },
      {
        type: 'text',
        name: 'Name',
        text: person,
        size: Math.round(62 * s),
        color: th.bg,
        align: 'left',
        x: x - barW / 2 + 36 * s,
        y: y - 26 * s,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 0.55, end: 1.1, ease: 'out' }],
      },
      {
        type: 'text',
        name: 'Role',
        text: role,
        size: Math.round(30 * s),
        color: th.bg,
        align: 'left',
        x: x - barW / 2 + 36 * s,
        y: y + 34 * s,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 0.75, end: 1.3, ease: 'out' }],
      },
      {
        type: 'solid',
        name: 'Outro fade',
        color: '#000000',
        opacity: 0,
        animate: [{ property: 'opacity', from: 0, to: 100, start: round(Math.max(0, dur - 0.5)), end: dur, ease: 'in' }],
      },
    ],
  }
}

/** Rounded CTA button with a soft glow pulse. */
function callToAction(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 4
  const label = options.label ?? options.headline ?? 'Subscribe'
  const cx = c.width / 2
  const cy = c.height / 2
  const btnW = Math.round(c.width * 0.34)
  const btnH = Math.round(120 * s)

  return {
    name: options.compName ?? 'Call to action',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers: [
      { type: 'solid', name: 'Background', color: th.bg },
      {
        type: 'shape',
        name: 'Button',
        shape: 'rect',
        w: btnW,
        h: btnH,
        radius: Math.round(btnH / 2),
        fill: th.accent,
        x: cx,
        y: cy,
        effects: [{ name: 'glow', radius: Math.round(30 * s), intensity: 1.4 }],
        animate: [
          { property: 'scale', from: 0, to: 100, start: 0.1, end: 0.8, ease: 'out' },
          { property: 'scale', from: 100, to: 104, start: 1.2, end: 1.9, ease: 'both' },
          { property: 'scale', from: 104, to: 100, start: 1.9, end: 2.6, ease: 'both' },
        ],
      },
      {
        type: 'text',
        name: 'Label',
        text: label,
        size: Math.round(52 * s),
        color: th.bg,
        align: 'center',
        x: cx,
        y: cy,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 0.5, end: 1.0, ease: 'out' }],
      },
    ],
  }
}

/** Circular mask expansion behind a wordmark. */
function logoReveal(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 4
  const brand = options.brand ?? options.headline ?? 'ACME'
  const cx = c.width / 2
  const cy = c.height / 2
  const diameter = Math.round(Math.min(c.width, c.height) * 0.42)

  const layers = [
    { type: 'solid', name: 'Background', color: th.bg },
    {
      type: 'shape',
      name: 'Disc',
      shape: 'ellipse',
      w: diameter,
      h: diameter,
      fill: th.accent,
      x: cx,
      y: cy,
      animate: [
        { property: 'scale', from: 0, to: 100, start: 0.15, end: 1.0, ease: 'out' },
        { property: 'rotation', from: -30, to: 0, start: 0.15, end: 1.2, ease: 'out' },
      ],
    },
    {
      type: 'text',
      name: 'Brand',
      text: brand,
      size: Math.round(96 * s),
      color: th.bg,
      align: 'center',
      x: cx,
      y: cy,
      charReveal: { start: 0.8, duration: 0.9 },
    },
  ]

  if (options.tagline !== undefined && options.tagline !== '') {
    layers.push({
      type: 'text',
      name: 'Tagline',
      text: options.tagline,
      size: Math.round(30 * s),
      color: th.muted,
      align: 'center',
      x: cx,
      y: cy + diameter * 0.72,
      animate: [{ property: 'opacity', from: 0, to: 100, start: 1.5, end: 2.2, ease: 'out' }],
    })
  }

  return {
    name: options.compName ?? 'Logo reveal',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers,
  }
}

/** 3-2-1 countdown built from one text layer per digit. */
function countdown(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const from = isNum(options.from) ? Math.max(1, Math.min(10, Math.round(options.from))) : 3
  const step = isNum(options.step) ? options.step : 1
  const cx = c.width / 2
  const cy = c.height / 2
  const layers = [{ type: 'solid', name: 'Background', color: th.bg }]

  for (let i = 0; i < from; i++) {
    const value = from - i
    const at = i * step
    layers.push({
      type: 'text',
      name: `Digit ${value}`,
      text: String(value),
      size: Math.round(360 * s),
      color: th.fg,
      align: 'center',
      x: cx,
      y: cy,
      inPoint: at,
      outPoint: at + step,
      animate: [
        { property: 'scale', from: 160, to: 100, start: at, end: at + step * 0.6, ease: 'out' },
        { property: 'opacity', from: 0, to: 100, start: at, end: at + step * 0.25, ease: 'out' },
        { property: 'opacity', from: 100, to: 0, start: at + step * 0.75, end: at + step, ease: 'in' },
      ],
    })
  }

  return {
    name: options.compName ?? 'Countdown',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: round(from * step + 0.5),
    background: th.bg,
    layers,
  }
}

/** Big number with a label and a progress rule. */
function statCard(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 5
  const value = options.value ?? '128%'
  const label = options.label ?? options.headline ?? 'growth this year'
  const cx = c.width / 2
  const cy = c.height / 2

  return {
    name: options.compName ?? 'Stat card',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers: [
      { type: 'solid', name: 'Background', color: th.bg },
      {
        type: 'text',
        name: 'Value',
        text: value,
        size: Math.round(220 * s),
        color: th.accent,
        align: 'center',
        x: cx,
        y: cy - 60 * s,
        animate: [
          { property: 'scale', from: 70, to: 100, start: 0.15, end: 0.95, ease: 'out' },
          { property: 'opacity', from: 0, to: 100, start: 0.15, end: 0.6, ease: 'out' },
        ],
      },
      {
        type: 'text',
        name: 'Label',
        text: label,
        size: Math.round(40 * s),
        color: th.muted,
        align: 'center',
        x: cx,
        y: cy + 130 * s,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 0.7, end: 1.3, ease: 'out' }],
      },
      {
        type: 'shape',
        name: 'Rule',
        shape: 'rect',
        w: Math.round(c.width * 0.5),
        h: Math.round(5 * s),
        fill: th.accent,
        x: cx,
        y: cy + 210 * s,
        animate: [{ property: 'scale.x', from: 0, to: 100, start: 1.0, end: 1.9, ease: 'out' }],
      },
    ],
  }
}

/** Pull quote with attribution. */
function quoteCard(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 6
  const quote = options.quote ?? options.text ?? 'The details are not the details. They make the design.'
  const author = options.author ?? options.subhead ?? 'Charles Eames'
  const cx = c.width / 2
  const cy = c.height / 2

  return {
    name: options.compName ?? 'Quote',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers: [
      { type: 'solid', name: 'Background', color: th.bg },
      {
        type: 'text',
        name: 'Mark',
        text: '\u201C',
        size: Math.round(320 * s),
        color: th.accent,
        align: 'center',
        x: Math.round(c.width * 0.2),
        y: Math.round(c.height * 0.3),
        animate: [{ property: 'opacity', from: 0, to: 100, start: 0.1, end: 0.7, ease: 'out' }],
      },
      {
        type: 'text',
        name: 'Quote',
        text: quote,
        size: Math.round(64 * s),
        color: th.fg,
        align: 'center',
        x: cx,
        y: cy,
        charReveal: { start: 0.3, duration: round(Math.min(1.6, dur * 0.35)) },
      },
      {
        type: 'text',
        name: 'Author',
        text: `\u2014 ${author}`,
        size: Math.round(34 * s),
        color: th.muted,
        align: 'center',
        x: cx,
        y: cy + 190 * s,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 1.4, end: 2.0, ease: 'out' }],
      },
    ],
  }
}

/** One word at a time, each replacing the last. */
function kineticText(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const words = Array.isArray(options.words) && options.words.length > 0
    ? options.words
    : splitWords(options.text ?? 'MAKE IT MOVE')
  const hold = isNum(options.hold) ? options.hold : 0.7
  const cx = c.width / 2
  const cy = c.height / 2
  const layers = [{ type: 'solid', name: 'Background', color: th.bg }]

  words.forEach((word, i) => {
    const at = round(i * hold)
    layers.push({
      type: 'text',
      name: `Word ${i + 1}`,
      text: String(word),
      size: Math.round(150 * s),
      color: i % 2 === 0 ? th.fg : th.accent,
      align: 'center',
      x: cx,
      y: cy,
      inPoint: at,
      outPoint: round(at + hold),
      animate: [
        { property: 'position.y', from: cy + 60 * s, to: cy, start: at, end: round(at + hold * 0.5), ease: 'out' },
        { property: 'opacity', from: 0, to: 100, start: at, end: round(at + hold * 0.35), ease: 'out' },
        { property: 'opacity', from: 100, to: 0, start: round(at + hold * 0.75), end: round(at + hold), ease: 'in' },
      ],
    })
  })

  return {
    name: options.compName ?? 'Kinetic text',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: round(words.length * hold + 0.3),
    background: th.bg,
    layers,
  }
}

/** Closing card with a call to action line. */
function endCard(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const s = typeScale(c.height)
  const dur = isNum(options.duration) ? options.duration : 5
  const headline = options.headline ?? 'Thanks for watching'
  const handle = options.handle ?? options.subhead ?? '@yourchannel'
  const cx = c.width / 2
  const cy = c.height / 2

  return {
    name: options.compName ?? 'End card',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers: [
      { type: 'solid', name: 'Background', color: th.bg },
      {
        type: 'shape',
        name: 'Accent bar',
        shape: 'rect',
        w: Math.round(c.width * 0.6),
        h: Math.round(10 * s),
        fill: th.accent,
        x: cx,
        y: cy - 130 * s,
        animate: [{ property: 'scale.x', from: 0, to: 100, start: 0.1, end: 0.9, ease: 'out' }],
      },
      {
        type: 'text',
        name: 'Headline',
        text: headline,
        size: Math.round(88 * s),
        color: th.fg,
        align: 'center',
        x: cx,
        y: cy,
        charReveal: { start: 0.35, duration: 1.0 },
      },
      {
        type: 'text',
        name: 'Handle',
        text: handle,
        size: Math.round(38 * s),
        color: th.muted,
        align: 'center',
        x: cx,
        y: cy + 140 * s,
        animate: [{ property: 'opacity', from: 0, to: 100, start: 1.1, end: 1.7, ease: 'out' }],
      },
    ],
  }
}

/** Slowly drifting dots — a background plate to composite under anything. */
function particleField(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const dur = isNum(options.duration) ? options.duration : 8
  const count = isNum(options.count) ? Math.max(1, Math.min(options.count, 60)) : 24
  const s = typeScale(c.height)
  const layers = [{ type: 'solid', name: 'Background', color: th.bg }]

  // Deterministic scatter: a golden-ratio sequence keeps it evenly spread and
  // reproducible across runs, which matters when a render is compared.
  const phi = 0.6180339887498949
  for (let i = 0; i < count; i++) {
    const fx = (i * phi) % 1
    const fy = (i * phi * 1.7 + 0.31) % 1
    const size = Math.round((10 + ((i * 7) % 26)) * s)
    const x = Math.round(fx * c.width)
    const y = Math.round(fy * c.height)
    const delay = round((i % 10) * 0.12)
    layers.push({
      type: 'shape',
      name: `Dot ${i + 1}`,
      shape: 'ellipse',
      w: size,
      h: size,
      fill: i % 4 === 0 ? th.accent : th.muted,
      opacity: 40 + ((i * 13) % 50),
      x,
      y,
      animate: [
        { property: 'position.y', from: y + 40 * s, to: y - 40 * s, start: delay, end: dur, ease: 'linear' },
        { property: 'opacity', from: 0, to: 60, start: delay, end: round(delay + 1.2), ease: 'out' },
      ],
    })
  }

  return {
    name: options.compName ?? 'Particle field',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers,
  }
}

/** Gradient wash with a slow rotating ramp. */
function gradientWash(options) {
  const th = theme(options.theme, options.colors)
  const c = canvas(options)
  const dur = isNum(options.duration) ? options.duration : 8
  const layers = [
    { type: 'solid', name: 'Background', color: th.bg },
    {
      type: 'solid',
      name: 'Gradient',
      color: th.accent,
      blend: 'screen',
      opacity: 60,
      effects: [
        {
          name: 'ramp',
          start: [0, 0],
          startColor: th.accent,
          end: [c.width, c.height],
          endColor: th.bg,
        },
        { name: 'blur', amount: 120 },
      ],
      animate: [
        { property: 'rotation', from: 0, to: 12, start: 0, end: dur, ease: 'linear' },
        { property: 'scale', from: 120, to: 130, start: 0, end: dur, ease: 'linear' },
      ],
    },
  ]

  return {
    name: options.compName ?? 'Gradient wash',
    width: c.width,
    height: c.height,
    fps: c.fps,
    duration: dur,
    background: th.bg,
    layers,
  }
}

/* ------------------------------------------------------------------ registry */

export const TEMPLATES = {
  title: {
    build: title,
    summary: 'Bold headline, accent rule and optional subhead; scale-in and per-character reveal.',
    params: ['headline', 'subhead', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  'lower-third': {
    build: lowerThird,
    summary: 'Name and role on an accent bar that wipes in from the left.',
    params: ['name', 'role', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  cta: {
    build: callToAction,
    summary: 'Rounded call-to-action button with a soft glow pulse.',
    params: ['label', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  'logo-reveal': {
    build: logoReveal,
    summary: 'Accent disc expands and settles behind a brand wordmark.',
    params: ['brand', 'tagline', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  countdown: {
    build: countdown,
    summary: 'Counting digits, one layer per number, each popping and fading.',
    params: ['from', 'step', 'theme', 'aspect', 'fps', 'colors'],
  },
  stat: {
    build: statCard,
    summary: 'Oversized value with a caption and an animated rule.',
    params: ['value', 'label', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  quote: {
    build: quoteCard,
    summary: 'Pull quote with an oversized quote mark and attribution.',
    params: ['quote', 'author', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  kinetic: {
    build: kineticText,
    summary: 'One word at a time, alternating foreground and accent colour.',
    params: ['words', 'text', 'hold', 'theme', 'aspect', 'fps', 'colors'],
  },
  'end-card': {
    build: endCard,
    summary: 'Closing card with a headline, accent bar and handle.',
    params: ['headline', 'handle', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  particles: {
    build: particleField,
    summary: 'Deterministically scattered dots drifting upward; a background plate.',
    params: ['count', 'theme', 'aspect', 'duration', 'fps', 'colors'],
  },
  gradient: {
    build: gradientWash,
    summary: 'Slow rotating gradient wash with blur; a background plate.',
    params: ['theme', 'aspect', 'duration', 'fps', 'colors'],
  },
}

export const TEMPLATE_NAMES = Object.keys(TEMPLATES)

/**
 * Build a scene spec from a template name and options.
 * @param {string} name one of {@link TEMPLATE_NAMES}
 * @param {object} [options]
 * @returns {object} scene spec for `DSH.buildScene`
 */
export function buildTemplate(name, options = {}) {
  const template = TEMPLATES[name]
  if (template === undefined) {
    const error = new Error(`unknown template "${name}"; available: ${TEMPLATE_NAMES.join(', ')}`)
    error.code = 'UNKNOWN_TEMPLATE'
    throw error
  }
  return template.build(options)
}

/** Catalogue for the model and for `ae_template` with no arguments. */
export function templateCatalog() {
  return TEMPLATE_NAMES.map((name) => ({
    name,
    summary: TEMPLATES[name].summary,
    params: TEMPLATES[name].params,
  }))
}
