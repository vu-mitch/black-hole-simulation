/**
 * CPU reference implementation of the light-ray tracer that runs in the
 * fragment shader (src/shaders/scene.frag). It exists so the optics can be
 * unit-tested against analytic results; keep the two in sync.
 *
 * Light paths are traced backwards from the camera. A photon stays in the
 * plane spanned by its position and direction, where its path r(phi) obeys
 * the exact orbit equation (u = r_s / r, lengths in units of r_s)
 *
 *   u'' + u = 3/2 u^2,        u'^2 + u^2 - u^3 = 1 / b^2
 *
 * with impact parameter b. The equation is regular across the horizon, and
 * r and phi are shared by Schwarzschild and Gullstrand–Painlevé coordinates.
 */
import { lorentzGamma, riverSpeed } from "./physics";
import { addScaled, cross, dot, length, normalize, scale, type Vec3 } from "./vec3";

export interface RayStart {
  /** Unit coordinate direction of the backwards-traced ray. */
  vel: Vec3;
  /** Photon energy at infinity per unit energy measured on board. */
  energyAtInfinity: number;
  /** Photon angular momentum per unit energy measured on board. */
  angularMomentum: Vec3;
}

/**
 * Turn a viewing direction `d` (unit vector, ship rest frame) into the initial
 * conditions of a backwards-traced ray. Applies special-relativistic
 * aberration from the ship frame into the free-fall frame, then the river
 * flow that maps free-fall directions to coordinate directions.
 */
export function launchRay(pos: Vec3, p: Vec3, d: Vec3): RayStart {
  const gamma = lorentzGamma(p);
  const pd = dot(p, d);
  const k0 = gamma - pd;
  const D = addScaled(d, p, pd / (gamma + 1) - 1);
  const r = length(pos);
  const rhat = scale(pos, 1 / r);
  const beta = riverSpeed(r);
  return {
    vel: normalize(addScaled(D, rhat, beta * k0)),
    energyAtInfinity: k0 + beta * dot(D, rhat),
    angularMomentum: cross(pos, scale(D, -1)),
  };
}

/**
 * Inverse of the aberration in {@link launchRay}: where on board the sky
 * direction `n` of the local free-fall frame appears.
 */
export function apparentDirection(p: Vec3, n: Vec3): Vec3 {
  return normalize(addScaled(n, p, dot(p, n) / (lorentzGamma(p) + 1) + 1));
}

export type RayFate = "captured" | "escaped";

const U_PHOTON_SPHERE = 2 / 3;
/** 1 / b_crit^2: the height of the potential barrier at the photon sphere. */
const BARRIER = 4 / 27;

/**
 * Decide analytically whether a backwards-traced ray reaches the sky.
 * `u` is r_s / r at the start, `du` its derivative with respect to the orbit
 * angle (negative when heading outward) and `invImpactSq` is 1 / b^2.
 */
export function classifyRay(u: number, du: number, invImpactSq: number): RayFate {
  if (u < U_PHOTON_SPHERE) return du <= 0 || invImpactSq < BARRIER ? "escaped" : "captured";
  return du < 0 && invImpactSq > BARRIER ? "escaped" : "captured";
}

export interface TraceOptions {
  /** Largest orbit-angle step in radians. */
  maxAngleStep: number;
  /** Largest relative change of the radius per step. */
  relativeStep: number;
  maxSteps: number;
}

export const DEFAULT_TRACE_OPTIONS: TraceOptions = {
  maxAngleStep: 0.2,
  relativeStep: 0.2,
  maxSteps: 200,
};

/** Below this u the light bending is negligible, so steps need not shrink with u. */
const U_FLOOR = 0.05;

export function angleStep(u: number, du: number, options: TraceOptions): number {
  const limit = (options.relativeStep * Math.max(u, U_FLOOR)) / Math.max(Math.abs(du), 1e-9);
  return Math.min(options.maxAngleStep, limit);
}

const orbitForce = (u: number): number => u * (1.5 * u - 1);

/** Advance (u, u') by the orbit angle h with one classical Runge–Kutta step. */
export function advanceOrbit(u: number, du: number, h: number): [number, number] {
  const a1 = orbitForce(u);
  const u2 = u + 0.5 * h * du;
  const d2 = du + 0.5 * h * a1;
  const a2 = orbitForce(u2);
  const u3 = u + 0.5 * h * d2;
  const d3 = du + 0.5 * h * a2;
  const a3 = orbitForce(u3);
  const u4 = u + h * d3;
  const d4 = du + h * a3;
  const a4 = orbitForce(u4);
  return [
    u + (h / 6) * (du + 2 * d2 + 2 * d3 + d4),
    du + (h / 6) * (a1 + 2 * a2 + 2 * a3 + a4),
  ];
}

export interface TraceResult {
  fate: RayFate;
  /** Direction on the celestial sphere the ray came from (escaped rays only). */
  direction: Vec3;
  /** Points where the ray crossed the equatorial (y = 0) plane, nearest first. */
  planeCrossings: Vec3[];
  steps: number;
  /** False when the step budget ran out before the ray reached its fate. */
  converged: boolean;
}

const RADIAL_EPSILON = 1e-6;

export function traceRay(
  pos: Vec3,
  vel: Vec3,
  options: TraceOptions = DEFAULT_TRACE_OPTIONS,
): TraceResult {
  const r0 = length(pos);
  const e1 = scale(pos, 1 / r0);
  const v = normalize(vel);
  const cosA = dot(v, e1);
  const tangent = addScaled(v, e1, -cosA);
  const sinA = length(tangent);
  const planeCrossings: Vec3[] = [];

  if (sinA < RADIAL_EPSILON) {
    const fate: RayFate = cosA > 0 ? "escaped" : "captured";
    return { fate, direction: v, planeCrossings, steps: 0, converged: true };
  }

  const e2 = scale(tangent, 1 / sinA);
  const pointAt = (phi: number, r: number): Vec3 =>
    addScaled(scale(e1, r * Math.cos(phi)), e2, r * Math.sin(phi));

  let u = 1 / r0;
  let du = (-u * cosA) / sinA;
  const fate = classifyRay(u, du, du * du + u * u - u * u * u);

  // The height above the disk plane varies as cos(phi - phi0) along the orbit.
  let nextCrossing = Number.POSITIVE_INFINITY;
  if (Math.hypot(e1[1], e2[1]) > 1e-9) {
    const quarter = Math.atan2(e2[1], e1[1]) + Math.PI / 2;
    nextCrossing = quarter - Math.PI * Math.floor(quarter / Math.PI);
    if (nextCrossing < 1e-4) nextCrossing += Math.PI;
  }

  let phi = 0;
  for (let i = 0; i < options.maxSteps; i++) {
    const h = angleStep(u, du, options);
    if (phi + h >= nextCrossing) {
      const [uCross] = advanceOrbit(u, du, nextCrossing - phi);
      if (uCross > 0) planeCrossings.push(pointAt(nextCrossing, 1 / uCross));
      nextCrossing += Math.PI;
    }
    const [uNext, duNext] = advanceOrbit(u, du, h);
    phi += h;
    if (uNext <= 0) {
      // u = 0 is infinity; step back along the (straight) asymptote to the exact zero.
      const phiInfinity = phi - Math.atan(uNext / duNext);
      return {
        fate,
        direction: pointAt(phiInfinity, 1),
        planeCrossings,
        steps: i + 1,
        converged: fate === "escaped",
      };
    }
    u = uNext;
    du = duNext;
    if (u >= 1 && du > 0) {
      return {
        fate,
        direction: pointAt(phi, 1),
        planeCrossings,
        steps: i + 1,
        converged: fate === "captured",
      };
    }
  }
  return { fate, direction: pointAt(phi, 1), planeCrossings, steps: options.maxSteps, converged: false };
}
