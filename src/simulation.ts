import { lookAlong, turn, type Orientation } from "./orientation";
import {
  advanceShip,
  assistAcceleration,
  circularOrbitProperVelocity,
  hoverAcceleration,
  hoverProperVelocity,
  lorentzGamma,
  R_ISCO,
  R_PHOTON_SPHERE,
  riverSpeed,
  RS,
  speedRelativeToStatic,
  timeDilation,
  type ShipState,
} from "./physics";
import { apparentDirection, launchRay } from "./raytrace";
import { addScaled, cross, dot, length, normalize, scale, type Vec3 } from "./vec3";

export type DriveMode = "assist" | "manual";
export type SimStatus = "flying" | "singularity";
export type SimEvent = "enteredHorizon" | "leftHorizon" | "singularity";
export type PresetId = "approach" | "orbit" | "photonSphere" | "plunge";
export type Region = "far" | "disk" | "insideIsco" | "insidePhotonSphere" | "insideHorizon";

export const PRESETS: readonly PresetId[] = ["approach", "orbit", "photonSphere", "plunge"];

export interface ControlInput {
  /** Requested motion along the camera's right, up and forward axes, each in [-1, 1]. */
  thrust: Vec3;
  boost: boolean;
  /** Camera rotation for this frame, radians. */
  yaw: number;
  pitch: number;
  roll: number;
}

export interface Telemetry {
  radius: number;
  region: Region;
  /** Speed relative to hovering observers, as a fraction of c. NaN inside the horizon. */
  speed: number;
  /** Speed at which space itself falls inward, as a fraction of c. */
  riverSpeed: number;
  /** Far-away seconds per on-board second. Infinite inside the horizon. */
  timeDilation: number;
  shipTime: number;
  farTime: number;
  /** Proper acceleration felt on board, in c^2 / r_s. */
  thrust: number;
  /** Thrust needed to hover here, in c^2 / r_s. Infinite inside the horizon. */
  hoverThrust: number;
  /** Radial tidal stretching per unit length, in c^2 / r_s^2. */
  tidal: number;
  /** Simulated r_s / c per real second. */
  rate: number;
  /** Ship time since the horizon was crossed, or null while outside. */
  timeInsideHorizon: number | null;
}

const R_SINGULARITY = 0.03;
const R_WARP_MIN = 0.06;
const R_MAX = 150;
export const R_MIN_DISPLAY = R_SINGULARITY;
export const R_MAX_DISPLAY = R_MAX;

const CRUISE_SPEED = 0.6;
const BOOST_SPEED = 0.97;
/** How quickly the flight assist reaches the requested velocity, per real second. */
const ASSIST_RESPONSE = 3.5;
/** Engine limit in c^2 / r_s; enough to hover down to about 1.004 r_s. */
const MAX_ENGINE_THRUST = 8;
const WARP_SPEED = 0.7;
/** Cap on how fast the disk may visibly spin, in r_s / c per real second. */
const MAX_DISK_RATE = 40;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Simulated time per real second, in r_s / c. The rate grows with distance:
 * the plunge near the singularity stays slow enough to watch, while the
 * flight in from deep space takes seconds rather than minutes.
 */
export function simulationRate(r: number): number {
  return Math.min(8, 0.45 * Math.max(r, 0.05) ** 0.85);
}

function regionAt(r: number): Region {
  if (r < RS) return "insideHorizon";
  if (r < R_PHOTON_SPHERE) return "insidePhotonSphere";
  if (r < R_ISCO) return "insideIsco";
  if (r < 14) return "disk";
  return "far";
}

export class Simulation {
  preset: PresetId = "approach";
  ship: ShipState = { pos: [0, 0, 20], p: [0, 0, 0], tau: 0, time: 0 };
  orientation: Orientation = lookAlong([0, 0, -1], [0, 1, 0]);
  drive: DriveMode = "assist";
  /** Unphysical drive that moves the ship freely, even out of the horizon. */
  warp = false;
  /** Keep the camera pointed at the hole. */
  lockOnHole = false;
  paused = false;
  timeFactor = 1;
  status: SimStatus = "flying";
  /** Coordinate time that drives the disk's rotation. */
  diskTime = 0;

  private thrust = 0;
  private horizonCrossingTau: number | null = null;

  constructor() {
    this.loadPreset("approach");
  }

  loadPreset(id: PresetId): void {
    const start = (pos: Vec3, p: Vec3, drive: DriveMode, lock: boolean, view: Orientation): void => {
      this.ship = { pos, p, tau: 0, time: 0 };
      this.drive = drive;
      this.lockOnHole = lock;
      this.orientation = view;
    };
    const towardsHole = (pos: Vec3, upHint: Vec3): Orientation => lookAlong(scale(pos, -1), upHint);
    const tilted = (r: number, degrees: number): Vec3 => {
      const a = (degrees * Math.PI) / 180;
      return [r * Math.cos(a), r * Math.sin(a), 0];
    };

    switch (id) {
      case "approach": {
        const pos: Vec3 = [0, 3.2, 22];
        start(pos, hoverProperVelocity(pos), "assist", false, towardsHole(pos, [0, 1, 0]));
        break;
      }
      case "orbit": {
        // Free-falling circular orbit, moving with the disk's rotation.
        const pos = tilted(5, 18);
        const p = circularOrbitProperVelocity(pos, [0, 0, -1]);
        start(pos, p, "manual", true, towardsHole(pos, [0, 1, 0]));
        break;
      }
      case "photonSphere": {
        // Hovering where light itself orbits: the shadow fills exactly half the sky.
        const pos = scale(normalize([1, 0.45, 0]), R_PHOTON_SPHERE);
        start(pos, hoverProperVelocity(pos), "assist", false, lookAlong([0, 0, -1], pos));
        break;
      }
      case "plunge": {
        // Released from rest with the engines off. The gaze is aimed beside the
        // hole so the shadow can be watched growing until it swallows the sky.
        const pos = tilted(10, 32);
        const radial = normalize(pos);
        const tangent = normalize(cross(radial, [0, 0, 1]));
        const gaze = normalize(addScaled(scale(radial, -1), tangent, Math.tan((48 * Math.PI) / 180)));
        start(pos, hoverProperVelocity(pos), "manual", false, lookAlong(gaze, [0, 1, 0]));
        break;
      }
      default: {
        const unreachable: never = id;
        throw new Error(`Unknown preset: ${String(unreachable)}`);
      }
    }
    this.preset = id;
    this.warp = false;
    this.paused = false;
    this.status = "flying";
    this.thrust = 0;
    this.diskTime = 0;
    this.horizonCrossingTau = null;
    this.aimAtHoleIfLocked();
  }

  /** Where the centre of the hole appears on board, in the ship's rest frame. */
  holeDirection(): Vec3 {
    return apparentDirection(this.ship.p, scale(normalize(this.ship.pos), -1));
  }

  /**
   * How much brighter than at rest far away the sky overhead appears (energy
   * ratio per photon). Used to adapt the exposure like an eye would.
   */
  zenithBlueshift(): number {
    const zenith = apparentDirection(this.ship.p, normalize(this.ship.pos));
    return 1 / launchRay(this.ship.pos, this.ship.p, zenith).energyAtInfinity;
  }

  update(dtReal: number, input: ControlInput): SimEvent[] {
    if (input.yaw !== 0 || input.pitch !== 0 || input.roll !== 0) {
      this.orientation = turn(this.orientation, input.yaw, input.pitch, input.roll);
      if (input.yaw !== 0 || input.pitch !== 0) this.lockOnHole = false;
    }
    // The singularity ends a real flight, but the warp drive may still leave it.
    if (this.paused || (this.status !== "flying" && !this.warp)) return [];
    if (this.status !== "flying") this.status = "flying";

    const events: SimEvent[] = [];
    const before = this.ship;
    const wasInside = length(before.pos) < RS;
    const rate = this.currentRate();
    // One frame must not fall from outside the horizon all the way to the
    // singularity, or the crossing is invisible and its clock reads zero.
    const dtau = Math.min(dtReal * rate, 0.18 * Math.max(length(before.pos), 0.08) ** 1.05);

    const { right, up, forward } = this.orientation;
    let direction = addScaled(addScaled(scale(right, input.thrust[0]), up, input.thrust[1]), forward, input.thrust[2]);
    const strength = length(direction);
    if (strength > 1) direction = scale(direction, 1 / strength);

    if (this.warp) {
      this.ship = this.warpStep(direction, input.boost, dtReal, dtau);
      this.thrust = 0;
    } else {
      const accel = this.engineAcceleration(direction, input.boost, rate);
      this.thrust = length(accel);
      this.ship = advanceShip(before, accel, dtau, R_SINGULARITY);
    }

    let r = length(this.ship.pos);
    if (r > R_MAX) {
      const pos = scale(this.ship.pos, R_MAX / r);
      this.ship = { ...this.ship, pos, p: hoverProperVelocity(pos) };
      r = R_MAX;
    }

    this.diskTime += Math.min(this.ship.time - before.time, MAX_DISK_RATE * dtReal);

    const isInside = r < RS;
    if (isInside && !wasInside) {
      const r0 = length(before.pos);
      const fraction = (r0 - RS) / Math.max(1e-9, r0 - r);
      this.horizonCrossingTau = before.tau + Math.min(1, Math.max(0, fraction)) * (this.ship.tau - before.tau);
      events.push("enteredHorizon");
    } else if (!isInside && wasInside) {
      this.horizonCrossingTau = null;
      events.push("leftHorizon");
    }
    if (r <= R_SINGULARITY) {
      this.status = "singularity";
      events.push("singularity");
    }

    this.aimAtHoleIfLocked();
    return events;
  }

  telemetry(): Telemetry {
    const r = length(this.ship.pos);
    const outside = r > RS;
    return {
      radius: r,
      region: regionAt(r),
      speed: speedRelativeToStatic(this.ship),
      riverSpeed: riverSpeed(r),
      timeDilation: timeDilation(this.ship),
      shipTime: this.ship.tau,
      farTime: this.ship.time,
      thrust: this.thrust,
      hoverThrust: outside ? hoverAcceleration(r) : Number.POSITIVE_INFINITY,
      tidal: RS / r ** 3,
      rate: this.paused || this.status !== "flying" ? 0 : this.currentRate(),
      timeInsideHorizon:
        this.horizonCrossingTau === null ? null : this.ship.tau - this.horizonCrossingTau,
    };
  }

  private currentRate(): number {
    return simulationRate(length(this.ship.pos)) * this.timeFactor;
  }

  private engineAcceleration(direction: Vec3, boost: boolean, rate: number): Vec3 {
    switch (this.drive) {
      case "assist": {
        const desired = scale(direction, boost ? BOOST_SPEED : CRUISE_SPEED);
        return assistAcceleration(this.ship, desired, ASSIST_RESPONSE / rate, MAX_ENGINE_THRUST);
      }
      case "manual": {
        // Scale the thrusters with local gravity so they stay useful everywhere.
        const r = length(this.ship.pos);
        const thrust = Math.min(MAX_ENGINE_THRUST, Math.max(0.01, RS / (r * r))) * (boost ? 4 : 1);
        return scale(direction, thrust);
      }
      default: {
        const unreachable: never = this.drive;
        throw new Error(`Unknown drive mode: ${String(unreachable)}`);
      }
    }
  }

  /**
   * Unphysical "warp" motion: the ship is simply moved through the coordinates.
   * The view is that of a hovering observer far out and blends into that of a
   * free-falling one near and inside the horizon, where nothing can hover.
   */
  private warpStep(direction: Vec3, boost: boolean, dtReal: number, dtau: number): ShipState {
    const { pos, p, tau, time } = this.ship;
    const r = length(pos);
    const speed = WARP_SPEED * Math.min(12, Math.max(0.3, r)) * (boost ? 2.5 : 1);
    let next = addScaled(pos, direction, speed * dtReal);
    const nextR = length(next);
    if (nextR < R_WARP_MIN) next = scale(next, R_WARP_MIN / nextR);

    const hoverWeight = smoothstep(1.3, 2.5, length(next));
    const target: Vec3 = hoverWeight > 0 ? scale(hoverProperVelocity(next), hoverWeight) : [0, 0, 0];
    const blend = 1 - Math.exp(-5 * dtReal);
    const nextP = addScaled(p, [target[0] - p[0], target[1] - p[1], target[2] - p[2]], blend);
    return { pos: next, p: nextP, tau: tau + dtau, time: time + lorentzGamma(nextP) * dtau };
  }

  private aimAtHoleIfLocked(): void {
    if (!this.lockOnHole) return;
    const target = this.holeDirection();
    // Keep the horizon level unless the hole is straight above or below.
    const upHint = Math.abs(dot(target, this.orientation.up)) > 0.999 ? this.orientation.right : this.orientation.up;
    this.orientation = lookAlong(target, upHint);
  }
}
