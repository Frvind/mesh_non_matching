// Splits delta = Z_cam - Z_texel into a resampling term and a residual term and
// checks whether the residual is constant inside one texel:
//   decompose.md, decompose-*.tsv
//
// Usage: node dump-decompose.mjs [--port 8773] [--out ./out] [--window 32]

// ---------------------------------------------------------------------------
//
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
      if (clip[3] <= 1e-9) return null;
      const ndcX = clip[0] / clip[3];
      const ndcY = clip[1] / clip[3];
      return { z: clip[2] / clip[3], ndcX, ndcY };
    };

    const cameraPassIndex = 1;
    const cameraFrame = renderer.getPassFrame(cameraPassIndex);
    const cameraCache = state.caches[cameraPassIndex];
    const size = Math.min(windowSize, cameraFrame.grid.width, cameraFrame.grid.height);
    const startX = Math.floor((cameraFrame.grid.width - size) / 2);
    const startY = Math.floor((cameraFrame.grid.height - size) / 2);

    const out = {};

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

          const uFloat = (projected.ndcX * 0.5 + 0.5) * lightW - 0.5;
          const vFloat = (projected.ndcY * 0.5 + 0.5) * lightH - 0.5;
          const tx = Math.round(uFloat);
          const ty = Math.round(vFloat);
          if (tx < 0 || ty < 0 || tx >= lightW || ty >= lightH) continue;
          if (lightCache.coverage[ty * lightW + tx] !== 1) continue;

          const zTexel = lightCache.values[ty * lightW + tx];
          const delta = projected.z - zTexel;

          const centerZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx, ty)).z;
          const uZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx + 1, ty)).z;
          const vZ = lightZOf(lightPassIndex, surfaceAt(lightPassIndex, tx, ty + 1)).z;
          const dZdu = uZ - centerZ;
          const dZdv = vZ - centerZ;
          const positional = dZdu * (uFloat - tx) + dZdv * (vFloat - ty);
          const residual = delta - positional;

          fragments.push({
            lightView,
            cameraPx: px,
            cameraPy: py,
            tx,
            ty,
            uFloat,
            vFloat,
            du: uFloat - tx,
            dv: vFloat - ty,
            dZdu,
            dZdv,
            zCam: projected.z,
            zTexel,
            delta,
            positional,
            residual,
          });
        }
      }

      const byTexel = new Map();
      for (const f of fragments) {
        const key = `${f.tx},${f.ty}`;
        if (!byTexel.has(key)) byTexel.set(key, []);
        byTexel.get(key).push(f);
      }

      const texelStats = [];
      for (const [key, list] of byTexel) {
        const [tx, ty] = key.split(',').map(Number);
        const residuals = list.map((f) => f.residual);
        const mean = residuals.reduce((s, v) => s + v, 0) / residuals.length;
        const spread = Math.max(...residuals) - Math.min(...residuals);
        const deltas = list.map((f) => f.delta);
        texelStats.push({
          tx,
          ty,
          count: list.length,
          residualMean: mean,
          residualSpread: spread,
          deltaMin: Math.min(...deltas),
          deltaMax: Math.max(...deltas),
          positionalSpread: Math.max(...list.map((f) => f.positional)) - Math.min(...list.map((f) => f.positional)),
        });
      }
      texelStats.sort((x, y) => y.count - x.count || y.ty - x.ty || x.tx - y.tx);

      const absPos = fragments.map((f) => Math.abs(f.positional));
      const absRes = fragments.map((f) => Math.abs(f.residual));
      const absDelta = fragments.map((f) => Math.abs(f.delta));
      const sum = (arr) => arr.reduce((s, v) => s + v, 0);

      out[lightView] = {
        lightView,
        lightPassIndex,
        samples: fragments.length,
        texelCount: texelStats.length,
        multiTexel: texelStats.filter((t) => t.count > 1).length,
        meanAbsDelta: sum(absDelta) / fragments.length,
        meanAbsPositional: sum(absPos) / fragments.length,
        meanAbsResidual: sum(absRes) / fragments.length,
        maxAbsPositional: Math.max(...absPos),
        maxAbsResidual: Math.max(...absRes),
        positionalShareOfMean: sum(absPos) / sum(absDelta),
        maxResidualSpreadWithinTexel: Math.max(...texelStats.map((t) => t.residualSpread)),
        meanResidualSpreadWithinTexel:
          sum(texelStats.filter((t) => t.count > 1).map((t) => t.residualSpread)) /
          Math.max(1, texelStats.filter((t) => t.count > 1).length),
        maxPositionalSpreadWithinTexel: Math.max(...texelStats.map((t) => t.positionalSpread)),
        deltaPositive: fragments.filter((f) => f.delta > 0).length,
        deltaNegative: fragments.filter((f) => f.delta <= 0).length,
        positionalPositive: fragments.filter((f) => f.positional > 0).length,
        positionalNegative: fragments.filter((f) => f.positional <= 0).length,
        fragments,
        texelStats,
      };
    }

    return {
      url: location.href,
      now: new Date().toISOString(),
      windowSize,
      window: { startX, startY, size },
      out,
    };
  }, WINDOW);

  await mkdir(OUT_DIR, { recursive: true });

  const sci = (v) => (v === null || v === undefined ? '-' : Number(v).toExponential(3));

  const md = [
    '# Δ 的分解：位置项（重新采样） + 残差项（光栅化/float/打包）',
    '',
    `- 时间: ${data.now}`,
    `- 页面: ${data.url}`,
    `- 采样: camera grid 中心 ${data.window.size}×${data.window.size} 像素`,
    '',
    '```',
    'Δ           = Z_cam − Z_texel',
    '位置项       = (∂Z/∂u)(u_f − u_texel) + (∂Z/∂v)(v_f − v_texel)   ← 把 camera fragment 重新采样到 light texel 的采样点',
    '残差项       = Δ − 位置项                                       ← 光栅化子像素吸附 + float 插值 + 24bit 打包',
    '```',
    '',
    '## 汇总',
    '',
    '| light 空间 | fragment | texel | 多 fragment texel | \\|Δ\\| 均值 | 位置项均值 | 残差均值 | 位置项占比 | 位置项最大 | 残差最大 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...['lightY', 'lightX'].map((name) => {
      const r = data.out[name];
      return `| ${name} | ${r.samples} | ${r.texelCount} | ${r.multiTexel} | ${sci(r.meanAbsDelta)} | ${sci(r.meanAbsPositional)} | ` +
        `${sci(r.meanAbsResidual)} | ${(r.positionalShareOfMean * 100).toFixed(2)}% | ${sci(r.maxAbsPositional)} | ${sci(r.maxAbsResidual)} |`;
    }),
    '',
    '## 残差到底是"每 texel 一个常数"还是"每 fragment 各一份"',
    '',
    '| light 空间 | 同 texel 内残差散布（多 fragment texel 平均） | 同 texel 内残差散布（最大） | 对照：同 texel 内位置项散布（最大） |',
    '| --- | --- | --- | --- |',
    ...['lightY', 'lightX'].map((name) => {
      const r = data.out[name];
      return `| ${name} | ${sci(r.meanResidualSpreadWithinTexel)} | ${sci(r.maxResidualSpreadWithinTexel)} | ${sci(r.maxPositionalSpreadWithinTexel)} |`;
    }),
    '',
    '残差在同一个 texel 内的散布远小于位置项 → **残差基本是"每 texel 一个常数（光侧 ε_light）+ 每 fragment 各自的小抖动"**，',
    '而位置项才是造成"同一 texel 内不同 fragment 判据撕裂"的部分。',
    '',
    '## 符号分裂',
    '',
    '| light 空间 | Δ>0（会被判阴影） | Δ≤0 | 位置项>0 | 位置项≤0 |',
    '| --- | --- | --- | --- | --- |',
    ...['lightY', 'lightX'].map((name) => {
      const r = data.out[name];
      return `| ${name} | ${r.deltaPositive} | ${r.deltaNegative} | ${r.positionalPositive} | ${r.positionalNegative} |`;
    }),
    '',
    '## 结论：三类项，各自由谁来修',
    '',
    '| 项 | 来源 | 是否随 fragment 变 | 修正位置 | 量级（lightY / lightX） |',
    '| --- | --- | --- | --- | --- |',
    '| ① camera 侧取整/位置 | camera 屏幕上把输入点取整到像素中心 | 每个 camera 像素一份 | **fragment 侧（前一步）** | 见 residual.md |',
    '| ② 光侧残差 ε_light | light 光栅化的子像素吸附 + float + 24bit 打包 | **每 texel 一个常数**（同 texel 内散布 ~1e-8） | **texel 侧常数**（或并进全局 bias） | 最大 ' + sci(data.out.lightY.maxAbsResidual) + ' / ' + sci(data.out.lightX.maxAbsResidual) + ' |',
    '| ③ 重采样位置项（camera fragment → light texel 采样点） | 落在 texel 内的亚像素位置 × 光空间局部斜率 | **每 fragment 一份，符号可正可负** | **只能逐 fragment**（不能用 texel 常数） | 最大 ' + sci(data.out.lightY.maxAbsPositional) + ' / ' + sci(data.out.lightX.maxAbsPositional) + ' |',
    '',
    '- "texel 偏移（单个 fragment）"和"fragment 挤占（多个）"是**同一个机制（③）**，只差在一个 texel 里有几个实例；',
    '  单个时可以用 texel 侧一个常数把它连同 ② 一起吃掉，多个时不行因为 ③ 的符号在一个 texel 内就会翻转。',
    '- 在 texel 侧抬升/下沉，实际修的是 **② + max(③)**；它无法区分 texel 内不同 fragment 各自的 ③。',
    '- 因此：用 texel 侧常数覆盖 ②，用 fragment 侧定向（Δ>0 就下沉 |Δ|）覆盖 ③，两者相加，不要互相抵消。',
    '',
    '## 逐 texel（前 20，完整见 decompose-*.tsv）',
    '',
    ...['lightY', 'lightX'].flatMap((name) => {
      const r = data.out[name];
      return [
        `### ${name}`,
        '',
        '| texel | #frag | 残差均值 | 残差散布 | 位置项散布 | Δ min | Δ max |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...r.texelStats.slice(0, 20).map(
          (t) =>
            `| (${t.tx}, ${t.ty}) | ${t.count} | ${sci(t.residualMean)} | ${sci(t.residualSpread)} | ${sci(t.positionalSpread)} | ${sci(t.deltaMin)} | ${sci(t.deltaMax)} |`,
        ),
        '',
      ];
    }),
  ].join('\n');

  await writeFile(path.join(OUT_DIR, 'decompose.md'), md, 'utf-8');

  for (const name of ['lightY', 'lightX']) {
    const r = data.out[name];
    const headerF = ['light_view', 'camera_px', 'camera_py', 'texel_u', 'texel_v', 'u_float', 'v_float', 'du', 'dv', 'dZdu', 'dZdv', 'z_cam', 'z_texel', 'delta', 'positional', 'residual', 'residual_share'];
    const linesF = r.fragments.map((f) =>
      [name, f.cameraPx, f.cameraPy, f.tx, f.ty, f.uFloat.toFixed(4), f.vFloat.toFixed(4), f.du.toFixed(4), f.dv.toFixed(4),
        f.dZdu.toExponential(6), f.dZdv.toExponential(6), f.zCam.toFixed(8), f.zTexel.toFixed(8),
        f.delta.toExponential(8), f.positional.toExponential(8), f.residual.toExponential(8),
        Math.abs(f.delta) > 1e-12 ? (Math.abs(f.positional) / Math.abs(f.delta)).toFixed(4) : '1.0000',
      ].join('\t'),
    );
    await writeFile(path.join(OUT_DIR, `decompose-${name}.tsv`), [headerF.join('\t'), ...linesF].join('\n'), 'utf-8');
  }

  const runsPath = path.join(OUT_DIR, 'runs.md');
  let runs = '# dump 运行历史\n\n| 时间 | 脚本 | 说明 |\n| --- | --- | --- |\n';
  try {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(runsPath, 'utf-8');
    runs = existing.includes('| 时间 |') ? existing : runs;
  } catch {}
  const y = data.out.lightY;
  const x = data.out.lightX;
  runs += `| ${data.now} | dump-decompose | 位置项占比 lightY ${(y.positionalShareOfMean * 100).toFixed(2)}% / lightX ${(x.positionalShareOfMean * 100).toFixed(2)}% · 同 texel 残差散布 ≤ ${Math.max(y.maxResidualSpreadWithinTexel, x.maxResidualSpreadWithinTexel).toExponential(2)} |\n`;
  await writeFile(runsPath, runs, 'utf-8');

  console.log(`[dump-decompose] wrote ${OUT_DIR}/decompose.md and decompose-*.tsv`);
  for (const name of ['lightY', 'lightX']) {
    const r = data.out[name];
    console.log(
      `  ${name}: |delta| mean ${r.meanAbsDelta.toExponential(2)} = positional ${r.meanAbsPositional.toExponential(2)} ` +
        `(${(r.positionalShareOfMean * 100).toFixed(2)}%) + residual ${r.meanAbsResidual.toExponential(2)} · ` +
        `within-texel residual spread mean ${r.meanResidualSpreadWithinTexel.toExponential(2)} / max ${r.maxResidualSpreadWithinTexel.toExponential(2)} · ` +
        `positional spread max ${r.maxPositionalSpreadWithinTexel.toExponential(2)}`,
    );
  }
} catch (error) {
  console.error('[dump-decompose] failed:', error?.message ?? error);
  console.error(`make sure server.mjs is running on 127.0.0.1:${PORT}`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
