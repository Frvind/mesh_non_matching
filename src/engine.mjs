// Engine - boots the context, renders one static frame per pass, and drives the
// read-only tools: a coordinate locator (world XYZ or plane UV) and the
// per-texel aggregate table.
//
// main() is async and is activated through activate(); failures are re-thrown so
// they surface instead of dying as an unhandled rejection.

// ---------------------------------------------------------------------------
// engine.mjs - Engine
//
//
//
//
// ---------------------------------------------------------------------------

import { MeshRender } from './mesh-render.mjs';
import { WebGLRenderer } from './webgl-renderer.mjs';
import { unpackWorldDepth, packingResolution } from './depth-codec.mjs';
import {
  lightLinearDepthFromNdcZ,
  ndcZToDepth01,
  projectToGrid,
  reconstructWorldPoint,
  reconstructWorldPointFromLightZ,
  rotateEyeAboutAxis,
} from './camera.mjs';
import { transformPoint4 } from './mat4.mjs';
import {
  AGGREGATE_PARAMS,
  CLEAR_COLOR,
  MESH_INSTANCES,
  PASS_PARAMS,
  PROJECTION_PARAMS,
  ROTATION_DEFAULTS,
  TRIANGLE_MESH,
  VIEWS,
  depthRangeForKind,
} from './mesh-params.mjs';

const DEFAULT_CONFIG = { passIndex: 0, port: null, mode: 'pass', passCount: PASS_PARAMS.length };

const KIND_LABELS = {
  worldDepth: '世界坐标深度 (世界单位)',
  lightZ: 'lightMVP 后的 z (NDC)',
};

function readConfig() {
  return { ...DEFAULT_CONFIG, ...(globalThis.__MESH_NON_MATCHING__ ?? {}) };
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function showError(error) {
  const box = document.getElementById('error');
  if (box) {
    box.hidden = false;
    box.textContent = `引擎异常: ${error?.message ?? error}\n${error?.stack ?? ''}`;
  }
  document.body.dataset.engineState = 'error';
}

function createContext(canvas) {
  const attributes = {
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
  };
  const gl =
    canvas.getContext('webgl2', attributes) ??
    canvas.getContext('webgl', attributes) ??
    canvas.getContext('experimental-webgl', attributes);
  if (!gl) throw new Error('WebGL is not available in this browser/environment');
  return gl;
}

function sizeCanvas(canvas) {
  const dpr = Math.min(globalThis.devicePixelRatio ?? 1, 2);
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round((rect.width || 960) * dpr));
  const height = Math.max(1, Math.round((rect.height || 720) * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height };
}

function createScene(gl) {
  return MESH_INSTANCES.map((instance, index) =>
    new MeshRender(gl, {
      ...TRIANGLE_MESH,
      label: instance.label,
      shader: PASS_PARAMS[index].kind,
      instanceKey: instance.key,
    }),
  );
}

function buildPassCache(renderer, index) {
  const frame = renderer.getPassFrame(index);
  const pixels = renderer.readPassPixels(index);
  const { width, height } = frame.grid;
  const values = new Float32Array(width * height).fill(Number.NaN);
  const coverage = new Uint8Array(width * height);
  const range = depthRangeForKind(frame.kind);

  for (let i = 0, p = 0; i < values.length; i++, p += 4) {
    const alpha = pixels[p + 3];
    coverage[i] = alpha > 0 ? 1 : 0;
    if (coverage[i]) values[i] = unpackWorldDepth([pixels[p], pixels[p + 1], pixels[p + 2], alpha], range);
  }

  return { index, kind: frame.kind, width, height, pixels, values, coverage, range };
}

function findCoveredPixel(cache, px, py, radius = 3) {
  const cx = Math.round(px);
  const cy = Math.round(py);
  const inBounds = (x, y) => x >= 0 && y >= 0 && x < cache.width && y < cache.height;

  if (inBounds(cx, cy) && cache.coverage[cy * cache.width + cx]) {
    return { x: cx, y: cy, index: cy * cache.width + cx };
  }
  for (let r = 1; r <= radius; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = cx + dx;
        const y = cy + dy;
        if (!inBounds(x, y)) continue;
        const index = y * cache.width + x;
        if (cache.coverage[index]) return { x, y, index };
      }
    }
  }
  return null;
}

function drawPreview(canvas, cache, markers) {
  if (!canvas || !cache) return;
  const ctx = canvas.getContext('2d');
  const { width, height, values, coverage, range } = cache;

  const source = document.createElement('canvas');
  source.width = width;
  source.height = height;
  const sourceCtx = source.getContext('2d');
  const image = sourceCtx.createImageData(width, height);
  const span = range[1] - range[0];

  for (let i = 0; i < values.length; i++) {
    const p = i * 4;
    if (!coverage[i]) {
      image.data[p] = 12;
      image.data[p + 1] = 14;
      image.data[p + 2] = 18;
      image.data[p + 3] = 255;
      continue;
    }
    const t = Math.min(1, Math.max(0, (values[i] - range[0]) / span));
    const v = Math.round(20 + t * 235);
    image.data[p] = v;
    image.data[p + 1] = v;
    image.data[p + 2] = v;
    image.data[p + 3] = 255;
  }
  sourceCtx.putImageData(image, 0, 0);

  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  for (const marker of markers) {
    if (!marker || !Number.isFinite(marker.px) || !Number.isFinite(marker.py)) continue;
    const x = ((marker.px + 0.5) / width) * canvas.width;
    const y = (1 - (marker.py + 0.5) / height) * canvas.height;
    const inGrid = marker.px >= -0.5 && marker.py >= -0.5 && marker.px <= width - 0.5 && marker.py <= height - 0.5;

    ctx.strokeStyle = inGrid ? marker.color : 'rgba(255, 140, 140, 0.85)';
    ctx.lineWidth = 1.5;
    const arm = 7;
    ctx.beginPath();
    ctx.moveTo(x - arm, y);
    ctx.lineTo(x + arm, y);
    ctx.moveTo(x, y - arm);
    ctx.lineTo(x, y + arm);
    ctx.stroke();
    if (!inGrid) {
      ctx.strokeStyle = 'rgba(255, 140, 140, 0.85)';
      ctx.strokeRect(x - 5, y - 5, 10, 10);
    }
  }
}

function lightZOfWorldPoint(world, frame) {
  const clip = transformPoint4(frame.lightViewProj, world);
  if (clip[3] <= 1e-9) return null;
  return clip[2] / clip[3];
}

async function main() {
  const config = readConfig();
  const canvas = document.getElementById('viewport');
  if (!canvas) throw new Error('#viewport canvas not found in the page');

  document.body.dataset.engineState = 'booting';
  document.body.dataset.mode = config.mode ?? 'pass';

  const gl = createContext(canvas);
  sizeCanvas(canvas);

  const meshes = createScene(gl);
  const passes = PASS_PARAMS.map((pass) => ({ ...pass, grid: { ...pass.grid } }));

  const renderer = new WebGLRenderer(gl, {
    meshes,
    passes,
    views: VIEWS,
    projection: PROJECTION_PARAMS,
    clearColor: CLEAR_COLOR,
  });
  await renderer.init();

  const state = {
    shownPass: Math.min(Math.max(config.passIndex, 0), passes.length - 1),
    angles: { ...ROTATION_DEFAULTS },
    pinnedPixel: null,
    caches: [],
    lastProbe: null,
  };

  const previews = [
    { canvas: document.getElementById('preview-a'), caption: document.getElementById('caption-a') },
    { canvas: document.getElementById('preview-b'), caption: document.getElementById('caption-b') },
  ];
  const markerEl = document.getElementById('probe-marker');
  const baseEyes = {
    lightX: [...VIEWS.lightX.eye],
    lightY: [...VIEWS.lightY.eye],
  };

  setText('hud-port', config.port ? `http://127.0.0.1:${config.port}` : '未知端口');
  setText(
    'hud-range',
    `worldDepth ${depthRangeForKind('worldDepth').join('–')} 世界单位 · lightZ ${depthRangeForKind('lightZ').join('–')} NDC · 打包分辨率 ${packingResolution(depthRangeForKind('lightZ')).toExponential(2)}`,
  );

  const axisOfShownPass = () => {
    const lightView = passes[state.shownPass].lightView ?? 'lightY';
    return lightView === 'lightX' ? 'x' : 'y';
  };

  const applyRotation = (axis, deg) => {
    const viewName = axis === 'x' ? 'lightX' : 'lightY';
    state.angles[axis] = deg;
    renderer.updateViewEye(viewName, rotateEyeAboutAxis(baseEyes[viewName], axis, deg));
    if (axisOfShownPass() === axis) setText('angle-value', `${deg.toFixed(0)}°`);
  };

  const syncAngleUi = () => {
    const axis = axisOfShownPass();
    const slider = document.getElementById('angle-slider');
    if (slider) slider.value = String(state.angles[axis]);
    setText('angle-value', `${state.angles[axis].toFixed(0)}°`);
    setText('angle-axis', `绕 ${axis.toUpperCase()} 轴`);
  };

  applyRotation('x', state.angles.x);
  applyRotation('y', state.angles.y);
  syncAngleUi();

  const probeAtTargetPixel = (px, py) => {
    const shown = state.shownPass;
    const pairIndex = passes[shown].probePair ?? (shown === 0 ? 1 : 0);
    const shownCache = state.caches[shown];
    const pairCache = state.caches[pairIndex];
    const frame = renderer.getPassFrame(shown);
    const pairFrame = renderer.getPassFrame(pairIndex);

    const found = findCoveredPixel(shownCache, px, py);
    if (!found) return { ok: false, px, py };

    const value = shownCache.values[found.index];
    const world =
      frame.kind === 'worldDepth'
        ? reconstructWorldPoint({ px: found.x, py: found.y }, value, frame)
        : reconstructWorldPointFromLightZ({ px: found.x, py: found.y }, value, frame);

    const mapped = projectToGrid(world, pairFrame);

    let pairValue = null;
    let pairCovered = false;
    if (mapped.inside) {
      const ox = Math.round(mapped.px);
      const oy = Math.round(mapped.py);
      if (ox >= 0 && oy >= 0 && ox < pairCache.width && oy < pairCache.height) {
        const oidx = oy * pairCache.width + ox;
        pairCovered = pairCache.coverage[oidx] === 1;
        if (pairCovered) pairValue = pairCache.values[oidx];
      }
    }

    const lightZ = lightZOfWorldPoint(world, frame);

    return {
      ok: true,
      shown,
      pairIndex,
      aPx: found.x,
      aPy: found.y,
      value,
      kind: frame.kind,
      world,
      lightZ,
      mappedPx: mapped.px,
      mappedPy: mapped.py,
      mappedInside: mapped.inside,
      pairCovered,
      pairValue,
      pairKind: pairFrame.kind,
      delta: pairValue === null ? null : pairValue - value,
      frame,
    };
  };

  const unitOf = (kind) => (kind === 'lightZ' ? 'NDC z' : '世界单位');

  const describeProbe = (probe) => {
    const shownGrid = renderer.getPassFrame(probe.shown).grid;
    const pairGrid = renderer.getPassFrame(probe.pairIndex).grid;

    setText('probe-a', `(${probe.aPx}, ${probe.aPy}) / ${shownGrid.width}×${shownGrid.height}`);
    setText('probe-value', `${probe.value.toFixed(6)} ${unitOf(probe.kind)}`);
    setText('probe-world', `[${probe.world.map((v) => v.toFixed(3)).join(', ')}]`);
    setText(
      'probe-light-z',
      probe.lightZ === null
        ? '光源背后, 无意义'
        : `${probe.lightZ.toFixed(6)} NDC (${probe.frame.lightView}) · depth01 ${ndcZToDepth01(probe.lightZ).toFixed(6)} · light 线性深度 ${lightLinearDepthFromNdcZ(probe.lightZ, probe.frame.lightProj).toFixed(4)}`,
    );
    setText(
      'probe-b',
      Number.isFinite(probe.mappedPx)
        ? `(${probe.mappedPx.toFixed(2)}, ${probe.mappedPy.toFixed(2)}) / ${pairGrid.width}×${pairGrid.height}${probe.mappedInside ? '' : ' · 落在网格外'}`
        : '无法投影',
    );
    setText(
      'probe-value-b',
      probe.pairValue === null
        ? (probe.mappedInside ? '该像素没有 fragment' : '—')
        : `${probe.pairValue.toFixed(6)} ${unitOf(probe.pairKind)}`,
    );
    setText(
      'probe-delta',
      probe.delta === null ? '—' : `${probe.delta >= 0 ? '+' : ''}${probe.delta.toFixed(6)} ${unitOf(probe.pairKind)}`,
    );
    setText(
      'probe-note',
      probe.delta === null
        ? '同一个世界点在配对 pass 的落点上没有 fragment —— 覆盖层面的 non-matching。'
        : `同一个世界点: 本帧 ${probe.value.toFixed(6)}, 配对 pass 落点处 ${probe.pairValue.toFixed(6)}.`,
    );

    if (previews[0].caption) previews[0].caption.textContent = `#${probe.shown} ${KIND_LABELS[probe.kind]}`;
    if (previews[1].caption) previews[1].caption.textContent = `#${probe.pairIndex} ${KIND_LABELS[probe.pairKind]}`;
    drawPreview(previews[0].canvas, state.caches[probe.shown], [
      { px: probe.aPx, py: probe.aPy, color: '#57d8ff' },
    ]);
    drawPreview(previews[1].canvas, state.caches[probe.pairIndex], [
      { px: probe.mappedPx, py: probe.mappedPy, color: '#ffd166' },
    ]);

    if (markerEl) {
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const p = renderer.targetToCanvas(probe.aPx, probe.aPy, probe.shown);
      markerEl.hidden = false;
      markerEl.style.left = `${p.x / dpr}px`;
      markerEl.style.top = `${p.y / dpr}px`;
    }
  };

  const clearProbe = () => {
    if (markerEl) markerEl.hidden = true;
    for (const id of ['probe-a', 'probe-value', 'probe-world', 'probe-light-z', 'probe-b', 'probe-value-b', 'probe-delta']) {
      setText(id, '-');
    }
    setText('probe-note', '把鼠标移到画面上；点击可以锁定一个点。');

    const shown = state.shownPass;
    const pairIndex = passes[shown].probePair ?? 0;
    if (state.caches.length) {
      if (previews[0].caption) previews[0].caption.textContent = `#${shown} ${KIND_LABELS[state.caches[shown].kind]}`;
      if (previews[1].caption) previews[1].caption.textContent = `#${pairIndex} ${KIND_LABELS[state.caches[pairIndex].kind]}`;
      drawPreview(previews[0].canvas, state.caches[shown], []);
      drawPreview(previews[1].canvas, state.caches[pairIndex], []);
    }
  };

  const runProbe = (deviceX, deviceY) => {
    const { px, py } = renderer.canvasToTarget(deviceX, deviceY, state.shownPass);
    return probeAtTargetPixel(px, py);
  };

  const refresh = async () => {
    sizeCanvas(canvas);
    const stats = await renderer.renderAllPasses();
    await renderer.present(state.shownPass);

    state.caches = stats.map((_, index) => buildPassCache(renderer, index));

    const shown = stats[state.shownPass];
    setText('hud-pass', `${shown.name} (pass #${state.shownPass})`);
    setText('hud-kind', `${KIND_LABELS[shown.kind]} · 打包区间 ${shown.depthRange.join('–')}`);
    setText('hud-grid', `${shown.grid.width} × ${shown.grid.height}`);

    const eyeOf = (viewName) => {
      const stat = stats.find((s) => s.view === viewName) ?? stats.find((s) => s.lightView === viewName);
      return stat ? `[${stat.eye.map((v) => v.toFixed(2)).join(', ')}]` : '-';
    };
    setText('hud-eye-light-x', eyeOf('lightX'));
    setText('hud-eye-light-y', eyeOf('lightY'));
    setText('hud-eye-camera', eyeOf('camera'));
    const axis = axisOfShownPass();
    const baseEye = VIEWS.lightY.eye;
    setText(
      'hud-view-mode',
      `本页那趟用 绕 ${axis.toUpperCase()} 轴的 light 视角 (当前 ${state.angles[axis].toFixed(0)}°) · ` +
        `light 基准 eye [${baseEye.map((v) => v.toFixed(2)).join(', ')}] · 绕 X ${state.angles.x.toFixed(0)}° / 绕 Y ${state.angles.y.toFixed(0)}° · viewport 都是 180×180`,
    );
    syncAngleUi();

    document.body.dataset.engineState = 'ready';

    if (state.pinnedPixel) {
      const probe = probeAtTargetPixel(state.pinnedPixel.px, state.pinnedPixel.py);
      if (probe.ok) {
        state.lastProbe = probe;
        describeProbe(probe);
      } else {
        clearProbe();
      }
    } else if (state.lastProbe) {
      describeProbe(state.lastProbe);
    } else {
      clearProbe();
    }

    if (document.getElementById('locate-body')) describeLocate();
    if (document.getElementById('agg-body')) describeAggregate();

    if (globalThis.__ENGINE__) globalThis.__ENGINE__.stats = stats;
    return stats;
  };

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

  const triangle = (() => {
    const [a, b, c] = TRIANGLE_MESH.positions;
    const e1 = sub(b, a);
    const e2 = sub(c, a);
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const len = Math.hypot(...n);
    const normal = n.map((v) => v / len);

    const e1len = Math.hypot(...e1) || 1;
    const eU = e1.map((v) => v / e1len);
    const eVraw = [
      normal[1] * eU[2] - normal[2] * eU[1],
      normal[2] * eU[0] - normal[0] * eU[2],
      normal[0] * eU[1] - normal[1] * eU[0],
    ];
    const eVlen = Math.hypot(...eVraw) || 1;
    const eV = eVraw.map((v) => v / eVlen);

    return {
      a, b, c, normal, eU, eV,
      edgeLength: e1len,
      distance: (p) => dot3(sub(p, a), normal),
      toPlane: (p) => {
        const d = sub(p, a);
        return { u: dot3(d, eU), v: dot3(d, eV) };
      },
      fromPlane: (u, v) => [
        a[0] + eU[0] * u + eV[0] * v,
        a[1] + eU[1] * u + eV[1] * v,
        a[2] + eU[2] * u + eV[2] * v,
      ],
      barycentric: (p) => {
        const v0 = sub(b, a);
        const v1 = sub(c, a);
        const v2 = sub(p, a);
        const d00 = dot3(v0, v0);
        const d01 = dot3(v0, v1);
        const d11 = dot3(v1, v1);
        const d20 = dot3(v2, v0);
        const d21 = dot3(v2, v1);
        const denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-12) return [1, 0, 0];
        const l1 = (d11 * d20 - d01 * d21) / denom;
        const l2 = (d00 * d21 - d01 * d20) / denom;
        return [1 - l1 - l2, l1, l2];
      },
      contains: (p) => {
        const v0 = sub(b, a);
        const v1 = sub(c, a);
        const v2 = sub(p, a);
        const d00 = dot3(v0, v0);
        const d01 = dot3(v0, v1);
        const d11 = dot3(v1, v1);
        const d20 = dot3(v2, v0);
        const d21 = dot3(v2, v1);
        const denom = d00 * d11 - d01 * d01;
        if (Math.abs(denom) < 1e-12) return false;
        const v = (d11 * d20 - d01 * d21) / denom;
        const w = (d00 * d21 - d01 * d20) / denom;
        const u = 1 - v - w;
        return u >= -1e-6 && v >= -1e-6 && w >= -1e-6;
      },
    };
  })();

  const locateState = {
    point: [0.0167, -0.1067, -0.0167],
    mode: 'world',
  };

  const computeLocate = (point) => {
    return passes.map((pass, index) => {
      const frame = renderer.getPassFrame(index);
      const cache = state.caches[index];
      const projected = projectToGrid(point, frame);

      let intPx = null;
      let covered = false;
      let value = null;
      if (Number.isFinite(projected.px) && cache) {
        const ox = Math.round(projected.px);
        const oy = Math.round(projected.py);
        if (ox >= 0 && oy >= 0 && ox < cache.width && oy < cache.height) {
          intPx = [ox, oy];
          const idx = oy * cache.width + ox;
          covered = cache.coverage[idx] === 1;
          if (covered) value = cache.values[idx];
        }
      }

      let analytic = null;
      if (frame.kind === 'worldDepth') {
        analytic = dot3(sub(point, frame.eye), frame.forward);
      } else {
        const clip = transformPoint4(frame.lightViewProj, point);
        analytic = clip[3] > 1e-9 ? clip[2] / clip[3] : null;
      }

      return {
        index,
        name: pass.name,
        short: pass.short,
        kind: frame.kind,
        view: frame.viewRole,
        lightView: frame.lightView,
        px: projected.px,
        py: projected.py,
        inside: projected.inside,
        behind: projected.behind,
        intPx,
        covered,
        value,
        analytic,
      };
    });
  };

  const describeLocate = () => {
    const body = document.getElementById('locate-body');
    if (!body) return;
    const point = locateState.point;
    const rows = computeLocate(point);

    body.textContent = '';
    for (const row of rows) {
      const tr = document.createElement('tr');
      if (row.index === state.shownPass) tr.className = 'is-shown';

      const cellPass = document.createElement('td');
      cellPass.textContent = row.short ?? `#${row.index}`;
      cellPass.title = row.name;

      const cellPx = document.createElement('td');
      cellPx.textContent = Number.isFinite(row.px) ? `(${row.px.toFixed(3)}, ${row.py.toFixed(3)})` : '—';
      if (!row.inside) cellPx.classList.add('miss');

      const cellCovered = document.createElement('td');
      cellCovered.textContent = row.covered ? `有 (${row.intPx[0]}, ${row.intPx[1]})` : (row.inside ? '无 fragment' : '网格外');
      if (!row.covered) cellCovered.classList.add('miss');

      const cellValue = document.createElement('td');
      cellValue.textContent = row.value === null ? '—' : row.value.toFixed(6);

      const cellAnalytic = document.createElement('td');
      cellAnalytic.textContent = row.analytic === null ? '—' : row.analytic.toFixed(6);

      const cellDiff = document.createElement('td');
      cellDiff.textContent =
        row.value === null || row.analytic === null
          ? '—'
          : `${row.value - row.analytic >= 0 ? '+' : ''}${(row.value - row.analytic).toFixed(6)}`;

      tr.append(cellPass, cellPx, cellCovered, cellValue, cellAnalytic, cellDiff);
      body.append(tr);
    }

    const onSurface = triangle.contains(point) && Math.abs(triangle.distance(point)) < 1e-6;

    const lightZOf = (viewName) => {
      const frame = renderer.frames.find((f) => f.lightView === viewName && f.lightViewProj);
      if (!frame) return null;
      const clip = transformPoint4(frame.lightViewProj, point);
      return clip[3] > 1e-9 ? clip[2] / clip[3] : null;
    };
    const zY = lightZOf('lightY');
    const zX = lightZOf('lightX');

    const plane = triangle.toPlane(point);
    const bary = triangle.barycentric(point);

    setText(
      'locate-note',
      `平面坐标 (u,v) = (${plane.u.toFixed(6)}, ${plane.v.toFixed(6)}) · 重心 (λ0,λ1,λ2) = ` +
        `(${bary.map((v) => v.toFixed(4)).join(', ')}) · 点在三角形上: ${onSurface ? '是' : '否'} · ` +
        `到平面距离 ${triangle.distance(point).toFixed(6)} · lightMVP z: 绕 Y ${zY === null ? '背后' : zY.toFixed(6)} / 绕 X ${zX === null ? '背后' : zX.toFixed(6)}`,
    );

    const shown = state.shownPass;
    const shownRow = rows[shown];
    if (markerEl) {
      if (Number.isFinite(shownRow.px) && shownRow.inside) {
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const p = renderer.targetToCanvas(shownRow.px, shownRow.py, shown);
        markerEl.hidden = false;
        markerEl.style.left = `${p.x / dpr}px`;
        markerEl.style.top = `${p.y / dpr}px`;
      } else {
        markerEl.hidden = true;
      }
    }

    const pairIndex = passes[shown].probePair ?? 0;
    if (state.caches.length) {
      drawPreview(previews[0].canvas, state.caches[shown], [
        { px: shownRow.px, py: shownRow.py, color: '#57d8ff' },
      ]);
      drawPreview(previews[1].canvas, state.caches[pairIndex], [
        { px: rows[pairIndex].px, py: rows[pairIndex].py, color: '#ffd166' },
      ]);
    }

    state.lastLocate = rows;
    return rows;
  };

  const locateInputs = ['locate-x', 'locate-y', 'locate-z'].map((id) => document.getElementById(id));
  const planeInputs = ['locate-u', 'locate-v'].map((id) => document.getElementById(id));
  const locateForm = document.getElementById('locate-form');

  const syncLocateInputs = (point) => {
    locateInputs.forEach((element, axis) => {
      if (element) element.value = String(Number(point[axis].toFixed(6)));
    });
    const plane = triangle.toPlane(point);
    if (planeInputs[0]) planeInputs[0].value = String(Number(plane.u.toFixed(6)));
    if (planeInputs[1]) planeInputs[1].value = String(Number(plane.v.toFixed(6)));
  };

  const setLocateMode = (mode) => {
    locateState.mode = mode;
    for (const button of document.querySelectorAll('#locate-mode-buttons button')) {
      button.classList.toggle('is-active', button.dataset.mode === mode);
    }
    for (const element of locateInputs) if (element) element.disabled = mode !== 'world';
    for (const element of planeInputs) if (element) element.disabled = mode !== 'plane';
    for (const group of document.querySelectorAll('#locate-form .coord-group')) {
      group.classList.toggle('is-active', group.dataset.mode === mode);
    }
    setText('locate-mode-hint', mode === 'plane'
      ? `平面坐标: 原点 = v0, u 轴 = v0→v1 (长度 ${triangle.edgeLength.toFixed(4)}), v 轴 = n × u`
      : '世界坐标: 直接输 x / y / z');
  };

  const readLocateInputs = () => {
    let point;
    if (locateState.mode === 'plane') {
      const u = Number(planeInputs[0]?.value) || 0;
      const v = Number(planeInputs[1]?.value) || 0;
      point = triangle.fromPlane(u, v);
    } else {
      point = locateInputs.map((element) => (element ? Number(element.value) || 0 : 0));
    }
    locateState.point = point;
    syncLocateInputs(point);
    return point;
  };

  const applyLocatedPoint = (point) => {
    locateState.point = [...point];
    syncLocateInputs(point);
    return describeLocate();
  };

  if (locateForm) {
    locateForm.addEventListener('submit', (event) => {
      event.preventDefault();
      readLocateInputs();
      describeLocate();
    });
  }
  for (const element of [...locateInputs, ...planeInputs]) {
    element?.addEventListener('input', () => {
      readLocateInputs();
      describeLocate();
    });
  }
  for (const button of document.querySelectorAll('#locate-mode-buttons button')) {
    button.addEventListener('click', () => {
      setLocateMode(button.dataset.mode);
      readLocateInputs();
      describeLocate();
    });
  }
  setLocateMode(locateState.mode);
  syncLocateInputs(locateState.point);
  for (const button of document.querySelectorAll('.presets button')) {
    button.addEventListener('click', () => {
      const point = button.dataset.point.split(',').map(Number);
      applyLocatedPoint(point);
    });
  }

  if (config.mode === 'locator') {
    const panel = document.getElementById('locator');
    panel?.classList.add('is-primary');
    panel?.scrollIntoView({ block: 'nearest' });
  }

  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  const aggregateState = { lightView: 'lightY', rows: [], records: [], summary: null };

  const sampleWindow = () => {
    const grid = renderer.getPassFrame(1).grid;
    const size = Math.min(AGGREGATE_PARAMS.size, grid.width, grid.height);
    const startX = Math.floor((grid.width - size) / 2);
    const startY = Math.floor((grid.height - size) / 2);
    return { startX, startY, size, width: grid.width, height: grid.height };
  };

  const lightPassIndexOf = (lightViewName) =>
    passes.findIndex((pass) => pass.lightView === lightViewName && pass.kind === 'lightZ' && pass.view === lightViewName);

  const buildAggregate = (lightViewName) => {
    const cameraPassIndex = 1;
    const cameraFrame = renderer.getPassFrame(cameraPassIndex);
    const cameraCache = state.caches[cameraPassIndex];
    const lightPassIndex = lightPassIndexOf(lightViewName);
    const lightFrame = renderer.getPassFrame(lightPassIndex);
    const lightCache = state.caches[lightPassIndex];
    const window = sampleWindow();

    const lightW = lightFrame.grid.width;
    const lightH = lightFrame.grid.height;
    const groups = new Map();
    const records = [];
    let sampled = 0;
    let outsideLight = 0;

    for (let py = window.startY; py < window.startY + window.size; py++) {
      for (let px = window.startX; px < window.startX + window.size; px++) {
        const idx = py * cameraCache.width + px;
        if (!cameraCache.coverage[idx]) continue;
        sampled++;

        const world = reconstructWorldPoint({ px, py }, cameraCache.values[idx], cameraFrame);
        const clip = transformPoint4(lightFrame.lightViewProj, world);
        if (clip[3] <= 1e-9) {
          outsideLight++;
          continue;
        }

        const ndcX = clip[0] / clip[3];
        const ndcY = clip[1] / clip[3];
        const zNdc = clip[2] / clip[3];
        const u = (ndcX * 0.5 + 0.5) * lightW - 0.5;
        const v = (ndcY * 0.5 + 0.5) * lightH - 0.5;
        const tx = Math.round(u);
        const ty = Math.round(v);
        const inLightGrid = tx >= 0 && ty >= 0 && tx < lightW && ty < lightH && Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1 && Math.abs(zNdc) <= 1;
        if (!inLightGrid) {
          outsideLight++;
          continue;
        }

        const key = `${tx},${ty}`;
        if (!groups.has(key)) groups.set(key, { tx, ty, fragments: [] });
        groups.get(key).fragments.push({ cameraPx: px, cameraPy: py, u, v, zNdc });

        records.push({ tx, ty, u, v, zNdc, cameraPx: px, cameraPy: py });
      }
    }

    const rows = [];
    for (const group of groups.values()) {
      const zs = group.fragments.map((f) => f.zNdc);
      const storedZ = lightCache && lightCache.coverage[group.ty * lightW + group.tx]
        ? lightCache.values[group.ty * lightW + group.tx]
        : null;
      rows.push({
        tx: group.tx,
        ty: group.ty,
        count: group.fragments.length,
        storedZ,
        zMin: Math.min(...zs),
        zMax: Math.max(...zs),
        zSpread: Math.max(...zs) - Math.min(...zs),
        locations: group.fragments
          .slice()
          .sort((a, b) => b.zNdc - a.zNdc)
          .map((f) => ({ cameraPx: f.cameraPx, cameraPy: f.cameraPy, u: f.u, v: f.v, zNdc: f.zNdc })),
      });
    }

    rows.sort((a, b) => b.count - a.count || b.ty - a.ty || a.tx - b.tx);

    const multi = rows.filter((row) => row.count > 1);
    const summary = {
      lightView: lightViewName,
      lightPassIndex,
      cameraPassIndex,
      window,
      sampledFragments: sampled,
      outsideLight,
      texels: rows.length,
      multiTexels: multi.length,
      multiFragments: multi.reduce((sum, row) => sum + row.count, 0),
      maxFragments: rows.reduce((max, row) => Math.max(max, row.count), 0),
      maxSpread: multi.reduce((max, row) => Math.max(max, row.zSpread), 0),
    };

    return { rows, records, summary };
  };

  const describeAggregate = () => {
    const built = buildAggregate(aggregateState.lightView);
    aggregateState.rows = built.rows;
    aggregateState.records = built.records;
    aggregateState.summary = built.summary;
    const summary = built.summary;

    for (const button of document.querySelectorAll('#agg-axis-buttons button')) {
      button.classList.toggle('is-active', button.dataset.light === aggregateState.lightView);
    }

    setText(
      'agg-summary',
      `light 视角 ${summary.lightView}（#${summary.lightPassIndex} 存 z / #${summary.cameraPassIndex} 取 fragment）· ` +
        `角度 ${summary.lightView === 'lightX' ? state.angles.x.toFixed(0) : state.angles.y.toFixed(0)}° · ` +
        `camera 采样窗口 x ${summary.window.startX}–${summary.window.startX + summary.window.size - 1}, ` +
        `y ${summary.window.startY}–${summary.window.startY + summary.window.size - 1} · ` +
        `有 fragment 的像素 ${summary.sampledFragments} 个 · 落进 light 网格 ${summary.sampledFragments - summary.outsideLight} 个 · ` +
        `覆盖 texel ${summary.texels} 个，其中 ${summary.multiTexels} 个 texel 里有多个 fragment（最多 ${summary.maxFragments} 个/texel，` +
        `同 texel 内 z 散布最大 ${summary.maxSpread.toExponential(2)} NDC）`,
    );

    const body = document.getElementById('agg-body');
    if (!body) return built;
    body.textContent = '';

    const shown = built.rows.slice(0, AGGREGATE_PARAMS.maxRows);
    for (const row of shown) {
      const tr = document.createElement('tr');
      if (row.count > 1) tr.className = 'is-multi';

      const cellTexel = document.createElement('td');
      cellTexel.textContent = `(${row.tx}, ${row.ty})`;

      const cellZ = document.createElement('td');
      cellZ.textContent = row.storedZ === null ? '无 fragment' : row.storedZ.toFixed(6);

      const cellRange = document.createElement('td');
      cellRange.textContent = row.count === 1 ? row.zMin.toFixed(6) : `${row.zMin.toFixed(6)}~${row.zMax.toFixed(6)}`;

      const cellCount = document.createElement('td');
      cellCount.textContent = String(row.count);

      const cellLoc = document.createElement('td');
      const shownLocations = row.locations.slice(0, AGGREGATE_PARAMS.maxLocationsPerRow);
      const parts = shownLocations.map((f) => `(${f.cameraPx},${f.cameraPy})`);
      cellLoc.textContent = parts.join(' ') + (row.count > shownLocations.length ? ` +${row.count - shownLocations.length}` : '');
      cellLoc.title = row.locations.map((f) => `cam(${f.cameraPx},${f.cameraPy}) → light(${f.u.toFixed(2)},${f.v.toFixed(2)}) z=${f.zNdc.toFixed(6)}`).join('\n');

      tr.append(cellTexel, cellZ, cellRange, cellCount, cellLoc);
      body.append(tr);
    }

    setText(
      'agg-note',
      built.rows.length > shown.length
        ? `表格只渲染前 ${shown.length} 行（共 ${built.rows.length} 行）；完整 fragment 记录请点下面的 TSV 导出。`
        : `共 ${built.rows.length} 行，已全部列出。`,
    );

    return built;
  };

  const exportAggregateTsv = () => {
    const header = ['light_texel_u', 'light_texel_v', 'light_u_float', 'light_v_float', 'z_in_light_NDC', 'camera_px', 'camera_py'];
    const lines = [header.join('\t')];
    for (const record of aggregateState.records) {
      lines.push([
        record.tx, record.ty, record.u.toFixed(4), record.v.toFixed(4), record.zNdc.toFixed(8), record.cameraPx, record.cameraPy,
      ].join('\t'));
    }
    const text = lines.join('\n');

    const textarea = document.getElementById('agg-tsv');
    if (textarea) textarea.value = text;

    try {
      const blob = new Blob([text], { type: 'text/tab-separated-values' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `texel-aggregate-${aggregateState.lightView}.tsv`;
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (error) {
      console.warn('[engine] TSV download failed; the data is in the text area', error);
    }
    return text;
  };

  for (const button of document.querySelectorAll('#agg-axis-buttons button')) {
    button.addEventListener('click', () => {
      aggregateState.lightView = button.dataset.light;
      describeAggregate();
    });
  }
  document.getElementById('agg-export')?.addEventListener('click', exportAggregateTsv);

  if (config.mode === 'locator') {
    document.getElementById('aggregate')?.classList.add('is-primary');
  }

  const canvasPointToDevice = (event) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: (event.clientX - rect.left) * (canvas.width / rect.width),
      y: (event.clientY - rect.top) * (canvas.height / rect.height),
    };
  };

  canvas.addEventListener('pointermove', (event) => {
    if (state.pinnedPixel) return;
    const { x, y } = canvasPointToDevice(event);
    const probe = runProbe(x, y);
    if (!probe.ok) {
      clearProbe();
      return;
    }
    state.lastProbe = probe;
    describeProbe(probe);
  });

  canvas.addEventListener('pointerleave', () => {
    if (state.pinnedPixel) return;
    state.lastProbe = null;
    clearProbe();
  });

  canvas.addEventListener('click', (event) => {
    if (state.pinnedPixel) {
      state.pinnedPixel = null;
      state.lastProbe = null;
      clearProbe();
      return;
    }
    const { x, y } = canvasPointToDevice(event);
    const probe = runProbe(x, y);
    if (probe.ok) {
      state.pinnedPixel = { px: probe.aPx, py: probe.aPy };
      state.lastProbe = probe;
      describeProbe(probe);
    }
  });

  const angleSlider = document.getElementById('angle-slider');
  if (angleSlider) {
    angleSlider.value = String(state.angles[axisOfShownPass()]);
    let scheduled = false;
    angleSlider.addEventListener('input', () => {
      applyRotation(axisOfShownPass(), Number(angleSlider.value));
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        refresh().catch((error) => {
          console.error('[engine] re-render after rotation failed', error);
          showError(error);
        });
      });
    });
  }

  const stats = await refresh();

  let resizeTimer = 0;
  globalThis.addEventListener?.('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      refresh().catch((error) => {
        console.error('[engine] re-render failed', error);
        showError(error);
      });
    }, 120);
  });

  globalThis.__ENGINE__ = {
    gl,
    renderer,
    meshes,
    passes,
    state,
    stats,
    refresh,
    probe: runProbe,
    probeAtTargetPixel,
    locateWorldPoint: (point) => applyLocatedPoint(point),
    locatePlanePoint: (u, v) => applyLocatedPoint(triangle.fromPlane(u, v)),
    triangleFrame: {
      a: triangle.a,
      b: triangle.b,
      c: triangle.c,
      eU: triangle.eU,
      eV: triangle.eV,
      normal: triangle.normal,
      edgeLength: triangle.edgeLength,
      toPlane: (p) => triangle.toPlane(p),
      fromPlane: (u, v) => triangle.fromPlane(u, v),
      contains: (p) => triangle.contains(p),
    },
    setLocateMode,
    buildAggregate: (lightViewName) => buildAggregate(lightViewName ?? aggregateState.lightView),
    aggregateState,
    computeLocate: (point) => computeLocate(point),
    setRotation: (axis, deg) => {
      applyRotation(axis, deg);
      syncAngleUi();
      return refresh();
    },
    axisOfShownPass,
    unpackWorldDepth,
  };

  console.log(
    `[engine] rendered ${stats.length} passes: ` +
      stats
        .map((s) => `#${s.index} ${s.kind}/${s.view}->${s.lightView} ${s.grid.width}x${s.grid.height}`)
        .join(' | ') +
      ` · presenting pass #${state.shownPass}`,
  );

  return stats;
}

export function activate(engineMain = main) {
  const task = (async () => await engineMain())();

  task.catch((error) => {
    showError(error);
    setTimeout(() => {
      throw error;
    }, 0);
  });

  return task;
}

export const engineReady = activate(main);
globalThis.__ENGINE_READY__ = engineReady;

export { main };
