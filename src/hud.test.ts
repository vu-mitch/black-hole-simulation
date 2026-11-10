import { describe, expect, it } from "vitest";
import { formatDuration, formatMagnitude, presetLabel } from "./hud";
import { PRESETS } from "./simulation";

describe("read-outs", () => {
  it("formats durations from seconds up to days", () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe("∞");
    expect(formatDuration(12.34)).toBe("12.3 s");
    expect(formatDuration(125)).toBe("2 min 5 s");
    expect(formatDuration(3700)).toBe("1 h 1 min");
    expect(formatDuration(3 * 86400)).toBe("3 days");
  });

  it("uses powers of ten for very small accelerations", () => {
    expect(formatMagnitude(5.2e-8)).toBe("5.2×10⁻⁸");
    expect(formatMagnitude(0.052)).toBe("0.052");
    expect(formatMagnitude(12)).toBe("12");
  });

  it("names every starting point", () => {
    for (const preset of PRESETS) expect(presetLabel(preset).length).toBeGreaterThan(0);
  });
});
