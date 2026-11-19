// Camera math used by both the renderer and the CPU-side analysis.
//
// Pixel convention: pixel centres, py counted from the bottom edge (as readPixels).

// ---------------------------------------------------------------------------
//
//
// ---------------------------------------------------------------------------

import { invert, lookAt, multiply, perspective, transformPoint4 } from './mat4.mjs';

export function passForward(pass) {
  const target = pass.target ?? [0, 0, 0];
  const fx = target[0] - pass.eye[0];
  const fy = target[1] - pass.eye[1];
  const fz = target[2] - pass.eye[2];
  const len = Math.hypot(fx, fy, fz) || 1;
  return [fx / len, fy / len, fz / len];
}

export function buildPassMatrices(pass, projection) {
  const view = lookAt(new Float32Array(16), pass.eye, pass.target ?? [0, 0, 0], pass.up);
  const proj = perspective(
    new Float32Array(16),
    (projection.fovDeg * Math.PI) / 180,
    pass.grid.width / pass.grid.height,
    projection.near,
    projection.far,
  );
  const viewProj = multiply(new Float32Array(16), proj, view);
  return { view, proj, viewProj };
}

export function pixelToNdc(px, py, grid) {
  return [((px + 0.5) / grid.width) * 2 - 1, ((py + 0.5) / grid.height) * 2 - 1];
}

export function ndcToPixel(ndcX, ndcY, grid) {
  return [(ndcX * 0.5 + 0.5) * grid.width - 0.5, (ndcY * 0.5 + 0.5) * grid.height - 0.5];
}

export function reconstructWorldPoint(pixel, depth, frame) {
  const invViewProj = invert(new Float32Array(16), frame.viewProj);
  if (!invViewProj) throw new Error('viewProj is not invertible');

  const [ndcX, ndcY] = pixelToNdc(pixel.px, pixel.py, frame.grid);
  const nearPoint = transformPoint4(invViewProj, [ndcX, ndcY, -1]);
  const farPoint = transformPoint4(invViewProj, [ndcX, ndcY, 1]);

  const nearW = [nearPoint[0] / nearPoint[3], nearPoint[1] / nearPoint[3], nearPoint[2] / nearPoint[3]];
  const farW = [farPoint[0] / farPoint[3], farPoint[1] / farPoint[3], farPoint[2] / farPoint[3]];

  let dir = [farW[0] - nearW[0], farW[1] - nearW[1], farW[2] - nearW[2]];
  const len = Math.hypot(...dir) || 1;
  dir = [dir[0] / len, dir[1] / len, dir[2] / len];

  // depth = dot(world - eye, forward) = |world - eye| * dot(dir, forward)
  const cos = dir[0] * frame.forward[0] + dir[1] * frame.forward[1] + dir[2] * frame.forward[2];
  if (Math.abs(cos) < 1e-6) throw new Error('view ray orthogonal to forward: depth cannot be inverted');
  const distance = depth / cos;

  return [
    frame.eye[0] + dir[0] * distance,
    frame.eye[1] + dir[1] * distance,
    frame.eye[2] + dir[2] * distance,
  ];
}

export function projectToGrid(worldPoint, frame) {
  const clip = transformPoint4(frame.viewProj, worldPoint);
  if (Math.abs(clip[3]) < 1e-9) return { px: NaN, py: NaN, ndcZ: NaN, inside: false, behind: true };

  const ndcX = clip[0] / clip[3];
  const ndcY = clip[1] / clip[3];
  const ndcZ = clip[2] / clip[3];
  const [px, py] = ndcToPixel(ndcX, ndcY, frame.grid);

  const inside =
    ndcZ >= -1 && ndcZ <= 1 &&
    px >= -0.5 && px <= frame.grid.width - 0.5 &&
    py >= -0.5 && py <= frame.grid.height - 0.5;

  return { px, py, ndcX, ndcY, ndcZ, inside, behind: clip[3] <= 0 };
}

export function rotateEyeAboutAxis(eye, axis, angleDeg) {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const [x, y, z] = eye;

  if (axis === 'y') return [x * cos - z * sin, y, x * sin + z * cos];
  if (axis === 'x') return [x, y * cos - z * sin, y * sin + z * cos];
  if (axis === 'z') return [x * cos - y * sin, x * sin + y * cos, z];
  throw new Error(`unknown rotation axis "${axis}"`);
}

export function pixelRayDirection(pixel, frame) {
  const invViewProj = invert(new Float32Array(16), frame.viewProj);
  if (!invViewProj) throw new Error('viewProj is not invertible');

  const [ndcX, ndcY] = pixelToNdc(pixel.px, pixel.py, frame.grid);
  const nearPoint = transformPoint4(invViewProj, [ndcX, ndcY, -1]);
  const farPoint = transformPoint4(invViewProj, [ndcX, ndcY, 1]);
  const nearW = [nearPoint[0] / nearPoint[3], nearPoint[1] / nearPoint[3], nearPoint[2] / nearPoint[3]];
  const farW = [farPoint[0] / farPoint[3], farPoint[1] / farPoint[3], farPoint[2] / farPoint[3]];

  const dir = [farW[0] - nearW[0], farW[1] - nearW[1], farW[2] - nearW[2]];
  const len = Math.hypot(...dir) || 1;
  return [dir[0] / len, dir[1] / len, dir[2] / len];
}

export function lightLinearDepthFromNdcZ(zNdc, lightProjection) {
  const m10 = lightProjection[10];
  const m14 = lightProjection[14];
  const zView = m14 / (-zNdc - m10);
  return -zView;
}

export function ndcZToDepth01(zNdc) {
  return (zNdc + 1) / 2;
}

export function reconstructWorldPointFromLightZ(pixel, zNdc, frame) {
  const lightDepth = lightLinearDepthFromNdcZ(zNdc, frame.lightProj);
  const dir = pixelRayDirection(pixel, frame);
  const eye = frame.eye;
  const lightEye = frame.lightEye;
  const forward = frame.lightForward;

  const denom = dir[0] * forward[0] + dir[1] * forward[1] + dir[2] * forward[2];
  if (Math.abs(denom) < 1e-9) throw new Error('ray parallel to the light view plane: lightMVP z cannot be inverted');

  const eyeToLightPlane =
    (eye[0] - lightEye[0]) * forward[0] +
    (eye[1] - lightEye[1]) * forward[1] +
    (eye[2] - lightEye[2]) * forward[2];

  const t = (lightDepth - eyeToLightPlane) / denom;
  return [eye[0] + dir[0] * t, eye[1] + dir[1] * t, eye[2] + dir[2] * t];
}
