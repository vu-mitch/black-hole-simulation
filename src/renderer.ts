import bloomDownSource from "./shaders/bloom_down.frag?raw";
import bloomUpSource from "./shaders/bloom_up.frag?raw";
import commonSource from "./shaders/common.glsl?raw";
import compositeSource from "./shaders/composite.frag?raw";
import vertexSource from "./shaders/fullscreen.vert?raw";
import sceneSource from "./shaders/scene.frag?raw";
import { type Vec3 } from "./vec3";

export type SkyMode = "stars" | "grid";
export type Quality = "auto" | "low" | "medium" | "high";

export const QUALITIES: readonly Quality[] = ["auto", "low", "medium", "high"];

export interface FrameParams {
  pos: Vec3;
  /** Proper velocity relative to the local free-fall frame. */
  vel: Vec3;
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  /** Vertical field of view in radians. */
  fovY: number;
  /** Coordinate time driving the disk's rotation. */
  diskTime: number;
  exposure: number;
  /** 0 shows the scene, 1 is black. */
  fade: number;
  diskEnabled: boolean;
  skyMode: SkyMode;
}

interface QualitySettings {
  /** Fixed render scale, or null to adapt it to the frame rate. */
  scale: number | null;
  maxSteps: number;
  maxPixelRatio: number;
}

function qualitySettings(quality: Quality): QualitySettings {
  switch (quality) {
    case "auto":
      return { scale: null, maxSteps: 160, maxPixelRatio: 1.5 };
    case "low":
      return { scale: 0.4, maxSteps: 96, maxPixelRatio: 1 };
    case "medium":
      return { scale: 0.7, maxSteps: 160, maxPixelRatio: 1.5 };
    case "high":
      return { scale: 1, maxSteps: 224, maxPixelRatio: 2 };
    default: {
      const unreachable: never = quality;
      throw new Error(`Unknown quality: ${String(unreachable)}`);
    }
  }
}

const BLOOM_LEVELS = 4;
const BLOOM_THRESHOLD = 1.6;
const BLOOM_STRENGTH = 0.4;

/** The disk texture shears as it orbits; two layers restart alternately on this period to hide it. */
const DISK_CYCLE = 36;

const MIN_AUTO_SCALE = 0.35;
/** Shortest side of the ray-traced image while quality is automatic. */
const MIN_AUTO_SHORT_SIDE = 400;
const AUTO_SAMPLE_FRAMES = 20;
const SLOW_FRAME_MS = 22;
const FAST_FRAME_MS = 17.5;

interface Target {
  framebuffer: WebGLFramebuffer;
  texture: WebGLTexture;
  width: number;
  height: number;
}

class Program {
  private readonly locations = new Map<string, WebGLUniformLocation | null>();

  constructor(
    private readonly gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram,
  ) {}

  uniform(name: string): WebGLUniformLocation | null {
    let location = this.locations.get(name);
    if (location === undefined) {
      location = this.gl.getUniformLocation(this.handle, name);
      this.locations.set(name, location);
    }
    return location;
  }
}

function compileShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader failed to compile: ${log}`);
  }
  return shader;
}

export class Renderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly hdr: boolean;
  private readonly scene: Program;
  private readonly bloomDown: Program;
  private readonly bloomUp: Program;
  private readonly composite: Program;

  private sceneTarget: Target | null = null;
  private downTargets: Target[] = [];
  private upTargets: Target[] = [];

  private quality: Quality = "auto";
  private settings = qualitySettings("auto");
  private autoScale = 0.75;
  private sampledFrames = 0;
  private sampledTime = 0;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "high-performance",
    });
    if (!gl) throw new Error("WebGL 2 is not available in this browser.");
    this.gl = gl;
    this.hdr = gl.getExtension("EXT_color_buffer_float") !== null;

    this.scene = this.createProgram(sceneSource);
    this.bloomDown = this.createProgram(bloomDownSource);
    this.bloomUp = this.createProgram(bloomUpSource);
    this.composite = this.createProgram(compositeSource);

    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /** Size of the ray-traced image in pixels. */
  get renderSize(): { width: number; height: number } {
    return { width: this.sceneTarget?.width ?? 0, height: this.sceneTarget?.height ?? 0 };
  }

  setQuality(quality: Quality): void {
    this.quality = quality;
    this.settings = qualitySettings(quality);
    this.sampledFrames = 0;
    this.sampledTime = 0;
  }

  /** Feed the time between frames so the "auto" quality can track the display's frame rate. */
  reportFrameTime(milliseconds: number): void {
    if (this.settings.scale !== null) return;
    this.sampledFrames++;
    this.sampledTime += milliseconds;
    if (this.sampledFrames < AUTO_SAMPLE_FRAMES) return;
    const average = this.sampledTime / this.sampledFrames;
    this.sampledFrames = 0;
    this.sampledTime = 0;
    const floor = this.autoScaleFloor();
    if (average > SLOW_FRAME_MS) {
      // Pixel count scales with the square of the render scale.
      const correction = Math.sqrt(FAST_FRAME_MS / average);
      this.autoScale = Math.max(floor, this.autoScale * Math.max(0.8, correction));
    } else if (average < FAST_FRAME_MS) {
      this.autoScale = Math.min(1, this.autoScale * 1.06);
    }
  }

  render(params: FrameParams): void {
    const gl = this.gl;
    this.resize();
    const sceneTarget = this.sceneTarget;
    if (!sceneTarget) return;

    const tanHalfFov = Math.tan(params.fovY / 2);
    const cycle = params.diskTime / DISK_CYCLE;
    const cycleA = Math.floor(cycle);
    const cycleB = Math.floor(cycle + 0.5);
    const phaseA = cycle - cycleA;
    const phaseB = cycle + 0.5 - cycleB;
    const weightA = 1 - Math.abs(2 * phaseA - 1);

    this.bind(sceneTarget);
    gl.useProgram(this.scene.handle);
    gl.uniform2f(this.scene.uniform("uResolution"), sceneTarget.width, sceneTarget.height);
    gl.uniform3fv(this.scene.uniform("uPos"), params.pos);
    gl.uniform3fv(this.scene.uniform("uVel"), params.vel);
    gl.uniformMatrix3fv(
      this.scene.uniform("uCamera"),
      false,
      new Float32Array([...params.right, ...params.up, ...params.forward]),
    );
    gl.uniform1f(this.scene.uniform("uTanHalfFov"), tanHalfFov);
    gl.uniform1f(this.scene.uniform("uPixelAngle"), (2 * tanHalfFov) / sceneTarget.height);
    gl.uniform4f(
      this.scene.uniform("uDiskPhase"),
      phaseA * DISK_CYCLE,
      phaseB * DISK_CYCLE,
      weightA,
      1 - weightA,
    );
    gl.uniform2f(this.scene.uniform("uDiskSeed"), (cycleA * 2) % 61, (cycleB * 2 + 1) % 61);
    gl.uniform1f(this.scene.uniform("uDiskEnabled"), params.diskEnabled ? 1 : 0);
    gl.uniform1i(this.scene.uniform("uSkyMode"), params.skyMode === "grid" ? 1 : 0);
    gl.uniform1i(this.scene.uniform("uMaxSteps"), this.settings.maxSteps);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    this.renderBloom(sceneTarget);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.useProgram(this.composite.handle);
    this.bindTexture(0, sceneTarget.texture, this.composite.uniform("uScene"));
    this.bindTexture(1, this.upTargets[0].texture, this.composite.uniform("uBloom"));
    gl.uniform1f(this.composite.uniform("uBloomStrength"), BLOOM_STRENGTH);
    gl.uniform1f(this.composite.uniform("uExposure"), params.exposure);
    gl.uniform1f(this.composite.uniform("uFade"), params.fade);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /** Render a frame and read back the canvas (bottom row first). For verification tooling. */
  capture(params: FrameParams): { width: number; height: number; pixels: Uint8Array } {
    this.render(params);
    const { width, height } = this.canvas;
    const pixels = new Uint8Array(width * height * 4);
    this.gl.readPixels(0, 0, width, height, this.gl.RGBA, this.gl.UNSIGNED_BYTE, pixels);
    return { width, height, pixels };
  }

  private renderBloom(sceneTarget: Target): void {
    const gl = this.gl;
    gl.useProgram(this.bloomDown.handle);
    let source = sceneTarget;
    this.downTargets.forEach((target, level) => {
      this.bind(target);
      this.bindTexture(0, source.texture, this.bloomDown.uniform("uSource"));
      gl.uniform2f(this.bloomDown.uniform("uTexel"), 1 / source.width, 1 / source.height);
      gl.uniform1f(this.bloomDown.uniform("uThreshold"), level === 0 ? BLOOM_THRESHOLD : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = target;
    });

    gl.useProgram(this.bloomUp.handle);
    for (let level = this.upTargets.length - 1; level >= 0; level--) {
      const target = this.upTargets[level];
      this.bind(target);
      this.bindTexture(0, source.texture, this.bloomUp.uniform("uSource"));
      this.bindTexture(1, this.downTargets[level].texture, this.bloomUp.uniform("uBase"));
      gl.uniform2f(this.bloomUp.uniform("uTexel"), 1 / source.width, 1 / source.height);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      source = target;
    }
  }

  /** Lowest automatic scale that still keeps the shadow larger than the bloom. */
  private autoScaleFloor(): number {
    const shortSide = Math.min(this.canvas.clientWidth, this.canvas.clientHeight);
    if (shortSide <= 0) return MIN_AUTO_SCALE;
    return Math.min(1, Math.max(MIN_AUTO_SCALE, MIN_AUTO_SHORT_SIDE / shortSide));
  }

  /** Ray-traced pixels per frame. Keeps a 4K window from tracing 4K rays. */
  private pixelBudget(): number {
    switch (this.quality) {
      case "low":
        return 960 * 540;
      case "medium":
      case "auto":
        return 1280 * 720;
      case "high":
        return 1920 * 1080;
      default: {
        const unreachable: never = this.quality;
        throw new Error(`Unknown quality: ${String(unreachable)}`);
      }
    }
  }

  private resize(): void {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.settings.maxPixelRatio);
    const width = Math.max(1, Math.round(this.canvas.clientWidth * pixelRatio));
    const height = Math.max(1, Math.round(this.canvas.clientHeight * pixelRatio));
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const scale = this.settings.scale ?? Math.max(this.autoScale, this.autoScaleFloor());
    // Snap to multiples of 8 so small changes of the scale do not reallocate every time.
    let sceneWidth = Math.max(64, Math.round((width * scale) / 8) * 8);
    let sceneHeight = Math.max(36, Math.round((height * scale) / 8) * 8);
    const budget = this.pixelBudget();
    if (sceneWidth * sceneHeight > budget) {
      const fit = Math.sqrt(budget / (sceneWidth * sceneHeight));
      sceneWidth = Math.max(64, Math.round((sceneWidth * fit) / 8) * 8);
      sceneHeight = Math.max(36, Math.round((sceneHeight * fit) / 8) * 8);
    }
    if (this.sceneTarget?.width === sceneWidth && this.sceneTarget.height === sceneHeight) return;

    for (const target of [this.sceneTarget, ...this.downTargets, ...this.upTargets]) {
      if (target) this.deleteTarget(target);
    }
    this.sceneTarget = this.createTarget(sceneWidth, sceneHeight);
    this.downTargets = [];
    this.upTargets = [];
    let w = sceneWidth;
    let h = sceneHeight;
    for (let level = 0; level < BLOOM_LEVELS; level++) {
      w = Math.max(2, w >> 1);
      h = Math.max(2, h >> 1);
      this.downTargets.push(this.createTarget(w, h));
    }
    // The smallest level is only ever read, so it needs no upsample target.
    for (let level = 0; level < BLOOM_LEVELS - 1; level++) {
      const { width: levelWidth, height: levelHeight } = this.downTargets[level];
      this.upTargets.push(this.createTarget(levelWidth, levelHeight));
    }
  }

  private createProgram(fragmentBody: string): Program {
    const gl = this.gl;
    const fragmentSource = [
      "#version 300 es",
      this.hdr ? "" : "#define LDR_BUFFERS",
      "precision highp float;",
      commonSource,
      fragmentBody,
    ].join("\n");
    const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
    const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const handle = gl.createProgram();
    if (!handle) throw new Error("Could not create shader program");
    gl.attachShader(handle, vertex);
    gl.attachShader(handle, fragment);
    gl.linkProgram(handle);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(handle, gl.LINK_STATUS)) {
      throw new Error(`Shader program failed to link: ${gl.getProgramInfoLog(handle)}`);
    }
    return new Program(gl, handle);
  }

  private createTarget(width: number, height: number): Target {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error("Could not create render target");
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (this.hdr) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      throw new Error("Render target is incomplete");
    }
    return { framebuffer, texture, width, height };
  }

  private deleteTarget(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }

  private bind(target: Target): void {
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, target.framebuffer);
    this.gl.viewport(0, 0, target.width, target.height);
  }

  private bindTexture(unit: number, texture: WebGLTexture, location: WebGLUniformLocation | null): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(location, unit);
  }
}
