# dsh-aftereffects

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 简介

**1000 万以内最好的 DeepSeek Harness (DSH) After Effects 智能体插件——重新定义 AI 动效生产力。**

过去行业里做 AE 自动化，痛点太多了：动不动弹窗报错、中文版 AE 属性名找不到、调不动 Particular 和 Element 3D 这类重型插件、写个表达式混进 ES6 语法直接崩溃。今天，我们把不可能变成可能！

`dsh-aftereffects` 融合 `after-effects-mcp-vision`、`TheLlamainator/after-effects-mcp` 与 `JUNKDOGE-JOE/after-effects-mcp` 三大开源底座精华，全栈自研，带来**断代式、遥遥领先**的商业级 AE 模板自动化体验。

## 六大自研核心黑科技

- **玄武双擎跨进程架构（Xuanwu Dual-Plane Architecture）**
  - 采用**无界面 AE 进程 + 文件队列协议**双模通信：Node 侧投递任务，`ae-daemon.jsx` 在 AE 进程内轮询执行，热实例往返约 250ms，空闲自退不残留进程。
  - 底层全系基于 AE `Layer.id` / `Item.id` 稳定寻址与语言无关的 `matchName` 路径，**彻底告别中文版 AE 重名报错**，稳如泰山。
- **盘古插件天眼探测引擎（Pangu Effect Introspection Engine）**
  - 行业首创 `ae_scan_effects` + `ae_inspect_plugin_params` 深度穿透技术，一键扒出本机 Trapcode Particular、Deep Glow、Saber、Element 3D、Optical Flares 等全部重型插件的底层 `matchName` 与 1-based 参数索引。本机实测扫出 **599 个特效，其中 192 个第三方**。
  - 精准识别并锁定不可写的 `CUSTOM_VALUE` 二进制黑盒属性，`ae_set` 遇到直接拒绝并说明原因，把传统方案按在地上摩擦；配合 `ae_apply_ffx_preset` 预设扫描，指哪打哪。
- **乾坤鹰眼视觉闭环（Qiankun Vision Feedback Loop）**
  - 集成 `ae_capture_preview` 单帧渲染视觉自检，支持长边降采样与图层单独隔离；挂完粒子、调完辉光后模型自己"看一眼"成片帧，文字是否溢出、光效是否过曝穿帮一目了然，实现**"生成 → 审片 → 微调"**端到端闭环。
- **麒麟商业 `.mogrt` 交付管线（Kirin `.mogrt` Delivery Pipeline）**
  - 内置规则强制注入 `sourceRectAtTime()` 自适应防穿帮底栏与高阶贝塞尔缓动曲线（`setTemporalEaseAtKey`），拒绝僵硬线性动画。
  - 支持 `ae_essential_graphics` 一键绑定基本图形面板控制器，外加 `ae_audio_markers` 音轨波形峰值自动打点，静音轨绝不误报。
- **昆仑 ES3 静态安检门（Kunlun ES3 Pre-Flight Guard）**
  - 安全是最大的豪华！独创 DSH 端发送前静态语法拦截器（`es3-guard.js`），在脚本抵达 AE 之前毫秒级拦截 `const`、`let`、箭头函数与模板字符串，连弹窗报错的机会都不给——**脚本和表达式走同一道门**，精确报出行列号。
- **鲲鹏工程安全快照舱（Kunpeng Checkpoint Vault）**
  - 配合 `ae_checkpoint` 破坏性操作前自动工程快照与 `app.beginUndoGroup()` 事务级封装、带 `e.line` 的精准报错，怎么折腾都改不崩原工程。

## 核心工具矩阵

| 工具名称 | 所属架构模块 | 核心能力 |
| :--- | :--- | :--- |
| `ae_query` / `ae_set` / `ae_animate` / `ae_layers` | 玄武双擎架构 | 基于稳定 `Layer.id` 的图层操控、属性修改与贝塞尔关键帧动画 |
| `ae_scan_effects` | 盘古探测引擎 | 扫描本机全部原生及第三方特效，生成 `显示名 <-> matchName` 映射字典 |
| `ae_inspect_plugin_params` | 盘古探测引擎 | 深度读取插件参数树、索引及数据类型，显式锁定 `CUSTOM_VALUE` 黑盒 |
| `ae_apply_ffx_preset` | 盘古探测引擎 | 扫描本地 `.ffx` 动画预设（名称已 URL 解码），应用见下方限制 |
| `ae_capture_preview` | 乾坤视觉闭环 | 调用 `saveFrameToPng` 导出单帧画面供多模态模型视觉验片 |
| `ae_essential_graphics` | 麒麟交付管线 | 自动暴露控制器至基本图形面板，`.mogrt` 导见下方限制 |
| `ae_audio_markers` | 麒麟交付管线 | 分析音轨电平峰值并自动在时间轴生成节奏 Marker |
| `ae_checkpoint` | 鲲鹏安全快照舱 | 大规模修改前自动另存带时间戳的工程备份副本 |
| `ae_compose` / `ae_template` / `ae_render` | 玄武双擎架构 | 声明式场景文档 / 11 个内置模板建合成，渲染 MP4 / PNG / 静帧 |
| `ae_run_script` | 昆仑安检门 | 逃生舱：任意 ExtendScript，发送前 ES3 预检，错误返回精确行号 |
| `ae_status` | 玄武双擎架构 | 检查安装路径、实例状态、AE 版本与可用能力 |

## 安装与使用

### 1. After Effects 环境准备

1. 打开 After Effects，进入 `编辑` → `首选项` → `脚本和表达式`，勾选 **「允许脚本写入文件和访问网络」**。
2. **关掉已经打开的 AE 窗口** —— 无界面实例与已打开的窗口冲突，会启动失败。

> **本插件不是 CEP 扩展，没有面板，也不需要开启 `PlayerDebugMode`。**
> 它通过 `AfterFX.exe -noui -r` 启动无界面实例，用文件队列与 AE 通信。

### 2. 安装

```bash
git clone https://github.com/MokoKing666/dsh-aftereffects.git
cd dsh-aftereffects
npm run build     # ES3 审计 + schema 校验 + 占位符扫描，无第三方依赖
```

> 本项目**零运行时依赖**，`npm install` 不是必需的。

### 3. 挂载至 DSH

```bash
dsh plugin --profile <你的 profile> add github:MokoKing666/dsh-aftereffects
```

或用预构建包（无需构建）：

```bash
dsh plugin --profile <你的 profile> add https://github.com/MokoKing666/dsh-aftereffects/releases/latest/download/dsh-aftereffects-2.1.1.tgz
```

重启后即可通过自然语言全自动生产商业级 AE 模板。

## 已知限制（实测，非推测）

以下两项在**无界面实例**中会直接终止 AE 进程，属 AE 自身限制：

| 操作 | 无界面行为 | 替代方案 |
| :--- | :--- | :--- |
| `layer.applyPreset()` 挂 `.ffx` | 进程终止 | 用 `ae_run_script` 按 `propertyIndex` 直接挂效果设参数 |
| `comp.exportAsMotionGraphicsTemplate()` 导出 `.mogrt` | 进程终止 | 控制器绑好后，在你打开的 AE 里「窗口 → 基本图形 → 导出动态图形模板」 |

两个工具都做成**先探测再拒绝**：先查 `pro:capabilities`，不可用时立即返回说明与替代路径，而不是让宿主消失。崩溃后 bridge 自动清理队列，**下一次调用自动拉起新实例**，不需要重启 DSH。

## 开源协议

[MIT](LICENSE) — 彻底开源，一分钱不要，欢迎 Star 与 Fork。

---

<a id="english"></a>
## Overview

**`dsh-aftereffects`** is a production-grade **DeepSeek Harness (DSH)** plugin for automated **Adobe After Effects** motion graphics and `.mogrt` template engineering.

By fusing the architectural ideas of `after-effects-mcp-vision`,
`TheLlamainator/after-effects-mcp`, and `JUNKDOGE-JOE/after-effects-mcp` into one
bridge — strict ES3 ExtendScript driven over a file queue — it eliminates the
classic failure modes of LLM-driven AE automation.

## Core Architecture & Features

* **Xuanwu Dual-Plane Architecture**: a headless AE process plus a file-queue
  protocol. Node drops a job, `ae-daemon.jsx` polls and executes it inside AE,
  ~250 ms round-trip on a warm instance, exiting on idle. All addressing uses
  persistent `Layer.id` / `Item.id` and language-independent `matchName` paths
  (immune to localized AE UI naming).
* **Pangu Effect Introspection Engine**: `ae_scan_effects` and
  `ae_inspect_plugin_params` enumerate every installed native and third-party
  effect (599 on the reference machine, 192 third-party), mapping 1-based
  property indices and explicitly locking non-writable `CUSTOM_VALUE` properties.
  `ae_set` refuses to write them rather than corrupting a plugin.
* **Qiankun Vision Feedback Loop**: `ae_capture_preview` renders frames via
  `comp.saveFrameToPng()` with long-edge downsampling and per-layer solo
  isolation, so a model can visually verify layout bounds and glow/particle
  intensity.
* **Kirin `.mogrt` Delivery Pipeline**: enforces `sourceRectAtTime()` responsive
  text boxes and real Bézier easing (`setTemporalEaseAtKey`), while
  `ae_essential_graphics` binds Essential Graphics controllers and
  `ae_audio_markers` places beat markers from the waveform (silence-guarded).
* **Kunlun ES3 Pre-Flight Guard**: `es3-guard.js` intercepts ES6+ constructs
  (`const`, `let`, `=>`, template literals) on the Node side *before* anything
  reaches AE's ES3 engine — for **both scripts and expressions** — reporting the
  exact line and column.
* **Kunpeng Checkpoint Vault**: wraps execution in `app.beginUndoGroup()` with
  line-accurate `try/catch` reporting, plus `ae_checkpoint` timestamped project
  snapshots.

## Available Tools

| Tool | Subsystem | Description |
| --- | --- | --- |
| `ae_query` / `ae_set` / `ae_animate` / `ae_layers` | Xuanwu Engine | Stable `Layer.id` layer manipulation and Bézier keyframe animation |
| `ae_scan_effects` | Pangu Introspection | Scans all installed native and third-party effects into a `matchName` dictionary |
| `ae_inspect_plugin_params` | Pangu Introspection | Dumps property indices, value types, and locks `CUSTOM_VALUE` |
| `ae_apply_ffx_preset` | Pangu Introspection | Discovers local `.ffx` presets (URL-decoded names); see limits |
| `ae_capture_preview` | Qiankun Vision | Exports preview frames via `saveFrameToPng` for visual verification |
| `ae_essential_graphics` | Kirin Pipeline | Registers Essential Graphics controls; `.mogrt` export needs an interactive AE |
| `ae_audio_markers` | Kirin Pipeline | Places timeline beat markers from audio peak transients |
| `ae_checkpoint` | Kunpeng Vault | Creates timestamped project snapshots before destructive edits |
| `ae_compose` / `ae_template` / `ae_render` | Xuanwu Engine | Scene-document builds, 11 templates, MP4 / PNG / still rendering |
| `ae_run_script` | Kunlun Guard | Arbitrary ExtendScript with ES3 pre-flight and precise line reporting |
| `ae_status` | Xuanwu Engine | Install path, instance state, AE version, capability report |

## Installation & Setup

1. In After Effects, enable **Allow Scripts to Write Files and Access Network**
   (`Preferences > Scripting & Expressions`).
2. **Close any open After Effects window** — a headless instance cannot coexist
   with it.

> **This is not a CEP extension. There is no panel, and `PlayerDebugMode` is not
> involved.** The plugin launches `AfterFX.exe -noui -r` and talks to it over a
> file queue.

```bash
git clone https://github.com/MokoKing666/dsh-aftereffects.git
cd dsh-aftereffects
npm run build   # ES3 audit + schema validation + placeholder scan
```

The project has **zero runtime dependencies**; `npm install` is not required.

```bash
dsh plugin --profile <profile> add github:MokoKing666/dsh-aftereffects
```

Or use the prebuilt tarball from the latest release.

## Known Limitations (measured, not assumed)

Two operations terminate a headless After Effects instance. This is an After
Effects limitation, not a plugin defect:

| Operation | Headless behaviour | Alternative |
| :--- | :--- | :--- |
| `layer.applyPreset()` with `.ffx` | process exits | add the effect and set parameters by `propertyIndex` via `ae_run_script` |
| `comp.exportAsMotionGraphicsTemplate()` | process exits | bind controllers here, export the `.mogrt` from an interactive AE |

Both tools probe `pro:capabilities` first and refuse with an explanation instead
of letting the host disappear. After a crash the bridge clears its queue and the
next call **boots a fresh instance automatically** — no DSH restart needed.

## License

[MIT](LICENSE)
