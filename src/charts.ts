import type { TelemetryRun, TelemetrySample, TimestampGap } from "./core/types";

export type BuiltInTelemetryMetric =
  "speed" | "battery" | "current" | "pathError" | "latency" | "dataAge";
/** Built-in keys are suggested while custom, application-owned channels remain valid. */
export type TelemetryMetric = BuiltInTelemetryMetric | (string & {});
export type TelemetryGapDisplay = "connect" | "break";
export type TelemetryGapsByRun = ReadonlyMap<string, readonly TimestampGap[]>;

export interface TelemetryMetricContext {
  run: TelemetryRun;
  runIndex: number;
  sampleIndex: number;
}

export type TelemetryMetricAccessor = (
  sample: TelemetrySample,
  context: TelemetryMetricContext,
) => number | null | undefined;

export interface TelemetryMetricDomain {
  min?: number;
  max?: number;
  /** Defaults to true for non-battery built-ins and false for custom metrics. */
  includeZero?: boolean;
}

export interface TelemetryThresholdLine {
  value: number;
  label: string;
  color?: string;
  dashArray?: string;
}

export interface TelemetryThresholdBand {
  min: number;
  max: number;
  label: string;
  color?: string;
}

/**
 * A metric can use a built-in key, read an optional enriched sample field, or
 * derive a value through `accessor`. Accessors run once when chart data changes.
 */
export interface TelemetryMetricDefinition {
  key: TelemetryMetric;
  label?: string;
  unit?: string;
  decimals?: number;
  accessor?: TelemetryMetricAccessor;
  domain?: TelemetryMetricDomain;
  thresholds?: readonly TelemetryThresholdLine[];
  thresholdBands?: readonly TelemetryThresholdBand[];
}

export type TelemetryMetricInput = TelemetryMetric | TelemetryMetricDefinition;

export type TelemetryIncidentSeverity = "info" | "warning" | "critical";

export interface TelemetryIncidentWindow {
  id: string;
  label: string;
  startTimestamp: number;
  /** Omit for a point-in-time incident. */
  endTimestamp?: number;
  severity?: TelemetryIncidentSeverity;
  color?: string;
  /** When supplied, render the window only in the listed metric rows. */
  metricKeys?: readonly TelemetryMetric[];
}

export interface TelemetryChartsOptions {
  /** One or more runs rendered against the same time axis. */
  runs?: readonly TelemetryRun[];
  /** Convenience alternative to `runs` for the primary replay. */
  primaryRun?: TelemetryRun;
  /** Convenience alternative to `runs` for a side-by-side comparison. */
  comparisonRun?: TelemetryRun | null;
  selectedTimestamp?: number | null;
  onSelectTimestamp?: (timestamp: number) => void;
  /** Alias accepted for consumers that use noun-first callback names. */
  onTimestampSelect?: (timestamp: number) => void;
  className?: string;
  /** Timestamp gaps belonging to the primary (first) run. */
  gaps?: readonly TimestampGap[];
  /** Explicit per-run gaps; useful when both compared runs contain outages. */
  gapsByRun?: TelemetryGapsByRun;
  /** Connect samples across gaps by default, preserving the legacy chart behavior. */
  gapDisplay?: TelemetryGapDisplay;
  /** Override the run receiving `gaps`; `null` applies them to every run. */
  gapRunId?: string | null;
  /** Defaults to speed, battery and current. Strings resolve built-in definitions. */
  metrics?: readonly TelemetryMetricInput[];
  /** Alias for consumers that prefer an explicit configuration name. */
  metricDefinitions?: readonly TelemetryMetricInput[];
  incidents?: readonly TelemetryIncidentWindow[];
  selectedIncidentId?: string | null;
  onSelectIncident?: (incident: TelemetryIncidentWindow, timestamp: number) => void;
  /** Alias accepted for noun-first callback naming. */
  onIncidentSelect?: (incident: TelemetryIncidentWindow, timestamp: number) => void;
}

export interface TelemetryChartsUpdate {
  runs?: readonly TelemetryRun[];
  primaryRun?: TelemetryRun;
  comparisonRun?: TelemetryRun | null;
  selectedTimestamp?: number | null;
  gaps?: readonly TimestampGap[];
  gapsByRun?: TelemetryGapsByRun;
  gapDisplay?: TelemetryGapDisplay;
  gapRunId?: string | null;
  metrics?: readonly TelemetryMetricInput[];
  metricDefinitions?: readonly TelemetryMetricInput[];
  incidents?: readonly TelemetryIncidentWindow[];
  selectedIncidentId?: string | null;
}

export interface TelemetryChartController {
  readonly element: HTMLElement;
  setRuns(runs: readonly TelemetryRun[]): void;
  setData(primaryRun: TelemetryRun, comparisonRun?: TelemetryRun | null): void;
  setGaps(
    gaps: readonly TimestampGap[],
    gapDisplay?: TelemetryGapDisplay,
    gapRunId?: string | null,
  ): void;
  setGapsByRun(gapsByRun: TelemetryGapsByRun, gapDisplay?: TelemetryGapDisplay): void;
  setMetrics(metrics: readonly TelemetryMetricInput[]): void;
  setIncidents(incidents: readonly TelemetryIncidentWindow[]): void;
  setSelectedIncident(incidentId: string | null): void;
  setSelectedTimestamp(timestamp: number | null): void;
  getSelectedTimestamp(): number | null;
  update(next: TelemetryChartsUpdate): void;
  resize(): void;
  destroy(): void;
}

interface ResolvedMetricDefinition {
  key: TelemetryMetric;
  label: string;
  unit: string;
  decimals: number;
  accessor: TelemetryMetricAccessor;
  domain?: TelemetryMetricDomain;
  thresholds: readonly TelemetryThresholdLine[];
  thresholdBands: readonly TelemetryThresholdBand[];
}

interface NumericDomain {
  min: number;
  max: number;
}

interface RunSeries {
  run: TelemetryRun;
  samples: readonly TelemetrySample[];
  color: string;
  dashed: boolean;
  metrics: Map<TelemetryMetric, MetricSeries>;
}

interface MetricPoint {
  timestamp: number;
  value: number;
  inputIndex: number;
  breakBefore: boolean;
}

interface MetricSeries {
  points: readonly MetricPoint[];
  domain: NumericDomain | null;
}

interface NormalizedGap {
  startTimestamp: number;
  endTimestamp: number;
}

interface ChartLayout {
  width: number;
  height: number;
  plotLeft: number;
  plotRight: number;
  plotWidth: number;
  top: number;
  rowHeight: number;
  plotHeight: number;
  horizontalTicks: number;
}

interface NormalizedIncidentWindow extends TelemetryIncidentWindow {
  endTimestamp: number;
}

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const DEFAULT_VIEW_WIDTH = 960;
const MIN_VIEW_WIDTH = 280;
const DESKTOP_PLOT_LEFT = 74;
const COMPACT_PLOT_LEFT = 58;
const DESKTOP_PLOT_RIGHT = 22;
const COMPACT_PLOT_RIGHT = 10;
const DESKTOP_TOP = 44;
const COMPACT_TOP = 64;
const ROW_HEIGHT = 58;
const PLOT_HEIGHT = 42;
const BOTTOM = 22;
const VERTICAL_TICKS = 2;
const MAX_CACHED_POINTS_PER_SERIES = 4_096;
const MAX_RENDERED_INCIDENT_WINDOWS = 200;

const DEFAULT_METRIC_KEYS: readonly BuiltInTelemetryMetric[] = ["speed", "battery", "current"];
const BUILT_IN_METRICS: Readonly<Record<BuiltInTelemetryMetric, TelemetryMetricDefinition>> = {
  speed: {
    key: "speed",
    label: "Speed",
    unit: "m/s",
    decimals: 2,
    domain: { includeZero: true },
  },
  battery: {
    key: "battery",
    label: "Battery",
    unit: "%",
    decimals: 1,
    domain: { includeZero: false },
  },
  current: {
    key: "current",
    label: "Current",
    unit: "A",
    decimals: 1,
    domain: { includeZero: true },
  },
  pathError: {
    key: "pathError",
    label: "Path error",
    unit: "m",
    decimals: 2,
    domain: { includeZero: true },
  },
  latency: {
    key: "latency",
    label: "Link latency",
    unit: "ms",
    decimals: 0,
    domain: { includeZero: true },
  },
  dataAge: {
    key: "dataAge",
    label: "Data age",
    unit: "ms",
    decimals: 0,
    domain: { includeZero: true },
  },
};

const SERIES_COLORS = ["#f05a1a", "#55a9d6", "#ffffff", "#b58ad8"] as const;
let chartInstanceId = 0;

function createSvgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string | number | undefined>> = {},
  text?: string,
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    if (value !== undefined) {
      element.setAttribute(attribute, String(value));
    }
  }
  if (text !== undefined) {
    element.textContent = text;
  }
  return element;
}

function finite(value: number): boolean {
  return Number.isFinite(value);
}

function numericSampleField(sample: TelemetrySample, keys: readonly string[]): number | null {
  const record = sample as unknown as Readonly<Record<string, unknown>>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && finite(value)) {
      return value;
    }
  }
  return null;
}

function builtInAccessor(key: TelemetryMetric): TelemetryMetricAccessor {
  const aliases: Readonly<Record<BuiltInTelemetryMetric, readonly string[]>> = {
    speed: ["speed"],
    battery: ["battery"],
    current: ["current"],
    pathError: ["pathError", "crossTrackError", "crossTrackErrorM", "routeError"],
    latency: ["latencyMs", "linkLatencyMs", "latency"],
    dataAge: ["dataAgeMs", "telemetryAgeMs", "dataAge"],
  };
  const fields = aliases[key as BuiltInTelemetryMetric] ?? [key];
  return (sample) => numericSampleField(sample, fields);
}

function humanizeMetricKey(key: string): string {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.length === 0 ? "Metric" : `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

function resolveMetricDefinitions(
  inputs: readonly TelemetryMetricInput[] | undefined,
): readonly ResolvedMetricDefinition[] {
  const selected = inputs ?? DEFAULT_METRIC_KEYS;
  const resolved = new Map<TelemetryMetric, ResolvedMetricDefinition>();

  for (const input of selected) {
    const supplied: TelemetryMetricDefinition = typeof input === "string" ? { key: input } : input;
    const builtIn = BUILT_IN_METRICS[supplied.key as BuiltInTelemetryMetric];
    const key = supplied.key;
    const definition: ResolvedMetricDefinition = {
      key,
      label: supplied.label ?? builtIn?.label ?? humanizeMetricKey(key),
      unit: supplied.unit ?? builtIn?.unit ?? "",
      decimals: Math.max(0, Math.min(6, supplied.decimals ?? builtIn?.decimals ?? 2)),
      accessor: supplied.accessor ?? builtIn?.accessor ?? builtInAccessor(key),
      domain: supplied.domain ?? builtIn?.domain,
      thresholds: (supplied.thresholds ?? builtIn?.thresholds ?? []).filter((threshold) =>
        finite(threshold.value),
      ),
      thresholdBands: (supplied.thresholdBands ?? builtIn?.thresholdBands ?? []).filter(
        (band) => finite(band.min) && finite(band.max) && band.max > band.min,
      ),
    };
    resolved.set(key, definition);
  }

  return [...resolved.values()];
}

function safeMetricValue(
  metric: ResolvedMetricDefinition,
  sample: TelemetrySample,
  context: TelemetryMetricContext,
): number | null {
  try {
    const value = metric.accessor(sample, context);
    return typeof value === "number" && finite(value) ? value : null;
  } catch {
    return null;
  }
}

function orderedSamples(run: TelemetryRun): readonly TelemetrySample[] {
  return [...run.samples]
    .filter((sample) => finite(sample.timestamp))
    .sort((left, right) => left.timestamp - right.timestamp);
}

function resolveRuns(options: TelemetryChartsOptions): readonly TelemetryRun[] {
  if (options.runs !== undefined) {
    return options.runs;
  }

  return [options.primaryRun, options.comparisonRun].filter(
    (run): run is TelemetryRun => run !== undefined && run !== null,
  );
}

function runColor(run: TelemetryRun, index: number): string {
  const kind = String(run.kind).toLowerCase();
  if (kind.includes("fault") || kind.includes("incident")) {
    return "#f05a1a";
  }
  if (kind.includes("normal") || kind.includes("baseline")) {
    return "#55a9d6";
  }
  return SERIES_COLORS[index % SERIES_COLORS.length] ?? SERIES_COLORS[0];
}

function seriesForRuns(runs: readonly TelemetryRun[]): readonly RunSeries[] {
  return runs.map((run, index) => ({
    run,
    samples: orderedSamples(run),
    color: runColor(run, index),
    dashed: index > 0 && !String(run.kind).toLowerCase().includes("fault"),
    metrics: new Map(),
  }));
}

function timestampDomain(series: readonly RunSeries[]): NumericDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const item of series) {
    for (const sample of item.samples) {
      if (sample.timestamp < min) {
        min = sample.timestamp;
      }
      if (sample.timestamp > max) {
        max = sample.timestamp;
      }
    }
  }

  if (!finite(min) || !finite(max)) {
    return { min: 0, max: 1 };
  }
  if (min === max) {
    return { min, max: min + 1 };
  }
  return { min, max };
}

interface MetricCacheBucket {
  minimum: MetricPoint;
  maximum: MetricPoint;
  containsBreak: boolean;
}

function cacheMetricSeries(
  item: RunSeries,
  runIndex: number,
  metric: ResolvedMetricDefinition,
  time: NumericDomain,
): MetricSeries {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  const bucketCount = Math.max(1, Math.floor(MAX_CACHED_POINTS_PER_SERIES / 2));
  const buckets = new Map<number, MetricCacheBucket>();
  let pendingBreak = false;

  for (const [sampleIndex, sample] of item.samples.entries()) {
    const value = safeMetricValue(metric, sample, { run: item.run, runIndex, sampleIndex });
    if (value === null) {
      pendingBreak = true;
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
    const ratio = (sample.timestamp - time.min) / (time.max - time.min);
    const bucketIndex = Math.floor(clamp(ratio * bucketCount, 0, bucketCount - 1));
    const point: MetricPoint = {
      timestamp: sample.timestamp,
      value,
      inputIndex: sampleIndex,
      breakBefore: pendingBreak,
    };
    const bucket = buckets.get(bucketIndex);
    if (bucket === undefined) {
      buckets.set(bucketIndex, {
        minimum: point,
        maximum: point,
        containsBreak: pendingBreak,
      });
    } else {
      if (value < bucket.minimum.value) {
        bucket.minimum = point;
      }
      if (value > bucket.maximum.value) {
        bucket.maximum = point;
      }
      bucket.containsBreak ||= pendingBreak;
    }
    pendingBreak = false;
  }

  const points: MetricPoint[] = [];
  for (const bucket of buckets.values()) {
    const selected =
      bucket.minimum === bucket.maximum
        ? [bucket.minimum]
        : [bucket.minimum, bucket.maximum].sort(
            (left, right) => left.inputIndex - right.inputIndex,
          );
    for (const point of selected) {
      points.push({ ...point, breakBefore: point.breakBefore || bucket.containsBreak });
    }
  }
  return {
    points,
    domain: finite(min) && finite(max) ? { min, max } : null,
  };
}

function metricDomain(
  series: readonly RunSeries[],
  metric: ResolvedMetricDefinition,
): NumericDomain {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const item of series) {
    const domain = item.metrics.get(metric.key)?.domain;
    if (domain !== null && domain !== undefined) {
      min = Math.min(min, domain.min);
      max = Math.max(max, domain.max);
    }
  }
  for (const threshold of metric.thresholds) {
    min = Math.min(min, threshold.value);
    max = Math.max(max, threshold.value);
  }
  for (const band of metric.thresholdBands) {
    min = Math.min(min, band.min);
    max = Math.max(max, band.max);
  }

  const configured = metric.domain;
  if (!finite(min) || !finite(max)) {
    min = configured?.min ?? 0;
    max = configured?.max ?? (metric.key === "battery" ? 100 : 1);
  }
  if (configured?.includeZero === true) {
    min = Math.min(min, 0);
    max = Math.max(max, 0);
  }

  const span = max - min;
  const padding = span > 0 ? span * 0.12 : Math.max(Math.abs(max) * 0.08, 0.5);

  if (metric.key === "battery") {
    min = Math.max(0, min - Math.max(padding, 0.5));
    max = Math.min(100, max + Math.max(padding, 0.5));
  } else {
    min = configured?.includeZero === true && min >= 0 ? 0 : min - padding;
    max += padding;
  }

  min = configured?.min ?? min;
  max = configured?.max ?? max;

  if (max <= min) {
    max = min + 1;
  }
  return { min, max };
}

function normalizeGaps(gaps: readonly TimestampGap[]): readonly NormalizedGap[] {
  const normalized = gaps
    .filter(
      (gap) =>
        finite(gap.startTimestamp) &&
        finite(gap.endTimestamp) &&
        gap.endTimestamp > gap.startTimestamp,
    )
    .map((gap) => ({
      startTimestamp: gap.startTimestamp,
      endTimestamp: gap.endTimestamp,
    }))
    .sort((left, right) => left.startTimestamp - right.startTimestamp);

  const merged: NormalizedGap[] = [];
  for (const gap of normalized) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && gap.startTimestamp <= previous.endTimestamp) {
      previous.endTimestamp = Math.max(previous.endTimestamp, gap.endTimestamp);
    } else {
      merged.push({ ...gap });
    }
  }
  return merged;
}

function normalizeGapsByRun(
  gapsByRun: TelemetryGapsByRun | undefined,
): ReadonlyMap<string, readonly NormalizedGap[]> {
  const normalized = new Map<string, readonly NormalizedGap[]>();
  if (gapsByRun === undefined) {
    return normalized;
  }
  for (const [runId, gaps] of gapsByRun) {
    normalized.set(runId, normalizeGaps(gaps));
  }
  return normalized;
}

function mergeNormalizedGaps(groups: Iterable<readonly NormalizedGap[]>): readonly NormalizedGap[] {
  const all: NormalizedGap[] = [];
  for (const gaps of groups) {
    for (const gap of gaps) {
      all.push({ ...gap });
    }
  }
  all.sort((left, right) => left.startTimestamp - right.startTimestamp);
  const merged: NormalizedGap[] = [];
  for (const gap of all) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && gap.startTimestamp <= previous.endTimestamp) {
      previous.endTimestamp = Math.max(previous.endTimestamp, gap.endTimestamp);
    } else {
      merged.push(gap);
    }
  }
  return merged;
}

function normalizeIncidents(
  incidents: readonly TelemetryIncidentWindow[] | undefined,
): readonly NormalizedIncidentWindow[] {
  return (incidents ?? [])
    .filter(
      (incident) =>
        incident.id.length > 0 &&
        finite(incident.startTimestamp) &&
        (incident.endTimestamp === undefined || finite(incident.endTimestamp)),
    )
    .map((incident) => ({
      ...incident,
      endTimestamp: Math.max(
        incident.startTimestamp,
        incident.endTimestamp ?? incident.startTimestamp,
      ),
    }))
    .sort(
      (left, right) =>
        left.startTimestamp - right.startTimestamp ||
        left.endTimestamp - right.endTimestamp ||
        left.id.localeCompare(right.id),
    );
}

function scale(value: number, domain: NumericDomain, start: number, end: number): number {
  return start + ((value - domain.min) / (domain.max - domain.min)) * (end - start);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function timestampInsideGap(timestamp: number, gaps: readonly NormalizedGap[]): boolean {
  let low = 0;
  let high = gaps.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const gap = gaps[middle];
    if (gap !== undefined && gap.endTimestamp <= timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const candidate = gaps[low];
  return (
    candidate !== undefined &&
    timestamp > candidate.startTimestamp &&
    timestamp < candidate.endTimestamp
  );
}

function gapSeparates(
  beforeTimestamp: number,
  afterTimestamp: number,
  gaps: readonly NormalizedGap[],
): boolean {
  for (const gap of gaps) {
    if (gap.endTimestamp <= beforeTimestamp) {
      continue;
    }
    if (gap.startTimestamp >= afterTimestamp) {
      return false;
    }
    return gap.startTimestamp < afterTimestamp && gap.endTimestamp > beforeTimestamp;
  }
  return false;
}

function appendBucket(
  path: string,
  bucket: readonly MetricPoint[],
  time: NumericDomain,
  values: NumericDomain,
  layout: ChartLayout,
  top: number,
  move: boolean,
): { path: string; move: boolean } {
  if (bucket.length === 0) {
    return { path, move };
  }

  let minimum = bucket[0];
  let maximum = bucket[0];
  for (const point of bucket) {
    if (minimum === undefined || point.value < minimum.value) {
      minimum = point;
    }
    if (maximum === undefined || point.value > maximum.value) {
      maximum = point;
    }
  }

  const selected =
    minimum === maximum
      ? minimum === undefined
        ? []
        : [minimum]
      : [minimum, maximum]
          .filter((point): point is MetricPoint => point !== undefined)
          .sort((left, right) => left.inputIndex - right.inputIndex);

  let nextPath = path;
  let shouldMove = move;
  const bucketContainsBreak = bucket.some((point) => point.breakBefore);
  for (const point of selected) {
    shouldMove ||= bucketContainsBreak || point.breakBefore;
    const x = scale(point.timestamp, time, layout.plotLeft, layout.width - layout.plotRight);
    const y = scale(point.value, values, top + layout.plotHeight, top);
    nextPath += `${shouldMove ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    shouldMove = false;
  }
  return { path: nextPath, move: shouldMove };
}

/**
 * Min/max sampling retains narrow spikes while bounding each series to roughly
 * two SVG points per horizontal plot pixel.
 */
function linePath(
  points: readonly MetricPoint[],
  time: NumericDomain,
  values: NumericDomain,
  layout: ChartLayout,
  top: number,
  gaps: readonly NormalizedGap[],
): string {
  let result = "";
  let bucket: MetricPoint[] = [];
  let bucketIndex = -1;
  let inputIndex = 0;
  let move = true;
  let previousTimestamp: number | null = null;

  const flush = (): void => {
    const appended = appendBucket(result, bucket, time, values, layout, top, move);
    result = appended.path;
    move = appended.move;
    bucket = [];
    bucketIndex = -1;
  };

  for (const point of points) {
    const unavailable = timestampInsideGap(point.timestamp, gaps);
    const separated =
      point.breakBefore ||
      (previousTimestamp !== null && gapSeparates(previousTimestamp, point.timestamp, gaps));

    if (unavailable || separated) {
      flush();
      move = true;
      previousTimestamp = unavailable ? null : point.timestamp;
      if (unavailable) {
        inputIndex += 1;
        continue;
      }
    }

    const x = scale(point.timestamp, time, 0, layout.plotWidth);
    const nextBucketIndex = Math.floor(clamp(x, 0, layout.plotWidth - 0.001));
    if (bucket.length > 0 && nextBucketIndex !== bucketIndex) {
      flush();
    }
    bucketIndex = nextBucketIndex;
    bucket.push({ ...point, inputIndex });
    previousTimestamp = point.timestamp;
    inputIndex += 1;
  }
  flush();
  return result;
}

function interpolatedMetric(
  item: RunSeries,
  runIndex: number,
  metric: ResolvedMetricDefinition,
  timestamp: number,
  gaps: readonly NormalizedGap[] = [],
): number | null {
  const samples = item.samples;
  if (samples.length === 0 || timestampInsideGap(timestamp, gaps)) {
    return null;
  }
  const first = samples[0];
  const last = samples[samples.length - 1];
  if (first === undefined || last === undefined) {
    return null;
  }
  if (timestamp <= first.timestamp) {
    return safeMetricValue(metric, first, { run: item.run, runIndex, sampleIndex: 0 });
  }
  if (timestamp >= last.timestamp) {
    return safeMetricValue(metric, last, {
      run: item.run,
      runIndex,
      sampleIndex: samples.length - 1,
    });
  }

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
    if (sample !== undefined && sample.timestamp <= timestamp) {
      low = middle;
    } else {
      high = middle;
    }
  }

  const before = samples[low];
  const after = samples[high];
  if (before === undefined || after === undefined) {
    return null;
  }
  const beforeValue = safeMetricValue(metric, before, {
    run: item.run,
    runIndex,
    sampleIndex: low,
  });
  const afterValue = safeMetricValue(metric, after, {
    run: item.run,
    runIndex,
    sampleIndex: high,
  });
  if (beforeValue === null || afterValue === null) {
    return null;
  }
  const interval = after.timestamp - before.timestamp;
  const ratio = interval === 0 ? 0 : (timestamp - before.timestamp) / interval;
  return beforeValue + (afterValue - beforeValue) * ratio;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  values.sort((left, right) => left - right);
  const middle = Math.floor(values.length / 2);
  const upper = values[middle] ?? 0;
  if (values.length % 2 === 1) {
    return upper;
  }
  return ((values[middle - 1] ?? upper) + upper) / 2;
}

function nominalInterval(series: readonly RunSeries[], time: NumericDomain): number {
  const primary = series[0];
  if (primary !== undefined) {
    const intervals: number[] = [];
    const stride = Math.max(1, Math.ceil((primary.samples.length - 1) / 2_048));
    for (let index = 1; index < primary.samples.length; index += stride) {
      const previous = primary.samples[index - 1];
      const current = primary.samples[index];
      if (previous === undefined || current === undefined) {
        continue;
      }
      const interval = current.timestamp - previous.timestamp;
      if (finite(interval) && interval > 0) {
        intervals.push(interval);
      }
    }
    const detected = median(intervals);
    if (detected > 0) {
      return detected;
    }
    if (primary.run.sampleRateHz !== undefined && primary.run.sampleRateHz > 0) {
      return 1 / primary.run.sampleRateHz;
    }
  }
  return Math.max((time.max - time.min) / 100, 0.001);
}

function layoutForWidth(measuredWidth: number, metricCount: number): ChartLayout {
  const width = Math.max(MIN_VIEW_WIDTH, Math.round(measuredWidth));
  const compact = width < 520;
  const plotLeft = compact ? COMPACT_PLOT_LEFT : DESKTOP_PLOT_LEFT;
  const plotRight = compact ? COMPACT_PLOT_RIGHT : DESKTOP_PLOT_RIGHT;
  const top = compact ? COMPACT_TOP : DESKTOP_TOP;
  return {
    width,
    height: top + ROW_HEIGHT * Math.max(metricCount, 1) + BOTTOM,
    plotLeft,
    plotRight,
    plotWidth: width - plotLeft - plotRight,
    top,
    rowHeight: ROW_HEIGHT,
    plotHeight: PLOT_HEIGHT,
    horizontalTicks: width < 390 ? 3 : width < 700 ? 4 : 6,
  };
}

function formatValue(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

function formatElapsed(timestamp: number, domain: NumericDomain): string {
  const elapsed = timestamp - domain.min;
  const duration = domain.max - domain.min;
  if (duration >= 600) {
    const minutes = Math.floor(elapsed / 60);
    return `${minutes}:${Math.round(elapsed % 60)
      .toString()
      .padStart(2, "0")}`;
  }
  if (duration >= 60) {
    return `${elapsed.toFixed(0)}s`;
  }
  return `${elapsed.toFixed(duration <= 10 ? 1 : 0)}s`;
}

function visibleRunName(run: TelemetryRun): string {
  const name = run.name.trim();
  return name.length > 0 ? name : run.id;
}

export class TelemetryCharts implements TelemetryChartController {
  readonly element: HTMLElement;

  private readonly svg: SVGSVGElement;
  private readonly staticLayer: SVGGElement;
  private readonly cursorLayer: SVGGElement;
  private readonly interactionLayer: SVGRectElement;
  private readonly cursorControl: HTMLInputElement;
  private readonly description: SVGDescElement;
  private readonly patternId: string;
  private readonly container: HTMLElement;
  private runs: readonly TelemetryRun[];
  private series: readonly RunSeries[] = [];
  private gaps: readonly NormalizedGap[];
  private gapsByRun: ReadonlyMap<string, readonly NormalizedGap[]>;
  private bandGaps: readonly NormalizedGap[];
  private gapDisplay: TelemetryGapDisplay;
  private gapRunId: string | null | undefined;
  private metrics: readonly ResolvedMetricDefinition[] = resolveMetricDefinitions(undefined);
  private incidents: readonly NormalizedIncidentWindow[] = [];
  private selectedIncidentId: string | null = null;
  private time: NumericDomain = { min: 0, max: 1 };
  private readonly metricDomains = new Map<TelemetryMetric, NumericDomain>();
  private sampleInterval = 0.01;
  private layout = layoutForWidth(DEFAULT_VIEW_WIDTH, this.metrics.length);
  private selectedTimestamp: number | null;
  private readonly onTimestampSelected?: (timestamp: number) => void;
  private readonly onIncidentSelected?: (
    incident: TelemetryIncidentWindow,
    timestamp: number,
  ) => void;
  private readonly resizeObserver: ResizeObserver | null;
  private destroyed = false;

  constructor(container: HTMLElement, options: TelemetryChartsOptions = {}) {
    this.container = container;
    this.runs = resolveRuns(options);
    this.gaps = normalizeGaps(options.gaps ?? []);
    this.gapsByRun = normalizeGapsByRun(options.gapsByRun);
    this.bandGaps = mergeNormalizedGaps([this.gaps, ...this.gapsByRun.values()]);
    this.gapDisplay = options.gapDisplay ?? "connect";
    this.gapRunId = options.gapRunId;
    this.metrics = resolveMetricDefinitions(options.metrics ?? options.metricDefinitions);
    this.incidents = normalizeIncidents(options.incidents);
    this.selectedIncidentId = options.selectedIncidentId ?? null;
    this.selectedTimestamp = options.selectedTimestamp ?? null;
    this.onTimestampSelected = options.onSelectTimestamp ?? options.onTimestampSelect;
    this.onIncidentSelected = options.onSelectIncident ?? options.onIncidentSelect;
    this.layout = layoutForWidth(DEFAULT_VIEW_WIDTH, this.metrics.length);

    const instanceId = ++chartInstanceId;
    const titleId = `telemetry-charts-title-${instanceId}`;
    const descriptionId = `telemetry-charts-description-${instanceId}`;
    this.patternId = `telemetry-gap-pattern-${instanceId}`;

    this.element = document.createElement("div");
    this.element.className = ["telemetry-charts", options.className]
      .filter((name): name is string => Boolean(name))
      .join(" ");
    this.element.style.minWidth = "0";
    this.element.style.position = "relative";

    this.svg = createSvgElement("svg", {
      class: "telemetry-charts__svg",
      viewBox: `0 0 ${this.layout.width} ${this.layout.height}`,
      preserveAspectRatio: "xMinYMin meet",
      role: "img",
      "aria-labelledby": `${titleId} ${descriptionId}`,
      focusable: "false",
    });
    this.svg.style.display = "block";
    this.svg.style.width = "100%";
    this.svg.style.height = `${this.layout.height}px`;
    this.description = createSvgElement("desc", { id: descriptionId });
    this.svg.append(
      createSvgElement("title", { id: titleId }, "Robot telemetry comparison"),
      this.description,
    );
    this.renderDefinitions();

    this.staticLayer = createSvgElement("g", { class: "telemetry-charts__static" });
    this.cursorLayer = createSvgElement("g", { class: "telemetry-charts__cursor" });
    this.interactionLayer = createSvgElement("rect", {
      class: "telemetry-charts__interaction",
      fill: "transparent",
      cursor: "crosshair",
      "pointer-events": "all",
      "aria-hidden": "true",
    });
    this.svg.append(this.staticLayer, this.cursorLayer, this.interactionLayer);
    this.svg.addEventListener("pointerdown", this.handlePointer);
    this.svg.addEventListener("pointermove", this.handlePointerMove);

    this.cursorControl = document.createElement("input");
    this.cursorControl.type = "range";
    this.cursorControl.className = "telemetry-charts__cursor-control";
    this.cursorControl.setAttribute("aria-label", "Telemetry chart time cursor");
    this.cursorControl.setAttribute("aria-describedby", descriptionId);
    this.cursorControl.setAttribute("aria-orientation", "horizontal");
    // Retain native slider semantics without a second, unexplained visual timeline.
    this.cursorControl.style.position = "absolute";
    this.cursorControl.style.top = "0";
    this.cursorControl.style.left = "0";
    this.cursorControl.style.width = "1px";
    this.cursorControl.style.height = "1px";
    this.cursorControl.style.margin = "-1px";
    this.cursorControl.style.padding = "0";
    this.cursorControl.style.border = "0";
    this.cursorControl.style.opacity = "0";
    this.cursorControl.style.clipPath = "inset(50%)";
    this.cursorControl.style.overflow = "hidden";
    this.cursorControl.addEventListener("input", this.handleRangeInput);
    this.cursorControl.addEventListener("keydown", this.handleRangeKeydown);
    this.cursorControl.addEventListener("focus", this.handleCursorFocus);
    this.cursorControl.addEventListener("blur", this.handleCursorBlur);

    this.element.append(this.svg, this.cursorControl);
    container.append(this.element);

    this.resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(container);
    this.rebuildData();
    this.resize(true);
  }

  setRuns(runs: readonly TelemetryRun[]): void {
    this.runs = runs;
    this.rebuildData();
    this.renderStatic();
    this.renderCursor();
  }

  setData(primaryRun: TelemetryRun, comparisonRun: TelemetryRun | null = null): void {
    this.setRuns(comparisonRun === null ? [primaryRun] : [primaryRun, comparisonRun]);
  }

  setGaps(
    gaps: readonly TimestampGap[],
    gapDisplay: TelemetryGapDisplay = this.gapDisplay,
    gapRunId: string | null | undefined = this.gapRunId,
  ): void {
    this.gaps = normalizeGaps(gaps);
    this.gapDisplay = gapDisplay;
    this.gapRunId = gapRunId;
    this.rebuildBandGaps();
    this.renderStatic();
    this.renderCursor();
  }

  setGapsByRun(
    gapsByRun: TelemetryGapsByRun,
    gapDisplay: TelemetryGapDisplay = this.gapDisplay,
  ): void {
    this.gapsByRun = normalizeGapsByRun(gapsByRun);
    this.gapDisplay = gapDisplay;
    this.rebuildBandGaps();
    this.renderStatic();
    this.renderCursor();
  }

  setMetrics(metrics: readonly TelemetryMetricInput[]): void {
    this.metrics = resolveMetricDefinitions(metrics);
    this.layout = layoutForWidth(this.layout.width, this.metrics.length);
    this.svg.setAttribute("viewBox", `0 0 ${this.layout.width} ${this.layout.height}`);
    this.svg.style.height = `${this.layout.height}px`;
    this.rebuildData();
    this.renderStatic();
    this.renderCursor();
  }

  setIncidents(incidents: readonly TelemetryIncidentWindow[]): void {
    this.incidents = normalizeIncidents(incidents);
    if (
      this.selectedIncidentId !== null &&
      !this.incidents.some((incident) => incident.id === this.selectedIncidentId)
    ) {
      this.selectedIncidentId = null;
    }
    this.updateAccessibleDescription();
    this.renderStatic();
    this.renderCursor();
  }

  setSelectedIncident(incidentId: string | null): void {
    this.selectedIncidentId = incidentId;
    this.renderStatic();
    this.renderCursor();
  }

  setSelectedTimestamp(timestamp: number | null): void {
    this.selectedTimestamp = timestamp !== null && finite(timestamp) ? timestamp : null;
    this.renderCursor();
  }

  getSelectedTimestamp(): number | null {
    return this.selectedTimestamp;
  }

  update(next: TelemetryChartsUpdate): void {
    let dataChanged = false;
    let staticChanged = false;
    let gapsChanged = false;
    if (next.runs !== undefined) {
      this.runs = next.runs;
      dataChanged = true;
    } else if (next.primaryRun !== undefined || next.comparisonRun !== undefined) {
      const primary = next.primaryRun ?? this.runs[0];
      const comparison = next.comparisonRun === undefined ? this.runs[1] : next.comparisonRun;
      this.runs = [primary, comparison].filter(
        (run): run is TelemetryRun => run !== undefined && run !== null,
      );
      dataChanged = true;
    }
    if (next.gaps !== undefined) {
      this.gaps = normalizeGaps(next.gaps);
      staticChanged = true;
      gapsChanged = true;
    }
    if (next.gapsByRun !== undefined) {
      this.gapsByRun = normalizeGapsByRun(next.gapsByRun);
      staticChanged = true;
      gapsChanged = true;
    }
    if (next.gapDisplay !== undefined && next.gapDisplay !== this.gapDisplay) {
      this.gapDisplay = next.gapDisplay;
      staticChanged = true;
    }
    if (next.gapRunId !== undefined && next.gapRunId !== this.gapRunId) {
      this.gapRunId = next.gapRunId;
      staticChanged = true;
    }
    const metricInputs = next.metrics ?? next.metricDefinitions;
    if (metricInputs !== undefined) {
      this.metrics = resolveMetricDefinitions(metricInputs);
      this.layout = layoutForWidth(this.layout.width, this.metrics.length);
      this.svg.setAttribute("viewBox", `0 0 ${this.layout.width} ${this.layout.height}`);
      this.svg.style.height = `${this.layout.height}px`;
      dataChanged = true;
    }
    if (next.incidents !== undefined) {
      this.incidents = normalizeIncidents(next.incidents);
      if (
        this.selectedIncidentId !== null &&
        !this.incidents.some((incident) => incident.id === this.selectedIncidentId)
      ) {
        this.selectedIncidentId = null;
      }
      this.updateAccessibleDescription();
      staticChanged = true;
    }
    if (next.selectedIncidentId !== undefined) {
      this.selectedIncidentId = next.selectedIncidentId;
      staticChanged = true;
    }
    if (next.selectedTimestamp !== undefined) {
      this.selectedTimestamp =
        next.selectedTimestamp !== null && finite(next.selectedTimestamp)
          ? next.selectedTimestamp
          : null;
    }
    if (dataChanged) {
      this.rebuildData();
      staticChanged = true;
    }
    if (gapsChanged) {
      this.rebuildBandGaps();
    }
    if (staticChanged) {
      this.renderStatic();
    }
    this.renderCursor();
  }

  resize(force = false): void {
    if (this.destroyed) {
      return;
    }
    const measured =
      this.element.getBoundingClientRect().width ||
      this.element.clientWidth ||
      this.container.getBoundingClientRect().width ||
      this.container.clientWidth ||
      DEFAULT_VIEW_WIDTH;
    const next = layoutForWidth(measured, this.metrics.length);
    if (!force && next.width === this.layout.width) {
      return;
    }
    this.layout = next;
    this.svg.setAttribute("viewBox", `0 0 ${next.width} ${next.height}`);
    this.svg.style.height = `${next.height}px`;
    this.renderStatic();
    this.renderCursor();
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.svg.removeEventListener("pointerdown", this.handlePointer);
    this.svg.removeEventListener("pointermove", this.handlePointerMove);
    this.cursorControl.removeEventListener("input", this.handleRangeInput);
    this.cursorControl.removeEventListener("keydown", this.handleRangeKeydown);
    this.cursorControl.removeEventListener("focus", this.handleCursorFocus);
    this.cursorControl.removeEventListener("blur", this.handleCursorBlur);
    this.element.remove();
  }

  private rebuildData(): void {
    this.series = seriesForRuns(this.runs);
    this.time = timestampDomain(this.series);
    this.metricDomains.clear();
    for (const [runIndex, item] of this.series.entries()) {
      for (const metric of this.metrics) {
        item.metrics.set(metric.key, cacheMetricSeries(item, runIndex, metric, this.time));
      }
    }
    for (const metric of this.metrics) {
      this.metricDomains.set(metric.key, metricDomain(this.series, metric));
    }
    this.sampleInterval = nominalInterval(this.series, this.time);
    this.rebuildBandGaps();
    this.updateAccessibleDescription();
  }

  private rebuildBandGaps(): void {
    const visibleRunIds = new Set(this.runs.map((run) => run.id));
    const visibleGroups: Array<readonly NormalizedGap[]> = [this.gaps];
    for (const [runId, gaps] of this.gapsByRun) {
      if (visibleRunIds.has(runId)) {
        visibleGroups.push(gaps);
      }
    }
    this.bandGaps = mergeNormalizedGaps(visibleGroups);
  }

  private readonly handlePointer = (event: PointerEvent): void => {
    event.stopPropagation();
    if (event.button !== 0) {
      return;
    }
    const timestamp = this.selectFromPointer(event);
    this.cursorControl.focus?.({ preventScroll: true });
    if (timestamp !== null) {
      const incident = this.incidentAtTimestamp(timestamp);
      if (incident !== null) {
        this.selectedIncidentId = incident.id;
        this.renderStatic();
        this.renderCursor();
        this.onIncidentSelected?.(incident, timestamp);
      }
    }
    this.svg.setPointerCapture?.(event.pointerId);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    if ((event.buttons & 1) === 1) {
      event.stopPropagation();
      this.selectFromPointer(event);
    }
  };

  private readonly handleCursorFocus = (): void => {
    this.element.setAttribute("data-cursor-focus", "true");
    this.element.style.outline = "2px solid #f05a1a";
    this.element.style.outlineOffset = "2px";
  };

  private readonly handleCursorBlur = (): void => {
    this.element.removeAttribute("data-cursor-focus");
    this.element.style.outline = "";
    this.element.style.outlineOffset = "";
  };

  private readonly handleRangeInput = (event: Event): void => {
    event.stopPropagation();
    const timestamp = Number(this.cursorControl.value);
    if (finite(timestamp)) {
      this.selectTimestamp(clamp(timestamp, this.time.min, this.time.max));
    }
  };

  private readonly handleRangeKeydown = (event: KeyboardEvent): void => {
    event.stopPropagation();
    const current =
      this.selectedTimestamp === null
        ? this.time.min
        : clamp(this.selectedTimestamp, this.time.min, this.time.max);
    const step = event.shiftKey ? 1 : this.sampleInterval;
    let next: number | null = null;

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = current - step;
    } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = current + step;
    } else if (event.key === "PageDown") {
      next = current - Math.max(step * 10, (this.time.max - this.time.min) / 10);
    } else if (event.key === "PageUp") {
      next = current + Math.max(step * 10, (this.time.max - this.time.min) / 10);
    } else if (event.key === "Home") {
      next = this.time.min;
    } else if (event.key === "End") {
      next = this.time.max;
    }

    if (next !== null) {
      event.preventDefault();
      this.selectTimestamp(clamp(next, this.time.min, this.time.max));
    }
  };

  private selectFromPointer(event: PointerEvent): number | null {
    if (this.series.every((item) => item.samples.length === 0)) {
      return null;
    }
    const bounds = this.svg.getBoundingClientRect();
    if (bounds.width <= 0) {
      return null;
    }
    const viewX = ((event.clientX - bounds.left) / bounds.width) * this.layout.width;
    const plotX = clamp(viewX, this.layout.plotLeft, this.layout.width - this.layout.plotRight);
    const timestamp = scale(
      plotX,
      {
        min: this.layout.plotLeft,
        max: this.layout.width - this.layout.plotRight,
      },
      this.time.min,
      this.time.max,
    );
    this.selectTimestamp(timestamp);
    return timestamp;
  }

  private selectTimestamp(timestamp: number): void {
    this.selectedTimestamp = timestamp;
    this.renderCursor();
    this.onTimestampSelected?.(timestamp);
  }

  private incidentAtTimestamp(timestamp: number): NormalizedIncidentWindow | null {
    const pointTolerance = Math.max(
      this.sampleInterval,
      ((this.time.max - this.time.min) / Math.max(this.layout.plotWidth, 1)) * 5,
    );
    let selected: NormalizedIncidentWindow | null = null;
    for (const incident of this.incidents) {
      const pointIncident = incident.endTimestamp === incident.startTimestamp;
      const contains = pointIncident
        ? Math.abs(timestamp - incident.startTimestamp) <= pointTolerance
        : timestamp >= incident.startTimestamp && timestamp <= incident.endTimestamp;
      if (!contains) {
        continue;
      }
      if (
        selected === null ||
        incident.endTimestamp - incident.startTimestamp <
          selected.endTimestamp - selected.startTimestamp
      ) {
        selected = incident;
      }
    }
    return selected;
  }

  private updateAccessibleDescription(): void {
    const labels = this.metrics.map((metric) => metric.label).join(", ");
    const channels = labels.length > 0 ? labels : "configured telemetry";
    const incidents =
      this.incidents.length === 0
        ? ""
        : ` ${this.incidents.length} incident window${this.incidents.length === 1 ? "" : "s"} are overlaid.`;
    this.description.textContent =
      `${channels} over replay time. Shaded telemetry bands indicate missing data.` + incidents;
  }

  private gapsForRun(item: RunSeries, index: number): readonly NormalizedGap[] {
    if (this.gapDisplay !== "break") {
      return [];
    }
    const explicit = this.gapsByRun.get(item.run.id);
    if (explicit !== undefined) {
      return explicit;
    }
    if (this.gapRunId === null) {
      return this.gaps;
    }
    if (this.gapRunId !== undefined) {
      return item.run.id === this.gapRunId ? this.gaps : [];
    }
    return index === 0 ? this.gaps : [];
  }

  private renderDefinitions(): void {
    const definitions = createSvgElement("defs");
    const pattern = createSvgElement("pattern", {
      id: this.patternId,
      width: 1,
      height: 1,
      patternUnits: "userSpaceOnUse",
    });
    pattern.append(
      createSvgElement("rect", {
        width: 1,
        height: 1,
        fill: "rgba(214, 169, 59, 0.22)",
      }),
    );
    definitions.append(pattern);
    this.svg.append(definitions);
  }

  private renderStatic(): void {
    if (this.destroyed) {
      return;
    }
    this.staticLayer.replaceChildren();
    this.renderHeader();

    if (this.series.every((item) => item.samples.length === 0)) {
      this.renderEmptyState();
    } else {
      for (const [index, metric] of this.metrics.entries()) {
        this.renderMetric(metric, index);
      }
      this.renderTimeAxis();
    }

    const interactionTop = this.layout.top - 8;
    this.interactionLayer.setAttribute("x", String(this.layout.plotLeft));
    this.interactionLayer.setAttribute("y", String(interactionTop));
    this.interactionLayer.setAttribute("width", String(this.layout.plotWidth));
    this.interactionLayer.setAttribute(
      "height",
      String(Math.max(1, this.layout.rowHeight * Math.max(this.metrics.length, 1) - 18)),
    );
  }

  private renderHeader(): void {
    const compact = this.layout.width < 520;
    let legendX = this.layout.plotLeft;
    let legendY = compact ? 41 : 20;
    for (const item of this.series) {
      const label = visibleRunName(item.run);
      const itemWidth = 43 + Math.min(label.length, compact ? 18 : 28) * 7;
      if (compact && legendX > this.layout.plotLeft && legendX + itemWidth > this.layout.width) {
        legendX = this.layout.plotLeft;
        legendY += 19;
      }
      this.staticLayer.append(
        createSvgElement("line", {
          class: "telemetry-charts__legend-line",
          x1: legendX,
          y1: legendY,
          x2: legendX + 18,
          y2: legendY,
          stroke: item.color,
          "stroke-width": 2.5,
          "stroke-dasharray": item.dashed ? "6 5" : undefined,
        }),
      );
      this.staticLayer.append(
        createSvgElement(
          "text",
          {
            class: "telemetry-charts__legend-label",
            x: legendX + 25,
            y: legendY + 3,
            fill: "#e7f2f7",
            "font-size": 12,
            "font-weight": 600,
          },
          compact && label.length > 18 ? `${label.slice(0, 17)}…` : label,
        ),
      );
      legendX += itemWidth;
    }
  }

  private renderMetric(metric: ResolvedMetricDefinition, index: number): void {
    const top = this.layout.top + index * this.layout.rowHeight;
    const values = this.metricDomains.get(metric.key) ?? { min: 0, max: 1 };
    const group = createSvgElement("g", {
      class: `telemetry-charts__row telemetry-charts__row--${metric.key}`,
      "data-metric": metric.key,
    });

    group.append(
      createSvgElement("rect", {
        class: "telemetry-charts__plot-background",
        x: this.layout.plotLeft,
        y: top,
        width: this.layout.plotWidth,
        height: this.layout.plotHeight,
        rx: 0,
        fill: "#1e252b",
        stroke: "#52636c",
      }),
    );

    this.renderIncidentWindows(group, metric, index, top);
    this.renderThresholdBands(group, metric, values, top);

    for (let tick = 0; tick <= this.layout.horizontalTicks; tick += 1) {
      const x = this.layout.plotLeft + (tick / this.layout.horizontalTicks) * this.layout.plotWidth;
      group.append(
        createSvgElement("line", {
          class: "telemetry-charts__grid-line telemetry-charts__grid-line--vertical",
          x1: x,
          y1: top,
          x2: x,
          y2: top + this.layout.plotHeight,
          stroke: "#263843",
          "stroke-width": 1,
        }),
      );
    }

    for (let tick = 0; tick <= VERTICAL_TICKS; tick += 1) {
      const ratio = tick / VERTICAL_TICKS;
      const y = top + ratio * this.layout.plotHeight;
      const value = values.max - ratio * (values.max - values.min);
      group.append(
        createSvgElement("line", {
          class: "telemetry-charts__grid-line telemetry-charts__grid-line--horizontal",
          x1: this.layout.plotLeft,
          y1: y,
          x2: this.layout.width - this.layout.plotRight,
          y2: y,
          stroke: "#263843",
          "stroke-width": 1,
        }),
      );
      group.append(
        createSvgElement(
          "text",
          {
            class: "telemetry-charts__axis-label",
            x: this.layout.plotLeft - 8,
            y: y + 3.5,
            fill: "#9db5c0",
            "font-size": 12,
            "text-anchor": "end",
          },
          formatValue(value, metric.decimals),
        ),
      );
    }

    group.append(
      createSvgElement(
        "text",
        {
          class: "telemetry-charts__metric-label",
          x: 7,
          y: top + 14,
          fill: "#e7f2f7",
          "font-size": 12,
          "font-weight": 600,
        },
        metric.label,
      ),
    );
    group.append(
      createSvgElement(
        "text",
        {
          class: "telemetry-charts__metric-unit",
          x: 7,
          y: top + 29,
          fill: "#9db5c0",
          "font-size": 12,
        },
        metric.unit,
      ),
    );

    if (this.gapDisplay === "break") {
      for (const gap of this.bandGaps) {
        const start = clamp(gap.startTimestamp, this.time.min, this.time.max);
        const end = clamp(gap.endTimestamp, this.time.min, this.time.max);
        if (end <= start) {
          continue;
        }
        const x = scale(
          start,
          this.time,
          this.layout.plotLeft,
          this.layout.width - this.layout.plotRight,
        );
        const width =
          scale(end, this.time, this.layout.plotLeft, this.layout.width - this.layout.plotRight) -
          x;
        group.append(
          createSvgElement("rect", {
            class: "telemetry-charts__gap-band",
            x,
            y: top,
            width: Math.max(width, 1),
            height: this.layout.plotHeight,
            fill: `url(#${this.patternId})`,
            "pointer-events": "none",
            "aria-hidden": "true",
          }),
        );
      }
    }

    this.renderThresholdLines(group, metric, values, top);

    for (const [seriesIndex, item] of this.series.entries()) {
      const metricSeries = item.metrics.get(metric.key);
      if (metricSeries === undefined) {
        continue;
      }
      const path = linePath(
        metricSeries.points,
        this.time,
        values,
        this.layout,
        top,
        this.gapsForRun(item, seriesIndex),
      );
      if (path.length > 0) {
        group.append(
          createSvgElement("path", {
            class: "telemetry-charts__series",
            d: path,
            fill: "none",
            stroke: item.color,
            "stroke-width": 2.1,
            "stroke-linecap": "round",
            "stroke-linejoin": "round",
            "stroke-dasharray": item.dashed ? "7 5" : undefined,
            "vector-effect": "non-scaling-stroke",
          }),
        );
      }
    }
    this.staticLayer.append(group);
  }

  private renderIncidentWindows(
    group: SVGGElement,
    metric: ResolvedMetricDefinition,
    metricIndex: number,
    top: number,
  ): void {
    const matching = this.incidents.filter(
      (incident) =>
        incident.endTimestamp >= this.time.min &&
        incident.startTimestamp <= this.time.max &&
        (incident.metricKeys === undefined || incident.metricKeys.includes(metric.key)),
    );
    const rendered = matching.slice(0, MAX_RENDERED_INCIDENT_WINDOWS);
    const selected = matching.find((incident) => incident.id === this.selectedIncidentId);
    if (selected !== undefined && !rendered.includes(selected)) {
      rendered[rendered.length - 1] = selected;
    }

    for (const incident of rendered) {
      const start = clamp(incident.startTimestamp, this.time.min, this.time.max);
      const end = clamp(incident.endTimestamp, this.time.min, this.time.max);
      const x = scale(
        start,
        this.time,
        this.layout.plotLeft,
        this.layout.width - this.layout.plotRight,
      );
      const rawWidth =
        scale(end, this.time, this.layout.plotLeft, this.layout.width - this.layout.plotRight) - x;
      const color =
        incident.color ??
        (incident.severity === "critical"
          ? "#e5483f"
          : incident.severity === "warning"
            ? "#f2a900"
            : "#b7ced9");
      const selectedWindow = incident.id === this.selectedIncidentId;
      group.append(
        createSvgElement("rect", {
          class: `telemetry-charts__incident-window${selectedWindow ? " is-selected" : ""}`,
          "data-incident-id": incident.id,
          x,
          y: top,
          width: Math.max(rawWidth, 2),
          height: this.layout.plotHeight,
          fill: color,
          opacity: selectedWindow ? 0.2 : 0.1,
          stroke: selectedWindow ? color : undefined,
          "stroke-width": selectedWindow ? 1.5 : undefined,
          "pointer-events": "none",
          "aria-hidden": "true",
        }),
      );
      if (metricIndex === 0 && incident.label.length > 0) {
        group.append(
          createSvgElement(
            "text",
            {
              class: "telemetry-charts__incident-label",
              x: Math.min(x + 4, this.layout.width - this.layout.plotRight - 4),
              y: top + this.layout.plotHeight - 5,
              fill: color,
              "font-size": 12,
              "font-weight": selectedWindow ? 700 : 600,
              "text-anchor": x > this.layout.width - this.layout.plotRight - 100 ? "end" : "start",
              "pointer-events": "none",
              "aria-hidden": "true",
            },
            incident.label.length > 24 ? `${incident.label.slice(0, 23)}…` : incident.label,
          ),
        );
      }
    }
  }

  private renderThresholdBands(
    group: SVGGElement,
    metric: ResolvedMetricDefinition,
    values: NumericDomain,
    top: number,
  ): void {
    for (const band of metric.thresholdBands) {
      const upperValue = clamp(band.max, values.min, values.max);
      const lowerValue = clamp(band.min, values.min, values.max);
      if (upperValue <= lowerValue) {
        continue;
      }
      const y = scale(upperValue, values, top + this.layout.plotHeight, top);
      const bottom = scale(lowerValue, values, top + this.layout.plotHeight, top);
      const color = band.color ?? "#f2a900";
      group.append(
        createSvgElement("rect", {
          class: "telemetry-charts__threshold-band",
          x: this.layout.plotLeft,
          y,
          width: this.layout.plotWidth,
          height: Math.max(bottom - y, 1),
          fill: color,
          opacity: 0.09,
          "pointer-events": "none",
          "aria-hidden": "true",
        }),
      );
      group.append(
        createSvgElement(
          "text",
          {
            class: "telemetry-charts__threshold-label",
            x: this.layout.width - this.layout.plotRight - 5,
            y: y + Math.min(Math.max((bottom - y) / 2 + 3, 10), Math.max(bottom - y - 2, 10)),
            fill: color,
            "font-size": 12,
            "font-weight": 600,
            "text-anchor": "end",
            "pointer-events": "none",
            "aria-hidden": "true",
          },
          band.label,
        ),
      );
    }
  }

  private renderThresholdLines(
    group: SVGGElement,
    metric: ResolvedMetricDefinition,
    values: NumericDomain,
    top: number,
  ): void {
    for (const threshold of metric.thresholds) {
      if (threshold.value < values.min || threshold.value > values.max) {
        continue;
      }
      const y = scale(threshold.value, values, top + this.layout.plotHeight, top);
      const color = threshold.color ?? "#f2a900";
      group.append(
        createSvgElement("line", {
          class: "telemetry-charts__threshold-line",
          x1: this.layout.plotLeft,
          y1: y,
          x2: this.layout.width - this.layout.plotRight,
          y2: y,
          stroke: color,
          "stroke-width": 1.2,
          "stroke-dasharray": threshold.dashArray ?? "5 4",
          opacity: 0.9,
          "pointer-events": "none",
          "aria-hidden": "true",
        }),
      );
      group.append(
        createSvgElement(
          "text",
          {
            class: "telemetry-charts__threshold-label",
            x: this.layout.width - this.layout.plotRight - 5,
            y: Math.max(top + 30, y - 3),
            fill: color,
            "font-size": 12,
            "font-weight": 600,
            "text-anchor": "end",
            "pointer-events": "none",
            "aria-hidden": "true",
          },
          threshold.label,
        ),
      );
    }
  }

  private renderTimeAxis(): void {
    const y = this.layout.top + Math.max(this.metrics.length, 1) * this.layout.rowHeight - 27;
    for (let tick = 0; tick <= this.layout.horizontalTicks; tick += 1) {
      const ratio = tick / this.layout.horizontalTicks;
      const timestamp = this.time.min + ratio * (this.time.max - this.time.min);
      const x = this.layout.plotLeft + ratio * this.layout.plotWidth;
      this.staticLayer.append(
        createSvgElement(
          "text",
          {
            class: "telemetry-charts__time-label",
            x,
            y,
            fill: "#9db5c0",
            "font-size": 12,
            "text-anchor":
              tick === 0 ? "start" : tick === this.layout.horizontalTicks ? "end" : "middle",
          },
          formatElapsed(timestamp, this.time),
        ),
      );
    }
  }

  private renderCursor(): void {
    if (this.destroyed) {
      return;
    }
    this.cursorLayer.replaceChildren();
    const hasData = this.series.some((item) => item.samples.length > 0);
    this.cursorControl.disabled = !hasData;
    this.cursorControl.min = String(this.time.min);
    this.cursorControl.max = String(this.time.max);
    this.cursorControl.step = String(this.sampleInterval);

    const timestamp =
      this.selectedTimestamp === null
        ? null
        : clamp(this.selectedTimestamp, this.time.min, this.time.max);
    this.cursorControl.value = String(timestamp ?? this.time.min);
    this.cursorControl.setAttribute(
      "aria-valuetext",
      timestamp === null ? "No time selected" : formatElapsed(timestamp, this.time),
    );

    const cursorLabel =
      timestamp === null ? "Time —" : `Time ${formatElapsed(timestamp, this.time)}`;
    this.cursorLayer.append(
      createSvgElement(
        "text",
        {
          class: "telemetry-charts__cursor-readout",
          x: this.layout.width - this.layout.plotRight,
          y: 18,
          fill: "#9db5c0",
          "font-size": 12,
          "font-weight": 600,
          "text-anchor": "end",
        },
        cursorLabel,
      ),
    );

    if (timestamp !== null && hasData) {
      this.renderCrosshair(timestamp);
    }
  }

  private renderCrosshair(timestamp: number): void {
    const x = scale(
      timestamp,
      this.time,
      this.layout.plotLeft,
      this.layout.width - this.layout.plotRight,
    );
    const group = createSvgElement("g", {
      class: "telemetry-charts__crosshair",
      "pointer-events": "none",
    });
    group.append(
      createSvgElement("line", {
        x1: x,
        y1: this.layout.top - 7,
        x2: x,
        y2: this.layout.top + Math.max(this.metrics.length, 1) * this.layout.rowHeight - 34,
        stroke: "#f05a1a",
        "stroke-width": 1,
        "stroke-dasharray": "3 4",
        opacity: 0.75,
      }),
    );

    for (const [metricIndex, metric] of this.metrics.entries()) {
      const top = this.layout.top + metricIndex * this.layout.rowHeight;
      const values = this.metricDomains.get(metric.key) ?? { min: 0, max: 1 };
      const readouts: string[] = [];
      for (const [seriesIndex, item] of this.series.entries()) {
        const runGaps = this.gapsForRun(item, seriesIndex);
        const value = interpolatedMetric(item, seriesIndex, metric, timestamp, runGaps);
        if (value === null) {
          if (timestampInsideGap(timestamp, runGaps)) {
            readouts.push("NO DATA");
          }
          continue;
        }
        const y = scale(value, values, top + this.layout.plotHeight, top);
        group.append(
          createSvgElement("circle", {
            class: "telemetry-charts__selected-point",
            cx: x,
            cy: y,
            r: 3.8,
            fill: "#1e252b",
            stroke: item.color,
            "stroke-width": 2.2,
          }),
        );
        readouts.push(`${formatValue(value, metric.decimals)} ${metric.unit}`);
      }

      if (readouts.length > 0) {
        group.append(
          createSvgElement(
            "text",
            {
              class: "telemetry-charts__selected-value",
              x: this.layout.width - this.layout.plotRight - 7,
              y: top + 13,
              fill: readouts.includes("NO DATA") ? "#f2a900" : "#ffffff",
              "font-size": 12,
              "font-weight": 600,
              "text-anchor": "end",
            },
            readouts.join(" / "),
          ),
        );
      }
    }
    this.cursorLayer.append(group);
  }

  private renderEmptyState(): void {
    this.staticLayer.append(
      createSvgElement("rect", {
        class: "telemetry-charts__empty-background",
        x: this.layout.plotLeft,
        y: this.layout.top,
        width: this.layout.plotWidth,
        height: this.layout.rowHeight * Math.max(this.metrics.length, 1) - 38,
        rx: 0,
        fill: "#1e252b",
        stroke: "#52636c",
      }),
    );
    this.staticLayer.append(
      createSvgElement(
        "text",
        {
          class: "telemetry-charts__empty-label",
          x: this.layout.plotLeft + this.layout.plotWidth / 2,
          y: this.layout.top + (this.layout.rowHeight * Math.max(this.metrics.length, 1) - 38) / 2,
          fill: "#9db5c0",
          "font-size": 12,
          "font-weight": 600,
          "text-anchor": "middle",
        },
        "No telemetry data",
      ),
    );
  }
}

export function createTelemetryCharts(
  container: HTMLElement,
  options: TelemetryChartsOptions = {},
): TelemetryChartController {
  return new TelemetryCharts(container, options);
}

/** Short alias for application code that treats the chart stack as a single view. */
export const mountTelemetryCharts = createTelemetryCharts;
