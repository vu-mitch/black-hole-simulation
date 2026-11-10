import { describe, expect, it } from "vitest";
import {
  advanceShip,
  assistAcceleration,
  circularOrbitProperVelocity,
  hoverAcceleration,
  hoverProperVelocity,
  orbitalEnergy,
  riverSpeed,
  speedRelativeToStatic,
  timeDilation,
  type ShipState,
} from "./physics";
import { cross, length, normalize, scale, type Vec3 } from "./vec3";

const ZERO: Vec3 = [0, 0, 0];

const makeState = (pos: Vec3, p: Vec3 = ZERO): ShipState => ({ pos, p, tau: 0, time: 0 });

const angularMomentum = (s: ShipState): Vec3 => cross(s.pos, s.p);

describe("free fall", () => {
  it("conserves energy and angular momentum on an eccentric orbit", () => {
    let state = makeState([10, 0, 0], [0.1, 0.05, 0.42]);
    const e0 = orbitalEnergy(state);
    const l0 = angularMomentum(state);
    let rMin = Infinity;
    let rMax = 0;
    for (let i = 0; i < 4000; i++) {
      state = advanceShip(state, ZERO, 0.1);
      const r = length(state.pos);
      rMin = Math.min(rMin, r);
      rMax = Math.max(rMax, r);
    }
    expect(rMax - rMin).toBeGreaterThan(1);
    expect(orbitalEnergy(state)).toBeCloseTo(e0, 6);
    const l1 = angularMomentum(state);
    expect(length([l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]])).toBeLessThan(1e-6);
  });

  it("keeps a circular orbit circular with the Kepler period", () => {
    const r = 6;
    let state = makeState([r, 0, 0]);
    state.p = circularOrbitProperVelocity(state.pos, [0, 0, 1]);
    const period = 2 * Math.PI * Math.sqrt(2 * r ** 3);
    let previousZ = 0;
    let crossingTime = Number.NaN;
    while (state.time < period * 1.1) {
      const next = advanceShip(state, ZERO, 0.05);
      expect(length(next.pos)).toBeCloseTo(r, 4);
      if (previousZ < 0 && next.pos[2] >= 0 && next.pos[0] > 0) {
        const f = -state.pos[2] / (next.pos[2] - state.pos[2]);
        crossingTime = state.time + f * (next.time - state.time);
      }
      previousZ = next.pos[2];
      state = next;
    }
    expect(crossingTime / period).toBeCloseTo(1, 3);
  });

  it("matches the analytic proper time of a radial plunge through the horizon", () => {
    const rStart = 4;
    const rEnd = 0.25;
    const tau = (2 / 3) * (rStart ** 1.5 - rEnd ** 1.5);
    const state = advanceShip(makeState([0, rStart, 0]), ZERO, tau);
    expect(length(state.pos)).toBeCloseTo(rEnd, 4);
    expect(length(state.p)).toBeLessThan(1e-9);
  });
});

describe("hovering", () => {
  it("stays put when thrusting with the analytic hover acceleration", () => {
    const pos: Vec3 = [0, 0, 2.5];
    let state = makeState(pos, hoverProperVelocity(pos));
    const accel = scale(normalize(pos), hoverAcceleration(2.5));
    for (let i = 0; i < 200; i++) state = advanceShip(state, accel, 0.05);
    expect(state.pos[2]).toBeCloseTo(2.5, 5);
    expect(speedRelativeToStatic(state)).toBeLessThan(1e-5);
  });

  it("measures the river speed for a free-falling observer and gravitational time dilation when hovering", () => {
    const pos: Vec3 = [3, 4, 0];
    expect(speedRelativeToStatic(makeState(pos))).toBeCloseTo(riverSpeed(5), 10);
    expect(timeDilation(makeState(pos, hoverProperVelocity(pos)))).toBeCloseTo(
      1 / Math.sqrt(1 - 1 / 5),
      10,
    );
  });

  it("flight assist brakes to a hover and then holds position", () => {
    let state = makeState([4, 0, 0], [0.3, 0.2, -0.4]);
    const step = 0.02;
    for (let i = 0; i < 3000; i++) {
      state = advanceShip(state, assistAcceleration(state, ZERO, 2, 10), step);
    }
    const settled = length(state.pos);
    expect(speedRelativeToStatic(state)).toBeLessThan(1e-3);
    for (let i = 0; i < 1000; i++) {
      state = advanceShip(state, assistAcceleration(state, ZERO, 2, 10), step);
    }
    expect(length(state.pos)).toBeCloseTo(settled, 2);
  });

  it("flight assist flies at the requested speed relative to hovering observers", () => {
    let state = makeState([8, 0, 0], hoverProperVelocity([8, 0, 0]));
    const desired: Vec3 = [0, 0.3, 0];
    // The hover frame rotates as the ship moves sideways, so a proportional
    // controller trails the target by an amount inversely proportional to its stiffness.
    for (let i = 0; i < 800; i++) {
      state = advanceShip(state, assistAcceleration(state, desired, 8, 100), 0.01);
    }
    expect(speedRelativeToStatic(state)).toBeCloseTo(0.3, 2);
  });
});

describe("inside the horizon", () => {
  it("falls to the singularity no matter how hard the engines push outward", () => {
    let state = makeState([0.9, 0, 0]);
    let previous = length(state.pos);
    while (previous > 0.05) {
      const outward = scale(normalize(state.pos), 50);
      state = advanceShip(state, outward, 0.002, 0.05);
      const r = length(state.pos);
      expect(r).toBeLessThan(previous);
      previous = r;
      expect(state.tau).toBeLessThan(Math.PI / 2);
    }
  });

  it("cannot be held up by the flight assist", () => {
    let state = makeState([0.8, 0, 0]);
    for (let i = 0; i < 2000 && length(state.pos) > 0.05; i++) {
      state = advanceShip(state, assistAcceleration(state, [0.9, 0, 0], 5, 10), 0.002, 0.05);
    }
    expect(length(state.pos)).toBeLessThanOrEqual(0.05);
  });
});
