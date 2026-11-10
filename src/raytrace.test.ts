import { describe, expect, it } from "vitest";
import { B_CRIT, hoverProperVelocity, riverSpeed } from "./physics";
import {
  apparentDirection,
  DEFAULT_TRACE_OPTIONS,
  launchRay,
  traceRay,
  type TraceOptions,
} from "./raytrace";
import { cross, dot, length, normalize, type Vec3 } from "./vec3";

const ZERO: Vec3 = [0, 0, 0];
const FINE: TraceOptions = { maxAngleStep: 0.002, relativeStep: 0.002, maxSteps: 2_000_000 };
const DEGREE = Math.PI / 180;

function bisect(lo: number, hi: number, isLow: (x: number) => boolean): number {
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (isLow(mid)) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** A ray at radius r0 heading inward with impact parameter b (as measured at infinity). */
function inboundRay(b: number, r0: number): { pos: Vec3; vel: Vec3 } {
  const h = b / Math.sqrt(1 + (b * b) / r0 ** 3);
  const s = h / r0;
  return { pos: [r0, 0, 0], vel: [-Math.sqrt(1 - s * s), 0, s] };
}

/** Viewing direction at angle psi from straight down (towards the hole) for an observer on the x axis. */
const lookDown = (psi: number): Vec3 => [-Math.cos(psi), 0, Math.sin(psi)];

const angleBetween = (a: Vec3, b: Vec3): number => Math.acos(Math.min(1, dot(a, b)));

describe("light paths", () => {
  it("captures light below the critical impact parameter 3√3/2 r_s", () => {
    const bCrit = bisect(2, 3.5, (b) => {
      const { pos, vel } = inboundRay(b, 25);
      return traceRay(pos, vel).fate === "captured";
    });
    expect(bCrit).toBeCloseTo(B_CRIT, 9);
  });

  it("integrates rays to the fate predicted analytically", () => {
    for (const b of [0.5, 2, 2.55, 2.62, 2.7, 3.5, 8, 20]) {
      const { pos, vel } = inboundRay(b, 25);
      const result = traceRay(pos, vel);
      expect(result.fate).toBe(b < B_CRIT ? "captured" : "escaped");
      expect(result.converged).toBe(true);
    }
  });

  it("reproduces the post-Newtonian light deflection series", () => {
    const rMin = 12;
    const b = rMin / Math.sqrt(1 - 1 / rMin);
    // Keeton & Petters (2005), in powers of M / b with M = r_s / 2.
    const x = 0.5 / b;
    const expected =
      4 * x +
      ((15 * Math.PI) / 4) * x ** 2 +
      (128 / 3) * x ** 3 +
      ((3465 * Math.PI) / 64) * x ** 4 +
      (3584 / 5) * x ** 5;
    for (const options of [FINE, DEFAULT_TRACE_OPTIONS]) {
      const result = traceRay([rMin, 0, 0], [0, 0, 1], options);
      expect(result.fate).toBe("escaped");
      const deflection = 2 * Math.atan2(-result.direction[0], result.direction[2]);
      expect(deflection).toBeCloseTo(expected, 4);
    }
  });

  it("agrees with a much finer integration for strongly bent rays", () => {
    for (const b of [2.61, 2.65, 2.8, 3, 4, 6, 10, 20]) {
      const { pos, vel } = inboundRay(b, 25);
      const coarse = traceRay(pos, vel);
      const fine = traceRay(pos, vel, FINE);
      expect(coarse.converged).toBe(true);
      expect(angleBetween(coarse.direction, fine.direction)).toBeLessThan(0.05 * DEGREE);
    }
  });

  it("agrees with a much finer integration for rays leaving the interior", () => {
    for (const r of [1.2, 0.5, 0.1, 0.03]) {
      for (const psi of [100, 91, 80]) {
        const ray = launchRay([r, 0, 0], ZERO, lookDown(psi * DEGREE));
        if (ray.energyAtInfinity <= 0) continue;
        const coarse = traceRay([r, 0, 0], ray.vel);
        const fine = traceRay([r, 0, 0], ray.vel, FINE);
        expect(coarse.fate).toBe("escaped");
        expect(coarse.converged).toBe(true);
        expect(angleBetween(coarse.direction, fine.direction)).toBeLessThan(0.2 * DEGREE);
      }
    }
  });

  it("finds where rays pierce the disk plane, including the far side behind the hole", () => {
    const cases: { pos: Vec3; vel: Vec3; crossings: number }[] = [
      { pos: [18, 4, 3], vel: normalize([-1, -0.35, 0.1]), crossings: 1 },
      // Passes over the hole and is bent down through the plane behind it.
      { pos: [20, 1.5, 0], vel: normalize([-1, 0.1, 0]), crossings: 1 },
      // Skims the photon sphere, swings around the far side and comes back up in front.
      { pos: [20, 1.5, 0], vel: normalize([-1, 0.057, 0]), crossings: 2 },
    ];
    for (const { pos, vel, crossings } of cases) {
      const coarse = traceRay(pos, vel);
      const fine = traceRay(pos, vel, FINE);
      expect(fine.planeCrossings.length).toBe(crossings);
      expect(coarse.planeCrossings.length).toBe(crossings);
      coarse.planeCrossings.forEach((a, i) => {
        const b = fine.planeCrossings[i];
        expect(Math.abs(a[1])).toBeLessThan(1e-9);
        expect(length([a[0] - b[0], a[1] - b[1], a[2] - b[2]])).toBeLessThan(0.02);
      });
    }
  });
});

describe("what the pilot sees", () => {
  const shadowAngle = (pos: Vec3, p: Vec3): number =>
    bisect(0.01, Math.PI - 0.01, (psi) => {
      const ray = launchRay(pos, p, lookDown(psi));
      return ray.energyAtInfinity <= 0 || traceRay(pos, ray.vel).fate === "captured";
    });

  it("launches rays whose path matches the photon's conserved energy and angular momentum", () => {
    const observers: { pos: Vec3; p: Vec3 }[] = [
      { pos: [3, 1, -2], p: [0.4, -0.3, 0.8] },
      { pos: [0.4, 0.1, 0.2], p: [-0.2, 0.5, 0.1] },
      { pos: [30, -4, 9], p: [2, 1, -3] },
    ];
    const directions = [normalize([0.2, 0.5, -1]), normalize([-1, 0.1, 0.3]), normalize([0.3, -1, 0.2])];
    for (const { pos, p } of observers) {
      for (const d of directions) {
        const ray = launchRay(pos, p, d);
        const pathAxis = normalize(cross(pos, ray.vel));
        expect(dot(pathAxis, normalize(ray.angularMomentum))).toBeCloseTo(-1, 10);

        // 1 / b^2 from the path geometry must equal (E / L)^2 from the photon's momentum.
        const u = 1 / length(pos);
        const cosA = dot(ray.vel, pos) * u;
        const du = (-u * cosA) / Math.sqrt(1 - cosA * cosA);
        const fromPath = du * du + u * u - u * u * u;
        const fromMomentum = (ray.energyAtInfinity / length(ray.angularMomentum)) ** 2;
        expect(fromPath / fromMomentum).toBeCloseTo(1, 9);
      }
    }
  });

  it("shows a hovering observer the analytic shadow size", () => {
    for (const r of [10, 3, 2]) {
      const pos: Vec3 = [r, 0, 0];
      const expected = Math.asin((B_CRIT / r) * Math.sqrt(1 - 1 / r));
      expect(shadowAngle(pos, hoverProperVelocity(pos))).toBeCloseTo(expected, 6);
    }
  });

  it("fills exactly half the sky of an observer hovering at the photon sphere", () => {
    const pos: Vec3 = [1.5, 0, 0];
    expect(shadowAngle(pos, hoverProperVelocity(pos))).toBeCloseTo(Math.PI / 2, 6);
  });

  it("shrinks the shadow to 42° for an observer falling freely through the horizon", () => {
    expect(shadowAngle([1, 0, 0], ZERO)).toBeCloseTo(2 * Math.atan(1 / B_CRIT), 6);
  });

  it("closes the shadow over half the sky as a falling observer nears the singularity", () => {
    const radii = [0.5, 0.1, 0.02, 0.004];
    const angles = radii.map((r) => shadowAngle([r, 0, 0], ZERO));
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeGreaterThan(angles[i - 1]);
    // Deep inside, the edge sits where b = b_crit: cos(psi) = sqrt(r) (1 - r sin(psi) / b_crit).
    const r = radii[radii.length - 1];
    const last = angles[angles.length - 1];
    expect(Math.cos(last)).toBeCloseTo(Math.sqrt(r) * (1 - (r * Math.sin(last)) / B_CRIT), 8);
    expect(last).toBeLessThan(Math.PI / 2);
  });

  it("redshifts starlight by sqrt(1 - r_s / r) for hovering and 1 + beta overhead for falling observers", () => {
    const pos: Vec3 = [0, 2, 0];
    const hover = hoverProperVelocity(pos);
    for (const d of [normalize([1, 2, 3]), normalize([-2, 0.5, 1]), [0, -1, 0] as Vec3]) {
      expect(launchRay(pos, hover, d).energyAtInfinity).toBeCloseTo(Math.sqrt(0.5), 10);
    }
    expect(launchRay(pos, ZERO, [0, 1, 0]).energyAtInfinity).toBeCloseTo(1 + riverSpeed(2), 10);
  });

  it("inverts the aberration when locating a sky direction on board", () => {
    const p: Vec3 = [1.2, -0.4, 0.7];
    const d = normalize([0.3, -0.8, 0.5]);
    // At a huge radius the river is still, so the launch direction is the free-fall-frame direction.
    const n = launchRay([1e12, 0, 0], p, d).vel;
    const back = apparentDirection(p, n);
    expect(length([back[0] - d[0], back[1] - d[1], back[2] - d[2]])).toBeLessThan(1e-5);
  });
});
