# dsh-aftereffects

[中文](#中文) | [English](#english)

---

<a id="中文"></a>
## 简介

**1000 万以内最好的 DeepSeek Harness (DSH) After Effects 智能体插件——重新定义 AI 动效生产力！**

过去行业里用大模型驱动 AE，痛点太多了：中文版 AE 找不到属性名报错、调不动 Particular 和 Element 3D 这类重型插件、写个表达式混进 ES6 语法当场崩溃、一不小心还把原工程改废。今天，我们把不可能变成可能！

`dsh-aftereffects` 融合 `after-effects-mcp-vision`、`TheLlamainator/after-effects-mcp` 与 `JUNKDOGE-JOE/after-effects-mcp` 三大开源底座精华，全栈自研，**零运行时依赖（无需 `npm install` 即可开箱即用）**，通过 **158 项全绿单元测试**与四段式构建审计，带来**断代式、遥遥领先**的 AE 自动化工程体验。

## 六大自研核心黑科技

- **玄武双擎合成架构（Xuanwu Dual-Engine Architecture）**
  - 兼顾声明式场景 JSON 极速建片（`ae_compose` + **11 款内置动效模板**）与底层 `Layer.id` / `Item.id` 毫米级微操（`ae_query` / `ae_set` / `ae_animate`）。
  - 全程锁定语言无关的 `matchName` 路径与真实贝塞尔缓动曲线，**彻底免疫中文版 AE 显示名报错**，稳如泰山。
- **盘古插件天眼引擎（Pangu Effect Introspection Engine）**
  - 内置 `ae_scan_effects`（按 AE 版本自动缓存原生/第三方分类字典）与 `ae_inspect_plugin_params` 递归参数树穿透技术，精准扒出全部第三方插件的 1-based 参数索引与数据类型。
  - **严格锁定 `CUSTOM_VALUE` 二进制黑盒属性**，遇到不可写参数直接拦截并给出明确诊断，彻底告别 ExtendScript 引擎崩溃；支持 `ae_apply_ffx_preset` 本地 `.ffx` 预设检索。
- **乾坤感知与自适应引擎（Qiankun Vision & Audio Perception）**
  - **纯 Node.js 原生 PNG 拼图渲染（`ae_capture_preview`）**：支持单帧截图、多帧采样与无外部依赖的 Contact Sheet 网格拼图，方便多模态模型视觉审片。
  - **全位深 WAV PCM 波形解析（`ae_audio_markers`）**：原生支持 8/16/24/32-bit 整数与 32/64-bit 浮点 WAV，多声道峰值瞬态检测自动映射时间轴 Marker。
  - **自适应防穿帮（`ae_auto_fit_text`）**：基于 `sourceRectAtTime()` 自动驱动背景矩形贴合文字边界。
- **麒麟模板与基本图形管线（Kirin Template & Essential Graphics Pipeline）**
  - 内置 `title`、`lower-third`、`cta`、`logo-reveal`、`countdown`、`stat`、`quote`、`kinetic`、`end-card`、`particles`、`gradient` **11 套商业动效模板**，支持 `midnight` / `sunset` / `mint` / `paper` / `mono` 5 大主题与 6 种画幅一键出片。
  - 支持 `ae_essential_graphics` 自动将图层属性暴露至基本图形面板（Essential Graphics），配合 `ae_render` 支持 mp4 / png 序列 / mov / avi / tif / psd 及单帧输出。
- **昆仑 ES3 静态安检门（Kunlun ES3 Pre-Flight Guard）**
  - 脚本与表达式走同一道静态安检门（`es3-guard.js`），在代码抵达 AE 之前毫秒级拦截 `const`、`let`、箭头函数 `=>`、模板字符串、`class`、解构、`for-of`、`async` 与 generator，**精确报出报错行列号**，连弹窗报错的机会都不给。
- **鲲鹏四重安全门禁与快照舱（Kunpeng Four-Gate Guard & Checkpoint Vault）**
  - **安全是最大的豪华！** 内置 23 类写操作静态分类器（精准区分赋值 `=` 与比较 `===`，绝不误杀只读查询），在 `ae_compose`、`ae_template`、`ae_run_script`（写模式）与 `ae_checkpoint restore` 四大高危入口强制前置备份。
  - 备份文件带 `manifest.json` **SHA-256 哈希校验**及 `RIFX` / `AEGP` / `RIFF` 文件头魔数验证，备份失败直接拒绝执行破坏性操作，怎么折腾都改不崩原工程！

## 17 大核心工具矩阵

| 工具名称 | 所属模块 | 核心能力 |
| :--- | :--- | :--- |
| `ae_status` | 玄武双擎架构 | 检查 AE 安装路径、`aerender`、版本与实例状态；支持主动拉起/关闭无界面实例 |
| `ae_compose` | 玄武双擎架构 | 按声明式场景 JSON 自动构建合成（支持文本/形状/纯色/空对象/素材/预合成/相机），可另存 `.aep` |
| `ae_template` | 麒麟模板管线 | 11 套内置模板 + 5 种主题 + 6 种画幅一键出片；支持 `template="list"` 枚举 |
| `ae_render` | 麒麟模板管线 | 渲染导出 mp4 / png 序列 / mov / avi / tif / psd；支持 `stillAt` 单帧渲染 |
| `ae_run_script` | 昆仑安检门 | 任意 ExtendScript 逃生舱，强制经过 ES3 语法预检与写操作安全门禁 |
| `ae_layers` | 玄武双擎架构 | 列出合成图层，返回稳定 `Layer.id`、图层类型与效果数量 |
| `ae_query` | 玄武双擎架构 | 按 `matchName` 点路径精确读取属性值、关键帧与数据类型 |
| `ae_set` | 玄武双擎架构 | 修改属性值或挂载表达式（`time` 给定时自动打关键帧），拦截 `CUSTOM_VALUE` 写入 |
| `ae_animate` | 玄武双擎架构 | 批量打关键帧并施加真实贝塞尔缓动（`linear` / `in` / `out` / `both` / `hold`） |
| `ae_scan_effects` | 盘古天眼引擎 | 扫描本机全部原生及第三方特效，按版本缓存 `显示名 <-> matchName` 字典 |
| `ae_inspect_plugin_params` | 盘古天眼引擎 | 递归读取插件参数树、1-based 索引与类型，显式锁定 `CUSTOM_VALUE` 黑盒 |
| `ae_apply_ffx_preset` | 盘古天眼引擎 | 扫描检索本地 `.ffx` 动画预设目录与可用性检查 |
| `ae_capture_preview` | 乾坤感知引擎 | 单帧截图、多帧采样及纯 Node PNG Contact Sheet 网格拼图输出 |
| `ae_essential_graphics` | 麒麟模板管线 | 将指定图层属性一键暴露至基本图形面板（Essential Graphics） |
| `ae_audio_markers` | 乾坤感知引擎 | 解析 8~64-bit WAV PCM 波形，按瞬态峰值自动在时间轴打 Marker |
| `ae_auto_fit_text` | 乾坤感知引擎 | 基于 `sourceRectAtTime()` 驱动背景矩形自动贴合文本尺寸 |
| `ae_checkpoint` | 鲲鹏安全门禁 | `create` / `list` / `restore` 工程快照，带 SHA-256 清单与魔数校验 |

## 快速开始

### 1. 环境准备

1. 打开 Adobe After Effects，进入 `编辑` -> `首选项` -> `脚本和表达式`，勾选 **「允许脚本写入文件和访问网络」**。
2. 确保系统已安装 Node.js（本插件**零外部运行时依赖**，克隆即用）。

### 2. 获取与自检

```bash
git clone https://github.com/MokoKing666/dsh-aftereffects.git
cd dsh-aftereffects
npm run build
```

### 3. 挂载至 DSH

在你的 DeepSeek Harness (DSH) 配置中注册并启用 `dsh-aftereffects`，重启 DSH 后即可通过自然语言调度全部 17 个工具。

## 已知工程边界

为保证生产环境可靠性，当前版本明确声明以下边界：

- **无界面实例限制**：由于无界面（Headless）AE 进程调用 `applyPreset()` 或导出 `.mogrt` 会导致宿主进程终止，`ae_apply_ffx_preset` 仅提供预设检索与能力检测，`ae_essential_graphics` 负责绑定控制器（最终 `.mogrt` 导出需在交互式 AE 界面中完成）。
- **视觉上下文闭环**：`ae_capture_preview` 输出 PNG 文件路径，需配合模型自身的读图工具（如 `read_image`）查看画面。
- **特殊时间变换**：暂未覆盖 `timeRemapEnabled` 重映射或负值 `stretch` 倒放图层的音频时间换算，以及复杂旋转/缩放组合下的 `sourceRectAtTime` 边界投影。

## 开源协议

[MIT](LICENSE) — 彻底开源，一分钱不要，欢迎 Star 与 Fork。

---

<a id="english"></a>
## Overview

**`dsh-aftereffects`** is a zero-dependency, production-grade **DeepSeek Harness (DSH)** plugin built on the Cordis architecture for automating **Adobe After Effects** motion graphics and template engineering.

Combining the architectural strengths of `after-effects-mcp-vision`, `TheLlamainator/after-effects-mcp`, and `JUNKDOGE-JOE/after-effects-mcp` into a unified Node.js ESM host plus strict ES3 ExtendScript runtime (backed by 158 unit tests and a 4-stage build audit), it solves localized UI naming failures, third-party plugin crashes, ES6 syntax errors, and accidental project corruption.

## Core Architecture & Features

- **Xuanwu Dual-Engine Architecture**: Pairs declarative JSON scene generation (`ae_compose` + **11 built-in templates** across 5 themes and 6 aspect ratios) with precision `Layer.id` / `matchName` property manipulation (`ae_query`, `ae_set`, `ae_animate`) and true Bezier easing.
- **Pangu Effect Introspection Engine**: `ae_scan_effects` and `ae_inspect_plugin_params` recursively map installed native and third-party plugins (1-based indices, types, version-aware caching) while locking non-writable binary `CUSTOM_VALUE` properties to prevent AE crashes.
- **Qiankun Vision & Audio Perception**: Pure-Node PNG Contact Sheet & frame capture (`ae_capture_preview`), multi-bit-depth WAV PCM peak transient marker generation (`ae_audio_markers`), and `sourceRectAtTime()` responsive text boxes (`ae_auto_fit_text`).
- **Kirin Template & Essential Graphics Pipeline**: Automates Essential Graphics property exposure (`ae_essential_graphics`) and multi-format rendering (`ae_render`).
- **Kunlun ES3 Pre-Flight Guard**: Static syntax linter (`es3-guard.js`) intercepts ES2015+ constructs (`const`, `let`, `=>`, template literals, `class`, destructuring, `for-of`, `async`, generators) with exact line/column numbers before reaching AE's ES3 engine.
- **Kunpeng Four-Gate Guard & Checkpoint Vault**: A 23-pattern write classifier (distinguishing `=` from `===`) enforces mandatory SHA-256 + magic-byte (`RIFX`/`AEGP`/`RIFF`) project backups before destructive `ae_compose`, `ae_template`, `ae_run_script`, or `ae_checkpoint restore` operations.

## Available Tools (17)

| Tool | Subsystem | Description |
| --- | --- | --- |
| `ae_status` | Xuanwu Engine | Checks AE install path, `aerender`, version, and instance status; starts/stops headless AE |
| `ae_compose` | Xuanwu Engine | Builds compositions from declarative scene JSON (text, shape, solid, null, footage, precomp, camera) |
| `ae_template` | Kirin Pipeline | Generates motion graphics from 11 built-in templates, 5 themes, and 6 aspect ratios |
| `ae_render` | Kirin Pipeline | Renders mp4, PNG sequence, mov, avi, tif, psd, or single frames via `stillAt` |
| `ae_run_script` | Kunlun Guard | Arbitrary ExtendScript escape hatch protected by ES3 linting and write-mode backup gates |
| `ae_layers` | Xuanwu Engine | Lists layers with persistent `Layer.id`, layer type, and effect counts |
| `ae_query` | Xuanwu Engine | Reads values, keyframes, and types via language-independent `matchName` dot-paths |
| `ae_set` | Xuanwu Engine | Sets values/expressions or keyframes at `time`; blocks `CUSTOM_VALUE` writes |
| `ae_animate` | Xuanwu Engine | Creates keyframes with true Bezier easing (`linear`, `in`, `out`, `both`, `hold`) |
| `ae_scan_effects` | Pangu Engine | Scans installed native/third-party effects into a version-cached `matchName` dictionary |
| `ae_inspect_plugin_params` | Pangu Engine | Recursively inspects plugin property trees, 1-based indices, and locks `CUSTOM_VALUE` |
| `ae_apply_ffx_preset` | Pangu Engine | Searches local `.ffx` preset directories and checks headless compatibility |
| `ae_capture_preview` | Qiankun Perception | Renders single frames, multi-frame samples, and pure-Node PNG Contact Sheets |
| `ae_essential_graphics` | Kirin Pipeline | Exposes layer properties to the Essential Graphics panel |
| `ae_audio_markers` | Qiankun Perception | Parses 8–64-bit WAV PCM audio and places timeline markers on transient peaks |
| `ae_auto_fit_text` | Qiankun Perception | Drives shape rectangles to fit text bounds via `sourceRectAtTime()` |
| `ae_checkpoint` | Kunpeng Vault | Creates, lists, and restores project backups with SHA-256 manifest verification |

## Quick Start

```bash
git clone https://github.com/MokoKing666/dsh-aftereffects.git
cd dsh-aftereffects
npm run build
```

Enable **Allow Scripts to Write Files and Access Network** in After Effects (`Preferences > Scripting & Expressions`), then register `dsh-aftereffects` in your DSH configuration. Zero external runtime dependencies are required.

## Known Limitations

- **Headless Host Constraints**: Because headless AE processes terminate on `applyPreset()` or `.mogrt` export calls, `ae_apply_ffx_preset` provides preset discovery/capability checks and `ae_essential_graphics` binds controls (final `.mogrt` export requires interactive AE UI).
- **Visual Inspection**: `ae_capture_preview` returns PNG file paths; pair it with a vision-capable read tool (`read_image`) to inspect frames.
- **Time Transforms**: Audio marker mapping does not yet convert `timeRemapEnabled` or negative-stretch reversed layers, and `sourceRectAtTime` fitting does not yet project complex combined rotation/scale transforms.

## License

[MIT](LICENSE)
