// Exports the current imaging state as files under out/:
//   summary.md, locator.md, plane-locate.{md,tsv}, texel-*.{md,tsv}, runs.md
//
// Usage: node dump-table.mjs [--port 8773] [--out ./out] [--md-rows 200]
// Requires a running server.mjs and a Playwright Chromium (see README).

// ---------------------------------------------------------------------------
//
//   node dump-table.mjs                 # 默认读 http://127.0.0.1:8773/
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
const MD_ROW_LIMIT = Number(argOf('md-rows', 200));

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

const fmt = (value, digits = 6) => (value === null || value === undefined ? '-' : Number(value).toFixed(digits));

function markdownTable(rows) {
  const header = '| light texel | z in light NDC | cam 片元 z | #frag | camera 屏幕位置 |';
  const divider = '| --- | --- | --- | --- | --- |';
  const body = rows.map((row) => {
    const shown = row.locations.slice(0, 6).map((f) => `(${f.cameraPx},${f.cameraPy})`);
    const extra = row.count > shown.length ? ` +${row.count - shown.length}` : '';
    const zRange = row.count === 1 ? fmt(row.zMin) : `${fmt(row.zMin)}~${fmt(row.zMax)}`;
    return `| (${row.tx}, ${row.ty}) | ${fmt(row.storedZ)} | ${zRange} | ${row.count} | ${shown.join(' ')}${extra} |`;
  });
  return [header, divider, ...body].join('\n');
}

function tsvOf(records) {
  const header = ['light_texel_u', 'light_texel_v', 'light_u_float', 'light_v_float', 'z_in_light_NDC', 'camera_px', 'camera_py'];
  const lines = records.map((r) =>
    [r.tx, r.ty, r.u.toFixed(4), r.v.toFixed(4), r.zNdc.toFixed(8), r.cameraPx, r.cameraPy].join('\t'),
  );
  return [header.join('\t'), ...lines].join('\n');
}

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});

try {
  const page = await browser.newPage({ viewport: { width: 1560, height: 900 } });
  const url = `http://127.0.0.1:${PORT}/`;
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ENGINE_READY__ !== undefined, null, { timeout: 25000 });
  await page.evaluate(() => window.__ENGINE_READY__);

  const data = await page.evaluate(() => {
    const engine = window.__ENGINE__;
    const { renderer, state, buildAggregate, passes, stats } = engine;

    const aggregateOf = (lightView) => {
      const built = buildAggregate(lightView);
      return { summary: built.summary, rows: built.rows, records: built.records };
    };

    const [a, b, c] = [
      [-0.95, -0.62, 0.0],
      [0.95, -0.62, -0.35],
      [0.05, 0.92, 0.3],
    ];
    const centroid = [0, 1, 2].map((i) => (a[i] + b[i] + c[i]) / 3);
    const locateRows = engine.computeLocate(centroid);

    return {
      url: location.href,
      port: window.__MESH_NON_MATCHING__?.port ?? null,
      shownPass: state.shownPass,
      angles: state.angles,
      eyes: {
        camera: renderer.getView('camera').eye,
        lightX: renderer.getView('lightX').eye,
        lightY: renderer.getView('lightY').eye,
      },
      passList: passes.map((pass, index) => ({
        index,
        name: pass.name,
        kind: pass.kind,
        view: pass.view,
        lightView: pass.lightView,
        grid: pass.grid,
        probePair: pass.probePair,
        hasPort: pass.hasPort ?? null,
      })),
      stats: stats.map((s) => ({ index: s.index, kind: s.kind, view: s.view, lightView: s.lightView, grid: s.grid, depthRange: s.depthRange })),
      lightY: aggregateOf('lightY'),
      lightX: aggregateOf('lightX'),
      locate: { point: centroid, rows: locateRows },
      planeGrid: (() => {
        const frame = engine.triangleFrame;
        const vMax = Math.max(
          frame.toPlane(frame.b).v,
          frame.toPlane(frame.c).v,
          0,
        );
        const vMin = Math.min(frame.toPlane(frame.b).v, frame.toPlane(frame.c).v, 0);
        const steps = 15;
        const entries = [];
        for (let i = 0; i <= steps; i++) {
          for (let j = 0; j <= steps; j++) {
            const u = (i / steps) * frame.edgeLength;
            const v = vMin + (j / steps) * (vMax - vMin);
            const world = frame.fromPlane(u, v);
            if (!frame.contains(world)) continue;
            const rows = engine.computeLocate(world);
            if (!rows.some((r) => r.covered)) continue;
            entries.push({ u, v, world, rows });
          }
        }
        return { steps, vMin, vMax, edgeLength: frame.edgeLength, entries };
      })(),
      now: new Date().toISOString(),
    };
  });

  await mkdir(OUT_DIR, { recursive: true });

  const summaryLines = [
    `# mesh_non_matching · 当前状态导出`,
    '',
    `- 时间: ${data.now}`,
    `- 页面: ${data.url} (port ${data.port}, 展示 pass #${data.shownPass})`,
    `- 旋转角: 绕 X ${data.angles.x}° / 绕 Y ${data.angles.y}°`,
    `- eye: camera [${data.eyes.camera.map((v) => v.toFixed(4)).join(', ')}] · ` +
      `lightX [${data.eyes.lightX.map((v) => v.toFixed(4)).join(', ')}] · ` +
      `lightY [${data.eyes.lightY.map((v) => v.toFixed(4)).join(', ')}]`,
    '',
    `## pass`,
    '',
    '| # | kind | 光栅化视角 | lightMVP 视角 | grid | 输出区间 |',
    '| --- | --- | --- | --- | --- | --- |',
    ...data.stats.map(
      (s) => `| ${s.index} | ${s.kind} | ${s.view} | ${s.lightView} | ${s.grid.width}×${s.grid.height} | ${s.depthRange.join('–')} |`,
    ),
    '',
    `## 同 texel 汇总 (camera 中心 32×32 像素)`,
    '',
    '| light 空间 | 采样 fragment | 落进 light 网格 | 覆盖 texel | 多 fragment 的 texel | 最多 /texel | 同 texel 内 z 散布最大 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...[data.lightY, data.lightX].map((item) => {
      const s = item.summary;
      return `| ${s.lightView} | ${s.sampledFragments} | ${s.sampledFragments - s.outsideLight} | ${s.texels} | ${s.multiTexels} | ${s.maxFragments} | ${s.maxSpread.toExponential(2)} NDC |`;
    }),
    '',
    `## 定位读数 (重心 [${data.locate.point.map((v) => v.toFixed(4)).join(', ')}])`,
    '',
    '| pass | kind | 像素 float | 覆盖 | 读回 | 解析 | 差 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...data.locate.rows.map(
      (r) =>
        `| ${r.short} | ${r.kind} | ${Number.isFinite(r.px) ? `(${r.px.toFixed(3)}, ${r.py.toFixed(3)})` : '—'} | ` +
        `${r.covered ? '有' : r.inside ? '无 fragment' : '网格外'} | ${fmt(r.value)} | ${fmt(r.analytic)} | ` +
        `${r.value === null || r.analytic === null ? '—' : fmt(r.value - r.analytic)} |`,
    ),
    '',
    `> 读回取的是最近像素中心，解析是输入点本身，差 ≈ 该处梯度 × 亚像素取整位移（详见 README「为什么 读回 和 解析 会差」）。`,
    '',
  ];

  await writeFile(path.join(OUT_DIR, 'summary.md'), summaryLines.join('\n'), 'utf-8');

  for (const [name, item] of [['lightY', data.lightY], ['lightX', data.lightX]]) {
    const rowsForMd = item.rows.slice(0, MD_ROW_LIMIT);
    const md = [
      `# 同 texel 总表 · light 空间 ${name} (角度 ${name === 'lightX' ? data.angles.x : data.angles.y}°)`,
      '',
      `- camera 采样窗口: x ${item.summary.window.startX}–${item.summary.window.startX + item.summary.window.size - 1}, ` +
        `y ${item.summary.window.startY}–${item.summary.window.startY + item.summary.window.size - 1} (${item.summary.window.size}×${item.summary.window.size})`,
      `- 采样 fragment: ${item.summary.sampledFragments} · 落进 light 网格: ${item.summary.sampledFragments - item.summary.outsideLight}`,
      `- 覆盖 texel: ${item.summary.texels} · 多 fragment 的 texel: ${item.summary.multiTexels} · 最多 ${item.summary.maxFragments} 个/texel`,
      `- 同 texel 内 z 散布最大: ${item.summary.maxSpread.toExponential(3)} NDC`,
      '',
      '`z in light NDC` 是该 texel 在 light pass 里存下的值；`cam 片元 z` 是落进来的 camera fragment 自己的 light-NDC z；',
      '`camera 屏幕位置` 是这些 fragment 在 camera 屏幕上的像素坐标（完整列表见同名 .tsv）。',
      '',
      markdownTable(rowsForMd),
      '',
      item.rows.length > rowsForMd.length
        ? `> 只列了前 ${rowsForMd.length} 行（共 ${item.rows.length} 行）；完整逐 fragment 记录见 \`texel-${name}.tsv\`。`
        : `> 共 ${item.rows.length} 行，已全部列出。`,
      '',
    ].join('\n');

    await writeFile(path.join(OUT_DIR, `texel-${name}.md`), md, 'utf-8');
    await writeFile(path.join(OUT_DIR, `texel-${name}.tsv`), tsvOf(item.records), 'utf-8');
  }

  const plane = data.planeGrid;
  const planeMd = [
    '# 平面坐标 (u, v) → 像素定位表',
    '',
    `- 平面基: 原点 = v0, u 轴 = v0→v1（长度 ${plane.edgeLength.toFixed(4)}）, v 轴 = n × u`,
    `- 采样: u ∈ [0, ${plane.edgeLength.toFixed(4)}], v ∈ [${plane.vMin.toFixed(4)}, ${plane.vMax.toFixed(4)}]，${plane.steps}×${plane.steps} 网格`,
    `- 保留条件: 落在三角形内 **且** 至少在一个 pass 上有 fragment`,
    `- 保留的点: ${plane.entries.length}（每点 × 6 趟 pass = 表里 ${plane.entries.length * (plane.entries[0]?.rows.length ?? 0)} 行）`,
    '',
    '| u | v | 世界坐标 | pass | 像素 float | 覆盖 | 读回 | 解析 | 差 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...plane.entries.flatMap((entry) =>
      entry.rows.map(
        (r) =>
          `| ${entry.u.toFixed(4)} | ${entry.v.toFixed(4)} | [${entry.world.map((x) => x.toFixed(3)).join(', ')}] | ${r.short} | ` +
          `${Number.isFinite(r.px) ? `(${r.px.toFixed(3)}, ${r.py.toFixed(3)})` : '—'} | ` +
          `${r.covered ? '有' : r.inside ? '无 fragment' : '网格外'} | ${fmt(r.value)} | ${fmt(r.analytic)} | ` +
          `${r.value === null || r.analytic === null ? '—' : fmt(r.value - r.analytic)} |`,
      ),
    ),
    '',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'plane-locate.md'), planeMd, 'utf-8');

  const planeHeader = ['u_plane', 'v_plane', 'world_x', 'world_y', 'world_z', 'pass', 'kind', 'pixel_x', 'pixel_y', 'covered', 'readback', 'analytic', 'diff'];
  const planeLines = plane.entries.flatMap((entry) =>
    entry.rows.map((r) =>
      [
        entry.u.toFixed(6), entry.v.toFixed(6),
        ...entry.world.map((x) => x.toFixed(8)),
        r.short, r.kind,
        Number.isFinite(r.px) ? r.px.toFixed(4) : 'nan',
        Number.isFinite(r.py) ? r.py.toFixed(4) : 'nan',
        r.covered ? 1 : 0,
        r.value === null ? 'nan' : r.value.toFixed(8),
        r.analytic === null ? 'nan' : r.analytic.toFixed(8),
        r.value === null || r.analytic === null ? 'nan' : (r.value - r.analytic).toExponential(8),
      ].join('\t'),
    ),
  );
  await writeFile(path.join(OUT_DIR, 'plane-locate.tsv'), [planeHeader.join('\t'), ...planeLines].join('\n'), 'utf-8');

  const locatorMd = [
    '# 世界坐标定位读数',
    '',
    `- 输入点(三角形重心): [${data.locate.point.map((v) => v.toFixed(6)).join(', ')}]`,
    '',
    '| pass | kind | 像素 float | 覆盖 | 读回 | 解析 | 差 |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...data.locate.rows.map(
      (r) =>
        `| ${r.short} | ${r.kind} | ${Number.isFinite(r.px) ? `(${r.px.toFixed(3)}, ${r.py.toFixed(3)})` : '—'} | ` +
        `${r.covered ? `有 (${r.intPx[0]}, ${r.intPx[1]})` : r.inside ? '无 fragment' : '网格外'} | ${fmt(r.value)} | ${fmt(r.analytic)} | ` +
        `${r.value === null || r.analytic === null ? '—' : fmt(r.value - r.analytic)} |`,
    ),
    '',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'locator.md'), locatorMd, 'utf-8');

  const runsPath = path.join(OUT_DIR, 'runs.md');
  let runs = '# dump-table 运行历史\n\n| 时间 | pass | 绕X / 绕Y | lightY texel / 多frag / 最多 | lightX texel / 多frag / 最多 |\n| --- | --- | --- | --- | --- |\n';
  try {
    const { readFile } = await import('node:fs/promises');
    const existing = await readFile(runsPath, 'utf-8');
    runs = existing.includes('| 时间 |') ? existing : runs;
  } catch {
  }
  runs += `| ${data.now} | #${data.shownPass} | ${data.angles.x}° / ${data.angles.y}° | ` +
    `${data.lightY.summary.texels} / ${data.lightY.summary.multiTexels} / ${data.lightY.summary.maxFragments} | ` +
    `${data.lightX.summary.texels} / ${data.lightX.summary.multiTexels} / ${data.lightX.summary.maxFragments} |\n`;
  await writeFile(runsPath, runs, 'utf-8');

  console.log(`[dump-table] wrote ${OUT_DIR}`);
  for (const name of ['summary.md', 'locator.md', 'plane-locate.md', 'plane-locate.tsv', 'texel-lightY.md', 'texel-lightY.tsv', 'texel-lightX.md', 'texel-lightX.tsv', 'runs.md']) {
    console.log(`  - ${name}`);
  }
  console.log('');
  console.log(`[dump-table] lightY: ${data.lightY.summary.texels} texel / ${data.lightY.summary.multiTexels} 个多 fragment / 最多 ${data.lightY.summary.maxFragments} 个`);
  console.log(`[dump-table] lightX: ${data.lightX.summary.texels} texel / ${data.lightX.summary.multiTexels} 个多 fragment / 最多 ${data.lightX.summary.maxFragments} 个`);
} catch (error) {
  console.error('[dump-table] failed:', error?.message ?? error);
  console.error(`make sure server.mjs is running on 127.0.0.1:${PORT} (node server.mjs)`);
  process.exitCode = 1;
} finally {
  await browser.close();
}
