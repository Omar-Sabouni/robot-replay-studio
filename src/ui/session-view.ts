import type {
  DetectorId,
  DetectorRuleConfig,
  EvidenceChain,
  ReplaySampleStatus,
  ReplaySessionRun,
  SessionAnalysis,
  SessionIncident,
  SessionTelemetrySample,
  TelemetryRun,
} from "../core/types";

/** The visible value used whenever an optional telemetry channel was not recorded. */
export const UNAVAILABLE_LABEL = "—";

/**
 * Adapt a normalized session run to the strict, legacy rendering contract.
 *
 * The old contract cannot express missing channels. NaN is intentional here:
 * chart accessors already treat non-finite values as gaps, while substituting
 * zero would create measurements that never existed. An empty state string is
 * the matching lossless sentinel for the legacy string-only state field: UI
 * formatters show it as unavailable and report summaries already ignore blank
 * states instead of inventing a controller transition.
 */
export function sessionRunToTelemetryRun(run: ReplaySessionRun): TelemetryRun {
  return {
    id: run.id,
    name: run.name,
    kind: run.kind,
    samples: run.samples.map((sample) => ({
      timestamp: sample.timestamp,
      sequence: sample.sequence ?? Number.NaN,
      pose: { ...sample.pose },
      speed: sample.speed ?? Number.NaN,
      battery: sample.battery ?? Number.NaN,
      current: sample.current ?? Number.NaN,
      state: sample.state ?? "",
      latencyMs: sample.latencyMs ?? Number.NaN,
      poseSigma: sample.poseSigma ?? Number.NaN,
    })),
    ...(run.description === undefined ? {} : { description: run.description }),
    ...(run.sampleRateHz === undefined ? {} : { sampleRateHz: run.sampleRateHz }),
  };
}

/** Compatibility alias for integration code that reads more naturally in this order. */
export const telemetryRunFromSessionRun = sessionRunToTelemetryRun;

export function finiteValue(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function formatTimecode(timestamp: number, milliseconds = true): string {
  if (!Number.isFinite(timestamp)) {
    return UNAVAILABLE_LABEL;
  }
  const safe = Math.max(0, timestamp);
  const wholeSeconds = Math.floor(safe);
  const hours = Math.floor(wholeSeconds / 3_600);
  const minutes = Math.floor((wholeSeconds % 3_600) / 60);
  const seconds = wholeSeconds % 60;
  const fraction = Math.min(999, Math.floor((safe - wholeSeconds) * 1_000 + 0.000_1));
  const clock = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  const hourPrefix = hours > 0 ? `${hours.toString().padStart(2, "0")}:` : "";
  return `${hourPrefix}${clock}${milliseconds ? `.${fraction.toString().padStart(3, "0")}` : ""}`;
}

export function formatSeconds(timestamp: number, digits = 1): string {
  return Number.isFinite(timestamp)
    ? `${Math.max(0, timestamp).toFixed(digits)} s`
    : UNAVAILABLE_LABEL;
}

export interface NumberFormatOptions {
  digits?: number;
  signed?: boolean;
  trimTrailingZeros?: boolean;
  unavailable?: string;
}

export function formatNumber(
  value: number | null | undefined,
  options: NumberFormatOptions = {},
): string {
  const finite = finiteValue(value);
  if (finite === null) {
    return options.unavailable ?? UNAVAILABLE_LABEL;
  }
  const digits = Math.max(0, options.digits ?? 1);
  let formatted = finite.toFixed(digits);
  if (options.trimTrailingZeros && formatted.includes(".")) {
    formatted = formatted.replace(/\.?0+$/, "");
  }
  if (options.signed && finite >= 0) {
    return `+${formatted}`;
  }
  return formatted;
}

export function formatSigned(value: number | null | undefined, digits = 1): string {
  return formatNumber(value, { digits, signed: true });
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  const formatted = formatNumber(value, { digits });
  return formatted === UNAVAILABLE_LABEL ? formatted : `${formatted}%`;
}

export function formatStateLabel(state: string | null | undefined): string {
  const trimmed = state?.trim();
  if (trimmed === undefined || trimmed === "") {
    return "Unavailable";
  }
  const normalized = trimmed.replaceAll(/[-_]+/g, " ").replaceAll(/\s+/g, " ");
  return `${normalized.charAt(0).toUpperCase()}${normalized.slice(1)}`;
}

export function formatFreshness(status: ReplaySampleStatus): string {
  switch (status) {
    case "held-during-gap":
      return "Held · telemetry gap";
    case "before-range":
      return "Before first sample";
    case "after-range":
      return "Run complete · final sample";
    case "interpolated":
      return "Interpolated sample";
    case "exact":
      return "Exact sample";
  }
}

export function detectorShortCode(id: DetectorId): string {
  switch (id) {
    case "timestamp-gap":
      return "TIME";
    case "sequence-gap":
      return "SEQ";
    case "pose-discontinuity":
      return "POSE";
    case "overcurrent":
      return "LOAD";
    case "low-battery":
      return "BATT";
    case "link-degradation":
      return "NET";
    case "route-deviation":
      return "ROUTE";
    case "heading-error":
      return "YAW";
    case "obstacle-clearance":
      return "SAFE";
    case "safe-stop":
      return "STOP";
  }
}

export function detectorUnit(id: DetectorId): string {
  switch (id) {
    case "timestamp-gap":
      return "s";
    case "sequence-gap":
      return "packets";
    case "pose-discontinuity":
    case "route-deviation":
    case "obstacle-clearance":
      return "m";
    case "overcurrent":
      return "A";
    case "low-battery":
      return "%";
    case "link-degradation":
      return "ms";
    case "heading-error":
      return "rad";
    case "safe-stop":
      return "state";
  }
}

export function detectorRuleSummary(rule: DetectorRuleConfig): string {
  const threshold = formatNumber(rule.threshold, { digits: detectorDigits(rule.id) });
  const unit = detectorUnit(rule.id);
  switch (rule.id) {
    case "timestamp-gap":
      return `Sample interval exceeds ${threshold} ${unit}`;
    case "sequence-gap":
      return `Sequence advances by more than ${threshold}`;
    case "pose-discontinuity":
      return `Pose jump exceeds ${threshold} ${unit}`;
    case "overcurrent":
      return `Motor current magnitude exceeds ${threshold} ${unit}`;
    case "low-battery":
      return `Battery reserve falls below ${threshold} ${unit}`;
    case "link-degradation":
      return `Sustained data age exceeds ${threshold} ${unit}`;
    case "route-deviation":
      return `Cross-track error exceeds ${threshold} ${unit}`;
    case "heading-error":
      return `Absolute heading error exceeds ${threshold} ${unit}`;
    case "obstacle-clearance":
      return `Obstacle clearance falls below ${threshold} ${unit}`;
    case "safe-stop":
      return "Robot enters a protective stop state";
  }
}

export function detectorRuleDescription(rule: DetectorRuleConfig): string {
  if (rule.unavailableReason !== undefined) {
    return rule.unavailableReason;
  }
  if (!rule.enabled) {
    return "This detector is disabled and does not contribute incidents.";
  }
  if (rule.minimumDuration <= 0) {
    return "Fires on the first sample that crosses the configured boundary.";
  }
  return `Fires when the boundary remains crossed for at least ${formatSeconds(rule.minimumDuration, rule.minimumDuration < 1 ? 2 : 1)}.`;
}

export function detectorExpression(rule: DetectorRuleConfig): string {
  const threshold = formatNumber(rule.threshold, { digits: detectorDigits(rule.id) });
  const duration = formatNumber(rule.minimumDuration, { digits: 2, trimTrailingZeros: true });
  switch (rule.id) {
    case "timestamp-gap":
      return `sample_interval > ${threshold}s`;
    case "sequence-gap":
      return `sequence_delta > ${threshold}`;
    case "pose-discontinuity":
      return `pose_jump > ${threshold}m`;
    case "overcurrent":
      return `abs(current) > ${threshold}A for ${duration}s`;
    case "low-battery":
      return `battery < ${threshold}% for ${duration}s`;
    case "link-degradation":
      return `latency > ${threshold}ms for ${duration}s`;
    case "route-deviation":
      return `cross_track_error > ${threshold}m for ${duration}s`;
    case "heading-error":
      return `abs(heading_error) > ${threshold}rad for ${duration}s`;
    case "obstacle-clearance":
      return `clearance < ${threshold}m for ${duration}s`;
    case "safe-stop":
      return `state == safe-stop`;
  }
}

export function detectorDigits(id: DetectorId): number {
  switch (id) {
    case "sequence-gap":
    case "link-degradation":
    case "safe-stop":
      return 0;
    case "low-battery":
    case "overcurrent":
      return 1;
    default:
      return 2;
  }
}

export function incidentMeasurement(incident: SessionIncident): string {
  const { observed, threshold, comparator, unit } = incident.evidence;
  const observedText =
    typeof observed === "number"
      ? formatNumber(observed, { digits: detectorDigits(incident.detectorId) })
      : observed;
  const thresholdText =
    typeof threshold === "number"
      ? formatNumber(threshold, { digits: detectorDigits(incident.detectorId) })
      : threshold;
  const boundary =
    comparator === "above"
      ? `limit ${thresholdText}`
      : comparator === "below"
        ? `minimum ${thresholdText}`
        : comparator === "state-entered"
          ? `expected ${thresholdText}`
          : `threshold ${thresholdText}`;
  const suffix = unit === "" || unit === "state" ? "" : ` ${unit}`;
  return `${observedText}${suffix} · ${boundary}${suffix}`;
}

export function incidentById(
  analysis: SessionAnalysis,
  incidentId: string | null | undefined,
): SessionIncident | null {
  return analysis.incidents.find(({ id }) => id === incidentId) ?? analysis.incidents[0] ?? null;
}

export function initiatingIncident(
  analysis: SessionAnalysis,
): { chain: EvidenceChain; incident: SessionIncident } | null {
  for (const chain of analysis.evidenceChains) {
    const step = chain.steps.find(({ classification }) => classification === "earliest-crossing");
    const incident =
      step === undefined ? undefined : analysis.incidents.find(({ id }) => id === step.incidentId);
    if (incident !== undefined) {
      return { chain, incident };
    }
  }
  return null;
}

export function findSampleAtOrBefore(
  samples: readonly SessionTelemetrySample[],
  timestamp: number,
): SessionTelemetrySample | null {
  if (samples.length === 0) {
    return null;
  }
  let low = 0;
  let high = samples.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const sample = samples[middle];
    if (sample === undefined) {
      break;
    }
    if (sample.timestamp <= timestamp) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return samples[Math.max(0, high)] ?? null;
}

export function nearestIncident(
  incidents: readonly SessionIncident[],
  timestamp: number,
): SessionIncident | null {
  if (incidents.length === 0) {
    return null;
  }
  let low = 0;
  let high = incidents.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if ((incidents[middle]?.timestamp ?? Number.POSITIVE_INFINITY) < timestamp) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  const after = incidents[Math.min(low, incidents.length - 1)] ?? null;
  const before = incidents[Math.max(0, low - 1)] ?? null;
  if (before === null) {
    return after;
  }
  if (after === null) {
    return before;
  }
  return Math.abs(before.timestamp - timestamp) <= Math.abs(after.timestamp - timestamp)
    ? before
    : after;
}
