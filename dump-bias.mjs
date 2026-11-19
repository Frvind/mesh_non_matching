// Decides, per fragment and per texel, whether the depth comparison has to be
// raised (texel side) or sunk (fragment side) for fragments that crowd into one
// light texel: bias-decision.md, bias-texels-*.tsv, bias-fragments-*.tsv,
// fragment-side-*.tsv
//
// Usage: node dump-bias.mjs [--port 8773] [--out ./out] [--window 32]

// ---------------------------------------------------------------------------
//
//      Δ      = Z_cam - Z_texel
//
//
// ---------------------------------------------------------------------------

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};

const PORT = Number(argOf('port', process.env.DUMP_PORT ?? 8773));
const OUT_DIR = path.resolve(ROOT, argOf('out', 'out'));
const WINDOW = Number(argOf('window', 32));

// playwright-core is resolved from node_modules by default; override with
// PLAYWRIGHT_CORE if it lives elsewhere. CHROME_PATH is optional: when unset,
// Playwright's own bundled Chromium is used.
const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE ?? 'playwright-core';
const CHROME = process.env.CHROME_PATH || undefined;

let playwright;
try {
  const mod = await import(PLAYWRIGHT_CORE);
  playwright = mod.default ?? mod;
} catch (error) {
  console.error(`[dump] cannot load "${PLAYWRIGHT_CORE}". Install playwright-core or set PLAYWRIGHT_CORE.`);
  throw error;
}
const { chromium } = playwright;

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 900 } });
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ENGINE_READY__ !== undefined, null, { timeout: 25000 });
  await page.evaluate(() => window.__ENGINE_READY__);

  const data = await page.evaluate(async (windowSize) => {
    const { renderer, state, passes } = window.__ENGINE__;
    const { TRIANGLE_MESH } = await import('./src/mesh-params.mjs');
    const { reconstructWorldPoint } = await import('./src/camera.mjs');
    const { transformPoint4 } = await import('./src/mat4.mjs');

    const [a, b, c] = TRIANGLE_MESH.positions;
    const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
    const dot = (p, q) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const nlen = Math.hypot(...n);
    const normal = n.map((v) => v / nlen);
    const dPlane = dot(normal, a);

    const surfaceAt = (passIndex, px, py) => {
      const frame = renderer.getPassFrame(passIndex);
      const onRay = reconstructWorldPoint({ px, py }, 1.0, frame);
      const eye = frame.eye;
      const dir = sub(onRay, eye);
      const denom = dot(dir, normal);
      const t = (dPlane - dot(normal, eye)) / denom;
      return [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
    };

    const lightZOf = (passIndex, world) => {
      const frame = renderer.getPassFrame(passIndex);
      const clip = transformPoint4(frame.lightViewProj, world);
      return clip[3] > 1e-9
        ? { z: clip[2] / clip[3], u: (clip[0] / clip[3]) * 0.5 + 0.5, v: (clip[1] / clip[3]) * 0.5 + 0.5 }
        : null;
    };

    const cameraPassIndex = 1;
    const cameraFrame = renderer.getPassFrame(cameraPassIndex);
    const cameraCache = state.caches[cameraPassIndex];
    const size = Math.min(windowSize, cameraFrame.grid.width, cameraFrame.grid.height);
    const startX = Math.floor((cameraFrame.grid.width - size) / 2);
    const startY = Math.floor((cameraFrame.grid.height - size) / 2);

    const results = {};

    for (const lightView of ['lightY', 'lightX']) {
      const lightPassIndex = passes.findIndex(
        (pass) => pass.lightView === lightView && pass.kind === 'lightZ' && pass.view === lightView,
      );
      const lightFrame = renderer.getPassFrame(lightPassIndex);
      const lightCache = state.caches[lightPassIndex];
      const lightW = lightFrame.grid.width;
      const lightH = lightFrame.grid.height;

      const fragments = [];

      for (let py = startY; py < startY + size; py++) {
        for (let px = startX; px < startX + size; px++) {
          const idx = py * cameraCache.width + px;
          if (!cameraCache.coverage[idx]) continue;

          const world = surfaceAt(cameraPassIndex, px, py);
          const projected = lightZOf(lightPassIndex, world);
          if (!projected) continue;

          const uFloat = projected.u * lightW - 0.5;
          const vFloat = projected.v * lightH - 0.5;
          const tx = Math.round(uFloat);
          const ty = Math.round(vFloat);
          if (tx < 0 || ty < 0 || tx >= lightW || ty >= lightH) continue;

          const storedCovered = lightCache.coverage[ty * lightW + tx] === 1;
          const zTexel = storedCovered ? lightCache.values[ty * lightW + tx] : null;
          if (zTexel === null) continue;

          const zCam = projected.z;
          const delta = zCam - zTexel;

          const centerZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx, ty)).z;
          const uZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx + 1, ty)).z;
          const vZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx, ty + 1)).z;
          const dZdu = uZ - centerZ;
          const dZdv = vZ - centerZ;
          const deltaPredicted = dZdu * (uFloat - tx) + dZdv * (vFloat - ty);

          fragments.push({
            lightView,
            cameraPx: px,
            cameraPy: py,
            tx,
            ty,
            uFloat,
            vFloat,
            subTexelOffset: Math.hypot(uFloat - tx, vFloat - ty),
            zCam,
            zTexel,
            delta,
            deltaPredicted,
            deltaPredictionError: delta - deltaPredicted,
            verdict: delta > 0 ? 'raise' : 'ok',
            neededRaise: Math.max(0, delta),
            fragSideAction: delta > 1e-12 ? 'sink' : 'none',
            fragSideAmount: Math.max(0, delta),
            texelSideAction: delta > 1e-12 ? 'raise' : 'none',
            consistentAdjust: -delta,
            consistentAction: delta > 1e-12 ? 'sink' : delta < -1e-12 ? 'raise' : 'none',
            marginAfterSink: (zCam - Math.max(0, delta)) <= zTexel ? zTexel - (zCam - Math.max(0, delta)) : 0,
          });
        }
      }

      const byTexel = new Map();
      for (const fragment of fragments) {
        const key = `${fragment.tx},${fragment.ty}`;
        if (!byTexel.has(key)) byTexel.set(key, []);
        byTexel.get(key).push(fragment);
      }

      const texels = [];
      for (const [key, list] of byTexel) {
        const [tx, ty] = key.split(',').map(Number);
        const deltas = list.map((f) => f.delta);
        const maxDelta = Math.max(...deltas);
        const minDelta = Math.min(...deltas);
        const raiseCount = list.filter((f) => f.delta > 0).length;
        texels.push({
          lightView,
          tx,
          ty,
          count: list.length,
          raiseCount,
          okCount: list.length - raiseCount,
          zTexel: list[0].zTexel,
          minDelta,
          maxDelta,
          neededBias: Math.max(0, maxDelta),
          decision: maxDelta > 0 ? 'raise' : 'none',
          sinkWouldShadow: list.filter((f) => f.delta > 0).length,
          marginWhenNoBias: minDelta,
        });
      }
      texels.sort((x, y) => y.count - x.count || y.ty - x.ty || x.tx - y.tx);

      const raiseFragments = fragments.filter((f) => f.neededRaise > 0);
      const maxBias = texels.reduce((max, t) => Math.max(max, t.neededBias), 0);
      const globalBiasTexels = texels.filter((t) => t.maxDelta <= 0).length;

      results[lightView] = {
        lightView,
        lightPassIndex,
        samples: fragments.length,
        texelCount: texels.length,
        multiTexel: texels.filter((t) => t.count > 1).length,
        deltaPositive: fragments.filter((f) => f.delta > 0).length,
        deltaNegative: fragments.filter((f) => f.delta <= 0).length,
        maxDelta: Math.max(...fragments.map((f) => f.delta)),
        minDelta: Math.min(...fragments.map((f) => f.delta)),
        meanDelta: fragments.reduce((sum, f) => sum + f.delta, 0) / fragments.length,
        maxPredictionError: Math.max(...fragments.map((f) => Math.abs(f.deltaPredictionError))),
        texelsNeedingRaise: texels.filter((t) => t.decision === 'raise').length,
        texelsNeedingNothing: texels.filter((t) => t.decision === 'none').length,
        raiseFragmentCount: raiseFragments.length,
        fragSinkCount: fragments.filter((f) => f.fragSideAction === 'sink').length,
        fragNoneCount: fragments.filter((f) => f.fragSideAction === 'none').length,
        maxFragSink: Math.max(...fragments.map((f) => f.fragSideAmount)),
        meanFragSinkOfSinkers:
          fragments.filter((f) => f.fragSideAction === 'sink').reduce((sum, f) => sum + f.fragSideAmount, 0) /
          Math.max(1, fragments.filter((f) => f.fragSideAction === 'sink').length),
        consistentRaiseCount: fragments.filter((f) => f.consistentAction === 'raise').length,
        consistentSinkCount: fragments.filter((f) => f.consistentAction === 'sink').length,
        maxNeededBias: maxBias,
        globalConstantBias: maxBias,
        overBiasedTexelsIfGlobal: globalBiasTexels,
        falseShadowAfterPerTexelBias: fragments.filter((f) => f.delta - (byTexel.get(`${f.tx},${f.ty}`)[0] ? Math.max(0, Math.max(...byTexel.get(`${f.tx},${f.ty}`).map((x) => x.delta))) : 0) > 1e-12).length,
        fragments,
        texels,
      };
    }

    return {
      url: location.href,
      now: new Date().toISOString(),
      windowSize,
      window: { startX, startY, size },
      results,
    };
  }, WINDOW);

  await mkdir(OUT_DIR, { recursive: true });

  const sci = (v) => (v === null || v === undefined ? '-' : Number(v).toExponential(3));
  const f6 = (v) => (v === null || v === undefined ? '-' : Number(v).toFixed(6));

  const md = [
    '# 同 texel 挤占: 抬升还是下沉',
    '',
    `- 时间: ${data.now}`,
    `- 页面: ${data.url}`,
    `- 采样: camera grid 中心 ${data.window.size}×${data.window.size} 像素（x ${data.window.startX}–${data.window.startX + data.window.size - 1}, y ${data.window.startY}–${data.window.startY + data.window.size - 1}）`,
    '',
    '## 判据',
    '',
    '```',
    'Z_texel = light pass 在该 texel 存下的 z (light NDC)',
    'Z_cam   = 该 camera fragment 自己的 light NDC z',
    'Δ       = Z_cam − Z_texel          (z 越大越远)',
    '',
    '深度测试: 受光 iff Z_cam ≤ Z_texel + bias',
    '  Δ > 0  → 该 fragment 会被判成阴影（假自遮挡）→ 这个 texel 必须【抬升】bias ≥ Δ',
    '  Δ ≤ 0  → 自然受光 → 不需要任何偏移（|Δ| 就是安全余量）',
    '  下沉只会让更多 fragment 满足 Δ > 0 → 只会加重 acne',
    '```',
    '',
    '所以"抬升还是下沉"不是策略选择，而是由 Δ 的符号唯一决定：**该 texel 内 max(Δ) > 0 就抬升，抬升量 = max(Δ)；否则不动**。',
    'Δ 本身是解析可算的：`Δ ≈ (∂Z/∂u)·(u−u_texel) + (∂Z/∂v)·(v−v_texel)`（光空间局部斜率 × 亚像素偏移），表里用 `Δ 预测` 列做了交叉验证。',
    '',
    '## 汇总',
    '',
    '| light 空间 | 采样 fragment | texel | 多 fragment texel | Δ>0 的 fragment | Δ≤0 的 fragment | Δ 范围 | 需要抬升的 texel | 最大抬升量 (NDC) | 全局常量抬升需 | 逐 texel 抬升后残余假阴影 | Δ 预测最大误差 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...['lightY', 'lightX'].map((name) => {
      const r = data.results[name];
      return `| ${name} | ${r.samples} | ${r.texelCount} | ${r.multiTexel} | ${r.deltaPositive} | ${r.deltaNegative} | ` +
        `${sci(r.minDelta)} ~ ${sci(r.maxDelta)} | ${r.texelsNeedingRaise} | ${sci(r.maxNeededBias)} | ` +
        `${sci(r.globalConstantBias)}（会过度抬升 ${r.overBiasedTexelsIfGlobal} 个 texel） | ${r.falseShadowAfterPerTexelBias} | ${sci(r.maxPredictionError)} |`;
    }),
    '',
    '## fragment 侧：抬升 还是 下沉',
    '',
    '修正写在**哪一侧**，方向的符号就相反；同一个物理修正有两种写法：',
    '',
    '```',
    '受光判据: z_cam <= z_texel + bias',
    '  在 fragment 侧做: 把 z_cam 减小 = 【下沉】 ← 对 Δ>0 的 fragment 用这个',
    '  在 texel 侧做  : 把 z_texel 增大 = 【抬升】 ← 对 texel 存储值用这个',
    '二者等价（同一个比较判据往同一侧推），对一个 fragment 只能选一侧、一个符号，否则会互相抵消。',
    '```',
    '',
    '**逐 fragment 的方向不统一**：只有 Δ = Z_cam − Z_texel > 0 的 fragment 会被误判成阴影，它们需要被【下沉】|Δ|；',
    'Δ ≤ 0 的 fragment 本来就受光，不需要动（若为了"和 texel 采样完全一致"而把它们【抬升】|Δ|，只会吃掉漏光余量，对假阴影没帮助）。',
    '',
    '| light 空间 | fragment | 需下沉（Δ>0） | 不需动（Δ≤0） | 下沉量均值 | 下沉量最大 | 一致化则需抬升的 fragment |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...['lightY', 'lightX'].map((name) => {
      const r = data.results[name];
      return `| ${name} | ${r.samples} | ${r.fragSinkCount} | ${r.fragNoneCount} | ` +
        `${sci(r.meanFragSinkOfSinkers)} | ${sci(r.maxFragSink)} | ${r.consistentRaiseCount} |`;
    }),
    '',
    '## 逐 texel 决策（前 40 行，完整见 bias-texels.tsv）',
    '',
    ...['lightY', 'lightX'].flatMap((name) => {
      const rows = data.results[name].texels.slice(0, 20);
      return [
        `### ${name}`,
        '',
        '| texel | #frag | 需要抬升的 frag | Z_texel | Δ min | Δ max | 决策 | 抬升量 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- |',
        ...rows.map(
          (t) =>
            `| (${t.tx}, ${t.ty}) | ${t.count} | ${t.raiseCount} | ${f6(t.zTexel)} | ${sci(t.minDelta)} | ${sci(t.maxDelta)} | ` +
            `${t.decision === 'raise' ? '**抬升**' : '不动'} | ${sci(t.neededBias)} |`,
        ),
        '',
      ];
    }),
    '## 结论',
    '',
    '1. **方向由符号决定**：Δ = Z_cam − Z_texel；Δ > 0 的 fragment 会被判成阴影。',
    '   - 修正放在 **fragment 侧** → 该 fragment【下沉】|Δ|（把自己拉近光源）；',
    '   - 修正放在 **texel 侧** → 存储值【抬升】|Δ|（把 texel 推远），是同一个修正的另一种写法；',
    '   - 对一个 fragment 不要两侧同时改，否则正负抵消。',
    '2. **抬升量是逐 texel 可算的**：该 texel 内 max(Δ)，或解析式 `∂Z/∂u·Δu + ∂Z/∂v·Δv`（与实测 Δ 的偏差见 `Δ 预测误差` 列）。',
    '3. **逐 texel 抬升 vs 全局常量**：逐 texel 抬升刚好消掉假阴影且不影响其他 texel；用一个全局常量则要取最坏值，会把不需要的 texel 也一起抬升（见汇总表的"过度抬升"数量）。',
    '',
  ].join('\n');

  await writeFile(path.join(OUT_DIR, 'bias-decision.md'), md, 'utf-8');

  for (const name of ['lightY', 'lightX']) {
    const r = data.results[name];
    const headerT = ['light_view', 'texel_u', 'texel_v', 'fragments', 'raise_fragments', 'z_texel', 'delta_min', 'delta_max', 'decision', 'needed_bias_ndc'];
    const linesT = r.texels.map((t) =>
      [name, t.tx, t.ty, t.count, t.raiseCount, t.zTexel.toFixed(8), t.minDelta.toExponential(8), t.maxDelta.toExponential(8), t.decision, t.neededBias.toExponential(8)].join('\t'),
    );
    await writeFile(path.join(OUT_DIR, `bias-texels-${name}.tsv`), [headerT.join('\t'), ...linesT].join('\n'), 'utf-8');

    const headerF = ['light_view', 'camera_px', 'camera_py', 'texel_u', 'texel_v', 'u_float', 'v_float', 'z_cam', 'z_texel', 'delta_z_cam_minus_texel', 'delta_predicted', 'prediction_error', 'verdict', 'needed_raise'];
    const linesF = r.fragments.map((f) =>
      [name, f.cameraPx, f.cameraPy, f.tx, f.ty, f.uFloat.toFixed(4), f.vFloat.toFixed(4), f.zCam.toFixed(8), f.zTexel.toFixed(8), f.delta.toExponential(8), f.deltaPredicted.toExponential(8), f.deltaPredictionError.toExponential(8), f.verdict, f.neededRaise.toExponential(8)].join('\t'),
    );
    await writeFile(path.join(OUT_DIR, `bias-fragments-${name}.tsv`), [headerF.join('\t'), ...linesF].join('\n'), 'utf-8');

    const headerS = ['light_view', 'camera_px', 'camera_py', 'texel_u', 'texel_v', 'u_float', 'v_float', 'z_cam', 'z_texel', 'delta', 'frag_side_action', 'frag_side_sink_amount', 'texel_side_equivalent', 'consistent_adjust_signed', 'consistent_action'];
    const linesS = r.fragments.map((f) =>
      [name, f.cameraPx, f.cameraPy, f.tx, f.ty, f.uFloat.toFixed(4), f.vFloat.toFixed(4), f.zCam.toFixed(8), f.zTexel.toFixed(8), f.delta.toExponential(8), f.fragSideAction, f.fragSideAmount.toExponential(8), f.texelSideAction, f.consistentAdjust.toExponential(8), f.consistentAction].join('\t'),
    );
    await writeFile(path.join(OUT_DIR, `fragment-side-${name}.tsv`), [headerS.join('\t'), ...linesS].join('\n'), 'utf-8');
  }

  const runsPath = path.join(OUT_DIR, 'runs.md');
  let runs = '# dump 运行历史\n\n| 时间 | 脚本 | 说明 |\n| --- | --- | --- |\n';
  try {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(runsPath, 'utf-8');
    runs = existing.includes('| 时间 |') ? existing : runs;
  } catch {}
  const y = data.results.lightY;
  const x = data.results.lightX;
  runs += `| ${data.now} | dump-bias | 需抬升 texel: lightY ${y.texelsNeedingRaise}/${y.texelCount} (max bias ${y.maxNeededBias.toExponential(2)}), lightX ${x.texelsNeedingRaise}/${x.texelCount} (max bias ${x.maxNeededBias.toExponential(2)}) |\n`;
  await writeFile(runsPath, runs, 'utf-8');

  console.log(`[dump-bias] wrote ${OUT_DIR}`);
  for (const name of ['lightY', 'lightX']) {
    const r = data.results[name];
    console.log(
      `  ${name}: ${r.samples} fragments · ${r.texelCount} texels (${r.multiTexel} multi) · ` +
        `delta>0 ${r.deltaPositive} / delta<=0 ${r.deltaNegative} · ` +
        `texels needing raise ${r.texelsNeedingRaise} · max raise ${r.maxNeededBias.toExponential(2)} NDC · ` +
        `max prediction error ${r.maxPredictionError.toExponential(2)}`,
    );
  }
} catch (error) {
  console.error('[dump-bias] failed:', error?.message ?? error);
  console.error(`make sure server.mjs is running on 127.0.0.1:${PORT}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
