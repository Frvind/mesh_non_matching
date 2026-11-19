# mesh_non_matching

A minimal WebGL harness for looking at **how camera-space fragments land in light-space
texels**, with numbers instead of eyeballing.

One triangle, four rendered passes served on four ports (plus a locator page), depth written
as a 24-bit packed value that can be read back exactly, and a handful of scripts that export
the measurements as tables.

There is no geometry pipeline, no material system and no third-party runtime dependency:
the mesh is three hard-coded vertices, the shading programs live inside `MeshRender`, and the
app is plain ES modules served by a 100-line Node server.

---

## Quick start

```bash
node server.mjs        # no install step, no build step
```

| Port | Pass | Rasterised from | Fragment value |
| --- | --- | --- | --- |
| <http://127.0.0.1:8771/> | `#4` | camera view | `lightViewProj(X) * world` → z (NDC) |
| <http://127.0.0.1:8772/> | `#5` | light(X) view | same quantity, from the light's own rasterisation |
| <http://127.0.0.1:8773/> | `#2` | camera view | `lightViewProj(Y) * world` → z (NDC) |
| <http://127.0.0.1:8774/> | `#3` | light(Y) view | same quantity, from the light's own rasterisation |
| <http://127.0.0.1:8775/> | locator | — | coordinate → pixel lookup for all passes |

Two further passes (`#0`, `#1`) are rendered but not exposed on a port: they write the plain
world-space depth of the light / camera rasterisation and are used as cross-checks and by the
locator table.

Ports can be changed:

```bash
PASS_4_PORT=9001 PASS_5_PORT=9002 PASS_2_PORT=9003 PASS_3_PORT=9004 LOCATOR_PORT=9005 node server.mjs
```

## What the passes share, and what they do not

- **Same mesh, same model matrix, same projection.** Every pass renders the same triangle with
  the same `M` and the same 55° perspective projection into a **180×180** viewport.
- **Each pass owns everything else**: its own FBO, its own `MeshRender`, its own program, its own
  view matrix and (for the `lightZ` passes) its own `lightViewProj`. Passes never share render
  state, so the order in which they are drawn is irrelevant.
- **Two light views.** `lightX` rotates the light eye about the X axis (y/z change), `lightY`
  rotates about Y (x/z change); both start from the same eye as the camera. Angles default to
  `x: 70°, y: 79°` and are editable in `src/mesh-params.mjs` or with the slider in the page.
- **Every pass awaits readiness.** `MeshRender.load()` compiles, links and uploads buffers
  asynchronously and exposes `ready()`; `renderPass()` awaits it before the first draw call, and
  `MeshRender.draw()` throws if it is called too early.

## Depth encoding

The fragment value is normalised into `[0, 1)` and packed as 24-bit fixed point into RGB, with
alpha used as a coverage flag:

```
t   = (value − range[0]) / (range[1] − range[0])
r   = floor(t·255)          g = floor(fract(t·255)·255)      b = floor(fract(...)·255)
RGB = (r, g, b) / 255       A = 1 (covered) | 0 (background)
```

Inverting it gives `t = (r + g/255 + b/65025) / 255` and a resolution of `range / 2²⁴`
(4.8e-7 world units for the world-space depth passes, 1.2e-7 NDC for the `lightZ` passes).

The packing only survives if nothing blurs it, so the render targets are plain RGBA8 without
MSAA, the presenter samples with `NEAREST`, and the analysis scripts read raw texels with
`readPixels`.

## Tools

### Coordinate → pixel locator (on every port)

Type a world position as `x / y / z`, **or** as plane coordinates `(u, v)` of the triangle
(origin at `v0`, `u` along `v0→v1`, `v` along `n × u`) — a plane point always lands exactly on
the triangle's plane. The panel lists, for all six passes: the sub-pixel position, whether that
pixel has a fragment, the value decoded from the texel, the analytic value at the input point,
and the difference. It also reports barycentric coordinates and both `lightMVP` z values for the
point.

### Per-texel aggregate table (on every port)

Takes the centre **32×32** camera pixels, projects each fragment into light space and groups by
light texel, giving one row per texel: the z stored in the light pass for that texel, the z of
the fragments that landed in it, the fragment count, and their camera-screen positions. Switch
between the two light spaces with one button. Multi-fragment texels are highlighted and can be
exported as TSV.

### Export scripts

The page is for looking; the scripts are for keeping records. They need a running server and
Playwright (see *Requirements*):

```bash
node dump-table.mjs      # summary.md, locator.md, plane-locate.*, texel-*.{md,tsv}
node dump-residual.mjs   # residual.md, residual.tsv      readback vs analytic, split into terms
node dump-decompose.mjs  # decompose.md, decompose-*.tsv  delta split into resampling + residual
node dump-bias.mjs       # bias-decision.md, bias-*.tsv, fragment-side-*.tsv
```

All of them write into `out/` (git-ignored) and append a line to `out/runs.md`.
Options: `--port`, `--out`, `--window`, `--md-rows`.

## Measured results

Numbers below are from the default configuration (180×180, light eye rotated `x: 70°`,
`y: 79°`, camera centre 32×32 window) and are reproduced by the export scripts.

**1. The packed value is the value.** Reading a texel back and inverting the packing reproduces
the analytic value at that pixel's ray with a residual of at most **0.013 px equivalent**
(≈2e-5 world units for the world-depth passes, ≈1.5e-5 NDC for the `lightZ` passes).

**2. Fragments crowd one texel.** 1024 camera fragments in the sampled window map to

| light space | texels hit | texels with >1 fragment | max fragments per texel |
| --- | --- | --- | --- |
| `lightY` (79°) | 70 | 67 | **31** |
| `lightX` (70°) | 537 | 433 | 5 |

**3. The mismatch is a resampling term, not precision.** For every fragment,
`Δ = Z_cam − Z_texel` splits into

```
Δ = (∂Z/∂u)(u_f − u_texel) + (∂Z/∂v)(v_f − v_texel)   +   residual
```

| light space | mean \|Δ\| | resampling term | residual | resampling share |
| --- | --- | --- | --- | --- |
| `lightY` | 7.42e-3 | 7.43e-3 | 8.45e-5 | 100.08 % |
| `lightX` | 4.95e-4 | 4.95e-4 | 5.38e-6 | 100.00 % |

The residual is constant *inside* a texel (spread ≤1.6e-8) while the resampling term changes
sign inside a texel (spread up to 3.5e-2). So precision is a per-texel constant, whereas the
crowding effect is per-fragment.

**4. Which direction to correct.** With the convention used here, larger z means farther, and a
fragment is lit when `Z_cam ≤ Z_texel + bias`. Therefore:

- `Δ > 0` → the fragment would be judged shadowed (false self-shadowing) and must be corrected;
  either **sink the fragment** by `Δ` (fragment side) or **raise the stored texel value** by `Δ`
  (texel side) — the same correction written on two sides, so only one of them may be applied.
- `Δ ≤ 0` → already lit, nothing to do. Sinking the stored value, or raising an already-lit
  fragment, only spends the light-leak margin.

| light space | fragments needing correction (Δ>0) | per-texel bias = max Δ | global constant bias | texels over-biased by a global constant |
| --- | --- | --- | --- | --- |
| `lightY` | 504 / 1024 | 1.87e-2 NDC | 1.87e-2 NDC | 15 (of 70) |
| `lightX` | 505 / 1024 | 1.09e-3 NDC | 1.09e-3 NDC | 61 (of 537) |

A per-texel bias removes all false self-shadowing in the sample; a single global constant has to
take the worst case and therefore over-corrects the texels that did not need it.

## Requirements

- The app itself: any Node.js ≥ 18 and a WebGL2/WebGL1 browser. Nothing else.
- The export scripts: `playwright-core` (or `playwright`) plus a Chromium.
  `npm i -D playwright && npx playwright install chromium`, or point at an existing install with
  `PLAYWRIGHT_CORE=/path/to/playwright-core/index.js` and `CHROME_PATH=/path/to/chrome`.

## Notes and limitations

- A single triangle means there is no occlusion: the correct answer for every fragment is "lit",
  so the harness measures self-shadowing behaviour only. There is no shadow receiver to leak onto.
- The in-page UI and the generated tables are in Chinese; source comments and this README are in
  English (Chinese section below).
- `out/` is generated, not committed.

## License

MIT — see [LICENSE](LICENSE).

## Layout

```
.
├── index.html            canvas + side panel (locator, texel table, previews)
├── style.css
├── server.mjs            five-port static server, injects /config.js per port
├── dump-table.mjs        exports the locator / texel tables
├── dump-residual.mjs     readback-vs-analytic decomposition
├── dump-decompose.mjs    Δ = resampling + residual
├── dump-bias.mjs         raise/sink decision per fragment and per texel
└── src
    ├── mesh-params.mjs   mesh, views, passes, viewports, packing ranges
    ├── mesh-render.mjs   MeshRender: internal programs, async readiness
    ├── webgl-renderer.mjs WebGLRenderer: one FBO per pass, per-pass lightMVP
    ├── camera.mjs        projection, unprojection, cross-pass mapping
    ├── depth-codec.mjs   24-bit packing / unpacking
    ├── mat4.mjs          small column-major matrix helpers
    └── engine.mjs        async main, locator, aggregate table
```

---

# mesh_non_matching（中文）

一个极小的 WebGL 实验环境，用来观察 **camera 空间的 fragment 落到 light 空间 texel 上**发生了什么，
并且用**数字**而不是肉眼去看。

只有一个三角形，四个 pass 分别开在四个端口上（外加一个定位页），深度以 24bit 定点打包写进颜色，
可以精确读回；另有几个脚本把测量结果导出成表。

没有几何管线、没有材质系统、没有第三方运行时依赖：mesh 是写死的三个顶点，着色程序住在 `MeshRender`
内部，整个应用是 100 行 Node 服务器拉起的原生 ES 模块。

## 快速开始

```bash
node server.mjs        # 无需安装、无需构建
```

| 端口 | pass | 光栅化来源 | 片元值 |
| --- | --- | --- | --- |
| <http://127.0.0.1:8771/> | `#4` | camera 视角 | `lightViewProj(X) * world` 的 z（NDC） |
| <http://127.0.0.1:8772/> | `#5` | light(X) 视角 | 同一个量，但由 light 自己光栅化 |
| <http://127.0.0.1:8773/> | `#2` | camera 视角 | `lightViewProj(Y) * world` 的 z（NDC） |
| <http://127.0.0.1:8774/> | `#3` | light(Y) 视角 | 同一个量，但由 light 自己光栅化 |
| <http://127.0.0.1:8775/> | 定位页 | — | 坐标 → 各 pass 像素位置 |

另有 `#0`、`#1` 两个 pass 会渲染但不开端口：它们输出 light / camera 光栅化的世界坐标深度，用于交叉校验和定位表。

端口可改：`PASS_4_PORT=9001 PASS_5_PORT=9002 PASS_2_PORT=9003 PASS_3_PORT=9004 LOCATOR_PORT=9005 node server.mjs`。

## 共性 / 差异

- **同一份 mesh、同一个 M、同一个投影**：所有 pass 画同一个三角形，用同一个模型矩阵和同一个 55° 透视投影，
  视口都是 **180×180**。
- **其余一切都独立**：各自的 FBO、各自的 `MeshRender`、各自的 program、各自的视图矩阵，
  `lightZ` 的 pass 还各有自己的 `lightViewProj`。因此 pass 之间不共享渲染状态，绘制顺序无关。
- **两个 light 视角**：`lightX` 让 light 的 eye 绕 X 轴转（y/z 变化），`lightY` 绕 Y 轴转（x/z 变化），
  两者都从与 camera 相同的 eye 出发。默认角度 `x: 70°`、`y: 79°`，可在 `src/mesh-params.mjs` 或页面滑块调整。
- **每个 pass 都等就绪**：`MeshRender.load()` 异步完成编译、链接与顶点上传并暴露 `ready()`；
  `renderPass()` 在第一次 draw 之前 await 它，`MeshRender.draw()` 在未就绪时直接抛异常。

## 深度编码

片元值先归一化到 `[0, 1)`，再按 24bit 定点打包进 RGB，alpha 作覆盖标记：

```
t   = (value − range[0]) / (range[1] − range[0])
r   = floor(t·255)          g = floor(fract(t·255)·255)      b = floor(fract(...)·255)
RGB = (r, g, b) / 255       A = 1（有 fragment）| 0（背景）
```

反解 `t = (r + g/255 + b/65025) / 255`，分辨率为 `range / 2²⁴`
（世界深度口径 4.8e-7 世界单位、`lightZ` 口径 1.2e-7 NDC）。

这种打包不能被任何滤波污染，所以渲染目标是不带 MSAA 的 RGBA8、presenter 用 `NEAREST` 采样、
分析脚本用 `readPixels` 读原始纹素。

## 工具

### 坐标 → 像素定位（每个端口都有）

可输世界坐标 `x / y / z`，也可输三角形的**平面坐标 `(u, v)`**（原点在 `v0`，`u` 沿 `v0→v1`，`v` 沿 `n × u`），
平面坐标换算出的点必然落在三角形所在平面上。表格列出六趟 pass 各自的亚像素位置、是否有 fragment、
纹素反解值、输入点的解析值以及两者之差；同时给出该点的重心坐标与两个 light 空间的 `lightMVP` z。

### 同 texel 总表（每个端口都有）

取 camera 中心 **32×32** 像素的 fragment 投到 light 空间并按 light texel 归组，每行给出：
该 texel 在 light pass 里存下的 z、落进来 fragment 的 z 范围、数量、以及它们在 camera 屏幕上的位置。
两个 light 空间一键切换，多 fragment 的行高亮，可导出 TSV。

### 导出脚本

页面用来看，脚本用来留档。需要先跑起 `server.mjs`，并安装 Playwright（见「依赖」）：

```bash
node dump-table.mjs      # summary.md, locator.md, plane-locate.*, texel-*.{md,tsv}
node dump-residual.mjs   # residual.md / .tsv    读回 vs 解析，拆成各项
node dump-decompose.mjs  # decompose.md / *.tsv  Δ 拆成重采样项 + 残差项
node dump-bias.mjs       # bias-decision.md / *.tsv  逐 fragment、逐 texel 的抬升/下沉决策
```

都写到 `out/`（已 git-ignore），并向 `out/runs.md` 追加一行；参数：`--port`、`--out`、`--window`、`--md-rows`。

## 实测结论

以下数字来自默认配置（180×180、light eye 旋转 `x: 70°` / `y: 79°`、camera 中心 32×32 窗口），
可用导出脚本复现。

**1. 打包值就是那个值。** 反解纹素得到的值与"该像素射线上的解析值"最多只差 **0.013 px 当量**
（世界深度口径约 2e-5 世界单位，`lightZ` 口径约 1.5e-5 NDC）。

**2. fragment 会挤占同一个 texel。** 采样窗口内 1024 个 camera fragment 映射到：

| light 空间 | 覆盖 texel | 多 fragment 的 texel | 最多 fragment/texel |
| --- | --- | --- | --- |
| `lightY`（79°） | 70 | 67 | **31** |
| `lightX`（70°） | 537 | 433 | 5 |

**3. 差异是重采样项，不是精度。** 对每个 fragment，`Δ = Z_cam − Z_texel` 可拆成

```
Δ = (∂Z/∂u)(u_f − u_texel) + (∂Z/∂v)(v_f − v_texel)   +   残差
```

| light 空间 | \|Δ\| 均值 | 重采样项 | 残差 | 重采样项占比 |
| --- | --- | --- | --- | --- |
| `lightY` | 7.42e-3 | 7.43e-3 | 8.45e-5 | 100.08 % |
| `lightX` | 4.95e-4 | 4.95e-4 | 5.38e-6 | 100.00 % |

残差在**同一个 texel 内基本恒定**（散布 ≤1.6e-8），而重采样项在同一 texel 内会改变符号（散布可达 3.5e-2）。
也就是说：精度项是"每 texel 一个常数"，挤占效应是"每 fragment 一份"。

**4. 该往哪个方向修。** 本文的投影下 z 越大越远，受光判据是 `Z_cam ≤ Z_texel + bias`，于是：

- `Δ > 0` → 会被判成阴影（假自遮挡），必须修正：**fragment 侧下沉 Δ**，或 **texel 侧抬升 Δ** ——
  同一个修正的两种写法，只能选一侧施加。
- `Δ ≤ 0` → 本来就受光，不需要动；下沉存储值或抬升已受光的 fragment，只会吃掉漏光余量。

| light 空间 | 需要修正的 fragment（Δ>0） | 逐 texel 抬升量 = max Δ | 全局常量抬升 | 全局常量会过度抬升的 texel |
| --- | --- | --- | --- | --- |
| `lightY` | 504 / 1024 | 1.87e-2 NDC | 1.87e-2 NDC | 15（共 70） |
| `lightX` | 505 / 1024 | 1.09e-3 NDC | 1.09e-3 NDC | 61（共 537） |

逐 texel 抬升可把样本内的假自遮挡清零；单一全局常量必须取最坏值，因此会过度修正那些本来不需要的 texel。

## 依赖

- 应用本体：Node.js ≥ 18 + 支持 WebGL2/WebGL1 的浏览器，无其他依赖。
- 导出脚本：`playwright-core`（或 `playwright`）+ 一个 Chromium。
  可用 `npm i -D playwright && npx playwright install chromium`，或用
  `PLAYWRIGHT_CORE=/path/to/playwright-core/index.js`、`CHROME_PATH=/path/to/chrome` 指向已有安装。

## 说明与限制

- 只有一个三角形 ⇒ 没有任何遮挡，所有 fragment 的正确答案都是"受光"，因此本环境只测自遮挡行为，
  没有可被漏光的接收体。
- 页面 UI 与生成的表格是中文；源码注释与本文档为英文（中文部分接在后面）。
- `out/` 是生成物，不提交。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 目录结构

```
.
├── index.html            canvas + 右侧面板（定位器、texel 总表、预览）
├── style.css
├── server.mjs            五端口静态服务器，按端口注入 /config.js
├── dump-table.mjs        导出定位表 / texel 表
├── dump-residual.mjs     读回 vs 解析 的分解
├── dump-decompose.mjs    Δ = 重采样项 + 残差项
├── dump-bias.mjs         逐 fragment / 逐 texel 的抬升-下沉决策
└── src
    ├── mesh-params.mjs   mesh、视角、pass、视口、打包区间
    ├── mesh-render.mjs   MeshRender：内置 program、异步就绪
    ├── webgl-renderer.mjs WebGLRenderer：每 pass 一个 FBO、每 pass 的 lightMVP
    ├── camera.mjs        投影、反投影、跨 pass 映射
    ├── depth-codec.mjs   24bit 打包 / 反解
    ├── mat4.mjs          列主序矩阵小工具
    └── engine.mjs        async 主函数、定位器、总表
```

---

## Repository hygiene

- `out/` (generated tables) and `node_modules/` are git-ignored.
- Source comments are English; the only Chinese in the code base is page UI text, generated
  table content, and the Chinese half of this README.
- No absolute paths: the export scripts resolve `playwright-core` from `node_modules` and fall
  back to `PLAYWRIGHT_CORE` / `CHROME_PATH` environment variables.
