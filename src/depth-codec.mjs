// Depth packaging shared by the shaders and the CPU-side readback.
//
//   t = (value - range[0]) / (range[1] - range[0])      value in [0,1)
//   r = floor(t*255), g = floor(fract(t*255)*255), b = floor(...)  -> 24-bit fixed point in RGB
//   alpha = 1 marks a covered fragment, 0 marks background
//
// Reading the texel back and inverting the packing recovers the value with a
// resolution of range / 2^24. Keep the render target free of MSAA, blending and
// filtering when using it.

// ---------------------------------------------------------------------------
//
//
//   t      = (d - min) / (max - min)        ∈ [0, 1)
//   s      = t * 255      -> r = floor(s)     (0..255)
//   f1     = (s - r) * 255 -> g = floor(f1)
//   f2     = (f1 - g) * 255 -> b = floor(f2)
//
//   t = (r + g/255 + b/65025) / 255
//   d = min + t * (max - min)
//
// ---------------------------------------------------------------------------

export function unpackWorldDepth(rgba, range) {
  const [r, g, b, a] = rgba;
  if (a === 0) return null;

  const t = (r + g / 255 + b / 65025) / 255;
  return range[0] + t * (range[1] - range[0]);
}

export function unpackNormalized(rgba) {
  const [r, g, b, a] = rgba;
  if (a === 0) return null;
  return (r + g / 255 + b / 65025) / 255;
}

export function packNormalized(t, range) {
  const clamped = Math.min(Math.max(t, 0), 0.9999999);
  const s = clamped * 255;
  const r = Math.floor(s);
  const f1 = (s - r) * 255;
  const g = Math.floor(f1);
  const f2 = (f1 - g) * 255;
  const b = Math.floor(f2);
  return [r, g, b, 255];
}

export function packingResolution(range) {
  return (range[1] - range[0]) / 16777215;
}
