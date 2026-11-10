import { type Command } from "./input";
import { R_ISCO, R_PHOTON_SPHERE, RS } from "./physics";
import { type Quality, type SkyMode } from "./renderer";
import {
  PRESETS,
  R_MAX_DISPLAY,
  R_MIN_DISPLAY,
  type DriveMode,
  type PresetId,
  type Region,
  type Telemetry,
} from "./simulation";

/**
 * Physical scale used for the read-outs: Sagittarius A*, the 4.3 million
 * solar mass black hole at the centre of the Milky Way.
 */
const RS_KM = 1.2703e7;
const RS_OVER_C_SECONDS = 42.37;
/** c^2 / r_s in units of Earth gravity. */
const THRUST_UNIT_G = 7.215e5;
/** c^2 / r_s^2 in Earth gravities per metre. */
const TIDAL_UNIT_G_PER_M = 5.68e-5;
/** Longest possible proper time between horizon and singularity: pi/2 r_s / c. */
const MAX_SURVIVAL_SECONDS = (Math.PI / 2) * RS_OVER_C_SECONDS;

const DISK_OUTER = 14;
const TOAST_MILLISECONDS = 3200;

export interface HudState {
  telemetry: Telemetry;
  preset: PresetId;
  drive: DriveMode;
  warp: boolean;
  lockOnHole: boolean;
  paused: boolean;
  diskEnabled: boolean;
  skyMode: SkyMode;
  quality: Quality;
  helpVisible: boolean;
  timeFactor: number;
  renderSize: { width: number; height: number };
  framesPerSecond: number;
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing element #${id}`);
  return found as T;
}

const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function significant(value: number, digits: number): string {
  return new Intl.NumberFormat("en-US", { maximumSignificantDigits: digits }).format(value);
}

function formatDistance(km: number): string {
  if (km >= 1e6) return `${significant(km / 1e6, 3)} million km`;
  return `${integer.format(km)} km`;
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "∞";
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ${Math.floor(seconds % 60)} s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${significant(seconds / 86400, 3)} days`;
}

const SUPERSCRIPTS = "⁰¹²³⁴⁵⁶⁷⁸⁹";

/** Compact number: fixed figures for everyday values, powers of ten otherwise. */
export function formatMagnitude(value: number): string {
  if (value === 0) return "0";
  const exp = Math.floor(Math.log10(value));
  if (exp >= -2 && exp < 4) return significant(value, 2);
  const digits = String(Math.abs(exp))
    .split("")
    .map((digit) => SUPERSCRIPTS[Number(digit)])
    .join("");
  return `${(value / 10 ** exp).toFixed(1)}×10${exp < 0 ? "⁻" : ""}${digits}`;
}

function formatG(g: number): string {
  if (!Number.isFinite(g)) return "∞";
  if (g >= 1e6) return `${significant(g / 1e6, 3)} million g`;
  if (g >= 100) return `${integer.format(Number(g.toPrecision(3)))} g`;
  return `${formatMagnitude(g)} g`;
}

function regionLabel(region: Region): string {
  switch (region) {
    case "far":
      return "Deep space";
    case "disk":
      return "Over the disk";
    case "insideIsco":
      return "No stable orbits";
    case "insidePhotonSphere":
      return "Inside photon sphere";
    case "insideHorizon":
      return "Inside horizon";
    default: {
      const unreachable: never = region;
      throw new Error(`Unknown region: ${String(unreachable)}`);
    }
  }
}

export function presetLabel(preset: PresetId): string {
  switch (preset) {
    case "approach":
      return "Approach: hovering 22 Schwarzschild radii out";
    case "orbit":
      return "Orbit: coasting on a circular orbit, engines off";
    case "photonSphere":
      return "Photon sphere: the hole's shadow fills half the sky";
    case "plunge":
      return "Free fall: released from rest, engines off";
    default: {
      const unreachable: never = preset;
      throw new Error(`Unknown preset: ${String(unreachable)}`);
    }
  }
}

function gaugeFraction(r: number): number {
  const clamped = Math.min(R_MAX_DISPLAY, Math.max(R_MIN_DISPLAY, r));
  return Math.log(clamped / R_MIN_DISPLAY) / Math.log(R_MAX_DISPLAY / R_MIN_DISPLAY);
}

const percent = (fraction: number): string => `${(fraction * 100).toFixed(2)}%`;

export class Hud {
  private readonly region = element("region");
  private readonly radius = element("t-radius");
  private readonly radiusKm = element("t-radius-km");
  private readonly speed = element("t-speed");
  private readonly river = element("t-river");
  private readonly dilation = element("t-dilation");
  private readonly shipTime = element("t-ship-time");
  private readonly farTime = element("t-far-time");
  private readonly thrust = element("t-thrust");
  private readonly hover = element("t-hover");
  private readonly tidal = element("t-tidal");
  private readonly render = element("t-render");
  private readonly marker = element("gauge-marker");
  private readonly banner = element("banner");
  private readonly toastElement = element("toast");
  private readonly help = element("help");
  private readonly pointer = element("hole-pointer");
  private readonly ending = element("ending");
  private readonly endingText = element("ending-text");
  private toastTimer = 0;
  private bannerKey = "";

  constructor(onCommand: (command: Command) => void) {
    element("gauge-horizon").style.width = percent(gaugeFraction(RS));
    const disk = element("gauge-disk");
    disk.style.left = percent(gaugeFraction(R_ISCO));
    disk.style.width = percent(gaugeFraction(DISK_OUTER) - gaugeFraction(R_ISCO));
    element("gauge-tick-horizon").style.left = percent(gaugeFraction(RS));
    element("gauge-tick-photon").style.left = percent(gaugeFraction(R_PHOTON_SPHERE));
    element("gauge-tick-isco").style.left = percent(gaugeFraction(R_ISCO));

    for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-command]")) {
      button.addEventListener("click", () => {
        onCommand(button.dataset.command as Command);
        // Hand the keyboard back to the cockpit so Space does not re-trigger the button.
        button.blur();
      });
    }
  }

  update(state: HudState): void {
    const t = state.telemetry;
    const inside = t.region === "insideHorizon";

    this.region.textContent = regionLabel(t.region);
    this.region.dataset.region = t.region;
    this.marker.style.left = percent(gaugeFraction(t.radius));

    this.radius.innerHTML = `${t.radius.toFixed(t.radius < 10 ? 3 : 2)} r<sub>s</sub>`;
    this.radiusKm.textContent = formatDistance(t.radius * RS_KM);
    this.speed.textContent = inside ? "nothing can hover here" : `${t.speed.toFixed(3)} c`;
    this.river.textContent = `${t.riverSpeed.toFixed(3)} c`;
    this.dilation.textContent = inside
      ? "never seen from outside"
      : t.timeDilation < 60
        ? `${t.timeDilation.toFixed(3)} s`
        : formatDuration(t.timeDilation);
    this.shipTime.textContent = formatDuration(t.shipTime * RS_OVER_C_SECONDS);
    this.farTime.textContent = formatDuration(t.farTime * RS_OVER_C_SECONDS);
    this.thrust.textContent = state.warp ? "warp" : formatG(t.thrust * THRUST_UNIT_G);
    this.hover.textContent = inside ? "hovering impossible" : `hover needs ${formatG(t.hoverThrust * THRUST_UNIT_G)}`;
    this.tidal.textContent = `${formatMagnitude(t.tidal * TIDAL_UNIT_G_PER_M)} g per metre`;

    const { width, height } = state.renderSize;
    const speedNote = state.timeFactor === 1 ? "" : ` · time ×${state.timeFactor}`;
    this.render.textContent = `${width}×${height} · ${Math.round(state.framesPerSecond)} fps${speedNote}`;

    for (const [index, preset] of PRESETS.entries()) {
      element(`btn-preset-${index + 1}`).setAttribute("aria-pressed", String(preset === state.preset));
    }
    this.setButton("btn-drive", state.drive === "assist" ? "Flight assist" : "Free flight", state.drive === "assist");
    this.setButton("btn-warp", "Warp drive", state.warp);
    this.setButton("btn-lock", "Track hole", state.lockOnHole);
    this.setButton("btn-disk", "Disk", state.diskEnabled);
    this.setButton("btn-sky", state.skyMode === "grid" ? "Grid sky" : "Star sky", state.skyMode === "grid");
    this.setButton("btn-quality", `Quality: ${state.quality}`, false);
    this.setButton("btn-pause", state.paused ? "Resume" : "Pause", state.paused);
    this.setButton("btn-help", "Help", state.helpVisible);
    this.help.hidden = !state.helpVisible;

    this.updateBanner(state, inside);
  }

  toast(text: string): void {
    this.toastElement.textContent = text;
    this.toastElement.classList.add("visible");
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => this.toastElement.classList.remove("visible"), TOAST_MILLISECONDS);
  }

  /** Point towards the hole from the screen centre, or hide the arrow with `null`. */
  setHolePointer(placement: { x: number; y: number; angle: number } | null): void {
    this.pointer.hidden = placement === null;
    if (placement) {
      this.pointer.style.transform = `translate(${placement.x.toFixed(1)}px, ${placement.y.toFixed(1)}px) rotate(${placement.angle.toFixed(3)}rad)`;
    }
  }

  showEnding(timeInsideHorizon: number | null): void {
    const survived =
      timeInsideHorizon === null
        ? "Your ship reached the singularity."
        : `Your ship reached the singularity ${formatDuration(timeInsideHorizon * RS_OVER_C_SECONDS)} of ship time after crossing the horizon.`;
    this.endingText.textContent = `${survived} Inside a hole this size no trajectory, with or without engines, lasts longer than ${Math.round(MAX_SURVIVAL_SECONDS)} seconds.`;
    this.ending.hidden = false;
    this.banner.style.visibility = "hidden";
  }

  hideEnding(): void {
    this.ending.hidden = true;
    this.banner.style.visibility = "";
  }

  private setButton(id: string, label: string, pressed: boolean): void {
    const button = element(id);
    const span = button.querySelector("span");
    if (span && span.textContent !== label) span.textContent = label;
    button.setAttribute("aria-pressed", String(pressed));
  }

  private updateBanner(state: HudState, inside: boolean): void {
    let kind = "";
    let title = "";
    let body = "";
    if (state.warp) {
      kind = "warp";
      title = "Warp drive engaged";
      body = "Physics is suspended: fly anywhere, even back out through the horizon. Press Space to return to real spacetime.";
    } else if (inside) {
      kind = "horizon";
      title = "Inside the event horizon";
      body = "Every path now leads to the singularity and no engine can change that. Press Space for the warp drive, which ignores physics, to fly back out.";
    } else if (state.paused) {
      kind = "paused";
      title = "Paused";
      body = "You can still look around. Press P to resume.";
    }
    if (kind === this.bannerKey) return;
    this.bannerKey = kind;
    this.banner.replaceChildren();
    this.banner.dataset.kind = kind;
    if (!kind) return;
    const heading = document.createElement("strong");
    heading.textContent = title;
    this.banner.append(heading, body);
  }
}
