// MeshRender - one renderable mesh with its own GL program.
//
// Two program kinds are bound internally (no external material file):
//   worldDepth  fragment value = dot(worldPos - eye, forward)   [world units]
//   lightZ      fragment value = (lightViewProj * worldPos).z/w [NDC]
// Both encode the value with the 24-bit packing from depth-codec.mjs.
//
// load() is genuinely asynchronous (shader compile/link plus buffer upload) and
// ready() exposes that promise; every pass awaits it before drawing.

// ---------------------------------------------------------------------------
// mesh-render.mjs - MeshRender
//
//
// ---------------------------------------------------------------------------

import { identity } from './mat4.mjs';

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
const PROGRAM_SOURCES = {
  worldDepth: {
    vertex: `
      precision highp float;
      attribute vec3 aPosition;
      uniform mat4 uModel;
      uniform mat4 uView;
      uniform mat4 uProj;
      varying vec3 vWorld;
      void main() {
        vec4 world = uModel * vec4(aPosition, 1.0);
        vWorld = world.xyz;
        gl_Position = uProj * (uView * world);
      }
    `,
    fragment: `
      precision highp float;
      uniform vec3 uEye;
      uniform vec3 uForward;
      uniform vec2 uDepthRange;
      varying vec3 vWorld;

      void main() {
        float depth = dot(vWorld - uEye, uForward);
        float t = clamp((depth - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 0.9999999);

        float s = t * 255.0;
        float r = floor(s);
        float f1 = (s - r) * 255.0;
        float g = floor(f1);
        float f2 = (f1 - g) * 255.0;
        float b = floor(f2);

        gl_FragColor = vec4(vec3(r, g, b) / 255.0, 1.0);
      }
    `,
  },
  lightZ: {
    vertex: `
      precision highp float;
      attribute vec3 aPosition;
      uniform mat4 uModel;
      uniform mat4 uView;
      uniform mat4 uProj;
      varying vec3 vWorld;
      void main() {
        vec4 world = uModel * vec4(aPosition, 1.0);
        vWorld = world.xyz;
        gl_Position = uProj * (uView * world);
      }
    `,
    fragment: `
      precision highp float;
      uniform mat4 uLightViewProj;   // lightMVP (V_light * P_light)
      uniform vec2 uDepthRange;
      varying vec3 vWorld;

      void main() {
        vec4 clip = uLightViewProj * vec4(vWorld, 1.0);
        float zNdc = clip.w > 1e-6 ? clip.z / clip.w : 1.0;

        float t = clamp((zNdc - uDepthRange.x) / (uDepthRange.y - uDepthRange.x), 0.0, 0.9999999);

        float s = t * 255.0;
        float r = floor(s);
        float f1 = (s - r) * 255.0;
        float g = floor(f1);
        float f2 = (f1 - g) * 255.0;
        float b = floor(f2);

        gl_FragColor = vec4(vec3(r, g, b) / 255.0, 1.0);
      }
    `,
  },
};

const nextFrame = (() => {
  if (typeof requestAnimationFrame === 'function') {
    return () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  return () => new Promise((resolve) => setTimeout(resolve, 0));
})();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForProgram(gl, program) {
  const parallel = gl.getExtension('KHR_parallel_shader_compile');
  if (parallel) {
    const statusEnum = parallel.COMPLETION_STATUS_KHR;
    for (let i = 0; i < 600; i++) {
      if (gl.getProgramParameter(program, statusEnum)) return;
      await sleep(2);
    }
    return;
  }
  await nextFrame();
}

export class MeshRender {
  #gl;
  #params;
  #label;

  #program = null;
  #locations = null;
  #buffer = null;
  #vertexCount = 0;
  #model = identity(new Float32Array(16));

  #ready = false;
  #readyPromise = null;
  #readyError = null;

  constructor(gl, params) {
    if (!gl) throw new Error('[MeshRender] a valid WebGL context is required');
    if (!params?.positions?.length) throw new Error('[MeshRender] missing vertex data');

    this.#gl = gl;
    this.#params = params;
    this.#label = params.label ?? 'mesh';

    const transform = params.transform ?? {};
    const translation = transform.translation ?? [0, 0, 0];
    const scale = transform.scale ?? [1, 1, 1];
    this.#model.set([
      scale[0], 0, 0, 0,
      0, scale[1], 0, 0,
      0, 0, scale[2], 0,
      translation[0], translation[1], translation[2], 1,
    ]);

    this.#vertexCount = params.positions.length;

    this.#readyPromise = this.#load();
    this.#readyPromise.catch((error) => {
      this.#readyError = error;
      console.error(`[MeshRender:${this.#label}] init failed`, error);
    });
  }

  get label() { return this.#label; }
  get params() { return this.#params; }
  get modelMatrix() { return this.#model; }
  get vertexCount() { return this.#vertexCount; }
  get isReady() { return this.#ready; }
  get readyError() { return this.#readyError; }

  ready() {
    return this.#readyPromise;
  }

  async #load() {
    const gl = this.#gl;
    const sources = PROGRAM_SOURCES[this.#params.shader];
    if (!sources) throw new Error(`[MeshRender:${this.#label}] unknown shader "${this.#params.shader}"`);

    const vertexShader = this.#compileShader(gl.VERTEX_SHADER, sources.vertex, 'vertex');
    const fragmentShader = this.#compileShader(gl.FRAGMENT_SHADER, sources.fragment, 'fragment');

    const program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    await waitForProgram(gl, program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`[MeshRender:${this.#label}] link failed: ${gl.getProgramInfoLog(program)}`);
    }

    gl.detachShader(program, vertexShader);
    gl.detachShader(program, fragmentShader);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);

    this.#program = program;
    this.#locations = {
      position: gl.getAttribLocation(program, 'aPosition'),
      model: gl.getUniformLocation(program, 'uModel'),
      view: gl.getUniformLocation(program, 'uView'),
      proj: gl.getUniformLocation(program, 'uProj'),
      eye: gl.getUniformLocation(program, 'uEye'),
      forward: gl.getUniformLocation(program, 'uForward'),
      depthRange: gl.getUniformLocation(program, 'uDepthRange'),
      lightViewProj: gl.getUniformLocation(program, 'uLightViewProj'),
    };

    await this.#uploadGeometry();
    this.#ready = true;
  }

  #compileShader(type, source, stage) {
    const gl = this.#gl;
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`[MeshRender:${this.#label}] ${stage} shader compilation failed: ${log}`);
    }
    return shader;
  }

  async #uploadGeometry() {
    const gl = this.#gl;
    const flat = new Float32Array(this.#params.positions.flat());

    this.#buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.bufferData(gl.ARRAY_BUFFER, flat, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    await Promise.resolve();
  }

  draw({ viewMatrix, projectionMatrix, eye, forward, lightViewProj, depthRange }) {
    if (!this.#ready) {
      throw new Error(`[MeshRender:${this.#label}] draw() before ready(): await ready() first`);
    }

    const gl = this.#gl;
    const loc = this.#locations;

    gl.useProgram(this.#program);
    gl.uniformMatrix4fv(loc.model, false, this.#model);
    gl.uniformMatrix4fv(loc.view, false, viewMatrix);
    gl.uniformMatrix4fv(loc.proj, false, projectionMatrix);
    if (this.#params.shader === 'lightZ') {
      if (!lightViewProj) throw new Error(`[MeshRender:${this.#label}] lightZ requires lightViewProj`);
      gl.uniformMatrix4fv(loc.lightViewProj, false, lightViewProj);
    } else {
      gl.uniform3fv(loc.eye, eye);
      gl.uniform3fv(loc.forward, forward);
    }
    gl.uniform2fv(loc.depthRange, depthRange);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.#buffer);
    gl.enableVertexAttribArray(loc.position);
    gl.vertexAttribPointer(loc.position, 3, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, this.#vertexCount);

    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.useProgram(null);
  }

  describe() {
    return {
      label: this.#label,
      ready: this.#ready,
      vertexCount: this.#vertexCount,
      positions: this.#params.positions,
      modelMatrix: Array.from(this.#model),
    };
  }
}
