# dsh-aftereffects

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 简介

**DeepSeek Harness (DSH) 的 Adobe After Effects 智能体插件。**

融合 `after-effects-mcp-vision`、`TheLlamainator/after-effects-mcp` 与 `JUNKDOGE-JOE/after-effects-mcp` 三大开源底座精华，全栈自研，专为商业级 AE 动效与 `.mogrt` 模板自动化生产打造。解决大模型调不动第三方插件、中文版 AE 属性名报错、表达式混入 ES6 语法崩溃这几类实际问题。

## 核心特性

- **第三方重型插件深度穿透**
  - 内置 `ae_scan_effects` 与 `ae_inspect_plugin_params` 探测引擎，一键扫描本机插件的底层 `matchName` 与真实参数索引。本机实测扫出 599 个特效，其中 192 个第三方（Deep Glow、Red Giant Universe 等）。
  - 自动标记不可写的 `CUSTOM_VALUE` 二进制黑盒属性，从根源杜绝脚本崩溃。`ae_set` 遇到这类属性会**直接拒绝并说明原因**，不会静默损坏。
- **稳定 ID 寻址 + 画面自检闭环**
  - 全系采用 AE `Layer.id` / `Item.id` 稳定寻址与语言无关的 `matchName` 路径，免疫中文版 AE 重名报错。
  - `ae_capture_preview` 单帧渲染截图，支持降采样与图层隔离；挂完粒子、调完辉光后模型可以看图验片，文字溢出与光效过曝一眼看穿。
- **商业级模板交付**
  - 内置规则强制注入 `sourceRectAtTime()` 自适应底栏与贝塞尔缓动，拒绝僵硬线性动画。
  - `ae_essential_graphics` 绑定基本图形面板控制器，`ae_audio_markers` 按音轨峰值自动打点。
- **安全（前置 ES3 安检门 + 自动快照）**
  - DSH 端发送前做 ES3 语法静态拦截，在代码发往 AE 前拦下 `const`、`let`、箭头函数等现代语法，并给出精确行列号。
  - `ae_checkpoint` 操作前自动工程备份，脚本统一包在 `UndoGroup` 事务里。

## 工具列表

| 工具名称 | 功能说明 |
| :--- | :--- |
| `ae_layers` | 列出图层，返回稳定 `Layer.id`、类型、变换快照与出入点 |
| `ae_query` | 按 `matchName` 点路径读取属性真实值、关键帧与缓动信息 |
| `ae_set` | 修改属性值或挂表达式；**拒绝写入 `CUSTOM_VALUE`** |
| `ae_animate` | 打关键帧并用 `setTemporalEaseAtKey()` 施加真实贝塞尔缓动 |
| `ae_scan_effects` | 扫描本机全部原生及第三方特效，生成 `显示名 <-> matchName` 映射 |
| `ae_inspect_plugin_params` | 读取插件参数树、`propertyIndex`、数据类型，显式标记 `CUSTOM_VALUE` |
| `ae_apply_ffx_preset` | 扫描本地 `.ffx` 预设（名称已 URL 解码）。应用受无界面限制，见下方说明 |
| `ae_capture_preview` | 调用 `saveFrameToPng` 导出单帧，支持降采样、图层隔离、多帧序列 |
| `ae_essential_graphics` | 绑定控制器至基本图形面板；`.mogrt` 导出需交互式 AE |
| `ae_audio_markers` | 分析音轨电平峰值自动打节奏 Marker，静音轨不会误报 |
| `ae_checkpoint` | 大规模修改前自动另存带时间戳的工程备份 |
| `ae_compose` / `ae_template` | 用声明式场景文档或内置模板建合成 |
| `ae_render` | 渲染 MP4 / PNG 序列 / 静帧 |
| `ae_run_script` | 逃生舱：执行任意 ExtendScript，发送前 ES3 预检，错误返回精确行号 |
| `ae_status` | 检查安装路径、实例状态、AE 版本与可用能力 |

## 安装与配置

### 1. After Effects 环境准备

**本插件不是 CEP 扩展，不需要安装面板，也不需要开启 `PlayerDebugMode`。**

它通过 `AfterFX.exe -noui -r` 启动无界面实例，用文件队列与 AE 通信。

需要确认一件事：

1. 打开 After Effects，进入 `编辑` → `首选项` → `脚本和表达式`，勾选 **「允许脚本写入文件和访问网络」**。
2. **如果你正开着 AE 窗口，先关掉它** —— 无界面实例与已打开的窗口冲突，会启动失败。

### 2. 安装 DSH 插件

从预构建包安装（推荐，无需构建）：

```bash
dsh plugin --profile <你的profile> add https://github.com/MokoKing666/dsh-aftereffects/releases/latest/download/dsh-aftereffects-2.0.1.tgz
```

或从源码安装：

```bash
git clone https://github.com/MokoKing666/dsh-aftereffects.git
dsh plugin --profile <你的profile> add github:MokoKing666/dsh-aftereffects
```

### 3. 自检

```bash
cd dsh-aftereffects
npm run build     # ES3 语法审计 + schema 校验 + 占位符扫描
npm test          # 端到端：启动 AE → 建合成 → 渲染 MP4 + PNG
```

`npm run build` 会做四件事：JS 模块解析、全部 `.jsx` 的 ES3 严格检查、16 个工具的 schema 网关兼容性校验、以及 CI 级占位符扫描（`TODO` / `FIXME` / `not implemented`）。

## 已知限制（实测，非推测）

以下两项在**无界面实例**里会直接终止 AE 进程，属 AE 自身限制：

| 操作 | 无界面行为 | 替代方案 |
| :--- | :--- | :--- |
| `layer.applyPreset()` 挂 `.ffx` | 进程终止 | 用 `ae_run_script` 按 `propertyIndex` 直接挂效果设参数 |
| `comp.exportAsMotionGraphicsTemplate()` 导出 `.mogrt` | 进程终止 | 控制器绑好后，在你打开的 AE 里「窗口 → 基本图形 → 导出动态图形模板」 |

工具已做成**先探测再拒绝**：`ae_apply_ffx_preset` 和 `ae_essential_graphics` 会先查 `pro:capabilities`，不可用时立即返回说明与替代路径，而不是让宿主消失。崩溃后 bridge 会自动清理残留队列，**下一次调用自动拉起新实例**，不需要重启 DSH。

## License

MIT

---

<a id="english"></a>
## Overview

An Adobe After Effects agent plugin for **DeepSeek Harness (DSH)**.

It draws on three open-source bases — `after-effects-mcp-vision`,
`TheLlamainator/after-effects-mcp` and `JUNKDOGE-JOE/after-effects-mcp` — and is
built for commercial AE motion work and `.mogrt` template automation. It solves
three concrete problems: driving third-party effects that resist scripting,
addressing properties on a localised After Effects, and expressions or scripts
that die on ES2015 syntax.

## Features

- **Third-party effects, reachable.** `ae_scan_effects` enumerates every
  installed effect and returns the `displayName <-> matchName` map (599 effects
  on the machine this was built against, 192 of them third-party).
  `ae_inspect_plugin_params` exposes the full parameter tree with
  `propertyIndex`, value type and an explicit `CUSTOM_VALUE` flag. `ae_set`
  refuses to write `CUSTOM_VALUE` rather than silently corrupting a plugin.
- **Stable addressing and a visual loop.** Everything addresses layers by
  `Layer.id` and properties by `matchName`, so a localised After Effects never
  matches on a translated display name. `ae_capture_preview` renders a frame —
  downsampled, or isolated to one layer — so a model can look at the result and
  catch overflow, over-bright glow or a broken composition.
- **Commercial template delivery.** `ae_essential_graphics` binds controllers to
  the Essential Graphics panel, `ae_audio_markers` marks beats from the waveform,
  and the built-in rules require `sourceRectAtTime()` auto-fitting and real
  Bézier easing instead of linear keyframes.
- **Safety.** An ES3 pre-flight guard rejects `const` / `let` / arrow functions
  and reports the exact line and column before the code ever reaches After
  Effects. `ae_checkpoint` snapshots the project before bulk edits, and every
  script runs inside an undo group.

## Tools

| Tool | Purpose |
| :--- | :--- |
| `ae_layers` | List layers with stable `Layer.id`, type, transform snapshot and in/out points |
| `ae_query` | Read a property by `matchName` path, including keyframes and easing |
| `ae_set` | Write a value or attach an expression; refuses `CUSTOM_VALUE` |
| `ae_animate` | Create keyframes with real Bézier easing via `setTemporalEaseAtKey()` |
| `ae_scan_effects` | Enumerate installed effects, `displayName <-> matchName` |
| `ae_inspect_plugin_params` | Parameter tree with `propertyIndex`, types, `CUSTOM_VALUE` flags |
| `ae_apply_ffx_preset` | Discover local `.ffx` presets (names URL-decoded); application is limited, see below |
| `ae_capture_preview` | `saveFrameToPng` still, downsampling, solo isolation, frame sequences |
| `ae_essential_graphics` | Bind Essential Graphics controllers; `.mogrt` export needs an interactive AE |
| `ae_audio_markers` | Waveform peaks to timeline markers, silence-guarded |
| `ae_checkpoint` | Timestamped `.aep` snapshot before bulk edits |
| `ae_compose` / `ae_template` | Build a composition from a scene document or a built-in template |
| `ae_render` | Render MP4, PNG sequences or a still |
| `ae_run_script` | Arbitrary ExtendScript with ES3 pre-flight and precise line reporting |
| `ae_status` | Install path, instance state, AE version, capability report |

## Install

**This is not a CEP extension. There is no panel, and `PlayerDebugMode` is not
involved.** The plugin launches `AfterFX.exe -noui -r` and talks to it over a
file queue.

1. In After Effects, enable `Edit → Preferences → Scripting & Expressions →
   Allow Scripts to Write Files and Access Network`.
2. **Close any open After Effects window** — a headless instance cannot coexist
   with it.

```bash
# prebuilt (no build step)
dsh plugin --profile <profile> add https://github.com/MokoKing666/dsh-aftereffects/releases/latest/download/dsh-aftereffects-2.0.1.tgz

# or from source
dsh plugin --profile <profile> add github:MokoKing666/dsh-aftereffects
```

Verify:

```bash
npm run build   # ES3 audit + schema validation + placeholder scan
npm test        # end to end: boot AE, build a comp, render MP4 + PNG
```

## Known limitations (measured, not assumed)

Two operations terminate a headless After Effects instance. This is an After
Effects limitation, not a bug in the plugin:

| Operation | Headless behaviour | Alternative |
| :--- | :--- | :--- |
| `layer.applyPreset()` with `.ffx` | process exits | add the effect and set its parameters by `propertyIndex` via `ae_run_script` |
| `comp.exportAsMotionGraphicsTemplate()` | process exits | bind controllers here, then export the `.mogrt` from an interactive After Effects |

Both tools probe `pro:capabilities` first and refuse with an explanation instead
of letting the host disappear. After a crash the bridge clears its queue and the
**next call boots a fresh instance automatically** — no DSH restart required.

## License

MIT
