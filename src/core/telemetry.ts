import type {
  Anomaly,
  AnomalyDetectionOptions,
  AnomalyType,
  RunKind,
  ResolvedTelemetrySample,
  StateChange,
  TelemetryRun,
  TelemetrySample,
  TimestampGap,
  TimelineMarker,
} from "./types";

const TWO_PI = Math.PI * 2;

const DEFAULTS = {
  timestampGapMultiplier: 3,
  minimumTimestampGap: 0.25,
  poseDiscontinuityDistance: 0.75,
  poseDiscontinuityYaw: Math.PI * 0.7,
  overcurrentThreshold: 18,
  lowBatteryThreshold: 20,
} as const;

export class TelemetryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryParseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new TelemetryParseError(`${path} must be an object`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TelemetryParseError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TelemetryParseError(`${path} must be a finite number`);
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const number = requireFiniteNumber(value, path);
  if (number < 0) {
    throw new TelemetryParseError(`${path} must be greater than or equal to zero`);
  }
  return number;
}

function optionalNonNegativeNumber(value: unknown, path: string): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return requireNonNegativeNumber(value, path);
}

function parseSample(value: unknown, index: number): TelemetrySample {
  const path = `samples[${index}]`;
  const sample = requireRecord(value, path);
  const pose = requireRecord(sample.pose, `${path}.pose`);
  const sequence = requireNonNegativeNumber(sample.sequence, `${path}.sequence`);

  if (!Number.isSafeInteger(sequence)) {
    throw new TelemetryParseError(`${path}.sequence must be a safe integer`);
  }

  const battery = requireFiniteNumber(sample.battery, `${path}.battery`);
  if (battery < 0 || battery > 100) {
    throw new TelemetryParseError(`${path}.battery must be between 0 and 100`);
  }

  const latencyMs = optionalNonNegativeNumber(sample.latencyMs, `${path}.latencyMs`);
  const poseSigma = optionalNonNegativeNumber(sample.poseSigma, `${path}.poseSigma`);

  return {
    timestamp: requireNonNegativeNumber(sample.timestamp, `${path}.timestamp`),
    sequence,
    pose: {
      x: requireFiniteNumber(pose.x, `${path}.pose.x`),
      y: requireFiniteNumber(pose.y, `${path}.pose.y`),
      yaw: requireFiniteNumber(pose.yaw, `${path}.pose.yaw`),
    },
    speed: requireFiniteNumber(sample.speed, `${path}.speed`),
    battery,
    current: requireFiniteNumber(sample.current, `${path}.current`),
    state: requireString(sample.state, `${path}.state`),
    ...(latencyMs === undefined ? {} : { latencyMs }),
    ...(poseSigma === undefined ? {} : { poseSigma }),
  };
}

/**
 * Parse and validate a telemetry run from JSON text or an already decoded value.
 * Sequence discontinuities are intentionally allowed so they can be diagnosed.
 */
export function parseTelemetryJson(input: string | unknown): TelemetryRun {
  let decoded: unknown;

  if (typeof input === "string") {
    try {
      decoded = JSON.parse(input) as unknown;
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid JSON";
      throw new TelemetryParseError(`Unable to parse telemetry JSON: ${reason}`);
    }
  } else {
    decoded = input;
  }

  const run = requireRecord(decoded, "run");
  const id = requireString(run.id, "run.id");
  const name = requireString(run.name, "run.name");
  const kind = run.kind;

  if (kind !== "normal" && kind !== "faulty") {
    throw new TelemetryParseError('run.kind must be either "normal" or "faulty"');
  }
  if (!Array.isArray(run.samples) || run.samples.length === 0) {
    throw new TelemetryParseError("run.samples must be a non-empty array");
  }
  for (let index = 0; index < run.samples.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(run.samples, index)) {
      throw new TelemetryParseError(`run.samples[${index}] must not be a sparse array entry`);
    }
  }

  const samples = run.samples.map(parseSample);
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    if (current.timestamp <= previous.timestamp) {
      throw new TelemetryParseError(
        `samples[${index}].timestamp must be greater than samples[${index - 1}].timestamp`,
      );
    }
  }

  const parsed: TelemetryRun = { id, name, kind, samples };
  if (run.description !== undefined) {
    parsed.description = requireString(run.description, "run.description");
  }
  if (run.sampleRateHz !== undefined) {
    const sampleRateHz = requireFiniteNumber(run.sampleRateHz, "run.sampleRateHz");
    if (sampleRateHz < 1e-9 || sampleRateHz > 1e9 || !Number.isFinite(1 / sampleRateHz)) {
      throw new TelemetryParseError("run.sampleRateHz must be between 1e-9 and 1e9 Hz");
    }
    parsed.sampleRateHz = sampleRateHz;
  }
  return parsed;
}

/** Normalize an angle in radians to [-PI, PI). */
export function normalizeYaw(yaw: number): number {
  const normalized = ((((yaw + Math.PI) % TWO_PI) + TWO_PI) % TWO_PI) - Math.PI;
  return Object.is(normalized, -0) ? 0 : normalized;
}

/** Shortest signed angular displacement from `from` to `to`. */
export function shortestYawDelta(from: number, to: number): number {
  return normalizeYaw(to - from);
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}

/**
 * Interpolate between two samples at an absolute timestamp. Discrete state and
 * sequence fields change only when the second sample's timestamp is reached.
 */
export function interpolateTelemetrySample(
  from: TelemetrySample,
  to: TelemetrySample,
  timestamp: number,
): TelemetrySample {
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("timestamp must be finite");
  }
  if (to.timestamp <= from.timestamp) {
    throw new RangeError("the second sample must have a later timestamp");
  }

  const amount = Math.max(
    0,
    Math.min(1, (timestamp - from.timestamp) / (to.timestamp - from.timestamp)),
  );
  const atUpperSample = amount >= 1;

  return {
    timestamp: lerp(from.timestamp, to.timestamp, amount),
    sequence: atUpperSample ? to.sequence : from.sequence,
    pose: {
      x: lerp(from.pose.x, to.pose.x, amount),
      y: lerp(from.pose.y, to.pose.y, amount),
      yaw: normalizeYaw(from.pose.yaw + shortestYawDelta(from.pose.yaw, to.pose.yaw) * amount),
    },
    speed: lerp(from.speed, to.speed, amount),
    battery: lerp(from.battery, to.battery, amount),
    current: lerp(from.current, to.current, amount),
    state: atUpperSample ? to.state : from.state,
  };
}

/**
 * Return the interpolated sample for an arbitrary time, clamped to the run's
 * first and last samples. The search is logarithmic for large runs.
 */
export function sampleAtTimestamp(
  samples: readonly TelemetrySample[],
  timestamp: number,
): TelemetrySample {
  if (samples.length === 0) {
    throw new RangeError("cannot sample an empty telemetry series");
  }
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("timestamp must be finite");
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError("cannot sample an empty telemetry series");
  }
  if (timestamp <= first.timestamp) {
    return { ...first, pose: { ...first.pose } };
  }
  if (timestamp >= last.timestamp) {
    return { ...last, pose: { ...last.pose } };
  }

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = samples[middle];
    if (candidate !== undefined && candidate.timestamp <= timestamp) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const from = samples[low];
  const to = samples[high];
  if (from === undefined || to === undefined) {
    throw new RangeError("telemetry samples must be ordered by timestamp");
  }
  return interpolateTelemetrySample(from, to, timestamp);
}

/** Friendly alias used by consumers which do not need the longer function name. */
export const interpolateSample = sampleAtTimestamp;

function cloneSample(sample: TelemetrySample): TelemetrySample {
  return { ...sample, pose: { ...sample.pose } };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted[middle] ?? 0;
  if (sorted.length % 2 === 1) {
    return upper;
  }
  const lower = sorted[middle - 1] ?? upper;
  return (lower + upper) / 2;
}

export function inferSampleInterval(samples: readonly TelemetrySample[]): number {
  const intervals: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const current = samples[index];
    const previous = samples[index - 1];
    if (current !== undefined && previous !== undefined) {
      const interval = current.timestamp - previous.timestamp;
      if (interval > 0 && Number.isFinite(interval)) {
        intervals.push(interval);
      }
    }
  }
  return median(intervals);
}

function anomalyId(type: AnomalyType, sample: TelemetrySample, sampleIndex: number): string {
  return `${type}-${sample.sequence}-${sampleIndex}`;
}

function assertPositiveOption(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero`);
  }
}

interface DetectionThresholds {
  timestampGap: number;
  poseDistance: number;
  poseYaw: number;
  overcurrent: number;
  lowBattery: number;
}

type TimestampGapOptions = Pick<
  AnomalyDetectionOptions,
  "timestampGapThreshold" | "timestampGapMultiplier"
>;

function resolveTimestampGapThreshold(
  samples: readonly TelemetrySample[],
  options: TimestampGapOptions,
): number {
  const multiplier = options.timestampGapMultiplier ?? DEFAULTS.timestampGapMultiplier;
  assertPositiveOption(multiplier, "timestampGapMultiplier");

  if (options.timestampGapThreshold !== undefined) {
    assertPositiveOption(options.timestampGapThreshold, "timestampGapThreshold");
    return options.timestampGapThreshold;
  }

  return Math.max(DEFAULTS.minimumTimestampGap, inferSampleInterval(samples) * multiplier);
}

function resolveDetectionThresholds(
  samples: readonly TelemetrySample[],
  options: AnomalyDetectionOptions,
): DetectionThresholds {
  const timestampGap = resolveTimestampGapThreshold(samples, options);
  const thresholds: DetectionThresholds = {
    timestampGap,
    poseDistance: options.poseDiscontinuityDistance ?? DEFAULTS.poseDiscontinuityDistance,
    poseYaw: options.poseDiscontinuityYaw ?? DEFAULTS.poseDiscontinuityYaw,
    overcurrent: options.overcurrentThreshold ?? DEFAULTS.overcurrentThreshold,
    lowBattery: options.lowBatteryThreshold ?? DEFAULTS.lowBatteryThreshold,
  };

  assertPositiveOption(thresholds.poseDistance, "poseDiscontinuityDistance");
  assertPositiveOption(thresholds.poseYaw, "poseDiscontinuityYaw");
  assertPositiveOption(thresholds.overcurrent, "overcurrentThreshold");
  assertPositiveOption(thresholds.lowBattery, "lowBatteryThreshold");
  return thresholds;
}

/**
 * Return timestamp gaps using the same strict threshold rule as anomaly
 * detection. The returned gaps are ordered by their boundary samples.
 */
export function getTimestampGaps(
  runOrSamples: TelemetryRun | readonly TelemetrySample[],
  options: TimestampGapOptions = {},
): TimestampGap[] {
  const samples = Array.isArray(runOrSamples)
    ? runOrSamples
    : (runOrSamples as TelemetryRun).samples;
  if (samples.length === 0) {
    return [];
  }

  const threshold = resolveTimestampGapThreshold(samples, options);
  if (samples.length < 2) {
    return [];
  }
  return timestampGapsAtThreshold(samples, threshold);
}

function timestampGapsAtThreshold(
  samples: readonly TelemetrySample[],
  threshold: number,
): TimestampGap[] {
  const gaps: TimestampGap[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }
    const duration = current.timestamp - previous.timestamp;
    if (duration > threshold) {
      gaps.push({
        startTimestamp: previous.timestamp,
        endTimestamp: current.timestamp,
        startSampleIndex: index - 1,
        endSampleIndex: index,
        duration,
        threshold,
      });
    }
  }
  return gaps;
}

function gapAtTimestamp(
  gaps: readonly TimestampGap[],
  timestamp: number,
): TimestampGap | undefined {
  let low = 0;
  let high = gaps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = gaps[middle];
    if (candidate !== undefined && candidate.endTimestamp <= timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const candidate = gaps[low];
  return candidate !== undefined &&
    timestamp > candidate.startTimestamp &&
    timestamp < candidate.endTimestamp
    ? candidate
    : undefined;
}

/**
 * Resolve replay telemetry without inventing motion inside timestamp gaps.
 * Before/after-range requests clamp like `sampleAtTimestamp`; an open gap
 * interval holds the last real sample and therefore preserves its timestamp.
 */
export function resolveTelemetrySample(
  samples: readonly TelemetrySample[],
  timestamp: number,
  gaps: readonly TimestampGap[] = getTimestampGaps(samples),
): ResolvedTelemetrySample {
  if (samples.length === 0) {
    throw new RangeError("cannot sample an empty telemetry series");
  }
  if (!Number.isFinite(timestamp)) {
    throw new RangeError("timestamp must be finite");
  }

  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    throw new RangeError("cannot sample an empty telemetry series");
  }
  if (timestamp < first.timestamp) {
    return { sample: cloneSample(first), status: "before-range" };
  }
  if (timestamp > last.timestamp) {
    return { sample: cloneSample(last), status: "after-range" };
  }

  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = samples[middle];
    if (candidate === undefined) {
      break;
    }
    if (candidate.timestamp === timestamp) {
      return { sample: cloneSample(candidate), status: "exact" };
    }
    if (candidate.timestamp < timestamp) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const from = samples[Math.max(0, high)];
  const to = samples[Math.min(samples.length - 1, low)];
  if (from === undefined || to === undefined || to.timestamp <= from.timestamp) {
    throw new RangeError("telemetry samples must be ordered by timestamp");
  }

  const gap = gapAtTimestamp(gaps, timestamp);
  if (gap !== undefined) {
    return { sample: cloneSample(from), status: "held-during-gap", gap };
  }
  return {
    sample: interpolateTelemetrySample(from, to, timestamp),
    status: "interpolated",
  };
}

function extremumBetween(
  samples: readonly TelemetrySample[],
  startIndex: number,
  endIndex: number,
  selector: (sample: TelemetrySample) => number,
  mode: "min" | "max",
): number {
  let result = mode === "min" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (let index = startIndex; index <= endIndex; index += 1) {
    const sample = samples[index];
    if (sample === undefined) {
      continue;
    }
    const value = selector(sample);
    result = mode === "min" ? Math.min(result, value) : Math.max(result, value);
  }
  return result;
}

function detectContiguousCondition(
  samples: readonly TelemetrySample[],
  predicate: (sample: TelemetrySample) => boolean,
  create: (
    start: TelemetrySample,
    end: TelemetrySample,
    startIndex: number,
    endIndex: number,
  ) => Anomaly,
): Anomaly[] {
  const anomalies: Anomaly[] = [];
  let startIndex: number | undefined;

  const finishEpisode = (endIndex: number): void => {
    if (startIndex === undefined) {
      return;
    }
    const start = samples[startIndex];
    const end = samples[endIndex];
    if (start !== undefined && end !== undefined) {
      anomalies.push(create(start, end, startIndex, endIndex));
    }
    startIndex = undefined;
  };

  samples.forEach((sample, index) => {
    if (predicate(sample)) {
      startIndex ??= index;
    } else if (startIndex !== undefined) {
      finishEpisode(index - 1);
    }
  });
  if (startIndex !== undefined) {
    finishEpisode(samples.length - 1);
  }
  return anomalies;
}

/** Detect the five supported telemetry integrity and operating anomalies. */
export function detectAnomalies(
  runOrSamples: TelemetryRun | readonly TelemetrySample[],
  options: AnomalyDetectionOptions = {},
): Anomaly[] {
  const samples = Array.isArray(runOrSamples)
    ? runOrSamples
    : (runOrSamples as TelemetryRun).samples;
  if (samples.length === 0) {
    return [];
  }
  const thresholds = resolveDetectionThresholds(samples, options);
  const anomalies: Anomaly[] = [];
  const timestampGaps = timestampGapsAtThreshold(samples, thresholds.timestampGap);
  let timestampGapIndex = 0;

  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous === undefined || current === undefined) {
      continue;
    }

    const interval = current.timestamp - previous.timestamp;
    const timestampGap = timestampGaps[timestampGapIndex];
    if (timestampGap?.endSampleIndex === index) {
      anomalies.push({
        id: anomalyId("timestamp-gap", current, index),
        type: "timestamp-gap",
        severity: "warning",
        timestamp: current.timestamp,
        title: "Timestamp gap",
        description: `Telemetry paused for ${interval.toFixed(3)} s.`,
        sampleIndex: index,
        details: {
          interval,
          threshold: thresholds.timestampGap,
          startTimestamp: timestampGap.startTimestamp,
          endTimestamp: timestampGap.endTimestamp,
        },
      });
      timestampGapIndex += 1;
    }

    const sequenceDelta = current.sequence - previous.sequence;
    if (sequenceDelta !== 1) {
      anomalies.push({
        id: anomalyId("sequence-gap", current, index),
        type: "sequence-gap",
        severity: sequenceDelta <= 0 ? "critical" : "warning",
        timestamp: current.timestamp,
        title: sequenceDelta <= 0 ? "Sequence regression" : "Sequence gap",
        description:
          sequenceDelta <= 0
            ? `Sequence moved from ${previous.sequence} to ${current.sequence}.`
            : `${sequenceDelta - 1} telemetry packet${sequenceDelta - 1 === 1 ? "" : "s"} missing.`,
        sampleIndex: index,
        details: {
          previousSequence: previous.sequence,
          currentSequence: current.sequence,
          missingPackets: Math.max(0, sequenceDelta - 1),
        },
      });
    }

    const distance = Math.hypot(current.pose.x - previous.pose.x, current.pose.y - previous.pose.y);
    const yawDelta = Math.abs(shortestYawDelta(previous.pose.yaw, current.pose.yaw));
    if (distance > thresholds.poseDistance || yawDelta > thresholds.poseYaw) {
      anomalies.push({
        id: anomalyId("pose-discontinuity", current, index),
        type: "pose-discontinuity",
        severity: "critical",
        timestamp: current.timestamp,
        title: "Pose discontinuity",
        description: `Pose jumped ${distance.toFixed(2)} m and ${((yawDelta * 180) / Math.PI).toFixed(1)} deg.`,
        sampleIndex: index,
        details: {
          distance,
          yawDelta,
          distanceThreshold: thresholds.poseDistance,
          yawThreshold: thresholds.poseYaw,
        },
      });
    }
  }

  const overcurrentAnomalies = detectContiguousCondition(
    samples,
    (sample) => Math.abs(sample.current) > thresholds.overcurrent,
    (start, end, index, endIndex) => ({
      id: anomalyId("overcurrent", start, index),
      type: "overcurrent",
      severity: "critical",
      timestamp: start.timestamp,
      endTimestamp: end.timestamp,
      title: "Motor overcurrent",
      description: `Motor current exceeded ${thresholds.overcurrent.toFixed(1)} A.`,
      sampleIndex: index,
      details: {
        threshold: thresholds.overcurrent,
        peakCurrent: extremumBetween(
          samples,
          index,
          endIndex,
          (sample) => Math.abs(sample.current),
          "max",
        ),
      },
    }),
  );
  for (const anomaly of overcurrentAnomalies) {
    anomalies.push(anomaly);
  }

  const lowBatteryAnomalies = detectContiguousCondition(
    samples,
    (sample) => sample.battery < thresholds.lowBattery,
    (start, end, index, endIndex) => ({
      id: anomalyId("low-battery", start, index),
      type: "low-battery",
      severity: "warning",
      timestamp: start.timestamp,
      endTimestamp: end.timestamp,
      title: "Low battery",
      description: `Battery charge fell below ${thresholds.lowBattery.toFixed(0)}%.`,
      sampleIndex: index,
      details: {
        threshold: thresholds.lowBattery,
        minimumBattery: extremumBetween(
          samples,
          index,
          endIndex,
          (sample) => sample.battery,
          "min",
        ),
      },
    }),
  );
  for (const anomaly of lowBatteryAnomalies) {
    anomalies.push(anomaly);
  }

  return anomalies.sort(
    (left, right) => left.timestamp - right.timestamp || left.type.localeCompare(right.type),
  );
}

export function getStateChanges(samples: readonly TelemetrySample[]): StateChange[] {
  const changes: StateChange[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1];
    const current = samples[index];
    if (previous !== undefined && current !== undefined && current.state !== previous.state) {
      changes.push({
        timestamp: current.timestamp,
        sampleIndex: index,
        from: previous.state,
        to: current.state,
      });
    }
  }
  return changes;
}

export function buildTimelineMarkers(
  run: TelemetryRun,
  anomalies: readonly Anomaly[] = detectAnomalies(run),
): TimelineMarker[] {
  const markers: TimelineMarker[] = anomalies.map((anomaly) => ({
    id: anomaly.id,
    type: anomaly.type,
    timestamp: anomaly.timestamp,
    label: anomaly.title,
    severity: anomaly.severity,
    sampleIndex: anomaly.sampleIndex,
  }));

  for (const change of getStateChanges(run.samples)) {
    markers.push({
      id: `state-change-${change.sampleIndex}`,
      type: "state-change",
      timestamp: change.timestamp,
      label: `${change.from} -> ${change.to}`,
      severity: "info",
      sampleIndex: change.sampleIndex,
    });
  }

  return markers.sort((left, right) => left.timestamp - right.timestamp);
}

function syntheticState(index: number, kind: RunKind): string {
  if (kind === "faulty" && index >= 176) {
    return "safe-stop";
  }
  if (index < 12) {
    return "standby";
  }
  if (index >= 105 && index < 130) {
    return "rerouting";
  }
  if (index >= 188) {
    return "inspection";
  }
  return "tracking";
}

/**
 * Generate a completely local, deterministic 20-second run. The faulty variant
 * intentionally contains one instance of each supported anomaly class.
 */
export function generateSyntheticRun(kind: RunKind = "normal"): TelemetryRun {
  const sampleRateHz = 10;
  const count = 201;
  const samples: TelemetrySample[] = [];
  let timestampOffset = 0;
  let sequenceOffset = 0;

  for (let index = 0; index < count; index += 1) {
    if (kind === "faulty" && index === 48) {
      timestampOffset += 0.8;
    }
    if (kind === "faulty" && index === 88) {
      sequenceOffset += 2;
    }

    const pathTime = index / sampleRateHz;
    const poseOffsetX = kind === "faulty" && index >= 118 ? 1.65 : 0;
    const poseOffsetY = kind === "faulty" && index >= 118 ? -0.9 : 0;
    const speed = index < 12 || index >= 196 ? 0 : 0.72 + 0.08 * Math.sin(pathTime * 0.72);
    const baseBattery = 92 - pathTime * 1.22;
    const battery = kind === "faulty" && index >= 166 ? 18.5 - (index - 166) * 0.075 : baseBattery;
    const current =
      kind === "faulty" && index >= 138 && index <= 148
        ? 23.4 + 1.6 * Math.sin((index - 138) * 0.7)
        : 7.1 + speed * 4.2 + 0.45 * Math.sin(pathTime * 1.8);

    samples.push({
      timestamp: Number((pathTime + timestampOffset).toFixed(3)),
      sequence: index + sequenceOffset,
      pose: {
        x: 0.38 * pathTime + 0.34 * Math.sin(pathTime * 0.42) + poseOffsetX,
        y: 1.15 * Math.sin(pathTime * 0.25) + poseOffsetY,
        yaw: normalizeYaw(0.34 * Math.sin(pathTime * 0.31) + 0.12 * pathTime),
      },
      speed,
      battery: Math.max(0, battery),
      current,
      state: syntheticState(index, kind),
    });
  }

  return {
    id: `synthetic-${kind}-run`,
    name: kind === "normal" ? "Nominal Traverse" : "Fault Injection Traverse",
    kind,
    description:
      kind === "normal"
        ? "Deterministic synthetic baseline run."
        : "Deterministic synthetic run containing controlled telemetry faults.",
    sampleRateHz,
    samples,
  };
}

export const generateSyntheticRuns = (): { normal: TelemetryRun; faulty: TelemetryRun } => ({
  normal: generateSyntheticRun("normal"),
  faulty: generateSyntheticRun("faulty"),
});
