# Publishing dsh-aftereffects

Everything the plugin needs is finished and verified. Two publishing steps are
still open because this machine has no GitHub credential that can create a
repository or call the REST API:

- `gh` is not logged in (`gh auth status` → not logged into any hosts).
- The credential manager holds one `gho_…` token for `https://github.com`. The
  git protocol accepts it, but `api.github.com` answers `401 Bad credentials`,
  so it cannot create a repository, push a release, or open a pull request.
- The SSH key authenticates as **MokoKing666** (`ssh -T git@github.com`), which
  is enough to push once the repository exists.

Run the steps below in order. Each is a single command.

## 1. Create the repository

Either in the browser — <https://github.com/new>, owner `MokoKing666`, name
`dsh-aftereffects`, **Public**, no README/license/gitignore (the repo already
has them) — or with the CLI after `gh auth login`:

```sh
gh auth login --hostname github.com --git-protocol ssh --web
gh repo create dsh-aftereffects --public \
  --description "Drive Adobe After Effects from DeepSeek Harness: compositions, motion-graphics templates, and MP4/PNG rendering."
```

## 2. Push

```sh
cd C:/Users/67262/Documents/deepseek-harness/default-workspace/dsh-aftereffects
git remote add origin git@github.com:MokoKing666/dsh-aftereffects.git
git push -u origin master
```

The package is already committed locally (`master`, two commits).

## 3. Add the `dsh-plugin` topic

The market's catalogue checks for it. In the browser: repository → ⚙ next to
*About* → **Topics** → add `dsh-plugin`. With the CLI:

```sh
gh repo edit MokoKing666/dsh-aftereffects --add-topic dsh-plugin,dsh,after-effects,adobe,extendscript
```

## 4. Submit to the dsh-market catalogue

The catalogue behind `dsh-market` and the host's **Discover** tab is
`awesome-dsh-plugin/awesome-dsh-plugin`. Its README states the rules:

- the repository must declare `dsh.bundle` in `package.json` — it does;
- the repository must be **at least 1 day old** — a brand-new repo is rejected,
  so this submission has to wait until tomorrow;
- the `dsh-plugin` topic must be set — step 3;
- add **one file**, `data/plugins/MokoKing666__dsh-aftereffects.yml`, rather than
  editing the generated README.

The file content:

```yaml
url: https://github.com/MokoKing666/dsh-aftereffects
name: MokoKing666/dsh-aftereffects
category: workflow
description:
  en: Drives Adobe After Effects from the chat — builds compositions and motion-graphics templates, then renders MP4, PNG sequences or stills.
  zh: 在对话里直接驱动 Adobe After Effects——按场景文档或内置模板建合成，再渲染成 MP4、PNG 序列或静帧。
```

Submit it as a pull request:

```sh
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone=false
gh repo sync <your-account>/awesome-dsh-plugin
# write data/plugins/MokoKing666__dsh-aftereffects.yml in a clone, then:
gh pr create --repo awesome-dsh-plugin/awesome-dsh-plugin \
  --title "Add MokoKing666/dsh-aftereffects" \
  --body "Drives Adobe After Effects from the chat: ae_compose, ae_template, ae_render, ae_status."
```

## 5. Alternatively: a self-hosted index

`dsh-market` and the host's Discover tab also read a **format 1** index JSON
from any URL. Publishing one is a way to make the plugin discoverable without
waiting for the catalogue review. The schema is validated by
`@deepseek-ai/dsh-plugin-market-index`; a minimal index for this plugin looks
like this (`icon` may be a relative path or a base64 data URL ≤ 32 KiB):

```json
{
  "format": 1,
  "title": { "en": "MokoKing666 plugins", "zh": "MokoKing666 插件" },
  "description": {
    "en": "Plugins by MokoKing666.",
    "zh": "MokoKing666 的 DSH 插件。"
  },
  "metadata": {
    "categories": { "workflow": { "title": { "en": "Workflow & Automation", "zh": "工作流与自动化" } } }
  },
  "plugins": [
    {
      "name": "dsh-aftereffects",
      "title": { "en": "After Effects", "zh": "After Effects" },
      "description": {
        "en": "Drives Adobe After Effects from the chat — builds compositions and motion-graphics templates, then renders MP4, PNG sequences or stills.",
        "zh": "在对话里直接驱动 Adobe After Effects——按场景文档或内置模板建合成，再渲染成 MP4、PNG 序列或静帧。"
      },
      "repository": { "url": "https://github.com/MokoKing666/dsh-aftereffects" },
      "metadata": { "category": "workflow" },
      "versions": [
        {
          "version": "1.0.0",
          "publishTimestamp": 0,
          "source": {
            "type": "git",
            "url": "https://github.com/MokoKing666/dsh-aftereffects",
            "commit": "<40-hex commit SHA of the pushed HEAD>"
          },
          "engines": { "dsh": ">=0.2.0-rc.2" }
        }
      ]
    }
  ]
}
```

Set `publishTimestamp` to the real Unix seconds of the release and `commit` to
`git rev-parse HEAD` after pushing. Host it anywhere over https (a GitHub Pages
branch, a gist raw URL, jsDelivr over an npm package), then add that URL under
**Plugins → Discover → Index sources** — or hand the URL to
`plugin_market action=list_plugins target=<url>`.

## What is already verified

- `ae_status`, `ae_template`, `ae_compose`, `ae_render` are registered and
  callable from a live session.
- A real composition was built and rendered to H.264 MP4 (1920×1080, 3.0 s,
  24 fps, 72 frames, verified with `ffprobe`), to a 72-frame PNG sequence, and
  to a single still.
- Custom scene documents work end to end: shapes with strokes and trim, glow,
  typewriter text, keyframed rotation.
- `node test/smoke.mjs` passes against After Effects 2026 (26.5x89, zh_CN).
