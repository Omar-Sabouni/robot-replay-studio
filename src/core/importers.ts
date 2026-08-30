import {
  REPLAY_SESSION_SCHEMA,
  type AppliedFaultTransformation,
  type CoordinateFrame,
  type DetectorConfiguration,
  type DetectorId,
  type DetectorRuleConfig,
  type EnvironmentObject,
  type MissionMetadata,
  type PlannedRoute,
  type ReplayAnnotation,
  type ReplayEnvironment,
  type ReplayRunRole,
  type ReplaySessionRun,
  type ReplaySessionV2,
  type RobotMetadata,
  type RunKind,
  type SessionProvenance,
  type SessionTelemetrySample,
} from "./types";
import {
  assertReplaySession,
  DETECTOR_CONFIGURATION_VERSION,
  detectorRuleConfigurationIssues,
  MAX_REPLAY_IDENTIFIER_LENGTH,
  sampleRateConfigurationIssue,
  sessionRunFromTelemetryRun,
  sha256Bytes as sha256RawBytes,
  sha256Text,
} from "./session";
import { normalizeYaw, parseTelemetryJson, TelemetryParseError } from "./telemetry";
import {
  assertImportSize,
  assertReplaySessionImportCounts,
  importCardinalityIssue,
  MAX_IMPORT_ANNOTATIONS,
  MAX_IMPORT_CSV_COLUMNS,
  MAX_IMPORT_ISSUES,
  MAX_IMPORT_PROVENANCE_NOTES,
  MAX_IMPORT_SAMPLES,
  MAX_IMPORT_STRING_LENGTH,
  MAX_IMPORT_TAGS,
  MAX_IMPORT_TRANSFORMATIONS,
  MAX_IMPORT_TRANSFORMATION_PARAMETERS,
  MAX_IMPORT_WARNINGS,
  RecordingImportError,
  type ImportIssue,
} from "./import-limits";

export {
  assertImportSize,
  assertReplaySessionImportLimits,
  MAX_IMPORT_ANNOTATIONS,
  MAX_IMPORT_BYTES,
  MAX_IMPORT_CSV_COLUMNS,
  MAX_IMPORT_ENVIRONMENT_OBJECTS,
  MAX_IMPORT_GEOMETRY_WORK,
  MAX_IMPORT_ISSUES,
  MAX_IMPORT_PROVENANCE_NOTES,
  MAX_IMPORT_ROUTE_WAYPOINTS,
  MAX_IMPORT_SAMPLES,
  MAX_IMPORT_STRING_LENGTH,
  MAX_IMPORT_TAGS,
  MAX_IMPORT_TRANSFORMATIONS,
  MAX_IMPORT_TRANSFORMATION_PARAMETERS,
  MAX_IMPORT_WARNINGS,
  preflightImportSize,
  RecordingImportError,
  type ImportIssue,
  type ImportIssueCode,
} from "./import-limits";

export type RecordingImportFormat = "auto" | "json" | "csv" | "ros-jsonl";
export type ResolvedRecordingImportFormat = Exclude<RecordingImportFormat, "auto">;
export type CsvYawUnit = "radians" | "degrees";
export type CsvTimestampUnit = "seconds" | "milliseconds" | "nanoseconds";

export interface ImportWarning {
  code: string;
  message: string;
  path?: string;
  line?: number;
  row?: number;
  field?: string;
}

export interface ImportChannelAvailabilityEntry {
  available: boolean;
  sampleCount: number;
  totalSamples: number;
}

export interface ImportChannelAvailability {
  timestamp: ImportChannelAvailabilityEntry;
  pose: ImportChannelAvailabilityEntry;
  sequence: ImportChannelAvailabilityEntry;
  speed: ImportChannelAvailabilityEntry;
  battery: ImportChannelAvailabilityEntry;
  current: ImportChannelAvailabilityEntry;
  state: ImportChannelAvailabilityEntry;
  latencyMs: ImportChannelAvailabilityEntry;
  poseSigma: ImportChannelAvailabilityEntry;
}

interface ImportedRecordingBase {
  format: ResolvedRecordingImportFormat;
  sourceName: string;
  byteLength: number;
  sha256: string;
  warnings: ImportWarning[];
}

export interface ImportedSessionRecording extends ImportedRecordingBase {
  kind: "session";
  format: "json";
  session: ReplaySessionV2;
}

export interface ImportedRunRecording extends ImportedRecordingBase {
  kind: "run";
  role: ReplayRunRole;
  run: ReplaySessionRun;
  provenance: SessionProvenance;
  availability: ImportChannelAvailability;
  /** Numeric approximation of the original timestamp represented by replay time 0. */
  timeOriginSeconds: number;
  /** Exact source-native representation of the replay origin for provenance display. */
  timeOriginExact: string;
}

export type ImportedRecording = ImportedSessionRecording | ImportedRunRecording;

interface ParserSourceOptions {
  sourceName?: string;
  importedAt?: string | null;
}

interface VerifiedParserSource {
  byteLength: number;
  sha256: string;
}

export interface ParseSessionJsonOptions extends ParserSourceOptions {
  /** Role used only when adapting a legacy TelemetryRun JSON document. */
  role?: ReplayRunRole;
}

export interface ParseTelemetryCsvOptions extends ParserSourceOptions {
  /** Required so a run is never silently assigned to the wrong comparison side. */
  role: ReplayRunRole;
  /** CSV yaw values are converted to normalized radians using this explicit unit. */
  yawUnit: CsvYawUnit;
  /** Source timestamp unit, converted to seconds before validation and inference. */
  timestampUnit?: CsvTimestampUnit;
  normalizeTimestampOrigin?: boolean;
  runId?: string;
  runName?: string;
  kind?: RunKind;
}

export interface RosbridgeTopicOptions {
  odom: string;
  battery?: string | null;
  diagnostics?: string | null;
}

export interface ParseRosbridgeJsonlOptions extends ParserSourceOptions {
  role: ReplayRunRole;
  topics?: Partial<RosbridgeTopicOptions>;
  normalizeTimestampOrigin?: boolean;
  runId?: string;
  runName?: string;
  kind?: RunKind;
}

export interface ImportRecordingOptions extends ParserSourceOptions {
  format?: RecordingImportFormat;
  role?: ReplayRunRole;
  yawUnit?: CsvYawUnit;
  timestampUnit?: CsvTimestampUnit;
  normalizeTimestampOrigin?: boolean;
  runId?: string;
  runName?: string;
  kind?: RunKind;
  topics?: Partial<RosbridgeTopicOptions>;
  signal?: AbortSignal;
}

export type ImportRecordingInput = string | ArrayBuffer | ArrayBufferView | Blob;

const DETECTOR_IDS = [
  "timestamp-gap",
  "sequence-gap",
  "pose-discontinuity",
  "overcurrent",
  "low-battery",
  "link-degradation",
  "route-deviation",
  "heading-error",
  "obstacle-clearance",
  "safe-stop",
] as const satisfies readonly DetectorId[];

const OPTIONAL_CSV_COLUMNS = [
  "sequence",
  "speed",
  "battery",
  "current",
  "state",
  "latency_ms",
  "pose_sigma",
] as const;

const CSV_COLUMNS = ["timestamp", "x", "y", "yaw", ...OPTIONAL_CSV_COLUMNS] as const;
const REQUIRED_CSV_COLUMNS = ["timestamp", "x", "y", "yaw"] as const;
const DEFAULT_ROS_TOPICS: RosbridgeTopicOptions = {
  odom: "/odom",
  battery: "/battery_state",
  diagnostics: "/diagnostics",
};

const MAX_CSV_NUMERIC_LITERAL_LENGTH = 256;
const GENERATED_TEXT_SUFFIX = "… [truncated]";
const GENERATED_MESSAGE_HEADROOM = 512;
const MAX_EMBEDDED_SOURCE_STRING_LENGTH = MAX_IMPORT_STRING_LENGTH - GENERATED_MESSAGE_HEADROOM;
const IMPORT_LINEAGE_NOTE_PREFIX = "[robot-replay/import-lineage/v1] ";

/** Keep importer-created text inside the same limits enforced on canonical input. */
function boundedGeneratedText(value: string, maximumLength = MAX_IMPORT_STRING_LENGTH): string {
  if (value.length <= maximumLength) {
    return value;
  }
  const retainedLength = Math.max(0, maximumLength - GENERATED_TEXT_SUFFIX.length);
  return `${value.slice(0, retainedLength)}${GENERATED_TEXT_SUFFIX}`;
}

function boundedIssue(issue: ImportIssue): ImportIssue {
  const { message, path, field, ...details } = issue;
  return {
    ...details,
    message: boundedGeneratedText(message),
    path: boundedGeneratedText(path),
    ...(field === undefined ? {} : { field: boundedGeneratedText(field) }),
  };
}

function boundedWarning(warning: ImportWarning): ImportWarning {
  const { message, path, field, ...details } = warning;
  const maximumMessageLength = MAX_IMPORT_STRING_LENGTH - GENERATED_MESSAGE_HEADROOM;
  return {
    ...details,
    message: boundedGeneratedText(message, maximumMessageLength),
    ...(path === undefined ? {} : { path: boundedGeneratedText(path) }),
    ...(field === undefined ? {} : { field: boundedGeneratedText(field) }),
  };
}

class IssueCollector {
  readonly issues: ImportIssue[] = [];
  total = 0;

  add(issue: ImportIssue): void {
    this.total += 1;
    if (this.issues.length < MAX_IMPORT_ISSUES) {
      this.issues.push(boundedIssue(issue));
    }
  }

  throwIfAny(): void {
    if (this.total > 0) {
      throw new RecordingImportError(this.issues, this.total);
    }
  }
}

function importError(issue: ImportIssue): RecordingImportError {
  return new RecordingImportError([boundedIssue(issue)]);
}

function appendWarning(warnings: ImportWarning[], warning: ImportWarning): void {
  if (warnings.length < MAX_IMPORT_WARNINGS - 1) {
    warnings.push(boundedWarning(warning));
  } else if (warnings.length === MAX_IMPORT_WARNINGS - 1) {
    warnings.push({
      code: "warnings-truncated",
      message: `Additional import warnings were omitted after the first ${MAX_IMPORT_WARNINGS - 1}.`,
    });
  }
}

function appendWarnings(warnings: ImportWarning[], additions: readonly ImportWarning[]): void {
  for (const warning of additions) {
    appendWarning(warnings, warning);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertImportedSampleCount(sampleCount: number, path: string): void {
  if (sampleCount > MAX_IMPORT_SAMPLES) {
    throw importError(importCardinalityIssue(path, "Telemetry", sampleCount, MAX_IMPORT_SAMPLES));
  }
}

/**
 * Reject canonical cardinality and CPU amplification before nested values are
 * copied into domain objects. Missing or malformed collections remain the
 * responsibility of the normal structured validator.
 */
function assertCanonicalImportLimits(root: Record<string, unknown>): void {
  const runs = isRecord(root.runs) ? root.runs : undefined;
  const candidate = runs !== undefined && isRecord(runs.candidate) ? runs.candidate : undefined;
  const baseline = runs !== undefined && isRecord(runs.baseline) ? runs.baseline : undefined;
  const candidateSampleCount = Array.isArray(candidate?.samples) ? candidate.samples.length : 0;
  const baselineSampleCount = Array.isArray(baseline?.samples) ? baseline.samples.length : 0;

  const route = isRecord(root.plannedRoute) ? root.plannedRoute : undefined;
  const waypointCount = Array.isArray(route?.waypoints) ? route.waypoints.length : 0;
  const environment = isRecord(root.environment) ? root.environment : undefined;
  const objectCount = Array.isArray(environment?.objects) ? environment.objects.length : 0;
  assertReplaySessionImportCounts({
    candidateSampleCount,
    baselineSampleCount,
    waypointCount,
    objectCount,
  });

  const mission = isRecord(root.mission) ? root.mission : undefined;
  const provenance = isRecord(root.provenance) ? root.provenance : undefined;
  const transformations = Array.isArray(root.transformations) ? root.transformations : [];
  const metadataIssues: ImportIssue[] = [];
  const checkArray = (value: unknown, path: string, label: string, maximum: number): void => {
    if (Array.isArray(value) && value.length > maximum) {
      metadataIssues.push(importCardinalityIssue(path, label, value.length, maximum));
    }
  };
  checkArray(mission?.tags, "mission.tags", "Mission tags", MAX_IMPORT_TAGS);
  checkArray(
    provenance?.notes,
    "provenance.notes",
    "Provenance notes",
    MAX_IMPORT_PROVENANCE_NOTES,
  );
  checkArray(root.annotations, "annotations", "Annotations", MAX_IMPORT_ANNOTATIONS);
  checkArray(
    root.transformations,
    "transformations",
    "Fault transformations",
    MAX_IMPORT_TRANSFORMATIONS,
  );
  for (
    let index = 0;
    index < Math.min(transformations.length, MAX_IMPORT_TRANSFORMATIONS);
    index += 1
  ) {
    const transformation = transformations[index];
    const parameters = isRecord(transformation) ? transformation.parameters : undefined;
    if (isRecord(parameters)) {
      const count = Object.keys(parameters).length;
      if (count > MAX_IMPORT_TRANSFORMATION_PARAMETERS) {
        metadataIssues.push(
          importCardinalityIssue(
            `transformations[${index}].parameters`,
            "Transformation parameters",
            count,
            MAX_IMPORT_TRANSFORMATION_PARAMETERS,
          ),
        );
      }
    }
  }
  if (metadataIssues.length > 0) {
    throw new RecordingImportError(metadataIssues);
  }
}

function sourceName(options: ParserSourceOptions, fallback: string): string {
  const name = options.sourceName?.trim();
  if (name === undefined || name === "") {
    return fallback;
  }
  if (name.length > MAX_EMBEDDED_SOURCE_STRING_LENGTH) {
    throw importError({
      code: "invalid-value",
      message: `Source name must contain at most ${MAX_EMBEDDED_SOURCE_STRING_LENGTH} characters.`,
      path: "options.sourceName",
    });
  }
  return name;
}

function assertImportedRunTextLimits(run: ReplaySessionRun, path = "run"): void {
  const issues = new IssueCollector();
  const check = (value: string | undefined | null, valuePath: string, maximum: number): void => {
    if (value !== undefined && value !== null && value.length > maximum) {
      issues.add({
        code: "invalid-value",
        message: `${valuePath} must contain at most ${maximum} characters.`,
        path: valuePath,
      });
    }
  };
  check(run.id, `${path}.id`, MAX_REPLAY_IDENTIFIER_LENGTH);
  check(run.name, `${path}.name`, MAX_IMPORT_STRING_LENGTH);
  check(run.description, `${path}.description`, MAX_IMPORT_STRING_LENGTH);
  run.samples.forEach((sample, index) => {
    check(sample.state, `${path}.samples[${index}].state`, MAX_IMPORT_STRING_LENGTH);
  });
  issues.throwIfAny();
}

function assertRunOptionTextLimits(options: { runId?: string; runName?: string }): void {
  for (const [path, value, maximum] of [
    ["options.runId", options.runId, MAX_REPLAY_IDENTIFIER_LENGTH],
    ["options.runName", options.runName, MAX_IMPORT_STRING_LENGTH],
  ] as const) {
    if (value !== undefined && value.trim().length > maximum) {
      throw importError({
        code: "invalid-value",
        message: `${path} must contain at most ${maximum} characters.`,
        path,
      });
    }
  }
}

function sourceByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x7f) {
      bytes += 1;
    } else if (code <= 0x7ff) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function parserSource(text: string, verified?: VerifiedParserSource): VerifiedParserSource {
  if (verified !== undefined) {
    assertImportSize(verified.byteLength);
    if (!/^[0-9a-f]{64}$/.test(verified.sha256)) {
      throw new TypeError("verified parser source must contain a valid SHA-256 digest");
    }
    return verified;
  }
  const byteLength = sourceByteLength(text);
  assertImportSize(byteLength);
  return { byteLength, sha256: sha256Text(text) };
}

function provenanceFor(
  source: SessionProvenance["source"],
  label: string,
  sha256: string,
  importedAt: string | null | undefined,
  notes: string[] = [],
): SessionProvenance {
  if (importedAt !== undefined && importedAt !== null && !isIsoTimestamp(importedAt)) {
    throw importError({
      code: "invalid-value",
      message: "importedAt must be an ISO-8601 timestamp or null.",
      path: "options.importedAt",
    });
  }
  const boundedNotes = notes
    .slice(0, MAX_IMPORT_PROVENANCE_NOTES)
    .map((note) => boundedGeneratedText(note));
  return {
    source,
    label: boundedGeneratedText(label),
    importedAt: importedAt ?? null,
    sha256,
    deterministic: false,
    ...(boundedNotes.length === 0 ? {} : { notes: boundedNotes }),
  };
}

function isIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (daysInMonth[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function defaultKind(): RunKind {
  // Role describes comparison placement, not whether telemetry is faulty.
  // "normal" is the least presumptive value available in the legacy binary
  // RunKind model; detector analysis remains the source of degradation truth.
  return "normal";
}

function assertReplayRole(value: unknown, path = "options.role"): asserts value is ReplayRunRole {
  if (value !== "candidate" && value !== "baseline") {
    throw importError({
      code: "invalid-value",
      message: "Run role must be either candidate or baseline.",
      path,
    });
  }
}

function assertRunKind(
  value: unknown,
  path = "options.kind",
): asserts value is RunKind | undefined {
  if (value !== undefined && value !== "normal" && value !== "faulty") {
    throw importError({
      code: "invalid-value",
      message: "Run kind must be either normal or faulty.",
      path,
    });
  }
}

function withoutByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function fileStem(name: string): string {
  const lastSegment = name.split(/[\\/]/).at(-1) ?? name;
  const withoutExtension = lastSegment.replace(/\.(?:jsonl|ndjson|json|csv)$/i, "");
  return withoutExtension.trim() || "Imported recording";
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "imported-run";
}

function channelAvailability(
  samples: readonly SessionTelemetrySample[],
): ImportChannelAvailability {
  const totalSamples = samples.length;
  const entry = (sampleCount: number): ImportChannelAvailabilityEntry => ({
    available: sampleCount > 0,
    sampleCount,
    totalSamples,
  });
  const count = (field: keyof Omit<SessionTelemetrySample, "timestamp" | "pose">): number =>
    samples.reduce((total, sample) => total + (sample[field] === null ? 0 : 1), 0);
  return {
    timestamp: entry(totalSamples),
    pose: entry(totalSamples),
    sequence: entry(count("sequence")),
    speed: entry(count("speed")),
    battery: entry(count("battery")),
    current: entry(count("current")),
    state: entry(count("state")),
    latencyMs: entry(count("latencyMs")),
    poseSigma: entry(count("poseSigma")),
  };
}

function inferSampleRate(samples: readonly SessionTelemetrySample[]): number | undefined {
  if (samples.length < 2) {
    return undefined;
  }
  // A full interval array needlessly doubles the numeric working set on large
  // recordings. Uniformly sample at most 4,096 deltas for a stable estimate.
  const maximumIntervals = 4_096;
  const intervalCount = samples.length - 1;
  const sampledIntervalCount = Math.min(intervalCount, maximumIntervals);
  const intervals: number[] = [];
  for (let sampleIndex = 0; sampleIndex < sampledIntervalCount; sampleIndex += 1) {
    const index = 1 + Math.floor((sampleIndex * intervalCount) / sampledIntervalCount);
    const current = samples[index];
    const previous = samples[index - 1];
    if (current !== undefined && previous !== undefined) {
      const interval = current.timestamp - previous.timestamp;
      if (interval > 0 && Number.isFinite(interval)) {
        intervals.push(interval);
      }
    }
  }
  if (intervals.length === 0) {
    return undefined;
  }
  intervals.sort((left, right) => left - right);
  let clusterEnd = intervals.length;
  for (let index = 1; index < intervals.length; index += 1) {
    const lower = intervals[index - 1];
    const upper = intervals[index];
    if (lower !== undefined && upper !== undefined && lower > 0 && upper / lower > 3) {
      clusterEnd = index;
      break;
    }
  }
  let nominalInterval: number;
  if (clusterEnd < intervals.length) {
    const middle = Math.floor(clusterEnd / 2);
    nominalInterval =
      clusterEnd % 2 === 0
        ? ((intervals[middle - 1] ?? 0) + (intervals[middle] ?? 0)) / 2
        : (intervals[middle] ?? 0);
  } else {
    nominalInterval = intervals[Math.floor((intervals.length - 1) * 0.25)] ?? 0;
  }
  if (nominalInterval <= 0) {
    return undefined;
  }
  const inferred = 1 / nominalInterval;
  return sampleRateConfigurationIssue(inferred) === null ? inferred : undefined;
}

function normalizeTimestamp(timestamp: number, origin: number): number {
  const normalized = Number((timestamp - origin).toFixed(9));
  return Object.is(normalized, -0) ? 0 : normalized;
}

function warningsForPartialChannels(availability: ImportChannelAvailability): ImportWarning[] {
  const warnings: ImportWarning[] = [];
  for (const field of [
    "sequence",
    "speed",
    "battery",
    "current",
    "state",
    "latencyMs",
    "poseSigma",
  ] as const) {
    const channel = availability[field];
    if (channel.sampleCount > 0 && channel.sampleCount < channel.totalSamples) {
      warnings.push({
        code: "partial-channel",
        field,
        path: `samples.${field}`,
        message: `${field} is present in ${channel.sampleCount} of ${channel.totalSamples} samples; missing values remain null.`,
      });
    }
  }
  return warnings;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid JSON";
    const positionMatch = /position\s+(\d+)/i.exec(message);
    const position = positionMatch === null ? undefined : Number(positionMatch[1]);
    let line: number | undefined;
    let column: number | undefined;
    if (position !== undefined && Number.isInteger(position)) {
      let lastNewline = -1;
      line = 1;
      for (let index = 0; index < position; index += 1) {
        if (text.charCodeAt(index) === 0x0a) {
          line += 1;
          lastNewline = index;
        }
      }
      column = position - lastNewline;
    }
    throw importError({
      code: "invalid-json",
      message: `Unable to parse JSON: ${message}`,
      path: "$",
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    });
  }
}

function issueFromLegacyError(error: TelemetryParseError): ImportIssue {
  const path =
    /(?:^|\s)((?:run\.)?samples\[\d+\](?:\.[A-Za-z0-9_]+)*|run\.[A-Za-z0-9_.]+)/.exec(
      error.message,
    )?.[1] ?? "$";
  return {
    code: error.message.includes("timestamp must be greater") ? "timestamp-order" : "invalid-value",
    message: error.message,
    path,
  };
}

/**
 * Parse either a canonical robot-replay/session/2.0 document or a strict
 * legacy TelemetryRun document. Legacy input is returned as a role-labelled
 * v2 run so callers can attach it without fabricating the other comparison.
 */
function parseSessionJsonSource(
  text: string,
  options: ParseSessionJsonOptions = {},
  verifiedSource?: VerifiedParserSource,
): ImportedRecording {
  const { byteLength, sha256 } = parserSource(text, verifiedSource);
  if (text.trim() === "") {
    throw importError({ code: "empty-input", message: "JSON input is empty.", path: "$" });
  }
  if (options.role !== undefined) {
    assertReplayRole(options.role);
  }
  const label = sourceName(options, "recording.json");
  const decoded = parseJson(withoutByteOrderMark(text));

  if (isRecord(decoded) && hasOwn(decoded, "schema")) {
    if (decoded.schema !== REPLAY_SESSION_SCHEMA) {
      throw importError({
        code: "unsupported-schema",
        message: `Expected schema ${REPLAY_SESSION_SCHEMA}; received ${String(decoded.schema)}.`,
        path: "schema",
      });
    }
    assertCanonicalImportLimits(decoded);
    const session = parseCanonicalSession(decoded, {
      label,
      sha256,
      importedAt: options.importedAt,
    });
    return {
      kind: "session",
      format: "json",
      sourceName: label,
      byteLength,
      sha256,
      warnings: [],
      session,
    };
  }

  const legacyValue = isRecord(decoded) && hasOwn(decoded, "run") ? decoded.run : decoded;
  if (isRecord(legacyValue) && Array.isArray(legacyValue.samples)) {
    assertImportedSampleCount(legacyValue.samples.length, "samples");
  }
  try {
    const legacyRun = parseTelemetryJson(legacyValue);
    assertImportedSampleCount(legacyRun.samples.length, "samples");
    const role = options.role ?? "candidate";
    const run = sessionRunFromTelemetryRun(legacyRun, role);
    const origin = run.samples[0]?.timestamp ?? 0;
    run.samples = run.samples.map((sample) => ({
      ...sample,
      timestamp: normalizeTimestamp(sample.timestamp, origin),
    }));
    assertImportedRunTextLimits(run);
    const availability = channelAvailability(run.samples);
    const warnings = warningsForPartialChannels(availability);
    if (options.role === undefined) {
      appendWarning(warnings, {
        code: "legacy-role-defaulted",
        message:
          "Legacy JSON does not encode a comparison role; it was assigned to candidate. Choose an explicit role when attaching it to an existing session.",
        path: "options.role",
      });
    }
    return {
      kind: "run",
      format: "json",
      role,
      run,
      provenance: provenanceFor("json", label, sha256, options.importedAt, [
        "Adapted from the legacy TelemetryRun JSON model.",
        `Timestamps rebased from source origin ${String(origin)} seconds.`,
        ...(options.role === undefined
          ? ["Comparison role was not encoded by the legacy document and defaulted to candidate."]
          : []),
      ]),
      availability,
      timeOriginSeconds: origin,
      timeOriginExact: `${String(origin)} seconds`,
      sourceName: label,
      byteLength,
      sha256,
      warnings,
    };
  } catch (error) {
    if (error instanceof TelemetryParseError) {
      throw new RecordingImportError([issueFromLegacyError(error)]);
    }
    throw error;
  }
}

export function parseSessionJson(
  text: string,
  options: ParseSessionJsonOptions = {},
): ImportedRecording {
  return parseSessionJsonSource(text, options);
}

interface CanonicalContext {
  label: string;
  sha256: string;
  importedAt?: string | null;
}

function canonicalLineageNotes(original: SessionProvenance): string[] {
  const originalNotes = original.notes ?? [];
  const previousLineageNotes = originalNotes.filter((note) =>
    note.startsWith(IMPORT_LINEAGE_NOTE_PREFIX),
  );
  const sourceNotes = originalNotes.filter((note) => !note.startsWith(IMPORT_LINEAGE_NOTE_PREFIX));
  const maximumCarriedNotes = MAX_IMPORT_PROVENANCE_NOTES - 1;
  const carriedNotes = sourceNotes
    .slice(0, maximumCarriedNotes)
    .map((note) => boundedGeneratedText(note));
  const omittedNotes = sourceNotes.length - carriedNotes.length;
  const priorLineageDigest =
    previousLineageNotes.length === 0 ? "none" : sha256Text(previousLineageNotes.join("\n"));
  const summary = [
    `${IMPORT_LINEAGE_NOTE_PREFIX}source=${original.source}`,
    `importedAt=${original.importedAt ?? "not-recorded"}`,
    `sha256=${original.sha256}`,
    `deterministic=${original.deterministic ? "yes" : "no"}`,
    `parent=${original.parentSessionId ?? "none"}`,
    `rootSha256=${original.rootSessionSha256 ?? "none"}`,
    `notesRetained=${carriedNotes.length}/${sourceNotes.length}`,
    `notesOmitted=${omittedNotes}`,
    `priorLineageSha256=${priorLineageDigest}`,
    `label=${JSON.stringify(original.label)}`,
  ].join("; ");
  return [boundedGeneratedText(summary), ...carriedNotes];
}

function parseCanonicalSession(
  root: Record<string, unknown>,
  context: CanonicalContext,
): ReplaySessionV2 {
  const issues = new IssueCollector();
  const id = requiredIdentifier(root.id, "id", issues);
  const mission = parseMission(root.mission, "mission", issues);
  const robot = parseRobot(root.robot, "robot", issues);
  const coordinateFrame = parseCoordinateFrame(root.coordinateFrame, "coordinateFrame", issues);
  const environment = parseEnvironment(root.environment, "environment", issues);
  const plannedRoute = parsePlannedRoute(root.plannedRoute, "plannedRoute", issues);
  const runsRecord = requiredRecord(root.runs, "runs", issues);
  const candidate = parseSessionRun(runsRecord.candidate, "runs.candidate", "candidate", issues);
  const baseline =
    runsRecord.baseline === undefined
      ? undefined
      : parseSessionRun(runsRecord.baseline, "runs.baseline", "baseline", issues);
  const detectors = parseDetectorConfiguration(root.detectors, "detectors", issues);
  const annotations = parseAnnotations(root.annotations, "annotations", issues);
  const transformations = parseTransformations(
    root.transformations,
    "transformations",
    candidate,
    issues,
  );
  const originalProvenance = parseProvenance(root.provenance, "provenance", issues);
  issues.throwIfAny();

  const notes = canonicalLineageNotes(originalProvenance);
  const session: ReplaySessionV2 = {
    schema: REPLAY_SESSION_SCHEMA,
    id,
    mission,
    robot,
    coordinateFrame,
    environment,
    plannedRoute,
    runs: { candidate, ...(baseline === undefined ? {} : { baseline }) },
    detectors,
    annotations,
    transformations,
    provenance: {
      ...provenanceFor("json", context.label, context.sha256, context.importedAt, notes),
      ...(originalProvenance.rootSessionSha256 === undefined
        ? {}
        : { rootSessionSha256: originalProvenance.rootSessionSha256 }),
      ...(originalProvenance.parentSessionId === undefined
        ? {}
        : { parentSessionId: originalProvenance.parentSessionId }),
    },
  };
  try {
    assertReplaySession(session);
  } catch (error) {
    if (error instanceof Error && "issues" in error && Array.isArray(error.issues)) {
      const validationIssues = error.issues as Array<{ path: string; message: string }>;
      throw new RecordingImportError(
        validationIssues.slice(0, MAX_IMPORT_ISSUES).map(({ path, message }) => ({
          code: "invalid-value",
          path,
          message: `${path}: ${message}`,
        })),
        validationIssues.length,
      );
    }
    throw error;
  }
  // Every nested value above was parsed into a fresh domain object already;
  // cloning again would briefly duplicate the entire normalized recording.
  return session;
}

function requiredRecord(
  value: unknown,
  path: string,
  issues: IssueCollector,
): Record<string, unknown> {
  if (!isRecord(value)) {
    issues.add({ code: "missing-field", message: `${path} must be an object.`, path });
    return {};
  }
  return value;
}

function requiredString(value: unknown, path: string, issues: IssueCollector): string {
  if (typeof value !== "string" || value.trim() === "") {
    issues.add({
      code: value === undefined ? "missing-field" : "invalid-value",
      message: `${path} must be a non-empty string.`,
      path,
    });
    return "invalid";
  }
  if (value.length > MAX_IMPORT_STRING_LENGTH) {
    issues.add({
      code: "invalid-value",
      message: `${path} must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
      path,
    });
  }
  return value;
}

function requiredIdentifier(value: unknown, path: string, issues: IssueCollector): string {
  const identifier = requiredString(value, path, issues);
  if (identifier === "invalid") {
    return identifier;
  }
  if (identifier !== identifier.trim()) {
    issues.add({
      code: "invalid-value",
      message: `${path} must not contain leading or trailing whitespace.`,
      path,
    });
  }
  if (identifier !== identifier.normalize("NFC")) {
    issues.add({
      code: "invalid-value",
      message: `${path} must use NFC Unicode normalization.`,
      path,
    });
  }
  if (identifier.length > 128) {
    issues.add({
      code: "invalid-value",
      message: `${path} must contain at most 128 characters.`,
      path,
    });
  }
  return identifier;
}

function requireUniqueIdentifiers(
  entries: readonly { id: string }[],
  path: string,
  issues: IssueCollector,
): void {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.id)) {
      issues.add({
        code: "duplicate-field",
        message: `${path}[${index}].id duplicates identifier ${JSON.stringify(entry.id)}.`,
        path: `${path}[${index}].id`,
      });
    }
    seen.add(entry.id);
  });
}

function optionalString(value: unknown, path: string, issues: IssueCollector): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim() === "") {
    issues.add({ code: "invalid-value", message: `${path} must be a non-empty string.`, path });
    return undefined;
  }
  if (value.length > MAX_IMPORT_STRING_LENGTH) {
    issues.add({
      code: "invalid-value",
      message: `${path} must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
      path,
    });
  }
  return value;
}

function finiteNumber(value: unknown, path: string, issues: IssueCollector): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add({
      code: value === undefined ? "missing-field" : "invalid-value",
      message: `${path} must be a finite number.`,
      path,
    });
    return Number.NaN;
  }
  return value;
}

function positiveNumber(value: unknown, path: string, issues: IssueCollector): number {
  const number = finiteNumber(value, path, issues);
  if (number <= 0) {
    issues.add({ code: "invalid-value", message: `${path} must be greater than zero.`, path });
  }
  return number;
}

function nonNegativeNumber(value: unknown, path: string, issues: IssueCollector): number {
  const number = finiteNumber(value, path, issues);
  if (number < 0) {
    issues.add({ code: "invalid-value", message: `${path} must not be negative.`, path });
  }
  return number;
}

function requiredBoolean(value: unknown, path: string, issues: IssueCollector): boolean {
  if (typeof value !== "boolean") {
    issues.add({
      code: value === undefined ? "missing-field" : "invalid-value",
      message: `${path} must be a boolean.`,
      path,
    });
    return false;
  }
  return value;
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
  issues: IssueCollector,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    issues.add({
      code: value === undefined ? "missing-field" : "invalid-value",
      message: `${path} must be one of: ${values.join(", ")}.`,
      path,
    });
    return values[0] as Values[number];
  }
  return value as Values[number];
}

function stringArray(value: unknown, path: string, issues: IssueCollector): string[] {
  if (!Array.isArray(value)) {
    issues.add({ code: "missing-field", message: `${path} must be an array.`, path });
    return [];
  }
  return value.map((entry, index) => requiredString(entry, `${path}[${index}]`, issues));
}

function parseMission(value: unknown, path: string, issues: IssueCollector): MissionMetadata {
  const record = requiredRecord(value, path, issues);
  return {
    id: requiredIdentifier(record.id, `${path}.id`, issues),
    title: requiredString(record.title, `${path}.title`, issues),
    subtitle: requiredString(record.subtitle, `${path}.subtitle`, issues),
    site: requiredString(record.site, `${path}.site`, issues),
    objective: requiredString(record.objective, `${path}.objective`, issues),
    outcome: enumValue(
      record.outcome,
      ["nominal", "degraded", "safe-stop"],
      `${path}.outcome`,
      issues,
    ),
    scenario: requiredString(record.scenario, `${path}.scenario`, issues),
    tags: stringArray(record.tags, `${path}.tags`, issues),
  };
}

function parseRobot(value: unknown, path: string, issues: IssueCollector): RobotMetadata {
  const record = requiredRecord(value, path, issues);
  const footprint = requiredRecord(record.footprint, `${path}.footprint`, issues);
  const nominalVoltage =
    record.nominalVoltage === undefined
      ? undefined
      : positiveNumber(record.nominalVoltage, `${path}.nominalVoltage`, issues);
  return {
    id: requiredIdentifier(record.id, `${path}.id`, issues),
    name: requiredString(record.name, `${path}.name`, issues),
    model: requiredString(record.model, `${path}.model`, issues),
    drive: enumValue(
      record.drive,
      ["differential", "ackermann", "omnidirectional", "unknown"],
      `${path}.drive`,
      issues,
    ),
    footprint: {
      length: positiveNumber(footprint.length, `${path}.footprint.length`, issues),
      width: positiveNumber(footprint.width, `${path}.footprint.width`, issues),
      safetyMargin: nonNegativeNumber(
        footprint.safetyMargin,
        `${path}.footprint.safetyMargin`,
        issues,
      ),
    },
    ...(nominalVoltage === undefined ? {} : { nominalVoltage }),
  };
}

function parseCoordinateFrame(
  value: unknown,
  path: string,
  issues: IssueCollector,
): CoordinateFrame {
  const record = requiredRecord(value, path, issues);
  const parent =
    record.parent === undefined
      ? undefined
      : requiredIdentifier(record.parent, `${path}.parent`, issues);
  return {
    id: requiredIdentifier(record.id, `${path}.id`, issues),
    label: requiredString(record.label, `${path}.label`, issues),
    ...(parent === undefined ? {} : { parent }),
    convention: enumValue(
      record.convention,
      ["x-east-y-north", "x-forward-y-left"],
      `${path}.convention`,
      issues,
    ),
    linearUnit: enumValue(record.linearUnit, ["metre"], `${path}.linearUnit`, issues),
    angularUnit: enumValue(record.angularUnit, ["radian"], `${path}.angularUnit`, issues),
  };
}

function parseEnvironment(value: unknown, path: string, issues: IssueCollector): ReplayEnvironment {
  const record = requiredRecord(value, path, issues);
  const floor = requiredRecord(record.floorBounds, `${path}.floorBounds`, issues);
  const minX = finiteNumber(floor.minX, `${path}.floorBounds.minX`, issues);
  const maxX = finiteNumber(floor.maxX, `${path}.floorBounds.maxX`, issues);
  const minY = finiteNumber(floor.minY, `${path}.floorBounds.minY`, issues);
  const maxY = finiteNumber(floor.maxY, `${path}.floorBounds.maxY`, issues);
  if (maxX <= minX) {
    issues.add({
      code: "invalid-value",
      message: `${path}.floorBounds.maxX must exceed minX.`,
      path: `${path}.floorBounds.maxX`,
    });
  }
  if (maxY <= minY) {
    issues.add({
      code: "invalid-value",
      message: `${path}.floorBounds.maxY must exceed minY.`,
      path: `${path}.floorBounds.maxY`,
    });
  }
  const objects: EnvironmentObject[] = [];
  if (!Array.isArray(record.objects)) {
    issues.add({
      code: "missing-field",
      message: `${path}.objects must be an array.`,
      path: `${path}.objects`,
    });
  } else {
    record.objects.forEach((entry, index) => {
      const objectPath = `${path}.objects[${index}]`;
      const object = requiredRecord(entry, objectPath, issues);
      objects.push({
        id: requiredIdentifier(object.id, `${objectPath}.id`, issues),
        label: requiredString(object.label, `${objectPath}.label`, issues),
        kind: enumValue(
          object.kind,
          ["rack", "wall", "dock", "goal", "obstacle"],
          `${objectPath}.kind`,
          issues,
        ),
        x: finiteNumber(object.x, `${objectPath}.x`, issues),
        y: finiteNumber(object.y, `${objectPath}.y`, issues),
        width: positiveNumber(object.width, `${objectPath}.width`, issues),
        depth: positiveNumber(object.depth, `${objectPath}.depth`, issues),
        height: nonNegativeNumber(object.height, `${objectPath}.height`, issues),
      });
    });
  }
  requireUniqueIdentifiers(objects, `${path}.objects`, issues);
  return {
    name: requiredString(record.name, `${path}.name`, issues),
    floorBounds: { minX, maxX, minY, maxY },
    objects,
  };
}

function parsePlannedRoute(value: unknown, path: string, issues: IssueCollector): PlannedRoute {
  const record = requiredRecord(value, path, issues);
  const source = enumValue(
    record.source,
    ["mission-plan", "inferred-observation"],
    `${path}.source`,
    issues,
  );
  const waypoints: PlannedRoute["waypoints"] = [];
  if (!Array.isArray(record.waypoints)) {
    issues.add({
      code: "missing-field",
      message: `${path}.waypoints must be an array.`,
      path: `${path}.waypoints`,
    });
  } else {
    record.waypoints.forEach((entry, index) => {
      const waypointPath = `${path}.waypoints[${index}]`;
      const waypoint = requiredRecord(entry, waypointPath, issues);
      const yaw =
        waypoint.yaw === undefined
          ? undefined
          : finiteNumber(waypoint.yaw, `${waypointPath}.yaw`, issues);
      const label = optionalString(waypoint.label, `${waypointPath}.label`, issues);
      waypoints.push({
        id: requiredIdentifier(waypoint.id, `${waypointPath}.id`, issues),
        x: finiteNumber(waypoint.x, `${waypointPath}.x`, issues),
        y: finiteNumber(waypoint.y, `${waypointPath}.y`, issues),
        ...(yaw === undefined ? {} : { yaw }),
        ...(label === undefined ? {} : { label }),
      });
    });
  }
  if (waypoints.length < 2) {
    issues.add({
      code: "invalid-value",
      message: `${path}.waypoints must contain at least two waypoints.`,
      path: `${path}.waypoints`,
    });
  }
  requireUniqueIdentifiers(waypoints, `${path}.waypoints`, issues);
  return {
    id: requiredIdentifier(record.id, `${path}.id`, issues),
    name: requiredString(record.name, `${path}.name`, issues),
    source,
    waypoints,
    corridorWidth: positiveNumber(record.corridorWidth, `${path}.corridorWidth`, issues),
    closed: requiredBoolean(record.closed, `${path}.closed`, issues),
  };
}

function nullableFiniteNumber(value: unknown, path: string, issues: IssueCollector): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  return finiteNumber(value, path, issues);
}

function nullableState(value: unknown, path: string, issues: IssueCollector): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requiredString(value, path, issues);
}

function parseSessionSample(
  value: unknown,
  path: string,
  issues: IssueCollector,
): SessionTelemetrySample {
  const record = requiredRecord(value, path, issues);
  const pose = requiredRecord(record.pose, `${path}.pose`, issues);
  const sequence = nullableFiniteNumber(record.sequence, `${path}.sequence`, issues);
  if (
    sequence !== null &&
    Number.isFinite(sequence) &&
    (!Number.isSafeInteger(sequence) || sequence < 0)
  ) {
    issues.add({
      code: "invalid-value",
      message: `${path}.sequence must be null or a non-negative safe integer.`,
      path: `${path}.sequence`,
    });
  }
  const battery = nullableFiniteNumber(record.battery, `${path}.battery`, issues);
  if (battery !== null && Number.isFinite(battery) && (battery < 0 || battery > 100)) {
    issues.add({
      code: "invalid-value",
      message: `${path}.battery must be between 0 and 100.`,
      path: `${path}.battery`,
    });
  }
  const latencyMs = nullableFiniteNumber(record.latencyMs, `${path}.latencyMs`, issues);
  if (latencyMs !== null && Number.isFinite(latencyMs) && latencyMs < 0) {
    issues.add({
      code: "invalid-value",
      message: `${path}.latencyMs must not be negative.`,
      path: `${path}.latencyMs`,
    });
  }
  const poseSigma = nullableFiniteNumber(record.poseSigma, `${path}.poseSigma`, issues);
  if (poseSigma !== null && Number.isFinite(poseSigma) && poseSigma < 0) {
    issues.add({
      code: "invalid-value",
      message: `${path}.poseSigma must not be negative.`,
      path: `${path}.poseSigma`,
    });
  }
  return {
    timestamp: nonNegativeNumber(record.timestamp, `${path}.timestamp`, issues),
    pose: {
      x: finiteNumber(pose.x, `${path}.pose.x`, issues),
      y: finiteNumber(pose.y, `${path}.pose.y`, issues),
      yaw: finiteNumber(pose.yaw, `${path}.pose.yaw`, issues),
    },
    sequence,
    speed: nullableFiniteNumber(record.speed, `${path}.speed`, issues),
    battery,
    current: nullableFiniteNumber(record.current, `${path}.current`, issues),
    state: nullableState(record.state, `${path}.state`, issues),
    latencyMs,
    poseSigma,
  };
}

function parseSessionRun(
  value: unknown,
  path: string,
  expectedRole: ReplayRunRole,
  issues: IssueCollector,
): ReplaySessionRun {
  const record = requiredRecord(value, path, issues);
  const role = enumValue(record.role, ["candidate", "baseline"], `${path}.role`, issues);
  if (role !== expectedRole) {
    issues.add({
      code: "invalid-value",
      message: `${path}.role must equal ${expectedRole}.`,
      path: `${path}.role`,
    });
  }
  const samples: SessionTelemetrySample[] = [];
  if (!Array.isArray(record.samples) || record.samples.length === 0) {
    issues.add({
      code: record.samples === undefined ? "missing-field" : "invalid-value",
      message: `${path}.samples must be a non-empty array.`,
      path: `${path}.samples`,
    });
  } else {
    record.samples.forEach((sample, index) => {
      samples.push(parseSessionSample(sample, `${path}.samples[${index}]`, issues));
    });
    for (let index = 1; index < samples.length; index += 1) {
      if ((samples[index]?.timestamp ?? 0) <= (samples[index - 1]?.timestamp ?? 0)) {
        issues.add({
          code: "timestamp-order",
          message: `${path}.samples[${index}].timestamp must increase strictly.`,
          path: `${path}.samples[${index}].timestamp`,
        });
      }
    }
  }
  const description = optionalString(record.description, `${path}.description`, issues);
  const sampleRateHz =
    record.sampleRateHz === undefined
      ? undefined
      : positiveNumber(record.sampleRateHz, `${path}.sampleRateHz`, issues);
  if (sampleRateHz !== undefined) {
    const sampleRateIssue = sampleRateConfigurationIssue(sampleRateHz);
    if (sampleRateIssue !== null) {
      issues.add({
        code: "invalid-value",
        message: `${path}.sampleRateHz ${sampleRateIssue}.`,
        path: `${path}.sampleRateHz`,
      });
    }
  }
  return {
    id: requiredIdentifier(record.id, `${path}.id`, issues),
    name: requiredString(record.name, `${path}.name`, issues),
    role: expectedRole,
    kind: enumValue(record.kind, ["normal", "faulty"], `${path}.kind`, issues),
    samples,
    ...(description === undefined ? {} : { description }),
    ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
  };
}

function parseDetectorConfiguration(
  value: unknown,
  path: string,
  issues: IssueCollector,
): DetectorConfiguration {
  const record = requiredRecord(value, path, issues);
  const rulesRecord = requiredRecord(record.rules, `${path}.rules`, issues);
  const rules = {} as Record<DetectorId, DetectorRuleConfig>;
  for (const detectorId of DETECTOR_IDS) {
    const rulePath = `${path}.rules.${detectorId}`;
    const rule = requiredRecord(rulesRecord[detectorId], rulePath, issues);
    const parsedId = enumValue(rule.id, [detectorId], `${rulePath}.id`, issues);
    const parsedRule: DetectorRuleConfig = {
      id: parsedId,
      label: requiredString(rule.label, `${rulePath}.label`, issues),
      version: enumValue(
        rule.version,
        [DETECTOR_CONFIGURATION_VERSION],
        `${rulePath}.version`,
        issues,
      ),
      enabled: requiredBoolean(rule.enabled, `${rulePath}.enabled`, issues),
      threshold: finiteNumber(rule.threshold, `${rulePath}.threshold`, issues),
      minimumDuration: finiteNumber(rule.minimumDuration, `${rulePath}.minimumDuration`, issues),
      severity: enumValue(rule.severity, ["warning", "critical"], `${rulePath}.severity`, issues),
    };
    rules[detectorId] = parsedRule;
    for (const message of detectorRuleConfigurationIssues(detectorId, parsedRule)) {
      const suffix = message.startsWith("threshold") ? "threshold" : "minimumDuration";
      issues.add({
        code: "invalid-value",
        message: `${rulePath}.${suffix} ${message}.`,
        path: `${rulePath}.${suffix}`,
      });
    }
  }
  return {
    version: enumValue(record.version, [DETECTOR_CONFIGURATION_VERSION], `${path}.version`, issues),
    rules,
  };
}

function parseAnnotations(
  value: unknown,
  path: string,
  issues: IssueCollector,
): ReplayAnnotation[] {
  if (!Array.isArray(value)) {
    issues.add({ code: "missing-field", message: `${path} must be an array.`, path });
    return [];
  }
  const annotations = value.map((entry, index) => {
    const annotationPath = `${path}[${index}]`;
    const annotation = requiredRecord(entry, annotationPath, issues);
    return {
      id: requiredIdentifier(annotation.id, `${annotationPath}.id`, issues),
      timestamp: nonNegativeNumber(annotation.timestamp, `${annotationPath}.timestamp`, issues),
      label: requiredString(annotation.label, `${annotationPath}.label`, issues),
      body: requiredString(annotation.body, `${annotationPath}.body`, issues),
      author: requiredString(annotation.author, `${annotationPath}.author`, issues),
    };
  });
  requireUniqueIdentifiers(annotations, path, issues);
  return annotations;
}

function parseTransformations(
  value: unknown,
  path: string,
  candidate: ReplaySessionRun,
  issues: IssueCollector,
): AppliedFaultTransformation[] {
  if (!Array.isArray(value)) {
    issues.add({ code: "missing-field", message: `${path} must be an array.`, path });
    return [];
  }
  const firstTimestamp = candidate.samples[0]?.timestamp ?? 0;
  const lastTimestamp = candidate.samples.at(-1)?.timestamp ?? 0;
  const transformations = value.map((entry, index) => {
    const transformationPath = `${path}[${index}]`;
    const transformation = requiredRecord(entry, transformationPath, issues);
    const type = enumValue(
      transformation.type,
      ["packet-dropout", "pose-reset", "motor-load"],
      `${transformationPath}.type`,
      issues,
    );
    const parametersRecord = requiredRecord(
      transformation.parameters,
      `${transformationPath}.parameters`,
      issues,
    );
    const expectedParameterKeys =
      type === "packet-dropout"
        ? (["duration"] as const)
        : type === "pose-reset"
          ? (["offsetX", "offsetY", "offsetYaw"] as const)
          : (["duration", "multiplier"] as const);
    for (const key of Object.keys(parametersRecord)) {
      if (!(expectedParameterKeys as readonly string[]).includes(key)) {
        issues.add({
          code: "invalid-value",
          message: `${transformationPath}.parameters.${key} is not valid for ${type}.`,
          path: `${transformationPath}.parameters.${key}`,
        });
      }
    }
    const parameters = Object.fromEntries(
      expectedParameterKeys.map((key) => [
        key,
        finiteNumber(parametersRecord[key], `${transformationPath}.parameters.${key}`, issues),
      ]),
    );
    const range = (key: string, minimum: number, maximum: number): void => {
      const parameter = parameters[key];
      if (
        parameter !== undefined &&
        Number.isFinite(parameter) &&
        (parameter < minimum || parameter > maximum)
      ) {
        issues.add({
          code: "invalid-value",
          message: `${transformationPath}.parameters.${key} must be between ${minimum} and ${maximum}.`,
          path: `${transformationPath}.parameters.${key}`,
        });
      }
    };
    if (type === "packet-dropout") {
      range("duration", 0.1, 3);
    } else if (type === "pose-reset") {
      range("offsetX", -2, 2);
      range("offsetY", -2, 2);
      range("offsetYaw", -Math.PI / 2, Math.PI / 2);
      if (parameters.offsetX === 0 && parameters.offsetY === 0 && parameters.offsetYaw === 0) {
        issues.add({
          code: "invalid-value",
          message: `${transformationPath}.parameters must include at least one non-zero pose offset.`,
          path: `${transformationPath}.parameters`,
        });
      }
    } else {
      range("duration", 0.5, 5);
      range("multiplier", 1, 3);
      if (parameters.multiplier === 1) {
        issues.add({
          code: "invalid-value",
          message: `${transformationPath}.parameters.multiplier must change the recorded current.`,
          path: `${transformationPath}.parameters.multiplier`,
        });
      }
    }
    const affectedSamples = nonNegativeNumber(
      transformation.affectedSamples,
      `${transformationPath}.affectedSamples`,
      issues,
    );
    if (
      Number.isFinite(affectedSamples) &&
      (!Number.isSafeInteger(affectedSamples) ||
        affectedSamples <= 0 ||
        affectedSamples > MAX_IMPORT_SAMPLES)
    ) {
      issues.add({
        code: "invalid-value",
        message: `${transformationPath}.affectedSamples must be a positive safe integer no greater than ${MAX_IMPORT_SAMPLES}.`,
        path: `${transformationPath}.affectedSamples`,
      });
    }
    const startTimestamp = nonNegativeNumber(
      transformation.startTimestamp,
      `${transformationPath}.startTimestamp`,
      issues,
    );
    const endTimestamp = nonNegativeNumber(
      transformation.endTimestamp,
      `${transformationPath}.endTimestamp`,
      issues,
    );
    if (
      Number.isFinite(startTimestamp) &&
      (startTimestamp < firstTimestamp || startTimestamp > lastTimestamp)
    ) {
      issues.add({
        code: "invalid-value",
        message: `${transformationPath}.startTimestamp must fall inside the candidate run.`,
        path: `${transformationPath}.startTimestamp`,
      });
    }
    if ((type === "packet-dropout" || type === "motor-load") && startTimestamp >= lastTimestamp) {
      issues.add({
        code: "invalid-value",
        message: `${transformationPath}.startTimestamp must precede the final candidate sample for ${type}.`,
        path: `${transformationPath}.startTimestamp`,
      });
    }
    if (
      Number.isFinite(startTimestamp) &&
      Number.isFinite(endTimestamp) &&
      endTimestamp < startTimestamp
    ) {
      issues.add({
        code: "invalid-value",
        message: `${transformationPath}.endTimestamp must not precede startTimestamp.`,
        path: `${transformationPath}.endTimestamp`,
      });
    }
    const duration = parameters.duration;
    const expectedEndTimestamp =
      type === "pose-reset" || duration === undefined || !Number.isFinite(duration)
        ? lastTimestamp
        : Math.min(lastTimestamp, startTimestamp + duration);
    if (
      Number.isFinite(endTimestamp) &&
      Number.isFinite(expectedEndTimestamp) &&
      Math.abs(endTimestamp - expectedEndTimestamp) > 1e-9
    ) {
      issues.add({
        code: "invalid-value",
        message: `${transformationPath}.endTimestamp does not match the ${type} transformation window.`,
        path: `${transformationPath}.endTimestamp`,
      });
    }
    return {
      id: requiredIdentifier(transformation.id, `${transformationPath}.id`, issues),
      type,
      startTimestamp,
      endTimestamp,
      parameters,
      affectedSamples,
    };
  });
  requireUniqueIdentifiers(transformations, path, issues);
  return transformations;
}

function parseProvenance(value: unknown, path: string, issues: IssueCollector): SessionProvenance {
  const record = requiredRecord(value, path, issues);
  const importedAt =
    record.importedAt === null
      ? null
      : requiredString(record.importedAt, `${path}.importedAt`, issues);
  if (importedAt !== null && importedAt !== "invalid" && !isIsoTimestamp(importedAt)) {
    issues.add({
      code: "invalid-value",
      message: `${path}.importedAt must be an ISO-8601 timestamp or null.`,
      path: `${path}.importedAt`,
    });
  }
  const sha256 = requiredString(record.sha256, `${path}.sha256`, issues);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    issues.add({
      code: "invalid-value",
      message: `${path}.sha256 must contain 64 lowercase hexadecimal digits.`,
      path: `${path}.sha256`,
    });
  }
  const rootSessionSha256 = optionalString(
    record.rootSessionSha256,
    `${path}.rootSessionSha256`,
    issues,
  );
  if (rootSessionSha256 !== undefined && !/^[0-9a-f]{64}$/.test(rootSessionSha256)) {
    issues.add({
      code: "invalid-value",
      message: `${path}.rootSessionSha256 must contain 64 lowercase hexadecimal digits.`,
      path: `${path}.rootSessionSha256`,
    });
  }
  const parentSessionId =
    record.parentSessionId === undefined
      ? undefined
      : requiredIdentifier(record.parentSessionId, `${path}.parentSessionId`, issues);
  const notes =
    record.notes === undefined ? undefined : stringArray(record.notes, `${path}.notes`, issues);
  return {
    source: enumValue(
      record.source,
      ["synthetic", "json", "csv", "ros-jsonl", "live", "derived"],
      `${path}.source`,
      issues,
    ),
    label: requiredString(record.label, `${path}.label`, issues),
    importedAt,
    sha256,
    deterministic: requiredBoolean(record.deterministic, `${path}.deterministic`, issues),
    ...(rootSessionSha256 === undefined ? {} : { rootSessionSha256 }),
    ...(parentSessionId === undefined ? {} : { parentSessionId }),
    ...(notes === undefined ? {} : { notes }),
  };
}

interface CsvCell {
  value: string;
  line: number;
  column: number;
}

interface CsvRow {
  cells: CsvCell[];
  line: number;
  number: number;
}

/**
 * Scan RFC-4180 rows and release each row immediately after the visitor
 * returns. Calling without a visitor is a low-allocation syntax-validation
 * pass used before semantic parsing begins.
 */
function scanCsvRows(text: string, visitor?: (row: CsvRow) => void): number {
  const issues = new IssueCollector();
  let row: CsvCell[] = [];
  let value = "";
  let line = 1;
  let column = 1;
  let rowLine = 1;
  let cellLine = 1;
  let cellColumn = 1;
  let quoted = false;
  let afterQuote = false;
  let cellHasCharacters = false;
  let cellLength = 0;
  let rowHasNonWhitespace = false;
  let cellCount = 0;
  let rowCount = 0;

  const extendCell = (): void => {
    cellLength += 1;
    if (cellLength > MAX_IMPORT_STRING_LENGTH) {
      throw importError({
        code: "invalid-csv",
        message: `CSV cells may contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
        path: `rows[${rowCount + 1}]`,
        line,
        column,
      });
    }
  };

  const pushCell = (): void => {
    if (cellCount >= MAX_IMPORT_CSV_COLUMNS) {
      throw importError({
        code: "invalid-csv",
        message: `CSV rows may contain at most ${MAX_IMPORT_CSV_COLUMNS} columns.`,
        path: `rows[${rowCount + 1}]`,
        line: rowLine,
        column: cellColumn,
      });
    }
    if (visitor !== undefined) {
      row.push({ value, line: cellLine, column: cellColumn });
    }
    cellCount += 1;
    value = "";
    cellLength = 0;
    afterQuote = false;
    cellHasCharacters = false;
  };
  const pushRow = (): void => {
    pushCell();
    if (!(cellCount === 1 && !rowHasNonWhitespace)) {
      rowCount += 1;
      if (visitor !== undefined) {
        visitor({ cells: row, line: rowLine, number: rowCount });
      }
    }
    if (visitor !== undefined) {
      row = [];
    }
    cellCount = 0;
    rowHasNonWhitespace = false;
  };
  const startNextCell = (): void => {
    cellLine = line;
    cellColumn = column + 1;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          extendCell();
          if (visitor !== undefined) {
            value += '"';
          }
          cellHasCharacters = true;
          rowHasNonWhitespace = true;
          index += 1;
          column += 2;
          continue;
        }
        quoted = false;
        afterQuote = true;
        column += 1;
        continue;
      }
      extendCell();
      if (visitor !== undefined) {
        value += character;
      }
      cellHasCharacters = true;
      if (!/\s/.test(character)) {
        rowHasNonWhitespace = true;
      }
      if (character === "\n") {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
      continue;
    }

    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      if (character === " " || character === "\t") {
        column += 1;
        continue;
      }
      issues.add({
        code: "invalid-csv",
        message: "Unexpected character after a closing quote.",
        path: `line[${line}]`,
        line,
        column,
      });
      extendCell();
      if (visitor !== undefined) {
        value += character;
      }
      cellHasCharacters = true;
      rowHasNonWhitespace = true;
      afterQuote = false;
      column += 1;
      continue;
    }

    if (character === '"' && !cellHasCharacters) {
      quoted = true;
      column += 1;
    } else if (character === '"') {
      issues.add({
        code: "invalid-csv",
        message: "A quote may only begin an empty CSV field; escape literal quotes as two quotes.",
        path: `line[${line}]`,
        line,
        column,
      });
      extendCell();
      if (visitor !== undefined) {
        value += character;
      }
      cellHasCharacters = true;
      rowHasNonWhitespace = true;
      column += 1;
    } else if (character === ",") {
      pushCell();
      startNextCell();
      column += 1;
    } else if (character === "\n" || character === "\r") {
      pushRow();
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      line += 1;
      column = 1;
      rowLine = line;
      cellLine = line;
      cellColumn = 1;
    } else {
      extendCell();
      if (visitor !== undefined) {
        value += character;
      }
      cellHasCharacters = true;
      if (!/\s/.test(character)) {
        rowHasNonWhitespace = true;
      }
      column += 1;
    }
  }
  if (quoted) {
    issues.add({
      code: "invalid-csv",
      message: "Quoted CSV field is not terminated.",
      path: `line[${cellLine}]`,
      line: cellLine,
      column: cellColumn,
    });
  }
  if (cellHasCharacters || cellCount > 0 || afterQuote) {
    pushRow();
  }
  issues.throwIfAny();
  return rowCount;
}

function parseCsvNumber(
  cell: CsvCell | undefined,
  path: string,
  issues: IssueCollector,
  details: { row: number; field: string; required: boolean },
): number | null {
  const raw = cell?.value.trim() ?? "";
  if (raw === "") {
    if (details.required) {
      issues.add({
        code: "missing-field",
        message: `${details.field} is required.`,
        path,
        row: details.row,
        line: cell?.line,
        column: cell?.column,
        field: details.field,
      });
    }
    return null;
  }
  if (raw.length > MAX_CSV_NUMERIC_LITERAL_LENGTH) {
    issues.add({
      code: "invalid-value",
      message: `${details.field} numeric literal may contain at most ${MAX_CSV_NUMERIC_LITERAL_LENGTH} characters.`,
      path,
      row: details.row,
      line: cell?.line,
      column: cell?.column,
      field: details.field,
    });
    return null;
  }
  const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  const value = decimalPattern.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value)) {
    issues.add({
      code: "invalid-value",
      message: `${details.field} must be a finite number; received ${JSON.stringify(raw)}.`,
      path,
      row: details.row,
      line: cell?.line,
      column: cell?.column,
      field: details.field,
    });
    return null;
  }
  return value;
}

interface CsvTimestampSource {
  value: number;
  raw: string;
  /** Preserves any timestamp exactly representable at whole-nanosecond resolution. */
  exactNanoseconds?: bigint;
}

function exactTimestampNanoseconds(raw: string, unit: CsvTimestampUnit): bigint | undefined {
  if (raw.length > 256) {
    return undefined;
  }
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(raw);
  if (match === null) {
    return undefined;
  }
  const exponent = match[5] === undefined ? 0 : Number(match[5]);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) {
    return undefined;
  }
  const integerDigits = match[2] ?? "";
  const fractionalDigits = match[3] ?? match[4] ?? "";
  const significandDigits = `${integerDigits}${fractionalDigits}`.replace(/^0+(?=\d)/, "") || "0";
  const unitPower = unit === "seconds" ? 9 : unit === "milliseconds" ? 6 : 0;
  const decimalPower = unitPower + exponent - fractionalDigits.length;
  let magnitude: bigint;
  if (decimalPower >= 0) {
    magnitude = BigInt(significandDigits) * 10n ** BigInt(decimalPower);
  } else {
    const divisorDigits = -decimalPower;
    if (divisorDigits > significandDigits.length) {
      if (/^0+$/.test(significandDigits)) {
        magnitude = 0n;
      } else {
        return undefined;
      }
    } else {
      const retained = significandDigits.slice(0, significandDigits.length - divisorDigits) || "0";
      const discarded = significandDigits.slice(significandDigits.length - divisorDigits);
      if (!/^0*$/.test(discarded)) {
        return undefined;
      }
      magnitude = BigInt(retained);
    }
  }
  return match[1] === "-" ? -magnitude : magnitude;
}

function nanosecondsToSeconds(value: bigint): number {
  return Number(value / 1_000_000_000n) + Number(value % 1_000_000_000n) / 1_000_000_000;
}

function parseCsvTimestamp(
  cell: CsvCell | undefined,
  path: string,
  issues: IssueCollector,
  details: { row: number; field: string },
  unit: CsvTimestampUnit,
): CsvTimestampSource | null {
  const value = parseCsvNumber(cell, path, issues, { ...details, required: true });
  if (value === null) {
    return null;
  }
  const raw = cell?.value.trim() ?? "";
  const exactNanoseconds = exactTimestampNanoseconds(raw, unit);
  return { value, raw, ...(exactNanoseconds === undefined ? {} : { exactNanoseconds }) };
}

function csvTimestampIsNegative(timestamp: CsvTimestampSource): boolean {
  return timestamp.exactNanoseconds === undefined
    ? timestamp.value < 0
    : timestamp.exactNanoseconds < 0n;
}

function csvTimestampIsNotAfter(
  timestamp: CsvTimestampSource,
  previous: CsvTimestampSource,
): boolean {
  if (timestamp.exactNanoseconds !== undefined && previous.exactNanoseconds !== undefined) {
    return timestamp.exactNanoseconds <= previous.exactNanoseconds;
  }
  return timestamp.value <= previous.value;
}

function csvTimestampSeconds(
  timestamp: CsvTimestampSource,
  origin: CsvTimestampSource | null,
  divisor: number,
): number {
  if (
    origin !== null &&
    timestamp.exactNanoseconds !== undefined &&
    origin.exactNanoseconds !== undefined
  ) {
    return nanosecondsToSeconds(timestamp.exactNanoseconds - origin.exactNanoseconds);
  }
  return (timestamp.value - (origin?.value ?? 0)) / divisor;
}

function csvTimestampOriginSeconds(origin: CsvTimestampSource | null, divisor: number): number {
  if (origin === null) {
    return 0;
  }
  return origin.exactNanoseconds === undefined
    ? origin.value / divisor
    : nanosecondsToSeconds(origin.exactNanoseconds);
}

function csvTimestampOriginExact(
  origin: CsvTimestampSource | null,
  unit: CsvTimestampUnit,
): string {
  return `${origin?.raw ?? "0"} ${unit}`;
}

/**
 * Parse RFC-4180-style CSV telemetry. Required columns are timestamp, x, y,
 * and yaw. Optional columns are sequence, speed, battery, current, state,
 * latency_ms, and pose_sigma; blank optional cells remain null.
 */
function parseTelemetryCsvSource(
  text: string,
  options: ParseTelemetryCsvOptions,
  verifiedSource?: VerifiedParserSource,
): ImportedRunRecording {
  const { byteLength, sha256 } = parserSource(text, verifiedSource);
  if (text.trim() === "") {
    throw importError({ code: "empty-input", message: "CSV input is empty.", path: "$" });
  }
  assertReplayRole(options.role);
  assertRunKind(options.kind);
  assertRunOptionTextLimits(options);
  if (options.yawUnit !== "radians" && options.yawUnit !== "degrees") {
    throw importError({
      code: "invalid-value",
      message: "CSV yaw unit must be either radians or degrees.",
      path: "options.yawUnit",
    });
  }
  const timestampUnit = options.timestampUnit ?? "seconds";
  if (
    timestampUnit !== "seconds" &&
    timestampUnit !== "milliseconds" &&
    timestampUnit !== "nanoseconds"
  ) {
    throw importError({
      code: "invalid-value",
      message: "CSV timestamp unit must be seconds, milliseconds, or nanoseconds.",
      path: "options.timestampUnit",
    });
  }
  const timestampDivisor =
    timestampUnit === "seconds" ? 1 : timestampUnit === "milliseconds" ? 1_000 : 1_000_000_000;
  const label = sourceName(options, "recording.csv");
  const csvText = withoutByteOrderMark(text);
  // Reject malformed quoting before semantic work, without retaining all CSV
  // cells. The second scan materializes at most one row at a time.
  const rowCount = scanCsvRows(csvText);
  if (rowCount < 2) {
    throw importError({
      code: "invalid-csv",
      message: "CSV must contain a header and at least one telemetry row.",
      path: "$",
    });
  }
  assertImportedSampleCount(rowCount - 1, "rows");

  const issues = new IssueCollector();
  const warnings: ImportWarning[] = [];
  if (options.kind === undefined) {
    appendWarning(warnings, {
      code: "run-kind-defaulted",
      message:
        "Run condition was not supplied; recorded as normal because the binary run model has no unknown state. Review detector findings before treating it as nominal.",
      path: "options.kind",
    });
  }
  let headers: string[] = [];
  const indices = new Map<string, number>();
  const samples: SessionTelemetrySample[] = [];
  const shouldNormalize = options.normalizeTimestampOrigin ?? true;
  let sourceTimestampOrigin: CsvTimestampSource | null = null;
  let previousTimestamp: CsvTimestampSource | null = null;
  let previousNormalizedTimestamp: number | null = null;
  let warnedAboutTimestampPrecision = false;
  scanCsvRows(csvText, (row) => {
    if (row.number === 1) {
      if (row.cells.length > MAX_IMPORT_CSV_COLUMNS) {
        throw importError({
          code: "invalid-csv",
          message: `CSV rows may contain at most ${MAX_IMPORT_CSV_COLUMNS} columns.`,
          path: "header",
          line: row.line,
        });
      }
      headers = row.cells.map((cell) => cell.value.trim().toLowerCase());
      headers.forEach((header, index) => {
        if (header === "") {
          issues.add({
            code: "missing-field",
            message: "CSV header names must not be empty.",
            path: `header[${index}]`,
            line: row.line,
            column: row.cells[index]?.column,
          });
          return;
        }
        if (indices.has(header)) {
          issues.add({
            code: "duplicate-field",
            message: `CSV header ${header} is duplicated.`,
            path: `header.${header}`,
            line: row.line,
            column: row.cells[index]?.column,
            field: header,
          });
          return;
        }
        indices.set(header, index);
        if (!(CSV_COLUMNS as readonly string[]).includes(header)) {
          appendWarning(warnings, {
            code: "unknown-column",
            message: `CSV column ${header} is not used.`,
            path: `header.${header}`,
            line: row.line,
            field: header,
          });
        }
      });
      for (const required of REQUIRED_CSV_COLUMNS) {
        if (!indices.has(required)) {
          issues.add({
            code: "missing-field",
            message: `CSV is missing required column ${required}.`,
            path: `header.${required}`,
            line: row.line,
            field: required,
          });
        }
      }
      return;
    }

    const rowNumber = row.number;
    if (row.cells.length > headers.length) {
      issues.add({
        code: "invalid-csv",
        message: `CSV row has ${row.cells.length} fields but the header has ${headers.length}.`,
        path: `rows[${rowNumber}]`,
        row: rowNumber,
        line: row.line,
      });
    }
    const cell = (field: string): CsvCell | undefined => {
      const index = indices.get(field);
      return index === undefined ? undefined : row.cells[index];
    };
    const number = (field: string, required: boolean): number | null =>
      parseCsvNumber(cell(field), `rows[${rowNumber}].${field}`, issues, {
        row: rowNumber,
        field,
        required,
      });
    const timestampSource = parseCsvTimestamp(
      cell("timestamp"),
      `rows[${rowNumber}].timestamp`,
      issues,
      { row: rowNumber, field: "timestamp" },
      timestampUnit,
    );
    if (
      timestampSource !== null &&
      timestampSource.exactNanoseconds === undefined &&
      !warnedAboutTimestampPrecision
    ) {
      appendWarning(warnings, {
        code: "timestamp-precision",
        message:
          "A timestamp is not exactly representable at whole-nanosecond resolution; replay uses its finite floating-point value.",
        path: `rows[${rowNumber}].timestamp`,
        row: rowNumber,
        line: row.line,
        field: "timestamp",
      });
      warnedAboutTimestampPrecision = true;
    }
    const x = number("x", true);
    const y = number("y", true);
    const yawSource = number("yaw", true);
    const sequence = number("sequence", false);
    const speed = number("speed", false);
    const battery = number("battery", false);
    const current = number("current", false);
    const latencyMs = number("latency_ms", false);
    const poseSigma = number("pose_sigma", false);
    const stateRaw = cell("state")?.value.trim() ?? "";

    if (timestampSource !== null && csvTimestampIsNegative(timestampSource)) {
      issues.add({
        code: "invalid-value",
        message: "timestamp must not be negative.",
        path: `rows[${rowNumber}].timestamp`,
        row: rowNumber,
        line: row.line,
        field: "timestamp",
      });
    }
    if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) {
      issues.add({
        code: "invalid-value",
        message: "sequence must be a non-negative safe integer.",
        path: `rows[${rowNumber}].sequence`,
        row: rowNumber,
        line: row.line,
        field: "sequence",
      });
    }
    if (battery !== null && (battery < 0 || battery > 100)) {
      issues.add({
        code: "invalid-value",
        message: "battery must be between 0 and 100 percent.",
        path: `rows[${rowNumber}].battery`,
        row: rowNumber,
        line: row.line,
        field: "battery",
      });
    }
    for (const [field, value] of [
      ["latency_ms", latencyMs],
      ["pose_sigma", poseSigma],
    ] as const) {
      if (value !== null && value < 0) {
        issues.add({
          code: "invalid-value",
          message: `${field} must not be negative.`,
          path: `rows[${rowNumber}].${field}`,
          row: rowNumber,
          line: row.line,
          field,
        });
      }
    }
    if (timestampSource !== null && x !== null && y !== null && yawSource !== null) {
      if (
        !shouldNormalize &&
        (timestampSource.exactNanoseconds === undefined ||
          timestampSource.exactNanoseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
          timestampSource.exactNanoseconds < -BigInt(Number.MAX_SAFE_INTEGER))
      ) {
        issues.add({
          code: "invalid-value",
          message:
            "Absolute timestamp cannot be retained at nanosecond-safe Number precision; enable timestamp-origin normalization.",
          path: `rows[${rowNumber}].timestamp`,
          row: rowNumber,
          line: row.line,
          field: "timestamp",
        });
      }
      const sourceOrderInvalid =
        previousTimestamp !== null && csvTimestampIsNotAfter(timestampSource, previousTimestamp);
      if (sourceOrderInvalid) {
        issues.add({
          code: "timestamp-order",
          message: "timestamp must increase strictly from one telemetry row to the next.",
          path: `rows[${rowNumber}].timestamp`,
          row: rowNumber,
          line: row.line,
          field: "timestamp",
        });
      }
      if (sourceTimestampOrigin === null && shouldNormalize) {
        sourceTimestampOrigin = timestampSource;
      }
      const timestamp = normalizeTimestamp(
        csvTimestampSeconds(timestampSource, sourceTimestampOrigin, timestampDivisor),
        0,
      );
      if (!Number.isFinite(timestamp)) {
        issues.add({
          code: "invalid-value",
          message: "timestamp conversion must produce a finite replay time.",
          path: `rows[${rowNumber}].timestamp`,
          row: rowNumber,
          line: row.line,
          field: "timestamp",
        });
      }
      if (
        !sourceOrderInvalid &&
        previousNormalizedTimestamp !== null &&
        timestamp <= previousNormalizedTimestamp
      ) {
        issues.add({
          code: "timestamp-order",
          message:
            "timestamp must remain strictly increasing after conversion to nanosecond-resolution replay time.",
          path: `rows[${rowNumber}].timestamp`,
          row: rowNumber,
          line: row.line,
          field: "timestamp",
        });
      }
      previousTimestamp = timestampSource;
      previousNormalizedTimestamp = timestamp;
      const yaw = normalizeYaw(
        options.yawUnit === "degrees" ? (yawSource / 180) * Math.PI : yawSource,
      );
      if (!Number.isFinite(yaw)) {
        issues.add({
          code: "invalid-value",
          message: "yaw conversion must produce a finite angle in radians.",
          path: `rows[${rowNumber}].yaw`,
          row: rowNumber,
          line: row.line,
          field: "yaw",
        });
      }
      samples.push({
        timestamp,
        pose: {
          x,
          y,
          yaw,
        },
        sequence,
        speed,
        battery,
        current,
        state: stateRaw === "" ? null : stateRaw,
        latencyMs,
        poseSigma,
      });
    }
  });
  if (samples.length === 0 && issues.total === 0) {
    issues.add({
      code: "invalid-csv",
      message: "CSV does not contain any telemetry samples.",
      path: "rows",
    });
  }
  issues.throwIfAny();

  const normalized = {
    samples,
    origin: shouldNormalize
      ? csvTimestampOriginSeconds(sourceTimestampOrigin, timestampDivisor)
      : 0,
  };
  const timeOriginExact = shouldNormalize
    ? csvTimestampOriginExact(sourceTimestampOrigin, timestampUnit)
    : "0 seconds (absolute timestamps retained)";
  const stem = fileStem(label);
  const sampleRateHz = inferSampleRate(normalized.samples);
  const run: ReplaySessionRun = {
    id: options.runId?.trim() || `${slug(stem)}-${options.role}`,
    name: options.runName?.trim() || stem,
    role: options.role,
    kind: options.kind ?? defaultKind(),
    samples: normalized.samples,
    description: `Imported locally from ${label}.`,
    ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
  };
  assertImportedRunTextLimits(run);
  const availability = channelAvailability(run.samples);
  appendWarnings(warnings, warningsForPartialChannels(availability));
  const notes = [
    `CSV yaw interpreted as ${options.yawUnit} and normalized to radians.`,
    `CSV timestamps interpreted as ${timestampUnit} and converted to seconds before normalization.`,
    ...(shouldNormalize
      ? [`Timestamps rebased from exact source origin ${timeOriginExact}.`]
      : ["Absolute source timestamps were retained without origin rebasing."]),
  ];
  return {
    kind: "run",
    format: "csv",
    role: options.role,
    run,
    provenance: provenanceFor("csv", label, sha256, options.importedAt, notes),
    availability,
    timeOriginSeconds: normalized.origin,
    timeOriginExact,
    sourceName: label,
    byteLength,
    sha256,
    warnings,
  };
}

export function parseTelemetryCsv(
  text: string,
  options: ParseTelemetryCsvOptions,
): ImportedRunRecording {
  return parseTelemetryCsvSource(text, options);
}

interface RosAuxiliaryState {
  battery: number | null;
  current: number | null;
  state: string | null;
  latencyMs: number | null;
  poseSigma: number | null;
}

function rosPath(line: number, suffix = ""): string {
  return `lines[${line}]${suffix}`;
}

function rosNumber(
  value: unknown,
  path: string,
  line: number,
  issues: IssueCollector,
): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    issues.add({
      code: value === undefined ? "missing-field" : "invalid-value",
      message: `${path} must be a finite number.`,
      path,
      line,
    });
    return null;
  }
  return value;
}

interface RosTimestampSource {
  seconds: number;
  originExact: string;
  /** Exact ROS sec/nanosec tuple represented as nanoseconds since epoch. */
  exactNanoseconds?: bigint;
}

function rosTimestamp(
  envelope: Record<string, unknown>,
  message: Record<string, unknown>,
  line: number,
  issues: IssueCollector,
): RosTimestampSource | null {
  const header = isRecord(message.header) ? message.header : undefined;
  const stamp = header !== undefined && isRecord(header.stamp) ? header.stamp : undefined;
  if (stamp !== undefined) {
    const seconds = stamp.sec ?? stamp.secs;
    const nanoseconds = stamp.nanosec ?? stamp.nsecs ?? 0;
    const sec = rosNumber(seconds, rosPath(line, ".msg.header.stamp.sec"), line, issues);
    const nsec = rosNumber(nanoseconds, rosPath(line, ".msg.header.stamp.nanosec"), line, issues);
    if (sec === null || nsec === null) {
      return null;
    }
    if (
      !Number.isSafeInteger(sec) ||
      !Number.isSafeInteger(nsec) ||
      sec < 0 ||
      nsec < 0 ||
      nsec >= 1_000_000_000
    ) {
      issues.add({
        code: "invalid-value",
        message:
          "ROS timestamp seconds must be a non-negative safe integer and nanoseconds must be an integer in [0, 1e9).",
        path: rosPath(line, ".msg.header.stamp"),
        line,
      });
      return null;
    }
    return {
      seconds: sec + nsec / 1_000_000_000,
      originExact: `${String(sec)} seconds + ${String(nsec)} nanoseconds`,
      exactNanoseconds: BigInt(sec) * 1_000_000_000n + BigInt(nsec),
    };
  }
  const direct = message.timestamp ?? envelope.timestamp;
  const timestamp = rosNumber(direct, rosPath(line, ".timestamp"), line, issues);
  if (timestamp !== null && timestamp < 0) {
    issues.add({
      code: "invalid-value",
      message: "ROS timestamp must not be negative.",
      path: rosPath(line, ".timestamp"),
      line,
    });
    return null;
  }
  if (timestamp === null) {
    return null;
  }
  const timestampNanoseconds = timestamp * 1_000_000_000;
  const exactNanoseconds = Number.isSafeInteger(timestampNanoseconds)
    ? BigInt(timestampNanoseconds)
    : undefined;
  return {
    seconds: timestamp,
    originExact: `${String(timestamp)} seconds (decoded JSON number)`,
    ...(exactNanoseconds === undefined ? {} : { exactNanoseconds }),
  };
}

function rosTimestampIsNotAfter(
  timestamp: RosTimestampSource,
  previous: RosTimestampSource,
): boolean {
  if (timestamp.exactNanoseconds !== undefined && previous.exactNanoseconds !== undefined) {
    return timestamp.exactNanoseconds <= previous.exactNanoseconds;
  }
  return timestamp.seconds <= previous.seconds;
}

function rosTimestampSeconds(
  timestamp: RosTimestampSource,
  origin: RosTimestampSource | null,
): number {
  if (
    origin !== null &&
    timestamp.exactNanoseconds !== undefined &&
    origin.exactNanoseconds !== undefined
  ) {
    return nanosecondsToSeconds(timestamp.exactNanoseconds - origin.exactNanoseconds);
  }
  return timestamp.seconds - (origin?.seconds ?? 0);
}

function rosTimestampOriginSeconds(origin: RosTimestampSource | null): number {
  if (origin === null) {
    return 0;
  }
  return origin.exactNanoseconds === undefined
    ? origin.seconds
    : nanosecondsToSeconds(origin.exactNanoseconds);
}

function rosTimestampOriginExact(origin: RosTimestampSource | null): string {
  return origin?.originExact ?? "0 seconds";
}

function nestedRecord(
  record: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  let current: Record<string, unknown> | undefined = record;
  for (const key of keys) {
    const next: unknown = current?.[key];
    if (!isRecord(next)) {
      return undefined;
    }
    current = next;
  }
  return current;
}

function directOptionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (
    typeof value === "string" &&
    /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim())
  ) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function optionalRosNumber(
  value: unknown,
  path: string,
  line: number,
  issues: IssueCollector,
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  issues.add({
    code: "invalid-value",
    message: `${path} must be a finite JSON number when present.`,
    path,
    line,
  });
  return null;
}

function optionalRosString(
  value: unknown,
  path: string,
  line: number,
  issues: IssueCollector,
): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    issues.add({
      code: "invalid-value",
      message: `${path} must be a non-empty string when present.`,
      path,
      line,
    });
    return null;
  }
  if (value.length > MAX_IMPORT_STRING_LENGTH) {
    issues.add({
      code: "invalid-value",
      message: `${path} must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
      path,
      line,
    });
    return null;
  }
  return value;
}

function covarianceSigma(
  message: Record<string, unknown>,
  line: number,
  issues: IssueCollector,
): number | null {
  const poseContainer = isRecord(message.pose) ? message.pose : undefined;
  const covariance = poseContainer?.covariance;
  if (covariance === undefined) {
    return optionalRosNumber(
      message.pose_sigma ?? message.poseSigma,
      rosPath(line, ".msg.pose_sigma"),
      line,
      issues,
    );
  }
  if (!Array.isArray(covariance) || covariance.length < 8) {
    issues.add({
      code: "invalid-value",
      message: "Odometry pose covariance must be an array containing at least eight entries.",
      path: rosPath(line, ".msg.pose.covariance"),
      line,
    });
    return null;
  }
  const varianceX = optionalRosNumber(
    covariance[0],
    rosPath(line, ".msg.pose.covariance[0]"),
    line,
    issues,
  );
  const varianceY = optionalRosNumber(
    covariance[7],
    rosPath(line, ".msg.pose.covariance[7]"),
    line,
    issues,
  );
  if (varianceX === null || varianceY === null || varianceX < 0 || varianceY < 0) {
    return null;
  }
  return Math.sqrt(Math.max(varianceX, varianceY));
}

interface ParsedRosOdom {
  sample: SessionTelemetrySample;
  timestampSource: RosTimestampSource;
}

function parseRosOdom(
  envelope: Record<string, unknown>,
  message: Record<string, unknown>,
  auxiliary: RosAuxiliaryState,
  line: number,
  issues: IssueCollector,
): ParsedRosOdom | null {
  const timestamp = rosTimestamp(envelope, message, line, issues);
  const poseContainer = nestedRecord(message, ["pose", "pose"]) ?? nestedRecord(message, ["pose"]);
  const position =
    poseContainer === undefined ? undefined : nestedRecord(poseContainer, ["position"]);
  const orientation =
    poseContainer === undefined ? undefined : nestedRecord(poseContainer, ["orientation"]);
  if (position === undefined) {
    issues.add({
      code: "missing-field",
      message: "Odometry message must contain pose.pose.position.",
      path: rosPath(line, ".msg.pose.pose.position"),
      line,
    });
  }
  if (orientation === undefined) {
    issues.add({
      code: "missing-field",
      message: "Odometry message must contain pose.pose.orientation.",
      path: rosPath(line, ".msg.pose.pose.orientation"),
      line,
    });
  }
  const x =
    position === undefined
      ? null
      : rosNumber(position.x, rosPath(line, ".msg.pose.pose.position.x"), line, issues);
  const y =
    position === undefined
      ? null
      : rosNumber(position.y, rosPath(line, ".msg.pose.pose.position.y"), line, issues);
  const qx =
    orientation === undefined
      ? null
      : rosNumber(orientation.x, rosPath(line, ".msg.pose.pose.orientation.x"), line, issues);
  const qy =
    orientation === undefined
      ? null
      : rosNumber(orientation.y, rosPath(line, ".msg.pose.pose.orientation.y"), line, issues);
  const qz =
    orientation === undefined
      ? null
      : rosNumber(orientation.z, rosPath(line, ".msg.pose.pose.orientation.z"), line, issues);
  const qw =
    orientation === undefined
      ? null
      : rosNumber(orientation.w, rosPath(line, ".msg.pose.pose.orientation.w"), line, issues);
  if ([timestamp, x, y, qx, qy, qz, qw].some((value) => value === null)) {
    return null;
  }
  const quaternionNorm = Math.hypot(qx ?? 0, qy ?? 0, qz ?? 0, qw ?? 0);
  if (!Number.isFinite(quaternionNorm) || quaternionNorm < 1e-9) {
    issues.add({
      code: "invalid-value",
      message: "Odometry orientation quaternion must have a finite, non-zero norm.",
      path: rosPath(line, ".msg.pose.pose.orientation"),
      line,
    });
    return null;
  }
  const normalizedX = (qx ?? 0) / quaternionNorm;
  const normalizedY = (qy ?? 0) / quaternionNorm;
  const normalizedZ = (qz ?? 0) / quaternionNorm;
  const normalizedW = (qw ?? 0) / quaternionNorm;
  const yaw = normalizeYaw(
    Math.atan2(
      2 * (normalizedW * normalizedZ + normalizedX * normalizedY),
      1 - 2 * (normalizedY * normalizedY + normalizedZ * normalizedZ),
    ),
  );
  if (!Number.isFinite(yaw)) {
    issues.add({
      code: "invalid-value",
      message: "Odometry orientation must resolve to a finite planar yaw.",
      path: rosPath(line, ".msg.pose.pose.orientation"),
      line,
    });
    return null;
  }
  let twist: Record<string, unknown> | undefined;
  if (message.twist !== undefined) {
    if (!isRecord(message.twist)) {
      issues.add({
        code: "invalid-value",
        message: "Odometry twist must be an object when present.",
        path: rosPath(line, ".msg.twist"),
        line,
      });
    } else if (message.twist.twist !== undefined) {
      if (isRecord(message.twist.twist)) {
        twist = message.twist.twist;
      } else {
        issues.add({
          code: "invalid-value",
          message: "Odometry twist.twist must be an object when present.",
          path: rosPath(line, ".msg.twist.twist"),
          line,
        });
      }
    } else {
      twist = message.twist;
    }
  }
  let linear: Record<string, unknown> | undefined;
  if (twist?.linear !== undefined) {
    if (isRecord(twist.linear)) {
      linear = twist.linear;
    } else {
      issues.add({
        code: "invalid-value",
        message: "Odometry linear twist must be an object when present.",
        path: rosPath(line, ".msg.twist.twist.linear"),
        line,
      });
    }
  }
  const linearX = optionalRosNumber(
    linear?.x,
    rosPath(line, ".msg.twist.twist.linear.x"),
    line,
    issues,
  );
  const linearY = optionalRosNumber(
    linear?.y,
    rosPath(line, ".msg.twist.twist.linear.y"),
    line,
    issues,
  );
  const speed =
    linearX === null && linearY === null ? null : Math.hypot(linearX ?? 0, linearY ?? 0);
  if (speed !== null && !Number.isFinite(speed)) {
    issues.add({
      code: "invalid-value",
      message: "Odometry linear velocity must resolve to a finite speed.",
      path: rosPath(line, ".msg.twist.twist.linear"),
      line,
    });
  }
  const header = isRecord(message.header) ? message.header : undefined;
  const sequenceRaw = header?.seq ?? message.sequence;
  const sequence = optionalRosNumber(sequenceRaw, rosPath(line, ".msg.header.seq"), line, issues);
  if (sequence !== null && (!Number.isSafeInteger(sequence) || sequence < 0)) {
    issues.add({
      code: "invalid-value",
      message: "Odometry sequence must be a non-negative safe integer.",
      path: rosPath(line, ".msg.header.seq"),
      line,
    });
  }
  const directLatency = optionalRosNumber(
    message.latency_ms ?? message.latencyMs,
    rosPath(line, ".msg.latency_ms"),
    line,
    issues,
  );
  const directSigma = covarianceSigma(message, line, issues);
  const directState = optionalRosString(message.state, rosPath(line, ".msg.state"), line, issues);
  const directBattery = optionalRosNumber(
    message.battery ?? message.battery_percent,
    rosPath(line, ".msg.battery"),
    line,
    issues,
  );
  const directCurrent = optionalRosNumber(
    message.current ?? message.current_a,
    rosPath(line, ".msg.current"),
    line,
    issues,
  );
  if (directBattery !== null && (directBattery < 0 || directBattery > 100)) {
    issues.add({
      code: "invalid-value",
      message: "Odometry battery value must be between 0 and 100 percent.",
      path: rosPath(line, ".msg.battery"),
      line,
    });
  }
  if (directLatency !== null && directLatency < 0) {
    issues.add({
      code: "invalid-value",
      message: "Odometry latency must not be negative.",
      path: rosPath(line, ".msg.latency_ms"),
      line,
    });
  }
  if (directSigma !== null && directSigma < 0) {
    issues.add({
      code: "invalid-value",
      message: "Odometry pose uncertainty must not be negative.",
      path: rosPath(line, ".msg.pose_sigma"),
      line,
    });
  }
  return {
    timestampSource: timestamp as RosTimestampSource,
    sample: {
      timestamp: (timestamp as RosTimestampSource).seconds,
      pose: { x: x ?? 0, y: y ?? 0, yaw },
      sequence,
      speed,
      battery: directBattery ?? auxiliary.battery,
      current: directCurrent ?? auxiliary.current,
      state: directState ?? auxiliary.state,
      latencyMs: directLatency ?? auxiliary.latencyMs,
      poseSigma: directSigma ?? auxiliary.poseSigma,
    },
  };
}

function parseBatteryMessage(
  message: Record<string, unknown>,
  auxiliary: RosAuxiliaryState,
  line: number,
  issues: IssueCollector,
): void {
  const rawPercentage = optionalRosNumber(
    message.percentage,
    rosPath(line, ".msg.percentage"),
    line,
    issues,
  );
  const rawPercent = optionalRosNumber(
    message.battery_percent ?? message.battery,
    rosPath(line, ".msg.battery_percent"),
    line,
    issues,
  );
  const battery = rawPercentage === null ? rawPercent : rawPercentage * 100;
  if (battery !== null) {
    if (battery < 0 || battery > 100) {
      issues.add({
        code: "invalid-value",
        message: "Battery percentage must resolve to a value between 0 and 100.",
        path: rosPath(line, ".msg.percentage"),
        line,
      });
    } else {
      auxiliary.battery = battery;
    }
  }
  const current = optionalRosNumber(message.current, rosPath(line, ".msg.current"), line, issues);
  if (current !== null) {
    auxiliary.current = current;
  }
}

function normalizedDiagnosticKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function diagnosticValues(
  message: Record<string, unknown>,
  line: number,
  issues: IssueCollector,
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const addRecord = (record: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(record)) {
      if (key.length > MAX_IMPORT_STRING_LENGTH) {
        issues.add({
          code: "invalid-value",
          message: `Diagnostic keys must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
          path: rosPath(line, ".msg.values"),
          line,
        });
        continue;
      }
      values.set(normalizedDiagnosticKey(key), value);
    }
  };
  if (isRecord(message.values)) {
    addRecord(message.values);
  } else if (message.values !== undefined) {
    issues.add({
      code: "invalid-value",
      message: "Diagnostics values must be an object when present.",
      path: rosPath(line, ".msg.values"),
      line,
    });
  }
  const statuses = Array.isArray(message.status) ? message.status : [];
  if (message.status !== undefined && !Array.isArray(message.status)) {
    issues.add({
      code: "invalid-value",
      message: "Diagnostics status must be an array when present.",
      path: rosPath(line, ".msg.status"),
      line,
    });
  }
  for (const statusValue of statuses) {
    if (!isRecord(statusValue)) {
      issues.add({
        code: "invalid-value",
        message: "Each diagnostics status entry must be an object.",
        path: rosPath(line, ".msg.status"),
        line,
      });
      continue;
    }
    if (Array.isArray(statusValue.values)) {
      for (const pair of statusValue.values) {
        if (isRecord(pair) && typeof pair.key === "string") {
          if (pair.key.length > MAX_IMPORT_STRING_LENGTH) {
            issues.add({
              code: "invalid-value",
              message: `Diagnostic keys must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
              path: rosPath(line, ".msg.status.values.key"),
              line,
            });
            continue;
          }
          values.set(normalizedDiagnosticKey(pair.key), pair.value);
        } else {
          issues.add({
            code: "invalid-value",
            message: "Each diagnostics key/value entry must contain a string key.",
            path: rosPath(line, ".msg.status.values"),
            line,
          });
        }
      }
    } else if (isRecord(statusValue.values)) {
      addRecord(statusValue.values);
    } else if (statusValue.values !== undefined) {
      issues.add({
        code: "invalid-value",
        message: "Diagnostics status values must be an array or object.",
        path: rosPath(line, ".msg.status.values"),
        line,
      });
    }
  }
  addRecord(message);
  return values;
}

function firstDiagnosticNumber(
  values: Map<string, unknown>,
  keys: readonly string[],
  line: number,
  issues: IssueCollector,
): number | null {
  for (const key of keys) {
    if (!values.has(key)) {
      continue;
    }
    const parsed = directOptionalNumber(values.get(key));
    if (parsed !== null) {
      return parsed;
    }
    issues.add({
      code: "invalid-value",
      message: `Diagnostic ${key} must use a finite decimal number.`,
      path: rosPath(line, `.msg.${key}`),
      line,
    });
  }
  return null;
}

function firstDiagnosticString(
  values: Map<string, unknown>,
  keys: readonly string[],
  line: number,
  issues: IssueCollector,
): string | null {
  for (const key of keys) {
    if (!values.has(key)) {
      continue;
    }
    const value = values.get(key);
    if (typeof value === "string" && value.trim() !== "") {
      if (value.length > MAX_IMPORT_STRING_LENGTH) {
        issues.add({
          code: "invalid-value",
          message: `Diagnostic ${key} must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
          path: rosPath(line, `.msg.${key}`),
          line,
        });
        return null;
      }
      return value;
    }
    issues.add({
      code: "invalid-value",
      message: `Diagnostic ${key} must be a non-empty string.`,
      path: rosPath(line, `.msg.${key}`),
      line,
    });
  }
  return null;
}

function parseDiagnosticsMessage(
  message: Record<string, unknown>,
  auxiliary: RosAuxiliaryState,
  line: number,
  issues: IssueCollector,
): void {
  const values = diagnosticValues(message, line, issues);
  const latencyMs = firstDiagnosticNumber(
    values,
    ["latency_ms", "link_latency_ms", "telemetry_latency_ms", "data_age_ms"],
    line,
    issues,
  );
  const poseSigma = firstDiagnosticNumber(
    values,
    ["pose_sigma", "pose_uncertainty_m", "position_sigma_m"],
    line,
    issues,
  );
  const current = firstDiagnosticNumber(
    values,
    ["motor_current_a", "motor_current", "current_a"],
    line,
    issues,
  );
  const state = firstDiagnosticString(
    values,
    ["state", "mode", "safety_state", "robot_state"],
    line,
    issues,
  );
  for (const [field, value] of [
    ["latency_ms", latencyMs],
    ["pose_sigma", poseSigma],
  ] as const) {
    if (value !== null && value < 0) {
      issues.add({
        code: "invalid-value",
        message: `${field} diagnostic value must not be negative.`,
        path: rosPath(line, `.msg.${field}`),
        line,
      });
    }
  }
  if (latencyMs !== null && latencyMs >= 0) {
    auxiliary.latencyMs = latencyMs;
  }
  if (poseSigma !== null && poseSigma >= 0) {
    auxiliary.poseSigma = poseSigma;
  }
  if (current !== null) {
    auxiliary.current = current;
  }
  if (state !== null) {
    auxiliary.state = state;
  }
}

/** Visit source lines without allocating a source-sized array of substrings. */
function forEachTextLine(
  text: string,
  visitor: (line: string, lineNumber: number) => boolean | void,
): void {
  let start = 0;
  let lineNumber = 1;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    let end = newline === -1 ? text.length : newline;
    if (end > start && text.charCodeAt(end - 1) === 0x0d) {
      end -= 1;
    }
    let line = text.slice(start, end);
    if (lineNumber === 1 && line.charCodeAt(0) === 0xfeff) {
      line = line.slice(1);
    }
    if (visitor(line, lineNumber) === false) {
      break;
    }
    if (newline === -1) {
      break;
    }
    start = newline + 1;
    lineNumber += 1;
  }
}

/**
 * Parse newline-delimited rosbridge publish envelopes. /odom is required;
 * /battery_state and /diagnostics enrich subsequent odometry samples when
 * available. ROS 1 and ROS 2 header stamp spellings are supported.
 */
function parseRosbridgeJsonlSource(
  text: string,
  options: ParseRosbridgeJsonlOptions,
  verifiedSource?: VerifiedParserSource,
): ImportedRunRecording {
  const { byteLength, sha256 } = parserSource(text, verifiedSource);
  if (text.trim() === "") {
    throw importError({ code: "empty-input", message: "ROS JSONL input is empty.", path: "$" });
  }
  assertReplayRole(options.role);
  assertRunKind(options.kind);
  assertRunOptionTextLimits(options);
  const label = sourceName(options, "recording.jsonl");
  const topics: RosbridgeTopicOptions = {
    odom: options.topics?.odom ?? DEFAULT_ROS_TOPICS.odom,
    battery:
      options.topics?.battery === undefined ? DEFAULT_ROS_TOPICS.battery : options.topics.battery,
    diagnostics:
      options.topics?.diagnostics === undefined
        ? DEFAULT_ROS_TOPICS.diagnostics
        : options.topics.diagnostics,
  };
  if (typeof topics.odom !== "string" || topics.odom.trim() === "") {
    throw importError({
      code: "missing-option",
      message: "ROS odometry topic must be a non-empty string.",
      path: "options.topics.odom",
    });
  }
  if (topics.odom.length > MAX_EMBEDDED_SOURCE_STRING_LENGTH) {
    throw importError({
      code: "invalid-value",
      message: `ROS odometry topic must contain at most ${MAX_EMBEDDED_SOURCE_STRING_LENGTH} characters.`,
      path: "options.topics.odom",
    });
  }
  for (const [topicKind, topic] of [
    ["battery", topics.battery],
    ["diagnostics", topics.diagnostics],
  ] as const) {
    if (topic !== null && (typeof topic !== "string" || topic.trim() === "")) {
      throw importError({
        code: "invalid-value",
        message: `ROS ${topicKind} topic must be a non-empty string or null to disable it.`,
        path: `options.topics.${topicKind}`,
      });
    }
    if (typeof topic === "string" && topic.length > MAX_EMBEDDED_SOURCE_STRING_LENGTH) {
      throw importError({
        code: "invalid-value",
        message: `ROS ${topicKind} topic must contain at most ${MAX_EMBEDDED_SOURCE_STRING_LENGTH} characters.`,
        path: `options.topics.${topicKind}`,
      });
    }
  }

  const issues = new IssueCollector();
  const warnings: ImportWarning[] = [];
  if (options.kind === undefined) {
    appendWarning(warnings, {
      code: "run-kind-defaulted",
      message:
        "Run condition was not supplied; recorded as normal because the binary run model has no unknown state. Review detector findings before treating it as nominal.",
      path: "options.kind",
    });
  }
  const shouldNormalize = options.normalizeTimestampOrigin ?? true;
  const samples: SessionTelemetrySample[] = [];
  const auxiliary: RosAuxiliaryState = {
    battery: null,
    current: null,
    state: null,
    latencyMs: null,
    poseSigma: null,
  };
  const unrecognizedTopics = new Map<string, number>();
  let ungroupedTopicMessages = 0;
  let odomMessages = 0;
  let sourceTimestampOrigin: RosTimestampSource | null = null;
  let previousTimestampSource: RosTimestampSource | null = null;
  let previousSampleTimestamp: number | null = null;
  forEachTextLine(text, (line, lineNumber) => {
    const sourceLine = line.trim();
    if (sourceLine === "") {
      return;
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(sourceLine) as unknown;
    } catch (error) {
      issues.add({
        code: "invalid-jsonl",
        message: `Line is not valid JSON: ${error instanceof Error ? error.message : "invalid JSON"}`,
        path: rosPath(lineNumber),
        line: lineNumber,
      });
      return;
    }
    if (!isRecord(decoded)) {
      issues.add({
        code: "invalid-jsonl",
        message: "Each JSONL line must be a rosbridge envelope object.",
        path: rosPath(lineNumber),
        line: lineNumber,
      });
      return;
    }
    if (decoded.op !== undefined && decoded.op !== "publish") {
      appendWarning(warnings, {
        code: "ignored-operation",
        message: `Ignored rosbridge operation ${String(decoded.op)}.`,
        path: rosPath(lineNumber, ".op"),
        line: lineNumber,
      });
      return;
    }
    if (typeof decoded.topic !== "string" || decoded.topic.trim() === "") {
      issues.add({
        code: "missing-field",
        message: "Rosbridge envelope topic must be a non-empty string.",
        path: rosPath(lineNumber, ".topic"),
        line: lineNumber,
      });
      return;
    }
    if (decoded.topic.length > MAX_IMPORT_STRING_LENGTH) {
      issues.add({
        code: "invalid-value",
        message: `Rosbridge envelope topic must contain at most ${MAX_IMPORT_STRING_LENGTH} characters.`,
        path: rosPath(lineNumber, ".topic"),
        line: lineNumber,
      });
      return;
    }
    if (!isRecord(decoded.msg)) {
      issues.add({
        code: "missing-field",
        message: "Rosbridge envelope msg must be an object.",
        path: rosPath(lineNumber, ".msg"),
        line: lineNumber,
      });
      return;
    }

    if (decoded.topic === topics.odom) {
      odomMessages += 1;
      if (odomMessages > MAX_IMPORT_SAMPLES) {
        issues.add({
          ...importCardinalityIssue("samples", "Odometry", odomMessages, MAX_IMPORT_SAMPLES),
          line: lineNumber,
        });
        return false;
      }
      const parsed = parseRosOdom(decoded, decoded.msg, auxiliary, lineNumber, issues);
      if (parsed !== null) {
        if (
          !shouldNormalize &&
          (parsed.timestampSource.exactNanoseconds === undefined ||
            parsed.timestampSource.exactNanoseconds > BigInt(Number.MAX_SAFE_INTEGER) ||
            parsed.timestampSource.exactNanoseconds < -BigInt(Number.MAX_SAFE_INTEGER))
        ) {
          issues.add({
            code: "invalid-value",
            message:
              "Absolute ROS timestamp cannot be retained at nanosecond-safe Number precision; enable timestamp-origin normalization.",
            path: rosPath(lineNumber, ".msg.header.stamp"),
            line: lineNumber,
          });
        }
        const sourceOrderInvalid =
          previousTimestampSource !== null &&
          rosTimestampIsNotAfter(parsed.timestampSource, previousTimestampSource);
        if (sourceOrderInvalid) {
          issues.add({
            code: "timestamp-order",
            message: "Odometry timestamps must increase strictly in JSONL order.",
            path: `samples[${samples.length}].timestamp`,
            line: lineNumber,
          });
        }
        if (sourceTimestampOrigin === null && shouldNormalize) {
          sourceTimestampOrigin = parsed.timestampSource;
        }
        const timestamp = normalizeTimestamp(
          rosTimestampSeconds(parsed.timestampSource, sourceTimestampOrigin),
          0,
        );
        if (!Number.isFinite(timestamp)) {
          issues.add({
            code: "invalid-value",
            message: "ROS timestamp conversion must produce a finite replay time.",
            path: rosPath(lineNumber, ".msg.header.stamp"),
            line: lineNumber,
          });
        }
        if (
          !sourceOrderInvalid &&
          previousSampleTimestamp !== null &&
          timestamp <= previousSampleTimestamp
        ) {
          issues.add({
            code: "timestamp-order",
            message:
              "Odometry timestamps must remain strictly increasing after conversion to nanosecond-resolution replay time.",
            path: `samples[${samples.length}].timestamp`,
            line: lineNumber,
          });
        }
        parsed.sample.timestamp = timestamp;
        previousTimestampSource = parsed.timestampSource;
        previousSampleTimestamp = timestamp;
        samples.push(parsed.sample);
      }
    } else if (topics.battery !== null && decoded.topic === topics.battery) {
      parseBatteryMessage(decoded.msg, auxiliary, lineNumber, issues);
    } else if (topics.diagnostics !== null && decoded.topic === topics.diagnostics) {
      parseDiagnosticsMessage(decoded.msg, auxiliary, lineNumber, issues);
    } else {
      const knownCount = unrecognizedTopics.get(decoded.topic);
      if (knownCount !== undefined) {
        unrecognizedTopics.set(decoded.topic, knownCount + 1);
      } else if (unrecognizedTopics.size < MAX_IMPORT_WARNINGS - 1) {
        unrecognizedTopics.set(decoded.topic, 1);
      } else {
        ungroupedTopicMessages += 1;
      }
    }
  });
  if (odomMessages === 0) {
    issues.add({
      code: "missing-topic",
      message: `No odometry messages were found on configured topic ${topics.odom}.`,
      path: "topics.odom",
    });
  }
  issues.throwIfAny();

  for (const [topic, count] of unrecognizedTopics) {
    appendWarning(warnings, {
      code: "ignored-topic",
      message: `Ignored ${count} message${count === 1 ? "" : "s"} from unconfigured topic ${topic}.`,
      path: "topics",
    });
  }
  if (ungroupedTopicMessages > 0) {
    appendWarning(warnings, {
      code: "ignored-topics-summary",
      message: `Ignored ${ungroupedTopicMessages} additional message${ungroupedTopicMessages === 1 ? "" : "s"} from other unconfigured topics.`,
      path: "topics",
    });
  }
  const normalized = {
    samples,
    origin: shouldNormalize ? rosTimestampOriginSeconds(sourceTimestampOrigin) : 0,
  };
  const timeOriginExact = shouldNormalize
    ? rosTimestampOriginExact(sourceTimestampOrigin)
    : "0 seconds (absolute timestamps retained)";
  const stem = fileStem(label);
  const sampleRateHz = inferSampleRate(normalized.samples);
  const run: ReplaySessionRun = {
    id: options.runId?.trim() || `${slug(stem)}-${options.role}`,
    name: options.runName?.trim() || stem,
    role: options.role,
    kind: options.kind ?? defaultKind(),
    samples: normalized.samples,
    description: `Imported locally from rosbridge JSONL (${topics.odom}).`,
    ...(sampleRateHz === undefined ? {} : { sampleRateHz }),
  };
  assertImportedRunTextLimits(run);
  const availability = channelAvailability(run.samples);
  appendWarnings(warnings, warningsForPartialChannels(availability));
  const notes = [
    `Odometry topic: ${topics.odom}.`,
    ...(topics.battery === null || topics.battery === undefined
      ? []
      : [`Battery topic: ${topics.battery}.`]),
    ...(topics.diagnostics === null || topics.diagnostics === undefined
      ? []
      : [`Diagnostics topic: ${topics.diagnostics}.`]),
    ...(shouldNormalize
      ? [`Timestamps rebased from exact source origin ${timeOriginExact}.`]
      : ["Absolute source timestamps were retained without origin rebasing."]),
  ];
  return {
    kind: "run",
    format: "ros-jsonl",
    role: options.role,
    run,
    provenance: provenanceFor("ros-jsonl", label, sha256, options.importedAt, notes),
    availability,
    timeOriginSeconds: normalized.origin,
    timeOriginExact,
    sourceName: label,
    byteLength,
    sha256,
    warnings,
  };
}

export function parseRosbridgeJsonl(
  text: string,
  options: ParseRosbridgeJsonlOptions,
): ImportedRunRecording {
  return parseRosbridgeJsonlSource(text, options);
}

function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw importError({
      code: "aborted",
      message: "Recording import was cancelled.",
      path: "import",
    });
  }
}

function inputName(input: ImportRecordingInput, options: ImportRecordingOptions): string {
  if (options.sourceName?.trim()) {
    return options.sourceName.trim();
  }
  if (typeof Blob !== "undefined" && input instanceof Blob && "name" in input) {
    const name = (input as Blob & { name?: unknown }).name;
    if (typeof name === "string" && name.trim() !== "") {
      return name;
    }
  }
  return "recording";
}

async function inputBytes(
  input: Exclude<ImportRecordingInput, string>,
  signal: AbortSignal | undefined,
): Promise<Uint8Array<ArrayBuffer>> {
  checkAborted(signal);
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    assertImportSize(input.size);
    const bytes = new Uint8Array(await input.arrayBuffer());
    checkAborted(signal);
    assertImportSize(bytes.byteLength);
    return bytes;
  }
  if (input instanceof ArrayBuffer) {
    assertImportSize(input.byteLength);
    return new Uint8Array(input);
  }
  if (ArrayBuffer.isView(input)) {
    assertImportSize(input.byteLength);
    const copy = new Uint8Array(input.byteLength);
    copy.set(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
    return copy;
  }
  throw importError({
    code: "invalid-value",
    message: "Import input must be text, an ArrayBuffer, a typed-array view, or a Blob/File.",
    path: "input",
  });
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw importError({
      code: "invalid-encoding",
      message: `Recording must be valid UTF-8: ${error instanceof Error ? error.message : "decoding failed"}`,
      path: "input",
    });
  }
}

async function fingerprintImportBytes(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  if (globalThis.crypto?.subtle !== undefined) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
  }
  return sha256RawBytes(bytes);
}

interface PreparedImportSource {
  text: string;
  byteLength: number;
  sha256: string;
}

/**
 * Decode and fingerprint inside a short-lived scope so the encoded byte buffer
 * can be reclaimed before parsing expands the telemetry into sample objects.
 */
async function prepareImportSource(
  input: ImportRecordingInput,
  options: ImportRecordingOptions,
): Promise<PreparedImportSource> {
  if (typeof input === "string") {
    // Measure without allocating an encoded copy so oversized programmatic
    // inputs are rejected before TextEncoder expands them.
    const byteLength = sourceByteLength(input);
    assertImportSize(byteLength);
    const bytes = new TextEncoder().encode(input);
    checkAborted(options.signal);
    const sha256 = await fingerprintImportBytes(bytes);
    checkAborted(options.signal);
    return { text: input, byteLength, sha256 };
  }
  const bytes = await inputBytes(input, options.signal);
  if (bytes.byteLength === 0) {
    throw importError({ code: "empty-input", message: "Recording input is empty.", path: "input" });
  }
  const text = decodeUtf8(bytes);
  const sha256 = await fingerprintImportBytes(bytes);
  checkAborted(options.signal);
  return { text, byteLength: bytes.byteLength, sha256 };
}

/** Find unescaped top-level object keys without materializing a JSON object. */
function jsonHasTopLevelKeys(text: string, requiredKeys: readonly string[]): boolean {
  const remaining = new Set(requiredKeys);
  let depth = 0;
  let stringStart = -1;
  let escaped = false;
  for (let index = 0; index < text.length && remaining.size > 0; index += 1) {
    const character = text[index] ?? "";
    if (stringStart >= 0) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        if (depth === 1) {
          let lookahead = index + 1;
          while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) {
            lookahead += 1;
          }
          if (text[lookahead] === ":") {
            remaining.delete(text.slice(stringStart, index));
          }
        }
        stringStart = -1;
      }
      continue;
    }
    if (character === '"') {
      stringStart = index + 1;
    } else if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
    }
  }
  return remaining.size === 0;
}

function detectFormat(text: string, name: string): ResolvedRecordingImportFormat {
  const lowerName = name.toLowerCase();
  if (/\.(?:jsonl|ndjson)$/.test(lowerName)) {
    return "ros-jsonl";
  }
  if (/\.csv$/.test(lowerName)) {
    return "csv";
  }
  if (/\.json$/.test(lowerName)) {
    return "json";
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    let nonEmptyLineCount = 0;
    let everyNonEmptyLineStartsObject = true;
    forEachTextLine(text, (line) => {
      const lineStart = line.trimStart();
      if (lineStart !== "") {
        nonEmptyLineCount += 1;
        if (!lineStart.startsWith("{")) {
          everyNonEmptyLineStartsObject = false;
          return false;
        }
      }
    });
    if (nonEmptyLineCount > 1 && everyNonEmptyLineStartsObject) {
      return "ros-jsonl";
    }
    if (jsonHasTopLevelKeys(trimmed, ["topic", "msg"])) {
      return "ros-jsonl";
    }
    return "json";
  }
  const firstLineEnd = text.search(/[\r\n]/);
  const firstLine = text.slice(0, firstLineEnd === -1 ? text.length : firstLineEnd).toLowerCase();
  if (REQUIRED_CSV_COLUMNS.every((column) => firstLine.includes(column))) {
    return "csv";
  }
  throw importError({
    code: "unsupported-format",
    message: "Unable to detect recording format; choose JSON, CSV, or ROS JSONL explicitly.",
    path: "options.format",
  });
}

function requireRole(options: ImportRecordingOptions, format: string): ReplayRunRole {
  if (options.role === undefined) {
    throw importError({
      code: "missing-option",
      message: `${format} import requires an explicit candidate or baseline role.`,
      path: "options.role",
    });
  }
  assertReplayRole(options.role);
  return options.role;
}

/**
 * Read, fingerprint, detect, and parse a local recording. This API preflights
 * Blob/File size before reading, uses Web Crypto in workers when available,
 * and never uploads or persists source telemetry.
 */
export async function importRecording(
  input: ImportRecordingInput,
  options: ImportRecordingOptions = {},
): Promise<ImportedRecording> {
  if (
    options.format !== undefined &&
    options.format !== "auto" &&
    options.format !== "json" &&
    options.format !== "csv" &&
    options.format !== "ros-jsonl"
  ) {
    throw importError({
      code: "unsupported-format",
      message: "Recording format must be auto, json, csv, or ros-jsonl.",
      path: "options.format",
    });
  }
  const name = inputName(input, options);
  const source = await prepareImportSource(input, options);
  if (source.byteLength === 0) {
    throw importError({ code: "empty-input", message: "Recording input is empty.", path: "input" });
  }
  const format =
    options.format === undefined || options.format === "auto"
      ? detectFormat(source.text, name)
      : options.format;
  const importedAt = Object.prototype.hasOwnProperty.call(options, "importedAt")
    ? (options.importedAt ?? null)
    : new Date().toISOString();
  const sourceOptions = {
    sourceName: name,
    importedAt,
  };

  switch (format) {
    case "json":
      return parseSessionJsonSource(source.text, { ...sourceOptions, role: options.role }, source);
    case "csv": {
      const role = requireRole(options, "CSV");
      if (options.yawUnit === undefined) {
        throw importError({
          code: "missing-option",
          message: "CSV import requires an explicit yaw unit (radians or degrees).",
          path: "options.yawUnit",
        });
      }
      return parseTelemetryCsvSource(
        source.text,
        {
          ...sourceOptions,
          role,
          yawUnit: options.yawUnit,
          timestampUnit: options.timestampUnit,
          normalizeTimestampOrigin: options.normalizeTimestampOrigin,
          runId: options.runId,
          runName: options.runName,
          kind: options.kind,
        },
        source,
      );
    }
    case "ros-jsonl": {
      const role = requireRole(options, "ROS JSONL");
      return parseRosbridgeJsonlSource(
        source.text,
        {
          ...sourceOptions,
          role,
          topics: options.topics,
          normalizeTimestampOrigin: options.normalizeTimestampOrigin,
          runId: options.runId,
          runName: options.runName,
          kind: options.kind,
        },
        source,
      );
    }
  }
}
