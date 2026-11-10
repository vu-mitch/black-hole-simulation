/**
 * Flight dynamics around a Schwarzschild black hole.
 *
 * Units: G = c = 1 and the Schwarzschild radius r_s = 1 (so M = 1/2).
 *
 * Everything is expressed in Gullstrand–Painlevé coordinates ("river model"):
 * space is flat and flows radially inward with speed beta = sqrt(r_s / r).
 * These coordinates are regular across the event horizon, so the same
 * equations work outside and inside the hole. The ship state is its position
 * and its proper velocity p = gamma * w relative to the local free-fall
 * ("rain") frame, whose axes coincide with the flat coordinate axes.
 *
 * Equations of motion in proper time tau (verified to conserve energy and
 * angular momentum):
 *
 *   dx/dtau = p - beta * gamma * rhat
 *   dp/dtau = gamma * (beta / r) * (p - 3/2 (p . rhat) rhat) + thrust
 *   dT/dtau = gamma
 */
import { addScaled, dot, length, normalize, scale, type Vec3 } from "./vec3";

export const RS = 1;
export const R_PHOTON_SPHERE = 1.5 * RS;
export const R_ISCO = 3 * RS;
/** Critical impact parameter: light with b < B_CRIT is captured. */
export const B_CRIT = ((3 * Math.sqrt(3)) / 2) * RS;

export interface ShipState {
  /** Position in flat Gullstrand–Painlevé Cartesian coordinates. */
  pos: Vec3;
  /** Proper velocity (gamma * v) relative to the local free-fall frame. */
  p: Vec3;
  /** Proper time experienced on board. */
  tau: number;
  /** Gullstrand–Painlevé coordinate time (drives the accretion disk). */
  time: number;
}

export const riverSpeed = (r: number): number => Math.sqrt(RS / r);

export const lorentzGamma = (p: Vec3): number => Math.sqrt(1 + dot(p, p));

/** Free-fall (geodesic) rate of change of p. */
export function geodesicForce(pos: Vec3, p: Vec3): Vec3 {
  const r = length(pos);
  const rhat = scale(pos, 1 / r);
  const beta = riverSpeed(r);
  const gamma = lorentzGamma(p);
  return scale(addScaled(p, rhat, -1.5 * dot(p, rhat)), (gamma * beta) / r);
}

/** Spatial rain-frame components of the 4-acceleration for a proper acceleration `a` felt on board. */
export function thrustToRainFrame(p: Vec3, a: Vec3): Vec3 {
  return addScaled(a, p, dot(p, a) / (lorentzGamma(p) + 1));
}

/** Inverse of {@link thrustToRainFrame}. */
export function rainFrameToThrust(p: Vec3, A: Vec3): Vec3 {
  const gamma = lorentzGamma(p);
  return addScaled(A, p, -dot(p, A) / (gamma * (gamma + 1)));
}

interface Derivative {
  dpos: Vec3;
  dp: Vec3;
  dtime: number;
}

function derivative(pos: Vec3, p: Vec3, accel: Vec3): Derivative {
  const r = length(pos);
  const rhat = scale(pos, 1 / r);
  const gamma = lorentzGamma(p);
  const force = geodesicForce(pos, p);
  const thrust = thrustToRainFrame(p, accel);
  return {
    dpos: addScaled(p, rhat, -riverSpeed(r) * gamma),
    dp: [force[0] + thrust[0], force[1] + thrust[1], force[2] + thrust[2]],
    dtime: gamma,
  };
}

function rk4Step(state: ShipState, accel: Vec3, h: number): ShipState {
  const k1 = derivative(state.pos, state.p, accel);
  const k2 = derivative(
    addScaled(state.pos, k1.dpos, h / 2),
    addScaled(state.p, k1.dp, h / 2),
    accel,
  );
  const k3 = derivative(
    addScaled(state.pos, k2.dpos, h / 2),
    addScaled(state.p, k2.dp, h / 2),
    accel,
  );
  const k4 = derivative(addScaled(state.pos, k3.dpos, h), addScaled(state.p, k3.dp, h), accel);
  const blend = (a: Vec3, b: Vec3, c: Vec3, d: Vec3, base: Vec3): Vec3 => [
    base[0] + (h / 6) * (a[0] + 2 * b[0] + 2 * c[0] + d[0]),
    base[1] + (h / 6) * (a[1] + 2 * b[1] + 2 * c[1] + d[1]),
    base[2] + (h / 6) * (a[2] + 2 * b[2] + 2 * c[2] + d[2]),
  ];
  return {
    pos: blend(k1.dpos, k2.dpos, k3.dpos, k4.dpos, state.pos),
    p: blend(k1.dp, k2.dp, k3.dp, k4.dp, state.p),
    tau: state.tau + h,
    time: state.time + (h / 6) * (k1.dtime + 2 * k2.dtime + 2 * k3.dtime + k4.dtime),
  };
}

/**
 * Advance the ship by proper time `dtau` under a constant on-board proper
 * acceleration `accel`. Sub-steps shrink with the local free-fall timescale so
 * the plunge towards r = 0 stays accurate. Integration stops at `minRadius`.
 */
export function advanceShip(
  state: ShipState,
  accel: Vec3,
  dtau: number,
  minRadius = 0,
): ShipState {
  let current = state;
  let remaining = dtau;
  for (let i = 0; i < 512 && remaining > 1e-12; i++) {
    const r = length(current.pos);
    if (r <= minRadius) break;
    const h = Math.min(remaining, 0.02 * r ** 1.5 + 1e-7);
    current = rk4Step(current, accel, h);
    remaining -= h;
  }
  return current;
}

/** Proper velocity of an observer hovering at fixed position (only exists outside the horizon). */
export function hoverProperVelocity(pos: Vec3): Vec3 {
  const r = length(pos);
  const beta = riverSpeed(r);
  return scale(pos, beta / Math.sqrt(1 - beta * beta) / r);
}

/** Proper acceleration needed to hover at radius r > r_s. */
export function hoverAcceleration(r: number): number {
  return RS / (2 * r * r * Math.sqrt(1 - RS / r));
}

/**
 * Convert a coordinate proper velocity U = dx/dtau into the rain-frame proper
 * velocity p. Solves (1 - beta^2) gamma^2 - 2 beta U_r gamma - (1 + U^2) = 0
 * in a form that stays finite at the horizon for infalling motion.
 */
export function properVelocityFromCoordinate(pos: Vec3, U: Vec3): Vec3 {
  const r = length(pos);
  const rhat = scale(pos, 1 / r);
  const beta = riverSpeed(r);
  const ur = dot(U, rhat);
  const u2 = dot(U, U);
  const energy = Math.sqrt(Math.max(0, beta * beta * ur * ur + (1 - beta * beta) * (1 + u2)));
  const gamma = (1 + u2) / (energy - beta * ur);
  return addScaled(U, rhat, beta * gamma);
}

/** Proper velocity of a prograde circular geodesic orbit about `axis` (r > 1.5 r_s). */
export function circularOrbitProperVelocity(pos: Vec3, tangent: Vec3): Vec3 {
  const r = length(pos);
  const speed = Math.sqrt(RS / (2 * r)) / Math.sqrt(1 - (1.5 * RS) / r);
  return properVelocityFromCoordinate(pos, scale(normalize(tangent), speed));
}

/** Conserved energy per unit mass (as measured at infinity). */
export function orbitalEnergy(state: ShipState): number {
  const r = length(state.pos);
  return lorentzGamma(state.p) - (riverSpeed(r) * dot(state.p, state.pos)) / r;
}

/** Speed (fraction of c) relative to a hovering observer. Only defined for r > r_s. */
export function speedRelativeToStatic(state: ShipState): number {
  const r = length(state.pos);
  const beta = riverSpeed(r);
  if (beta >= 1) return Number.NaN;
  const gamma = lorentzGamma(state.p);
  const pr = dot(state.p, state.pos) / r;
  const gammaRel = (gamma - beta * pr) / Math.sqrt(1 - beta * beta);
  return Math.sqrt(Math.max(0, 1 - 1 / (gammaRel * gammaRel)));
}

/** Far-away clock rate per on-board second (dt/dtau). Infinite at and inside the horizon. */
export function timeDilation(state: ShipState): number {
  const r = length(state.pos);
  if (r <= RS) return Number.POSITIVE_INFINITY;
  return orbitalEnergy(state) / (1 - RS / r);
}

/** Relativistic composition: velocity in the base frame of something moving at `v` inside a frame moving at `u`. */
export function composeVelocities(u: Vec3, v: Vec3): Vec3 {
  const u2 = dot(u, u);
  const uv = dot(u, v);
  if (u2 < 1e-18) return v;
  const invGamma = Math.sqrt(Math.max(0, 1 - u2));
  const vPar = scale(u, uv / u2);
  const vPerp: Vec3 = [v[0] - vPar[0], v[1] - vPar[1], v[2] - vPar[2]];
  const denom = 1 + uv;
  return [
    (u[0] + vPar[0] + vPerp[0] * invGamma) / denom,
    (u[1] + vPar[1] + vPerp[1] * invGamma) / denom,
    (u[2] + vPar[2] + vPerp[2] * invGamma) / denom,
  ];
}

const MAX_FRAME_SPEED = 0.9995;

/**
 * Flight-assist autopilot. Returns the on-board proper acceleration that steers
 * the ship towards `desiredVelocity`, limited to `maxAccel`.
 *
 * Outside the horizon the velocity is measured against hovering observers, so
 * zero input means "hold position against gravity". Inside the horizon nothing
 * can hover, so the velocity is measured against the infalling river instead.
 */
export function assistAcceleration(
  state: ShipState,
  desiredVelocity: Vec3,
  response: number,
  maxAccel: number,
): Vec3 {
  const r = length(state.pos);
  const beta = riverSpeed(r);
  let target = desiredVelocity;
  if (beta < 1) {
    const frame = scale(state.pos, Math.min(beta, MAX_FRAME_SPEED) / r);
    target = composeVelocities(frame, desiredVelocity);
  }
  const speed2 = Math.min(dot(target, target), MAX_FRAME_SPEED * MAX_FRAME_SPEED);
  const targetP = scale(normalize(target), Math.sqrt(speed2 / (1 - speed2)));

  const force = geodesicForce(state.pos, state.p);
  const wanted: Vec3 = [
    (targetP[0] - state.p[0]) * response - force[0],
    (targetP[1] - state.p[1]) * response - force[1],
    (targetP[2] - state.p[2]) * response - force[2],
  ];
  const accel = rainFrameToThrust(state.p, wanted);
  const magnitude = length(accel);
  return magnitude > maxAccel ? scale(accel, maxAccel / magnitude) : accel;
}
