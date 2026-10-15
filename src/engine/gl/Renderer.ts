// WebGL2 indexed-color renderer.
//
// The original game renders into a 640x480 8-bit palettized DirectDraw surface. We reproduce that
// exactly: every draw writes palette indices into an R8 offscreen target ("index buffer"), sprites are
// stored as palette indices (index 0 = transparent), per-draw remap tables emulate the player color
// remapping (.RMP files), and a final pass converts indices to RGB through the current palette and
// scales the image to the canvas. Because every quad is axis aligned, unscaled and positioned on whole
// pixels, the GPU produces bit-identical results to a software blitter.

import { SCREEN_W, SCREEN_H } from '../constants.ts';

export const DrawMode = {
  /** Sprite: discard index 0, then remap through table `remap`. */
  Sprite: 0,
  /** Opaque blit: copy indices as-is (index 0 included), remap applied. */
  Opaque: 1,
  /** Solid fill with palette index `color` (stored in remap field). */
  Fill: 2,
  /** Mask: draw palette index `color` where the source texel is non-zero (fonts, silhouettes). */
  Mask: 3,
} as const;
export type DrawMode = (typeof DrawMode)[keyof typeof DrawMode];

export interface TextureHandle {
  tex: WebGLTexture;
  w: number;
  h: number;
  layers: number;
}

const INSTANCE_INTS = 8; // dstX, dstY, w, h, srcX, srcY, layer, (mode << 12 | param)
const MAX_INSTANCES = 16384;

const SPRITE_VS = `#version 300 es
precision highp float;
precision highp int;
layout(location=0) in ivec4 aDst;   // x, y, w, h
layout(location=1) in ivec4 aSrc;   // sx, sy, layer, modeParam
uniform vec2 uTarget;
flat out ivec4 vSrc;
out vec2 vLocal;
void main() {
  int vid = gl_VertexID;
  vec2 corner = vec2(float(vid & 1), float((vid >> 1) & 1));
  vec2 pos = vec2(aDst.xy) + corner * vec2(aDst.zw);
  // The target is y-up (GL), source rows are top-down: local y runs from h (bottom) to 0 (top).
  vLocal = vec2(corner.x, 1.0 - corner.y) * vec2(aDst.zw);
  vSrc = aSrc;
  vec2 ndc = pos / uTarget * 2.0 - 1.0;
  gl_Position = vec4(ndc.x, ndc.y, 0.0, 1.0);
}`;

const SPRITE_FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2DArray;
precision highp sampler2D;
uniform sampler2DArray uAtlas;
uniform sampler2D uRemap;   // 256 x N, R8
flat in ivec4 vSrc;
in vec2 vLocal;
out vec4 outColor;
void main() {
  int mode = vSrc.w >> 12;
  int param = vSrc.w & 4095;
  if (mode == 2) { outColor = vec4(float(param) / 255.0, 0.0, 0.0, 1.0); return; }
  ivec2 local = ivec2(floor(vLocal));
  ivec3 tc = ivec3(vSrc.x + local.x, vSrc.y + local.y, vSrc.z);
  int idx = int(texelFetch(uAtlas, tc, 0).r * 255.0 + 0.5);
  if (mode == 3) {
    if (idx == 0) discard;
    outColor = vec4(float(param) / 255.0, 0.0, 0.0, 1.0);
    return;
  }
  if (mode == 0 && idx == 0) discard;
  int mapped = int(texelFetch(uRemap, ivec2(idx, param), 0).r * 255.0 + 0.5);
  outColor = vec4(float(mapped) / 255.0, 0.0, 0.0, 1.0);
}`;

const PRESENT_VS = `#version 300 es
precision highp float;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Converts indices to colors and scales with "sharp bilinear" filtering: nearest neighbour inside
// source pixels, a one-output-pixel wide linear blend at pixel boundaries. This keeps pixels crisp at
// non-integer scale factors without uneven pixel widths.
const PRESENT_FS = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D uIndex;
uniform sampler2D uPalette; // 256x1 RGBA8
uniform vec2 uSrcSize;
uniform vec4 uViewport;      // x, y, w, h of the game image inside the canvas (device pixels)
uniform float uScale;        // device pixels per source pixel
uniform vec4 uBorder;        // border color
uniform int uSharp;
out vec4 outColor;
vec3 col(ivec2 p) {
  p = clamp(p, ivec2(0), ivec2(uSrcSize) - 1);
  int idx = int(texelFetch(uIndex, ivec2(p.x, int(uSrcSize.y) - 1 - p.y), 0).r * 255.0 + 0.5);
  return texelFetch(uPalette, ivec2(idx, 0), 0).rgb;
}
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 rel = (frag - uViewport.xy);
  if (rel.x < 0.0 || rel.y < 0.0 || rel.x >= uViewport.z || rel.y >= uViewport.w) { outColor = uBorder; return; }
  // source pixel coords, y down
  vec2 src = vec2(rel.x, uViewport.w - rel.y) / uScale;
  if (uSharp == 0) { outColor = vec4(col(ivec2(floor(src))), 1.0); return; }
  vec2 s = src - 0.5;
  vec2 base = floor(s);
  vec2 f = s - base;
  // sharpen: only blend within ~1 device pixel around the texel edge
  vec2 r = clamp((f - 0.5) * uScale + 0.5, 0.0, 1.0);
  ivec2 b = ivec2(base);
  vec3 c00 = col(b), c10 = col(b + ivec2(1, 0)), c01 = col(b + ivec2(0, 1)), c11 = col(b + ivec2(1, 1));
  vec3 c = mix(mix(c00, c10, r.x), mix(c01, c11, r.x), r.y);
  outColor = vec4(c, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error('shader compile failed: ' + gl.getShaderInfoLog(sh) + '\n' + src);
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('link failed: ' + gl.getProgramInfoLog(p));
  return p;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  private spriteProg: WebGLProgram;
  private presentProg: WebGLProgram;
  private vao: WebGLVertexArrayObject;
  private presentVao: WebGLVertexArrayObject;
  private instBuf: WebGLBuffer;
  private inst = new Int16Array(MAX_INSTANCES * INSTANCE_INTS);
  private count = 0;
  private curTex: TextureHandle | null = null;
  private indexTex: WebGLTexture;
  private fbo: WebGLFramebuffer;
  private paletteTex: WebGLTexture;
  private remapTex: WebGLTexture;
  private remapRows = 1;
  private uTargetLoc: WebGLUniformLocation;
  private presentLocs: Record<string, WebGLUniformLocation | null> = {};
  readonly palette = new Uint8Array(256 * 4);
  private paletteDirty = true;
  /** Placement of the 640x480 image inside the canvas, CSS pixels (for input mapping). */
  viewport = { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H, scale: 1 };
  sharp = true;
  drawCalls = 0;
  /** Clip rectangle (x0,y0,x1,y1) in screen pixels, applied with scissor. */
  private clip: [number, number, number, number] | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);

    this.spriteProg = link(gl, SPRITE_VS, SPRITE_FS);
    this.presentProg = link(gl, PRESENT_VS, PRESENT_FS);
    this.uTargetLoc = gl.getUniformLocation(this.spriteProg, 'uTarget')!;
    gl.useProgram(this.spriteProg);
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'uAtlas'), 0);
    gl.uniform1i(gl.getUniformLocation(this.spriteProg, 'uRemap'), 1);
    for (const n of ['uIndex', 'uPalette', 'uSrcSize', 'uViewport', 'uScale', 'uBorder', 'uSharp']) {
      this.presentLocs[n] = gl.getUniformLocation(this.presentProg, n);
    }

    this.instBuf = gl.createBuffer()!;
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.inst.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribIPointer(0, 4, gl.SHORT, INSTANCE_INTS * 2, 0);
    gl.vertexAttribDivisor(0, 1);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribIPointer(1, 4, gl.SHORT, INSTANCE_INTS * 2, 8);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);
    this.presentVao = gl.createVertexArray()!;

    this.indexTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.R8, SCREEN_W, SCREEN_H);
    this.setNearest(gl.TEXTURE_2D);
    this.fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.indexTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.paletteTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, 256, 1);
    this.setNearest(gl.TEXTURE_2D);

    this.remapTex = gl.createTexture()!;
    this.setRemapTables([identityTable()]);
    // Dummy texture so that fills drawn before any sprite still have a complete sampler bound.
    this.dummy = this.createIndexedTexture(1, 1, [new Uint8Array(1)]);
  }

  private dummy: TextureHandle;

  private setNearest(target: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Upload remap tables (each 256 entries). Row 0 should be the identity table. */
  setRemapTables(tables: Uint8Array[]): void {
    const gl = this.gl;
    this.flush();
    const data = new Uint8Array(256 * tables.length);
    tables.forEach((t, i) => data.set(t, i * 256));
    gl.bindTexture(gl.TEXTURE_2D, this.remapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 256, tables.length, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.setNearest(gl.TEXTURE_2D);
    this.remapRows = tables.length;
  }

  get remapCount(): number {
    return this.remapRows;
  }

  /** Create an indexed texture array (R8) with the given layers (each w*h indices). */
  createIndexedTexture(w: number, h: number, layers: Uint8Array[]): TextureHandle {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, tex);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8, w, h, layers.length);
    layers.forEach((data, i) => {
      gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, i, w, h, 1, gl.RED, gl.UNSIGNED_BYTE, data);
    });
    this.setNearest(gl.TEXTURE_2D_ARRAY);
    return { tex, w, h, layers: layers.length };
  }

  updateIndexedLayer(handle: TextureHandle, layer: number, data: Uint8Array): void {
    const gl = this.gl;
    this.flush();
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, handle.tex);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, layer, handle.w, handle.h, 1, gl.RED, gl.UNSIGNED_BYTE, data);
  }

  deleteTexture(handle: TextureHandle): void {
    this.flush();
    if (this.curTex === handle) this.curTex = null;
    this.gl.deleteTexture(handle.tex);
  }

  /** Set palette from 256*3 8-bit RGB values. */
  setPalette(rgb: Uint8Array | number[]): void {
    for (let i = 0; i < 256; i++) {
      this.palette[i * 4] = rgb[i * 3];
      this.palette[i * 4 + 1] = rgb[i * 3 + 1];
      this.palette[i * 4 + 2] = rgb[i * 3 + 2];
      this.palette[i * 4 + 3] = 255;
    }
    this.paletteDirty = true;
  }

  setPaletteEntry(i: number, r: number, g: number, b: number): void {
    this.palette[i * 4] = r;
    this.palette[i * 4 + 1] = g;
    this.palette[i * 4 + 2] = b;
    this.paletteDirty = true;
  }

  markPaletteDirty(): void {
    this.paletteDirty = true;
  }

  private inFrame = false;

  beginFrame(): void {
    const gl = this.gl;
    this.inFrame = true;
    this.drawCalls = 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, SCREEN_W, SCREEN_H);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(this.spriteProg);
    gl.uniform2f(this.uTargetLoc, SCREEN_W, SCREEN_H);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.remapTex);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.vao);
    this.curTex = null;
    this.clip = null;
  }

  /** Restrict drawing to a rectangle (screen coords, y down) or pass null to disable. */
  setClip(x0: number, y0: number, x1: number, y1: number): void;
  setClip(none: null): void;
  setClip(x0: number | null, y0 = 0, x1 = 0, y1 = 0): void {
    this.flush();
    const gl = this.gl;
    if (x0 === null) {
      this.clip = null;
      gl.disable(gl.SCISSOR_TEST);
      return;
    }
    this.clip = [x0, y0, x1, y1];
    gl.enable(gl.SCISSOR_TEST);
    // index target is stored y-up in GL; our projection maps screen y down to GL y up via flip below
    gl.scissor(x0, SCREEN_H - y1, Math.max(0, x1 - x0), Math.max(0, y1 - y0));
  }

  private push(tex: TextureHandle | null, dx: number, dy: number, w: number, h: number, sx: number, sy: number, layer: number, modeParam: number): void {
    if (w <= 0 || h <= 0) return;
    this.needsPresent = true;
    // drawing between frames (e.g. before the first one) goes into the persistent index buffer
    if (!this.inFrame) this.beginFrame();
    if (tex !== this.curTex && tex !== null) {
      this.flush();
      this.curTex = tex;
    }
    if (this.count >= MAX_INSTANCES) this.flush();
    const o = this.count * INSTANCE_INTS;
    const a = this.inst;
    // flip y so that screen y=0 is the top row of the index buffer as read back by the present pass
    a[o] = dx;
    a[o + 1] = SCREEN_H - dy - h;
    a[o + 2] = w;
    a[o + 3] = h;
    a[o + 4] = sx;
    a[o + 5] = sy;
    a[o + 6] = layer;
    a[o + 7] = modeParam;
    this.count++;
  }

  /**
   * Draw a w*h region of an indexed texture layer at (dx,dy) (top-left, screen pixels, y down).
   * Source rows are stored top-down in the texture.
   */
  draw(tex: TextureHandle, layer: number, sx: number, sy: number, w: number, h: number, dx: number, dy: number, remap = 0, mode: DrawMode = DrawMode.Sprite): void {
    this.pushFlipped(tex, dx, dy, w, h, sx, sy, layer, (mode << 12) | remap);
  }

  /** Draw with a solid color where the source texel is non-zero. */
  drawMask(tex: TextureHandle, layer: number, sx: number, sy: number, w: number, h: number, dx: number, dy: number, color: number): void {
    this.pushFlipped(tex, dx, dy, w, h, sx, sy, layer, (DrawMode.Mask << 12) | color);
  }

  fillRect(x: number, y: number, w: number, h: number, color: number): void {
    let x0 = Math.max(0, x), y0 = Math.max(0, y);
    const x1 = Math.min(SCREEN_W, x + w), y1 = Math.min(SCREEN_H, y + h);
    if (x1 <= x0 || y1 <= y0) return;
    this.push(this.curTex ?? this.dummy, x0, y0, x1 - x0, y1 - y0, 0, 0, 0, (DrawMode.Fill << 12) | color);
  }

  // Clips against the screen (so negative positions fit Int16 storage) and queues the quad.
  private pushFlipped(tex: TextureHandle, dx: number, dy: number, w: number, h: number, sx: number, sy: number, layer: number, modeParam: number): void {
    // Clip against the screen so that negative positions work with Int16 storage and partial sprites.
    let x0 = dx, y0 = dy, x1 = dx + w, y1 = dy + h;
    if (x0 < 0) { sx -= x0; x0 = 0; }
    if (y0 < 0) { sy -= y0; y0 = 0; }
    if (x1 > SCREEN_W) x1 = SCREEN_W;
    if (y1 > SCREEN_H) y1 = SCREEN_H;
    if (x1 <= x0 || y1 <= y0) return;
    this.push(tex, x0, y0, x1 - x0, y1 - y0, sx, sy, layer, modeParam);
  }

  flush(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    if (this.curTex) {
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.curTex.tex);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.inst, 0, this.count * INSTANCE_INTS);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.drawCalls++;
    this.count = 0;
  }

  /** Resize the canvas backing store to match its CSS size and compute the game viewport. */
  layout(cssW: number, cssH: number, dpr: number, integerScale = false): void {
    const pw = Math.max(1, Math.round(cssW * dpr));
    const ph = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      this.canvas.width = pw;
      this.canvas.height = ph;
    }
    let scale = Math.min(pw / SCREEN_W, ph / SCREEN_H);
    if (integerScale && scale >= 1) scale = Math.floor(scale);
    const w = Math.round(SCREEN_W * scale);
    const h = Math.round(SCREEN_H * scale);
    const x = Math.floor((pw - w) / 2);
    const y = Math.floor((ph - h) / 2);
    this.viewportPx = { x, y, w, h, scale };
    this.viewport = { x: x / dpr, y: y / dpr, w: w / dpr, h: h / dpr, scale: scale / dpr };
    this.needsPresent = true;
  }

  private viewportPx = { x: 0, y: 0, w: SCREEN_W, h: SCREEN_H, scale: 1 };
  /** something was drawn, or the palette or canvas size changed, since the last present */
  private needsPresent = true;

  endFrame(): void {
    this.flush();
    this.inFrame = false;
    // Display frames without new content (a 120 Hz screen shows each 60 Hz game frame twice) present
    // nothing: the canvas keeps showing the previous picture.
    if (!this.needsPresent && !this.paletteDirty) return;
    this.needsPresent = false;
    const gl = this.gl;
    gl.disable(gl.SCISSOR_TEST);
    if (this.paletteDirty) {
      gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, this.palette);
      this.paletteDirty = false;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.presentProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.indexTex);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.paletteTex);
    gl.activeTexture(gl.TEXTURE0);
    const L = this.presentLocs;
    gl.uniform1i(L.uIndex, 0);
    gl.uniform1i(L.uPalette, 1);
    gl.uniform2f(L.uSrcSize, SCREEN_W, SCREEN_H);
    const v = this.viewportPx;
    // gl_FragCoord origin is bottom-left
    gl.uniform4f(L.uViewport, v.x, this.canvas.height - v.y - v.h, v.w, v.h);
    gl.uniform1f(L.uScale, v.scale);
    gl.uniform4f(L.uBorder, 0, 0, 0, 1);
    const integral = Math.abs(v.scale - Math.round(v.scale)) < 1e-6;
    gl.uniform1i(L.uSharp, this.sharp && !integral ? 1 : 0);
    gl.bindVertexArray(this.presentVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    this.drawCalls++;
  }

  /**
   * Copy what has been drawn so far into a 640x480 indexed texture (rows top-down, like every other
   * texture), so that a frozen screen can be redrawn under a modal dialog the way GNW keeps the window
   * contents below it. Pass the previous handle to reuse its storage.
   */
  snapshot(reuse: TextureHandle | null = null): TextureHandle {
    this.flush();
    const gl = this.gl;
    const handle = reuse ?? this.createIndexedTexture(SCREEN_W, SCREEN_H, [new Uint8Array(SCREEN_W * SCREEN_H)]);
    if (!this.snapFbo) this.snapFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.fbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, this.snapFbo);
    gl.framebufferTextureLayer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, handle.tex, 0, 0);
    const scissor = gl.isEnabled(gl.SCISSOR_TEST);
    gl.disable(gl.SCISSOR_TEST);
    // the index target is stored bottom-up: flip while copying
    gl.blitFramebuffer(0, 0, SCREEN_W, SCREEN_H, 0, SCREEN_H, SCREEN_W, 0, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    if (scissor) gl.enable(gl.SCISSOR_TEST);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    return handle;
  }

  private snapFbo: WebGLFramebuffer | null = null;

  /** Read back the current index buffer (for tests). Must be called after drawing, before endFrame. */
  readIndices(): Uint8Array {
    this.flush();
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    const rgba = new Uint8Array(SCREEN_W * SCREEN_H * 4);
    gl.readPixels(0, 0, SCREEN_W, SCREEN_H, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    const out = new Uint8Array(SCREEN_W * SCREEN_H);
    for (let y = 0; y < SCREEN_H; y++) {
      for (let x = 0; x < SCREEN_W; x++) {
        out[(SCREEN_H - 1 - y) * SCREEN_W + x] = rgba[(y * SCREEN_W + x) * 4];
      }
    }
    return out;
  }
}

export function identityTable(): Uint8Array {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) t[i] = i;
  return t;
}
