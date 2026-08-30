import { describe, expect, it } from "vitest";

import {
  analyzeSession,
  createEvidenceChains,
  deriveSessionMetrics,
  MAX_ANALYSIS_INCIDENTS,
} from "../src/core/analysis";
import {
  handleAnalysisWorkerRequest,
  type AnalysisWorkerResponse,
} from "../src/core/analysis-worker";
import {
  applyFaultBranches,
  branchMotorLoad,
  branchPacketDropout,
  branchPoseReset,
  resetFaultBranch,
} from "../src/core/faults";
import {
  assertReplaySessionImportLimits,
  importRecording,
  MAX_IMPORT_TAGS,
  MAX_IMPORT_CSV_COLUMNS,
  MAX_IMPORT_ENVIRONMENT_OBJECTS,
  MAX_IMPORT_GEOMETRY_WORK,
  MAX_IMPORT_PROVENANCE_NOTES,
  MAX_IMPORT_ROUTE_WAYPOINTS,
  MAX_IMPORT_SAMPLES,
  MAX_IMPORT_STRING_LENGTH,
  parseRosbridgeJsonl,
  parseSessionJson,
  parseTelemetryCsv,
  RecordingImportError,
} from "../src/core/importers";
import {
  LIVE_PROTOCOL_SCHEMA,
  MIN_LIVE_SAMPLE_RATE_HZ,
  decodeLiveMessage,
  LiveProtocolError,
  type LiveHelloMessage,
  type LiveSampleMessage,
} from "../src/core/live-protocol";
import {
  createDeterministicLiveMessages,
  DeterministicLiveSimulator,
} from "../src/core/live-simulator";
import {
  LiveMessageTransport,
  MAX_LIVE_SAMPLES,
  WebSocketLiveClient,
  validateLiveWebSocketUrl,
  type LiveSocket,
  type LiveTransportUpdate,
} from "../src/core/live-transport";
import {
  generateEastLoopScenario,
  generateNominalScenario,
  generateScenarioCatalog,
  generateWheelSlipScenario,
} from "../src/core/scenarios";
import {
  collectSessionValidationIssues,
  createReplaySession,
  isReplaySessionV2,
  MAX_REPLAY_IDENTIFIER_LENGTH,
  sha256Bytes,
  sha256Text,
} from "../src/core/session";
import {
  buildTimelineMarkers,
  detectAnomalies,
  generateSyntheticRun,
  generateSyntheticRuns,
  getTimestampGaps,
  getStateChanges,
  interpolateTelemetrySample,
  parseTelemetryJson,
  resolveTelemetrySample,
  sampleAtTimestamp,
  shortestYawDelta,
  TelemetryParseError,
} from "../src/core/telemetry";
import {
  REPLAY_SESSION_SCHEMA,
  type SessionIncident,
  type SessionTelemetrySample,
  type TelemetryRun,
  type TelemetrySample,
} from "../src/core/types";

function sample(
  timestamp: number,
  sequence: number,
  overrides: Partial<TelemetrySample> = {},
): TelemetrySample {
  return {
    timestamp,
    sequence,
    pose: { x: timestamp, y: 0, yaw: 0 },
    speed: 1,
    battery: 80,
    current: 8,
    state: "tracking",
    ...overrides,
  };
}

function run(samples: TelemetrySample[]): TelemetryRun {
  return { id: "test-run", name: "Test run", kind: "normal", samples };
}

function sessionSample(
  timestamp: number,
  sequence: number,
  overrides: Partial<SessionTelemetrySample> = {},
): SessionTelemetrySample {
  return {
    timestamp,
    sequence,
    pose: { x: timestamp, y: 0, yaw: 0 },
    speed: 1,
    battery: 80,
    current: 8,
    state: "tracking",
    latencyMs: 20,
    poseSigma: 0.01,
    ...overrides,
  };
}

describe("parseTelemetryJson", () => {
  it("parses a valid run without hiding telemetry gaps", () => {
    const input = JSON.stringify({
      id: "r-01",
      name: "Synthetic fixture",
      kind: "faulty",
      description: "A local fixture",
      sampleRateHz: 10,
      samples: [sample(0, 10), sample(0.1, 13)],
    });

    const parsed = parseTelemetryJson(input);

    expect(parsed.id).toBe("r-01");
    expect(parsed.kind).toBe("faulty");
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[1]?.sequence).toBe(13);
    expect(parsed.samples[1]?.pose.x).toBeCloseTo(0.1);
  });

  it("accepts an already decoded object and returns independent sample values", () => {
    const input = {
      id: "r-02",
      name: "Decoded fixture",
      kind: "normal",
      samples: [sample(0, 0), sample(0.1, 1)],
    };

    const parsed = parseTelemetryJson(input);
    input.samples[0]!.pose.x = 99;

    expect(parsed.samples[0]?.pose.x).toBe(0);
  });

  it("rejects sparse decoded sample arrays without silently dropping holes", () => {
    const samples = new Array<TelemetrySample>(1);

    expect(() =>
      parseTelemetryJson({ id: "sparse", name: "Sparse run", kind: "normal", samples }),
    ).toThrowError(/run\.samples\[0\].*sparse array entry/);
  });

  it.each([
    ["invalid JSON", "{"],
    ["unknown kind", { id: "x", name: "x", kind: "real", samples: [sample(0, 0)] }],
    ["empty samples", { id: "x", name: "x", kind: "normal", samples: [] }],
    [
      "unordered timestamps",
      { id: "x", name: "x", kind: "normal", samples: [sample(1, 0), sample(0, 1)] },
    ],
    [
      "invalid battery",
      {
        id: "x",
        name: "x",
        kind: "normal",
        samples: [sample(0, 0, { battery: 101 })],
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => parseTelemetryJson(input)).toThrow(TelemetryParseError);
  });
});

describe("telemetry interpolation", () => {
  it("linearly interpolates continuous values and holds discrete values", () => {
    const from = sample(2, 20, {
      pose: { x: 0, y: 2, yaw: 0 },
      speed: 0,
      battery: 90,
      current: 4,
      state: "standby",
    });
    const to = sample(4, 21, {
      pose: { x: 4, y: 6, yaw: Math.PI / 2 },
      speed: 2,
      battery: 70,
      current: 8,
      state: "tracking",
    });

    const midpoint = interpolateTelemetrySample(from, to, 3);

    expect(midpoint).toMatchObject({
      timestamp: 3,
      sequence: 20,
      speed: 1,
      battery: 80,
      current: 6,
      state: "standby",
    });
    expect(midpoint.pose.x).toBeCloseTo(2);
    expect(midpoint.pose.y).toBeCloseTo(4);
    expect(midpoint.pose.yaw).toBeCloseTo(Math.PI / 4);
    expect(interpolateTelemetrySample(from, to, 4).state).toBe("tracking");
  });

  it("takes the shortest path across the yaw wrap boundary", () => {
    const degrees = (value: number): number => (value * Math.PI) / 180;
    const from = sample(0, 0, { pose: { x: 0, y: 0, yaw: degrees(179) } });
    const to = sample(1, 1, { pose: { x: 1, y: 0, yaw: degrees(-179) } });

    const midpoint = interpolateTelemetrySample(from, to, 0.5);

    expect(Math.abs(midpoint.pose.yaw)).toBeCloseTo(Math.PI);
    expect(Math.abs(shortestYawDelta(from.pose.yaw, midpoint.pose.yaw))).toBeLessThan(degrees(2));
  });

  it("uses binary search and clamps sampling to the telemetry extent", () => {
    const samples = [sample(1, 1), sample(2, 2), sample(3, 3)];

    expect(sampleAtTimestamp(samples, -10).timestamp).toBe(1);
    expect(sampleAtTimestamp(samples, 2.25).pose.x).toBeCloseTo(2.25);
    expect(sampleAtTimestamp(samples, 50).timestamp).toBe(3);
    expect(() => sampleAtTimestamp([], 1)).toThrow(RangeError);
  });

  it("preserves legacy interpolation across a detected timestamp gap", () => {
    const samples = [sample(1, 1), sample(2, 2), sample(5, 3)];

    expect(sampleAtTimestamp(samples, 3).timestamp).toBe(3);
    expect(sampleAtTimestamp(samples, 3).pose.x).toBe(3);
  });
});

describe("timestamp gap replay", () => {
  it("uses a strict explicit threshold and exposes both real-sample boundaries", () => {
    const samples = [sample(0, 0), sample(0.25, 1), sample(0.501, 2)];

    expect(getTimestampGaps(samples, { timestampGapThreshold: 0.25 })).toEqual([
      {
        startTimestamp: 0.25,
        endTimestamp: 0.501,
        startSampleIndex: 1,
        endSampleIndex: 2,
        duration: 0.251,
        threshold: 0.25,
      },
    ]);
  });

  it("infers max(250ms, three times the median interval)", () => {
    const samples = [sample(0, 0), sample(0.1, 1), sample(0.2, 2), sample(0.3, 3), sample(0.7, 4)];

    const gaps = getTimestampGaps(samples);

    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ startTimestamp: 0.3, endTimestamp: 0.7 });
    expect(gaps[0]?.threshold).toBeCloseTo(0.3);
  });

  it("resolves exact, interpolated, held and clamped samples with open gaps", () => {
    const samples = [sample(1, 0), sample(2, 1), sample(5, 2), sample(5.5, 3), sample(9, 4)];
    const gaps = getTimestampGaps(samples, { timestampGapThreshold: 2 });

    expect(resolveTelemetrySample(samples, 0, gaps)).toMatchObject({
      status: "before-range",
      sample: { timestamp: 1 },
    });
    expect(resolveTelemetrySample(samples, 1, gaps)).toMatchObject({
      status: "exact",
      sample: { timestamp: 1 },
    });
    expect(resolveTelemetrySample(samples, 1.5, gaps)).toMatchObject({
      status: "interpolated",
      sample: { timestamp: 1.5 },
    });
    expect(resolveTelemetrySample(samples, 3, gaps)).toMatchObject({
      status: "held-during-gap",
      sample: { timestamp: 2, sequence: 1 },
      gap: { startTimestamp: 2, endTimestamp: 5 },
    });
    expect(resolveTelemetrySample(samples, 5, gaps)).toMatchObject({
      status: "exact",
      sample: { timestamp: 5, sequence: 2 },
    });
    expect(resolveTelemetrySample(samples, 5.25, gaps)).toMatchObject({
      status: "interpolated",
      sample: { timestamp: 5.25 },
    });
    expect(resolveTelemetrySample(samples, 7, gaps)).toMatchObject({
      status: "held-during-gap",
      sample: { timestamp: 5.5, sequence: 3 },
      gap: { startTimestamp: 5.5, endTimestamp: 9 },
    });
    expect(resolveTelemetrySample(samples, 10, gaps)).toMatchObject({
      status: "after-range",
      sample: { timestamp: 9 },
    });
  });

  it("validates gap options and invalid sampling input", () => {
    const samples = [sample(0, 0), sample(1, 1)];

    expect(() => getTimestampGaps(samples, { timestampGapThreshold: 0 })).toThrow(RangeError);
    expect(() => getTimestampGaps(samples, { timestampGapMultiplier: Number.NaN })).toThrow(
      RangeError,
    );
    expect(() => resolveTelemetrySample([], 0)).toThrow(RangeError);
    expect(() => resolveTelemetrySample(samples, Number.NaN)).toThrow(RangeError);
  });

  it("accepts a telemetry run as the public gap-detection input", () => {
    const fixture = run([sample(0, 0), sample(0.1, 1), sample(0.8, 2)]);

    expect(getTimestampGaps(fixture, { timestampGapThreshold: 0.25 })).toHaveLength(1);
  });
});

describe("synthetic telemetry", () => {
  it("is deterministic and contains no random or external data", () => {
    const first = generateSyntheticRun("normal");
    const second = generateSyntheticRun("normal");

    expect(second).toEqual(first);
    expect(first.id).toBe("synthetic-normal-run");
    expect(first.samples).toHaveLength(201);
    expect(first.samples[0]?.timestamp).toBe(0);
    expect(first.samples.at(-1)?.timestamp).toBe(20);
  });

  it("keeps the baseline clean and injects every fault class into the faulty run", () => {
    const normal = generateSyntheticRun("normal");
    const faulty = generateSyntheticRun("faulty");

    expect(detectAnomalies(normal)).toEqual([]);
    expect(new Set(detectAnomalies(faulty).map(({ type }) => type))).toEqual(
      new Set([
        "timestamp-gap",
        "sequence-gap",
        "pose-discontinuity",
        "overcurrent",
        "low-battery",
      ]),
    );
    expect(faulty.samples.at(-1)?.timestamp).toBe(20.8);
  });

  it("round-trips generated data through the strict JSON parser", () => {
    const generated = generateSyntheticRun("faulty");
    expect(parseTelemetryJson(JSON.stringify(generated))).toEqual(generated);
  });

  it("generates the paired public synthetic-run fixture", () => {
    const generated = generateSyntheticRuns();

    expect(generated.normal.kind).toBe("normal");
    expect(generated.faulty.kind).toBe("faulty");
  });
});

describe("anomaly detection", () => {
  it("detects timestamp and sequence gaps", () => {
    const anomalies = detectAnomalies(run([sample(0, 20), sample(0.1, 21), sample(0.8, 24)]), {
      timestampGapThreshold: 0.25,
    });

    expect(anomalies.map(({ type }) => type)).toEqual(["sequence-gap", "timestamp-gap"]);
    expect(anomalies.find(({ type }) => type === "timestamp-gap")?.details?.interval).toBeCloseTo(
      0.7,
    );
    expect(anomalies.find(({ type }) => type === "sequence-gap")?.details?.missingPackets).toBe(2);
  });

  it("detects translation and wrapped-yaw pose discontinuities", () => {
    const poseJump = detectAnomalies(
      run([sample(0, 0), sample(0.1, 1, { pose: { x: 2, y: 0, yaw: 0 } })]),
    );
    const wrapIsContinuous = detectAnomalies(
      run([
        sample(0, 0, { pose: { x: 0, y: 0, yaw: Math.PI - 0.01 } }),
        sample(0.1, 1, { pose: { x: 0.01, y: 0, yaw: -Math.PI + 0.01 } }),
      ]),
    );

    expect(poseJump.map(({ type }) => type)).toContain("pose-discontinuity");
    expect(wrapIsContinuous.map(({ type }) => type)).not.toContain("pose-discontinuity");
  });

  it("collapses contiguous overcurrent and low-battery samples into episodes", () => {
    const anomalies = detectAnomalies(
      run([
        sample(0, 0),
        sample(0.1, 1, { current: 19 }),
        sample(0.2, 2, { current: 22 }),
        sample(0.3, 3),
        sample(0.4, 4, { battery: 19 }),
        sample(0.5, 5, { battery: 18 }),
      ]),
    );

    const current = anomalies.filter(({ type }) => type === "overcurrent");
    const battery = anomalies.filter(({ type }) => type === "low-battery");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ timestamp: 0.1, endTimestamp: 0.2 });
    expect(current[0]?.details?.peakCurrent).toBe(22);
    expect(battery).toHaveLength(1);
    expect(battery[0]).toMatchObject({ timestamp: 0.4, endTimestamp: 0.5 });
    expect(battery[0]?.details?.minimumBattery).toBe(18);
  });

  it("reports absolute peak current for negative overcurrent episodes", () => {
    const anomalies = detectAnomalies(
      run([
        sample(0, 0),
        sample(0.1, 1, { current: -20 }),
        sample(0.2, 2, { current: -27.5 }),
        sample(0.3, 3),
      ]),
    );

    expect(anomalies.find(({ type }) => type === "overcurrent")?.details?.peakCurrent).toBe(27.5);
  });

  it("adds timestamp gap boundaries without changing anomaly identity or timestamp", () => {
    const anomalies = detectAnomalies(run([sample(0, 20), sample(0.1, 21), sample(0.8, 22)]), {
      timestampGapThreshold: 0.25,
    });
    const gap = anomalies.find(({ type }) => type === "timestamp-gap");

    expect(gap).toMatchObject({
      id: "timestamp-gap-22-2",
      timestamp: 0.8,
      sampleIndex: 2,
      details: { startTimestamp: 0.1, endTimestamp: 0.8 },
    });
  });

  it("distinguishes sequence regressions from a single missing packet", () => {
    const anomalies = detectAnomalies(run([sample(0, 5), sample(0.1, 4), sample(0.2, 6)])).filter(
      ({ type }) => type === "sequence-gap",
    );

    expect(anomalies).toHaveLength(2);
    expect(anomalies[0]).toMatchObject({
      severity: "critical",
      title: "Sequence regression",
      description: "Sequence moved from 5 to 4.",
    });
    expect(anomalies[1]).toMatchObject({
      severity: "warning",
      title: "Sequence gap",
      description: "1 telemetry packet missing.",
    });
  });

  it("reports state changes separately and merges them into timeline markers", () => {
    const fixture = run([
      sample(0, 0, { state: "standby" }),
      sample(0.1, 1, { state: "tracking" }),
      sample(0.2, 2, { state: "tracking", current: 25 }),
    ]);

    expect(getStateChanges(fixture.samples)).toEqual([
      { timestamp: 0.1, sampleIndex: 1, from: "standby", to: "tracking" },
    ]);
    expect(buildTimelineMarkers(fixture).map(({ type }) => type)).toEqual([
      "state-change",
      "overcurrent",
    ]);
  });

  it("processes a 200,000-sample run without spread-argument overflow", () => {
    const samples = Array.from({ length: 200_000 }, (_, index) =>
      sample(index / 100, index, { current: index < 199_999 ? -25 : 8 }),
    );

    const anomalies = detectAnomalies(samples, { timestampGapThreshold: 1 });

    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      type: "overcurrent",
      sampleIndex: 0,
      endTimestamp: 1999.98,
      details: { peakCurrent: 25 },
    });
  });
});

describe("replay session v2", () => {
  it("generates deterministic, independent 45-second scenario sessions", () => {
    const first = generateEastLoopScenario();
    const second = generateEastLoopScenario();
    const catalog = generateScenarioCatalog();

    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.schema).toBe(REPLAY_SESSION_SCHEMA);
    expect(first.mission).toMatchObject({
      id: "RPL-042",
      outcome: "safe-stop",
      scenario: "east-loop-incident",
    });
    expect(first.runs.candidate.role).toBe("candidate");
    expect(first.runs.baseline?.role).toBe("baseline");
    expect(first.runs.candidate.samples.at(-1)?.timestamp).toBe(45);
    expect(first.runs.baseline?.samples).toHaveLength(901);
    expect(first.runs.candidate.samples.length).toBeLessThan(901);
    expect(first.provenance).toMatchObject({
      source: "synthetic",
      deterministic: true,
    });
    expect(first.provenance.sha256).toMatch(/^[a-f0-9]{64}$/);

    first.mission.title = "locally edited";
    expect(second.mission.title).not.toBe("locally edited");
    expect(catalog.map(({ mission }) => mission.scenario)).toEqual([
      "east-loop-incident",
      "wheel-slip-drift",
      "steady-route",
    ]);
  });

  it("derives an ordered, inspectable evidence chain while keeping the nominal case clean", () => {
    const incident = analyzeSession(generateEastLoopScenario());
    const detectorIds = incident.incidents.map(({ detectorId }) => detectorId);

    expect(detectorIds).toEqual(
      expect.arrayContaining([
        "link-degradation",
        "timestamp-gap",
        "sequence-gap",
        "pose-discontinuity",
        "route-deviation",
        "overcurrent",
        "safe-stop",
      ]),
    );
    expect(incident.incidents).toEqual(
      [...incident.incidents].sort(
        (left, right) =>
          left.timestamp - right.timestamp || left.detectorId.localeCompare(right.detectorId),
      ),
    );
    expect(incident.summary).toMatchObject({
      duration: 45,
      sampleCount: 888,
    });
    expect(incident.summary.packetDeliveryPercent).toBeLessThan(100);
    expect(incident.summary.maxCrossTrackError).toBeGreaterThan(0.45);
    expect(incident.evidenceChains).toHaveLength(1);
    expect(incident.evidenceChains[0]).toMatchObject({
      correlationIsNotCausation: true,
    });
    expect(incident.evidenceChains[0]?.summary).toContain("not a claim of proven causality");
    expect(incident.evidenceChains[0]?.steps.at(-1)?.classification).toBe("protective-response");

    const nominal = analyzeSession(generateNominalScenario());
    expect(nominal.incidents).toEqual([]);
    expect(nominal.evidenceChains).toEqual([]);
  });

  it("keeps wheel-slip displacement route-local and corner evidence progress-aware", () => {
    const wheelSlip = generateWheelSlipScenario();
    const sampleIndex = wheelSlip.runs.candidate.samples.findIndex(
      ({ timestamp }) => timestamp === 28,
    );
    const candidate = wheelSlip.runs.candidate.samples[sampleIndex];
    const baseline = wheelSlip.runs.baseline?.samples[sampleIndex];
    if (candidate === undefined || baseline === undefined) {
      throw new Error("wheel-slip scenario must provide aligned samples at 28 seconds");
    }
    const analysis = analyzeSession(wheelSlip);

    expect(candidate.pose.x - baseline.pose.x).toBeLessThan(-0.7);
    expect(candidate.pose.y - baseline.pose.y).toBeCloseTo(0, 6);
    expect(analysis.metrics[sampleIndex]?.crossTrackError).toBeGreaterThan(0.7);
    expect(analysis.summary.maxHeadingError).toBeCloseTo(0.48, 5);
    expect(analysis.incidents.some(({ detectorId }) => detectorId === "pose-discontinuity")).toBe(
      false,
    );

    const eastLoop = analyzeSession(generateEastLoopScenario());
    expect(eastLoop.summary.maxHeadingError).toBeCloseTo(0.52, 5);
    expect(eastLoop.summary.maxCrossTrackError).toBeGreaterThan(1.1);
  });

  it("applies detector overrides without mutating the session configuration", () => {
    const session = generateEastLoopScenario();
    const configuredRule = session.detectors.rules["safe-stop"];
    const analysis = analyzeSession(session, {
      detectorOverrides: { "safe-stop": { enabled: false } },
    });

    expect(analysis.incidents.map(({ detectorId }) => detectorId)).not.toContain("safe-stop");
    expect(analysis.disabledDetectors).toContainEqual({
      id: "safe-stop",
      reason: "Disabled by configuration.",
    });
    expect(configuredRule.enabled).toBe(true);
  });

  it("uses the timestamp-gap override for metrics, interpolation, energy, and episodes", () => {
    const session = generateNominalScenario();
    session.runs.candidate.sampleRateHz = 20;
    session.runs.candidate.samples = [
      sessionSample(0, 0, { current: 19, pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(1, 1, { current: 25, pose: { x: 1, y: 0, yaw: 0 } }),
      sessionSample(2, 2, { current: 19, pose: { x: 2, y: 0, yaw: 0 } }),
    ];
    session.runs.baseline!.sampleRateHz = 20;
    session.runs.baseline!.samples = [
      sessionSample(0, 0, { current: 10, pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(2, 2, { current: 10, pose: { x: 2, y: 0, yaw: 0 } }),
    ];

    const separated = analyzeSession(session);
    expect(separated.metrics[1]).toMatchObject({
      baselinePositionDelta: null,
      cumulativeEnergyWh: null,
    });
    expect(separated.incidents.some(({ detectorId }) => detectorId === "overcurrent")).toBe(false);

    const continuous = analyzeSession(session, {
      detectorOverrides: { "timestamp-gap": { threshold: 2 } },
    });
    const overcurrent = continuous.incidents.find(({ detectorId }) => detectorId === "overcurrent");
    expect(continuous.metrics[1]?.baselinePositionDelta).toBe(0);
    expect(continuous.metrics[1]?.cumulativeEnergyWh).toBeGreaterThan(0);
    expect(continuous.summary.energyEstimateWh).toBeGreaterThan(0);
    expect(overcurrent?.evidence).toMatchObject({ observed: 25, baselineDelta: 15 });
  });

  it("compares heading and clearance evidence with aligned baseline detector metrics", () => {
    const session = generateNominalScenario();
    session.robot.footprint = { length: 0, width: 0, safetyMargin: 0 };
    session.plannedRoute = {
      id: "straight-test-route",
      name: "Straight test route",
      source: "mission-plan",
      corridorWidth: 1,
      closed: false,
      waypoints: [
        { id: "start", x: 0, y: 0 },
        { id: "end", x: 10, y: 0 },
      ],
    };
    session.environment.objects = [
      {
        id: "test-obstacle",
        label: "Test obstacle",
        kind: "obstacle",
        x: 5,
        y: 0,
        width: 2,
        depth: 2,
        height: 1,
      },
    ];
    session.runs.candidate.sampleRateHz = 20;
    session.runs.candidate.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(1, 1, { pose: { x: 3.5, y: 0, yaw: 1 } }),
      sessionSample(2, 2, { pose: { x: 10, y: 0, yaw: 0 } }),
    ];
    session.runs.baseline!.sampleRateHz = 20;
    session.runs.baseline!.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(1, 1, { pose: { x: 3, y: 0, yaw: 0.2 } }),
      sessionSample(2, 2, { pose: { x: 10, y: 0, yaw: 0 } }),
    ];
    const detectorOverrides = {
      "timestamp-gap": { threshold: 2 },
      "heading-error": { threshold: 0.5, minimumDuration: 0 },
      "obstacle-clearance": { threshold: 0.6, minimumDuration: 0 },
    } as const;

    const analysis = analyzeSession(session, { detectorOverrides });
    expect(
      analysis.incidents.find(({ detectorId }) => detectorId === "heading-error")?.evidence
        .baselineDelta,
    ).toBeCloseTo(0.8);
    expect(
      analysis.incidents.find(({ detectorId }) => detectorId === "obstacle-clearance")?.evidence
        .baselineDelta,
    ).toBeCloseTo(-0.5);

    const baseline = session.runs.baseline;
    if (baseline === undefined) {
      throw new Error("nominal scenario must provide a baseline run");
    }
    baseline.samples = baseline.samples.filter(({ timestamp }) => timestamp !== 1);
    const acrossBaselineGap = analyzeSession(session, {
      detectorOverrides: {
        ...detectorOverrides,
        "timestamp-gap": { threshold: 0.25 },
      },
    });
    expect(
      acrossBaselineGap.incidents.find(({ detectorId }) => detectorId === "heading-error")?.evidence
        .baselineDelta,
    ).toBeNull();
    expect(
      acrossBaselineGap.incidents.find(({ detectorId }) => detectorId === "obstacle-clearance")
        ?.evidence.baselineDelta,
    ).toBeNull();
  });

  it("uses exact baseline values while rejecting deltas that bridge baseline gaps", () => {
    const exact = generateNominalScenario();
    exact.runs.candidate.sampleRateHz = 2;
    exact.runs.candidate.samples = [
      sessionSample(0, 0, { current: 8 }),
      sessionSample(1, 1, { current: 25 }),
      sessionSample(1.5, 2, { current: 24 }),
      sessionSample(2, 3, { current: 8 }),
    ];
    exact.runs.baseline!.sampleRateHz = 1;
    exact.runs.baseline!.samples = [
      sessionSample(0, 0, { current: 10 }),
      sessionSample(1, 1, { current: 10 }),
      sessionSample(2, 2, { current: null }),
    ];
    expect(
      analyzeSession(exact).incidents.find(({ detectorId }) => detectorId === "overcurrent")
        ?.evidence.baselineDelta,
    ).toBe(15);

    const acrossGap = generateNominalScenario();
    acrossGap.runs.candidate.sampleRateHz = 1;
    acrossGap.runs.candidate.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(1, 1, { pose: { x: 2, y: 0, yaw: 0 } }),
    ];
    acrossGap.runs.baseline!.sampleRateHz = 20;
    acrossGap.runs.baseline!.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(1, 1, { pose: { x: 1, y: 0, yaw: 0 } }),
    ];
    expect(
      analyzeSession(acrossGap).incidents.find(
        ({ detectorId }) => detectorId === "pose-discontinuity",
      )?.evidence.baselineDelta,
    ).toBeNull();
  });

  it("applies sequence thresholds to missing-packet counts", () => {
    const session = generateNominalScenario();
    session.runs.candidate.samples = [sessionSample(0, 0), sessionSample(0.05, 2)];
    expect(
      analyzeSession(session).incidents.some(({ detectorId }) => detectorId === "sequence-gap"),
    ).toBe(false);

    session.runs.candidate.samples[1] = sessionSample(0.05, 3);
    const sequenceGap = analyzeSession(session).incidents.find(
      ({ detectorId }) => detectorId === "sequence-gap",
    );
    expect(sequenceGap?.evidence).toMatchObject({
      observed: 2,
      threshold: 1,
      comparator: "above",
      unit: "packets",
    });
  });

  it("honors the configured safe-stop minimum duration", () => {
    const session = generateNominalScenario();
    session.runs.candidate.samples = [
      sessionSample(0, 0),
      sessionSample(0.25, 1, { state: "safe-stop" }),
      sessionSample(0.75, 2, { state: "SAFE_STOP" }),
      sessionSample(1, 3),
    ];

    const tooShort = analyzeSession(session, {
      detectorOverrides: {
        "timestamp-gap": { threshold: 1 },
        "safe-stop": { minimumDuration: 0.75 },
      },
    });
    expect(tooShort.incidents.some(({ detectorId }) => detectorId === "safe-stop")).toBe(false);

    const longEnough = analyzeSession(session, {
      detectorOverrides: {
        "timestamp-gap": { threshold: 1 },
        "safe-stop": { minimumDuration: 0.5 },
      },
    });
    expect(
      longEnough.incidents.find(({ detectorId }) => detectorId === "safe-stop")?.evidence.duration,
    ).toBe(0.5);
  });

  it("treats minimum duration as a scale-aware lower bound", () => {
    const session = generateNominalScenario();
    session.runs.candidate.samples = [
      sessionSample(0, 0, { state: "safe-stop" }),
      sessionSample(0.9999999995, 1, { state: "safe-stop" }),
      sessionSample(1.1, 2),
    ];
    const options = {
      detectorOverrides: {
        "timestamp-gap": { threshold: 2 },
        "safe-stop": { minimumDuration: 1 },
      },
    } as const;
    expect(
      analyzeSession(session, options).incidents.some(
        ({ detectorId }) => detectorId === "safe-stop",
      ),
    ).toBe(false);

    session.runs.candidate.samples[1] = sessionSample(1, 1, { state: "safe-stop" });
    expect(
      analyzeSession(session, options).incidents.find(
        ({ detectorId }) => detectorId === "safe-stop",
      )?.evidence.duration,
    ).toBe(1);

    session.runs.candidate.samples = [sessionSample(0, 0, { state: "safe-stop" })];
    expect(
      analyzeSession(session, {
        detectorOverrides: { "safe-stop": { minimumDuration: Number.EPSILON } },
      }).incidents.some(({ detectorId }) => detectorId === "safe-stop"),
    ).toBe(false);
  });

  it("enforces detector domains, instantaneous duration semantics, and safe sequences", () => {
    const session = generateNominalScenario();
    session.detectors.rules["sequence-gap"].threshold = -1;
    session.detectors.rules["pose-discontinuity"].minimumDuration = 0.1;
    const first = session.runs.candidate.samples[0];
    if (first === undefined) {
      throw new Error("scenario must provide a candidate sample");
    }
    first.sequence = Number.MAX_SAFE_INTEGER + 1;

    expect(collectSessionValidationIssues(session)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "runs.candidate.samples[0].sequence" }),
        expect.objectContaining({ path: "detectors.rules.sequence-gap.threshold" }),
        expect.objectContaining({
          path: "detectors.rules.pose-discontinuity.minimumDuration",
        }),
      ]),
    );
    expect(() =>
      analyzeSession(generateNominalScenario(), {
        detectorOverrides: { "low-battery": { threshold: 101 } },
      }),
    ).toThrowError(/low-battery.*between 0 and 100/);
  });

  it("breaks sequence continuity at null counters instead of inventing packet loss", () => {
    const session = generateNominalScenario();
    session.runs.candidate.samples = [
      sessionSample(0, 0),
      sessionSample(0.05, 1, { sequence: null }),
      sessionSample(0.1, 2),
    ];

    const unavailable = analyzeSession(session);
    expect(unavailable.summary.packetDeliveryPercent).toBeNull();
    expect(unavailable.disabledDetectors).toContainEqual({
      id: "sequence-gap",
      reason: "No adjacent samples provide sequence continuity.",
    });

    session.runs.candidate.samples = [
      sessionSample(0, 0),
      sessionSample(0.05, 1),
      sessionSample(0.1, 2, { sequence: null }),
      sessionSample(0.15, 10),
      sessionSample(0.2, 11),
    ];
    expect(analyzeSession(session).summary.packetDeliveryPercent).toBe(100);
  });

  it("skips zero-length route segments and keeps pose discontinuity translational", () => {
    const session = generateNominalScenario();
    session.plannedRoute = {
      id: "vertical-with-stop",
      name: "Vertical route with repeated stop waypoint",
      source: "mission-plan",
      corridorWidth: 1,
      closed: false,
      waypoints: [
        { id: "start", x: 0, y: 0 },
        { id: "stop", x: 0, y: 0 },
        { id: "end", x: 0, y: 10 },
      ],
    };
    session.runs.candidate.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(0.05, 1, { pose: { x: 0, y: 0.05, yaw: Math.PI / 2 } }),
    ];
    session.runs.baseline!.samples = [
      sessionSample(0, 0, { pose: { x: 0, y: 0, yaw: 0 } }),
      sessionSample(0.05, 1, { pose: { x: 0, y: 0.05, yaw: Math.PI / 2 } }),
    ];

    expect(deriveSessionMetrics(session)[0]?.headingError).toBeCloseTo(Math.PI / 2);
    expect(
      analyzeSession(session).incidents.some(
        ({ detectorId }) => detectorId === "pose-discontinuity",
      ),
    ).toBe(false);

    const stationary = createReplaySession({
      id: "stationary",
      candidate: {
        ...session.runs.candidate,
        id: "stationary-run",
        name: "Stationary",
        samples: [sessionSample(0, 0, { pose: { x: 1, y: 1, yaw: 0 } })],
      },
    });
    expect(stationary.plannedRoute.source).toBe("inferred-observation");
    expect(deriveSessionMetrics(stationary)[0]).toMatchObject({
      crossTrackError: 0,
      headingError: 0,
    });
  });

  it("keeps every emitted analysis number finite and uses null for unavailable metrics", () => {
    const session = generateNominalScenario();
    session.environment.objects = [];
    session.robot.nominalVoltage = Number.MAX_VALUE;
    session.runs.candidate.samples = [
      sessionSample(0, 0, { current: Number.MAX_VALUE }),
      sessionSample(0.05, 1, { current: Number.MAX_VALUE }),
    ];
    const analysis = analyzeSession(session);
    const numbers: number[] = [];
    const collectNumbers = (value: unknown): void => {
      if (typeof value === "number") {
        numbers.push(value);
      } else if (Array.isArray(value)) {
        value.forEach(collectNumbers);
      } else if (typeof value === "object" && value !== null) {
        Object.values(value).forEach(collectNumbers);
      }
    };
    collectNumbers(analysis);

    expect(numbers.every(Number.isFinite)).toBe(true);
    expect(analysis.metrics.every(({ obstacleClearance }) => obstacleClearance === null)).toBe(
      true,
    );
    expect(analysis.metrics.at(-1)?.cumulativeEnergyWh).toBeNull();
    expect(analysis.summary.minObstacleClearance).toBeNull();
    expect(analysis.summary.energyEstimateWh).toBeNull();
  });

  it("labels simultaneous opening evidence as factual earliest crossings", () => {
    const session = generateNominalScenario();
    const makeIncident = (
      id: string,
      detectorId: SessionIncident["detectorId"],
      timestamp: number,
    ): SessionIncident => ({
      id,
      detectorId,
      ruleVersion: "2.0.0",
      severity: "warning",
      timestamp,
      endTimestamp: timestamp,
      sampleIndex: 0,
      title: id,
      description: id,
      evidence: {
        observed: 1,
        threshold: 0,
        comparator: "above",
        unit: "test",
        baselineDelta: null,
        duration: 0,
        sampleRange: [0, 0],
        supportingSampleIndices: [0],
        operatorCheck: "Review source evidence.",
      },
    });
    const chain = createEvidenceChains(session, [
      makeIncident("route", "route-deviation", 1),
      makeIncident("heading", "heading-error", 1),
      makeIncident("stop", "safe-stop", 2),
    ])[0];

    expect(
      chain?.steps.filter(({ classification }) => classification === "earliest-crossing"),
    ).toHaveLength(2);
    expect(chain?.steps.at(-1)?.classification).toBe("protective-response");
    expect(chain?.steps[0]?.rationale).toContain("relative order is unresolved");
  });

  it("groups shared gap boundaries without inventing event order and scopes chain IDs by run", () => {
    const session = generateNominalScenario();
    for (const rule of Object.values(session.detectors.rules)) {
      rule.enabled = rule.id === "timestamp-gap" || rule.id === "sequence-gap";
    }
    session.runs.candidate.sampleRateHz = 20;
    session.runs.candidate.samples = [sessionSample(0, 0), sessionSample(5, 100)];
    const analysis = analyzeSession(session);
    const chain = analysis.evidenceChains[0];

    expect(chain?.steps.map(({ incidentId }) => incidentId)).toEqual([
      expect.stringContaining("timestamp-gap"),
      expect.stringContaining("sequence-gap"),
    ]);
    expect(chain?.steps.map(({ classification }) => classification)).toEqual([
      "earliest-crossing",
      "earliest-crossing",
    ]);
    expect(chain?.steps[1]).toMatchObject({ elapsedFromPrevious: 0 });
    expect(chain?.steps[1]?.rationale).toContain("co-referential evidence, not a later event");
    expect(chain?.summary).toContain("bounded 0.000 s review window");

    const otherRun = structuredClone(session);
    otherRun.runs.candidate.id = "same-session-other-run";
    const otherChain = analyzeSession(otherRun).evidenceChains[0];
    expect(otherChain?.id).not.toBe(chain?.id);
    expect(chain?.id).toContain(session.runs.candidate.id);
    expect(otherChain?.id).toContain(otherRun.runs.candidate.id);
  });

  it("fingerprints interpretation-critical context when creating a session", () => {
    const candidate = generateNominalScenario().runs.candidate;
    const first = createReplaySession({
      id: "fingerprint-test",
      candidate,
      robot: { nominalVoltage: 48 },
    });
    const second = createReplaySession({
      id: "fingerprint-test",
      candidate,
      robot: { nominalVoltage: 24 },
    });

    expect(first.runs.candidate.samples).toEqual(second.runs.candidate.samples);
    expect(first.provenance.sha256).not.toBe(second.provenance.sha256);
  });

  it("fails closed before adversarial detector output can exceed its resource bound", () => {
    const session = generateNominalScenario();
    delete session.runs.baseline;
    if (session.environment.objects.length === 0) {
      throw new Error("scenario must provide collision geometry");
    }
    const sampleCount = Math.ceil(MAX_ANALYSIS_INCIDENTS / 2) + 2;
    session.runs.candidate.samples = Array.from({ length: sampleCount }, (_, index) =>
      sessionSample(index * 0.3, index * 3, {
        state: "tracking",
      }),
    );

    expect(() =>
      analyzeSession(session, {
        detectorOverrides: {
          "timestamp-gap": { threshold: 0.1 },
          "sequence-gap": { threshold: 0 },
          "pose-discontinuity": { enabled: false },
          overcurrent: { enabled: false },
          "low-battery": { enabled: false },
          "link-degradation": { enabled: false },
          "route-deviation": { enabled: false },
          "heading-error": { enabled: false },
          "obstacle-clearance": { enabled: false },
          "safe-stop": { enabled: false },
        },
      }),
    ).toThrowError(
      expect.objectContaining({
        name: "RangeError",
        message: expect.stringContaining(MAX_ANALYSIS_INCIDENTS.toLocaleString("en-US")),
      }),
    );
  });
});

describe("Fault Lab branches", () => {
  it("branches packet loss, pose reset and motor load without changing the source session", () => {
    const source = generateNominalScenario();
    const sourceSnapshot = structuredClone(source);
    const dropout = branchPacketDropout(source, 10, 0.5);
    const poseReset = branchPoseReset(source, 10, 0.75, -0.25, 0.3);
    const motorLoad = branchMotorLoad(source, 10, 1, 2);

    expect(source).toEqual(sourceSnapshot);
    expect(dropout.runs.candidate.samples.length).toBeLessThan(
      source.runs.candidate.samples.length,
    );
    expect(dropout.transformations[0]).toMatchObject({
      type: "packet-dropout",
      startTimestamp: 10,
      endTimestamp: 10.5,
    });
    expect(analyzeSession(dropout).incidents.map(({ detectorId }) => detectorId)).toContain(
      "timestamp-gap",
    );

    const sourceAtTen = source.runs.candidate.samples.find(({ timestamp }) => timestamp === 10);
    const resetAtTen = poseReset.runs.candidate.samples.find(({ timestamp }) => timestamp === 10);
    expect(resetAtTen?.pose.x).toBeCloseTo((sourceAtTen?.pose.x ?? 0) + 0.75);
    expect(resetAtTen?.pose.y).toBeCloseTo((sourceAtTen?.pose.y ?? 0) - 0.25);

    const sourceCurrent = sourceAtTen?.current ?? 0;
    const loadedCurrent = motorLoad.runs.candidate.samples.find(
      ({ timestamp }) => timestamp === 10,
    )?.current;
    expect(loadedCurrent).toBeCloseTo(sourceCurrent * 2);
    expect(motorLoad.provenance).toMatchObject({
      source: "derived",
      parentSessionId: source.id,
    });
    expect(motorLoad.provenance.sha256).not.toBe(source.provenance.sha256);

    const reset = resetFaultBranch(source);
    expect(reset).toEqual(source);
    expect(reset).not.toBe(source);
    expect(() => branchPacketDropout(source, 10, 3.1)).toThrow(RangeError);
  });

  it("canonicalizes cumulative lineage across batched and sequential transformations", () => {
    const source = generateNominalScenario();
    const dropout = { type: "packet-dropout", startTimestamp: 10, duration: 0.5 } as const;
    const reset = {
      type: "pose-reset",
      startTimestamp: 12,
      offsetX: 0.5,
      offsetY: 0,
      offsetYaw: 0,
    } as const;
    const batched = applyFaultBranches(source, [dropout, reset]);
    const sequential = applyFaultBranches(applyFaultBranches(source, [dropout]), [reset]);

    expect(sequential).toEqual(batched);
    expect(batched.runs.candidate.name).toBe("Steady route · modified");
    expect(batched.provenance.label).toBe(
      "Deterministic nominal scenario generator v2 · Fault Lab branch",
    );
    expect(batched.provenance.rootSessionSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      batched.provenance.notes?.filter((note) => note.startsWith("Modified locally")),
    ).toHaveLength(1);

    const changedContext = structuredClone(source);
    changedContext.detectors.rules["link-degradation"].threshold += 1;
    expect(applyFaultBranches(changedContext, [dropout]).provenance.sha256).not.toBe(
      applyFaultBranches(source, [dropout]).provenance.sha256,
    );
  });

  it("binds branch identity to the resulting candidate recording", () => {
    const established = branchPoseReset(generateNominalScenario(), 5, 0.25, 0, 0);
    const changedCandidate = structuredClone(established);
    const changedSample = changedCandidate.runs.candidate.samples[100];
    if (changedSample === undefined) {
      throw new Error("scenario must provide a candidate sample");
    }
    changedSample.pose.x += 0.5;
    changedCandidate.runs.candidate.sampleRateHz = 1;
    changedCandidate.provenance.sha256 = "b".repeat(64);
    const nextFault = {
      type: "motor-load",
      startTimestamp: 10,
      duration: 1,
      multiplier: 2,
    } as const;

    const unchangedBranch = applyFaultBranches(established, [nextFault]);
    const changedBranch = applyFaultBranches(changedCandidate, [nextFault]);

    expect(changedCandidate.provenance.rootSessionSha256).toBe(
      established.provenance.rootSessionSha256,
    );
    expect(changedBranch.provenance.sha256).not.toBe(unchangedBranch.provenance.sha256);
    expect(changedBranch.id).not.toBe(unchangedBranch.id);
    expect(changedBranch.runs.candidate.id).not.toBe(unchangedBranch.runs.candidate.id);

    const metadataMutations: Array<(session: typeof established) => void> = [
      (session) => {
        session.mission.title = "Changed mission title";
      },
      (session) => {
        session.runs.candidate.id = "changed-candidate-root";
      },
      (session) => {
        session.runs.candidate.name = "Changed candidate name";
      },
      (session) => {
        session.runs.candidate.description = "Changed candidate description";
      },
    ];
    for (const mutate of metadataMutations) {
      const changedMetadata = structuredClone(established);
      mutate(changedMetadata);
      expect(applyFaultBranches(changedMetadata, [nextFault]).provenance.sha256).not.toBe(
        unchangedBranch.provenance.sha256,
      );
    }
  });

  it("keeps derived identifiers inside the canonical session contract", () => {
    const source = generateNominalScenario();
    source.id = "s".repeat(MAX_REPLAY_IDENTIFIER_LENGTH);
    source.runs.candidate.id = "c".repeat(MAX_REPLAY_IDENTIFIER_LENGTH);
    expect(collectSessionValidationIssues(source)).toEqual([]);

    const branch = branchMotorLoad(source, 10, 1, 2);

    expect(branch.id.length).toBeLessThanOrEqual(MAX_REPLAY_IDENTIFIER_LENGTH);
    expect(branch.runs.candidate.id.length).toBeLessThanOrEqual(MAX_REPLAY_IDENTIFIER_LENGTH);
    expect(collectSessionValidationIssues(branch)).toEqual([]);
  });

  it("allocates deterministic transformation IDs around existing opaque identifiers", () => {
    const source = generateNominalScenario();
    source.transformations = [
      {
        id: "motor-load-10.000-2",
        type: "pose-reset",
        startTimestamp: 1,
        endTimestamp: 45,
        parameters: { offsetX: 0.1, offsetY: 0, offsetYaw: 0 },
        affectedSamples: 1,
      },
    ];
    expect(collectSessionValidationIssues(source)).toEqual([]);

    const first = branchMotorLoad(source, 10, 1, 2);
    const second = branchMotorLoad(source, 10, 1, 2);

    expect(first).toEqual(second);
    expect(first.transformations.map(({ id }) => id)).toEqual([
      "motor-load-10.000-2",
      "motor-load-10.000-2-2",
    ]);
    expect(collectSessionValidationIssues(first)).toEqual([]);
  });
});

describe("analysis worker cancellation", () => {
  it("ignores unknown cancel IDs and only cancels an active matching request", async () => {
    const reusedResponses: AnalysisWorkerResponse[] = [];
    await handleAnalysisWorkerRequest({ type: "cancel", requestId: "reused-id" }, (response) =>
      reusedResponses.push(response),
    );
    await handleAnalysisWorkerRequest(
      {
        type: "analyze",
        requestId: "reused-id",
        session: generateNominalScenario(),
      },
      (response) => reusedResponses.push(response),
    );
    expect(reusedResponses.some(({ type }) => type === "result")).toBe(true);
    expect(reusedResponses.some(({ type }) => type === "cancelled")).toBe(false);

    const cancelledResponses: AnalysisWorkerResponse[] = [];
    const active = handleAnalysisWorkerRequest(
      {
        type: "analyze",
        requestId: "active-id",
        session: generateNominalScenario(),
      },
      (response) => cancelledResponses.push(response),
    );
    await handleAnalysisWorkerRequest({ type: "cancel", requestId: "active-id" }, (response) =>
      cancelledResponses.push(response),
    );
    await active;
    expect(cancelledResponses.filter(({ type }) => type === "cancelled")).toHaveLength(1);
    expect(cancelledResponses.some(({ type }) => type === "result")).toBe(false);
  });
});

describe("session importers", () => {
  it("rebases legacy JSON, preserves optional channels, and exposes its defaulted role", () => {
    const imported = parseSessionJson(
      JSON.stringify({
        id: "legacy",
        name: "Legacy run",
        kind: "normal",
        samples: [
          {
            timestamp: 100,
            sequence: 1,
            pose: { x: 0, y: 0, yaw: 0 },
            speed: 1,
            battery: 80,
            current: 4,
            state: "tracking",
            latencyMs: 12,
            poseSigma: 0.04,
          },
          {
            timestamp: 100.1,
            sequence: 2,
            pose: { x: 0.1, y: 0, yaw: 0 },
            speed: 1,
            battery: 80,
            current: 4,
            state: "tracking",
            latencyMs: 13,
            poseSigma: 0.05,
          },
        ],
      }),
    );

    expect(imported.kind).toBe("run");
    if (imported.kind !== "run") throw new Error("expected legacy run import");
    expect(imported.run.samples.map(({ timestamp }) => timestamp)).toEqual([0, 0.1]);
    expect(imported.run.samples[0]).toMatchObject({ latencyMs: 12, poseSigma: 0.04 });
    expect(imported).toMatchObject({
      role: "candidate",
      timeOriginSeconds: 100,
      timeOriginExact: "100 seconds",
    });
    expect(imported.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "legacy-role-defaulted" })]),
    );
  });

  it("fingerprints original source bytes identically across crypto implementations", async () => {
    const csv = "timestamp,x,y,yaw\n0,0,0,0";
    const forgedOptions = {
      role: "candidate" as const,
      yawUnit: "radians" as const,
      byteLength: 1,
      sha256: "f".repeat(64),
    };
    const parsed = parseTelemetryCsv(csv, forgedOptions);

    expect(parsed.byteLength).toBe(new TextEncoder().encode(csv).byteLength);
    expect(parsed.sha256).toBe(sha256Text(csv));
    expect(parsed.sha256).not.toBe(forgedOptions.sha256);
    expect(sha256Text("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(sha256Bytes(Uint8Array.from([0, 255, 128, 1]))).toBe(
      "6509423fd9da5c225d2f8619ffae394b40f9f7686fee55a38c54b1424ac65f46",
    );

    const bytesWithBom = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(csv)]);
    const importedBytes = await importRecording(bytesWithBom, {
      format: "csv",
      role: "candidate",
      yawUnit: "radians",
      importedAt: null,
    });
    expect(importedBytes.sha256).toBe(
      "3123a1ccc439979b07a624509390ea0baabb3a18908587960ff7ec3b341d0380",
    );
    expect(importedBytes.sha256).toBe(sha256Bytes(bytesWithBom));
    expect(importedBytes.sha256).not.toBe(sha256Text(csv));
  });

  it("round-trips canonical sessions and replaces source provenance", () => {
    const source = generateNominalScenario();
    source.provenance.rootSessionSha256 = "a".repeat(64);
    source.provenance.parentSessionId = "source-parent";
    const imported = parseSessionJson(JSON.stringify(source), {
      sourceName: "nominal-session.json",
      importedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(imported.kind).toBe("session");
    if (imported.kind !== "session") {
      throw new Error("expected a canonical session import");
    }
    expect(imported.session).not.toBe(source);
    expect(imported.session.schema).toBe(REPLAY_SESSION_SCHEMA);
    expect(imported.session.runs.candidate.samples).toEqual(source.runs.candidate.samples);
    expect(imported.session.provenance).toMatchObject({
      source: "json",
      label: "nominal-session.json",
      importedAt: "2026-08-11T00:00:00.000Z",
      deterministic: false,
      rootSessionSha256: "a".repeat(64),
      parentSessionId: "source-parent",
    });
    expect(imported.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps normalized provenance inside canonical note and string limits", () => {
    const source = generateNominalScenario();
    source.provenance.notes = [
      "x".repeat(MAX_IMPORT_STRING_LENGTH),
      ...Array.from({ length: MAX_IMPORT_PROVENANCE_NOTES - 1 }, (_, index) => `note-${index}`),
    ];

    const first = parseSessionJson(JSON.stringify(source), { importedAt: null });
    expect(first.kind).toBe("session");
    if (first.kind !== "session") throw new Error("expected canonical session import");
    expect(first.session.provenance.notes).toHaveLength(MAX_IMPORT_PROVENANCE_NOTES);
    expect(
      first.session.provenance.notes?.every(
        (note) => note.length > 0 && note.length <= MAX_IMPORT_STRING_LENGTH,
      ),
    ).toBe(true);

    const second = parseSessionJson(JSON.stringify(first.session), { importedAt: null });
    expect(second.kind).toBe("session");
    if (second.kind !== "session") throw new Error("expected canonical session re-import");
    expect(second.session.provenance.notes?.length).toBeLessThanOrEqual(
      MAX_IMPORT_PROVENANCE_NOTES,
    );
    expect(second.session.provenance.notes?.at(1)).toBe("x".repeat(MAX_IMPORT_STRING_LENGTH));
  });

  it("rejects canonical metadata amplification and unsupported interpretation contracts", () => {
    const excessiveTags = generateNominalScenario();
    excessiveTags.mission.tags = Array.from({ length: MAX_IMPORT_TAGS + 1 }, () => "tag");
    expect(() => parseSessionJson(JSON.stringify(excessiveTags))).toThrowError(
      expect.objectContaining({
        issues: [expect.objectContaining({ path: "mission.tags" })],
      }),
    );

    const staleDetector = generateNominalScenario();
    staleDetector.detectors.rules.overcurrent.unavailableReason = "stale imported state";
    const parsed = parseSessionJson(JSON.stringify(staleDetector));
    if (parsed.kind !== "session") throw new Error("expected canonical session import");
    expect(parsed.session.detectors.rules.overcurrent.unavailableReason).toBeUndefined();

    staleDetector.detectors.version = "unsupported";
    expect(() => parseSessionJson(JSON.stringify(staleDetector))).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([expect.objectContaining({ path: "detectors.version" })]),
      }),
    );
  });

  it("keeps the unknown-data type guard semantic and rejects ambiguous evidence identifiers", () => {
    const missingMission = generateNominalScenario() as unknown as Record<string, unknown>;
    delete missingMission.mission;
    expect(isReplaySessionV2(missingMission)).toBe(false);

    const invalid = generateNominalScenario();
    invalid.environment.floorBounds.maxX = invalid.environment.floorBounds.minX;
    invalid.plannedRoute.waypoints[1]!.id = invalid.plannedRoute.waypoints[0]!.id;
    expect(isReplaySessionV2(invalid)).toBe(false);

    const emptyCanonicalText = generateNominalScenario();
    emptyCanonicalText.mission.tags[0] = " ";
    expect(isReplaySessionV2(emptyCanonicalText)).toBe(false);

    const sparse = generateNominalScenario();
    sparse.annotations = new Array(1);
    expect(isReplaySessionV2(sparse)).toBe(false);
    expect(collectSessionValidationIssues(sparse)).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "annotations[0]" })]),
    );
  });

  it("derives a bounded deterministic session ID from a maximum-length candidate ID", () => {
    const candidate = {
      ...generateNominalScenario().runs.candidate,
      id: "c".repeat(MAX_REPLAY_IDENTIFIER_LENGTH),
    };
    const first = createReplaySession({ candidate });
    const second = createReplaySession({ candidate });

    expect(first.id).toBe(second.id);
    expect(first.id.length).toBeLessThanOrEqual(MAX_REPLAY_IDENTIFIER_LENGTH);
    expect(first.mission.id).toBe(first.id);
    expect(collectSessionValidationIssues(first)).toEqual([]);
  });

  it("bounds canonical geometry cardinality and sample-geometry work before deep validation", () => {
    const source = generateNominalScenario();
    const waypoint = source.plannedRoute.waypoints[0];
    const object = source.environment.objects[0];
    const sourceSample = source.runs.candidate.samples[0];
    if (waypoint === undefined || object === undefined || sourceSample === undefined) {
      throw new Error("scenario must provide import limit fixtures");
    }
    source.plannedRoute.waypoints = Array.from(
      { length: MAX_IMPORT_ROUTE_WAYPOINTS + 1 },
      (_, index) => ({ ...waypoint, id: `waypoint-${index}` }),
    );
    source.environment.objects = Array.from(
      { length: MAX_IMPORT_ENVIRONMENT_OBJECTS + 1 },
      (_, index) => ({ ...object, id: `object-${index}` }),
    );
    source.runs.candidate.samples = Array.from({ length: 4_000 }, (_, index) => ({
      ...sourceSample,
      timestamp: index / 20,
      pose: { ...sourceSample.pose },
    }));

    try {
      parseSessionJson(JSON.stringify(source));
      throw new Error("expected canonical import limits to reject the session");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingImportError);
      if (!(error instanceof RecordingImportError)) {
        throw error;
      }
      expect(error.issues).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "plannedRoute.waypoints" }),
          expect.objectContaining({ path: "environment.objects" }),
          expect.objectContaining({
            path: "runs",
            message: expect.stringContaining(`${MAX_IMPORT_GEOMETRY_WORK}`),
          }),
        ]),
      );
      expect(error.issues).toHaveLength(3);
    }
  });

  it("rechecks aggregate limits after composing a baseline into a normalized session", () => {
    const session = generateNominalScenario();
    const candidateCount = Math.floor(MAX_IMPORT_SAMPLES / 2) + 1;
    session.runs.candidate.samples = new Array<SessionTelemetrySample>(candidateCount);
    session.runs.baseline = {
      ...session.runs.candidate,
      id: "aggregate-limit-baseline",
      role: "baseline",
      samples: new Array<SessionTelemetrySample>(MAX_IMPORT_SAMPLES - candidateCount + 1),
    };

    expect(() => assertReplaySessionImportLimits(session)).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: "runs",
            message: expect.stringContaining(`${MAX_IMPORT_SAMPLES}`),
          }),
        ]),
      }),
    );
  });

  it("keeps absent CSV channels null, converts degrees and normalizes time explicitly", async () => {
    const csv = [
      "timestamp,x,y,yaw,sequence,speed",
      "100,1,2,180,10,0.5",
      "100.05,1.1,2,-179,11,",
    ].join("\n");
    const parsed = parseTelemetryCsv(csv, {
      role: "baseline",
      yawUnit: "degrees",
      normalizeTimestampOrigin: true,
      sourceName: "baseline.csv",
    });

    expect(parsed).toMatchObject({
      kind: "run",
      role: "baseline",
      format: "csv",
      sourceName: "baseline.csv",
      timeOriginSeconds: 100,
      timeOriginExact: "100 seconds",
    });
    expect(parsed.run.samples[0]).toMatchObject({
      timestamp: 0,
      sequence: 10,
      speed: 0.5,
      battery: null,
      current: null,
      state: null,
      latencyMs: null,
      poseSigma: null,
    });
    expect(Math.abs(parsed.run.samples[0]?.pose.yaw ?? 0)).toBeCloseTo(Math.PI);
    expect(parsed.run.samples[1]?.timestamp).toBeCloseTo(0.05);
    expect(parsed.run.samples[1]?.speed).toBeNull();
    expect(parsed.availability.speed).toEqual({
      available: true,
      sampleCount: 1,
      totalSamples: 2,
    });

    const autoDetected = await importRecording(csv, {
      format: "auto",
      role: "candidate",
      yawUnit: "degrees",
      normalizeTimestampOrigin: true,
      sourceName: "candidate.csv",
      importedAt: null,
    });
    expect(autoDetected).toMatchObject({ kind: "run", format: "csv", role: "candidate" });
  });

  it("rejects CSV timestamps that collapse when converted to replay precision", () => {
    const csv = ["timestamp,x,y,yaw", "0,0,0,0", "0.0000000004,1,0,0"].join("\n");

    expect(() =>
      parseTelemetryCsv(csv, {
        role: "candidate",
        yawUnit: "radians",
        normalizeTimestampOrigin: true,
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: "timestamp-order",
            path: "rows[3].timestamp",
          }),
        ],
      }),
    );
  });

  it.each([
    ["seconds", "1700000000.123456789", "1700000000.123456790"],
    ["milliseconds", "1700000000123.456789", "1700000000123.456790"],
    ["nanoseconds", "1700000000123456789", "1700000000123456790"],
  ] as const)("preserves epoch-scale one-nanosecond CSV deltas in %s", (unit, first, second) => {
    const parsed = parseTelemetryCsv(
      ["timestamp,x,y,yaw", `${first},0,0,0`, `${second},1,0,0`].join("\n"),
      { role: "candidate", yawUnit: "radians", timestampUnit: unit },
    );

    expect(parsed.run.samples.map(({ timestamp }) => timestamp)).toEqual([0, 0.000000001]);
    expect(parsed.timeOriginExact).toBe(`${first} ${unit}`);
  });

  it("rejects precision-unsafe absolute epochs when CSV rebasing is disabled", () => {
    expect(() =>
      parseTelemetryCsv("timestamp,x,y,yaw\n1700000000.123456789,0,0,0", {
        role: "candidate",
        yawUnit: "radians",
        normalizeTimestampOrigin: false,
      }),
    ).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            path: "rows[2].timestamp",
            message: expect.stringContaining("enable timestamp-origin normalization"),
          }),
        ],
      }),
    );
  });

  it("rejects CSV sample cardinality before materializing telemetry rows", () => {
    const csv = [
      "timestamp,x,y,yaw",
      ...Array.from({ length: MAX_IMPORT_SAMPLES + 1 }, (_, index) => `${index},0,0,0`),
    ].join("\n");

    try {
      parseTelemetryCsv(csv, { role: "candidate", yawUnit: "radians" });
      throw new Error("expected the sample import limit to reject the recording");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingImportError);
      if (!(error instanceof RecordingImportError)) {
        throw error;
      }
      expect(error.issues).toEqual([
        expect.objectContaining({
          path: "rows",
          message: expect.stringContaining(`${MAX_IMPORT_SAMPLES}`),
        }),
      ]);
    }
  });

  it.each(["header", "data"] as const)(
    "rejects over-wide CSV %s rows before materializing unbounded cells",
    (rowKind) => {
      const wideRow = Array.from({ length: MAX_IMPORT_CSV_COLUMNS + 1 }, () => "x").join(",");
      const csv = rowKind === "header" ? `${wideRow}\n0,0,0,0` : `timestamp,x,y,yaw\n${wideRow}`;

      expect(() => parseTelemetryCsv(csv, { role: "candidate", yawUnit: "radians" })).toThrowError(
        expect.objectContaining({
          issues: [
            expect.objectContaining({
              code: "invalid-csv",
              message: expect.stringContaining(`${MAX_IMPORT_CSV_COLUMNS}`),
            }),
          ],
        }),
      );
    },
  );

  it("rejects oversized CSV cells before emitting un-reimportable sample state", () => {
    const state = "x".repeat(MAX_IMPORT_STRING_LENGTH + 1);
    const csv = `timestamp,x,y,yaw,state\n0,0,0,0,${state}`;

    expect(() => parseTelemetryCsv(csv, { role: "candidate", yawUnit: "radians" })).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: "invalid-csv",
            path: "rows[2]",
            message: expect.stringContaining(`${MAX_IMPORT_STRING_LENGTH}`),
          }),
        ],
      }),
    );
  });

  it("surfaces bounded, structured validation issues", () => {
    const invalidRows = Array.from({ length: 30 }, (_, index) => `${index},not-a-number,0,0`);
    const csv = ["timestamp,x,y,yaw", ...invalidRows].join("\n");

    try {
      parseTelemetryCsv(csv, { role: "candidate", yawUnit: "radians" });
      throw new Error("expected import validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(RecordingImportError);
      if (!(error instanceof RecordingImportError)) {
        throw error;
      }
      expect(error.totalIssueCount).toBe(30);
      expect(error.issues).toHaveLength(20);
      expect(error.truncated).toBe(true);
      expect(error.issues[0]).toMatchObject({
        code: "invalid-value",
        field: "x",
        row: 2,
      });
    }
  });

  it("merges rosbridge auxiliary channels into normalized odometry samples", () => {
    const lines = [
      {
        op: "publish",
        topic: "/battery_state",
        msg: { percentage: 0.82, current: -2.5 },
      },
      {
        op: "publish",
        topic: "/diagnostics",
        msg: { values: { latency_ms: 47, pose_sigma: 0.08, state: "tracking" } },
      },
      {
        op: "publish",
        topic: "/odom",
        msg: {
          header: { seq: 40, stamp: { sec: 100, nanosec: 0 } },
          pose: {
            pose: {
              position: { x: 1.5, y: -2 },
              orientation: { x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 },
            },
          },
          twist: { twist: { linear: { x: 0.3, y: 0.4 } } },
        },
      },
      {
        op: "publish",
        topic: "/odom",
        msg: {
          header: { seq: 41, stamp: { sec: 100, nanosec: 50_000_000 } },
          pose: {
            pose: {
              position: { x: 1.55, y: -1.95 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
            },
          },
        },
      },
    ].map((message) => JSON.stringify(message));

    const parsed = parseRosbridgeJsonl(lines.join("\n"), {
      role: "candidate",
      sourceName: "rosbag-export.jsonl",
      normalizeTimestampOrigin: true,
    });

    expect(parsed).toMatchObject({
      kind: "run",
      format: "ros-jsonl",
      role: "candidate",
      timeOriginSeconds: 100,
      timeOriginExact: "100 seconds + 0 nanoseconds",
    });
    expect(parsed.run.samples[0]).toMatchObject({
      timestamp: 0,
      sequence: 40,
      speed: 0.5,
      battery: 82,
      current: -2.5,
      state: "tracking",
      latencyMs: 47,
      poseSigma: 0.08,
    });
    expect(parsed.run.samples[0]?.pose.yaw).toBeCloseTo(Math.PI / 2);
    expect(parsed.run.samples[1]?.timestamp).toBeCloseTo(0.05);
    expect(parsed.run.samples[1]?.speed).toBeNull();
  });

  it("preserves one-nanosecond ROS stamp ordering at epoch scale", () => {
    const odometryLine = (nanosec: number): string =>
      JSON.stringify({
        op: "publish",
        topic: "/odom",
        msg: {
          header: { stamp: { sec: 1_700_000_000, nanosec } },
          pose: {
            pose: {
              position: { x: nanosec, y: 0 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
            },
          },
        },
      });
    const parsed = parseRosbridgeJsonl([odometryLine(123), odometryLine(124)].join("\n"), {
      role: "candidate",
      normalizeTimestampOrigin: true,
    });

    expect(parsed.run.samples.map(({ timestamp }) => timestamp)).toEqual([0, 0.000000001]);
    expect(parsed.timeOriginExact).toBe("1700000000 seconds + 123 nanoseconds");
  });

  it("rejects malformed present ROS optional channels instead of erasing them", () => {
    const line = JSON.stringify({
      op: "publish",
      topic: "/odom",
      msg: {
        header: { seq: "corrupt", stamp: { sec: 1, nanosec: 0 } },
        pose: {
          pose: {
            position: { x: 0, y: 0 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
        twist: { twist: { linear: { x: "corrupt", y: 0 } } },
      },
    });

    expect(() => parseRosbridgeJsonl(line, { role: "candidate" })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "lines[1].msg.header.seq" }),
          expect.objectContaining({ path: "lines[1].msg.twist.twist.linear.x" }),
        ]),
      }),
    );

    const malformedContainers = [
      JSON.stringify({ op: "publish", topic: "/diagnostics", msg: { status: {} } }),
      JSON.stringify({
        op: "publish",
        topic: "/odom",
        msg: {
          header: { seq: 1, stamp: { sec: 1, nanosec: 0 } },
          pose: {
            pose: {
              position: { x: 0, y: 0 },
              orientation: { x: 0, y: 0, z: 0, w: 1 },
            },
          },
          twist: "corrupt",
        },
      }),
    ].join("\n");
    expect(() => parseRosbridgeJsonl(malformedContainers, { role: "candidate" })).toThrowError(
      expect.objectContaining({
        issues: expect.arrayContaining([
          expect.objectContaining({ path: "lines[1].msg.status" }),
          expect.objectContaining({ path: "lines[2].msg.twist" }),
        ]),
      }),
    );
  });

  it("rejects oversized ROS state before emitting an un-reimportable run", () => {
    const line = JSON.stringify({
      op: "publish",
      topic: "/odom",
      msg: {
        header: { stamp: { sec: 1, nanosec: 0 } },
        pose: {
          pose: {
            position: { x: 0, y: 0 },
            orientation: { x: 0, y: 0, z: 0, w: 1 },
          },
        },
        state: "x".repeat(MAX_IMPORT_STRING_LENGTH + 1),
      },
    });

    expect(() => parseRosbridgeJsonl(line, { role: "candidate" })).toThrowError(
      expect.objectContaining({
        issues: [
          expect.objectContaining({
            code: "invalid-value",
            path: "lines[1].msg.state",
            message: expect.stringContaining(`${MAX_IMPORT_STRING_LENGTH}`),
          }),
        ],
      }),
    );
  });
});

function liveHello(sampleRateHz: number | null = 10): LiveHelloMessage {
  return {
    type: "hello",
    schema: LIVE_PROTOCOL_SCHEMA,
    session: {
      id: "live-test",
      source: "telemetry test",
      name: null,
      robotId: null,
      sampleRateHz,
      startedAt: null,
    },
  };
}

function liveSample(timestamp: number, sequence: number | null): LiveSampleMessage {
  return {
    type: "sample",
    sample: {
      timestamp,
      sequence,
      pose: { x: timestamp, y: 0, yaw: 0 },
      speed: 1,
      battery: 80,
      current: 4,
      state: "tracking",
      latencyMs: 20,
      poseSigma: 0.01,
    },
  };
}

interface FakeLiveSocket extends LiveSocket {
  readonly closes: Array<{ code: number | undefined; reason: string | undefined }>;
  emit(data: unknown): void;
  open(): void;
  remoteClose(code: number, wasClean: boolean): void;
}

function fakeLiveSocket(): FakeLiveSocket {
  return {
    binaryType: "arraybuffer",
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    closes: [],
    close(code, reason) {
      this.closes.push({ code, reason });
    },
    emit(data) {
      this.onmessage?.({ data });
    },
    open() {
      this.onopen?.({ type: "open" });
    },
    remoteClose(code, wasClean) {
      this.onclose?.({ code, reason: "test close", wasClean });
    },
  };
}

async function settleLiveQueue(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) {
    await Promise.resolve();
  }
}

describe("live telemetry protocol", () => {
  it("uses one strict decoder for deterministic live messages and preserves null channels", () => {
    const decoded = decodeLiveMessage({
      type: "sample",
      sample: {
        timestamp: 1.5,
        sequence: 30,
        pose: { x: 1, y: 2, yaw: 0.25 },
      },
    });

    expect(decoded).toEqual({
      type: "sample",
      sample: {
        timestamp: 1.5,
        sequence: 30,
        pose: { x: 1, y: 2, yaw: 0.25 },
        speed: null,
        battery: null,
        current: null,
        state: null,
        latencyMs: null,
        poseSigma: null,
      },
    });

    expect(() =>
      decodeLiveMessage({
        type: "hello",
        schema: "robot-replay/live/1.0",
        session: {},
      }),
    ).toThrowError(LiveProtocolError);
    try {
      decodeLiveMessage("{");
    } catch (error) {
      expect(error).toMatchObject({ code: "invalid-json", path: "message" });
    }
  });

  it("accepts only non-negative safe-integer sample sequences", () => {
    const decodeSequence = (sequence: number) =>
      decodeLiveMessage({
        type: "sample",
        sample: {
          timestamp: 1.5,
          sequence,
          pose: { x: 1, y: 2, yaw: 0.25 },
        },
      });

    expect(decodeSequence(Number.MAX_SAFE_INTEGER)).toMatchObject({
      type: "sample",
      sample: { sequence: Number.MAX_SAFE_INTEGER },
    });
    for (const sequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      try {
        decodeSequence(sequence);
        throw new Error(`sequence ${sequence} should have been rejected`);
      } catch (error) {
        expect(error).toMatchObject({
          name: "LiveProtocolError",
          code: "invalid-message",
          path: "message.sample.sequence",
        });
      }
    }
  });

  it("keeps known sequence order across unknown counters without inventing packet loss", () => {
    const transport = new LiveMessageTransport();
    transport.ingest(liveHello(null));
    transport.ingest(liveSample(1, 100));
    transport.ingest(liveSample(2, null));

    expect(() => transport.ingest(liveSample(3, 1))).toThrowError(
      expect.objectContaining({ path: "message.sample.sequence" }),
    );
    transport.ingest(liveSample(3, 105));

    expect(transport.getSnapshot().gaps).toEqual([]);
    expect(transport.getSnapshot().samples.map(({ sequence }) => sequence)).toEqual([
      100,
      null,
      105,
    ]);
  });

  it("aligns endpoint, clock-anchor, sample-rate, and delivery-option admission", () => {
    expect(validateLiveWebSocketUrl("ws://localhost:9000/live", "http:").hostname).toBe(
      "localhost",
    );
    expect(validateLiveWebSocketUrl("ws://127.0.0.1/live", "http:").hostname).toBe("127.0.0.1");
    for (const [url, pageProtocol] of [
      ["ws://example.com/live", "http:"],
      ["ws://[::1]/live", "http:"],
      ["ws://localhost/live", "https:"],
      ["wss://example.com/live#fragment", "https:"],
    ] as const) {
      expect(() => validateLiveWebSocketUrl(url, pageProtocol)).toThrow(TypeError);
    }

    for (const sampleRateHz of [MIN_LIVE_SAMPLE_RATE_HZ, 1e9]) {
      expect(decodeLiveMessage(liveHello(sampleRateHz))).toMatchObject({
        session: { sampleRateHz },
      });
    }
    for (const sampleRateHz of [MIN_LIVE_SAMPLE_RATE_HZ / 2, 1e9 + 1]) {
      expect(() => decodeLiveMessage(liveHello(sampleRateHz))).toThrowError(
        expect.objectContaining({ path: "message.session.sampleRateHz" }),
      );
    }
    const validLeapAnchor = liveHello();
    validLeapAnchor.session.startedAt = "2024-02-29T23:59:59.123Z";
    expect(decodeLiveMessage(validLeapAnchor)).toMatchObject({
      session: { startedAt: validLeapAnchor.session.startedAt },
    });
    for (const startedAt of ["2026-02-31T00:00:00Z", "2025-02-29T00:00:00Z"]) {
      const invalidAnchor = liveHello();
      invalidAnchor.session.startedAt = startedAt;
      expect(() => decodeLiveMessage(invalidAnchor)).toThrowError(
        expect.objectContaining({ path: "message.session.startedAt" }),
      );
    }
    for (const option of ["maximumSamples", "catchUpBatchSize"] as const) {
      expect(
        () => new LiveMessageTransport({ [option]: Number.MAX_SAFE_INTEGER + 1 }),
      ).toThrowError(/safe integer/);
    }
    expect(() =>
      createDeterministicLiveMessages({
        sampleRateHz: MIN_LIVE_SAMPLE_RATE_HZ / 2,
        durationSeconds: 1,
      }),
    ).toThrowError(RangeError);
  });

  it("generates a reproducible stream and makes packet loss visible in the bounded transport", () => {
    const first = createDeterministicLiveMessages({ sampleRateHz: 20, durationSeconds: 23 });
    const second = createDeterministicLiveMessages({ sampleRateHz: 20, durationSeconds: 23 });
    const hello = first[0];
    const end = first.at(-1);
    const samples = first.filter(
      (message): message is LiveSampleMessage => message.type === "sample",
    );

    expect(second).toEqual(first);
    expect(hello).toMatchObject({ type: "hello", schema: LIVE_PROTOCOL_SCHEMA });
    expect(end).toMatchObject({ type: "end", timestamp: 23, reason: "Stream complete" });
    expect(samples.some(({ sample }) => sample.timestamp >= 18 && sample.timestamp < 18.7)).toBe(
      false,
    );

    const transport = new LiveMessageTransport({ maximumSamples: 64 });
    if (hello?.type !== "hello") {
      throw new Error("deterministic stream must begin with hello");
    }
    transport.ingest(hello);
    for (const message of samples.filter(
      ({ sample }) => sample.timestamp >= 17.9 && sample.timestamp <= 18.8,
    )) {
      transport.ingest(message);
    }

    const snapshot = transport.getSnapshot();
    expect(snapshot.state).toBe("live");
    expect(snapshot.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "sequence",
          startTimestamp: 17.95,
          endTimestamp: 18.7,
          missingSamples: 14,
        }),
      ]),
    );
    expect(snapshot.receivedSamples).toBe(
      samples.filter(({ sample }) => sample.timestamp >= 17.9 && sample.timestamp <= 18.8).length,
    );
  });

  it("freezes the simulated pose once the safe stop reports zero speed", () => {
    const samples = createDeterministicLiveMessages({
      sampleRateHz: 20,
      durationSeconds: 23,
    }).filter((message): message is LiveSampleMessage => message.type === "sample");
    const stopped = samples.filter(({ sample }) => sample.state === "safe-stop");
    const beforeStop = samples.filter(({ sample }) => sample.timestamp < 22.4).at(-1);

    expect(stopped.length).toBeGreaterThan(1);
    expect(stopped.every(({ sample }) => sample.speed === 0)).toBe(true);
    expect(stopped.every(({ sample }) => sample.pose.x === stopped[0]?.sample.pose.x)).toBe(true);
    expect(stopped.every(({ sample }) => sample.pose.y === stopped[0]?.sample.pose.y)).toBe(true);
    expect(stopped.every(({ sample }) => sample.pose.yaw === stopped[0]?.sample.pose.yaw)).toBe(
      true,
    );
    expect(beforeStop?.sample.pose).not.toEqual(stopped[0]?.sample.pose);
    expect(stopped.at(-1)?.sample.sequence).toBeGreaterThan(stopped[0]?.sample.sequence ?? 0);
  });

  it("rejects deterministic scenarios whose inclusive eager work exceeds the live sample cap", () => {
    expect(() =>
      createDeterministicLiveMessages({
        sampleRateHz: 20,
        durationSeconds: MAX_LIVE_SAMPLES / 20,
      }),
    ).toThrowError(RangeError);
  });

  it("guards reset callbacks and serializes nested ingestion without rewinding delivery", () => {
    const helloReset = new LiveMessageTransport();
    const helloUpdates: LiveTransportUpdate[] = [];
    helloReset.subscribe((update) => {
      helloUpdates.push(update);
      if (update.type === "state" && update.state === "live") {
        helloReset.reset();
      }
    });
    helloReset.ingest(liveHello());
    expect(helloUpdates.some(({ type }) => type === "hello")).toBe(false);
    expect(helloReset.getSnapshot()).toMatchObject({ state: "disconnected", session: null });

    const gapReset = new LiveMessageTransport();
    const gapUpdates: LiveTransportUpdate[] = [];
    gapReset.ingest(liveHello());
    gapReset.ingest(liveSample(1, 1));
    gapReset.subscribe((update) => {
      gapUpdates.push(update);
      if (update.type === "gap") {
        gapReset.reset();
      }
    });
    gapReset.ingest(liveSample(3, 3));
    expect(
      gapUpdates.some((update) => update.type === "samples" && update.samples[0]?.sequence === 3),
    ).toBe(false);
    expect(gapReset.getSnapshot()).toMatchObject({ state: "disconnected", samples: [] });

    const nested = new LiveMessageTransport();
    const delivered: Array<number | null> = [];
    let queued = false;
    nested.subscribe((update) => {
      if (update.type === "gap" && !queued) {
        queued = true;
        nested.ingest(liveSample(4, 4));
      } else if (update.type === "samples") {
        delivered.push(...update.samples.map(({ sequence }) => sequence));
      }
    });
    nested.ingest(liveHello());
    nested.ingest(liveSample(1, 1));
    nested.ingest(liveSample(3, 3));
    expect(delivered).toEqual([1, 3, 4]);
    expect(nested.getSnapshot()).toMatchObject({ pendingSamples: 0, receivedSamples: 3 });
  });

  it.each(["paused", "catching-up"] as const)(
    "flushes every retained %s sample in bounded batches before end",
    (deliveryState) => {
      const scheduled: Array<{ callback: () => void; canceled: boolean }> = [];
      const updates: LiveTransportUpdate[] = [];
      const transport = new LiveMessageTransport({
        maximumSamples: 5,
        catchUpBatchSize: 2,
        schedule: (callback) => {
          const task = { callback, canceled: false };
          scheduled.push(task);
          return task;
        },
        cancelScheduled: (handle) => {
          (handle as { canceled: boolean }).canceled = true;
        },
      });
      const stream = createDeterministicLiveMessages({ sampleRateHz: 10, durationSeconds: 0.4 });
      const hello = stream.find((message) => message.type === "hello");
      const samples = stream.filter(
        (message): message is LiveSampleMessage => message.type === "sample",
      );
      const end = stream.find((message) => message.type === "end");
      if (hello?.type !== "hello" || end?.type !== "end") {
        throw new Error("deterministic live fixture is incomplete");
      }

      let snapshotAtEnd = null as ReturnType<LiveMessageTransport["getSnapshot"]> | null;
      transport.subscribe((update) => {
        updates.push(update);
        if (update.type === "end") {
          snapshotAtEnd = transport.getSnapshot();
        }
      });
      transport.ingest(hello);
      transport.pauseDelivery();
      for (const message of samples) {
        transport.ingest(message);
      }
      if (deliveryState === "catching-up") {
        transport.resumeDelivery("catch-up");
      }
      updates.length = 0;

      transport.ingest(end);

      const sampleUpdates = updates.filter(
        (update): update is Extract<LiveTransportUpdate, { type: "samples" }> =>
          update.type === "samples",
      );
      const completeIndex = updates.findIndex(
        (update) => update.type === "state" && update.state === "complete",
      );
      const endIndex = updates.findIndex((update) => update.type === "end");
      const finalDeliveryIndex = updates.findIndex(
        (update) =>
          update.type === "delivery" &&
          update.pendingSamples === 0 &&
          !update.paused &&
          !update.catchingUp,
      );

      expect(sampleUpdates.map(({ samples: batch }) => batch.length)).toEqual([2, 2, 1]);
      expect(
        sampleUpdates.flatMap(({ samples: batch }) => batch.map(({ sequence }) => sequence)),
      ).toEqual([0, 1, 2, 3, 4]);
      expect(sampleUpdates.every(({ catchUp }) => catchUp)).toBe(true);
      expect(finalDeliveryIndex).toBeGreaterThan(-1);
      expect(completeIndex).toBeGreaterThan(finalDeliveryIndex);
      expect(endIndex).toBeGreaterThan(completeIndex);
      expect(updates.filter(({ type }) => type === "end")).toHaveLength(1);
      expect(snapshotAtEnd).toMatchObject({
        state: "complete",
        paused: false,
        catchingUp: false,
        pendingSamples: 0,
        receivedSamples: 5,
        droppedSamples: 0,
      });
      expect(snapshotAtEnd?.samples.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3, 4]);

      const terminalUpdateCount = updates.length;
      for (const task of scheduled) {
        task.callback();
      }
      expect(updates).toHaveLength(terminalUpdateCount);
    },
  );

  it("flushes only retained samples after paused history reaches its bound", () => {
    const transport = new LiveMessageTransport({ maximumSamples: 3, catchUpBatchSize: 2 });
    const stream = createDeterministicLiveMessages({ sampleRateHz: 10, durationSeconds: 0.4 });
    const delivered: Array<number | null> = [];
    const hello = stream.find((message) => message.type === "hello");
    const end = stream.find((message) => message.type === "end");
    if (hello?.type !== "hello" || end?.type !== "end") {
      throw new Error("deterministic live fixture is incomplete");
    }
    transport.subscribe((update) => {
      if (update.type === "samples") {
        delivered.push(...update.samples.map(({ sequence }) => sequence));
      }
    });
    transport.ingest(hello);
    transport.pauseDelivery();
    for (const message of stream) {
      if (message.type === "sample") {
        transport.ingest(message);
      }
    }

    transport.ingest(end);

    expect(delivered).toEqual([2, 3, 4]);
    expect(transport.getSnapshot()).toMatchObject({
      pendingSamples: 0,
      receivedSamples: 5,
      droppedSamples: 2,
    });
  });

  it("does not emit catch-up work after an end ingested reentrantly from a sample callback", () => {
    const scheduledCatchUps: Array<() => void> = [];
    const transport = new LiveMessageTransport({
      catchUpBatchSize: 1,
      schedule: (callback) => {
        scheduledCatchUps.push(callback);
        return callback;
      },
      cancelScheduled: () => undefined,
    });
    const stream = createDeterministicLiveMessages({ sampleRateHz: 10, durationSeconds: 0.2 });
    const hello = stream.find((message) => message.type === "hello");
    const end = stream.find((message) => message.type === "end");
    if (hello?.type !== "hello" || end?.type !== "end") {
      throw new Error("deterministic live fixture is incomplete");
    }
    const updates: LiveTransportUpdate[] = [];
    let ending = false;
    transport.subscribe((update) => {
      updates.push(update);
      if (update.type === "samples" && update.catchUp && !ending) {
        ending = true;
        transport.ingest(end);
      }
    });
    transport.ingest(hello);
    transport.pauseDelivery();
    for (const message of stream) {
      if (message.type === "sample") {
        transport.ingest(message);
      }
    }
    transport.resumeDelivery("catch-up");
    updates.length = 0;

    const scheduledCatchUp = scheduledCatchUps[0];
    if (scheduledCatchUp === undefined) {
      throw new Error("catch-up work was not scheduled");
    }
    scheduledCatchUp();

    expect(
      updates.flatMap((update) =>
        update.type === "samples" ? update.samples.map(({ sequence }) => sequence) : [],
      ),
    ).toEqual([0, 1, 2]);
    expect(updates.at(-1)?.type).toBe("end");
    expect(updates.filter(({ type }) => type === "end")).toHaveLength(1);
    expect(transport.getSnapshot()).toMatchObject({
      state: "complete",
      pendingSamples: 0,
      catchingUp: false,
    });
  });

  it("accepts only an exact last-sample replay across a reconnect boundary", () => {
    const stream = createDeterministicLiveMessages({ sampleRateHz: 10, durationSeconds: 0.2 });
    const hello = stream.find((message) => message.type === "hello");
    const sourceSamples = stream.filter(
      (message): message is LiveSampleMessage => message.type === "sample",
    );
    const first = sourceSamples[0];
    const second = sourceSamples[1];
    if (hello?.type !== "hello" || first === undefined || second === undefined) {
      throw new Error("deterministic live fixture is incomplete");
    }
    const transport = new LiveMessageTransport();
    const delivered: Array<number | null> = [];
    transport.subscribe((update) => {
      if (update.type === "samples") {
        delivered.push(...update.samples.map(({ sequence }) => sequence));
      }
    });
    transport.ingest(hello);
    transport.ingest(first);
    expect(() => transport.ingest(first)).toThrowError(LiveProtocolError);

    transport.markDisconnected();
    transport.ingest(hello);
    const exactReplay = decodeLiveMessage(JSON.stringify(first));
    transport.ingest(exactReplay);
    transport.ingest(decodeLiveMessage(JSON.stringify(first)));
    expect(transport.getSnapshot()).toMatchObject({ receivedSamples: 1, pendingSamples: 0 });
    expect(delivered).toEqual([0]);
    expect(transport.getSnapshot().gaps.at(-1)).toMatchObject({
      kind: "transport",
      endTimestamp: null,
    });

    const divergentReplay = decodeLiveMessage({
      ...first,
      sample: { ...first.sample, speed: (first.sample.speed ?? 0) + 1 },
    });
    expect(() => transport.ingest(divergentReplay)).toThrowError(LiveProtocolError);
    transport.ingest(second);

    expect(transport.getSnapshot()).toMatchObject({ receivedSamples: 2, pendingSamples: 0 });
    expect(delivered).toEqual([0, 1]);
    expect(transport.getSnapshot().gaps.at(-1)).toMatchObject({
      kind: "transport",
      endTimestamp: second.sample.timestamp,
      endSequence: second.sample.sequence,
    });
    expect(() => transport.ingest(second)).toThrowError(LiveProtocolError);
  });

  it("owns immutable retained evidence while snapshots expose only detached arrays", () => {
    const hello = liveHello();
    const sourceSample = liveSample(1, 1);
    const sourceEvent = {
      type: "event" as const,
      event: {
        id: "owned-event",
        timestamp: 1,
        kind: "test",
        severity: "critical" as const,
        title: "Owned event",
        description: null,
        details: { source: "original" },
      },
    };
    const end = { type: "end" as const, timestamp: 2, reason: "original end" };
    const transport = new LiveMessageTransport();
    transport.ingest(hello);
    transport.ingest(sourceSample);
    transport.ingest(sourceEvent);
    transport.markDisconnected();
    transport.ingest(end);

    hello.session.id = "mutated";
    sourceSample.sample.pose.x = 999;
    sourceEvent.event.details.source = "mutated";
    end.reason = "mutated";
    const snapshot = transport.getSnapshot();
    expect(snapshot).toMatchObject({
      session: { id: "live-test" },
      samples: [{ pose: { x: 1 } }],
      events: [{ details: { source: "original" } }],
      end: { reason: "original end" },
    });
    for (const retained of [
      snapshot.session,
      snapshot.samples[0],
      snapshot.samples[0]?.pose,
      snapshot.events[0],
      snapshot.events[0]?.details,
      snapshot.gaps[0],
      snapshot.end,
    ]) {
      expect(Object.isFrozen(retained)).toBe(true);
    }
    (snapshot.samples as unknown as unknown[]).length = 0;
    (snapshot.events as unknown as unknown[]).length = 0;
    (snapshot.gaps as unknown as unknown[]).length = 0;
    expect(transport.getSnapshot()).toMatchObject({
      samples: [expect.any(Object)],
      events: [expect.any(Object)],
      gaps: [expect.any(Object)],
    });
  });

  it("keeps aggregate evidence identity and terminal bounds beyond retained-history caps", () => {
    const event = (id: string, timestamp: number, severity: "info" | "critical") => ({
      type: "event" as const,
      event: {
        id,
        timestamp,
        kind: "test",
        severity,
        title: id,
        description: null,
        details: {},
      },
    });
    const transport = new LiveMessageTransport();
    transport.ingest(liveHello(null));
    transport.ingest(liveSample(1, 0));
    transport.ingest(event("critical-first", 3_000, "critical"));
    for (let index = 0; index < 129; index += 1) {
      transport.ingest(event(`info-${index}`, 2, "info"));
    }
    expect(() => transport.ingest(event("critical-first", 3_000, "critical"))).toThrowError(
      expect.objectContaining({ path: "message.event.id" }),
    );
    for (let index = 1; index <= 2_002; index += 1) {
      transport.ingest(liveSample(index + 1, index * 2));
    }

    expect(transport.getSnapshot()).toMatchObject({
      receivedEvents: 130,
      droppedEvents: 2,
      criticalEver: true,
      receivedGaps: 2_002,
      droppedGaps: 2,
    });
    expect(transport.getSnapshot().events).toHaveLength(128);
    expect(transport.getSnapshot().gaps).toHaveLength(2_000);
    expect(transport.getSnapshot().events.some(({ id }) => id === "critical-first")).toBe(false);
    expect(() =>
      transport.ingest({ type: "end", timestamp: 2_500, reason: "before latest event" }),
    ).toThrowError(expect.objectContaining({ path: "message.timestamp" }));

    transport.markDisconnected();
    transport.ingest(liveHello(null));
    transport.ingest(liveSample(2_003, 4_004));
    transport.ingest({ type: "end", timestamp: 3_000, reason: "bounded end" });
    expect(transport.getSnapshot()).toMatchObject({
      state: "complete",
      receivedGaps: 2_003,
      droppedGaps: 3,
    });
    expect(transport.getSnapshot().gaps.at(-1)).toMatchObject({
      kind: "transport",
      endTimestamp: 3_000,
      endSequence: null,
      missingSamples: null,
    });
  });

  it.each([
    ["precise terminal", 6, 0.166667, "none", 1],
    ["sample restart", 1, 1, "restart", 2],
    ["hello disconnect/reconnect", 1, 1, "disconnect-connect", 2],
  ] as const)(
    "keeps simulator lifecycle coherent for %s",
    (_label, sampleRateHz, durationSeconds, action, expectedHellos) => {
      const scheduled: Array<{ callback: () => void; canceled: boolean }> = [];
      const simulator = new DeterministicLiveSimulator({
        sampleRateHz,
        durationSeconds,
        schedule: (callback) => {
          const task = { callback, canceled: false };
          scheduled.push(task);
          return task;
        },
        cancelScheduled: (handle) => {
          (handle as { canceled: boolean }).canceled = true;
        },
      });
      let acted = false;
      let helloCount = 0;
      const errors: Error[] = [];
      simulator.subscribe((update) => {
        if (update.type === "hello") {
          helloCount += 1;
          if (action === "disconnect-connect" && !acted) {
            acted = true;
            simulator.disconnect();
            simulator.connect();
          }
        } else if (update.type === "samples" && action === "restart" && !acted) {
          acted = true;
          simulator.restart();
        } else if (update.type === "error") {
          errors.push(update.error);
        }
      });
      simulator.connect();
      let work = 0;
      while (scheduled.length > 0 && work < 40) {
        const task = scheduled.shift();
        if (task !== undefined && !task.canceled) {
          task.callback();
        }
        work += 1;
      }

      expect(work).toBeLessThan(40);
      expect(errors).toEqual([]);
      expect(helloCount).toBe(expectedHellos);
      expect(simulator.state).toBe("complete");
    },
  );

  it("honors disconnect requested synchronously from a simulator restart reset", () => {
    const scheduled: Array<{ callback: () => void; canceled: boolean }> = [];
    const simulator = new DeterministicLiveSimulator({
      sampleRateHz: 1,
      durationSeconds: 1,
      schedule: (callback) => {
        const task = { callback, canceled: false };
        scheduled.push(task);
        return task;
      },
      cancelScheduled: (handle) => {
        (handle as { canceled: boolean }).canceled = true;
      },
    });
    let stopDuringRestart = false;
    simulator.subscribe((update) => {
      if (stopDuringRestart && update.type === "state" && update.state === "disconnected") {
        simulator.disconnect();
      }
    });
    simulator.connect();
    scheduled.shift()?.callback();
    stopDuringRestart = true;
    simulator.restart();

    expect(simulator.state).toBe("disconnected");
    expect(scheduled.every(({ canceled }) => canceled)).toBe(true);
  });

  it.each(["complete-state", "end"] as const)(
    "keeps a simulator restart requested from the terminal %s callback",
    (trigger) => {
      const scheduled: Array<{ callback: () => void; canceled: boolean }> = [];
      const simulator = new DeterministicLiveSimulator({
        sampleRateHz: 1,
        durationSeconds: 0.1,
        schedule: (callback) => {
          const task = { callback, canceled: false };
          scheduled.push(task);
          return task;
        },
        cancelScheduled: (handle) => {
          (handle as { canceled: boolean }).canceled = true;
        },
      });
      let requestedRestart = false;
      let helloCount = 0;
      let endCount = 0;
      simulator.subscribe((update) => {
        if (update.type === "hello") {
          helloCount += 1;
        }
        if (update.type === "end") {
          endCount += 1;
        }
        const matchesTrigger =
          (trigger === "end" && update.type === "end") ||
          (trigger === "complete-state" && update.type === "state" && update.state === "complete");
        if (matchesTrigger && !requestedRestart) {
          requestedRestart = true;
          simulator.connect();
        }
      });

      simulator.connect();
      let work = 0;
      while (scheduled.length > 0 && work < 20) {
        const task = scheduled.shift();
        if (task !== undefined && !task.canceled) {
          task.callback();
        }
        work += 1;
      }

      expect(work).toBeLessThan(20);
      expect(helloCount).toBe(2);
      expect(endCount).toBe(2);
      expect(simulator.state).toBe("complete");
    },
  );

  it("guards canceled, completed, and invalid-terminal WebSocket attempts", async () => {
    let canceledAllocations = 0;
    const canceled = new WebSocketLiveClient({
      url: "ws://localhost/live",
      pageProtocol: "http:",
      webSocketFactory: () => {
        canceledAllocations += 1;
        return fakeLiveSocket();
      },
      schedule: () => Symbol("timer"),
      cancelScheduled: () => undefined,
    });
    canceled.subscribe((update) => {
      if (update.type === "state" && update.state === "connecting") {
        canceled.disconnect();
      }
    });
    canceled.connect();
    expect(canceledAllocations).toBe(0);
    expect(canceled.state).toBe("disconnected");

    const completedSockets: FakeLiveSocket[] = [];
    const completed = new WebSocketLiveClient({
      url: "ws://localhost/live",
      pageProtocol: "http:",
      webSocketFactory: () => {
        const socket = fakeLiveSocket();
        completedSockets.push(socket);
        return socket;
      },
      schedule: () => Symbol("timer"),
      cancelScheduled: () => undefined,
    });
    completed.connect();
    completedSockets[0]?.emit(JSON.stringify(liveHello()));
    completedSockets[0]?.emit(JSON.stringify(liveSample(1, 1)));
    completedSockets[0]?.emit(JSON.stringify({ type: "end", timestamp: 1, reason: "done" }));
    await settleLiveQueue();
    expect(completed.getSnapshot()).toMatchObject({ state: "complete", receivedSamples: 1 });
    completed.disconnect();
    completed.connect();
    expect(completedSockets).toHaveLength(2);
    expect(completed.getSnapshot()).toMatchObject({
      state: "connecting",
      session: null,
      samples: [],
      end: null,
      receivedSamples: 0,
    });

    const replacementSockets: FakeLiveSocket[] = [];
    const replacement = new WebSocketLiveClient({
      url: "ws://localhost/live",
      pageProtocol: "http:",
      webSocketFactory: () => {
        const socket = fakeLiveSocket();
        replacementSockets.push(socket);
        return socket;
      },
      schedule: () => Symbol("timer"),
      cancelScheduled: () => undefined,
    });
    let replaced = false;
    replacement.subscribe((update) => {
      if (update.type === "error" && !replaced) {
        replaced = true;
        replacement.disconnect();
        replacement.connect();
      }
    });
    replacement.connect();
    replacementSockets[0]?.emit(JSON.stringify(liveHello()));
    replacementSockets[0]?.emit(JSON.stringify(liveSample(10, 10)));
    replacementSockets[0]?.emit(
      JSON.stringify({ type: "end", timestamp: 9, reason: "invalid end" }),
    );
    await settleLiveQueue();
    expect(replacementSockets).toHaveLength(2);
    expect(replacement.state).toBe("connecting");
  });

  it("uses only newly retained samples for stale recovery and backoff reset", async () => {
    type Scheduled = { callback: () => void; delayMs: number; canceled: boolean };
    const scheduled: Scheduled[] = [];
    const sockets: FakeLiveSocket[] = [];
    const client = new WebSocketLiveClient({
      url: "ws://localhost/live",
      pageProtocol: "http:",
      staleAfterMs: 50,
      schedule: (callback, delayMs) => {
        const task = { callback, delayMs, canceled: false };
        scheduled.push(task);
        return task;
      },
      cancelScheduled: (handle) => {
        (handle as Scheduled).canceled = true;
      },
      webSocketFactory: () => {
        const socket = fakeLiveSocket();
        sockets.push(socket);
        return socket;
      },
    });
    const take = (delayMs: number): Scheduled => {
      const index = scheduled.findIndex((task) => !task.canceled && task.delayMs === delayMs);
      expect(index).toBeGreaterThanOrEqual(0);
      return scheduled.splice(index, 1)[0]!;
    };

    client.connect();
    sockets[0]?.open();
    const eventOnlyStale = scheduled.find((task) => !task.canceled && task.delayMs === 50);
    sockets[0]?.emit(JSON.stringify(liveHello(100)));
    sockets[0]?.emit(
      JSON.stringify({
        type: "event",
        event: {
          id: "event-only-traffic",
          timestamp: 0,
          kind: "test",
          severity: "info",
          title: "Event only",
          description: null,
          details: {},
        },
      }),
    );
    await settleLiveQueue();
    expect(eventOnlyStale?.canceled).toBe(true);
    expect(scheduled.filter(({ canceled, delayMs }) => !canceled && delayMs === 50)).toHaveLength(
      1,
    );
    const firstStale = take(50);
    expect(firstStale).not.toBe(eventOnlyStale);
    firstStale.callback();
    expect(client.state).toBe("reconnecting");
    take(1_000).callback();

    sockets[1]?.open();
    sockets[1]?.emit(JSON.stringify(liveHello(100)));
    await settleLiveQueue();
    take(50).callback();
    expect(client.state).toBe("reconnecting");
    take(2_000).callback();

    sockets[2]?.open();
    sockets[2]?.emit(JSON.stringify(liveHello(100)));
    sockets[2]?.emit(JSON.stringify(liveSample(1, 1)));
    await settleLiveQueue();
    sockets[2]?.remoteClose(1006, false);
    expect(client.state).toBe("reconnecting");
    take(1_000).callback();

    sockets[3]?.open();
    const replayStale = scheduled.find((task) => !task.canceled && task.delayMs === 50);
    sockets[3]?.emit(JSON.stringify(liveHello(100)));
    sockets[3]?.emit(JSON.stringify(liveSample(1, 1)));
    await settleLiveQueue();
    expect(client.getSnapshot().receivedSamples).toBe(1);
    expect(replayStale?.canceled).toBe(true);
    const replayTimeout = take(50);
    expect(replayTimeout).not.toBe(replayStale);
    replayTimeout.callback();
    expect(client.state).toBe("reconnecting");
    expect(scheduled.some(({ canceled, delayMs }) => !canceled && delayMs === 2_000)).toBe(true);
  });

  it("derives first and subsequent sample freshness windows from a low-rate hello", async () => {
    type Scheduled = { callback: () => void; delayMs: number; canceled: boolean };
    const scheduled: Scheduled[] = [];
    const socket = fakeLiveSocket();
    const client = new WebSocketLiveClient({
      url: "ws://localhost/live",
      pageProtocol: "http:",
      staleAfterMs: 3_000,
      schedule: (callback, delayMs) => {
        const task = { callback, delayMs, canceled: false };
        scheduled.push(task);
        return task;
      },
      cancelScheduled: (handle) => {
        (handle as Scheduled).canceled = true;
      },
      webSocketFactory: () => socket,
    });
    const activeTask = (delayMs: number): Scheduled => {
      const task = scheduled.find(
        (candidate) => !candidate.canceled && candidate.delayMs === delayMs,
      );
      expect(task).toBeDefined();
      return task!;
    };

    client.connect();
    const connectionTimeout = activeTask(3_000);
    socket.open();
    expect(connectionTimeout.canceled).toBe(true);
    const handshakeTimeout = activeTask(3_000);

    socket.emit(JSON.stringify(liveHello(0.1)));
    await settleLiveQueue();
    expect(client.state).toBe("live");
    expect(handshakeTimeout.canceled).toBe(true);
    const firstSampleTimeout = activeTask(30_000);

    socket.emit(JSON.stringify(liveSample(0, 0)));
    await settleLiveQueue();
    expect(firstSampleTimeout.canceled).toBe(true);
    const nextSampleTimeout = activeTask(30_000);

    socket.emit(JSON.stringify(liveSample(10, 1)));
    await settleLiveQueue();
    expect(nextSampleTimeout.canceled).toBe(true);
    const terminalFreshnessTimeout = activeTask(30_000);

    terminalFreshnessTimeout.callback();
    expect(client.state).toBe("reconnecting");
    expect(socket.closes).toEqual([{ code: 4000, reason: "sample freshness timeout" }]);
    expect(activeTask(1_000)).toBeDefined();
  });

  it.each(["complete-state", "end"] as const)(
    "keeps a WebSocket restart requested from the terminal %s callback",
    async (trigger) => {
      type FakeSocket = LiveSocket & {
        readonly closes: Array<{ code: number | undefined; reason: string | undefined }>;
        emit(data: unknown): void;
      };
      const sockets: FakeSocket[] = [];
      const socketFactory = (): FakeSocket => {
        const socket: FakeSocket = {
          binaryType: "arraybuffer",
          onopen: null,
          onmessage: null,
          onerror: null,
          onclose: null,
          closes: [],
          close(code, reason) {
            this.closes.push({ code, reason });
          },
          emit(data) {
            this.onmessage?.({ data });
          },
        };
        sockets.push(socket);
        return socket;
      };
      const client = new WebSocketLiveClient({
        url: "ws://localhost/live",
        pageProtocol: "http:",
        webSocketFactory: socketFactory,
        schedule: () => Symbol("timer"),
        cancelScheduled: () => undefined,
      });
      let requestedRestart = false;
      client.subscribe((update) => {
        const matchesTrigger =
          (trigger === "end" && update.type === "end") ||
          (trigger === "complete-state" && update.type === "state" && update.state === "complete");
        if (matchesTrigger && !requestedRestart) {
          requestedRestart = true;
          client.connect();
        }
      });
      const settleQueue = async (): Promise<void> => {
        for (let turn = 0; turn < 12; turn += 1) {
          await Promise.resolve();
        }
      };
      const stream = createDeterministicLiveMessages({ sampleRateHz: 1, durationSeconds: 0.1 });
      const hello = stream.find((message) => message.type === "hello");
      const end = stream.find((message) => message.type === "end");
      if (hello?.type !== "hello" || end?.type !== "end") {
        throw new Error("deterministic live fixture is incomplete");
      }

      client.connect();
      sockets[0]?.emit(JSON.stringify(hello));
      await settleQueue();
      expect(client.state).toBe("live");
      sockets[0]?.emit(JSON.stringify(end));
      await settleQueue();

      expect(sockets).toHaveLength(2);
      expect(sockets[0]?.closes).toEqual([{ code: 1000, reason: "stream complete" }]);
      expect(sockets[1]?.closes).toEqual([]);
      expect(client.state).toBe("connecting");
      sockets[1]?.emit(JSON.stringify(hello));
      await settleQueue();
      expect(client.state).toBe("live");
      expect(client.getSnapshot().samples).toEqual([]);
    },
  );
});
