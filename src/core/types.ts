/** All telemetry timestamps and replay durations are expressed in seconds. */
export interface Pose2D {
  x: number;
  y: number;
  /** Heading in radians. Values are normalized to [-PI, PI) by interpolation. */
  yaw: number;
}

export interface TelemetrySample {
  timestamp: number;
  sequence: number;
  pose: Pose2D;
  /** Linear speed in metres per second. */
  speed: number;
  /** Remaining battery charge in percent. */
  battery: number;
  /** Motor current in amperes. */
  current: number;
  state: string;
  /** Optional end-to-end link latency in milliseconds. */
  latencyMs?: number | null;
  /** Optional one-sigma planar pose uncertainty in metres. */
  poseSigma?: number | null;
}

export type RunKind = "normal" | "faulty";

export interface TelemetryRun {
  id: string;
  name: string;
  kind: RunKind;
  samples: TelemetrySample[];
  description?: string;
  sampleRateHz?: number;
}

/**
 * A missing-telemetry window between two real, adjacent samples. The interval
 * is open: both boundary timestamps refer to real samples.
 */
export interface TimestampGap {
  startTimestamp: number;
  endTimestamp: number;
  startSampleIndex: number;
  endSampleIndex: number;
  duration: number;
  threshold: number;
}

export type ReplaySampleStatus =
  "exact" | "interpolated" | "held-during-gap" | "before-range" | "after-range";

/** A replay sample together with how it was resolved for the requested time. */
export interface ResolvedTelemetrySample {
  sample: TelemetrySample;
  status: ReplaySampleStatus;
  /** Present only when `status` is `held-during-gap`. */
  gap?: TimestampGap;
}

export type AnomalyType =
  "timestamp-gap" | "sequence-gap" | "pose-discontinuity" | "overcurrent" | "low-battery";

export type AnomalySeverity = "warning" | "critical";

export interface Anomaly {
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  timestamp: number;
  title: string;
  description: string;
  sampleIndex: number;
  /** Present for anomalies which span a contiguous group of samples. */
  endTimestamp?: number;
  details?: Record<string, number | string>;
}

export interface AnomalyDetectionOptions {
  /** Explicit gap threshold in seconds. By default it is inferred from the run. */
  timestampGapThreshold?: number;
  /** Multiplier applied to the inferred nominal sample interval. */
  timestampGapMultiplier?: number;
  /** Absolute distance jump in metres. */
  poseDiscontinuityDistance?: number;
  /** Absolute shortest heading jump in radians. */
  poseDiscontinuityYaw?: number;
  /** Absolute motor current threshold in amperes. */
  overcurrentThreshold?: number;
  /** Remaining charge threshold in percent. */
  lowBatteryThreshold?: number;
}

export interface StateChange {
  timestamp: number;
  sampleIndex: number;
  from: string;
  to: string;
}

export type TimelineMarkerType = "state-change" | AnomalyType;

export interface TimelineMarker {
  id: string;
  type: TimelineMarkerType;
  timestamp: number;
  label: string;
  severity: "info" | AnomalySeverity;
  sampleIndex: number;
}

export interface ReplayClockSnapshot {
  currentTime: number;
  duration: number;
  progress: number;
  playbackRate: number;
  playing: boolean;
}

// ---------------------------------------------------------------------------
// Session v2 domain model
// ---------------------------------------------------------------------------

/** Canonical on-disk schema identifier for Robot Replay Studio sessions. */
export const REPLAY_SESSION_SCHEMA = "robot-replay/session/2.0" as const;

export type ReplaySessionSchema = typeof REPLAY_SESSION_SCHEMA;

/** How a run participates in a candidate-versus-baseline investigation. */
export type ReplayRunRole = "candidate" | "baseline";

/**
 * Normalized v2 telemetry. Units are seconds, metres, radians, amperes,
 * percent, and milliseconds. Missing channels remain null: callers must not
 * reinterpret missing measurements as zero.
 */
export interface SessionTelemetrySample {
  timestamp: number;
  pose: Pose2D;
  sequence: number | null;
  speed: number | null;
  battery: number | null;
  current: number | null;
  state: string | null;
  latencyMs: number | null;
  poseSigma: number | null;
}

export interface ReplaySessionRun {
  id: string;
  name: string;
  role: ReplayRunRole;
  kind: RunKind;
  samples: SessionTelemetrySample[];
  description?: string;
  sampleRateHz?: number;
}

export interface MissionMetadata {
  id: string;
  title: string;
  subtitle: string;
  site: string;
  objective: string;
  outcome: "nominal" | "degraded" | "safe-stop";
  scenario: string;
  tags: string[];
}

export interface RobotFootprint {
  /** Overall bumper-to-bumper length in metres. */
  length: number;
  /** Overall width in metres. */
  width: number;
  /** Additional safety envelope around the physical footprint in metres. */
  safetyMargin: number;
}

export interface RobotMetadata {
  id: string;
  name: string;
  model: string;
  drive: "differential" | "ackermann" | "omnidirectional" | "unknown";
  footprint: RobotFootprint;
  /** Used only for energy estimation; omit when the power bus is unknown. */
  nominalVoltage?: number;
}

export interface CoordinateFrame {
  id: string;
  label: string;
  parent?: string;
  convention: "x-east-y-north" | "x-forward-y-left";
  linearUnit: "metre";
  angularUnit: "radian";
}

export interface RouteWaypoint {
  id: string;
  x: number;
  y: number;
  /** Desired heading in radians. */
  yaw?: number;
  label?: string;
}

export interface PlannedRoute {
  id: string;
  name: string;
  /** Distinguishes an actual mission plan from a display-only inferred line. */
  source: "mission-plan" | "inferred-observation";
  waypoints: RouteWaypoint[];
  /** Total permitted route-error band width in metres. */
  corridorWidth: number;
  closed: boolean;
}

export type EnvironmentObjectKind = "rack" | "wall" | "dock" | "goal" | "obstacle";

/** Axis-aligned environment object, deliberately easy to render procedurally. */
export interface EnvironmentObject {
  id: string;
  label: string;
  kind: EnvironmentObjectKind;
  x: number;
  y: number;
  width: number;
  depth: number;
  height: number;
}

export interface ReplayEnvironment {
  name: string;
  floorBounds: {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
  };
  objects: EnvironmentObject[];
}

export type SessionSourceKind = "synthetic" | "json" | "csv" | "ros-jsonl" | "live" | "derived";

export interface SessionProvenance {
  source: SessionSourceKind;
  label: string;
  importedAt: string | null;
  /** Lowercase SHA-256 hexadecimal digest of the normalized source. */
  sha256: string;
  deterministic: boolean;
  /**
   * Stable fingerprint of the pristine root session, including the telemetry
   * and interpretation-critical context used by deterministic fault branches.
   */
  rootSessionSha256?: string;
  parentSessionId?: string;
  notes?: string[];
}

export type DetectorId =
  | "timestamp-gap"
  | "sequence-gap"
  | "pose-discontinuity"
  | "overcurrent"
  | "low-battery"
  | "link-degradation"
  | "route-deviation"
  | "heading-error"
  | "obstacle-clearance"
  | "safe-stop";

export interface DetectorRuleConfig {
  id: DetectorId;
  label: string;
  version: string;
  enabled: boolean;
  /** Human-readable reason when the input does not provide a required channel. */
  unavailableReason?: string;
  /** Primary threshold in the detector's documented unit. */
  threshold: number;
  /** Minimum qualifying episode duration in seconds. */
  minimumDuration: number;
  severity: AnomalySeverity;
}

export interface DetectorConfiguration {
  version: string;
  rules: Record<DetectorId, DetectorRuleConfig>;
}

export interface ReplayAnnotation {
  id: string;
  timestamp: number;
  label: string;
  body: string;
  author: string;
}

export type FaultTransformationType = "packet-dropout" | "pose-reset" | "motor-load";

export interface PacketDropoutFault {
  type: "packet-dropout";
  startTimestamp: number;
  duration: number;
}

export interface PoseResetFault {
  type: "pose-reset";
  startTimestamp: number;
  offsetX: number;
  offsetY: number;
  offsetYaw: number;
}

export interface MotorLoadFault {
  type: "motor-load";
  startTimestamp: number;
  duration: number;
  multiplier: number;
}

export type FaultSpecification = PacketDropoutFault | PoseResetFault | MotorLoadFault;

export interface AppliedFaultTransformation {
  id: string;
  type: FaultTransformationType;
  startTimestamp: number;
  endTimestamp: number;
  parameters: Record<string, number>;
  affectedSamples: number;
}

export interface ReplaySessionV2 {
  schema: ReplaySessionSchema;
  id: string;
  mission: MissionMetadata;
  robot: RobotMetadata;
  coordinateFrame: CoordinateFrame;
  environment: ReplayEnvironment;
  plannedRoute: PlannedRoute;
  runs: {
    candidate: ReplaySessionRun;
    baseline?: ReplaySessionRun;
  };
  detectors: DetectorConfiguration;
  annotations: ReplayAnnotation[];
  transformations: AppliedFaultTransformation[];
  provenance: SessionProvenance;
}

export interface DerivedSampleMetrics {
  timestamp: number;
  sampleIndex: number;
  crossTrackError: number;
  headingError: number;
  baselinePositionDelta: number | null;
  intervalJitterMs: number | null;
  dataAgeMs: number | null;
  cumulativeEnergyWh: number | null;
  /** Null when the session has no usable collision geometry. */
  obstacleClearance: number | null;
}

export interface AnalysisSummary {
  duration: number;
  sampleCount: number;
  maxCrossTrackError: number;
  maxHeadingError: number;
  maxBaselinePositionDelta: number | null;
  packetDeliveryPercent: number | null;
  intervalJitterP95Ms: number | null;
  maxDataAgeMs: number | null;
  energyEstimateWh: number | null;
  /** Null when obstacle clearance is unavailable. */
  minObstacleClearance: number | null;
  peakCurrent: number | null;
  minBattery: number | null;
  maxLatencyMs: number | null;
}

export type EvidenceComparator = "above" | "below" | "equal" | "state-entered";

export interface IncidentEvidence {
  observed: number | string;
  threshold: number | string;
  comparator: EvidenceComparator;
  unit: string;
  baselineDelta: number | null;
  duration: number;
  sampleRange: [number, number];
  supportingSampleIndices: number[];
  operatorCheck: string;
}

export interface SessionIncident {
  id: string;
  detectorId: DetectorId;
  ruleVersion: string;
  severity: AnomalySeverity;
  timestamp: number;
  endTimestamp: number;
  sampleIndex: number;
  title: string;
  description: string;
  evidence: IncidentEvidence;
}

export type EvidenceChainClassification =
  "earliest-crossing" | "subsequent-crossing" | "protective-response";

export interface EvidenceChainStep {
  incidentId: string;
  classification: EvidenceChainClassification;
  elapsedFromPrevious: number | null;
  rationale: string;
}

export interface EvidenceChain {
  id: string;
  title: string;
  summary: string;
  steps: EvidenceChainStep[];
  /** Always true: temporal association is deliberately not presented as proof. */
  correlationIsNotCausation: true;
}

export interface SessionAnalysis {
  sessionId: string;
  runId: string;
  detectorVersion: string;
  metrics: DerivedSampleMetrics[];
  summary: AnalysisSummary;
  incidents: SessionIncident[];
  evidenceChains: EvidenceChain[];
  disabledDetectors: Array<{ id: DetectorId; reason: string }>;
}
