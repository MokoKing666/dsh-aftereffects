# 升级变更清单 — dsh-aftereffects 2.0.0

商业级 AE 模板工具链。**架构不变**：仍然是 `AfterFX.exe -noui -r` + 文件队列 daemon，
新增能力全部走同一个 job 通道，没有引入 CEP、没有改端口、没有改鉴权。原本能连上的 AE 照旧能连。

## 新增工具（7 个，共 12 个）

| 工具 | 作用 |
| --- | --- |
| `ae_scan_effects` | 枚举本机全部特效，返回 `显示名 <-> matchName` 映射，标记第三方。实测扫出 599 个，其中 192 个第三方。 |
| `ae_inspect_plugin_params` | 单个效果的完整参数树：`propertyIndex` / `matchName` / `valueType` / 菜单项，**并显式标记 `customValue`（CUSTOM_VALUE 二进制黑盒，禁止赋值）**。 |
| `ae_apply_ffx_preset` | 扫描 `.ffx` 预设（名称已 URL 解码）。应用受无界面限制，见下。 |
| `ae_capture_preview` | `saveFrameToPng` 渲染，支持 `longEdge` 降采样、`soloLayerId` 图层隔离、多帧序列。 |
| `ae_essential_graphics` | 把属性绑进基本图形面板（`addToMotionGraphicsTemplate`），并尝试导出 `.mogrt`。 |
| `ae_audio_markers` | 分析音轨电平峰值自动打 Marker，静音轨不会误报。 |
| `ae_checkpoint` | 时间戳备份 `.aep`，原地保存后复制，不改工程指向，自动裁剪旧备份。 |
| `ae_run_script` | 逃生舱：任意 ExtendScript，**发送前 ES3 预检**，执行包 undo 组，错误返回精确行号与出错源码。 |

## 改动文件

| 文件 | 变更 |
| --- | --- |
| `lib/ae-runtime-pro.jsx` | **新增**。全部新能力的 ExtendScript 实现（ES3）。 |
| `lib/pro-tools.js` | **新增**。7 个工具的定义层。 |
| `lib/es3-guard.js` | **新增**。ES3 预检器：剥离字符串/注释后扫描，精确定位行列。 |
| `lib/ae-daemon.jsx` | 改为加载两个 runtime，支持 `pro:` 前缀路由，pro 包以 `eval` 包装注入核心 runtime。 |
| `lib/bridge.js` | 传入 `proRuntime` 路径；崩溃后自动清空队列并标记 `recoverable`。 |
| `lib/ae-runtime.jsx` | 层返回值补 `id`，并在建完后重新索引（原来记录的是插入时的索引，会过期）。 |
| `index.js` | 注册 7 个新工具 + `ae_run_script`；重写 system prompt 注入六条商业规范。 |
| `package.json` | 2.0.0。 |

## 六条商业规范（随插件自动注入 Agent）

1. 100% ES3，禁用 const/let/箭头函数/模板字符串/class/for-of/async
2. 第三方插件先 `ae_scan_effects` + `ae_inspect_plugin_params` 核对，禁止对 CUSTOM_VALUE 赋值，用 `propertyIndex`/`matchName` 而非中文名
3. 字幕框必须注入 `sourceRectAtTime()` 自适应表达式
4. 禁止默认线性关键帧，必须 `setTemporalEaseAtKey()` 或弹性/阻尼表达式
5. 重型特效或核心排版后必须 `ae_capture_preview` 自检
6. 破坏性批量操作前先 `ae_checkpoint`

## 实测结果

13/13 端到端通过，宿主全程存活；原有 smoke test 零回归。

## 两个必须知道的硬限制

**以下两项在无界面实例里会直接终止 AE 进程**（实测 AE 27.0x78），不是代码 bug，是 AE 的限制：

- `layer.applyPreset()` — 挂 `.ffx` 预设
- `comp.exportAsMotionGraphicsTemplate()` — 导出 `.mogrt`

工具已做成**先探测再拒绝**：`ae_apply_ffx_preset` 和 `ae_essential_graphics` 会调 `pro:capabilities`，
不可用时立即返回明确说明与替代路径，而不是让宿主消失。

- 需要预设效果 → 用 `ae_run_script` 按 `propertyIndex` 直接挂效果设参数（效果本身完全可脚本化）
- 需要 `.mogrt` → 控制器已绑好，在你打开的 AE 里「窗口 → 基本图形 → 导出动态图形模板」

崩溃后 bridge 会自动清理残留队列，**下一次调用自动拉起新实例**，不需要重启 DSH。

## 需要你在 AE 里做什么

**不需要重开扩展面板** —— 这个插件不是 CEP 扩展，没有面板。
唯一需要注意的是：如果你正开着 After Effects 窗口，先关掉它，插件要启动无界面实例。
