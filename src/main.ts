import { Hud, presetLabel } from "./hud";
import { Input, type Command } from "./input";
import { Renderer, QUALITIES, type Quality, type SkyMode } from "./renderer";
import { PRESETS, Simulation, type PresetId } from "./simulation";
import "./style.css";
import { dot } from "./vec3";

const FOV_MIN = (28 * Math.PI) / 180;
const FOV_MAX = (100 * Math.PI) / 180;
const FOV_DEFAULT = (68 * Math.PI) / 180;
const EXPOSURE = 1.15;
const POINTER_MARGIN = 52;

const canvas = document.querySelector<HTMLCanvasElement>("#view");
const fatal = document.querySelector<HTMLElement>("#fatal");
if (!canvas || !fatal) throw new Error("The page is missing its canvas.");
const view: HTMLCanvasElement = canvas;

let renderer: Renderer;
try {
  renderer = new Renderer(canvas);
} catch (error) {
  fatal.hidden = false;
  fatal.textContent =
    error instanceof Error ? error.message : "This browser cannot start the simulation.";
  throw error;
}

const sim = new Simulation();
const input = new Input(view, (command) => handleCommand(command));
const hud = new Hud((command) => handleCommand(command));

let fovY = FOV_DEFAULT;
let exposure = EXPOSURE;
let fade = 0;
let diskEnabled = true;
let skyMode: SkyMode = "stars";
let quality: Quality = "auto";
let helpVisible = window.matchMedia("(min-width: 1100px)").matches;
let framesPerSecond = 0;
let fpsElapsed = 0;
let fpsFrames = 0;
let lastFrame = performance.now();
let started = false;

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-hold]")) {
  const code = button.dataset.hold ?? "";
  const press = (event: PointerEvent): void => {
    button.setPointerCapture(event.pointerId);
    input.setVirtualKey(code, true);
  };
  const release = (): void => input.setVirtualKey(code, false);
  button.addEventListener("pointerdown", press);
  button.addEventListener("pointerup", release);
  button.addEventListener("pointercancel", release);
  button.addEventListener("lostpointercapture", release);
}

function targetExposure(): number {
  // Dim the picture when the sky ahead is strongly blueshifted, like an eye adapting.
  const shift = Math.min(12, Math.max(0.2, sim.zenithBlueshift()));
  return Math.min(4, Math.max(0.04, EXPOSURE / shift ** 3));
}

function loadPreset(preset: PresetId): void {
  sim.loadPreset(preset);
  fade = 0;
  exposure = targetExposure();
  hud.hideEnding();
  hud.toast(presetLabel(preset));
}

function handleCommand(command: Command): void {
  switch (command) {
    case "toggleWarp":
      sim.warp = !sim.warp;
      if (sim.warp) hud.hideEnding();
      break;
    case "toggleDrive":
      sim.drive = sim.drive === "assist" ? "manual" : "assist";
      hud.toast(sim.drive === "assist" ? "Flight assist: hold still with the engines" : "Free flight: engines push, gravity does the rest");
      break;
    case "toggleLock":
      sim.lockOnHole = !sim.lockOnHole;
      break;
    case "togglePause":
      sim.paused = !sim.paused;
      break;
    case "toggleHelp":
      helpVisible = !helpVisible;
      break;
    case "toggleDisk":
      diskEnabled = !diskEnabled;
      break;
    case "toggleSky":
      skyMode = skyMode === "stars" ? "grid" : "stars";
      break;
    case "cycleQuality": {
      const next = QUALITIES[(QUALITIES.indexOf(quality) + 1) % QUALITIES.length];
      quality = next;
      renderer.setQuality(next);
      hud.toast(`Render quality: ${next}`);
      break;
    }
    case "slower":
      sim.timeFactor = Math.max(0.25, sim.timeFactor / 2);
      hud.toast(sim.timeFactor === 1 ? "Normal time" : `Time ×${sim.timeFactor}`);
      break;
    case "faster":
      sim.timeFactor = Math.min(16, sim.timeFactor * 2);
      hud.toast(sim.timeFactor === 1 ? "Normal time" : `Time ×${sim.timeFactor}`);
      break;
    case "restart":
      loadPreset(sim.preset);
      break;
    case "preset1":
      loadPreset(PRESETS[0]);
      break;
    case "preset2":
      loadPreset(PRESETS[1]);
      break;
    case "preset3":
      loadPreset(PRESETS[2]);
      break;
    case "preset4":
      loadPreset(PRESETS[3]);
      break;
    default: {
      const unreachable: never = command;
      throw new Error(`Unknown command: ${String(unreachable)}`);
    }
  }
}

/** Screen offset of the "hole is that way" arrow, or null when the hole is already in view. */
function holeMarker(): { x: number; y: number; angle: number } | null {
  const direction = sim.holeDirection();
  const x = dot(direction, sim.orientation.right);
  const y = dot(direction, sim.orientation.up);
  const z = dot(direction, sim.orientation.forward);
  const width = view.clientWidth;
  const height = view.clientHeight;
  if (width < 2 || height < 2) return null;

  const tanHalf = Math.tan(fovY / 2);
  let dx: number;
  let dy: number;
  if (z > 0.05) {
    dx = (x / (z * tanHalf)) * (height / 2);
    dy = -(y / (z * tanHalf)) * (height / 2);
    if (Math.abs(dx) <= width / 2 - POINTER_MARGIN && Math.abs(dy) <= height / 2 - POINTER_MARGIN) {
      return null;
    }
  } else {
    dx = x;
    dy = -y;
  }
  const scale = Math.min(
    (width / 2 - POINTER_MARGIN) / Math.max(Math.abs(dx), 1e-6),
    (height / 2 - POINTER_MARGIN) / Math.max(Math.abs(dy), 1e-6),
  );
  return { x: dx * scale, y: dy * scale, angle: Math.atan2(dy, dx) + Math.PI / 2 };
}

function frame(now: number): void {
  const elapsed = (now - lastFrame) / 1000;
  lastFrame = now;
  // Keep the simulation in step with the clock even when a frame runs long,
  // but don't fast-forward after the tab has been in the background.
  const dt = Math.min(0.25, elapsed);
  if (started) renderer.reportFrameTime(elapsed * 1000);
  started = true;

  const wheel = input.takeWheel();
  if (wheel !== 0) fovY = Math.min(FOV_MAX, Math.max(FOV_MIN, fovY * Math.exp(wheel * 0.0008)));
  view.classList.toggle("dragging", input.dragging);

  const events = sim.update(dt, input.sample(dt, fovY));
  for (const event of events) {
    if (event === "singularity") hud.showEnding(sim.telemetry().timeInsideHorizon);
  }

  exposure += (targetExposure() - exposure) * (1 - Math.exp(-dt / 0.5));
  const fadingOut = sim.status === "singularity";
  fade += ((fadingOut ? 1 : 0) - fade) * (1 - Math.exp(-dt / 0.35));

  renderer.render({
    pos: sim.ship.pos,
    vel: sim.ship.p,
    right: sim.orientation.right,
    up: sim.orientation.up,
    forward: sim.orientation.forward,
    fovY,
    diskTime: sim.diskTime,
    exposure,
    fade,
    diskEnabled,
    skyMode,
  });

  fpsElapsed += elapsed;
  fpsFrames += 1;
  if (fpsElapsed >= 0.5) {
    framesPerSecond = fpsFrames / fpsElapsed;
    fpsElapsed = 0;
    fpsFrames = 0;
  }

  hud.setHolePointer(holeMarker());
  hud.update({
    telemetry: sim.telemetry(),
    preset: sim.preset,
    drive: sim.drive,
    warp: sim.warp,
    lockOnHole: sim.lockOnHole,
    paused: sim.paused,
    diskEnabled,
    skyMode,
    quality,
    helpVisible,
    timeFactor: sim.timeFactor,
    renderSize: renderer.renderSize,
    framesPerSecond,
  });

  requestAnimationFrame(frame);
}

requestAnimationFrame(frame);
