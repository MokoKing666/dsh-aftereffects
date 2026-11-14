# dsh-aftereffects

Drive **Adobe After Effects** from DeepSeek Harness. Ask for a title card, a lower
third, a countdown or a full composition, and get an MP4 back — without leaving
the conversation.

```text
you ▸ 用 title 模板做一条 3 秒片头，主题 sunset，然后渲染成 mp4
dsh ▸ ae_template({ template: "title", options: { headline: "…", theme: "sunset", duration: 3 } })
      ae_render({ output: "C:/out/intro.mp4", format: "mp4" })
      → 1920×1080 · 3.0s · 24fps · 334 KB
```

## What it adds

| Tool | What it does |
| --- | --- |
| `ae_status` | Reports the install path, whether a headless instance is running, the AE version and locale, the available output templates, and the built-in template catalogue. `action: "start"` boots After Effects, `"stop"` shuts it down. |
| `ae_template` | Builds a composition from one of eleven built-in motion-graphics templates. `template: "list"` prints the catalogue. |
| `ae_compose` | Builds a composition from a declarative scene document — the general form behind every template. |
| `ae_render` | Renders a composition to H.264 MP4, PNG sequence, QuickTime, AVI, TIFF or PSD. With `stillAt` it exports a single PNG frame instead. |

## Templates

| Name | Result |
| --- | --- |
| `title` | Headline, accent rule, optional subhead; scale-in and per-character reveal. |
| `lower-third` | Name and role on an accent bar wiping in from the left. |
| `cta` | Rounded call-to-action button with a soft glow pulse. |
| `logo-reveal` | Accent disc expands behind a brand wordmark, tagline fades in. |
| `countdown` | Counting digits, one layer per number. |
| `stat` | Oversized value, caption and an animated rule. |
| `quote` | Pull quote with an oversized quote mark and attribution. |
| `kinetic` | One word at a time, alternating foreground and accent colour. |
| `end-card` | Closing card with headline, accent bar and handle. |
| `particles` | Deterministically scattered dots drifting upward — a background plate. |
| `gradient` | Slow rotating gradient wash with blur — a background plate. |

Every template takes `theme` (`midnight` `sunset` `mint` `paper` `mono`),
`aspect` (`16:9` `9:16` `1:1` `4:5` `4:3` `21:9`), `duration`, `fps`,
`colors` (override any theme colour) and `compName`.

## Composing by hand

`ae_compose` takes a scene document. Layers are built in array order, so the
first entry sits on top.

```json
{
  "name": "My comp",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "duration": 6,
  "background": "#0b1020",
  "layers": [
    {
      "type": "text",
      "text": "SHIP IT",
      "size": 140,
      "color": "#ffffff",
      "align": "center",
      "x": 960,
      "y": 540,
      "charReveal": { "start": 0.3, "duration": 1.0 },
      "animate": [
        { "property": "scale", "from": 92, "to": 100, "start": 0.1, "end": 1.0, "ease": "out" }
      ]
    },
    {
      "type": "shape",
      "shape": "rect",
      "w": 720,
      "h": 8,
      "fill": "#4c8dff",
      "x": 960,
      "y": 680,
      "animate": [
        { "property": "scale.x", "from": 0, "to": 100, "start": 0.6, "end": 1.5, "ease": "out" }
      ]
    }
  ]
}
```

- **Layer types** — `text`, `shape` (`rect` / `ellipse` / `path`), `solid`,
  `null`, `footage` (import an image or video), `precomp` (nest another comp).
- **Animation** — `{ property, from, to, start, end, ease }`. `property` is
  `opacity`, `scale`, `scale.x`, `position`, `position.y`, `rotation`, `anchor`,
  or `effect:<Effect>:<Parameter>`. `ease` is `linear`, `in`, `out`, `both` or
  `hold`.
- **Effects** — `[{ "name": "glow", "radius": 40, "intensity": 1.5 }]`. Friendly
  parameter keys (`radius`, `intensity`, `amount`, `direction`, `color`, …) map
  to the effect's stable parameter matchNames, so they work on a localised
  After Effects too.
- **Text extras** — `charReveal` reveals per character through a text animator;
  `typewriter` types the string out with a source-text expression.

## Requirements

- **After Effects installed locally.** Tested against After Effects 2026 (26.5).
  The plugin auto-detects the newest non-beta install under `Program Files\Adobe`
  (or `/Applications`), or takes an explicit path.
- **Windows or macOS.** The bridge spawns `AfterFX.exe -noui -r <script>`; the
  macOS binary lives at `After Effects.app/Contents/MacOS/After Effects` and
  accepts the same flags.
- **Node 18+** in the Harness runtime (already true for DSH).

## How it works

After Effects has no automation server, so the plugin uses the one channel Adobe
supports: running ExtendScript inside the application.

1. `lib/bridge.js` spawns `AfterFX.exe -noui -r <bootstrap>` — a headless
   instance with no UI. It cannot run beside an After Effects window the user has
   open, so close that window first.
2. `lib/ae-daemon.jsx` is that bootstrap. It loads `lib/ae-runtime.jsx`, writes a
   heartbeat, and then polls a job directory.
3. A tool call drops one JSON job file and waits for the matching result file.
   Round-trip on a warm instance is about 250 ms.

The daemon exits by itself after `keepAliveMs` (30 minutes by default) and when
the plugin unloads, so no After Effects process is left behind.

The whole ExtendScript layer is ES3 and locale-independent: effects are added by
`matchName`, and effect parameters are addressed by their stable `ADBE …-000n`
matchNames rather than their translated display names.

PNG sequences are exported frame by frame with `saveFrameToPng`, because the
render queue's only PNG output templates are After Effects' internal
`_HIDDEN X-Factor` variants, which write a single image for the whole range.

## Configuration

Set these under the plugin's row in the profile's `cordis.patch.yml`:

```yaml
- id: dsh-aftereffects
  name: dsh-aftereffects
  config:
    executable: 'C:\Program Files\Adobe\Adobe After Effects 2026\Support Files\AfterFX.exe'
    workDir: ''            # default: $DSH_HOME/aftereffects
    launchTimeoutMs: 120000
    jobTimeoutMs: 900000
    keepAliveMs: 1800000
```

## Limitations

- Rendering is synchronous: `ae_render` blocks until the render queue finishes.
  A long composition holds the tool call for its whole duration.
- One headless instance at a time. A second launch attempt while an After Effects
  window is open fails with a clear message.
- Only the render queue and `saveFrameToPng` are used, so anything that requires
  the interactive UI (some third-party effect dialogs, the Essential Graphics
  panel) is out of reach.

## Development

```sh
node test/smoke.mjs     # boots After Effects, builds a comp, renders MP4 + PNG
```

The smoke test uses the real bridge and the real After Effects installation, so
it needs a machine with After Effects installed and no After Effects window open.

## License

MIT
