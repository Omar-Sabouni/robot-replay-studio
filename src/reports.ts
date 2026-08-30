import type { Anomaly, TelemetryRun, TelemetrySample } from "./core/types";

export interface IncidentRunInput {
  run: TelemetryRun;
  anomalies: readonly Anomaly[];
}

export type IncidentReportFieldValue = string | number | boolean | null;
export type IncidentReportFields = Readonly<Record<string, IncidentReportFieldValue>>;

export interface IncidentReportProvenance {
  /** How the recording entered the workbench. */
  sourceType?: "synthetic" | "imported" | "live" | "derived" | string;
  sourceName?: string;
  sourceFormat?: string;
  sourceSchemaVersion?: string;
  /** Hex-encoded digest of the source before analysis. */
  sourceFingerprint?: string;
  fingerprintAlgorithm?: "SHA-256" | string;
  /** Root session identity retained when this report describes a derived branch. */
  parentSessionId?: string;
  /** Stable digest of the pristine session from which a derived branch originated. */
  rootSessionSha256?: string;
  acquiredAt?: string;
  originalSampleCount?: number;
  privacy?: "local-only" | "external" | string;
}

export interface IncidentDetectorRunAvailability {
  runId: string;
  available: boolean;
  /** Required when the detector could not run for this run. */
  reason?: string;
}

export interface IncidentDetectorConfiguration {
  id: string;
  label?: string;
  version?: string;
  enabled: boolean;
  thresholds?: IncidentReportFields;
  /** Run-specific channel and geometry availability for comparison reports. */
  availability?: readonly IncidentDetectorRunAvailability[];
  /** Legacy aggregate status retained for backwards-compatible integrations. */
  unavailableReason?: string;
}

export interface IncidentEvidenceRange {
  id: string;
  label: string;
  startTimestamp: number;
  endTimestamp: number;
  runId?: string;
  anomalyId?: string;
  startSampleIndex?: number;
  endSampleIndex?: number;
  supportingSampleCount?: number;
  observed?: IncidentReportFieldValue;
  threshold?: IncidentReportFieldValue;
  baseline?: IncidentReportFieldValue;
  unit?: string;
}

export type IncidentEvidenceRelationship =
  "temporal-correlation" | "detector-correlation" | "operator-confirmed";

export interface IncidentEvidenceChainEntry {
  id: string;
  label: string;
  timestamp: number;
  endTimestamp?: number;
  runId?: string;
  anomalyId?: string;
  kind?: "observation" | "condition" | "response" | "outcome";
  description?: string;
  relationship?: IncidentEvidenceRelationship;
  /** Normalized confidence in the range [0, 1], when a detector provides one. */
  confidence?: number;
  predecessorIds?: readonly string[];
  evidenceRangeIds?: readonly string[];
}

export interface IncidentDerivedMetric {
  id: string;
  label: string;
  value: number | null;
  unit?: string;
  runId?: string;
  baselineValue?: number | null;
  delta?: number | null;
  description?: string;
}

export interface IncidentAnnotation {
  id: string;
  timestamp: number;
  text: string;
  endTimestamp?: number;
  runId?: string;
  author?: string;
  createdAt?: string;
  tags?: readonly string[];
}

export interface IncidentFaultTransformation {
  id: string;
  type: "packet-dropout" | "pose-reset" | "motor-load" | string;
  startTimestamp: number;
  endTimestamp?: number;
  label?: string;
  parameters?: IncidentReportFields;
}

export interface IncidentReportInput {
  run: TelemetryRun;
  anomalies: readonly Anomaly[];
  /** Structured comparison input. */
  comparison?: IncidentRunInput | null;
  /** Convenience alternative to `comparison`. */
  comparisonRun?: TelemetryRun | null;
  comparisonAnomalies?: readonly Anomaly[];
  title?: string;
  selectedTimestamp?: number | null;
  generatedAt?: Date | string;
  notes?: string;
  provenance?: IncidentReportProvenance;
  detectorConfigurations?: readonly IncidentDetectorConfiguration[];
  /** Short alias accepted for integrations that already call these detector configs. */
  detectorConfigs?: readonly IncidentDetectorConfiguration[];
  evidenceRanges?: readonly IncidentEvidenceRange[];
  evidenceChain?: readonly IncidentEvidenceChainEntry[];
  derivedMetrics?: readonly IncidentDerivedMetric[];
  annotations?: readonly IncidentAnnotation[];
  faultTransformations?: readonly IncidentFaultTransformation[];
  /** Convenience alias; the report always emits `faultTransformations`. */
  transformations?: readonly IncidentFaultTransformation[];
}

export interface IncidentSeverityCounts {
  warning: number;
  critical: number;
}

export interface IncidentTelemetrySummary {
  averageSpeed: number | null;
  maximumSpeed: number | null;
  minimumBattery: number | null;
  endingBattery: number | null;
  peakCurrent: number | null;
  states: readonly string[];
  stateTransitions: number;
}

export interface IncidentRunSummary {
  id: string;
  name: string;
  /** The primary input is the candidate; the optional comparison is the baseline. */
  role: "candidate" | "baseline";
  kind: TelemetryRun["kind"];
  description?: string;
  sampleRateHz?: number;
  sampleCount: number;
  startTimestamp: number | null;
  endTimestamp: number | null;
  /** Null only when finite source timestamps span beyond JavaScript's numeric range. */
  durationSeconds: number | null;
  telemetry: IncidentTelemetrySummary;
  anomalies: IncidentSeverityCounts & { total: number };
}

export interface IncidentReportAnomaly {
  runId: string;
  id: string;
  /** Exact v2 detector identity; `type` remains only for v1 compatibility. */
  detectorId?: string;
  type: Anomaly["type"];
  severity: Anomaly["severity"];
  timestamp: number;
  endTimestamp?: number;
  sampleIndex: number;
  title: string;
  description: string;
  details: IncidentReportFields;
}

export interface IncidentReport {
  schemaVersion: "robot-replay-incident/2.0";
  title: string;
  generatedAt: string;
  selectedTimestamp: number | null;
  notes?: string;
  summary: IncidentSeverityCounts & {
    runCount: number;
    anomalyCount: number;
  };
  runs: readonly IncidentRunSummary[];
  anomalies: readonly IncidentReportAnomaly[];
  provenance?: IncidentReportProvenance;
  detectorConfigurations?: readonly IncidentDetectorConfiguration[];
  evidenceRanges?: readonly IncidentEvidenceRange[];
  evidenceChain?: readonly IncidentEvidenceChainEntry[];
  /** Included whenever an evidence chain is exported. */
  causalityNotice?: string;
  derivedMetrics?: readonly IncidentDerivedMetric[];
  annotations?: readonly IncidentAnnotation[];
  faultTransformations?: readonly IncidentFaultTransformation[];
}

export type IncidentReportFormat = "json" | "markdown" | "html";

export interface IncidentReportArtifact {
  filename: string;
  mimeType: string;
  content: string;
}

function orderedSamples(run: TelemetryRun): readonly TelemetrySample[] {
  return [...run.samples]
    .filter((sample) => Number.isFinite(sample.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function valuesFor(
  samples: readonly TelemetrySample[],
  selector: (sample: TelemetrySample) => number | null | undefined,
): readonly number[] {
  const values: number[] = [];
  for (const sample of samples) {
    const value = selector(sample);
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      values.push(value);
    }
  }
  return values;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  let scale = 0;
  for (const value of values) {
    scale = Math.max(scale, Math.abs(value));
  }
  if (scale === 0) {
    return 0;
  }
  let normalizedTotal = 0;
  for (const value of values) {
    normalizedTotal += value / scale;
  }
  const result = (normalizedTotal / values.length) * scale;
  return Number.isFinite(result) ? result : null;
}

function extremum(values: readonly number[], mode: "min" | "max"): number | null {
  if (values.length === 0) {
    return null;
  }
  let result = mode === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const value of values) {
    result = mode === "min" ? Math.min(result, value) : Math.max(result, value);
  }
  return result;
}

function rounded(value: number | null, precision = 3): number | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  const multiplier = 10 ** precision;
  if (!Number.isFinite(multiplier) || Math.abs(value) > Number.MAX_VALUE / multiplier) {
    return value;
  }
  const result = Math.round(value * multiplier) / multiplier;
  return Number.isFinite(result) ? result : null;
}

function severityCounts(anomalies: readonly Anomaly[]): IncidentSeverityCounts & { total: number } {
  const counts = { warning: 0, critical: 0, total: anomalies.length };
  for (const anomaly of anomalies) {
    counts[anomaly.severity] += 1;
  }
  return counts;
}

function stateSummary(samples: readonly TelemetrySample[]): {
  states: readonly string[];
  stateTransitions: number;
} {
  const states: string[] = [];
  const seenStates = new Set<string>();
  let previous: string | null = null;
  let stateTransitions = 0;

  for (const sample of samples) {
    const state = typeof sample.state === "string" ? sample.state.trim() : "";
    if (state.length === 0) {
      continue;
    }
    if (!seenStates.has(state)) {
      seenStates.add(state);
      states.push(state);
    }
    if (previous !== null && previous !== state) {
      stateTransitions += 1;
    }
    previous = state;
  }
  return { states, stateTransitions };
}

function summarizeRun(
  run: TelemetryRun,
  anomalies: readonly Anomaly[],
  role: IncidentRunSummary["role"],
): IncidentRunSummary {
  const samples = orderedSamples(run);
  const first = samples[0];
  const last = samples[samples.length - 1];
  const speeds = valuesFor(samples, (sample) => sample.speed);
  const batteries = valuesFor(samples, (sample) => sample.battery);
  const currents = valuesFor(samples, (sample) =>
    sample.current === null || sample.current === undefined ? null : Math.abs(sample.current),
  );
  let lastBattery: number | null = null;
  for (let index = samples.length - 1; index >= 0; index -= 1) {
    const battery = samples[index]?.battery;
    if (typeof battery === "number" && Number.isFinite(battery)) {
      lastBattery = battery;
      break;
    }
  }

  const summary: IncidentRunSummary = {
    id: run.id,
    name: run.name,
    role,
    kind: run.kind,
    sampleCount: samples.length,
    startTimestamp: first?.timestamp ?? null,
    endTimestamp: last?.timestamp ?? null,
    durationSeconds:
      first === undefined || last === undefined
        ? 0
        : rounded(Math.max(0, last.timestamp - first.timestamp)),
    telemetry: {
      averageSpeed: rounded(mean(speeds)),
      maximumSpeed: rounded(extremum(speeds, "max")),
      minimumBattery: rounded(extremum(batteries, "min")),
      endingBattery: rounded(lastBattery),
      peakCurrent: rounded(extremum(currents, "max")),
      ...stateSummary(samples),
    },
    anomalies: severityCounts(anomalies),
  };

  if (run.description !== undefined) {
    summary.description = run.description;
  }
  if (run.sampleRateHz !== undefined) {
    summary.sampleRateHz = run.sampleRateHz;
  }
  return summary;
}

function reportAnomaly(
  runId: string,
  anomaly: Anomaly,
  reportId = anomaly.id,
): IncidentReportAnomaly {
  const detectorId = anomaly.details?.detectorId;
  const result: IncidentReportAnomaly = {
    runId,
    id: reportId,
    type: anomaly.type,
    severity: anomaly.severity,
    timestamp: anomaly.timestamp,
    sampleIndex: anomaly.sampleIndex,
    title: anomaly.title,
    description: anomaly.description,
    details: { ...anomaly.details },
    ...(typeof detectorId === "string" && detectorId.trim().length > 0 ? { detectorId } : {}),
  };
  if (anomaly.endTimestamp !== undefined) {
    result.endTimestamp = anomaly.endTimestamp;
  }
  return result;
}

type IncidentAnomalyIdLookup = ReadonlyMap<string, ReadonlyMap<string, string>>;

interface ResolvedReportAnomalies {
  anomalies: readonly IncidentReportAnomaly[];
  idsByRunAndSource: IncidentAnomalyIdLookup;
}

interface PendingReportAnomaly {
  runId: string;
  anomaly: Anomaly;
}

function availableScopedAnomalyId(runId: string, sourceId: string, usedIds: Set<string>): string {
  const base = `${runId}:${sourceId}`;
  let candidate = base;
  let occurrence = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}#${occurrence}`;
    occurrence += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

function rememberAnomalyId(
  lookup: Map<string, Map<string, string>>,
  runId: string,
  sourceId: string,
  reportId: string,
): void {
  let idsBySource = lookup.get(runId);
  if (idsBySource === undefined) {
    idsBySource = new Map<string, string>();
    lookup.set(runId, idsBySource);
  }
  idsBySource.set(sourceId, reportId);
}

function assertUniqueAnomalySourceIds(pending: readonly PendingReportAnomaly[]): void {
  const sourceIdsByRun = new Map<string, Set<string>>();
  for (const { runId, anomaly } of pending) {
    let sourceIds = sourceIdsByRun.get(runId);
    if (sourceIds === undefined) {
      sourceIds = new Set<string>();
      sourceIdsByRun.set(runId, sourceIds);
    }
    if (sourceIds.has(anomaly.id)) {
      throw new Error(
        `Anomaly ID ${JSON.stringify(anomaly.id)} is duplicated within run ${JSON.stringify(runId)}; evidence references would be ambiguous.`,
      );
    }
    sourceIds.add(anomaly.id);
  }
}

function resolveReportAnomalies(inputs: readonly IncidentRunInput[]): ResolvedReportAnomalies {
  const pending: PendingReportAnomaly[] = inputs.flatMap(({ run, anomalies }) =>
    anomalies.map((anomaly) => ({ runId: run.id, anomaly })),
  );
  assertUniqueAnomalySourceIds(pending);
  const sourceIdCounts = new Map<string, number>();
  for (const { anomaly } of pending) {
    sourceIdCounts.set(anomaly.id, (sourceIdCounts.get(anomaly.id) ?? 0) + 1);
  }

  // Reserve every globally unique source ID before allocating scoped collision IDs.
  // This keeps legacy IDs stable without allowing a generated ID to shadow one of them.
  const usedIds = new Set(
    pending
      .filter(({ anomaly }) => sourceIdCounts.get(anomaly.id) === 1)
      .map(({ anomaly }) => anomaly.id),
  );
  const idsByRunAndSource = new Map<string, Map<string, string>>();
  const anomalies = pending.map(({ runId, anomaly }) => {
    const reportId =
      sourceIdCounts.get(anomaly.id) === 1
        ? anomaly.id
        : availableScopedAnomalyId(runId, anomaly.id, usedIds);
    rememberAnomalyId(idsByRunAndSource, runId, anomaly.id, reportId);
    return reportAnomaly(runId, anomaly, reportId);
  });

  anomalies.sort(
    (left, right) => left.timestamp - right.timestamp || left.id.localeCompare(right.id),
  );
  return { anomalies, idsByRunAndSource };
}

function resolvedAnomalyReference(
  runId: string | undefined,
  sourceId: string | undefined,
  idsByRunAndSource: IncidentAnomalyIdLookup,
): string | undefined {
  if (sourceId === undefined) {
    return undefined;
  }
  if (runId !== undefined) {
    const resolved = idsByRunAndSource.get(runId)?.get(sourceId);
    if (resolved === undefined) {
      throw new Error(
        `Evidence references anomaly ${JSON.stringify(sourceId)} outside run ${JSON.stringify(runId)}.`,
      );
    }
    return resolved;
  }
  const matches = [...idsByRunAndSource.values()]
    .map((idsBySource) => idsBySource.get(sourceId))
    .filter((value): value is string => value !== undefined);
  if (matches.length === 0) {
    throw new Error(`Evidence references unknown anomaly ID ${JSON.stringify(sourceId)}.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Evidence reference ${JSON.stringify(sourceId)} is ambiguous across runs; provide runId.`,
    );
  }
  return matches[0];
}

function isoTimestamp(value: Date | string | undefined): string {
  const date = value === undefined ? new Date() : value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error("generatedAt must be a valid date or ISO timestamp");
  }
  return date.toISOString();
}

function resolvedInputs(input: IncidentReportInput): readonly IncidentRunInput[] {
  if (
    input.comparison !== undefined &&
    input.comparison !== null &&
    input.comparisonRun !== undefined &&
    input.comparisonRun !== null
  ) {
    throw new Error("Provide comparison or comparisonRun, not both.");
  }
  if (
    input.comparisonAnomalies !== undefined &&
    (input.comparisonRun === undefined || input.comparisonRun === null)
  ) {
    throw new Error("comparisonAnomalies requires comparisonRun.");
  }
  const primary: IncidentRunInput = { run: input.run, anomalies: input.anomalies };
  if (input.comparison !== undefined && input.comparison !== null) {
    return [primary, input.comparison];
  }
  if (input.comparisonRun !== undefined && input.comparisonRun !== null) {
    return [primary, { run: input.comparisonRun, anomalies: input.comparisonAnomalies ?? [] }];
  }
  return [primary];
}

function assertIdentifier(value: string, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string.`);
  }
}

function assertUniqueIds(
  label: string,
  values: readonly { id: string }[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const [index, value] of (values ?? []).entries()) {
    assertIdentifier(value.id, `${label}[${index}].id`);
    if (ids.has(value.id)) {
      throw new Error(`${label} contains duplicate ID ${JSON.stringify(value.id)}.`);
    }
    ids.add(value.id);
  }
  return ids;
}

function assertFiniteTimestamp(value: number, path: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${path} must be finite.`);
  }
}

function assertFiniteFields(fields: IncidentReportFields | undefined, path: string): void {
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new RangeError(`${path}.${key} must be finite.`);
    }
  }
}

function assertFiniteNullable(value: number | null | undefined, path: string): void {
  if (value !== undefined && value !== null && !Number.isFinite(value)) {
    throw new RangeError(`${path} must be finite or null.`);
  }
}

function assertTimestampRange(start: number, end: number | undefined, path: string): void {
  assertFiniteTimestamp(start, `${path}.startTimestamp`);
  if (end !== undefined) {
    assertFiniteTimestamp(end, `${path}.endTimestamp`);
    if (end < start) {
      throw new RangeError(`${path}.endTimestamp must not precede startTimestamp.`);
    }
  }
}

function assertOptionalRunId(
  runId: string | undefined,
  runIds: ReadonlySet<string>,
  path: string,
): void {
  if (runId !== undefined && !runIds.has(runId)) {
    throw new Error(`${path} references unknown run ID ${JSON.stringify(runId)}.`);
  }
}

function assertAcyclicEvidenceChain(entries: readonly IncidentEvidenceChainEntry[]): void {
  const predecessors = new Map(
    entries.map((entry) => [entry.id, [...(entry.predecessorIds ?? [])]] as const),
  );
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      throw new Error(`evidenceChain contains a predecessor cycle at ${JSON.stringify(id)}.`);
    }
    visiting.add(id);
    for (const predecessor of predecessors.get(id) ?? []) {
      visit(predecessor);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of predecessors.keys()) {
    visit(id);
  }
}

/** Reject ambiguous or dangling evidence before it can become a credible-looking export. */
function validateReportInputGraph(
  input: IncidentReportInput,
  inputs: readonly IncidentRunInput[],
): void {
  if (input.detectorConfigurations !== undefined && input.detectorConfigs !== undefined) {
    throw new Error("Provide detectorConfigurations or detectorConfigs, not both.");
  }
  if (input.faultTransformations !== undefined && input.transformations !== undefined) {
    throw new Error("Provide faultTransformations or transformations, not both.");
  }

  const runIds = new Set<string>();
  for (const [runIndex, { run, anomalies }] of inputs.entries()) {
    assertIdentifier(run.id, `runs[${runIndex}].id`);
    if (runIds.has(run.id)) {
      throw new Error(`Report inputs contain duplicate run ID ${JSON.stringify(run.id)}.`);
    }
    runIds.add(run.id);
    if (
      run.sampleRateHz !== undefined &&
      (!Number.isFinite(run.sampleRateHz) || run.sampleRateHz <= 0)
    ) {
      throw new RangeError(`runs[${runIndex}].sampleRateHz must be positive and finite.`);
    }
    for (const [anomalyIndex, anomaly] of anomalies.entries()) {
      const path = `runs[${runIndex}].anomalies[${anomalyIndex}]`;
      assertIdentifier(anomaly.id, `${path}.id`);
      assertFiniteTimestamp(anomaly.timestamp, `${path}.timestamp`);
      if (anomaly.endTimestamp !== undefined) {
        assertFiniteTimestamp(anomaly.endTimestamp, `${path}.endTimestamp`);
        if (anomaly.endTimestamp < anomaly.timestamp) {
          throw new RangeError(`${path}.endTimestamp must not precede timestamp.`);
        }
      }
      if (!Number.isSafeInteger(anomaly.sampleIndex) || anomaly.sampleIndex < 0) {
        throw new RangeError(`${path}.sampleIndex must be a non-negative safe integer.`);
      }
      assertFiniteFields(anomaly.details, `${path}.details`);
    }
  }

  const ranges = input.evidenceRanges ?? [];
  const rangeIds = assertUniqueIds("evidenceRanges", ranges);
  const rangesById = new Map(ranges.map((range) => [range.id, range] as const));
  for (const [index, range] of ranges.entries()) {
    const path = `evidenceRanges[${index}]`;
    assertTimestampRange(range.startTimestamp, range.endTimestamp, path);
    assertOptionalRunId(range.runId, runIds, path);
    if (range.anomalyId !== undefined) {
      assertIdentifier(range.anomalyId, `${path}.anomalyId`);
    }
    for (const [field, value] of [
      ["observed", range.observed],
      ["threshold", range.threshold],
      ["baseline", range.baseline],
    ] as const) {
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new RangeError(`${path}.${field} must be finite.`);
      }
    }
    if (
      range.startSampleIndex !== undefined &&
      (!Number.isSafeInteger(range.startSampleIndex) || range.startSampleIndex < 0)
    ) {
      throw new RangeError(`${path}.startSampleIndex must be a non-negative safe integer.`);
    }
    if (
      range.endSampleIndex !== undefined &&
      (!Number.isSafeInteger(range.endSampleIndex) || range.endSampleIndex < 0)
    ) {
      throw new RangeError(`${path}.endSampleIndex must be a non-negative safe integer.`);
    }
    if (
      range.startSampleIndex !== undefined &&
      range.endSampleIndex !== undefined &&
      range.endSampleIndex < range.startSampleIndex
    ) {
      throw new RangeError(`${path}.endSampleIndex must not precede startSampleIndex.`);
    }
  }

  const chain = input.evidenceChain ?? [];
  const chainIds = assertUniqueIds("evidenceChain", chain);
  for (const [index, entry] of chain.entries()) {
    const path = `evidenceChain[${index}]`;
    assertFiniteTimestamp(entry.timestamp, `${path}.timestamp`);
    if (entry.endTimestamp !== undefined) {
      assertFiniteTimestamp(entry.endTimestamp, `${path}.endTimestamp`);
      if (entry.endTimestamp < entry.timestamp) {
        throw new RangeError(`${path}.endTimestamp must not precede timestamp.`);
      }
    }
    assertOptionalRunId(entry.runId, runIds, path);
    if (entry.anomalyId !== undefined) {
      assertIdentifier(entry.anomalyId, `${path}.anomalyId`);
    }
    if (
      entry.confidence !== undefined &&
      (!Number.isFinite(entry.confidence) || entry.confidence < 0 || entry.confidence > 1)
    ) {
      throw new RangeError(`${path}.confidence must be between 0 and 1.`);
    }
    const predecessorIds = entry.predecessorIds ?? [];
    if (new Set(predecessorIds).size !== predecessorIds.length) {
      throw new Error(`${path}.predecessorIds contains a duplicate reference.`);
    }
    for (const predecessorId of predecessorIds) {
      if (!chainIds.has(predecessorId)) {
        throw new Error(
          `${path}.predecessorIds references unknown chain entry ${JSON.stringify(predecessorId)}.`,
        );
      }
    }
    const evidenceRangeIds = entry.evidenceRangeIds ?? [];
    if (new Set(evidenceRangeIds).size !== evidenceRangeIds.length) {
      throw new Error(`${path}.evidenceRangeIds contains a duplicate reference.`);
    }
    for (const evidenceRangeId of evidenceRangeIds) {
      if (!rangeIds.has(evidenceRangeId)) {
        throw new Error(
          `${path}.evidenceRangeIds references unknown evidence range ${JSON.stringify(evidenceRangeId)}.`,
        );
      }
      const referencedRange = rangesById.get(evidenceRangeId);
      if (
        entry.runId !== undefined &&
        referencedRange?.runId !== undefined &&
        entry.runId !== referencedRange.runId
      ) {
        throw new Error(
          `${path}.evidenceRangeIds references evidence range ${JSON.stringify(evidenceRangeId)} from run ${JSON.stringify(referencedRange.runId)}, not chain run ${JSON.stringify(entry.runId)}.`,
        );
      }
      if (
        entry.anomalyId !== undefined &&
        referencedRange?.anomalyId !== undefined &&
        entry.anomalyId !== referencedRange.anomalyId
      ) {
        throw new Error(
          `${path}.evidenceRangeIds references evidence range ${JSON.stringify(evidenceRangeId)} for anomaly ${JSON.stringify(referencedRange.anomalyId)}, not chain anomaly ${JSON.stringify(entry.anomalyId)}.`,
        );
      }
    }
  }
  assertAcyclicEvidenceChain(chain);

  for (const [label, values] of [
    ["detectorConfigurations", input.detectorConfigurations ?? input.detectorConfigs],
    ["derivedMetrics", input.derivedMetrics],
    ["annotations", input.annotations],
    ["faultTransformations", input.faultTransformations ?? input.transformations],
  ] as const) {
    assertUniqueIds(label, values);
  }
  for (const [index, metric] of (input.derivedMetrics ?? []).entries()) {
    assertOptionalRunId(metric.runId, runIds, `derivedMetrics[${index}]`);
    assertFiniteNullable(metric.value, `derivedMetrics[${index}].value`);
    assertFiniteNullable(metric.baselineValue, `derivedMetrics[${index}].baselineValue`);
    assertFiniteNullable(metric.delta, `derivedMetrics[${index}].delta`);
  }
  for (const [index, annotation] of (input.annotations ?? []).entries()) {
    assertOptionalRunId(annotation.runId, runIds, `annotations[${index}]`);
    const path = `annotations[${index}]`;
    assertFiniteTimestamp(annotation.timestamp, `${path}.timestamp`);
    if (annotation.endTimestamp !== undefined) {
      assertFiniteTimestamp(annotation.endTimestamp, `${path}.endTimestamp`);
      if (annotation.endTimestamp < annotation.timestamp) {
        throw new RangeError(`${path}.endTimestamp must not precede timestamp.`);
      }
    }
  }
  for (const [index, transformation] of (
    input.faultTransformations ??
    input.transformations ??
    []
  ).entries()) {
    assertTimestampRange(
      transformation.startTimestamp,
      transformation.endTimestamp,
      `faultTransformations[${index}]`,
    );
    assertFiniteFields(transformation.parameters, `faultTransformations[${index}].parameters`);
  }
  for (const [index, detector] of (
    input.detectorConfigurations ??
    input.detectorConfigs ??
    []
  ).entries()) {
    const path = `detectorConfigurations[${index}]`;
    assertFiniteFields(detector.thresholds, `${path}.thresholds`);
    const availabilityRunIds = new Set<string>();
    for (const [availabilityIndex, availability] of (detector.availability ?? []).entries()) {
      const availabilityPath = `${path}.availability[${availabilityIndex}]`;
      assertIdentifier(availability.runId, `${availabilityPath}.runId`);
      if (!runIds.has(availability.runId)) {
        throw new Error(
          `${availabilityPath} references unknown run ID ${JSON.stringify(availability.runId)}.`,
        );
      }
      if (availabilityRunIds.has(availability.runId)) {
        throw new Error(
          `${path}.availability contains duplicate run ID ${JSON.stringify(availability.runId)}.`,
        );
      }
      availabilityRunIds.add(availability.runId);
      if (typeof availability.available !== "boolean") {
        throw new TypeError(`${availabilityPath}.available must be a boolean.`);
      }
      if (availability.reason !== undefined && availability.reason.trim().length === 0) {
        throw new Error(`${availabilityPath}.reason must be a non-empty string when provided.`);
      }
      if (!availability.available && availability.reason === undefined) {
        throw new Error(`${availabilityPath}.reason is required when the detector is unavailable.`);
      }
    }
  }
  if (input.provenance?.parentSessionId !== undefined) {
    assertIdentifier(input.provenance.parentSessionId, "provenance.parentSessionId");
  }
  if (
    input.provenance?.rootSessionSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(input.provenance.rootSessionSha256)
  ) {
    throw new Error("provenance.rootSessionSha256 must be 64 lowercase hexadecimal digits.");
  }
  if (
    input.provenance?.originalSampleCount !== undefined &&
    (!Number.isSafeInteger(input.provenance.originalSampleCount) ||
      input.provenance.originalSampleCount < 0)
  ) {
    throw new RangeError("provenance.originalSampleCount must be a non-negative safe integer.");
  }
}

const EVIDENCE_CAUSALITY_NOTICE =
  "Evidence-chain links show temporal or detector correlation. They do not establish causal proof.";

function copyFields(fields: IncidentReportFields | undefined): IncidentReportFields | undefined {
  return fields === undefined ? undefined : { ...fields };
}

function copyProvenance(provenance: IncidentReportProvenance): IncidentReportProvenance {
  return { ...provenance };
}

function copyDetector(detector: IncidentDetectorConfiguration): IncidentDetectorConfiguration {
  const result: IncidentDetectorConfiguration = { ...detector };
  const thresholds = copyFields(detector.thresholds);
  if (thresholds !== undefined) {
    result.thresholds = thresholds;
  }
  if (detector.availability !== undefined) {
    result.availability = detector.availability.map((availability) => ({ ...availability }));
  }
  return result;
}

function copyEvidenceRange(
  range: IncidentEvidenceRange,
  idsByRunAndSource: IncidentAnomalyIdLookup,
): IncidentEvidenceRange {
  if (
    range.supportingSampleCount !== undefined &&
    (!Number.isSafeInteger(range.supportingSampleCount) || range.supportingSampleCount < 0)
  ) {
    throw new RangeError(
      `Evidence range ${JSON.stringify(range.id)} supportingSampleCount must be a non-negative safe integer.`,
    );
  }
  const result: IncidentEvidenceRange = { ...range };
  if (range.anomalyId !== undefined) {
    result.anomalyId = resolvedAnomalyReference(range.runId, range.anomalyId, idsByRunAndSource);
  }
  return result;
}

function copyEvidenceChainEntry(
  entry: IncidentEvidenceChainEntry,
  idsByRunAndSource: IncidentAnomalyIdLookup,
): IncidentEvidenceChainEntry {
  const result: IncidentEvidenceChainEntry = { ...entry };
  if (entry.anomalyId !== undefined) {
    result.anomalyId = resolvedAnomalyReference(entry.runId, entry.anomalyId, idsByRunAndSource);
  }
  if (entry.predecessorIds !== undefined) {
    result.predecessorIds = [...entry.predecessorIds];
  }
  if (entry.evidenceRangeIds !== undefined) {
    result.evidenceRangeIds = [...entry.evidenceRangeIds];
  }
  return result;
}

function copyAnnotation(annotation: IncidentAnnotation): IncidentAnnotation {
  const result: IncidentAnnotation = { ...annotation };
  if (annotation.tags !== undefined) {
    result.tags = [...annotation.tags];
  }
  return result;
}

function copyTransformation(
  transformation: IncidentFaultTransformation,
): IncidentFaultTransformation {
  const result: IncidentFaultTransformation = { ...transformation };
  const parameters = copyFields(transformation.parameters);
  if (parameters !== undefined) {
    result.parameters = parameters;
  }
  return result;
}

function addOptionalReportSections(
  report: IncidentReport,
  input: IncidentReportInput,
  idsByRunAndSource: IncidentAnomalyIdLookup,
): void {
  if (input.provenance !== undefined) {
    report.provenance = copyProvenance(input.provenance);
  }

  const detectors = input.detectorConfigurations ?? input.detectorConfigs;
  if (detectors !== undefined && detectors.length > 0) {
    report.detectorConfigurations = detectors.map(copyDetector);
  }
  if (input.evidenceRanges !== undefined && input.evidenceRanges.length > 0) {
    report.evidenceRanges = input.evidenceRanges.map((range) =>
      copyEvidenceRange(range, idsByRunAndSource),
    );
  }
  if (input.evidenceChain !== undefined && input.evidenceChain.length > 0) {
    report.evidenceChain = input.evidenceChain.map((entry) =>
      copyEvidenceChainEntry(entry, idsByRunAndSource),
    );
    report.causalityNotice = EVIDENCE_CAUSALITY_NOTICE;
  }
  if (input.derivedMetrics !== undefined && input.derivedMetrics.length > 0) {
    report.derivedMetrics = input.derivedMetrics.map((metric) => ({ ...metric }));
  }
  if (input.annotations !== undefined && input.annotations.length > 0) {
    report.annotations = input.annotations.map(copyAnnotation);
  }

  const transformations = input.faultTransformations ?? input.transformations;
  if (transformations !== undefined && transformations.length > 0) {
    report.faultTransformations = transformations.map(copyTransformation);
  }
}

/** Builds a serializable, deterministic report when `generatedAt` is provided. */
export function createIncidentReport(input: IncidentReportInput): IncidentReport {
  const inputs = resolvedInputs(input);
  validateReportInputGraph(input, inputs);
  const { anomalies, idsByRunAndSource } = resolveReportAnomalies(inputs);
  const warning = anomalies.filter((anomaly) => anomaly.severity === "warning").length;
  const critical = anomalies.filter((anomaly) => anomaly.severity === "critical").length;
  const report: IncidentReport = {
    schemaVersion: "robot-replay-incident/2.0",
    title: input.title?.trim() || `${input.run.name} incident report`,
    generatedAt: isoTimestamp(input.generatedAt),
    selectedTimestamp:
      input.selectedTimestamp !== undefined &&
      input.selectedTimestamp !== null &&
      Number.isFinite(input.selectedTimestamp)
        ? input.selectedTimestamp
        : null,
    summary: {
      runCount: inputs.length,
      anomalyCount: anomalies.length,
      warning,
      critical,
    },
    runs: inputs.map(({ run, anomalies: detected }, index) =>
      summarizeRun(run, detected, index === 0 ? "candidate" : "baseline"),
    ),
    anomalies,
  };
  if (input.notes !== undefined && input.notes.trim().length > 0) {
    report.notes = input.notes.trim();
  }
  addOptionalReportSections(report, input, idsByRunAndSource);
  return report;
}

export function incidentReportToJson(report: IncidentReport, indent = 2): string {
  const safeIndent = Math.max(0, Math.min(10, Math.trunc(indent)));
  const publicReport: Partial<IncidentReport> = { ...report };
  delete publicReport.schemaVersion;
  delete publicReport.generatedAt;
  delete publicReport.provenance;
  delete publicReport.causalityNotice;
  if (report.detectorConfigurations !== undefined) {
    publicReport.detectorConfigurations = report.detectorConfigurations.map((detector) => {
      const publicDetector = { ...detector };
      delete publicDetector.version;
      return publicDetector;
    });
  }
  if (report.annotations !== undefined) {
    publicReport.annotations = report.annotations.map((annotation) => {
      const publicAnnotation = { ...annotation };
      delete publicAnnotation.createdAt;
      return publicAnnotation;
    });
  }
  return JSON.stringify(publicReport, null, safeIndent);
}

/** Alias retaining the all-caps spelling commonly used in UI actions. */
export const incidentReportToJSON = incidentReportToJson;

function escapeMarkdown(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replace(/([*_[\]{}()#+.!~-])/g, "\\$1")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("`", "&#96;")
    .replace(/\r\n?|\n/g, " ");
}

function markdownValue(value: number | null, unit = ""): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }
  return `${value.toLocaleString("en-US", { maximumFractionDigits: 3 })}${unit}`;
}

function formattedSupportingSampleCount(value: number | undefined): string {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value.toLocaleString("en-US")
    : "—";
}

function formatReplayTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) {
    return "—";
  }
  const sign = timestamp < 0 ? "−" : "";
  const absolute = Math.abs(timestamp);
  const totalMilliseconds = Math.round(absolute * 1_000);
  if (!Number.isSafeInteger(totalMilliseconds)) {
    return "—";
  }
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const millisecondsWithinMinute = totalMilliseconds % 60_000;
  const seconds = Math.floor(millisecondsWithinMinute / 1_000);
  const milliseconds = millisecondsWithinMinute % 1_000;
  return `${sign}${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}.${milliseconds.toString().padStart(3, "0")}`;
}

function anomalyDetails(details: IncidentReportFields): string {
  const entries = Object.entries(details);
  if (entries.length === 0) {
    return "—";
  }
  return entries
    .map(([key, value]) => `${escapeMarkdown(key)}: ${escapeMarkdown(String(value))}`)
    .join("; ");
}

function anomalyDetectorLabel(anomaly: IncidentReportAnomaly): string {
  return anomaly.detectorId ?? anomaly.type;
}

function fieldValue(value: IncidentReportFieldValue | undefined): string {
  if (value === undefined || value === null) {
    return "—";
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
      ? value.toLocaleString("en-US", { maximumFractionDigits: 6 })
      : "—";
  }
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return value;
}

function markdownFields(fields: IncidentReportFields | undefined): string {
  if (fields === undefined || Object.keys(fields).length === 0) {
    return "—";
  }
  return Object.entries(fields)
    .map(([key, value]) => `${escapeMarkdown(key)}: ${escapeMarkdown(fieldValue(value))}`)
    .join("; ");
}

function detectorAvailabilityLabels(
  availability: readonly IncidentDetectorRunAvailability[] | undefined,
): readonly string[] {
  return (availability ?? []).map((entry) =>
    entry.available
      ? `${entry.runId}: available`
      : `${entry.runId}: unavailable — ${entry.reason ?? "reason not provided"}`,
  );
}

function formatTimeRange(startTimestamp: number, endTimestamp?: number): string {
  const start = formatReplayTime(startTimestamp);
  if (endTimestamp === undefined || endTimestamp === startTimestamp) {
    return start;
  }
  const end = formatReplayTime(endTimestamp);
  const collapsedFiniteRange = start !== "—" && start === end;
  return `${start}–${end}${collapsedFiniteRange ? " (sub-millisecond source span)" : ""}`;
}

function anomaliesForRun(report: IncidentReport, runId: string): readonly IncidentReportAnomaly[] {
  return report.anomalies.filter((anomaly) => anomaly.runId === runId);
}

export function incidentReportToMarkdown(report: IncidentReport): string {
  const lines: string[] = [
    `# ${escapeMarkdown(report.title)}`,
    "",
    `Selected replay time: ${report.selectedTimestamp === null ? "not selected" : formatReplayTime(report.selectedTimestamp)}`,
    "",
    "## Summary",
    "",
    `- Runs compared: ${report.summary.runCount}`,
    `- Detected incidents: ${report.summary.anomalyCount}`,
    `- Critical: ${report.summary.critical}`,
    `- Warnings: ${report.summary.warning}`,
  ];

  if (report.notes !== undefined) {
    lines.push("", "### Analyst notes", "", escapeMarkdown(report.notes));
  }

  lines.push(
    "",
    "## Run comparison",
    "",
    "| Role | Run | Kind | Samples | Duration | Avg speed | Min battery | Peak current | Warnings | Critical |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  );
  for (const run of report.runs) {
    lines.push(
      `| ${escapeMarkdown(run.role)} | ${escapeMarkdown(run.name)} | ${escapeMarkdown(String(run.kind))} | ${run.sampleCount} | ${markdownValue(run.durationSeconds, " s")} | ${markdownValue(run.telemetry.averageSpeed, " m/s")} | ${markdownValue(run.telemetry.minimumBattery, "%")} | ${markdownValue(run.telemetry.peakCurrent, " A")} | ${run.anomalies.warning} | ${run.anomalies.critical} |`,
    );
  }

  for (const run of report.runs) {
    lines.push(
      "",
      `## ${escapeMarkdown(run.name)}`,
      "",
      `Role: ${escapeMarkdown(run.role)}  `,
      `Run ID: ${escapeMarkdown(run.id)}  `,
      `Window: ${run.startTimestamp === null || run.endTimestamp === null ? "—" : formatTimeRange(run.startTimestamp, run.endTimestamp)}  `,
      `States: ${run.telemetry.states.length === 0 ? "—" : run.telemetry.states.map(escapeMarkdown).join(" → ")}  `,
      `State transitions: ${run.telemetry.stateTransitions}`,
    );

    if (run.description !== undefined) {
      lines.push("", escapeMarkdown(run.description));
    }

    const anomalies = anomaliesForRun(report, run.id);
    lines.push("", "### Detected incidents", "");
    if (anomalies.length === 0) {
      lines.push("No incidents detected.");
      continue;
    }

    lines.push(
      "| Time | Severity | Incident ID | Detector | Finding | Details |",
      "| ---: | --- | --- | --- | --- | --- |",
    );
    for (const anomaly of anomalies) {
      const time = formatTimeRange(anomaly.timestamp, anomaly.endTimestamp);
      const finding = `${escapeMarkdown(anomaly.title)} — ${escapeMarkdown(anomaly.description)}`;
      lines.push(
        `| ${time} | ${escapeMarkdown(anomaly.severity.toUpperCase())} | ${escapeMarkdown(anomaly.id)} | ${escapeMarkdown(anomalyDetectorLabel(anomaly))} | ${finding} | ${anomalyDetails(anomaly.details)} |`,
      );
    }
  }

  if (report.evidenceChain !== undefined) {
    lines.push("", "## Evidence chain", "");
    report.evidenceChain.forEach((entry, index) => {
      const qualifiers: string[] = [];
      if (entry.kind !== undefined) {
        qualifiers.push(escapeMarkdown(entry.kind));
      }
      if (entry.relationship !== undefined) {
        qualifiers.push(escapeMarkdown(entry.relationship));
      }
      if (entry.confidence !== undefined && Number.isFinite(entry.confidence)) {
        qualifiers.push(`${Math.round(entry.confidence * 100)}% confidence`);
      }
      const qualifier = qualifiers.length === 0 ? "" : ` (${qualifiers.join(", ")})`;
      lines.push(
        `${index + 1}. **${formatTimeRange(entry.timestamp, entry.endTimestamp)} — ${escapeMarkdown(entry.label)}**${qualifier}`,
      );
      lines.push(
        `   Run: ${escapeMarkdown(entry.runId ?? "—")} · Chain entry: ${escapeMarkdown(entry.id)} · Incident: ${escapeMarkdown(entry.anomalyId ?? "—")}`,
      );
      if (entry.description !== undefined) {
        lines.push(`   ${escapeMarkdown(entry.description)}`);
      }
      if (entry.predecessorIds !== undefined && entry.predecessorIds.length > 0) {
        lines.push(`   Preceded by: ${entry.predecessorIds.map(escapeMarkdown).join(", ")}`);
      }
      if (entry.evidenceRangeIds !== undefined && entry.evidenceRangeIds.length > 0) {
        lines.push(`   Evidence: ${entry.evidenceRangeIds.map(escapeMarkdown).join(", ")}`);
      }
    });
  }

  if (report.evidenceRanges !== undefined) {
    lines.push(
      "",
      "## Evidence ranges",
      "",
      "| Run | Range ID | Incident ID | Window | Evidence | Observed | Threshold | Baseline delta | Samples |",
      "| --- | --- | --- | ---: | --- | ---: | ---: | ---: | ---: |",
    );
    for (const range of report.evidenceRanges) {
      const suffix = range.unit === undefined ? "" : ` ${range.unit}`;
      lines.push(
        `| ${escapeMarkdown(range.runId ?? "—")} | ${escapeMarkdown(range.id)} | ${escapeMarkdown(range.anomalyId ?? "—")} | ${formatTimeRange(range.startTimestamp, range.endTimestamp)} | ${escapeMarkdown(range.label)} | ${escapeMarkdown(fieldValue(range.observed))}${escapeMarkdown(suffix)} | ${escapeMarkdown(fieldValue(range.threshold))}${escapeMarkdown(suffix)} | ${escapeMarkdown(fieldValue(range.baseline))}${escapeMarkdown(suffix)} | ${formattedSupportingSampleCount(range.supportingSampleCount)} |`,
      );
    }
  }

  if (report.derivedMetrics !== undefined) {
    lines.push(
      "",
      "## Derived metrics",
      "",
      "| Metric | Value | Baseline | Delta |",
      "| --- | ---: | ---: | ---: |",
    );
    for (const metric of report.derivedMetrics) {
      const unit = metric.unit === undefined ? "" : ` ${metric.unit}`;
      lines.push(
        `| ${escapeMarkdown(metric.label)} | ${escapeMarkdown(fieldValue(metric.value))}${escapeMarkdown(unit)} | ${escapeMarkdown(fieldValue(metric.baselineValue))}${escapeMarkdown(unit)} | ${escapeMarkdown(fieldValue(metric.delta))}${escapeMarkdown(unit)} |`,
      );
    }
  }

  if (report.detectorConfigurations !== undefined) {
    lines.push(
      "",
      "## Detector configuration",
      "",
      "| Detector | Status | Run availability | Thresholds |",
      "| --- | --- | --- | --- |",
    );
    for (const detector of report.detectorConfigurations) {
      const status =
        detector.unavailableReason !== undefined
          ? `unavailable — ${detector.unavailableReason}`
          : detector.enabled
            ? "enabled"
            : "disabled";
      const availability = detectorAvailabilityLabels(detector.availability);
      lines.push(
        `| ${escapeMarkdown(detector.label ?? detector.id)} | ${escapeMarkdown(status)} | ${availability.length === 0 ? "—" : availability.map(escapeMarkdown).join("; ")} | ${markdownFields(detector.thresholds)} |`,
      );
    }
  }

  if (report.annotations !== undefined) {
    lines.push("", "## Analyst annotations", "");
    for (const annotation of report.annotations) {
      const author =
        annotation.author === undefined ? "" : ` — ${escapeMarkdown(annotation.author)}`;
      const tags =
        annotation.tags === undefined || annotation.tags.length === 0
          ? ""
          : ` [${annotation.tags.map(escapeMarkdown).join(", ")}]`;
      lines.push(
        `- **${formatTimeRange(annotation.timestamp, annotation.endTimestamp)}${author}:** ${escapeMarkdown(annotation.text)}${tags}`,
      );
    }
  }

  if (report.faultTransformations !== undefined) {
    lines.push(
      "",
      "## Fault transformations",
      "",
      "These changes apply only to this branch.",
      "",
      "| Window | Transformation | Parameters |",
      "| ---: | --- | --- |",
    );
    for (const transformation of report.faultTransformations) {
      lines.push(
        `| ${formatTimeRange(transformation.startTimestamp, transformation.endTimestamp)} | ${escapeMarkdown(transformation.label ?? transformation.type)} | ${markdownFields(transformation.parameters)} |`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function htmlFieldValue(value: IncidentReportFieldValue | undefined): string {
  return escapeHtml(fieldValue(value));
}

function htmlFields(fields: IncidentReportFields | undefined): string {
  if (fields === undefined || Object.keys(fields).length === 0) {
    return '<span class="empty">—</span>';
  }
  return Object.entries(fields)
    .map(
      ([key, value]) =>
        `<span class="field"><strong>${escapeHtml(key)}:</strong> ${htmlFieldValue(value)}</span>`,
    )
    .join(" ");
}

function incidentRowsToHtml(anomalies: readonly IncidentReportAnomaly[]): string {
  if (anomalies.length === 0) {
    return '<p class="empty-state">No incidents detected.</p>';
  }
  const rows = anomalies
    .map((anomaly) => {
      const severityClass =
        anomaly.severity === "critical"
          ? "critical"
          : anomaly.severity === "warning"
            ? "warning"
            : "info";
      const details = Object.entries(anomaly.details)
        .map(
          ([key, value]) =>
            `<span class="field"><strong>${escapeHtml(key)}:</strong> ${escapeHtml(String(value))}</span>`,
        )
        .join(" ");
      return `<tr>
        <td class="numeric">${formatTimeRange(anomaly.timestamp, anomaly.endTimestamp)}</td>
        <td><span class="severity severity-${severityClass}">${escapeHtml(anomaly.severity)}</span></td>
        <td><code>${escapeHtml(anomaly.id)}</code></td>
        <td><code>${escapeHtml(anomalyDetectorLabel(anomaly))}</code></td>
        <td><strong>${escapeHtml(anomaly.title)}</strong><br><span class="muted">${escapeHtml(anomaly.description)}</span></td>
        <td>${details || '<span class="empty">—</span>'}</td>
      </tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table>
    <caption>Detected incidents</caption>
    <thead><tr><th>Time</th><th>Severity</th><th>Incident ID</th><th>Detector</th><th>Finding</th><th>Details</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function optionalReportSectionsToHtml(report: IncidentReport): string {
  const sections: string[] = [];

  if (report.evidenceChain !== undefined) {
    const entries = report.evidenceChain
      .map((entry) => {
        const qualifiers: string[] = [];
        if (entry.kind !== undefined) {
          qualifiers.push(`<span class="pill">${escapeHtml(entry.kind)}</span>`);
        }
        if (entry.relationship !== undefined) {
          qualifiers.push(`<span class="pill">${escapeHtml(entry.relationship)}</span>`);
        }
        if (entry.confidence !== undefined && Number.isFinite(entry.confidence)) {
          qualifiers.push(
            `<span class="pill">${Math.round(entry.confidence * 100)}% confidence</span>`,
          );
        }
        const links: string[] = [];
        if (entry.predecessorIds !== undefined && entry.predecessorIds.length > 0) {
          links.push(`Preceded by ${entry.predecessorIds.map(escapeHtml).join(", ")}`);
        }
        if (entry.evidenceRangeIds !== undefined && entry.evidenceRangeIds.length > 0) {
          links.push(`Evidence ${entry.evidenceRangeIds.map(escapeHtml).join(", ")}`);
        }
        return `<li>
          <div class="chain-time">${formatTimeRange(entry.timestamp, entry.endTimestamp)}</div>
          <div><h3>${escapeHtml(entry.label)}</h3><div class="pills">${qualifiers.join("")}</div>
          <p class="muted"><strong>Run:</strong> <code>${escapeHtml(entry.runId ?? "—")}</code> · <strong>Chain entry:</strong> <code>${escapeHtml(entry.id)}</code> · <strong>Incident:</strong> <code>${escapeHtml(entry.anomalyId ?? "—")}</code></p>
          ${entry.description === undefined ? "" : `<p>${escapeHtml(entry.description)}</p>`}
          ${links.length === 0 ? "" : `<p class="muted">${links.join(" · ")}</p>`}</div>
        </li>`;
      })
      .join("");
    sections.push(`<section aria-labelledby="evidence-chain-heading">
      <h2 id="evidence-chain-heading">Evidence chain</h2>
      <ol class="evidence-chain">${entries}</ol>
    </section>`);
  }

  if (report.evidenceRanges !== undefined) {
    const rows = report.evidenceRanges
      .map((range) => {
        const suffix = range.unit === undefined ? "" : ` ${escapeHtml(range.unit)}`;
        return `<tr>
          <td><code>${escapeHtml(range.runId ?? "—")}</code></td>
          <td><code>${escapeHtml(range.id)}</code></td>
          <td><code>${escapeHtml(range.anomalyId ?? "—")}</code></td>
          <td class="numeric">${formatTimeRange(range.startTimestamp, range.endTimestamp)}</td>
          <td>${escapeHtml(range.label)}</td>
          <td class="numeric">${htmlFieldValue(range.observed)}${suffix}</td>
          <td class="numeric">${htmlFieldValue(range.threshold)}${suffix}</td>
          <td class="numeric">${htmlFieldValue(range.baseline)}${suffix}</td>
          <td class="numeric">${formattedSupportingSampleCount(range.supportingSampleCount)}</td>
        </tr>`;
      })
      .join("");
    sections.push(`<section aria-labelledby="evidence-ranges-heading">
      <h2 id="evidence-ranges-heading">Evidence ranges</h2>
      <div class="table-wrap"><table><caption>Observed evidence windows and detector boundaries</caption>
      <thead><tr><th>Run</th><th>Range ID</th><th>Incident ID</th><th>Window</th><th>Evidence</th><th>Observed</th><th>Threshold</th><th>Baseline delta</th><th>Samples</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    </section>`);
  }

  if (report.derivedMetrics !== undefined) {
    const rows = report.derivedMetrics
      .map((metric) => {
        const unit = metric.unit === undefined ? "" : ` ${escapeHtml(metric.unit)}`;
        return `<tr><td><strong>${escapeHtml(metric.label)}</strong>${metric.description === undefined ? "" : `<br><span class="muted">${escapeHtml(metric.description)}</span>`}</td>
          <td class="numeric">${htmlFieldValue(metric.value)}${unit}</td>
          <td class="numeric">${htmlFieldValue(metric.baselineValue)}${unit}</td>
          <td class="numeric">${htmlFieldValue(metric.delta)}${unit}</td></tr>`;
      })
      .join("");
    sections.push(`<section aria-labelledby="metrics-heading"><h2 id="metrics-heading">Derived metrics</h2>
      <div class="table-wrap"><table><caption>Metrics derived during this analysis</caption>
      <thead><tr><th>Metric</th><th>Value</th><th>Baseline</th><th>Delta</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`);
  }

  if (report.detectorConfigurations !== undefined) {
    const rows = report.detectorConfigurations
      .map((detector) => {
        const status =
          detector.unavailableReason !== undefined
            ? `<span class="status disabled">Unavailable</span><br><span class="muted">${escapeHtml(detector.unavailableReason)}</span>`
            : detector.enabled
              ? '<span class="status enabled">Enabled</span>'
              : '<span class="status disabled">Disabled</span>';
        const availability = detectorAvailabilityLabels(detector.availability);
        const availabilityHtml =
          availability.length === 0
            ? '<span class="empty">—</span>'
            : availability.map((entry) => escapeHtml(entry)).join("<br>");
        return `<tr><td><strong>${escapeHtml(detector.label ?? detector.id)}</strong><br><code>${escapeHtml(detector.id)}</code></td>
          <td>${status}</td><td>${availabilityHtml}</td><td>${htmlFields(detector.thresholds)}</td></tr>`;
      })
      .join("");
    sections.push(`<section aria-labelledby="detectors-heading"><h2 id="detectors-heading">Detector configuration</h2>
      <div class="table-wrap"><table><caption>Rules and thresholds used for this report</caption>
      <thead><tr><th>Detector</th><th>Status</th><th>Run availability</th><th>Thresholds</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`);
  }

  if (report.annotations !== undefined) {
    const items = report.annotations
      .map((annotation) => {
        const tags =
          annotation.tags === undefined
            ? ""
            : annotation.tags.map((tag) => `<span class="pill">${escapeHtml(tag)}</span>`).join("");
        return `<li><div class="chain-time">${formatTimeRange(annotation.timestamp, annotation.endTimestamp)}</div>
          <div><p>${escapeHtml(annotation.text)}</p>
          ${annotation.author === undefined ? "" : `<p class="muted">${escapeHtml(annotation.author)}</p>`}
          <div class="pills">${tags}</div></div></li>`;
      })
      .join("");
    sections.push(`<section aria-labelledby="annotations-heading"><h2 id="annotations-heading">Analyst annotations</h2>
      <ul class="annotations">${items}</ul></section>`);
  }

  if (report.faultTransformations !== undefined) {
    const rows = report.faultTransformations
      .map(
        (transformation) => `<tr>
          <td class="numeric">${formatTimeRange(transformation.startTimestamp, transformation.endTimestamp)}</td>
          <td><strong>${escapeHtml(transformation.label ?? transformation.type)}</strong><br><code>${escapeHtml(transformation.type)}</code></td>
          <td>${htmlFields(transformation.parameters)}</td></tr>`,
      )
      .join("");
    sections.push(`<section aria-labelledby="transformations-heading"><h2 id="transformations-heading">Fault transformations</h2>
      <aside class="notice">These changes apply only to this branch.</aside>
      <div class="table-wrap"><table><caption>Transformations applied to the analysis branch</caption>
      <thead><tr><th>Window</th><th>Transformation</th><th>Parameters</th></tr></thead><tbody>${rows}</tbody></table></div>
    </section>`);
  }

  return sections.join("\n");
}

/** Produces a standalone, script-free HTML report suitable for printing to PDF. */
export function incidentReportToHtml(report: IncidentReport): string {
  const runRows = report.runs
    .map(
      (
        run,
      ) => `<tr><td><span class="pill">${escapeHtml(run.role)}</span></td><td><strong>${escapeHtml(run.name)}</strong><br><code>${escapeHtml(run.id)}</code></td>
        <td>${escapeHtml(String(run.kind))}</td><td class="numeric">${run.sampleCount.toLocaleString("en-US")}</td>
        <td class="numeric">${markdownValue(run.durationSeconds, " s")}</td>
        <td class="numeric">${markdownValue(run.telemetry.averageSpeed, " m/s")}</td>
        <td class="numeric">${markdownValue(run.telemetry.minimumBattery, "%")}</td>
        <td class="numeric">${markdownValue(run.telemetry.peakCurrent, " A")}</td>
        <td class="numeric">${run.anomalies.warning}</td><td class="numeric">${run.anomalies.critical}</td></tr>`,
    )
    .join("");

  const runSections = report.runs
    .map((run, index) => {
      const states =
        run.telemetry.states.length === 0 ? "—" : run.telemetry.states.map(escapeHtml).join(" → ");
      const headingId = `run-${slug(run.id)}-${index}`;
      return `<article class="run" aria-labelledby="${headingId}">
        <h2 id="${headingId}">${escapeHtml(run.name)}</h2>
        ${run.description === undefined ? "" : `<p>${escapeHtml(run.description)}</p>`}
        <dl class="metadata">
          <div><dt>Role</dt><dd>${escapeHtml(run.role)}</dd></div>
          <div><dt>Run ID</dt><dd><code>${escapeHtml(run.id)}</code></dd></div>
          <div><dt>Window</dt><dd>${run.startTimestamp === null || run.endTimestamp === null ? "—" : formatTimeRange(run.startTimestamp, run.endTimestamp)}</dd></div>
          <div><dt>States</dt><dd>${states}</dd></div>
          <div><dt>State transitions</dt><dd>${run.telemetry.stateTransitions}</dd></div>
        </dl>
        ${incidentRowsToHtml(anomaliesForRun(report, run.id))}
      </article>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex,nofollow">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>${escapeHtml(report.title)} — Robot Replay Studio</title>
  <style>
    :root { color-scheme: light; font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #11171b; background: #232b32; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    main { width: min(1120px, calc(100% - 32px)); margin: 24px auto; background: #f4f7f8; border: 2px solid; border-color: #c9d0d5; }
    header, section, article.run, footer { padding: 22px 28px; }
    header { color: #ffffff; background: #232b32; border-bottom: 4px solid #34414c; }
    header p { color: #c8dbe4; }
    section, article.run { border-bottom: 1px solid #829099; }
    h1, h2, h3, p { margin-top: 0; }
    h1, h2, h3 { font-family: system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
    h1 { max-width: 780px; margin-bottom: 8px; font-size: clamp(24px, 3vw, 32px); line-height: 1.12; }
    h2 { margin-bottom: 14px; color: #2a353e; font-size: 19px; }
    h3 { margin: 0 0 4px; color: #2a353e; font-size: 15px; }
    .eyebrow { margin-bottom: 8px; color: #f05a1a; font: 700 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); margin: 18px 0 0; padding: 0; color: #11171b; border-block: 1px solid #829099; background: #eef1f3; list-style: none; }
    .summary li { padding: 10px; color: #11171b; border-right: 1px solid #829099; }
    .summary li:last-child { border-right: 0; }
    .summary strong { display: block; color: #2a353e; font: 600 20px/1.1 system-ui, sans-serif; }
    .summary span { color: #35434b; font-size: 12px; }
    .metadata { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 24px; margin: 0; }
    .metadata div { min-width: 0; }
    dt { color: #52636c; font-size: 12px; font-weight: 700; }
    dd { margin: 3px 0 0; overflow-wrap: anywhere; }
    .table-wrap { width: 100%; overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 12px; }
    caption { padding: 0 0 8px; color: #52636c; text-align: left; }
    th, td { padding: 9px 8px; border: 1px solid #829099; text-align: left; vertical-align: top; }
    th { color: #ffffff; background: #34414c; font-size: 12px; }
    tbody tr:nth-child(even) { background: #e7edf0; }
    .numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
    code { font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; overflow-wrap: anywhere; }
    .muted, .empty, .empty-state { color: #52636c; }
    .field { display: inline-block; margin: 0 8px 3px 0; }
    .severity, .status, .pill { display: inline-block; padding: 2px 6px; border: 1px solid currentColor; font: 600 12px system-ui, sans-serif; }
    .severity-warning { color: #6b4700; background: #f5ecd9; }
    .severity-critical, .disabled { color: #651713; background: #ecd8d7; }
    .enabled { color: #365500; background: #dce8c8; }
    .pill { margin: 0 5px 5px 0; color: #2a353e; background: #eaeff2; }
    .notice { margin: 0 0 18px; padding: 10px 12px; color: #11171b; background: #eaeff2; border-left: 4px solid #34414c; }
    .evidence-chain, .annotations { margin: 0; padding: 0; list-style: none; }
    .evidence-chain li, .annotations li { display: grid; grid-template-columns: 128px 1fr; gap: 18px; padding: 12px 0; border-bottom: 1px solid #829099; }
    .chain-time { color: #2a353e; font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
    footer { color: #52636c; font-size: 12px; }
    @media (max-width: 700px) { main { width: 100%; margin: 0; border-inline: 0; } header, section, article.run, footer { padding: 20px 16px; } .summary { grid-template-columns: repeat(2, 1fr); } .summary li:nth-child(2) { border-right: 0; } .summary li:nth-child(-n + 2) { border-bottom: 1px solid #829099; } .metadata { grid-template-columns: 1fr; } .evidence-chain li, .annotations li { grid-template-columns: 1fr; gap: 4px; } }
    @page { size: A4 landscape; margin: 12mm; }
    @media print { :root { font-size: 10pt; background: #fff; } main { width: 100%; margin: 0; border: 0; } header { color: #11171b; background: #fff; border: 2px solid #11171b; } header p, .eyebrow { color: #35434b; } section, article.run, footer { padding: 18px 0; } section, article.run { break-inside: avoid; } th { color: #11171b; background: #fff; } table { font-size: 9pt; } thead { display: table-header-group; } tr { break-inside: avoid; } .table-wrap { overflow: visible; } }
  </style>
</head>
<body>
<main>
  <header>
    <h1>${escapeHtml(report.title)}</h1>
    <p>Selected replay time: ${report.selectedTimestamp === null ? "not selected" : formatReplayTime(report.selectedTimestamp)}</p>
    <ul class="summary">
      <li><strong>${report.summary.runCount}</strong><span>Runs compared</span></li>
      <li><strong>${report.summary.anomalyCount}</strong><span>Detected incidents</span></li>
      <li><strong>${report.summary.critical}</strong><span>Critical</span></li>
      <li><strong>${report.summary.warning}</strong><span>Warnings</span></li>
    </ul>
  </header>
  ${report.notes === undefined ? "" : `<section aria-labelledby="notes-heading"><h2 id="notes-heading">Analyst notes</h2><p>${escapeHtml(report.notes)}</p></section>`}
  <section aria-labelledby="comparison-heading"><h2 id="comparison-heading">Run comparison</h2>
    <div class="table-wrap"><table><caption>Telemetry and incident summary by run</caption>
      <thead><tr><th>Role</th><th>Run</th><th>Kind</th><th>Samples</th><th>Duration</th><th>Avg speed</th><th>Min battery</th><th>Peak current</th><th>Warnings</th><th>Critical</th></tr></thead>
      <tbody>${runRows}</tbody>
    </table></div>
  </section>
  ${runSections}
  ${optionalReportSectionsToHtml(report)}
</main>
</body>
</html>`;
}

/** Alias retaining the all-caps spelling commonly used in UI actions. */
export const incidentReportToHTML = incidentReportToHtml;

function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return normalized || "incident-report";
}

const WINDOWS_RESERVED_FILENAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Converts both user-supplied names and report titles into a traversal-safe,
 * cross-platform download filename.
 */
export function sanitizeIncidentReportFilename(
  filename: string | undefined,
  reportTitle: string,
  format: IncidentReportFormat,
): string {
  const extension = format === "json" ? "json" : format === "markdown" ? "md" : "html";
  const suppliedLeaf = filename
    ?.trim()
    .replaceAll("\\", "/")
    .split("/")
    .at(-1)
    ?.replace(/\.(?:json|md|markdown|html?|xhtml)$/i, "");
  let base = slug(
    suppliedLeaf === undefined || suppliedLeaf.length === 0 ? reportTitle : suppliedLeaf,
  );
  if (WINDOWS_RESERVED_FILENAME.test(base)) {
    base = `report-${base}`;
  }
  return `${base}.${extension}`;
}

export function createIncidentReportArtifact(
  report: IncidentReport,
  format: IncidentReportFormat,
  filename?: string,
): IncidentReportArtifact {
  const safeFilename = sanitizeIncidentReportFilename(filename, report.title, format);
  if (format === "json") {
    return {
      filename: safeFilename,
      mimeType: "application/json;charset=utf-8",
      content: incidentReportToJson(report),
    };
  }
  if (format === "markdown") {
    return {
      filename: safeFilename,
      mimeType: "text/markdown;charset=utf-8",
      content: incidentReportToMarkdown(report),
    };
  }
  return {
    filename: safeFilename,
    mimeType: "text/html;charset=utf-8",
    content: incidentReportToHtml(report),
  };
}

function triggerDownload(artifact: IncidentReportArtifact): void {
  if (typeof document === "undefined" || typeof URL === "undefined") {
    throw new Error("Incident report downloads require a browser environment");
  }
  const url = URL.createObjectURL(new Blob([artifact.content], { type: artifact.mimeType }));
  let anchor: HTMLAnchorElement | null = null;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = artifact.filename;
    anchor.hidden = true;
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

export function downloadIncidentReport(
  report: IncidentReport,
  format: IncidentReportFormat,
  filename?: string,
): IncidentReportArtifact {
  const artifact = createIncidentReportArtifact(report, format, filename);
  triggerDownload(artifact);
  return artifact;
}

export function downloadIncidentReportJson(
  report: IncidentReport,
  filename?: string,
): IncidentReportArtifact {
  return downloadIncidentReport(report, "json", filename);
}

/** Alias retaining the all-caps spelling commonly used in UI actions. */
export const downloadIncidentReportJSON = downloadIncidentReportJson;

export function downloadIncidentReportMarkdown(
  report: IncidentReport,
  filename?: string,
): IncidentReportArtifact {
  return downloadIncidentReport(report, "markdown", filename);
}

export function downloadIncidentReportHtml(
  report: IncidentReport,
  filename?: string,
): IncidentReportArtifact {
  return downloadIncidentReport(report, "html", filename);
}

/** Alias retaining the all-caps spelling commonly used in UI actions. */
export const downloadIncidentReportHTML = downloadIncidentReportHtml;
