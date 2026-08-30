import { describe, expect, it } from "vitest";

import { detectAnomalies } from "../src/core/telemetry";
import type { TelemetryRun, TelemetrySample } from "../src/core/types";
import { createIncidentReport } from "../src/reports";

describe("large telemetry regressions", () => {
  it("diagnoses and summarizes 200,000 samples without stack overflow", () => {
    const samples: TelemetrySample[] = Array.from({ length: 200_000 }, (_, index) => ({
      timestamp: index / 100,
      sequence: index,
      pose: { x: index / 100, y: Math.sin(index / 100), yaw: 0 },
      speed: 1,
      battery: 90 - index / 20_000,
      current: index >= 100_000 && index < 100_010 ? 24 : 8,
      state: "tracking",
    }));
    const run: TelemetryRun = {
      id: "performance-fixture",
      name: "Performance fixture",
      kind: "faulty",
      samples,
    };

    const anomalies = detectAnomalies(run);
    const report = createIncidentReport({
      run,
      anomalies,
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(anomalies.some(({ type }) => type === "overcurrent")).toBe(true);
    expect(report.runs[0]?.sampleCount).toBe(200_000);
    expect(report.runs[0]?.telemetry.peakCurrent).toBe(24);
  }, 10_000);
});
