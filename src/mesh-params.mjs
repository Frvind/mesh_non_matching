// Single source of truth for the whole harness: the mesh, the views, the passes,
// the viewport sizes and the packing ranges. Everything else is derived from here.
//
//   mesh    one triangle, three vertices, no generator
//   views   camera (fixed), lightX (eye rotated about X), lightY (eye rotated about Y)
//   passes  two worldDepth passes (no port, used for cross-checks) and four
//           lightZ passes served on ports 8771-8774

// ---------------------------------------------------------------------------
//
//
//
// ---------------------------------------------------------------------------

export const TRIANGLE_MESH = {
  label: 'triangle',
  positions: [
    [-0.95, -0.62, 0.0],
    [0.95, -0.62, -0.35],
    [0.05, 0.92, 0.3],
  ],
  transform: { translation: [0, 0, 0], scale: [1, 1, 1] },
};

export const VIEWS = {
  camera: {
    label: 'camera',
    eye: [0.0167, -0.1067, 1.0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    rotationAxis: null,
  },
  lightY: {
    label: 'point light (rotated about Y)',
    eye: [0.0167, -0.1067, 1.0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    rotationAxis: 'y',
  },
  lightX: {
    label: 'point light (rotated about X)',
    eye: [0.0167, -0.1067, 1.0],
    target: [0, 0, 0],
    up: [0, 1, 0],
    rotationAxis: 'x',
  },
};

export const ROTATION_DEFAULTS = { x: 70, y: 79 };

export const PASS_PARAMS = [
  {
    name: 'pass-0 · light(Y) raster · world depth',
    short: '#0 w·LY',
    kind: 'worldDepth',
    view: 'lightY',
    lightView: 'lightY',
    grid: { width: 180, height: 180 },
    probePair: 1,
    hasPort: false,
  },
  {
    name: 'pass-1 · camera raster · world depth',
    short: '#1 w·cam',
    kind: 'worldDepth',
    view: 'camera',
    lightView: 'lightY',
    grid: { width: 180, height: 180 },
    probePair: 0,
    hasPort: false,
  },
  {
    name: 'pass-2 · camera raster · lightMVP z (about Y)',
    short: '#2 z·cam·LY',
    kind: 'lightZ',
    view: 'camera',
    lightView: 'lightY',
    grid: { width: 180, height: 180 },
    probePair: 3,
    hasPort: 8773,
  },
  {
    name: 'pass-3 · light(Y) raster · lightMVP z (about Y)',
    short: '#3 z·lt·LY',
    kind: 'lightZ',
    view: 'lightY',
    lightView: 'lightY',
    grid: { width: 180, height: 180 },
    probePair: 2,
    hasPort: 8774,
  },
  {
    name: 'pass-4 · camera raster · lightMVP z (about X)',
    short: '#4 z·cam·LX',
    kind: 'lightZ',
    view: 'camera',
    lightView: 'lightX',
    grid: { width: 180, height: 180 },
    probePair: 5,
    hasPort: 8771,
  },
  {
    name: 'pass-5 · light(X) raster · lightMVP z (about X)',
    short: '#5 z·lt·LX',
    kind: 'lightZ',
    view: 'lightX',
    lightView: 'lightX',
    grid: { width: 180, height: 180 },
    probePair: 4,
    hasPort: 8772,
  },
];

export const MESH_INSTANCES = PASS_PARAMS.map((pass, index) => ({
  key: `pass-${index}`,
  label: `triangle (for ${pass.name})`,
  shader: pass.kind,
}));

export const PROJECTION_PARAMS = { fovDeg: 55, near: 0.1, far: 100 };

export const WORLD_DEPTH_RANGE = [0, 8];
export const LIGHT_Z_RANGE = [-1, 1];

export function depthRangeForKind(kind) {
  if (kind === 'worldDepth') return WORLD_DEPTH_RANGE;
  if (kind === 'lightZ') return LIGHT_Z_RANGE;
  throw new Error(`unknown pass kind "${kind}"`);
}

export const CLEAR_COLOR = [0, 0, 0, 0];

export const AGGREGATE_PARAMS = {
  side: 'camera',
  size: 32,
  maxRows: 400,
  maxLocationsPerRow: 6,
};
