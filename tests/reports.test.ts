import { afterEach, describe, expect, it, vi } from "vitest";

import type { Anomaly, ReplaySessionRun, TelemetryRun, TelemetrySample } from "../src/core/types";
import {
  createIncidentReport,
  createIncidentReportArtifact,
  downloadIncidentReport,
  downloadIncidentReportJson,
  downloadIncidentReportJSON,
  downloadIncidentReportMarkdown,
  incidentReportToJson,
  incidentReportToJSON,
  incidentReportToHtml,
  incidentReportToMarkdown,
  type IncidentDetectorRunAvailability,
} from "../src/reports";
import { sessionRunToTelemetryRun } from "../src/ui/session-view";

const originalDocumentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document");

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalDocumentDescriptor === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", originalDocumentDescriptor);
  }
});

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

function run(samples: TelemetrySample[], overrides: Partial<TelemetryRun> = {}): TelemetryRun {
  return {
    id: "report-run",
    name: "Report run",
    kind: "faulty",
    samples,
    ...overrides,
  };
}

describe("incident reports", () => {
  it("reports peak current by absolute magnitude and serializes run content", () => {
    const report = createIncidentReport({
      run: run([
        sample(0, 0, { current: 12 }),
        sample(1, 1, { current: -31.25 }),
        sample(2, 2, { current: 20 }),
      ]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.runs[0]?.telemetry.peakCurrent).toBe(31.25);
    const exported = JSON.parse(incidentReportToJson(report)) as Record<string, unknown>;
    expect(exported.runs).toEqual(report.runs);
  });

  it("exports evidence, detector, and transformation content", () => {
    const availability = [{ runId: "report-run", available: true }] as const;
    const report = createIncidentReport({
      run: run([sample(0, 0), sample(1, 1, { current: 22 })]),
      anomalies: [
        {
          id: "overcurrent-1",
          type: "overcurrent",
          severity: "critical",
          timestamp: 1,
          endTimestamp: 1.2,
          sampleIndex: 1,
          title: "Control load saturation",
          description: "Current exceeded the configured operating band.",
          details: { peakCurrent: 22 },
        },
      ],
      generatedAt: "2026-08-11T00:00:00.000Z",
      provenance: {
        sourceType: "derived",
        sourceName: "RPL-042 local branch",
        sourceFormat: "robot-replay/session/2.0",
        sourceFingerprint: "a".repeat(64),
        fingerprintAlgorithm: "SHA-256",
        parentSessionId: "session-root",
        rootSessionSha256: "b".repeat(64),
        originalSampleCount: 2,
        privacy: "local-only",
      },
      detectorConfigurations: [
        {
          id: "overcurrent",
          label: "Motor overcurrent",
          version: "2.0.0",
          enabled: true,
          thresholds: { currentA: 18, minimumDurationS: 0.25 },
          availability,
        },
      ],
      evidenceRanges: [
        {
          id: "range-overcurrent-1",
          label: "Sustained current window",
          startTimestamp: 1,
          endTimestamp: 1.2,
          anomalyId: "overcurrent-1",
          observed: 22,
          threshold: 18,
          unit: "A",
          supportingSampleCount: 2,
        },
      ],
      evidenceChain: [
        {
          id: "chain-step-1",
          label: "Drive load exceeded threshold",
          timestamp: 1,
          endTimestamp: 1.2,
          anomalyId: "overcurrent-1",
          kind: "condition",
          relationship: "detector-correlation",
          confidence: 0.93,
          evidenceRangeIds: ["range-overcurrent-1"],
        },
      ],
      derivedMetrics: [
        {
          id: "peak-current",
          label: "Peak current",
          value: 22,
          baselineValue: 10,
          delta: 12,
          unit: "A",
        },
      ],
      annotations: [
        {
          id: "annotation-1",
          timestamp: 1,
          text: "Inspect wheel-load telemetry.",
          author: "Operator",
          tags: ["controls"],
        },
      ],
      faultTransformations: [
        {
          id: "motor-load-1",
          type: "motor-load",
          startTimestamp: 1,
          endTimestamp: 1.2,
          parameters: { multiplier: 1.8 },
        },
      ],
    });

    expect(report).toMatchObject({
      schemaVersion: "robot-replay-incident/2.0",
      provenance: {
        sourceType: "derived",
        privacy: "local-only",
        parentSessionId: "session-root",
        rootSessionSha256: "b".repeat(64),
      },
      detectorConfigurations: [
        {
          id: "overcurrent",
          enabled: true,
          availability: [{ runId: "report-run", available: true }],
        },
      ],
      evidenceRanges: [{ id: "range-overcurrent-1", supportingSampleCount: 2 }],
      evidenceChain: [{ id: "chain-step-1", confidence: 0.93 }],
      derivedMetrics: [{ id: "peak-current", delta: 12 }],
      annotations: [{ id: "annotation-1", tags: ["controls"] }],
      faultTransformations: [{ id: "motor-load-1", parameters: { multiplier: 1.8 } }],
    });
    expect(report.causalityNotice).toContain("do not establish causal proof");
    expect(report.detectorConfigurations?.[0]?.availability).not.toBe(availability);
    expect(report.detectorConfigurations?.[0]?.availability?.[0]).not.toBe(availability[0]);

    const markdown = incidentReportToMarkdown(report);
    expect(markdown).toContain("## Evidence chain");
    expect(markdown).toContain("## Detector configuration");
    expect(markdown).toContain("## Fault transformations");
    expect(markdown).toContain(String.raw`report\-run: available`);

    const html = incidentReportToHtml(report);
    expect(html).toContain("<!doctype html>");
    expect(html).toContain("Evidence chain");
    expect(html).toContain("report-run: available");

    const artifact = createIncidentReportArtifact(report, "html");
    expect(artifact).toMatchObject({
      filename: "report-run-incident-report.html",
      mimeType: "text/html;charset=utf-8",
    });
  });

  it("renders and validates structured per-run detector availability and branch lineage", () => {
    const candidate = run([sample(0, 0)], { id: "candidate" });
    const baseline = run([sample(0, 0)], {
      id: "baseline",
      name: "Baseline",
      kind: "normal",
    });
    const availability: readonly IncidentDetectorRunAvailability[] = [
      { runId: "candidate", available: true },
      { runId: "baseline", available: false, reason: "Link latency is unavailable." },
    ];
    const report = createIncidentReport({
      run: candidate,
      anomalies: [],
      comparisonRun: baseline,
      detectorConfigurations: [
        {
          id: "link-degradation",
          enabled: true,
          availability,
        },
      ],
      provenance: {
        parentSessionId: "source-session",
        rootSessionSha256: "c".repeat(64),
      },
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    const markdown = incidentReportToMarkdown(report);
    const html = incidentReportToHtml(report);
    expect(markdown).toContain("baseline: unavailable — Link latency is unavailable");
    expect(html).toContain("baseline: unavailable — Link latency is unavailable.");
    expect(report.detectorConfigurations?.[0]?.availability).not.toBe(availability);

    const inputWithAvailability = (
      detectorAvailability: readonly IncidentDetectorRunAvailability[],
    ) => ({
      run: candidate,
      anomalies: [],
      comparisonRun: baseline,
      detectorConfigurations: [
        { id: "link-degradation", enabled: true, availability: detectorAvailability },
      ],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(() =>
      createIncidentReport(inputWithAvailability([{ runId: "missing", available: true }])),
    ).toThrow('references unknown run ID "missing"');
    expect(() =>
      createIncidentReport(
        inputWithAvailability([
          { runId: "candidate", available: true },
          { runId: "candidate", available: true },
        ]),
      ),
    ).toThrow('availability contains duplicate run ID "candidate"');
    expect(() =>
      createIncidentReport(inputWithAvailability([{ runId: "candidate", available: false }])),
    ).toThrow("reason is required when the detector is unavailable");
    expect(() =>
      createIncidentReport(
        inputWithAvailability([{ runId: "candidate", available: false, reason: "   " }]),
      ),
    ).toThrow("reason must be a non-empty string when provided");
    expect(() =>
      createIncidentReport(
        inputWithAvailability([
          {
            runId: "candidate",
            available: "yes",
          } as unknown as IncidentDetectorRunAvailability,
        ]),
      ),
    ).toThrow("available must be a boolean");
    expect(() =>
      createIncidentReport({
        run: candidate,
        anomalies: [],
        provenance: { parentSessionId: "   " },
        generatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow("provenance.parentSessionId must be a non-empty string");
    expect(() =>
      createIncidentReport({
        run: candidate,
        anomalies: [],
        provenance: { rootSessionSha256: "ABC" },
        generatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow("provenance.rootSessionSha256 must be 64 lowercase hexadecimal digits");
  });

  it("validates evidence sample counts and safely renders malformed direct serializer input", () => {
    const input = {
      run: run([sample(0, 0)]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
      evidenceRanges: [
        {
          id: "range-1",
          label: "Evidence",
          startTimestamp: 0,
          endTimestamp: 0,
          supportingSampleCount: Number.NaN,
        },
      ],
    };
    expect(() => createIncidentReport(input)).toThrow(
      'Evidence range "range-1" supportingSampleCount must be a non-negative safe integer.',
    );

    const report = createIncidentReport({
      ...input,
      evidenceRanges: [{ ...input.evidenceRanges[0], supportingSampleCount: 2_000 }],
    });
    const hostileCount = "<style>main{display:none}</style>";
    const malformed = {
      ...report,
      evidenceRanges: [
        {
          ...report.evidenceRanges?.[0],
          supportingSampleCount: hostileCount,
        },
      ],
    } as unknown as typeof report;

    expect(incidentReportToMarkdown(report)).toContain("| 2,000 |");
    expect(incidentReportToHtml(report)).toContain('<td class="numeric">2,000</td>');
    expect(incidentReportToMarkdown(malformed)).not.toContain(hostileCount);
    expect(incidentReportToHtml(malformed)).not.toContain(hostileCount);
  });

  it("handles an empty run and no incidents without invalid reductions", () => {
    const report = createIncidentReport({
      run: run([]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.summary.anomalyCount).toBe(0);
    expect(report.runs[0]).toMatchObject({
      sampleCount: 0,
      startTimestamp: null,
      endTimestamp: null,
      durationSeconds: 0,
      telemetry: {
        averageSpeed: null,
        maximumSpeed: null,
        minimumBattery: null,
        endingBattery: null,
        peakCurrent: null,
      },
    });
    expect(incidentReportToMarkdown(report)).toContain("No incidents detected.");
  });

  it("does not turn a missing normalized state into a controller state transition", () => {
    const normalizedRun: ReplaySessionRun = {
      id: "nullable-state-run",
      name: "Nullable state run",
      role: "candidate",
      kind: "normal",
      samples: ["tracking", null, "tracking"].map((state, index) => ({
        timestamp: index,
        sequence: index,
        pose: { x: index, y: 0, yaw: 0 },
        speed: 1,
        battery: 80,
        current: 8,
        state,
        latencyMs: null,
        poseSigma: null,
      })),
    };

    const report = createIncidentReport({
      run: sessionRunToTelemetryRun(normalizedRun),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.runs[0]?.telemetry).toMatchObject({
      states: ["tracking"],
      stateTransitions: 0,
    });
    expect(incidentReportToMarkdown(report)).not.toContain("Unavailable →");
  });

  it("escapes Markdown structure, raw HTML and backticks in every plain-text field", () => {
    const hostile = '<script>alert("x")</script> `tick` **bold** | [click](javascript:alert(1))';
    const anomaly: Anomaly = {
      id: hostile,
      type: "overcurrent",
      severity: "critical",
      timestamp: 0,
      sampleIndex: 0,
      title: hostile,
      description: `<img src=x onerror=alert(1)>\n# heading`,
      details: { [hostile]: hostile },
    };
    const report = createIncidentReport({
      run: run([sample(0, 0, { state: hostile })], {
        id: hostile,
        name: hostile,
        description: hostile,
      }),
      anomalies: [anomaly],
      title: hostile,
      notes: `${hostile}\n<div>unsafe</div>`,
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    const markdown = incidentReportToMarkdown(report);

    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("<img");
    expect(markdown).not.toContain("<div>");
    expect(markdown).not.toContain("<br>");
    expect(markdown).not.toContain("`");
    expect(markdown).toContain("&lt;script&gt;");
    expect(markdown).toContain("&#96;tick&#96;");
    expect(markdown).toContain("\\*\\*bold\\*\\*");
    expect(markdown).toContain("\\[click\\]\\(javascript:alert\\(1\\)\\)");
  });

  it("summarizes 200,000 samples without spread-argument overflow", () => {
    const samples = Array.from({ length: 200_000 }, (_, index) =>
      sample(index / 100, index, {
        speed: index % 2,
        battery: 100 - index / 10_000,
        current: index === 150_000 ? -42 : 8,
      }),
    );

    const report = createIncidentReport({
      run: run(samples),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.runs[0]).toMatchObject({
      sampleCount: 200_000,
      durationSeconds: 1999.99,
      telemetry: {
        averageSpeed: 0.5,
        maximumSpeed: 1,
        peakCurrent: 42,
      },
    });
  });

  it("keeps finite summary inputs finite and exports an unavailable overflowing duration", () => {
    const report = createIncidentReport({
      run: run([
        sample(-Number.MAX_VALUE, 0, { speed: Number.MAX_VALUE }),
        sample(Number.MAX_VALUE, 1, { speed: Number.MAX_VALUE }),
      ]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.runs[0]?.durationSeconds).toBeNull();
    expect(report.runs[0]?.telemetry.averageSpeed).toBe(Number.MAX_VALUE);
    expect(Number.isFinite(report.runs[0]?.telemetry.averageSpeed ?? Number.NaN)).toBe(true);

    const json = JSON.parse(incidentReportToJson(report)) as typeof report;
    const markdown = incidentReportToMarkdown(report);
    const html = incidentReportToHtml(report);
    expect(json.runs[0]?.durationSeconds).toBeNull();
    expect(json.runs[0]?.telemetry.averageSpeed).toBe(Number.MAX_VALUE);
    expect(markdown).not.toMatch(/Infinity|∞/);
    expect(html).not.toMatch(/Infinity|∞/);
  });

  it("compares runs, orders tied incidents and renders ranges and negative times", () => {
    const warning = (id: string, timestamp: number): Anomaly => ({
      id,
      type: "timestamp-gap",
      severity: "warning",
      timestamp,
      sampleIndex: 0,
      title: `Warning ${id}`,
      description: "Warning detail",
      details: {},
    });
    const ranged: Anomaly = {
      id: "z-critical",
      type: "overcurrent",
      severity: "critical",
      timestamp: 2,
      endTimestamp: 3,
      sampleIndex: 2,
      title: "Sustained current",
      description: "Current remained high",
      details: {},
    };
    const primary = run(
      [
        sample(2, 2, { state: "done" }),
        sample(0, 0, { state: "idle" }),
        sample(1, 1, { state: "moving" }),
      ],
      { description: "Primary run", sampleRateHz: 1 },
    );
    const baseline = run([sample(0, 0), sample(1, 1)], {
      id: "baseline",
      name: "Baseline",
      kind: "normal",
    });

    const report = createIncidentReport({
      run: primary,
      anomalies: [warning("b-warning", 1), ranged],
      comparison: {
        run: baseline,
        anomalies: [warning("a-warning", 1), warning("negative", -1)],
      },
      title: "  Comparison report  ",
      selectedTimestamp: 1.25,
      generatedAt: new Date("2026-08-11T00:00:00.000Z"),
      notes: "  reviewed  ",
    });

    expect(report.title).toBe("Comparison report");
    expect(report.selectedTimestamp).toBe(1.25);
    expect(report.notes).toBe("reviewed");
    expect(report.summary).toMatchObject({
      runCount: 2,
      anomalyCount: 4,
      warning: 3,
      critical: 1,
    });
    expect(report.runs[0]).toMatchObject({
      description: "Primary run",
      sampleRateHz: 1,
      startTimestamp: 0,
      endTimestamp: 2,
      telemetry: {
        states: ["idle", "moving", "done"],
        stateTransitions: 2,
      },
    });
    expect(report.anomalies.map(({ id }) => id)).toEqual([
      "negative",
      "a-warning",
      "b-warning",
      "z-critical",
    ]);

    const markdown = incidentReportToMarkdown(report);
    expect(markdown).toContain("Selected replay time: 00:01.250");
    expect(markdown).toContain("−00:01.000");
    expect(markdown).toContain("00:02.000–00:03.000");
    expect(markdown).toContain("| — |");
  });

  it("rounds replay time across minute boundaries and labels collapsed source ranges", () => {
    const report = createIncidentReport({
      run: run([sample(0, 0), sample(60, 1)]),
      anomalies: [
        {
          id: "sub-millisecond-window",
          type: "overcurrent",
          severity: "warning",
          timestamp: 1.0004,
          endTimestamp: 1.00049,
          sampleIndex: 0,
          title: "Narrow window",
          description: "Distinct source timestamps share millisecond display precision.",
          details: {},
        },
      ],
      selectedTimestamp: 59.9996,
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    const markdown = incidentReportToMarkdown(report);
    const html = incidentReportToHtml(report);
    expect(markdown).toContain("Selected replay time: 01:00.000");
    expect(markdown).toContain("00:01.000–00:01.000 (sub-millisecond source span)");
    expect(html).toContain("Selected replay time: 01:00.000");
    expect(html).toContain("00:01.000–00:01.000 (sub-millisecond source span)");
    expect(markdown).not.toContain("00:60.000");
  });

  it("run-scopes colliding legacy anomaly IDs and keeps every export reference aligned", () => {
    const legacyAnomaly = (title: string): Anomaly => ({
      id: "shared",
      type: "overcurrent",
      severity: "critical",
      timestamp: 1,
      sampleIndex: 1,
      title,
      description: `${title} detail`,
      details: { detectorId: "overcurrent" },
    });
    const candidate = run([sample(0, 0), sample(1, 1)], {
      id: "candidate",
      name: "Candidate",
    });
    const baseline = run([sample(0, 0), sample(1, 1)], {
      id: "baseline",
      name: "Baseline",
      kind: "normal",
    });
    const evidenceRanges = [
      {
        id: "candidate-range",
        label: "Candidate evidence",
        startTimestamp: 1,
        endTimestamp: 1,
        runId: "candidate",
        anomalyId: "shared",
      },
      {
        id: "baseline-range",
        label: "Baseline evidence",
        startTimestamp: 1,
        endTimestamp: 1,
        runId: "baseline",
        anomalyId: "shared",
      },
    ];
    const evidenceChain = [
      {
        id: "candidate-chain",
        label: "Candidate condition",
        timestamp: 1,
        runId: "candidate",
        anomalyId: "shared",
        evidenceRangeIds: ["candidate-range"],
      },
      {
        id: "baseline-chain",
        label: "Baseline condition",
        timestamp: 1,
        runId: "baseline",
        anomalyId: "shared",
        evidenceRangeIds: ["baseline-range"],
      },
    ];
    const input = {
      run: candidate,
      anomalies: [legacyAnomaly("Candidate load")],
      comparisonRun: baseline,
      comparisonAnomalies: [legacyAnomaly("Baseline load")],
      evidenceRanges,
      evidenceChain,
      generatedAt: "2026-08-11T00:00:00.000Z",
    };

    const report = createIncidentReport(input);
    const repeated = createIncidentReport(input);
    const idsByRun = Object.fromEntries(
      report.anomalies.map((anomaly) => [anomaly.runId, anomaly.id]),
    );

    expect(report.summary.anomalyCount).toBe(2);
    expect(report.runs.map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "candidate", role: "candidate" },
      { id: "baseline", role: "baseline" },
    ]);
    expect(new Set(report.anomalies.map(({ id }) => id)).size).toBe(2);
    expect(idsByRun).toEqual({
      baseline: "baseline:shared",
      candidate: "candidate:shared",
    });
    expect(repeated.anomalies).toEqual(report.anomalies);
    expect(report.evidenceRanges?.map(({ runId, anomalyId }) => ({ runId, anomalyId }))).toEqual([
      { runId: "candidate", anomalyId: "candidate:shared" },
      { runId: "baseline", anomalyId: "baseline:shared" },
    ]);
    expect(report.evidenceChain?.map(({ runId, anomalyId }) => ({ runId, anomalyId }))).toEqual([
      { runId: "candidate", anomalyId: "candidate:shared" },
      { runId: "baseline", anomalyId: "baseline:shared" },
    ]);
    expect(evidenceRanges.map(({ anomalyId }) => anomalyId)).toEqual(["shared", "shared"]);
    expect(evidenceChain.map(({ anomalyId }) => anomalyId)).toEqual(["shared", "shared"]);

    const json = JSON.parse(incidentReportToJson(report)) as typeof report;
    expect(json.anomalies).toEqual(report.anomalies);

    const markdown = incidentReportToMarkdown(report);
    expect(markdown).toContain("| Role | Run | Kind |");
    expect(markdown).toContain("Run: candidate · Chain entry: candidate\\-chain");
    expect(markdown).toContain("| Run | Range ID | Incident ID | Window |");
    expect(markdown).toContain("candidate\\-range");
    expect(markdown).toContain("| Time | Severity | Incident ID | Detector |");
    expect(markdown).toContain("| candidate:shared |");
    expect(markdown).toContain("| baseline:shared |");

    const html = incidentReportToHtml(report);
    expect(html).toContain("<th>Role</th><th>Run</th><th>Kind</th>");
    expect(html).toContain("<strong>Run:</strong> <code>candidate</code>");
    expect(html).toContain("<strong>Chain entry:</strong> <code>candidate-chain</code>");
    expect(html).toContain("<th>Run</th><th>Range ID</th><th>Incident ID</th>");
    expect(html).toContain("<code>candidate-range</code>");
    expect(html).toContain("<th>Incident ID</th>");
    expect(html).toContain("<code>candidate:shared</code>");
    expect(html).toContain("<code>baseline:shared</code>");
  });

  it("rejects duplicate anomaly source IDs within one run before references become ambiguous", () => {
    const duplicate: Anomaly = {
      id: "shared",
      type: "overcurrent",
      severity: "critical",
      timestamp: 1,
      sampleIndex: 1,
      title: "Duplicate",
      description: "Duplicate source identity",
      details: {},
    };

    expect(() =>
      createIncidentReport({
        run: run([sample(0, 0), sample(1, 1)], { id: "candidate" }),
        anomalies: [duplicate, { ...duplicate, timestamp: 1.1 }],
        generatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow(
      'Anomaly ID "shared" is duplicated within run "candidate"; evidence references would be ambiguous.',
    );
  });

  it("rejects ambiguous, dangling, or misattributed report graph references", () => {
    const shared: Anomaly = {
      id: "shared",
      type: "overcurrent",
      severity: "critical",
      timestamp: 1,
      sampleIndex: 1,
      title: "Load",
      description: "Load evidence",
      details: {},
    };
    const candidate = run([sample(0, 0), sample(1, 1)], { id: "candidate" });
    const baseline = run([sample(0, 0), sample(1, 1)], { id: "baseline" });
    const base = {
      run: candidate,
      anomalies: [shared],
      comparisonRun: baseline,
      comparisonAnomalies: [shared],
      generatedAt: "2026-08-11T00:00:00.000Z",
    };

    expect(() =>
      createIncidentReport({
        ...base,
        evidenceRanges: [
          {
            id: "range",
            label: "Ambiguous",
            startTimestamp: 1,
            endTimestamp: 1,
            anomalyId: "shared",
          },
        ],
      }),
    ).toThrow('Evidence reference "shared" is ambiguous across runs; provide runId.');

    expect(() =>
      createIncidentReport({
        ...base,
        evidenceChain: [
          {
            id: "chain",
            label: "Dangling",
            timestamp: 1,
            evidenceRangeIds: ["missing-range"],
          },
        ],
      }),
    ).toThrow('references unknown evidence range "missing-range"');

    expect(() =>
      createIncidentReport({
        ...base,
        evidenceRanges: [
          {
            id: "baseline-range",
            label: "Baseline evidence",
            startTimestamp: 1,
            endTimestamp: 1,
            runId: "baseline",
            anomalyId: "shared",
          },
        ],
        evidenceChain: [
          {
            id: "candidate-chain",
            label: "Candidate conclusion",
            timestamp: 1,
            runId: "candidate",
            anomalyId: "shared",
            evidenceRangeIds: ["baseline-range"],
          },
        ],
      }),
    ).toThrow(
      'references evidence range "baseline-range" from run "baseline", not chain run "candidate"',
    );

    expect(() =>
      createIncidentReport({
        run: candidate,
        anomalies: [shared, { ...shared, id: "other", title: "Other load" }],
        evidenceRanges: [
          {
            id: "other-range",
            label: "Other evidence",
            startTimestamp: 1,
            endTimestamp: 1,
            runId: "candidate",
            anomalyId: "other",
          },
        ],
        evidenceChain: [
          {
            id: "shared-chain",
            label: "Shared conclusion",
            timestamp: 1,
            runId: "candidate",
            anomalyId: "shared",
            evidenceRangeIds: ["other-range"],
          },
        ],
        generatedAt: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow(
      'references evidence range "other-range" for anomaly "other", not chain anomaly "shared"',
    );

    expect(() =>
      createIncidentReport({
        ...base,
        comparisonRun: { ...baseline, id: "candidate" },
      }),
    ).toThrow('Report inputs contain duplicate run ID "candidate".');
  });

  it("supports convenience and null comparison inputs plus report defaults", () => {
    const baseline = run([sample(0, 0)], {
      id: "baseline",
      name: "Baseline",
      kind: "normal",
    });
    const convenience = createIncidentReport({
      run: run([sample(0, 0)]),
      anomalies: [],
      comparisonRun: baseline,
      title: "   ",
      selectedTimestamp: Number.NaN,
      notes: "   ",
      generatedAt: "2026-08-11T00:00:00.000Z",
    });
    const nullComparison = createIncidentReport({
      run: run([sample(0, 0)]),
      anomalies: [],
      comparison: null,
      comparisonRun: null,
      selectedTimestamp: null,
    });

    expect(convenience.summary.runCount).toBe(2);
    expect(convenience.runs[1]?.id).toBe("baseline");
    expect(convenience.title).toBe("Report run incident report");
    expect(convenience.selectedTimestamp).toBeNull();
    expect(convenience).not.toHaveProperty("notes");
    expect(nullComparison.summary.runCount).toBe(1);
    expect(Number.isFinite(Date.parse(nullComparison.generatedAt))).toBe(true);
    expect(() =>
      createIncidentReport({
        run: baseline,
        anomalies: [],
        generatedAt: "not-a-date",
      }),
    ).toThrow("generatedAt must be a valid date or ISO timestamp");
  });

  it("filters non-finite summary values and finds the last valid battery", () => {
    const report = createIncidentReport({
      run: run([
        sample(2, 2, {
          speed: Number.NaN,
          battery: Number.NaN,
          current: Number.NaN,
        }),
        sample(0, 0, { speed: 1, battery: 75, current: -9 }),
        sample(Number.NaN, 1),
      ]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    expect(report.runs[0]).toMatchObject({
      sampleCount: 2,
      telemetry: {
        averageSpeed: 1,
        minimumBattery: 75,
        endingBattery: 75,
        peakCurrent: 9,
      },
    });
  });

  it("creates JSON and Markdown artifacts with normalized filenames", () => {
    const report = createIncidentReport({
      run: run([sample(0, 0)]),
      anomalies: [],
      title: "Café / Alarm!",
      generatedAt: "2026-08-11T00:00:00.000Z",
    });
    const json = createIncidentReportArtifact(report, "json");
    const markdown = createIncidentReportArtifact(report, "markdown", "handoff.markdown");
    const fallback = createIncidentReportArtifact({ ...report, title: "***" }, "json");

    expect(json).toMatchObject({
      filename: "cafe-alarm.json",
      mimeType: "application/json;charset=utf-8",
    });
    const exported = JSON.parse(json.content) as Record<string, unknown>;
    expect(markdown).toMatchObject({
      filename: "handoff.md",
      mimeType: "text/markdown;charset=utf-8",
    });
    expect(markdown.content).toContain("# Café / Alarm\\!");
    expect(fallback.filename).toBe("incident-report.json");
    expect(JSON.parse(incidentReportToJSON(report, -5))).toEqual(exported);
    expect(JSON.parse(incidentReportToJson(report, 99))).toEqual(exported);
  });

  it("rejects downloads outside a browser environment", () => {
    const report = createIncidentReport({
      run: run([sample(0, 0)]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });

    Reflect.deleteProperty(globalThis, "document");
    expect(() => downloadIncidentReport(report, "json")).toThrow(
      "Incident report downloads require a browser environment",
    );
  });

  it("downloads both artifacts and revokes their object URLs", () => {
    const report = createIncidentReport({
      run: run([sample(0, 0)]),
      anomalies: [],
      generatedAt: "2026-08-11T00:00:00.000Z",
    });
    const anchor = {
      href: "",
      download: "",
      hidden: false,
      click: vi.fn(),
      remove: vi.fn(),
    };
    const append = vi.fn();
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        createElement: vi.fn(() => anchor),
        body: { append },
      },
    });
    const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:test");
    const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    vi.useFakeTimers();

    expect(downloadIncidentReportJson(report, "analysis.json").filename).toBe("analysis.json");
    expect(downloadIncidentReportMarkdown(report, "analysis.md").filename).toBe("analysis.md");
    expect(downloadIncidentReportJSON(report, "alias.json").filename).toBe("alias.json");
    expect(createObjectURL).toHaveBeenCalledTimes(3);
    expect(append).toHaveBeenCalledTimes(3);
    expect(anchor.click).toHaveBeenCalledTimes(3);
    expect(anchor.remove).toHaveBeenCalledTimes(3);

    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledTimes(3);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
