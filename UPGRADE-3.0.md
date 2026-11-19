# 升级记录 — dsh-aftereffects 3.0.0

在原架构上做增量升级：**没有改通信方式**，仍然是
`Node.js ESM / Cordis 插件 → AfterFX 无界面进程 → ExtendScript Daemon → 本地文件队列`。
文件队列协议、任务 ID、心跳、超时、`pro:` 路由、`serial()` 单队列都没有变动。

---

## 参考仓库（已删除，SHA 记录在此）

| 仓库 | 检出 Commit | 借鉴内容 |
| :--- | :--- | :--- |
| `VolksRat71/after-effects-mcp-vision` | `d2c95489ff0481169bb6c693fc60527b315f88ce` | `resolutionFactor` 降采样截图、solo 隔离、Contact Sheet 思路 |
| `TheLlamainator/after-effects-mcp` | `e4a462098d28acc22a128ec20a9091ae47422915` | `analyzeWavAmplitudes()` 的 RIFF/WAVE 解析思路 |
| `JUNKDOGE-JOE/after-effects-mcp` | `10b0154ca64f5ed15096b367f160129ee9ffe503` | Checkpoint 先原地保存再复制、完整性校验思路 |

未移植：CEP 面板、`PlayerDebugMode`、C++ AEGP、`.aex`、原生通信架构、任何二进制插件。

---

## 上一版本的功能审计

| 能力 | 上一版真实状态 | 本次处理 |
| :--- | :--- | :--- |
| 效果扫描 | 能用，但用 `ADBE`/`CC` 前缀猜第三方，会把 AE 自带效果误判 | **修正**：Node 侧分类表，未知保持 `unknown` |
| 参数树 | 只递归一层，`getPropertyParameters` 当 PropertyGroup 用 | **重写**：任意深度、`propertyParameters` 数组/组双形态、带完整 path |
| FFX 应用 | 会崩溃 | **保持拒绝**，能力预检先拦住，给替代方案 |
| MOGRT 导出 | 会崩溃 | **保持拒绝**，同上 |
| 音频卡点 | 逐帧读 `ADBE Audio Levels`——这是电平表不是波形 | **重做**：Node 解析原始 PCM 采样 |
| 截图 | 有 `saveFrameToPng`，但没 Contact Sheet | **补齐**：纯 JS PNG 合成 |
| 图片回传 | 无 | **如实报告**：工具结果只带文本，图像不进视觉上下文 |
| 自动文字适配 | 表达式让形状读自己，逻辑是错的；且未注册成工具 | **重写**并注册为 `ae_auto_fit_text` |
| Checkpoint | 只备份，不校验，无程序级保护 | **升级**：验证 + 清单 + 恢复 + 门禁 |
| ES3 预检 | 有正则扫描，漏检解构/generator，误报正则字面量 | **加固**：20+ 规则，正确区分除号与正则 |

---

## 新增工具

| 工具 | 说明 |
| :--- | :--- |
| `ae_auto_fit_text` | 用 `sourceRectAtTime()` + `toComp/fromComp` 真实驱动背景矩形；返回实测边界与期望尺寸 |
| `ae_layers` / `ae_query` / `ae_set` / `ae_animate` | 上一轮新增，本轮修正了参数树与 CUSTOM_VALUE 路径 |

工具总数 **17**，无重名、无重复注册。

---

## 新增模块

| 文件 | 作用 |
| :--- | :--- |
| `lib/wav.js` | RIFF/WAVE 解析 + RMS/瞬态检测 + 时间映射。8/16/24/32-bit PCM、32/64-bit float |
| `lib/contact-sheet.js` | 纯 Node PNG 解码/编码/合成，无原生依赖 |
| `lib/effect-cache.js` | 效果扫描缓存（按 AE 版本失效）+ 厂商分类表 |
| `lib/checkpoint.js` | 备份验证、清单、裁剪、恢复门禁 |
| `lib/gate.js` | **执行门禁**：把判定接到真实执行路径（建片 / 脚本 / 恢复），含脚本写模式分类器 |
| `scripts/test.mjs` | `npm test`：先单测，再 AE 集成 |
| `scripts/test-ae.mjs` | 28 项实机集成测试 |
| `test/*.test.mjs` | 150 项单元测试 |

---

## 测试结果

### 构建

```
npm run build   → passed
  1/4  JS 模块解析        24 files
  2/4  .jsx ES3 检查       3 files, 0 violations
  3/4  工具 Schema        17 tools, 0 invalid type
  4/4  占位符扫描          24 files clean
```

### 单元测试

```
150 tests, 150 pass, 0 fail
  wav.test.mjs            21
  contact-sheet.test.mjs   8
  es3-guard.test.mjs      34
  effect-cache.test.mjs   13
  checkpoint.test.mjs     18
  gate.test.mjs           27   门禁分类器（写模式 21 条 / 只读 6 条）
  gate-tools.test.mjs     23   门禁接线 + guardScript 放行/拒绝 + ae_checkpoint 语义
  compose-gate.test.mjs    6   两个建片入口分别拦
```

门禁测试有两条是刻意反过来钉的：

- **空的工程不备份** —— 否则每次建片都复制一次工程，"保护"变成噪音。
- **探测失败按有内容处理** —— bridge 读不到状态时必须拒绝，而不是当成"没有东西可毁"。

分类器也钉了两个方向，两个都严重：

- **漏判写操作** = 无保护执行。`layer.source = f`、`comp.frameRate = 60`、`layer.moveTo(1)` 这些赋值型修改，第一版全部漏了。
- **误判只读** = 每次读取都复制工程。`\s*=` 会把 `layer.source === null` 判成写操作，修法是断言后面不许是 `=`。

`ae_run_script` 的规则也因此分成两种：**写脚本备份不成就不执行**，**读脚本照常放行**——拦一个毁不掉任何东西的读取，只会教会使用者随手声明 `readOnly`。

### AE 实机集成（AE 27.0x78 / Windows）

```
28 passed, 0 failed, 1 not run
```

关键几条：

- Layer.id 寻址：`TXT#28, BG#27`
- 参数树：15 个参数，每个带完整 matchName 路径
- CUSTOM_VALUE 拒绝：`ADBE Easy Levels2-0002`（色阶直方图）写入被拦
- Contact Sheet：1928×364，由 3 张真实 AE 截图合成
- 自动文字适配：字形 961.89×89.91 → 矩形宽 1022（= 962 + 30×2）**实测吻合**
- 音频：4 个峰值 0.3/0.9/1.5/2.1，与构造的 ground truth 完全一致
- 异常行号：L3 精确回传

### 未运行项

| 项 | 原因 |
| :--- | :--- |
| 改文案后自动收缩 | 测试用的 Source Text 表达式写法有误，未真正改变文本。功能本身（表达式重新测量）未被否定，只是没测到 |

### 明确未测试（不为测试而触发崩溃）

`applyPreset()` 与 `exportAsMotionGraphicsTemplate()` 的真实调用。两者在无界面实例中会终止 AE 进程，只验证了**能力检测与拒绝路径**。

---

## 已知限制

| 问题 | 状态 |
| :--- | :--- |
| FFX 能否自动挂载 | **不能**。无界面会崩。工具会先检测并返回 `capability_unavailable` + 替代方案 |
| MOGRT 能否自动导出 | **不能**。同上。控制器可以绑，导出需用户在交互式 AE 里做 |
| 图片是否进入模型视觉上下文 | **否**。工具结果只带文本；返回 `imageInContext: false` 并提示调 `read_image` |
| 音频峰值是否来自原始波形 | **是**。Node 直接解析 WAV PCM 采样，不再读 Audio Levels |
| 文字适配是否真实有效 | **是**，已实测表达式解析结果。但不支持旋转/缩放的复杂变换组合下的精确贴合 |
| Checkpoint 是否有程序级强制 | **已接入**（3.0.1 补完）。`lib/gate.js` 把判定接到真实执行路径上：`ae_compose` / `ae_template` 的建片门禁、`ae_run_script` 的写操作门禁、`ae_checkpoint` 的跨工程恢复拒绝。备份必须通过校验才算数，无法备份时**拒绝执行**而不是裸跑。见下方「3.0.1 补完项」 |

### 3.0.1 补完项：门禁从"库层能力"变成"执行路径"

上一版把门禁写成 `assertSafeToProceed` 这个函数就停手了——一个在执行前没被调用的门禁只是建议。本轮补齐的是**调用点**：

| 路径 | 为什么必须拦 | 现在的行为 |
| :--- | :--- | :--- |
| `ae_compose` 建同名合成 | `buildScene` 默认 `replace !== false`，会**删掉旧合成** | 先查工程里是否真有同名合成；有则新建并校验备份，失败则拒绝 |
| `ae_compose` 的 `resetProject` | 清空整个工程 | 同上；空工程放行（没有可毁内容），未保存工程直接拒绝 |
| `ae_template` | 走的是**同一条** `buildScene` 路径 | 与 `ae_compose` 完全同一道门，不是绕过通道 |
| `ae_run_script` | 唯一能执行任意 ExtendScript 的入口 | **写脚本**命中写模式 → 先备份，备份不成则拒绝执行；**读脚本**放行（未保存工程里读版本号不会被挡） |
| `ae_checkpoint action=restore` | 恢复别的工程的备份会把当前工作整个换掉 | 校验归属 + 目标完整性 + 恢复前安全备份 + 恢复后核对文件一致 |
| `ae_checkpoint action=list` | 旧实现会顺手 `app.project.save()` | 只读目录，绝不触发保存 |

判定原则有两条是刻意的：

1. **空的工程不备份**。建第一个合成不该复制一次工程文件；保护一旦变成噪音就会被绕过。
2. **探测失败按"有内容"处理**。`pro:projectStatus` 读不到时，`compNames` 返回 `null` 而不是 `[]`——"未知"不能当成"没有东西可毁"。

校验不可省：备份文件必须存在、≥1KB、前四字节是 `RIFX`/`AEGP`/`RIFF`，否则抛 `CHECKPOINT_INVALID`。测试里的假 bridge 交出的也是**磁盘上真实存在**的 `.aep`，假路径只能证明校验可被绕过。

### 时间重映射

`audioSource` 会检测 `timeRemapEnabled` 并在结果里标注；**重映射图层的时间换算未实现**，结果里会明确 `note` 说明。Reverse（负 stretch）目前的换算未经验证。

---

## 使用须知

- **不需要重启 DSH 之外的操作**：热重载即可让新代码生效。
- **不需要重开 CEP 面板**：本项目没有 CEP 面板。
- **不需要改 AE 设置**（除了首次启用「允许脚本写入文件和访问网络」）。
- 用之前**关掉开着的 AE 窗口**，无界面实例与它冲突。
- MOGRT 需用户自行在 AE 里导出（窗口 → 基本图形 → 导出动态图形模板）。
