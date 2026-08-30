import {
  REPLAY_SESSION_SCHEMA,
  type CoordinateFrame,
  type DetectorConfiguration,
  type DetectorId,
  type DetectorRuleConfig,
  type MissionMetadata,
  type PlannedRoute,
  type ReplayAnnotation,
  type ReplayEnvironment,
  type ReplaySessionRun,
  type ReplaySessionV2,
  type RobotMetadata,
  type SessionProvenance,
  type SessionTelemetrySample,
  type TelemetryRun,
} from "./types";

const HEX = "0123456789abcdef";

export const DETECTOR_CONFIGURATION_VERSION = "2.0.0";
export const MIN_REPLAY_SAMPLE_RATE_HZ = 1e-9;
export const MAX_REPLAY_SAMPLE_RATE_HZ = 1e9;
export const MAX_REPLAY_IDENTIFIER_LENGTH = 128;

export const DETECTOR_IDS: readonly DetectorId[] = [
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
] as const;

export const DEFAULT_COORDINATE_FRAME: Readonly<CoordinateFrame> = {
  id: "map",
  label: "Local map",
  convention: "x-east-y-north",
  linearUnit: "metre",
  angularUnit: "radian",
};

export const DEFAULT_ROBOT: Readonly<RobotMetadata> = {
  id: "robot-01",
  name: "AMR-01",
  model: "Differential-drive AMR",
  drive: "differential",
  footprint: { length: 0.82, width: 0.58, safetyMargin: 0.12 },
  nominalVoltage: 48,
};

const UNKNOWN_ROBOT: Readonly<RobotMetadata> = {
  id: "unidentified-robot",
  name: "Unspecified robot",
  model: "Unknown model · visualization footprint only",
  drive: "unknown",
  footprint: { length: 0.82, width: 0.58, safetyMargin: 0.12 },
};

const detectorRule = (
  id: DetectorId,
  label: string,
  threshold: number,
  minimumDuration: number,
  severity: DetectorRuleConfig["severity"],
): DetectorRuleConfig => ({
  id,
  label,
  version: DETECTOR_CONFIGURATION_VERSION,
  enabled: true,
  threshold,
  minimumDuration,
  severity,
});

/** A fresh detector configuration suitable for editing in the Rules panel. */
export function createDefaultDetectorConfiguration(): DetectorConfiguration {
  return {
    version: DETECTOR_CONFIGURATION_VERSION,
    rules: {
      "timestamp-gap": detectorRule("timestamp-gap", "Timestamp gap", 0.25, 0, "warning"),
      "sequence-gap": detectorRule("sequence-gap", "Sequence gap", 1, 0, "warning"),
      "pose-discontinuity": detectorRule(
        "pose-discontinuity",
        "Pose discontinuity",
        0.75,
        0,
        "critical",
      ),
      overcurrent: detectorRule("overcurrent", "Motor overcurrent", 18, 0.25, "critical"),
      "low-battery": detectorRule("low-battery", "Low battery", 20, 1, "warning"),
      "link-degradation": detectorRule("link-degradation", "Link degradation", 180, 0.5, "warning"),
      "route-deviation": detectorRule("route-deviation", "Route deviation", 0.45, 0.25, "critical"),
      "heading-error": detectorRule("heading-error", "Heading error", 0.4, 0.5, "warning"),
      "obstacle-clearance": detectorRule(
        "obstacle-clearance",
        "Obstacle clearance",
        0.3,
        0.1,
        "critical",
      ),
      "safe-stop": detectorRule("safe-stop", "Protective safe-stop", 1, 0, "critical"),
    },
  };
}

/** Immutable-by-convention snapshot for consumers that only need defaults. */
export const DEFAULT_DETECTOR_CONFIGURATION = createDefaultDetectorConfiguration();
/** Short alias retained for UI integrations. */
export const DEFAULT_DETECTOR_CONFIG = DEFAULT_DETECTOR_CONFIGURATION;

const INSTANTANEOUS_DETECTORS = new Set<DetectorId>([
  "timestamp-gap",
  "sequence-gap",
  "pose-discontinuity",
]);

/**
 * Validate the numeric contract that gives each detector threshold one
 * unambiguous physical meaning. Importers and runtime overrides share this
 * contract so a report can never claim a configuration the analyzer ignored.
 */
export function detectorRuleConfigurationIssues(
  id: DetectorId,
  rule: Pick<DetectorRuleConfig, "threshold" | "minimumDuration">,
): string[] {
  const issues: string[] = [];
  const threshold = rule.threshold;
  if (!Number.isFinite(threshold)) {
    issues.push("threshold must be finite");
  } else {
    switch (id) {
      case "sequence-gap":
        if (!Number.isSafeInteger(threshold) || threshold < 0) {
          issues.push("threshold must be a non-negative safe integer packet count");
        }
        break;
      case "low-battery":
        if (threshold < 0 || threshold > 100) {
          issues.push("threshold must be between 0 and 100 percent");
        }
        break;
      case "heading-error":
        if (threshold < 0 || threshold > Math.PI) {
          issues.push("threshold must be between 0 and PI radians");
        }
        break;
      case "safe-stop":
        if (threshold !== 1) {
          issues.push("threshold must equal 1 for the state-entry detector");
        }
        break;
      case "timestamp-gap":
      case "pose-discontinuity":
      case "overcurrent":
      case "link-degradation":
      case "route-deviation":
      case "obstacle-clearance":
        if (threshold < 0) {
          issues.push("threshold must be non-negative");
        }
        break;
    }
  }
  if (!Number.isFinite(rule.minimumDuration) || rule.minimumDuration < 0) {
    issues.push("minimumDuration must be a non-negative finite number");
  } else if (INSTANTANEOUS_DETECTORS.has(id) && rule.minimumDuration !== 0) {
    issues.push("minimumDuration must equal 0 for this instantaneous detector");
  }
  return issues;
}

export function sampleRateConfigurationIssue(value: number): string | null {
  return Number.isFinite(value) &&
    value >= MIN_REPLAY_SAMPLE_RATE_HZ &&
    value <= MAX_REPLAY_SAMPLE_RATE_HZ &&
    Number.isFinite(1 / value)
    ? null
    : `must be between ${MIN_REPLAY_SAMPLE_RATE_HZ} and ${MAX_REPLAY_SAMPLE_RATE_HZ} Hz`;
}

export interface CreateReplaySessionOptions {
  id?: string;
  mission?: Partial<MissionMetadata>;
  robot?: Partial<Omit<RobotMetadata, "footprint">> & {
    footprint?: Partial<RobotMetadata["footprint"]>;
  };
  coordinateFrame?: CoordinateFrame;
  environment?: ReplayEnvironment;
  plannedRoute?: PlannedRoute;
  candidate: ReplaySessionRun;
  baseline?: ReplaySessionRun;
  detectors?: DetectorConfiguration;
  annotations?: ReplayAnnotation[];
  provenance?: Partial<SessionProvenance>;
}

export interface SessionValidationIssue {
  path: string;
  message: string;
}

export class ReplaySessionValidationError extends Error {
  readonly issues: readonly SessionValidationIssue[];

  constructor(issues: readonly SessionValidationIssue[]) {
    super(issues.map(({ path, message }) => `${path}: ${message}`).join("\n"));
    this.name = "ReplaySessionValidationError";
    this.issues = issues;
  }
}

function copySample(sample: SessionTelemetrySample): SessionTelemetrySample {
  return { ...sample, pose: { ...sample.pose } };
}

function copyRun(run: ReplaySessionRun, role = run.role): ReplaySessionRun {
  return { ...run, role, samples: run.samples.map(copySample) };
}

function inferRoute(run: ReplaySessionRun): PlannedRoute {
  const first = run.samples[0]?.pose ?? { x: 0, y: 0, yaw: 0 };
  const last = run.samples.at(-1)?.pose ?? first;
  return {
    id: "observed-route",
    name: "Observed start-to-goal route",
    source: "inferred-observation",
    corridorWidth: 0.9,
    closed: false,
    waypoints: [
      { id: "start", x: first.x, y: first.y, yaw: first.yaw, label: "Start" },
      { id: "goal", x: last.x, y: last.y, yaw: last.yaw, label: "Goal" },
    ],
  };
}

function inferredEnvironment(run: ReplaySessionRun): ReplayEnvironment {
  let minX = 0;
  let maxX = 0;
  let minY = 0;
  let maxY = 0;
  for (const { pose } of run.samples) {
    minX = Math.min(minX, pose.x);
    maxX = Math.max(maxX, pose.x);
    minY = Math.min(minY, pose.y);
    maxY = Math.max(maxY, pose.y);
  }
  return {
    name: "Imported local map",
    floorBounds: { minX: minX - 2, maxX: maxX + 2, minY: minY - 2, maxY: maxY + 2 },
    objects: [],
  };
}

function mergeRobot(robot: CreateReplaySessionOptions["robot"] = {}): RobotMetadata {
  const footprint = { ...UNKNOWN_ROBOT.footprint, ...robot.footprint };
  return { ...UNKNOWN_ROBOT, ...robot, footprint };
}

function defaultMission(id: string, candidate: ReplaySessionRun): MissionMetadata {
  return {
    id,
    title: candidate.name,
    subtitle: "Autonomy telemetry investigation",
    site: "Local replay",
    objective: "Review the candidate run against available evidence.",
    outcome: candidate.kind === "normal" ? "nominal" : "degraded",
    scenario: "imported-recording",
    tags: ["autonomy", "telemetry", "incident-analysis"],
  };
}

function defaultSessionId(candidateId: string): string {
  const descriptive = `session-${candidateId}`;
  return descriptive.length <= MAX_REPLAY_IDENTIFIER_LENGTH
    ? descriptive
    : `session-${sha256Text(candidateId).slice(0, 32)}`;
}

/**
 * Build a complete v2 session around one normalized candidate run. Importers
 * can therefore remain focused on decoding rather than inventing UI metadata.
 */
export function createReplaySession(options: CreateReplaySessionOptions): ReplaySessionV2 {
  const id = options.id?.trim() || defaultSessionId(options.candidate.id);
  const mission = { ...defaultMission(id, options.candidate), ...options.mission };
  mission.tags = [...(options.mission?.tags ?? defaultMission(id, options.candidate).tags)];
  const candidate = copyRun(options.candidate, "candidate");
  const baseline =
    options.baseline === undefined ? undefined : copyRun(options.baseline, "baseline");
  const plannedRoute = options.plannedRoute ?? inferRoute(baseline ?? candidate);
  const environment = options.environment ?? inferredEnvironment(candidate);
  const robot = mergeRobot(options.robot);
  const coordinateFrame = { ...(options.coordinateFrame ?? DEFAULT_COORDINATE_FRAME) };
  const detectors = cloneDetectorConfiguration(
    options.detectors ?? createDefaultDetectorConfiguration(),
  );
  const annotations = (options.annotations ?? []).map((annotation) => ({ ...annotation }));
  const provenance: SessionProvenance = {
    source: options.provenance?.source ?? "json",
    label: options.provenance?.label ?? candidate.name,
    importedAt: options.provenance?.importedAt ?? null,
    // Filled from the complete normalized session below when the caller did
    // not provide an authoritative source digest.
    sha256: options.provenance?.sha256 ?? "0".repeat(64),
    deterministic: options.provenance?.deterministic ?? false,
    ...(options.provenance?.rootSessionSha256 === undefined
      ? {}
      : { rootSessionSha256: options.provenance.rootSessionSha256 }),
    ...(options.provenance?.parentSessionId === undefined
      ? {}
      : { parentSessionId: options.provenance.parentSessionId }),
    ...(options.provenance?.notes === undefined ? {} : { notes: [...options.provenance.notes] }),
  };

  const session: ReplaySessionV2 = {
    schema: REPLAY_SESSION_SCHEMA,
    id,
    mission,
    robot,
    coordinateFrame,
    environment: {
      ...environment,
      floorBounds: { ...environment.floorBounds },
      objects: environment.objects.map((object) => ({ ...object })),
    },
    plannedRoute: {
      ...plannedRoute,
      waypoints: plannedRoute.waypoints.map((waypoint) => ({ ...waypoint })),
    },
    runs: { candidate, ...(baseline === undefined ? {} : { baseline }) },
    detectors,
    annotations,
    transformations: [],
    provenance,
  };
  if (options.provenance?.sha256 === undefined) {
    session.provenance.sha256 = fingerprintReplaySessionContent(session);
  }
  assertReplaySession(session);
  return session;
}

export function cloneDetectorConfiguration(
  configuration: DetectorConfiguration,
): DetectorConfiguration {
  const rules = {} as Record<DetectorId, DetectorRuleConfig>;
  for (const [id, rule] of Object.entries(configuration.rules) as Array<
    [DetectorId, DetectorRuleConfig]
  >) {
    rules[id] = { ...rule };
  }
  return { version: configuration.version, rules };
}

/** Deep clone the data-only session model, suitable for local fault branches. */
export function cloneReplaySession(session: ReplaySessionV2): ReplaySessionV2 {
  return {
    ...session,
    mission: { ...session.mission, tags: [...session.mission.tags] },
    robot: { ...session.robot, footprint: { ...session.robot.footprint } },
    coordinateFrame: { ...session.coordinateFrame },
    environment: {
      ...session.environment,
      floorBounds: { ...session.environment.floorBounds },
      objects: session.environment.objects.map((object) => ({ ...object })),
    },
    plannedRoute: {
      ...session.plannedRoute,
      waypoints: session.plannedRoute.waypoints.map((waypoint) => ({ ...waypoint })),
    },
    runs: {
      candidate: copyRun(session.runs.candidate),
      ...(session.runs.baseline === undefined ? {} : { baseline: copyRun(session.runs.baseline) }),
    },
    detectors: cloneDetectorConfiguration(session.detectors),
    annotations: session.annotations.map((annotation) => ({ ...annotation })),
    transformations: session.transformations.map((transformation) => ({
      ...transformation,
      parameters: { ...transformation.parameters },
    })),
    provenance: {
      ...session.provenance,
      ...(session.provenance.notes === undefined ? {} : { notes: [...session.provenance.notes] }),
    },
  };
}

/** Fingerprint every normalized field that can change replay interpretation. */
export function fingerprintReplaySessionContent(session: ReplaySessionV2): string {
  return sha256StableValue({
    schema: session.schema,
    id: session.id,
    mission: session.mission,
    robot: session.robot,
    coordinateFrame: session.coordinateFrame,
    environment: session.environment,
    plannedRoute: session.plannedRoute,
    runs: session.runs,
    detectors: session.detectors,
    annotations: session.annotations,
    transformations: session.transformations,
  });
}

/**
 * Fingerprint mutable analysis context separately from faulted candidate
 * samples. This keeps cumulative branches canonical while still making rule,
 * map, route, footprint, baseline, and annotation changes identity-bearing.
 */
export function fingerprintReplaySessionInterpretation(session: ReplaySessionV2): string {
  return sha256StableValue({
    schema: session.schema,
    robot: session.robot,
    coordinateFrame: session.coordinateFrame,
    environment: session.environment,
    plannedRoute: session.plannedRoute,
    baseline: session.runs.baseline,
    detectors: session.detectors,
    annotations: session.annotations,
  });
}

/** Adapt a strict v1 run without fabricating optional v2 measurements. */
export function sessionRunFromTelemetryRun(
  run: TelemetryRun,
  role: ReplaySessionRun["role"] = "candidate",
): ReplaySessionRun {
  return {
    ...run,
    role,
    samples: run.samples.map((sample) => ({
      timestamp: sample.timestamp,
      pose: { ...sample.pose },
      sequence: sample.sequence,
      speed: sample.speed,
      battery: sample.battery,
      current: sample.current,
      state: sample.state,
      latencyMs: sample.latencyMs ?? null,
      poseSigma: sample.poseSigma ?? null,
    })),
  };
}

/**
 * Adapt a complete v2 run for legacy renderers. This deliberately throws when
 * a required legacy channel is missing instead of substituting a false zero.
 */
export function telemetryRunFromSessionRun(run: ReplaySessionRun): TelemetryRun {
  return {
    id: run.id,
    name: run.name,
    kind: run.kind,
    ...(run.description === undefined ? {} : { description: run.description }),
    ...(run.sampleRateHz === undefined ? {} : { sampleRateHz: run.sampleRateHz }),
    samples: run.samples.map((sample, index) => {
      const path = `samples[${index}]`;
      if (sample.sequence === null) {
        throw new ReplaySessionValidationError([
          { path: `${path}.sequence`, message: "is required by the legacy replay renderer" },
        ]);
      }
      if (sample.speed === null || sample.battery === null || sample.current === null) {
        const missing = ["speed", "battery", "current"].find(
          (field) => sample[field as "speed" | "battery" | "current"] === null,
        );
        throw new ReplaySessionValidationError([
          {
            path: `${path}.${missing ?? "channel"}`,
            message: "is required by the legacy replay renderer",
          },
        ]);
      }
      if (sample.state === null) {
        throw new ReplaySessionValidationError([
          { path: `${path}.state`, message: "is required by the legacy replay renderer" },
        ]);
      }
      return {
        timestamp: sample.timestamp,
        sequence: sample.sequence,
        pose: { ...sample.pose },
        speed: sample.speed,
        battery: sample.battery,
        current: sample.current,
        state: sample.state,
        latencyMs: sample.latencyMs,
        poseSigma: sample.poseSigma,
      };
    }),
  };
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function identifierIssue(value: string): string | null {
  if (value.trim() === "") {
    return "must not be empty";
  }
  if (value !== value.trim()) {
    return "must not contain leading or trailing whitespace";
  }
  if (value !== value.normalize("NFC")) {
    return "must use NFC Unicode normalization";
  }
  return value.length <= MAX_REPLAY_IDENTIFIER_LENGTH
    ? null
    : `must contain at most ${MAX_REPLAY_IDENTIFIER_LENGTH} characters`;
}

function validIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    match[1],
    match[2],
    match[3],
    match[4],
    match[5],
    match[6],
    match[7] ?? "0",
    match[8] ?? "0",
  ].map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= (days[month - 1] ?? 0) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

/** Validate an already type-safe session. Use isReplaySessionV2 at unknown-data boundaries. */
export function collectSessionValidationIssues(session: ReplaySessionV2): SessionValidationIssue[] {
  const issues: SessionValidationIssue[] = [];
  const validateDenseArray = (values: readonly unknown[], path: string): void => {
    for (let index = 0; index < values.length; index += 1) {
      if (!Object.prototype.hasOwnProperty.call(values, index)) {
        issues.push({ path: `${path}[${index}]`, message: "must not be a sparse array entry" });
      }
    }
  };
  validateDenseArray(session.mission.tags, "mission.tags");
  validateDenseArray(session.environment.objects, "environment.objects");
  validateDenseArray(session.plannedRoute.waypoints, "plannedRoute.waypoints");
  validateDenseArray(session.runs.candidate.samples, "runs.candidate.samples");
  if (session.runs.baseline !== undefined) {
    validateDenseArray(session.runs.baseline.samples, "runs.baseline.samples");
  }
  validateDenseArray(session.annotations, "annotations");
  validateDenseArray(session.transformations, "transformations");
  if (session.provenance.notes !== undefined) {
    validateDenseArray(session.provenance.notes, "provenance.notes");
  }
  const validateIdentifier = (value: string, path: string): void => {
    const message = identifierIssue(value);
    if (message !== null) {
      issues.push({ path, message });
    }
  };
  const validateUniqueIds = (entries: readonly { id: string }[], path: string): void => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      if (seen.has(entry.id)) {
        issues.push({ path: `${path}[${index}].id`, message: `duplicates identifier ${entry.id}` });
      }
      seen.add(entry.id);
    });
  };
  if (session.schema !== REPLAY_SESSION_SCHEMA) {
    issues.push({ path: "schema", message: `must equal ${REPLAY_SESSION_SCHEMA}` });
  }
  validateIdentifier(session.id, "id");
  validateIdentifier(session.mission.id, "mission.id");
  validateIdentifier(session.robot.id, "robot.id");
  validateIdentifier(session.coordinateFrame.id, "coordinateFrame.id");
  if (session.coordinateFrame.parent !== undefined) {
    validateIdentifier(session.coordinateFrame.parent, "coordinateFrame.parent");
  }
  validateIdentifier(session.plannedRoute.id, "plannedRoute.id");
  for (const [path, value] of [
    ["mission.title", session.mission.title],
    ["mission.subtitle", session.mission.subtitle],
    ["mission.site", session.mission.site],
    ["mission.objective", session.mission.objective],
    ["mission.scenario", session.mission.scenario],
    ["robot.name", session.robot.name],
    ["robot.model", session.robot.model],
    ["coordinateFrame.label", session.coordinateFrame.label],
    ["environment.name", session.environment.name],
    ["plannedRoute.name", session.plannedRoute.name],
    ["provenance.label", session.provenance.label],
  ] as const) {
    if (value.trim() === "") issues.push({ path, message: "must not be empty" });
  }
  if (session.provenance.importedAt !== null && !validIsoTimestamp(session.provenance.importedAt)) {
    issues.push({
      path: "provenance.importedAt",
      message: "must be a valid ISO-8601 timestamp or null",
    });
  }
  if (
    session.plannedRoute.source !== "mission-plan" &&
    session.plannedRoute.source !== "inferred-observation"
  ) {
    issues.push({
      path: "plannedRoute.source",
      message: 'must explicitly equal "mission-plan" or "inferred-observation"',
    });
  }
  if (session.runs.candidate.role !== "candidate") {
    issues.push({ path: "runs.candidate.role", message: 'must equal "candidate"' });
  }
  if (session.runs.baseline !== undefined && session.runs.baseline.role !== "baseline") {
    issues.push({ path: "runs.baseline.role", message: 'must equal "baseline"' });
  }
  if (
    session.runs.baseline !== undefined &&
    session.runs.baseline.id === session.runs.candidate.id
  ) {
    issues.push({
      path: "runs.baseline.id",
      message: "must differ from runs.candidate.id so comparison evidence remains attributable",
    });
  }
  if (session.plannedRoute.waypoints.length < 2) {
    issues.push({ path: "plannedRoute.waypoints", message: "must contain at least two points" });
  }
  if (!finite(session.plannedRoute.corridorWidth) || session.plannedRoute.corridorWidth <= 0) {
    issues.push({ path: "plannedRoute.corridorWidth", message: "must be greater than zero" });
  }
  session.plannedRoute.waypoints.forEach((waypoint, index) => {
    validateIdentifier(waypoint.id, `plannedRoute.waypoints[${index}].id`);
    if (
      !finite(waypoint.x) ||
      !finite(waypoint.y) ||
      (waypoint.yaw !== undefined && !finite(waypoint.yaw))
    ) {
      issues.push({
        path: `plannedRoute.waypoints[${index}]`,
        message: "must contain finite x, y, and optional yaw values",
      });
    }
  });
  validateUniqueIds(session.plannedRoute.waypoints, "plannedRoute.waypoints");
  if (session.plannedRoute.waypoints.length >= 2) {
    const segmentCount = session.plannedRoute.closed
      ? session.plannedRoute.waypoints.length
      : session.plannedRoute.waypoints.length - 1;
    const hasNonDegenerateSegment = Array.from({ length: segmentCount }, (_, index) => {
      const from = session.plannedRoute.waypoints[index];
      const to = session.plannedRoute.waypoints[index + 1] ?? session.plannedRoute.waypoints[0];
      return (
        from !== undefined &&
        to !== undefined &&
        finite(from.x) &&
        finite(from.y) &&
        finite(to.x) &&
        finite(to.y) &&
        (from.x !== to.x || from.y !== to.y)
      );
    }).some(Boolean);
    if (!hasNonDegenerateSegment && session.plannedRoute.source !== "inferred-observation") {
      issues.push({
        path: "plannedRoute.waypoints",
        message: "must define at least one non-zero-length segment",
      });
    }
  }
  const footprint = session.robot.footprint;
  if (
    !finite(footprint.length) ||
    !finite(footprint.width) ||
    !finite(footprint.safetyMargin) ||
    footprint.length <= 0 ||
    footprint.width <= 0 ||
    footprint.safetyMargin < 0
  ) {
    issues.push({
      path: "robot.footprint",
      message: "length/width must be positive and safetyMargin must be non-negative",
    });
  }
  const bounds = session.environment.floorBounds;
  if (
    !finite(bounds.minX) ||
    !finite(bounds.maxX) ||
    !finite(bounds.minY) ||
    !finite(bounds.maxY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    issues.push({
      path: "environment.floorBounds",
      message: "must contain finite ordered bounds with each maximum greater than its minimum",
    });
  }
  session.environment.objects.forEach((object, index) => {
    const objectPath = `environment.objects[${index}]`;
    validateIdentifier(object.id, `${objectPath}.id`);
    if (
      !finite(object.x) ||
      !finite(object.y) ||
      !finite(object.width) ||
      !finite(object.depth) ||
      !finite(object.height) ||
      object.width <= 0 ||
      object.depth <= 0 ||
      object.height < 0
    ) {
      issues.push({
        path: objectPath,
        message: "must contain finite coordinates, positive width/depth, and non-negative height",
      });
    }
  });
  validateUniqueIds(session.environment.objects, "environment.objects");
  if (
    session.robot.nominalVoltage !== undefined &&
    (!finite(session.robot.nominalVoltage) || session.robot.nominalVoltage <= 0)
  ) {
    issues.push({ path: "robot.nominalVoltage", message: "must be a positive finite number" });
  }
  for (const [runKey, run] of [
    ["candidate", session.runs.candidate],
    ["baseline", session.runs.baseline],
  ] as const) {
    if (run === undefined) {
      continue;
    }
    if (run.samples.length === 0) {
      issues.push({ path: `runs.${runKey}.samples`, message: "must not be empty" });
      continue;
    }
    validateIdentifier(run.id, `runs.${runKey}.id`);
    if (run.sampleRateHz !== undefined) {
      const sampleRateIssue = sampleRateConfigurationIssue(run.sampleRateHz);
      if (sampleRateIssue !== null) {
        issues.push({ path: `runs.${runKey}.sampleRateHz`, message: sampleRateIssue });
      }
    }
    run.samples.forEach((sample, index) => {
      const path = `runs.${runKey}.samples[${index}]`;
      if (!finite(sample.timestamp) || sample.timestamp < 0) {
        issues.push({ path: `${path}.timestamp`, message: "must be a non-negative finite number" });
      }
      if (!finite(sample.pose.x) || !finite(sample.pose.y) || !finite(sample.pose.yaw)) {
        issues.push({ path: `${path}.pose`, message: "must contain finite x, y, and yaw" });
      }
      if (index > 0 && sample.timestamp <= (run.samples[index - 1]?.timestamp ?? -1)) {
        issues.push({ path: `${path}.timestamp`, message: "must increase strictly" });
      }
      if (
        sample.sequence !== null &&
        (!Number.isSafeInteger(sample.sequence) || sample.sequence < 0)
      ) {
        issues.push({
          path: `${path}.sequence`,
          message: "must be null or a non-negative safe integer",
        });
      }
      for (const field of ["speed", "battery", "current", "latencyMs", "poseSigma"] as const) {
        if (sample[field] !== null && !finite(sample[field])) {
          issues.push({ path: `${path}.${field}`, message: "must be null or finite" });
        }
      }
      if (sample.battery !== null && (sample.battery < 0 || sample.battery > 100)) {
        issues.push({ path: `${path}.battery`, message: "must be between 0 and 100" });
      }
      if (sample.latencyMs !== null && sample.latencyMs < 0) {
        issues.push({ path: `${path}.latencyMs`, message: "must not be negative" });
      }
      if (sample.poseSigma !== null && sample.poseSigma < 0) {
        issues.push({ path: `${path}.poseSigma`, message: "must not be negative" });
      }
      if (sample.state !== null && sample.state.trim() === "") {
        issues.push({ path: `${path}.state`, message: "must be null or a non-empty string" });
      }
    });
  }
  if (!/^[0-9a-f]{64}$/.test(session.provenance.sha256)) {
    issues.push({ path: "provenance.sha256", message: "must be 64 lowercase hexadecimal digits" });
  }
  if (
    session.provenance.rootSessionSha256 !== undefined &&
    !/^[0-9a-f]{64}$/.test(session.provenance.rootSessionSha256)
  ) {
    issues.push({
      path: "provenance.rootSessionSha256",
      message: "must be 64 lowercase hexadecimal digits when provided",
    });
  }
  if (session.provenance.parentSessionId !== undefined) {
    validateIdentifier(session.provenance.parentSessionId, "provenance.parentSessionId");
  }
  const configuredDetectorIds = Object.keys(session.detectors.rules);
  for (const configuredId of configuredDetectorIds) {
    if (!(DETECTOR_IDS as readonly string[]).includes(configuredId)) {
      issues.push({
        path: `detectors.rules.${configuredId}`,
        message: "is not part of the supported analyzer contract",
      });
    }
  }
  for (const id of DETECTOR_IDS) {
    if (session.detectors.rules[id] === undefined) {
      issues.push({ path: `detectors.rules.${id}`, message: "is required" });
    }
  }
  if (session.detectors.version !== DETECTOR_CONFIGURATION_VERSION) {
    issues.push({
      path: "detectors.version",
      message: `must equal supported analyzer contract ${DETECTOR_CONFIGURATION_VERSION}`,
    });
  }
  for (const [id, rule] of Object.entries(session.detectors.rules) as Array<
    [DetectorId, DetectorRuleConfig]
  >) {
    if (rule.id !== id) {
      issues.push({ path: `detectors.rules.${id}.id`, message: `must equal ${id}` });
    }
    if (rule.version !== DETECTOR_CONFIGURATION_VERSION) {
      issues.push({
        path: `detectors.rules.${id}.version`,
        message: `must equal supported analyzer contract ${DETECTOR_CONFIGURATION_VERSION}`,
      });
    }
    for (const message of detectorRuleConfigurationIssues(id, rule)) {
      issues.push({
        path: message.startsWith("threshold")
          ? `detectors.rules.${id}.threshold`
          : `detectors.rules.${id}.minimumDuration`,
        message,
      });
    }
  }
  session.annotations.forEach((annotation, index) => {
    const annotationPath = `annotations[${index}]`;
    validateIdentifier(annotation.id, `${annotationPath}.id`);
    if (!finite(annotation.timestamp) || annotation.timestamp < 0) {
      issues.push({
        path: `${annotationPath}.timestamp`,
        message: "must be a non-negative finite number",
      });
    }
  });
  validateUniqueIds(session.annotations, "annotations");

  const firstTimestamp = session.runs.candidate.samples[0]?.timestamp;
  const lastTimestamp = session.runs.candidate.samples.at(-1)?.timestamp;
  session.transformations.forEach((transformation, index) => {
    const transformationPath = `transformations[${index}]`;
    validateIdentifier(transformation.id, `${transformationPath}.id`);
    if (
      !Number.isSafeInteger(transformation.affectedSamples) ||
      transformation.affectedSamples <= 0
    ) {
      issues.push({
        path: `${transformationPath}.affectedSamples`,
        message: "must be a positive safe integer",
      });
    }
    if (
      !finite(transformation.startTimestamp) ||
      firstTimestamp === undefined ||
      lastTimestamp === undefined ||
      transformation.startTimestamp < firstTimestamp ||
      transformation.startTimestamp > lastTimestamp
    ) {
      issues.push({
        path: `${transformationPath}.startTimestamp`,
        message: "must fall inside the candidate run",
      });
    }
    const expectedKeys =
      transformation.type === "packet-dropout"
        ? ["duration"]
        : transformation.type === "pose-reset"
          ? ["offsetX", "offsetY", "offsetYaw"]
          : ["duration", "multiplier"];
    const actualKeys = Object.keys(transformation.parameters);
    if (
      actualKeys.length !== expectedKeys.length ||
      expectedKeys.some(
        (key) => !Object.prototype.hasOwnProperty.call(transformation.parameters, key),
      )
    ) {
      issues.push({
        path: `${transformationPath}.parameters`,
        message: `must contain exactly ${expectedKeys.join(", ")} for ${transformation.type}`,
      });
    }
    const parameter = (key: string): number | undefined => transformation.parameters[key];
    const range = (key: string, minimum: number, maximum: number): void => {
      const value = parameter(key);
      if (!finite(value) || value < minimum || value > maximum) {
        issues.push({
          path: `${transformationPath}.parameters.${key}`,
          message: `must be finite and between ${minimum} and ${maximum}`,
        });
      }
    };
    if (transformation.type === "packet-dropout") {
      range("duration", 0.1, 3);
    } else if (transformation.type === "pose-reset") {
      range("offsetX", -2, 2);
      range("offsetY", -2, 2);
      range("offsetYaw", -Math.PI / 2, Math.PI / 2);
      if (
        parameter("offsetX") === 0 &&
        parameter("offsetY") === 0 &&
        parameter("offsetYaw") === 0
      ) {
        issues.push({
          path: `${transformationPath}.parameters`,
          message: "must include at least one non-zero pose offset",
        });
      }
    } else {
      range("duration", 0.5, 5);
      range("multiplier", 1, 3);
      if (parameter("multiplier") === 1) {
        issues.push({
          path: `${transformationPath}.parameters.multiplier`,
          message: "must change the recorded current",
        });
      }
    }
    if (
      lastTimestamp !== undefined &&
      transformation.type !== "pose-reset" &&
      transformation.startTimestamp >= lastTimestamp
    ) {
      issues.push({
        path: `${transformationPath}.startTimestamp`,
        message: `must precede the final candidate sample for ${transformation.type}`,
      });
    }
    const duration = parameter("duration");
    const expectedEnd =
      lastTimestamp === undefined
        ? undefined
        : transformation.type === "pose-reset" || !finite(duration)
          ? lastTimestamp
          : Math.min(lastTimestamp, transformation.startTimestamp + duration);
    if (
      !finite(transformation.endTimestamp) ||
      expectedEnd === undefined ||
      Math.abs(transformation.endTimestamp - expectedEnd) > 1e-9
    ) {
      issues.push({
        path: `${transformationPath}.endTimestamp`,
        message: "must match the type-specific transformation window",
      });
    }
  });
  validateUniqueIds(session.transformations, "transformations");
  return issues;
}

export function assertReplaySession(session: ReplaySessionV2): void {
  const issues = collectSessionValidationIssues(session);
  if (issues.length > 0) {
    throw new ReplaySessionValidationError(issues);
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function strings(recordValue: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.every((key) => nonEmptyString(recordValue[key]));
}

function denseArray(value: unknown): value is unknown[] {
  if (!Array.isArray(value)) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      return false;
    }
  }
  return true;
}

function oneOf(value: unknown, values: readonly string[]): boolean {
  return typeof value === "string" && values.includes(value);
}

function hasReplaySessionStructure(value: unknown): value is ReplaySessionV2 {
  if (!record(value)) return false;
  const mission = value.mission;
  const robot = value.robot;
  const frame = value.coordinateFrame;
  const environment = value.environment;
  const route = value.plannedRoute;
  const runs = value.runs;
  const detectors = value.detectors;
  const detectorRules = record(detectors) && record(detectors.rules) ? detectors.rules : undefined;
  const provenance = value.provenance;
  if (
    !strings(value, ["schema", "id"]) ||
    !record(mission) ||
    !strings(mission, ["id", "title", "subtitle", "site", "objective", "outcome", "scenario"]) ||
    !denseArray(mission.tags) ||
    !mission.tags.every(nonEmptyString) ||
    !oneOf(mission.outcome, ["nominal", "degraded", "safe-stop"]) ||
    !record(robot) ||
    !strings(robot, ["id", "name", "model", "drive"]) ||
    !oneOf(robot.drive, ["differential", "ackermann", "omnidirectional", "unknown"]) ||
    !record(robot.footprint) ||
    ![robot.footprint.length, robot.footprint.width, robot.footprint.safetyMargin].every(finite) ||
    (robot.nominalVoltage !== undefined && !finite(robot.nominalVoltage)) ||
    !record(frame) ||
    !strings(frame, ["id", "label", "convention", "linearUnit", "angularUnit"]) ||
    !oneOf(frame.convention, ["x-east-y-north", "x-forward-y-left"]) ||
    frame.linearUnit !== "metre" ||
    frame.angularUnit !== "radian" ||
    (frame.parent !== undefined && typeof frame.parent !== "string") ||
    !record(environment) ||
    !strings(environment, ["name"]) ||
    !record(environment.floorBounds) ||
    ![
      environment.floorBounds.minX,
      environment.floorBounds.maxX,
      environment.floorBounds.minY,
      environment.floorBounds.maxY,
    ].every(finite) ||
    !denseArray(environment.objects) ||
    !environment.objects.every(
      (entry) =>
        record(entry) &&
        strings(entry, ["id", "label", "kind"]) &&
        oneOf(entry.kind, ["rack", "wall", "dock", "goal", "obstacle"]) &&
        [entry.x, entry.y, entry.width, entry.depth, entry.height].every(finite),
    ) ||
    !record(route) ||
    !strings(route, ["id", "name", "source"]) ||
    typeof route.closed !== "boolean" ||
    !finite(route.corridorWidth) ||
    !oneOf(route.source, ["mission-plan", "inferred-observation"]) ||
    !denseArray(route.waypoints) ||
    !route.waypoints.every(
      (entry) =>
        record(entry) &&
        strings(entry, ["id"]) &&
        finite(entry.x) &&
        finite(entry.y) &&
        (entry.yaw === undefined || finite(entry.yaw)) &&
        (entry.label === undefined || nonEmptyString(entry.label)),
    ) ||
    !record(runs) ||
    !record(runs.candidate) ||
    (runs.baseline !== undefined && !record(runs.baseline)) ||
    !record(detectors) ||
    !strings(detectors, ["version"]) ||
    detectorRules === undefined ||
    !DETECTOR_IDS.every((id) => {
      const rule = detectorRules[id];
      return (
        record(rule) &&
        strings(rule, ["id", "label", "version", "severity"]) &&
        rule.id === id &&
        typeof rule.enabled === "boolean" &&
        (rule.unavailableReason === undefined || typeof rule.unavailableReason === "string") &&
        finite(rule.threshold) &&
        finite(rule.minimumDuration) &&
        oneOf(rule.severity, ["warning", "critical"])
      );
    }) ||
    !denseArray(value.annotations) ||
    !value.annotations.every(
      (entry) =>
        record(entry) &&
        strings(entry, ["id", "label", "body", "author"]) &&
        finite(entry.timestamp),
    ) ||
    !denseArray(value.transformations) ||
    !value.transformations.every(
      (entry) =>
        record(entry) &&
        strings(entry, ["id", "type"]) &&
        oneOf(entry.type, ["packet-dropout", "pose-reset", "motor-load"]) &&
        finite(entry.startTimestamp) &&
        finite(entry.endTimestamp) &&
        finite(entry.affectedSamples) &&
        record(entry.parameters) &&
        Object.values(entry.parameters).every(finite),
    ) ||
    !record(provenance) ||
    !strings(provenance, ["source", "label", "sha256"]) ||
    typeof provenance.deterministic !== "boolean" ||
    !oneOf(provenance.source, ["synthetic", "json", "csv", "ros-jsonl", "live", "derived"]) ||
    (provenance.importedAt !== null && typeof provenance.importedAt !== "string") ||
    (provenance.notes !== undefined &&
      (!denseArray(provenance.notes) || !provenance.notes.every(nonEmptyString))) ||
    (provenance.parentSessionId !== undefined && typeof provenance.parentSessionId !== "string") ||
    (provenance.rootSessionSha256 !== undefined && typeof provenance.rootSessionSha256 !== "string")
  ) {
    return false;
  }
  const runValues = [runs.candidate, runs.baseline].filter(record);
  return runValues.every(
    (runValue) =>
      strings(runValue, ["id", "name", "role", "kind"]) &&
      oneOf(runValue.role, ["candidate", "baseline"]) &&
      oneOf(runValue.kind, ["normal", "faulty"]) &&
      (runValue.description === undefined || nonEmptyString(runValue.description)) &&
      (runValue.sampleRateHz === undefined || finite(runValue.sampleRateHz)) &&
      denseArray(runValue.samples) &&
      runValue.samples.every(
        (sample) =>
          record(sample) &&
          record(sample.pose) &&
          finite(sample.timestamp) &&
          [sample.pose.x, sample.pose.y, sample.pose.yaw].every(finite) &&
          [
            sample.sequence,
            sample.speed,
            sample.battery,
            sample.current,
            sample.latencyMs,
            sample.poseSigma,
          ].every((entry) => entry === null || finite(entry)) &&
          (sample.state === null || nonEmptyString(sample.state)),
      ),
  );
}

export function isReplaySessionV2(value: unknown): value is ReplaySessionV2 {
  if (!hasReplaySessionStructure(value)) {
    return false;
  }
  try {
    return collectSessionValidationIssues(value).length === 0;
  } catch {
    return false;
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Small dependency-free, blockwise SHA-256 implementation for source bytes. */
export function sha256Bytes(bytes: Uint8Array): string {
  const constants = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const bitLength = bytes.length * 8;
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const lengthOffset = paddedLength - 8;
  const paddedByte = (index: number): number => {
    if (index < bytes.length) return bytes[index] ?? 0;
    if (index === bytes.length) return 0x80;
    if (index < lengthOffset) return 0;
    const lengthIndex = index - lengthOffset;
    const word = lengthIndex < 4 ? high : low;
    return (word >>> ((3 - (lengthIndex % 4)) * 8)) & 0xff;
  };

  const hash = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];
  const words = new Array<number>(64).fill(0);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const byteOffset = offset + index * 4;
      words[index] =
        ((paddedByte(byteOffset) << 24) |
          (paddedByte(byteOffset + 1) << 16) |
          (paddedByte(byteOffset + 2) << 8) |
          paddedByte(byteOffset + 3)) >>>
        0;
    }
    for (let index = 16; index < 64; index += 1) {
      const previous15 = words[index - 15] ?? 0;
      const previous2 = words[index - 2] ?? 0;
      const sigma0 = rotateRight(previous15, 7) ^ rotateRight(previous15, 18) ^ (previous15 >>> 3);
      const sigma1 = rotateRight(previous2, 17) ^ rotateRight(previous2, 19) ^ (previous2 >>> 10);
      words[index] = ((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + (constants[index] ?? 0) + (words[index] ?? 0)) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = ((hash[0] ?? 0) + a) >>> 0;
    hash[1] = ((hash[1] ?? 0) + b) >>> 0;
    hash[2] = ((hash[2] ?? 0) + c) >>> 0;
    hash[3] = ((hash[3] ?? 0) + d) >>> 0;
    hash[4] = ((hash[4] ?? 0) + e) >>> 0;
    hash[5] = ((hash[5] ?? 0) + f) >>> 0;
    hash[6] = ((hash[6] ?? 0) + g) >>> 0;
    hash[7] = ((hash[7] ?? 0) + h) >>> 0;
  }
  return hash
    .map((value) =>
      [24, 16, 8, 0]
        .map((shift) => `${HEX[((value >>> shift) >> 4) & 0xf]}${HEX[(value >>> shift) & 0xf]}`)
        .join(""),
    )
    .join("");
}

/** UTF-8 text companion used for stable normalized-session fingerprints. */
export function sha256Text(text: string): string {
  return sha256Bytes(new TextEncoder().encode(text));
}

export function sha256StableValue(value: unknown): string {
  return sha256Text(stableStringify(value));
}
