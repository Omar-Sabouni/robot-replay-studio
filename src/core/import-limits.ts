import type { ReplaySessionV2 } from "./types";

/** Maximum encoded source size accepted before a browser File or Blob is read. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;
export const MAX_IMPORT_ISSUES = 20;
export const MAX_IMPORT_WARNINGS = 50;

/** Maximum fields accepted in any CSV row before cell objects are allocated. */
export const MAX_IMPORT_CSV_COLUMNS = 128;

/** Candidate and baseline samples are counted together for canonical sessions. */
export const MAX_IMPORT_SAMPLES = 200_000;
export const MAX_IMPORT_ROUTE_WAYPOINTS = 4_096;
export const MAX_IMPORT_ENVIRONMENT_OBJECTS = 256;

/** Maximum sample-by-geometry work admitted by a canonical session import. */
export const MAX_IMPORT_GEOMETRY_WORK = 20_000_000;

/** Bounds repeated metadata that can otherwise amplify a small JSON source. */
export const MAX_IMPORT_TAGS = 128;
export const MAX_IMPORT_PROVENANCE_NOTES = 256;
export const MAX_IMPORT_ANNOTATIONS = 4_096;
export const MAX_IMPORT_TRANSFORMATIONS = 256;
export const MAX_IMPORT_TRANSFORMATION_PARAMETERS = 16;
export const MAX_IMPORT_STRING_LENGTH = 65_536;

export type ImportIssueCode =
  | "aborted"
  | "empty-input"
  | "file-too-large"
  | "invalid-encoding"
  | "invalid-json"
  | "invalid-csv"
  | "invalid-jsonl"
  | "invalid-value"
  | "missing-field"
  | "duplicate-field"
  | "unsupported-schema"
  | "unsupported-format"
  | "missing-option"
  | "missing-topic"
  | "timestamp-order";

/** A stable, UI-friendly validation issue. At most 20 are exposed per failure. */
export interface ImportIssue {
  code: ImportIssueCode;
  message: string;
  path: string;
  line?: number;
  row?: number;
  column?: number;
  field?: string;
}

export class RecordingImportError extends Error {
  readonly issues: readonly ImportIssue[];
  readonly totalIssueCount: number;
  readonly truncated: boolean;

  constructor(issues: readonly ImportIssue[], totalIssueCount = issues.length) {
    const first = issues[0];
    const suffix = totalIssueCount > 1 ? ` (${totalIssueCount} issues)` : "";
    super(`${first?.message ?? "Unable to import recording"}${suffix}`);
    this.name = "RecordingImportError";
    this.issues = issues.slice(0, MAX_IMPORT_ISSUES);
    this.totalIssueCount = totalIssueCount;
    this.truncated = totalIssueCount > this.issues.length;
  }
}

export function importCardinalityIssue(
  path: string,
  label: string,
  actual: number,
  maximum: number,
): ImportIssue {
  return {
    code: "invalid-value",
    message: `${label} contains ${actual} entries; the import limit is ${maximum}.`,
    path,
  };
}

export interface ReplaySessionImportCounts {
  candidateSampleCount: number;
  baselineSampleCount: number;
  waypointCount: number;
  objectCount: number;
}

export function assertReplaySessionImportCounts({
  candidateSampleCount,
  baselineSampleCount,
  waypointCount,
  objectCount,
}: ReplaySessionImportCounts): void {
  const totalSampleCount = candidateSampleCount + baselineSampleCount;
  const geometryCount = waypointCount + objectCount;
  const issues: ImportIssue[] = [];

  if (totalSampleCount > MAX_IMPORT_SAMPLES) {
    issues.push(
      importCardinalityIssue(
        "runs",
        "Candidate and baseline telemetry",
        totalSampleCount,
        MAX_IMPORT_SAMPLES,
      ),
    );
  }
  if (waypointCount > MAX_IMPORT_ROUTE_WAYPOINTS) {
    issues.push(
      importCardinalityIssue(
        "plannedRoute.waypoints",
        "Planned route",
        waypointCount,
        MAX_IMPORT_ROUTE_WAYPOINTS,
      ),
    );
  }
  if (objectCount > MAX_IMPORT_ENVIRONMENT_OBJECTS) {
    issues.push(
      importCardinalityIssue(
        "environment.objects",
        "Environment",
        objectCount,
        MAX_IMPORT_ENVIRONMENT_OBJECTS,
      ),
    );
  }

  const geometryWork = BigInt(totalSampleCount) * BigInt(geometryCount);
  if (geometryWork > BigInt(MAX_IMPORT_GEOMETRY_WORK)) {
    issues.push({
      code: "invalid-value",
      message: `Telemetry and geometry require ${geometryWork.toString()} sample-geometry checks; the import work limit is ${MAX_IMPORT_GEOMETRY_WORK}.`,
      path: "runs",
    });
  }
  if (issues.length > 0) {
    throw new RecordingImportError(issues);
  }
}

/**
 * Recheck resource limits after composing or replacing runs in an already
 * normalized session without serializing and reparsing the full recording.
 */
export function assertReplaySessionImportLimits(session: ReplaySessionV2): void {
  assertReplaySessionImportCounts({
    candidateSampleCount: session.runs.candidate.samples.length,
    baselineSampleCount: session.runs.baseline?.samples.length ?? 0,
    waypointCount: session.plannedRoute.waypoints.length,
    objectCount: session.environment.objects.length,
  });
}

function importError(issue: ImportIssue): RecordingImportError {
  return new RecordingImportError([issue]);
}

function formatBytes(value: number): string {
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1)} KiB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Validate a File/Blob size before reading it into memory. */
export function assertImportSize(size: number, maximumBytes = MAX_IMPORT_BYTES): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw importError({
      code: "invalid-value",
      message: "Import size must be a non-negative safe integer.",
      path: "file.size",
    });
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new RangeError("maximumBytes must be a positive safe integer");
  }
  if (size > maximumBytes) {
    throw importError({
      code: "file-too-large",
      message: `Recording size ${size} B (${formatBytes(size)}) exceeds the ${formatBytes(maximumBytes)} local import limit.`,
      path: "file.size",
    });
  }
}

/** Non-throwing companion suitable for file-picker preflight UI. */
export function preflightImportSize(
  size: number,
  maximumBytes = MAX_IMPORT_BYTES,
): { accepted: true } | { accepted: false; issue: ImportIssue } {
  try {
    assertImportSize(size, maximumBytes);
    return { accepted: true };
  } catch (error) {
    if (error instanceof RecordingImportError && error.issues[0] !== undefined) {
      return { accepted: false, issue: error.issues[0] };
    }
    throw error;
  }
}
