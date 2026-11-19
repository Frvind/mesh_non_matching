// WebGLRenderer - one framebuffer per pass.
//
// Each pass owns its own viewport size, view matrix and lightMVP, its own
// MeshRender and its own FBO, so passes never share render state and their
// order does not matter. A separate presenter blits one pass to the canvas.
// Readback helpers return raw texels so the packed values stay exact.

// ---------------------------------------------------------------------------
// webgl-renderer.mjs - WebGLRenderer
//
// ---------------------------------------------------------------------------

import { buildPassMatrices, passForward } from './camera.mjs';
import { lookAt, multiply, perspective } from './mat4.mjs';
import { depthRangeForKind } from './mesh-params.mjs';

const PRESENTER = {
  vertex: `
    precision highp float;
    attribute vec2 aClip;
    uniform vec2 uScale;
    varying vec2 vUv;
    void main() {
      vUv = aClip * 0.5 + 0.5;
      gl_Position = vec4(aClip * uScale, 0.0, 1.0);
    }
  `,
  fragment: `
    precision highp float;
    uniform sampler2D uTexture;
    varying vec2 vUv;
    void main() {
      gl_FragColor = texture2D(uTexture, vUv);
    }
  `,
};

const nextFrame = (() => {
  if (typeof requestAnimationFrame === 'function') {
    return () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return () => new Promise((resolve) => setTimeout(resolve, 0));
})();

class PassTarget {
  constructor(gl, grid) {
    this.gl = gl;
    this.width = grid.width;
    this.height = grid.height;

    this.framebuffer = gl.createFramebuffer();
    this.colorTexture = gl.createTexture();
    this.depthBuffer = gl.createRenderbuffer();

    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.width, this.height);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.colorTexture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);

    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    if (status !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error(`pass target framebuffer incomplete: 0x${status.toString(16)}`);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindRenderbuffer(gl.RENDERBUFFER, null);
  }
}

export class WebGLRenderer {
  #gl;
  #meshes;
  #passes;
  #views;
  #projection;
  #clearColor;

  #targets = [];
  #frames = [];
  #passStats = [];

  #presenterProgram = null;
  #presenterLocations = null;
  #presenterBuffer = null;

  constructor(gl, { meshes, passes, views, projection, clearColor = [0, 0, 0, 0] }) {
    if (!meshes?.length) throw new Error('[WebGLRenderer] no mesh');
    if (!passes?.length) throw new Error('[WebGLRenderer] no pass');
    if (!views || Object.keys(views).length === 0) throw new Error('[WebGLRenderer] missing view definitions');

    for (const [index, pass] of passes.entries()) {
      const meshIndex = pass.meshIndex ?? index;
      if (!meshes[meshIndex]) throw new Error(`[WebGLRenderer] pass ${index} points at missing mesh ${meshIndex}`);
      if (!pass.grid?.width || !pass.grid?.height) throw new Error(`[WebGLRenderer] pass ${index} is missing its grid size`);
      if (!views[pass.view]) throw new Error(`[WebGLRenderer] pass ${index} references unknown view "${pass.view}"`);
      if (!views[pass.lightView ?? pass.view]) throw new Error(`[WebGLRenderer] pass ${index} references unknown lightView`);
    }

    this.#gl = gl;
    this.#meshes = meshes;
    this.#passes = passes;
    this.#views = {};
    for (const [name, view] of Object.entries(views)) {
      this.#views[name] = {
        ...view,
        eye: [...view.eye],
        target: [...(view.target ?? [0, 0, 0])],
        up: [...(view.up ?? [0, 1, 0])],
      };
    }
    this.#projection = projection;
    this.#clearColor = clearColor;
    this.#passStats = passes.map((pass, index) => ({ index, name: pass.name, ready: false }));
  }

  get passCount() { return this.#passes.length; }
  get passStats() { return this.#passStats; }
  get targets() { return this.#targets; }
  get frames() { return this.#frames; }

  getPassFrame(index) {
    return this.#frames[index];
  }

  updateViewEye(role, eye) {
    const view = this.#views[role];
    if (!view) throw new Error(`[WebGLRenderer] unknown view "${role}"`);
    view.eye = [...eye];
    return view;
  }

  getView(role) {
    return this.#views[role];
  }

  #lightMatrices(viewName) {
    const view = this.#views[viewName];
    if (!view) throw new Error(`[WebGLRenderer] unknown view "${viewName}"`);
    const lightPass =
      this.#passes.find((pass) => pass.lightView === viewName) ??
      this.#passes.find((pass) => pass.view === viewName) ??
      this.#passes[0];

    const proj = perspective(
      new Float32Array(16),
      (this.#projection.fovDeg * Math.PI) / 180,
      lightPass.grid.width / lightPass.grid.height,
      this.#projection.near,
      this.#projection.far,
    );
    const viewMatrix = lookAt(new Float32Array(16), view.eye, view.target ?? [0, 0, 0], view.up ?? [0, 1, 0]);
    return { proj, view: viewMatrix, viewProj: multiply(new Float32Array(16), proj, viewMatrix) };
  }

  async init() {
    const gl = this.#gl;

    for (const pass of this.#passes) {
      this.#targets.push(new PassTarget(gl, pass.grid));
    }

    this.#frames = this.#passes.map((pass, index) => ({
      index,
      grid: pass.grid,
      eye: [...this.#views[pass.view].eye],
      forward: passForward(this.#views[pass.view]),
      view: null,
      proj: null,
      viewProj: null,
      lightEye: [...this.#views[pass.lightView ?? pass.view].eye],
      lightForward: passForward(this.#views[pass.lightView ?? pass.view]),
      lightProj: null,
      lightViewProj: null,
    }));

    const vertexShader = this.#compileShader(gl.VERTEX_SHADER, PRESENTER.vertex, 'presenter/vertex');
    const fragmentShader = this.#compileShader(gl.FRAGMENT_SHADER, PRESENTER.fragment, 'presenter/fragment');
    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    await nextFrame();

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[WebGLRenderer] presenter link failed: ${gl.getProgramInfoLog(program)}`);
    }
    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    this.#presenterProgram = program;
    this.#presenterLocations = {
      aClip: gl.getAttribLocation(program, 'aClip'),
      uScale: gl.getUniformLocation(program, 'uScale'),
      uTexture: gl.getUniformLocation(program, 'uTexture'),
    };

    this.#presenterBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#presenterBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return this;
  }

  async renderPass(index) {
    const gl = this.#gl;
    const pass = this.#passes[index];
    const target = this.#targets[index];
    if (!pass || !target) throw new Error(`[WebGLRenderer] pass ${index} does not exist`);

    const mesh = this.#meshes[pass.meshIndex ?? index];

    await mesh.ready();

    const viewSpec = this.#views[pass.view];
    const lightViewName = pass.lightView ?? pass.view;
    const lightView = this.#views[lightViewName];
    const matrices = buildPassMatrices({ ...viewSpec, grid: pass.grid }, this.#projection);
    const light = this.#lightMatrices(lightViewName);
    const lightForward = passForward(lightView);
    const eye = viewSpec.eye;
    const forward = passForward(viewSpec);
    const viewMatrix = matrices.view;
    const depthRange = depthRangeForKind(pass.kind);

    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(...this.#clearColor);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);

    mesh.draw({
      viewMatrix,
      projectionMatrix: matrices.proj,
      eye,
      forward,
      lightViewProj: light.viewProj,
      depthRange,
    });

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.#frames[index] = {
      index,
      kind: pass.kind,
      viewRole: pass.view,
      lightView: lightViewName,
      short: pass.short,
      probePair: pass.probePair,
      grid: { width: target.width, height: target.height },
      eye,
      forward,
      view: viewMatrix,
      proj: matrices.proj,
      viewProj: multiply(new Float32Array(16), matrices.proj, viewMatrix),
      lightView: lightViewName,
      lightEye: [...lightView.eye],
      lightForward,
      lightProj: light.proj,
      lightViewProj: light.viewProj,
      depthRange,
    };

    const stats = {
      index,
      name: pass.name,
      kind: pass.kind,
      view: pass.view,
      lightView: lightViewName,
      short: pass.short,
      meshIndex: pass.meshIndex ?? index,
      meshLabel: mesh.label,
      grid: { width: target.width, height: target.height },
      eye,
      forward,
      lightEye: [...lightView.eye],
      depthRange,
      ready: mesh.isReady,
    };
    this.#passStats[index] = stats;
    return stats;
  }

  async renderAllPasses() {
    const results = [];
    for (let i = 0; i < this.#passes.length; i++) results.push(await this.renderPass(i));
    return results;
  }

  async present(index) {
    const gl = this.#gl;
    const target = this.#targets[index];
    if (!target) throw new Error(`[WebGLRenderer] no pass ${index}`);

    const rect = this.#presentRect(index);
    const canvasWidth = gl.drawingBufferWidth;
    const canvasHeight = gl.drawingBufferHeight;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvasWidth, canvasHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0.012, 0.016, 0.024, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const { aClip, uScale, uTexture } = this.#presenterLocations;
    gl.useProgram(this.#presenterProgram);
    gl.uniform2f(uScale, rect.drawWidth / canvasWidth, rect.drawHeight / canvasHeight);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, target.colorTexture);
    gl.uniform1i(uTexture, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.#presenterBuffer);
    gl.enableVertexAttribArray(aClip);
    gl.vertexAttribPointer(aClip, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    await nextFrame();
  }

  #presentRect(index) {
    const gl = this.#gl;
    const target = this.#targets[index];
    const canvasWidth = gl.drawingBufferWidth;
    const canvasHeight = gl.drawingBufferHeight;
    const targetAspect = target.width / target.height;
    const canvasAspect = canvasWidth / canvasHeight;

    let drawWidth;
    let drawHeight;
    if (canvasAspect > targetAspect) {
      drawHeight = canvasHeight;
      drawWidth = canvasHeight * targetAspect;
    } else {
      drawWidth = canvasWidth;
      drawHeight = canvasWidth / targetAspect;
    }
    return {
      drawWidth,
      drawHeight,
      offsetX: (canvasWidth - drawWidth) / 2,
      offsetY: (canvasHeight - drawHeight) / 2,
      canvasWidth,
      canvasHeight,
    };
  }

  canvasToTarget(deviceX, deviceY, index) {
    const rect = this.#presentRect(index);
    const target = this.#targets[index];
    const px = ((deviceX - rect.offsetX) / rect.drawWidth) * target.width - 0.5;
    const py = (1 - (deviceY - rect.offsetY) / rect.drawHeight) * target.height - 0.5;
    return { px, py };
  }

  targetToCanvas(px, py, index) {
    const rect = this.#presentRect(index);
    const target = this.#targets[index];
    return {
      x: rect.offsetX + ((px + 0.5) / target.width) * rect.drawWidth,
      y: rect.offsetY + (1 - (py + 0.5) / target.height) * rect.drawHeight,
    };
  }

  readPassPixels(index) {
    const gl = this.#gl;
    const target = this.#targets[index];
    if (!target) throw new Error(`[WebGLRenderer] no pass ${index}`);
    const pixels = new Uint8Array(target.width * target.height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.readPixels(0, 0, target.width, target.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return pixels;
  }

  #compileShader(type, source, stage) {
    const gl = this.#gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[WebGLRenderer] ${stage} shader compilation failed: ${log}`);
    }
    return shader;
  }
}
