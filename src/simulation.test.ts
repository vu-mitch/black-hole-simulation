import { describe, expect, it } from "vitest";
import { lookAlong } from "./orientation";
import { PRESETS, Simulation, simulationRate, type ControlInput } from "./simulation";
import { length } from "./vec3";

const STILL: ControlInput = { thrust: [0, 0, 0], boost: false, yaw: 0, pitch: 0, roll: 0 };

describe("simulation rate", () => {
  it("grows with distance and never runs away", () => {
    const radii = [0.05, 0.2, 1, 3, 10, 40];
    for (let i = 1; i < radii.length; i++) {
      expect(simulationRate(radii[i])).toBeGreaterThan(simulationRate(radii[i - 1]));
    }
    expect(simulationRate(0.001)).toBeGreaterThan(0);
    expect(simulationRate(10_000)).toBeLessThanOrEqual(8);
  });
});

describe("flight", () => {
  it("holds the assisted hovers and the free orbit", () => {
    const approach = new Simulation();
    approach.loadPreset("approach");
    const parked = length(approach.ship.pos);
    for (let i = 0; i < 150; i++) approach.update(1 / 30, STILL);
    expect(length(approach.ship.pos)).toBeCloseTo(parked, 0);

    const orbit = new Simulation();
    orbit.loadPreset("orbit");
    for (let i = 0; i < 150; i++) orbit.update(1 / 30, STILL);
    expect(length(orbit.ship.pos)).toBeCloseTo(5, 1);

    const photon = new Simulation();
    photon.loadPreset("photonSphere");
    for (let i = 0; i < 150; i++) photon.update(1 / 30, STILL);
    expect(length(photon.ship.pos)).toBeCloseTo(1.5, 1);
  });

  it("falls through the horizon when the engines are off", () => {
    const sim = new Simulation();
    sim.loadPreset("plunge");
    const start = length(sim.ship.pos);
    let crossed = false;
    for (let i = 0; i < 6000 && !crossed; i++) {
      if (sim.update(0.05, STILL).includes("enteredHorizon")) crossed = true;
    }
    expect(length(sim.ship.pos)).toBeLessThan(start / 2);
    expect(crossed).toBe(true);
  });

  it("flies back out through the horizon with the warp drive", () => {
    const sim = new Simulation();
    sim.ship = { pos: [0.4, 0, 0], p: [0, 0, 0], tau: 0, time: 0 };
    sim.warp = true;
    sim.lockOnHole = false;
    sim.orientation = lookAlong([1, 0, 0], [0, 1, 0]);
    const outward: ControlInput = { thrust: [0, 0, 1], boost: true, yaw: 0, pitch: 0, roll: 0 };
    let left = false;
    for (let i = 0; i < 100; i++) {
      if (sim.update(0.05, outward).includes("leftHorizon")) left = true;
    }
    expect(left).toBe(true);
    expect(length(sim.ship.pos)).toBeGreaterThan(1);
  });

  it("lets the warp drive leave the singularity", () => {
    const sim = new Simulation();
    sim.status = "singularity";
    sim.ship = { pos: [0.03, 0, 0], p: [0, 0, 0], tau: 1, time: 1 };
    sim.warp = true;
    sim.lockOnHole = false;
    sim.orientation = lookAlong([1, 0, 0], [0, 1, 0]);
    sim.update(0.05, { thrust: [0, 0, 1], boost: false, yaw: 0, pitch: 0, roll: 0 });
    expect(sim.status).toBe("flying");
    expect(length(sim.ship.pos)).toBeGreaterThan(0.05);
  });

  it("keeps the fall through the horizon visible even when time is sped up", () => {
    const sim = new Simulation();
    sim.loadPreset("plunge");
    sim.timeFactor = 16;
    let sawInside = false;
    let timeInside = 0;
    for (let i = 0; i < 800 && sim.status === "flying"; i++) {
      const events = sim.update(0.1, STILL);
      const radius = length(sim.ship.pos);
      if (radius < 1 && radius > 0.05) sawInside = true;
      if (events.includes("singularity")) timeInside = sim.telemetry().timeInsideHorizon ?? 0;
    }
    expect(sim.status).toBe("singularity");
    expect(sawInside).toBe(true);
    expect(timeInside).toBeGreaterThan(0.05);
  });

  it("reaches the singularity in free fall and stops there", () => {
    const sim = new Simulation();
    sim.loadPreset("plunge");
    for (let i = 0; i < 8000 && sim.status === "flying"; i++) sim.update(0.1, STILL);
    expect(sim.status).toBe("singularity");
    const radius = length(sim.ship.pos);
    sim.update(1, STILL);
    expect(length(sim.ship.pos)).toBe(radius);
  });

  it("starts every preset in a finite state", () => {
    const sim = new Simulation();
    for (const preset of PRESETS) {
      sim.loadPreset(preset);
      expect(sim.diskTime).toBe(0);
      sim.update(1 / 30, STILL);
      expect(sim.telemetry().radius).toBeGreaterThan(0);
      expect(Number.isFinite(sim.ship.p[0] + sim.ship.p[1] + sim.ship.p[2])).toBe(true);
    }
  });
});
