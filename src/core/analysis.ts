import { cloneDetectorConfiguration, detectorRuleConfigurationIssues } from "./session";
import type {
  AnalysisSummary,
  DerivedSampleMetrics,
  DetectorConfiguration,
  DetectorId,
  DetectorRuleConfig,
  EvidenceChain,
  EvidenceChainClassification,
  IncidentEvidence,
  PlannedRoute,
  ReplaySessionRun,
  ReplaySessionV2,
  SessionAnalysis,
  SessionIncident,
  SessionTelemetrySample,
} from "./types";

interface RouteProjection {
  distance: number;
  headingError: number;
  segmentIndex: number;
  progress: number;
}

interface RouteProjectionHint {
  preferredSegmentIndex: number;
  authoritative: boolean;
}

interface Episode {
  startIndex: number;
  endIndex: number;
  peakIndex: number;
  observed: number;
}

interface BaselineLookup {
  samples: readonly SessionTelemetrySample[];
  maximumInterpolationInterval: number;
}

export interface AnalyzeSessionOptions {
  detectorOverrides?: Partial<Record<DetectorId, Partial<DetectorRuleConfig>>>;
}

/** Fail-closed bound for detector output retained in one analysis result. */
export const MAX_ANALYSIS_INCIDENTS = 25_000;

function requireFiniteDerived(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} could not be represented as a finite number`);
  }
  return value;
}

function finiteOrNull(value: number): number | null {
  return Number.isFinite(value) ? value : null;
}

function normalizeYaw(yaw: number): number {
  const twoPi = Math.PI * 2;
  return ((((yaw + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

/** Normalize controller state spelling without accepting substring matches. */
export function normalizeControllerStateToken(state: string | null): string | null {
  const trimmed = state?.trim();
  if (trimmed === undefined || trimmed === "") {
    return null;
  }
  const token = trimmed
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .replace(/([a-z\d])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return token === "" ? null : token;
}

function medianOfSortedPrefix(values: readonly number[], length: number): number {
  if (length <= 0) {
    return 0;
  }
  const middle = Math.floor(length / 2);
  if (length % 2 === 1) {
    return values[middle] ?? 0;
  }
  return ((values[middle - 1] ?? 0) + (values[middle] ?? 0)) / 2;
}

function percentile(values: readonly number[], proportion: number): number | null {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) {
    return null;
  }
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * proportion) - 1)] ?? null;
}

function maximum(values: readonly number[]): number | null {
  let result = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value)) {
      result = Math.max(result, value);
    }
  }
  return result === Number.NEGATIVE_INFINITY ? null : result;
}

function minimum(values: readonly number[]): number | null {
  let result = Number.POSITIVE_INFINITY;
  for (const value of values) {
    if (Number.isFinite(value)) {
      result = Math.min(result, value);
    }
  }
  return result === Number.POSITIVE_INFINITY ? null : result;
}

const TIMESTAMP_GAP_CADENCE_MULTIPLIER = 3;

function gapResistantObservedInterval(samples: readonly SessionTelemetrySample[]): number {
  const intervals: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (current !== undefined && previous !== undefined) {
      const interval = current.timestamp - previous.timestamp;
      requireFiniteDerived(interval, "observed sample interval");
      if (interval > 0) {
        intervals.push(interval);
      }
    }
  }
  if (intervals.length < 2) {
    return intervals[0] ?? 0;
  }
  intervals.sort((left, right) => left - right);
  // A clear separation denotes a lower cadence cluster plus missing-time
  // intervals. Without a clear split, a lower quartile is deliberately more
  // conservative than the all-interval median for sparse recordings.
  let clusterEnd = intervals.length;
  for (let index = 1; index < intervals.length; index += 1) {
    const lower = intervals[index - 1];
    const upper = intervals[index];
    if (lower === undefined || upper === undefined || lower <= 0) {
      continue;
    }
    const separation = upper / lower;
    if (separation > TIMESTAMP_GAP_CADENCE_MULTIPLIER) {
      clusterEnd = index;
      break;
    }
  }
  if (clusterEnd < intervals.length) {
    return medianOfSortedPrefix(intervals, clusterEnd);
  }
  return intervals[Math.floor((intervals.length - 1) * 0.25)] ?? 0;
}

function nominalSampleInterval(
  samples: readonly SessionTelemetrySample[],
  declaredSampleRateHz?: number,
): number {
  if (
    declaredSampleRateHz !== undefined &&
    Number.isFinite(declaredSampleRateHz) &&
    declaredSampleRateHz > 0
  ) {
    return requireFiniteDerived(1 / declaredSampleRateHz, "nominal sample interval");
  }
  return gapResistantObservedInterval(samples);
}

function runNominalInterval(run: ReplaySessionRun): number {
  return nominalSampleInterval(run.samples, run.sampleRateHz);
}

function effectiveTimestampGapThreshold(nominalInterval: number, configuredFloor: number): number {
  return requireFiniteDerived(
    Math.max(configuredFloor, nominalInterval * TIMESTAMP_GAP_CADENCE_MULTIPLIER),
    "effective timestamp-gap threshold",
  );
}

/**
 * Resolve the timestamp-gap rule as a configured floor plus a cadence-aware
 * guard. The guard prevents every sample in a valid low-rate recording from
 * being misclassified as a dropout.
 */
export function resolveEffectiveTimestampGapThreshold(
  samples: readonly SessionTelemetrySample[],
  configuredFloor: number,
  declaredSampleRateHz?: number,
): number {
  if (!Number.isFinite(configuredFloor) || configuredFloor < 0) {
    throw new RangeError("timestamp-gap threshold must be non-negative and finite");
  }
  return effectiveTimestampGapThreshold(
    nominalSampleInterval(samples, declaredSampleRateHz),
    configuredFloor,
  );
}

function routeProjection(
  x: number,
  y: number,
  yaw: number,
  route: PlannedRoute,
  hint?: RouteProjectionHint,
): RouteProjection {
  const candidates: RouteProjection[] = [];
  const finalSegmentIndex = route.closed ? route.waypoints.length : route.waypoints.length - 1;
  let cumulativeDistance = 0;
  for (let index = 1; index <= finalSegmentIndex; index += 1) {
    const from = route.waypoints[index - 1];
    const to = route.waypoints[index] ?? route.waypoints[0];
    if (from === undefined || to === undefined) {
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = requireFiniteDerived(Math.hypot(dx, dy), "route segment length");
    if (length === 0) {
      continue;
    }
    const unitX = dx / length;
    const unitY = dy / length;
    const relativeX = requireFiniteDerived(x - from.x, "route-relative x coordinate");
    const relativeY = requireFiniteDerived(y - from.y, "route-relative y coordinate");
    const along = requireFiniteDerived(
      relativeX * unitX + relativeY * unitY,
      "route projection distance",
    );
    const projectedDistance = Math.max(0, Math.min(length, along));
    const projectedX = requireFiniteDerived(
      from.x + unitX * projectedDistance,
      "projected route x coordinate",
    );
    const projectedY = requireFiniteDerived(
      from.y + unitY * projectedDistance,
      "projected route y coordinate",
    );
    const distance = requireFiniteDerived(
      Math.hypot(x - projectedX, y - projectedY),
      "cross-track error",
    );
    const headingError = Math.abs(normalizeYaw(yaw - Math.atan2(dy, dx)));
    candidates.push({
      distance,
      headingError,
      segmentIndex: index - 1,
      progress: cumulativeDistance + projectedDistance,
    });
    cumulativeDistance += length;
  }
  if (candidates.length === 0) {
    if (route.source === "inferred-observation") {
      return { distance: 0, headingError: 0, segmentIndex: 0, progress: 0 };
    }
    throw new RangeError("planned route must contain at least one non-zero-length segment");
  }
  const nearestDistance =
    minimum(candidates.map(({ distance }) => distance)) ?? Number.POSITIVE_INFINITY;
  const cornerTolerance = Math.max(0.05, route.corridorWidth * 0.1);
  const plausibleHeadings = candidates
    .filter(({ distance }) => distance <= nearestDistance + cornerTolerance)
    .sort(
      (left, right) =>
        left.headingError - right.headingError ||
        left.distance - right.distance ||
        left.segmentIndex - right.segmentIndex,
    );
  const natural = plausibleHeadings[0] ?? candidates[0];
  if (natural === undefined) {
    throw new RangeError("planned route projection did not produce a segment");
  }
  const hinted =
    hint === undefined
      ? undefined
      : candidates.find(({ segmentIndex }) => segmentIndex === hint.preferredSegmentIndex);
  const hintDistanceTolerance = Math.max(
    cornerTolerance,
    route.corridorWidth + Math.max(cornerTolerance, 0.25),
  );
  const hintHeadingTolerance = Math.PI / 4;
  const useHint =
    hinted !== undefined &&
    hinted.distance <= nearestDistance + hintDistanceTolerance &&
    (hint?.authoritative === true ||
      hinted.headingError <= natural.headingError + hintHeadingTolerance);
  const selected = useHint ? hinted : natural;
  return {
    distance: requireFiniteDerived(
      useHint ? selected.distance : nearestDistance,
      "selected route distance",
    ),
    headingError: Math.min(Math.PI, selected.headingError),
    segmentIndex: selected.segmentIndex,
    progress: selected.progress,
  };
}

function sampleAt(
  samples: readonly SessionTelemetrySample[],
  timestamp: number,
  maximumInterpolationInterval = Number.POSITIVE_INFINITY,
): SessionTelemetrySample | null {
  const first = samples[0];
  const last = samples.at(-1);
  if (first === undefined || last === undefined) {
    return null;
  }
  if (timestamp < first.timestamp || timestamp > last.timestamp) {
    return null;
  }
  if (timestamp === first.timestamp) {
    return first;
  }
  if (timestamp === last.timestamp) {
    return last;
  }
  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if ((samples[middle]?.timestamp ?? Number.POSITIVE_INFINITY) <= timestamp) {
      low = middle;
    } else {
      high = middle;
    }
  }
  const from = samples[low];
  const to = samples[high];
  if (from === undefined || to === undefined) {
    return null;
  }
  if (timestamp === from.timestamp) {
    return from;
  }
  if (timestamp === to.timestamp) {
    return to;
  }
  const amount = (timestamp - from.timestamp) / (to.timestamp - from.timestamp);
  if (!Number.isFinite(amount)) {
    return null;
  }
  if (amount > 0 && amount < 1 && to.timestamp - from.timestamp > maximumInterpolationInterval) {
    return null;
  }
  const interpolateNullable = (left: number | null, right: number | null): number | null =>
    left === null || right === null ? null : finiteOrNull(left + (right - left) * amount);
  const x = from.pose.x + (to.pose.x - from.pose.x) * amount;
  const y = from.pose.y + (to.pose.y - from.pose.y) * amount;
  const yaw = normalizeYaw(from.pose.yaw + normalizeYaw(to.pose.yaw - from.pose.yaw) * amount);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(yaw)) {
    return null;
  }
  return {
    timestamp,
    pose: { x, y, yaw },
    sequence: amount >= 1 ? to.sequence : from.sequence,
    speed: interpolateNullable(from.speed, to.speed),
    battery: interpolateNullable(from.battery, to.battery),
    current: interpolateNullable(from.current, to.current),
    state: amount >= 1 ? to.state : from.state,
    latencyMs: interpolateNullable(from.latencyMs, to.latencyMs),
    poseSigma: interpolateNullable(from.poseSigma, to.poseSigma),
  };
}

function obstacleClearance(
  session: ReplaySessionV2,
  sample: SessionTelemetrySample,
): number | null {
  const monitored = session.environment.objects.filter(
    ({ kind }) => kind === "rack" || kind === "wall" || kind === "obstacle",
  );
  if (monitored.length === 0) {
    return null;
  }
  const radius = requireFiniteDerived(
    Math.hypot(session.robot.footprint.length, session.robot.footprint.width) / 2 +
      session.robot.footprint.safetyMargin,
    "inflated robot radius",
  );
  let minimum = Number.POSITIVE_INFINITY;
  for (const object of monitored) {
    const halfWidth = object.width / 2;
    const halfDepth = object.depth / 2;
    const localX = requireFiniteDerived(
      Math.abs(sample.pose.x - object.x) - halfWidth,
      "obstacle-relative x coordinate",
    );
    const localY = requireFiniteDerived(
      Math.abs(sample.pose.y - object.y) - halfDepth,
      "obstacle-relative y coordinate",
    );
    const outside = requireFiniteDerived(
      Math.hypot(Math.max(0, localX), Math.max(0, localY)),
      "obstacle distance",
    );
    const signedObjectDistance = localX <= 0 && localY <= 0 ? Math.max(localX, localY) : outside;
    minimum = Math.min(
      minimum,
      requireFiniteDerived(signedObjectDistance - radius, "inflated obstacle clearance"),
    );
  }
  return finiteOrNull(minimum);
}

function deriveSessionMetricsWithConfiguration(
  session: ReplaySessionV2,
  run: ReplaySessionRun,
  configuration: DetectorConfiguration,
): DerivedSampleMetrics[] {
  const nominalInterval = runNominalInterval(run);
  const maximumContinuousInterval = effectiveTimestampGapThreshold(
    nominalInterval,
    configuration.rules["timestamp-gap"].threshold,
  );
  const baselineRun = session.runs.baseline;
  const baseline = baselineRun?.samples;
  const baselineMaximumContinuousInterval =
    baselineRun === undefined
      ? 0
      : effectiveTimestampGapThreshold(
          runNominalInterval(baselineRun),
          configuration.rules["timestamp-gap"].threshold,
        );
  const nominalVoltage = session.robot.nominalVoltage ?? null;
  let cumulativeEnergyWh: number | null =
    nominalVoltage === null || run.samples[0]?.current === null ? null : 0;
  let previousCandidateSegmentIndex: number | null = null;
  return run.samples.map((sample, sampleIndex) => {
    const previous = run.samples[sampleIndex - 1];
    const elapsed =
      previous === undefined
        ? null
        : requireFiniteDerived(sample.timestamp - previous.timestamp, "candidate sample interval");
    if (
      cumulativeEnergyWh !== null &&
      previous !== undefined &&
      elapsed !== null &&
      previous.current !== null &&
      sample.current !== null &&
      elapsed <= maximumContinuousInterval
    ) {
      const averageCurrent = Math.abs(previous.current) / 2 + Math.abs(sample.current) / 2;
      const increment = averageCurrent * (nominalVoltage ?? 0) * (elapsed / 3_600);
      cumulativeEnergyWh = finiteOrNull(cumulativeEnergyWh + increment);
    } else if (
      previous !== undefined &&
      (previous.current === null ||
        sample.current === null ||
        (elapsed !== null && elapsed > maximumContinuousInterval))
    ) {
      cumulativeEnergyWh = null;
    }
    const baselineSample =
      baseline === undefined
        ? null
        : sampleAt(baseline, sample.timestamp, baselineMaximumContinuousInterval);
    const baselineProjection =
      baselineSample === null
        ? null
        : routeProjection(
            baselineSample.pose.x,
            baselineSample.pose.y,
            baselineSample.pose.yaw,
            session.plannedRoute,
          );
    const projection = routeProjection(
      sample.pose.x,
      sample.pose.y,
      sample.pose.yaw,
      session.plannedRoute,
      baselineProjection !== null
        ? { preferredSegmentIndex: baselineProjection.segmentIndex, authoritative: true }
        : previousCandidateSegmentIndex === null
          ? undefined
          : { preferredSegmentIndex: previousCandidateSegmentIndex, authoritative: false },
    );
    previousCandidateSegmentIndex = projection.segmentIndex;
    return {
      timestamp: sample.timestamp,
      sampleIndex,
      crossTrackError: projection.distance,
      headingError: projection.headingError,
      baselinePositionDelta:
        baselineSample === null
          ? null
          : finiteOrNull(
              Math.hypot(
                sample.pose.x - baselineSample.pose.x,
                sample.pose.y - baselineSample.pose.y,
              ),
            ),
      intervalJitterMs:
        elapsed === null || nominalInterval === 0
          ? null
          : (() => {
              const jitter = Math.abs(elapsed - nominalInterval) * 1_000;
              return Number.isFinite(jitter) ? (jitter < 1e-6 ? 0 : jitter) : null;
            })(),
      dataAgeMs: sample.latencyMs,
      cumulativeEnergyWh,
      obstacleClearance: obstacleClearance(session, sample),
    };
  });
}

/** Compute bounded per-sample metrics without mutating or resampling source data. */
export function deriveSessionMetrics(
  session: ReplaySessionV2,
  run: ReplaySessionRun = session.runs.candidate,
  options: AnalyzeSessionOptions = {},
): DerivedSampleMetrics[] {
  const configuration = resolvedConfiguration(session, options.detectorOverrides);
  return deriveSessionMetricsWithConfiguration(session, run, configuration);
}

function valuesOf(
  samples: readonly SessionTelemetrySample[],
  selector: (sample: SessionTelemetrySample) => number | null,
): number[] {
  const values: number[] = [];
  for (const sample of samples) {
    const value = selector(sample);
    if (value !== null && Number.isFinite(value)) {
      values.push(value);
    }
  }
  return values;
}

function packetDelivery(samples: readonly SessionTelemetrySample[]): number | null {
  let delivered = 0;
  let expected = 0;
  let comparableIntervals = 0;
  let previousSequence: number | null = null;
  for (const sample of samples) {
    const current = sample.sequence;
    if (current === null) {
      previousSequence = null;
      continue;
    }
    if (previousSequence === null) {
      delivered += 1;
      expected += 1;
      previousSequence = current;
      continue;
    }
    comparableIntervals += 1;
    const delta = current - previousSequence;
    if (delta > 0) {
      delivered += 1;
      expected += delta;
    } else {
      // The packet arrived, but a duplicate or reset cannot establish delivery
      // continuity and therefore counts as an expected-but-invalid position.
      expected += 1;
    }
    previousSequence = current;
  }
  return comparableIntervals === 0 || expected <= 0
    ? null
    : Math.min(100, (delivered / expected) * 100);
}

export function summarizeSessionAnalysis(
  session: ReplaySessionV2,
  metrics: readonly DerivedSampleMetrics[],
  run: ReplaySessionRun = session.runs.candidate,
): AnalysisSummary {
  const firstTimestamp = run.samples[0]?.timestamp ?? 0;
  const lastTimestamp = run.samples.at(-1)?.timestamp ?? firstTimestamp;
  const finiteClearances = metrics
    .map(({ obstacleClearance: value }) => value)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const baselineDeltas = metrics
    .map(({ baselinePositionDelta }) => baselinePositionDelta)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const jitterValues = metrics
    .map(({ intervalJitterMs }) => intervalJitterMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const dataAges = metrics
    .map(({ dataAgeMs }) => dataAgeMs)
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const currents = valuesOf(run.samples, ({ current }) => current).map(Math.abs);
  const batteries = valuesOf(run.samples, ({ battery }) => battery);
  const latencies = valuesOf(run.samples, ({ latencyMs }) => latencyMs);
  return {
    duration: Math.max(
      0,
      requireFiniteDerived(lastTimestamp - firstTimestamp, "analysis duration"),
    ),
    sampleCount: run.samples.length,
    maxCrossTrackError: maximum(metrics.map(({ crossTrackError }) => crossTrackError)) ?? 0,
    maxHeadingError: maximum(metrics.map(({ headingError }) => headingError)) ?? 0,
    maxBaselinePositionDelta: maximum(baselineDeltas),
    packetDeliveryPercent: packetDelivery(run.samples),
    intervalJitterP95Ms: percentile(jitterValues, 0.95),
    maxDataAgeMs: maximum(dataAges),
    energyEstimateWh: finiteOrNull(metrics.at(-1)?.cumulativeEnergyWh ?? Number.NaN),
    minObstacleClearance: minimum(finiteClearances),
    peakCurrent: maximum(currents),
    minBattery: minimum(batteries),
    maxLatencyMs: maximum(latencies),
  };
}

function resolvedConfiguration(
  session: ReplaySessionV2,
  overrides: AnalyzeSessionOptions["detectorOverrides"],
): DetectorConfiguration {
  const configuration = cloneDetectorConfiguration(session.detectors);
  if (overrides !== undefined) {
    for (const [id, override] of Object.entries(overrides) as Array<
      [DetectorId, Partial<DetectorRuleConfig>]
    >) {
      configuration.rules[id] = { ...configuration.rules[id], ...override, id };
    }
  }
  for (const [id, rule] of Object.entries(configuration.rules) as Array<
    [DetectorId, DetectorRuleConfig]
  >) {
    const issues = detectorRuleConfigurationIssues(id, rule);
    if (issues.length > 0) {
      throw new RangeError(`${id}: ${issues.join("; ")}`);
    }
  }
  return configuration;
}

export function resolveDetectorAvailability(
  id: DetectorId,
  session: ReplaySessionV2,
  run: ReplaySessionRun = session.runs.candidate,
): string | null {
  const samples = run.samples;
  switch (id) {
    case "sequence-gap":
      return samples.some((sample, index) => {
        const previous = samples[index - 1];
        return sample.sequence !== null && previous !== undefined && previous.sequence !== null;
      })
        ? null
        : "No adjacent samples provide sequence continuity.";
    case "overcurrent":
      return samples.some(({ current }) => current !== null)
        ? null
        : "Motor current is unavailable.";
    case "low-battery":
      return samples.some(({ battery }) => battery !== null)
        ? null
        : "Battery charge is unavailable.";
    case "link-degradation":
      return samples.some(({ latencyMs }) => latencyMs !== null)
        ? null
        : "Link latency is unavailable.";
    case "safe-stop":
      return samples.some(({ state }) => state !== null)
        ? null
        : "Controller state is unavailable.";
    case "obstacle-clearance":
      return session.environment.objects.some(
        ({ kind }) => kind === "rack" || kind === "wall" || kind === "obstacle",
      )
        ? null
        : "No collision geometry is available.";
    case "route-deviation":
    case "heading-error":
      return session.plannedRoute.source === "inferred-observation"
        ? "No authoritative mission route is available."
        : null;
    case "timestamp-gap":
    case "pose-discontinuity":
      return null;
  }
}

function episodeDuration(
  samples: readonly SessionTelemetrySample[],
  startIndex: number,
  endIndex: number,
): number {
  const start = samples[startIndex]?.timestamp ?? 0;
  const end = samples[endIndex]?.timestamp ?? start;
  return Math.max(0, requireFiniteDerived(end - start, "detector episode duration"));
}

function durationMeetsMinimum(duration: number, minimumDuration: number): boolean {
  if (duration >= minimumDuration) {
    return true;
  }
  const scale = Math.max(Math.abs(duration), Math.abs(minimumDuration), Number.MIN_VALUE);
  const representationTolerance = Number.EPSILON * scale * 4;
  return minimumDuration - duration <= representationTolerance;
}

function episodes(
  samples: readonly SessionTelemetrySample[],
  values: readonly (number | null)[],
  predicate: (value: number) => boolean,
  peakMode: "min" | "max",
  minimumDuration: number,
  maximumContinuousInterval: number,
): Episode[] {
  const result: Episode[] = [];
  let startIndex: number | null = null;
  const finish = (endIndex: number): void => {
    if (startIndex === null) {
      return;
    }
    if (durationMeetsMinimum(episodeDuration(samples, startIndex, endIndex), minimumDuration)) {
      let peakIndex = startIndex;
      for (let index = startIndex + 1; index <= endIndex; index += 1) {
        const candidate = values[index];
        const peak = values[peakIndex];
        if (
          candidate !== null &&
          candidate !== undefined &&
          peak !== null &&
          peak !== undefined &&
          (peakMode === "max" ? candidate > peak : candidate < peak)
        ) {
          peakIndex = index;
        }
      }
      result.push({
        startIndex,
        endIndex,
        peakIndex,
        observed: values[peakIndex] ?? 0,
      });
    }
    startIndex = null;
  };
  values.forEach((value, index) => {
    const previous = samples[index - 1];
    const current = samples[index];
    if (
      startIndex !== null &&
      previous !== undefined &&
      current !== undefined &&
      requireFiniteDerived(current.timestamp - previous.timestamp, "detector continuity interval") >
        maximumContinuousInterval
    ) {
      finish(index - 1);
    }
    if (value !== null && predicate(value)) {
      startIndex ??= index;
    } else if (startIndex !== null) {
      finish(index - 1);
    }
  });
  if (startIndex !== null) {
    finish(values.length - 1);
  }
  return result;
}

function uniqueSupportingIndices(start: number, peak: number, end: number): number[] {
  return [...new Set([start, peak, end])];
}

interface IncidentFields {
  rule: DetectorRuleConfig;
  run: ReplaySessionRun;
  episode: Episode;
  evidenceStartIndex?: number;
  title: string;
  description: string;
  evidence: Omit<IncidentEvidence, "duration" | "sampleRange" | "supportingSampleIndices">;
}

function incident(fields: IncidentFields): SessionIncident {
  const { rule, run, episode } = fields;
  const start = run.samples[episode.startIndex];
  const end = run.samples[episode.endIndex];
  const evidenceStartIndex = fields.evidenceStartIndex ?? episode.startIndex;
  if (start === undefined || end === undefined || run.samples[evidenceStartIndex] === undefined) {
    throw new RangeError("incident episode references an unavailable sample");
  }
  return {
    id: `${rule.id}-${run.id}-${episode.startIndex}`,
    detectorId: rule.id,
    ruleVersion: rule.version,
    severity: rule.severity,
    timestamp: start.timestamp,
    endTimestamp: end.timestamp,
    sampleIndex: episode.startIndex,
    title: fields.title,
    description: fields.description,
    evidence: {
      ...fields.evidence,
      duration: Math.max(
        0,
        requireFiniteDerived(end.timestamp - start.timestamp, "incident duration"),
      ),
      sampleRange: [evidenceStartIndex, episode.endIndex],
      supportingSampleIndices: uniqueSupportingIndices(
        evidenceStartIndex,
        episode.peakIndex,
        episode.endIndex,
      ),
    },
  };
}

/** Build cadence-dependent baseline state once, then reuse it for every incident peak. */
function createBaselineLookup(
  session: ReplaySessionV2,
  configuration: DetectorConfiguration,
): BaselineLookup | null {
  const run = session.runs.baseline;
  if (run === undefined) {
    return null;
  }
  return {
    samples: run.samples,
    maximumInterpolationInterval: effectiveTimestampGapThreshold(
      runNominalInterval(run),
      configuration.rules["timestamp-gap"].threshold,
    ),
  };
}

function baselineMetricDelta(
  baseline: BaselineLookup | null,
  candidate: SessionTelemetrySample,
  candidateValue: number | null,
  baselineSelector: (sample: SessionTelemetrySample) => number | null,
): number | null {
  if (baseline === null || candidateValue === null) {
    return null;
  }
  const baselineSample = sampleAt(
    baseline.samples,
    candidate.timestamp,
    baseline.maximumInterpolationInterval,
  );
  if (baselineSample === null) {
    return null;
  }
  const baselineValue = baselineSelector(baselineSample);
  return baselineValue === null ? null : finiteOrNull(candidateValue - baselineValue);
}

function baselineChannelDelta(
  baseline: BaselineLookup | null,
  candidate: SessionTelemetrySample,
  selector: (sample: SessionTelemetrySample) => number | null,
): number | null {
  return baselineMetricDelta(baseline, candidate, selector(candidate), selector);
}

function baselinePositionStepDelta(
  baseline: BaselineLookup | null,
  previous: SessionTelemetrySample,
  current: SessionTelemetrySample,
  candidateStep: number,
): number | null {
  if (baseline === null) {
    return null;
  }
  const { samples, maximumInterpolationInterval } = baseline;
  const baselinePrevious = sampleAt(samples, previous.timestamp, maximumInterpolationInterval);
  const baselineCurrent = sampleAt(samples, current.timestamp, maximumInterpolationInterval);
  if (
    baselinePrevious === null ||
    baselineCurrent === null ||
    !baselineContinuityBetween(
      samples,
      previous.timestamp,
      current.timestamp,
      maximumInterpolationInterval,
    )
  ) {
    return null;
  }
  const baselineStep = Math.hypot(
    baselineCurrent.pose.x - baselinePrevious.pose.x,
    baselineCurrent.pose.y - baselinePrevious.pose.y,
  );
  return finiteOrNull(candidateStep - baselineStep);
}

function baselineContinuityBetween(
  samples: readonly SessionTelemetrySample[],
  startTimestamp: number,
  endTimestamp: number,
  maximumContinuousInterval: number,
): boolean {
  const start = Math.min(startTimestamp, endTimestamp);
  const end = Math.max(startTimestamp, endTimestamp);
  if (end <= start) {
    return true;
  }
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((samples[middle]?.timestamp ?? Number.POSITIVE_INFINITY) <= start) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  for (let index = low; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (current === undefined || current.timestamp > end) {
      break;
    }
    if (
      previous !== undefined &&
      current.timestamp - previous.timestamp > maximumContinuousInterval
    ) {
      return false;
    }
  }
  return true;
}

interface SessionIncidentDetection {
  incidents: SessionIncident[];
  disabledDetectors: Array<{ id: DetectorId; reason: string }>;
  configuration: DetectorConfiguration;
}

function detectSessionIncidentsWithConfiguration(
  session: ReplaySessionV2,
  metrics: readonly DerivedSampleMetrics[],
  configuration: DetectorConfiguration,
): SessionIncidentDetection {
  const run = session.runs.candidate;
  const samples = run.samples;
  const incidents: SessionIncident[] = [];
  const disabledDetectors: Array<{ id: DetectorId; reason: string }> = [];
  const timestampGapThreshold = effectiveTimestampGapThreshold(
    runNominalInterval(run),
    configuration.rules["timestamp-gap"].threshold,
  );
  const baselineLookup = createBaselineLookup(session, configuration);
  const addIncident = (fields: IncidentFields): void => {
    if (incidents.length >= MAX_ANALYSIS_INCIDENTS) {
      throw new RangeError(
        `Analysis stopped because detector output exceeded the ${MAX_ANALYSIS_INCIDENTS.toLocaleString("en-US")} incident resource limit. Narrow the recording or detector scope before retrying.`,
      );
    }
    incidents.push(incident(fields));
  };

  const usableRule = (id: DetectorId): DetectorRuleConfig | null => {
    const rule = configuration.rules[id];
    const unavailable = resolveDetectorAvailability(id, session, run);
    if (!rule.enabled || unavailable !== null) {
      disabledDetectors.push({
        id,
        reason: rule.enabled
          ? (unavailable ?? "Required input is unavailable.")
          : "Disabled by configuration.",
      });
      return null;
    }
    return rule;
  };

  const timestampRule = usableRule("timestamp-gap");
  if (timestampRule !== null) {
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      const interval = requireFiniteDerived(
        current.timestamp - previous.timestamp,
        "timestamp-gap interval",
      );
      if (interval > timestampGapThreshold) {
        const episode = {
          startIndex: index - 1,
          endIndex: index,
          peakIndex: index,
          observed: interval,
        };
        addIncident({
          rule: timestampRule,
          run,
          episode,
          title: "Telemetry dropout",
          description: `No candidate sample arrived for ${interval.toFixed(2)} s.`,
          evidence: {
            observed: interval,
            threshold: timestampGapThreshold,
            comparator: "above",
            unit: "s",
            baselineDelta: null,
            operatorCheck: "Inspect source timestamps around both dropout boundaries.",
          },
        });
      }
    }
  }

  const sequenceRule = usableRule("sequence-gap");
  if (sequenceRule !== null) {
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (
        previous?.sequence === null ||
        current?.sequence === null ||
        previous === undefined ||
        current === undefined
      ) {
        continue;
      }
      const delta = current.sequence - previous.sequence;
      const missing = Math.max(0, delta - 1);
      if (missing > sequenceRule.threshold || delta <= 0) {
        addIncident({
          rule: sequenceRule,
          run,
          episode: { startIndex: index, endIndex: index, peakIndex: index, observed: missing },
          evidenceStartIndex: index - 1,
          title: delta <= 0 ? "Sequence regression" : "Packet loss",
          description:
            delta <= 0
              ? `Sequence regressed from ${previous.sequence} to ${current.sequence}.`
              : `${missing} expected telemetry packets are absent.`,
          evidence: {
            observed: delta <= 0 ? delta : missing,
            threshold: delta <= 0 ? 1 : sequenceRule.threshold,
            comparator: delta <= 0 ? "below" : "above",
            unit: delta <= 0 ? "sequence delta" : "packets",
            baselineDelta: null,
            operatorCheck: "Compare packet counters with transport-side drop statistics.",
          },
        });
      }
    }
  }

  const poseRule = usableRule("pose-discontinuity");
  if (poseRule !== null) {
    for (let index = 1; index < samples.length; index += 1) {
      const previous = samples[index - 1];
      const current = samples[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      if (
        requireFiniteDerived(current.timestamp - previous.timestamp, "pose continuity interval") >
        timestampGapThreshold
      ) {
        continue;
      }
      const jump = requireFiniteDerived(
        Math.hypot(current.pose.x - previous.pose.x, current.pose.y - previous.pose.y),
        "position discontinuity",
      );
      if (jump > poseRule.threshold) {
        addIncident({
          rule: poseRule,
          run,
          episode: { startIndex: index, endIndex: index, peakIndex: index, observed: jump },
          evidenceStartIndex: index - 1,
          title: "Localization reset",
          description: `Reported pose moved ${jump.toFixed(2)} m between adjacent samples.`,
          evidence: {
            observed: jump,
            threshold: poseRule.threshold,
            comparator: "above",
            unit: "m",
            baselineDelta: baselinePositionStepDelta(baselineLookup, previous, current, jump),
            operatorCheck: "Check localization reset counters and raw odometry continuity.",
          },
        });
      }
      // This detector's configured threshold is explicitly translational and
      // measured in metres. Angular route alignment remains the responsibility
      // of the heading-error rule, so planned corners cannot be mislabeled as
      // pose resets through an undocumented cross-rule radian threshold.
    }
  }

  const addNumericEpisodes = (
    id: DetectorId,
    values: readonly (number | null)[],
    comparator: "above" | "below",
    title: string,
    unit: string,
    check: string,
    description: (observed: number, threshold: number) => string,
    baselineDelta: (sample: SessionTelemetrySample, metric: DerivedSampleMetrics) => number | null,
  ): void => {
    const rule = usableRule(id);
    if (rule === null) {
      return;
    }
    const found = episodes(
      samples,
      values,
      comparator === "above"
        ? (value) => value > rule.threshold
        : (value) => value < rule.threshold,
      comparator === "above" ? "max" : "min",
      rule.minimumDuration,
      timestampGapThreshold,
    );
    for (const foundEpisode of found) {
      const sample = samples[foundEpisode.peakIndex];
      const metric = metrics[foundEpisode.peakIndex];
      if (sample === undefined || metric === undefined) {
        continue;
      }
      addIncident({
        rule,
        run,
        episode: foundEpisode,
        title,
        description: description(foundEpisode.observed, rule.threshold),
        evidence: {
          observed: foundEpisode.observed,
          threshold: rule.threshold,
          comparator,
          unit,
          baselineDelta: baselineDelta(sample, metric),
          operatorCheck: check,
        },
      });
    }
  };

  addNumericEpisodes(
    "overcurrent",
    samples.map(({ current }) => (current === null ? null : Math.abs(current))),
    "above",
    "Control load saturation",
    "A",
    "Compare drive demand, wheel speed, and current-limit status over this window.",
    (observed, threshold) =>
      `Motor current reached ${observed.toFixed(1)} A above the ${threshold.toFixed(1)} A rule.`,
    (sample) =>
      baselineChannelDelta(baselineLookup, sample, ({ current }) =>
        current === null ? null : Math.abs(current),
      ),
  );
  addNumericEpisodes(
    "low-battery",
    samples.map(({ battery }) => battery),
    "below",
    "Low battery reserve",
    "%",
    "Confirm pack state of charge and voltage under load.",
    (observed, threshold) =>
      `Battery reserve fell to ${observed.toFixed(1)}%, below ${threshold.toFixed(1)}%.`,
    (sample) => baselineChannelDelta(baselineLookup, sample, ({ battery }) => battery),
  );
  addNumericEpisodes(
    "link-degradation",
    samples.map(({ latencyMs }) => latencyMs),
    "above",
    "Link degradation",
    "ms",
    "Inspect radio diagnostics and correlate latency with packet-counter discontinuities.",
    (observed, threshold) =>
      `End-to-end latency peaked at ${observed.toFixed(0)} ms above the ${threshold.toFixed(0)} ms rule.`,
    (sample) => baselineChannelDelta(baselineLookup, sample, ({ latencyMs }) => latencyMs),
  );
  addNumericEpisodes(
    "route-deviation",
    metrics.map(({ crossTrackError }) => crossTrackError),
    "above",
    "Route deviation",
    "m",
    "Compare candidate pose, route corridor, and nominal replay.",
    (observed, threshold) =>
      `Cross-track error reached ${observed.toFixed(2)} m outside the ${threshold.toFixed(2)} m rule.`,
    (sample) =>
      baselineChannelDelta(
        baselineLookup,
        sample,
        (comparisonSample) =>
          routeProjection(
            comparisonSample.pose.x,
            comparisonSample.pose.y,
            comparisonSample.pose.yaw,
            session.plannedRoute,
          ).distance,
      ),
  );
  addNumericEpisodes(
    "heading-error",
    metrics.map(({ headingError }) => headingError),
    "above",
    "Heading drift",
    "rad",
    "Compare reported pose heading against the active route-segment tangent.",
    (observed, threshold) =>
      `Heading error reached ${((observed * 180) / Math.PI).toFixed(1)}°, above the ${((threshold * 180) / Math.PI).toFixed(1)}° rule.`,
    (sample, metric) =>
      baselineMetricDelta(
        baselineLookup,
        sample,
        metric.headingError,
        (comparisonSample) =>
          routeProjection(
            comparisonSample.pose.x,
            comparisonSample.pose.y,
            comparisonSample.pose.yaw,
            session.plannedRoute,
          ).headingError,
      ),
  );
  addNumericEpisodes(
    "obstacle-clearance",
    metrics.map(({ obstacleClearance }) => obstacleClearance),
    "below",
    "Safety corridor breach",
    "m",
    "Inspect footprint inflation, rack geometry, and the minimum-clearance pose.",
    (observed, threshold) =>
      `Inflated footprint clearance fell to ${observed.toFixed(2)} m below the ${threshold.toFixed(2)} m rule.`,
    (sample, metric) =>
      baselineMetricDelta(baselineLookup, sample, metric.obstacleClearance, (comparisonSample) =>
        obstacleClearance(session, comparisonSample),
      ),
  );

  const safeStopRule = usableRule("safe-stop");
  if (safeStopRule !== null) {
    const safeStopValues = samples.map(({ state }) =>
      normalizeControllerStateToken(state) === "safe-stop" ? 1 : 0,
    );
    for (const foundEpisode of episodes(
      samples,
      safeStopValues,
      (value) => value === 1,
      "max",
      safeStopRule.minimumDuration,
      timestampGapThreshold,
    )) {
      addIncident({
        rule: safeStopRule,
        run,
        episode: foundEpisode,
        title: "Protective safe-stop",
        description: "The motion controller entered its protective safe-stop state.",
        evidence: {
          observed: "safe-stop",
          threshold: "state entered",
          comparator: "state-entered",
          unit: "controller state",
          baselineDelta: null,
          operatorCheck: "Confirm the stop reason, interlock chain, and zero-speed transition.",
        },
      });
    }
  }

  return {
    incidents: incidents.sort(
      (left, right) =>
        left.timestamp - right.timestamp || left.detectorId.localeCompare(right.detectorId),
    ),
    disabledDetectors,
    configuration,
  };
}

/** Run deterministic, configurable detectors and return inspectable evidence. */
export function detectSessionIncidents(
  session: ReplaySessionV2,
  metrics: readonly DerivedSampleMetrics[] | undefined = undefined,
  options: AnalyzeSessionOptions = {},
): SessionIncidentDetection {
  const configuration = resolvedConfiguration(session, options.detectorOverrides);
  return detectSessionIncidentsWithConfiguration(
    session,
    metrics ??
      deriveSessionMetricsWithConfiguration(session, session.runs.candidate, configuration),
    configuration,
  );
}

function classificationFor(
  incidentValue: SessionIncident,
  firstIncident: SessionIncident,
): EvidenceChainClassification {
  if (incidentValue.detectorId === "safe-stop") {
    return "protective-response";
  }
  return Math.abs(incidentValue.timestamp - firstIncident.timestamp) <=
    TIMESTAMP_EQUALITY_TOLERANCE || coReferentialEvidence(firstIncident, incidentValue)
    ? "earliest-crossing"
    : "subsequent-crossing";
}

const MAX_EVIDENCE_NEIGHBOR_GAP_SECONDS = 3;
const MAX_EVIDENCE_WINDOW_SPAN_SECONDS = 8;
const TIMESTAMP_EQUALITY_TOLERANCE = 1e-9;

function sampleRangesOverlap(left: SessionIncident, right: SessionIncident): boolean {
  const [leftStart, leftEnd] = left.evidence.sampleRange;
  const [rightStart, rightEnd] = right.evidence.sampleRange;
  return leftStart <= rightEnd && rightStart <= leftEnd;
}

function incidentIntervalsOverlap(left: SessionIncident, right: SessionIncident): boolean {
  return (
    left.timestamp <= right.endTimestamp + TIMESTAMP_EQUALITY_TOLERANCE &&
    right.timestamp <= left.endTimestamp + TIMESTAMP_EQUALITY_TOLERANCE
  );
}

function relatedEvidence(left: SessionIncident, right: SessionIncident): boolean {
  return sampleRangesOverlap(left, right) && incidentIntervalsOverlap(left, right);
}

function coReferentialEvidence(left: SessionIncident, right: SessionIncident): boolean {
  return (
    left.evidence.sampleRange[0] === right.evidence.sampleRange[0] &&
    left.evidence.sampleRange[1] === right.evidence.sampleRange[1] &&
    incidentIntervalsOverlap(left, right)
  );
}

function evidenceElapsed(left: SessionIncident, right: SessionIncident): number {
  return coReferentialEvidence(left, right) ? 0 : Math.max(0, right.timestamp - left.timestamp);
}

function evidenceWindows(ordered: readonly SessionIncident[]): SessionIncident[][] {
  const windows: SessionIncident[][] = [];
  let current: SessionIncident[] = [];
  let overlapFrontier: SessionIncident | undefined;
  for (const incidentValue of ordered) {
    const first = current[0];
    const previous = current.at(-1);
    const sharesEvidence =
      (previous !== undefined && relatedEvidence(previous, incidentValue)) ||
      (overlapFrontier !== undefined && relatedEvidence(overlapFrontier, incidentValue));
    if (
      first !== undefined &&
      previous !== undefined &&
      !sharesEvidence &&
      (incidentValue.timestamp - previous.timestamp > MAX_EVIDENCE_NEIGHBOR_GAP_SECONDS ||
        incidentValue.timestamp - first.timestamp > MAX_EVIDENCE_WINDOW_SPAN_SECONDS)
    ) {
      windows.push(current);
      current = [];
      overlapFrontier = undefined;
    }
    current.push(incidentValue);
    if (
      overlapFrontier === undefined ||
      incidentValue.endTimestamp > overlapFrontier.endTimestamp ||
      (incidentValue.endTimestamp === overlapFrontier.endTimestamp &&
        incidentValue.evidence.sampleRange[1] > overlapFrontier.evidence.sampleRange[1])
    ) {
      overlapFrontier = incidentValue;
    }
  }
  if (current.length > 0) {
    windows.push(current);
  }
  return windows;
}

function firstCrossingPerDetector(window: readonly SessionIncident[]): SessionIncident[] {
  const seen = new Set<DetectorId>();
  return window.filter(({ detectorId }) => {
    if (seen.has(detectorId)) {
      return false;
    }
    seen.add(detectorId);
    return true;
  });
}

function meaningfulEvidenceWindow(window: readonly SessionIncident[]): boolean {
  const first = window[0];
  const last = window.at(-1);
  const hasRelatedEvidence = window.some((incidentValue, index) =>
    window.slice(index + 1).some((other) => relatedEvidence(incidentValue, other)),
  );
  return (
    first !== undefined &&
    last !== undefined &&
    window.length >= 2 &&
    new Set(window.map(({ detectorId }) => detectorId)).size >= 2 &&
    (last.timestamp - first.timestamp > TIMESTAMP_EQUALITY_TOLERANCE || hasRelatedEvidence)
  );
}

function formatEvidenceElapsed(elapsed: number): string {
  return elapsed < 0.1 ? elapsed.toFixed(3) : elapsed.toFixed(2);
}

function timingRationale(
  window: readonly SessionIncident[],
  incidentValue: SessionIncident,
  index: number,
): string {
  const previous = window[index - 1];
  if (previous === undefined) {
    const next = window[index + 1];
    if (next !== undefined && coReferentialEvidence(incidentValue, next)) {
      return "Shares the opening evidence boundary with another detector finding; both become observable at the post-boundary sample, so their relative order is unresolved.";
    }
    return next !== undefined &&
      Math.abs(next.timestamp - incidentValue.timestamp) <= TIMESTAMP_EQUALITY_TOLERANCE
      ? "Shares the opening timestamp with another detector crossing; their relative order is unresolved."
      : "Earliest recorded detector crossing in this bounded review window; it is an anchor, not a proven cause.";
  }
  if (coReferentialEvidence(previous, incidentValue)) {
    return incidentValue.detectorId === "safe-stop"
      ? `The protective response shares ${previous.title}'s supporting sample boundary; telemetry does not establish a later order.`
      : `Shares the same supporting sample boundary as ${previous.title}; this is co-referential evidence, not a later event.`;
  }
  const elapsed = evidenceElapsed(previous, incidentValue);
  if (elapsed <= TIMESTAMP_EQUALITY_TOLERANCE) {
    return `Shares a recorded timestamp with ${previous.title}; telemetry does not resolve their relative order.`;
  }
  return incidentValue.detectorId === "safe-stop"
    ? `The protective response began ${formatEvidenceElapsed(elapsed)} s after ${previous.title}; this establishes order only, not cause.`
    : `This detector crossed ${formatEvidenceElapsed(elapsed)} s after ${previous.title}; this establishes measured order only.`;
}

/** Build a temporal evidence narrative that explicitly avoids causal claims. */
export function createEvidenceChains(
  session: ReplaySessionV2,
  incidents: readonly SessionIncident[],
): EvidenceChain[] {
  if (incidents.length < 2) {
    return [];
  }
  const ordered = [...incidents].sort(
    (left, right) =>
      left.timestamp - right.timestamp ||
      left.detectorId.localeCompare(right.detectorId) ||
      left.id.localeCompare(right.id),
  );
  return evidenceWindows(ordered)
    .map(firstCrossingPerDetector)
    .flatMap(evidenceWindows)
    .filter(meaningfulEvidenceWindow)
    .map((window, windowIndex) => {
      const first = window[0];
      if (first === undefined) {
        throw new RangeError("evidence window must contain at least one incident");
      }
      const span = window
        .slice(1)
        .reduce(
          (elapsed, incidentValue, index) =>
            elapsed + evidenceElapsed(window[index] ?? incidentValue, incidentValue),
          0,
        );
      return {
        id: `evidence-chain-${session.id}-${session.runs.candidate.id}-${windowIndex + 1}`,
        title: `${session.mission.id} evidence window ${windowIndex + 1}`,
        summary: `${window.length} detector rules contributed evidence within a bounded ${formatEvidenceElapsed(span)} s review window. Their measured ordering supports investigation prioritization and is not a claim of proven causality.`,
        steps: window.map((incidentValue, index) => ({
          incidentId: incidentValue.id,
          classification: classificationFor(incidentValue, first),
          elapsedFromPrevious:
            index === 0 ? null : evidenceElapsed(window[index - 1] ?? incidentValue, incidentValue),
          rationale: timingRationale(window, incidentValue, index),
        })),
        correlationIsNotCausation: true as const,
      };
    });
}

/** Complete synchronous analysis API; the worker delegates to this same path. */
export function analyzeSession(
  session: ReplaySessionV2,
  options: AnalyzeSessionOptions = {},
): SessionAnalysis {
  const configuration = resolvedConfiguration(session, options.detectorOverrides);
  const metrics = deriveSessionMetricsWithConfiguration(
    session,
    session.runs.candidate,
    configuration,
  );
  const detection = detectSessionIncidentsWithConfiguration(session, metrics, configuration);
  return {
    sessionId: session.id,
    runId: session.runs.candidate.id,
    detectorVersion: detection.configuration.version,
    metrics,
    summary: summarizeSessionAnalysis(session, metrics),
    incidents: detection.incidents,
    evidenceChains: createEvidenceChains(session, detection.incidents),
    disabledDetectors: detection.disabledDetectors,
  };
}

/** Alias that makes direct/fallback integrations read naturally. */
export const analyzeReplaySession = analyzeSession;
