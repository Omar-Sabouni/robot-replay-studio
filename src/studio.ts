import {
  createTelemetryCharts,
  type TelemetryChartController,
  type TelemetryIncidentWindow,
  type TelemetryMetricInput,
} from "./charts";
import {
  analyzeSession,
  deriveSessionMetrics,
  resolveDetectorAvailability,
  resolveEffectiveTimestampGapThreshold,
  summarizeSessionAnalysis,
} from "./core/analysis";
import type {
  AnalysisWorkerRequest,
  AnalysisWorkerResponse,
  AnalysisWorkerResult,
} from "./core/analysis-worker";
import { applyFaultBranch } from "./core/faults";
import { ReplayClock } from "./core/replay-clock";
import {
  generateEastLoopScenario,
  generateScenario,
  listScenarioDescriptors,
  type ScenarioId,
} from "./core/scenarios";
import {
  cloneDetectorConfiguration,
  cloneReplaySession,
  createReplaySession,
  fingerprintReplaySessionContent,
  sha256StableValue,
} from "./core/session";
import { getTimestampGaps, resolveTelemetrySample } from "./core/telemetry";
import type {
  Anomaly,
  AnomalyType,
  DetectorConfiguration,
  DetectorId,
  DerivedSampleMetrics,
  FaultSpecification,
  ReplaySessionRun,
  ReplaySessionV2,
  SessionAnalysis,
  SessionIncident,
  SessionTelemetrySample,
  TelemetryRun,
  TelemetrySample,
  TimestampGap,
} from "./core/types";
import { assertReplaySessionImportLimits } from "./core/import-limits";
import type { ImportedRecording, ImportRecordingOptions } from "./core/importers";
import type {
  LiveTransport,
  LiveTransportSnapshot,
  LiveTransportUpdate,
} from "./core/live-transport";
import type {
  RobotCameraMode,
  RobotReplayScene,
  SceneMarker,
  SceneObstacle,
  SceneTrajectoryPoint,
  SceneWarehouseLayout,
} from "./scene";
import { SpatialFallbackView } from "./spatial-fallback";
import {
  renderReplayStats,
  renderEvidencePanel,
  renderIncidentList,
  renderInspectorTabState,
  renderMissionChoices,
  renderMissionOutcome,
  renderMobileTabState,
  renderRulesPanel,
  renderSamplePanel,
  renderTimeline,
  type InspectorView,
  type MissionChoice,
  type MobileView,
  type SparklinePoint,
} from "./ui/renderers";
import {
  detectorUnit,
  formatStateLabel,
  formatTimecode,
  sessionRunToTelemetryRun,
} from "./ui/session-view";
import { renderAppShell } from "./ui/shell";

const SCENE_POSE_LIMIT = 4_000;
const MOBILE_QUERY = "(max-width: 760px)";
const MAIN_THREAD_FALLBACK_SAMPLE_LIMIT = 20_000;
const MAIN_THREAD_FALLBACK_WORK_LIMIT = 2_000_000;
const CONTINUITY_SCENARIO_KEY = "robot-replay-studio:scenario";
const CONTINUITY_INCIDENT_PREFIX = "robot-replay-studio:incident:";

type SeverityFilter = "all" | SessionIncident["severity"];
type SignalPreset = "investigation" | "power";

interface SessionLoadOptions {
  analysis?: SessionAnalysis;
  setPristine?: boolean;
  catalogIdentity?: ScenarioId | null;
  signal?: AbortSignal;
  seekTimestamp?: number;
  preserveSelection?: boolean;
  announce?: string;
}

const CUSTOM_MISSION_CHOICE = "__custom-session__";

function deterministicIdentifier(
  prefix: string,
  seed: unknown,
  reserved: ReadonlySet<string> = new Set(),
): string {
  for (let discriminator = 0; discriminator < 1_000; discriminator += 1) {
    const digest = sha256StableValue({ seed, discriminator }).slice(0, 32);
    const identifier = `${prefix}-${digest}`;
    if (!reserved.has(identifier)) {
      return identifier;
    }
  }
  throw new RangeError(`Unable to allocate a unique ${prefix} identifier`);
}

function alignBaselineRun(
  candidate: ReplaySessionRun,
  baseline: ReplaySessionRun,
): { run: ReplaySessionRun; offsetSeconds: number; candidateStart: number; baselineStart: number } {
  const candidateStart = candidate.samples[0]?.timestamp;
  const baselineStart = baseline.samples[0]?.timestamp;
  if (candidateStart === undefined || baselineStart === undefined) {
    throw new RangeError("Candidate and baseline recordings must each contain at least one sample");
  }
  const offsetSeconds = candidateStart - baselineStart;
  if (!Number.isFinite(offsetSeconds)) {
    throw new RangeError("Baseline elapsed-time alignment produced a non-finite offset");
  }
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  const samples = baseline.samples.map((sample, index) => {
    const timestamp = sample.timestamp + offsetSeconds;
    if (!Number.isFinite(timestamp)) {
      throw new RangeError(
        `Baseline timestamp ${index + 1} overflowed during elapsed-time alignment`,
      );
    }
    if (timestamp <= previousTimestamp) {
      throw new RangeError(
        `Baseline timestamp ${index + 1} no longer increases strictly after elapsed-time alignment`,
      );
    }
    previousTimestamp = timestamp;
    return { ...sample, timestamp, pose: { ...sample.pose } };
  });
  return {
    run: { ...baseline, samples },
    offsetSeconds: Object.is(offsetSeconds, -0) ? 0 : offsetSeconds,
    candidateStart,
    baselineStart,
  };
}

const workerInfrastructureError = (message: string): Error => {
  const error = new Error(message);
  error.name = "WorkerInfrastructureError";
  return error;
};

function nestedIssueCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("issues" in error)) {
    return null;
  }
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) {
    return null;
  }
  const first = issues[0];
  return typeof first === "object" && first !== null && "code" in first
    ? String((first as { code: unknown }).code)
    : null;
}

function publicImportErrorMessage(error: unknown): string {
  switch (nestedIssueCode(error)) {
    case "aborted":
      return "Import cancelled.";
    case "empty-input":
      return "This recording is empty.";
    case "file-too-large":
      return "This recording exceeds the local import size limit.";
    case "invalid-encoding":
      return "This recording is not valid UTF-8 text.";
    case "invalid-json":
      return "This recording is not valid JSON.";
    case "invalid-csv":
      return "This recording is not valid CSV.";
    case "invalid-jsonl":
      return "This recording is not valid ROS-bridge JSONL.";
    case "unsupported-schema":
      return "This session format is not supported.";
    case "unsupported-format":
      return "This recording format is not supported.";
    case "missing-option":
      return "Choose the required import options and try again.";
    case "missing-topic":
      return "This recording does not contain a supported telemetry topic.";
    case "timestamp-order":
      return "Recording timestamps must be in nondecreasing order.";
    case "duplicate-field":
    case "invalid-value":
    case "missing-field":
      return "Some required telemetry fields are missing or invalid.";
    default:
      return "Unable to import this recording. Check the selected format and file contents.";
  }
}

function publicLiveErrorMessage(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  switch (code) {
    case "invalid-json":
      return "The live source sent invalid JSON.";
    case "message-too-large":
      return "A live message exceeded the size limit.";
    case "unsupported-schema":
      return "This live stream format is not supported.";
    case "invalid-message":
      return "The live source sent an invalid telemetry message.";
    default:
      return "The live connection was interrupted.";
  }
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) {
    throw new DOMException("The operation was aborted", "AbortError");
  }
}

function allowsMainThreadAnalysis(session: ReplaySessionV2): boolean {
  const sampleCount =
    session.runs.candidate.samples.length + (session.runs.baseline?.samples.length ?? 0);
  const geometryCount = session.plannedRoute.waypoints.length + session.environment.objects.length;
  return (
    sampleCount <= MAIN_THREAD_FALLBACK_SAMPLE_LIMIT &&
    BigInt(sampleCount) * BigInt(geometryCount) <= BigInt(MAIN_THREAD_FALLBACK_WORK_LIMIT)
  );
}

function catalogScenario(value: string | null): ScenarioId | null {
  const previousSteadyRouteId = ["nominal", "validation"].join("-");
  if (value === previousSteadyRouteId) {
    return "steady-route";
  }
  return listScenarioDescriptors().some(({ id }) => id === value) ? (value as ScenarioId) : null;
}

function initialCatalogScenario(): ScenarioId {
  let urlScenario: string | null = null;
  let storedScenario: string | null = null;
  try {
    urlScenario = new URL(window.location.href).searchParams.get("scenario");
  } catch {
    // A malformed embedding URL should not prevent the default mission from loading.
  }
  try {
    storedScenario = window.sessionStorage.getItem(CONTINUITY_SCENARIO_KEY);
  } catch {
    // Storage can be unavailable in privacy-restricted browser contexts.
  }
  return catalogScenario(urlScenario) ?? catalogScenario(storedScenario) ?? "east-loop-incident";
}

function initialIncidentId(scenario: ScenarioId): string | null {
  let urlIncident: string | null = null;
  let storedIncident: string | null = null;
  try {
    urlIncident = new URL(window.location.href).searchParams.get("incident");
  } catch {
    // Fall back to the per-tab continuity record below.
  }
  try {
    storedIncident = window.sessionStorage.getItem(`${CONTINUITY_INCIDENT_PREFIX}${scenario}`);
  } catch {
    // Storage is an enhancement, not a runtime requirement.
  }
  return urlIncident ?? storedIncident;
}

interface PreparedSession {
  candidate: TelemetryRun;
  baseline: TelemetryRun | null;
  candidateGaps: TimestampGap[];
  baselineGaps: TimestampGap[];
  baselineAnalysis: SessionAnalysis | null;
}

interface RepresentativeIncident {
  incidentId: string;
  label: string;
  timestamp: number;
}

function byId<T extends HTMLElement>(id: string): T {
  const element = document.querySelector<T>(`#${id}`);
  if (element === null) {
    throw new Error(`Required interface element #${id} was not found`);
  }
  return element;
}

function setText(id: string, value: string): void {
  byId<HTMLElement>(id).textContent = value;
}

function asFinite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSessionSample(sample: TelemetrySample): SessionTelemetrySample {
  return {
    timestamp: sample.timestamp,
    sequence:
      Number.isSafeInteger(sample.sequence) && sample.sequence >= 0 ? sample.sequence : null,
    pose: { ...sample.pose },
    speed: asFinite(sample.speed),
    battery: asFinite(sample.battery),
    current: asFinite(sample.current),
    state: sample.state === "Unavailable" ? null : sample.state,
    latencyMs: asFinite(sample.latencyMs),
    poseSigma: asFinite(sample.poseSigma),
  };
}

function elapsedDuration(run: ReplaySessionRun): number {
  const start = run.samples[0]?.timestamp ?? 0;
  return Math.max(0, (run.samples.at(-1)?.timestamp ?? start) - start);
}

function baselineAnalysisFor(session: ReplaySessionV2): SessionAnalysis | null {
  const baseline = session.runs.baseline;
  if (baseline === undefined) {
    return null;
  }
  const metrics = deriveSessionMetrics(session, baseline);
  return {
    sessionId: session.id,
    runId: baseline.id,
    detectorVersion: session.detectors.version,
    metrics,
    summary: summarizeSessionAnalysis(session, metrics, baseline),
    incidents: [],
    evidenceChains: [],
    disabledDetectors: [],
  };
}

function metricAtTimestamp(
  metrics: readonly DerivedSampleMetrics[],
  timestamp: number,
): DerivedSampleMetrics | null {
  if (metrics.length === 0) {
    return null;
  }
  let low = 0;
  let high = metrics.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((metrics[middle]?.timestamp ?? Number.POSITIVE_INFINITY) <= timestamp) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return metrics[low] ?? null;
}

function firstTimestampIndex(
  samples: readonly SessionTelemetrySample[],
  timestamp: number,
  inclusive: boolean,
): number {
  let low = 0;
  let high = samples.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const value = samples[middle]?.timestamp ?? Number.POSITIVE_INFINITY;
    if (value < timestamp || (!inclusive && value === timestamp)) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

function activeGapAt(gaps: readonly TimestampGap[], timestamp: number): TimestampGap | null {
  let low = 0;
  let high = gaps.length - 1;
  let candidate: TimestampGap | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const gap = gaps[middle];
    if (gap === undefined) {
      break;
    }
    if (gap.startTimestamp < timestamp) {
      candidate = gap;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return candidate !== null && timestamp < candidate.endTimestamp ? candidate : null;
}

function decimateMap<T, U>(
  values: readonly T[],
  limit: number,
  map: (value: T, index: number) => U,
): U[] {
  if (values.length <= limit) {
    return values.map(map);
  }
  const result: U[] = [];
  const finalIndex = values.length - 1;
  for (let outputIndex = 0; outputIndex < limit; outputIndex += 1) {
    const sourceIndex = Math.round((outputIndex / (limit - 1)) * finalIndex);
    const value = values[sourceIndex];
    if (value !== undefined) {
      result.push(map(value, sourceIndex));
    }
  }
  return result;
}

function incidentMarker(session: ReplaySessionV2, incident: SessionIncident): SceneMarker | null {
  const sample = session.runs.candidate.samples[incident.sampleIndex];
  return sample === undefined
    ? null
    : {
        id: incident.id,
        x: sample.pose.x,
        y: sample.pose.y,
        label: incident.title,
        kind: incident.severity,
      };
}

function sceneWarehouse(session: ReplaySessionV2): SceneWarehouseLayout {
  const asObstacle = (
    object: ReplaySessionV2["environment"]["objects"][number],
  ): SceneObstacle => ({
    id: object.id,
    label: object.label,
    x: object.x,
    y: object.y,
    width: object.width,
    depth: object.depth,
    height: object.height,
    kind: object.kind === "wall" ? "wall" : object.kind === "obstacle" ? "hazard" : "rack",
  });
  const racks = session.environment.objects.filter(({ kind }) => kind === "rack").map(asObstacle);
  const obstacles = session.environment.objects
    .filter(({ kind }) => kind === "wall" || kind === "obstacle")
    .map(asObstacle);
  const dockObject = session.environment.objects.find(({ kind }) => kind === "dock");
  const goalObject = session.environment.objects.find(({ kind }) => kind === "goal");
  return {
    racks,
    obstacles,
    floorBounds: { ...session.environment.floorBounds },
    plannedRoute: session.plannedRoute.waypoints.map(({ x, y }) => ({ x, y })),
    plannedRouteClosed: session.plannedRoute.closed,
    safetyCorridorWidth: session.plannedRoute.corridorWidth,
    ...(dockObject === undefined
      ? {}
      : {
          dock: {
            x: dockObject.x,
            y: dockObject.y,
            width: dockObject.width,
            depth: dockObject.depth,
            label: dockObject.label,
          },
        }),
    ...(goalObject === undefined ? {} : { goal: { x: goalObject.x, y: goalObject.y } }),
  };
}

function legacyAnomalyType(id: DetectorId): AnomalyType {
  switch (id) {
    case "timestamp-gap":
    case "link-degradation":
      return "timestamp-gap";
    case "sequence-gap":
      return "sequence-gap";
    case "overcurrent":
      return "overcurrent";
    case "low-battery":
      return "low-battery";
    case "pose-discontinuity":
    case "route-deviation":
    case "heading-error":
    case "obstacle-clearance":
    case "safe-stop":
      return "pose-discontinuity";
  }
}

function asLegacyAnomaly(incident: SessionIncident): Anomaly {
  return {
    id: incident.id,
    type: legacyAnomalyType(incident.detectorId),
    severity: incident.severity,
    timestamp: incident.timestamp,
    endTimestamp: incident.endTimestamp,
    title: incident.title,
    description: incident.description,
    sampleIndex: incident.sampleIndex,
    details: {
      detectorId: incident.detectorId,
      observed: incident.evidence.observed,
      threshold: incident.evidence.threshold,
      unit: incident.evidence.unit,
      duration: incident.evidence.duration,
    },
  };
}

function playPauseGlyph(playing: boolean): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", playing ? "M9 7v10M15 7v10" : "m9 6 9 6-9 6Z");
  svg.append(path);
  return svg;
}

export class RobotReplayStudio {
  private session: ReplaySessionV2;
  private pristineSession: ReplaySessionV2;
  private catalogIdentity: ScenarioId | null;
  private pristineCatalogIdentity: ScenarioId | null;
  private analysis: SessionAnalysis;
  private prepared: PreparedSession;
  private clock: ReplayClock;
  private readonly charts: TelemetryChartController;
  private fallback: SpatialFallbackView | null = null;
  private scene: RobotReplayScene | null = null;
  private sceneLoading = false;
  private sceneVisible = true;
  private fallbackForced = false;
  private comparisonVisible = true;
  private cameraMode: RobotCameraMode = "orbit";
  private selectedIncidentId: string | null;
  private inspectorView: InspectorView = "evidence";
  private mobileView: MobileView = "replay";
  private mobileLayout = false;
  private severityFilter: SeverityFilter = "all";
  private incidentQuery = "";
  private signalPreset: SignalPreset = "investigation";
  private animationFrame: number | null = null;
  private toastTimer: number | null = null;
  private loadGeneration = 0;
  private committedLoadGeneration = 0;
  private worker: Worker | null = null;
  private workerSequence = 0;
  private selectedImportFile: File | null = null;
  private importAbort: AbortController | null = null;
  private importGeneration = 0;
  private faultAbort: AbortController | null = null;
  private faultGeneration = 0;
  private faultAnchorTimestamp = 0;
  private resetLoadAbort: AbortController | null = null;
  private missionLoadAbort: AbortController | null = null;
  private missionLoadPromise: Promise<void> | null = null;
  private resetLoadPromise: Promise<void> | null = null;
  private liveTransport: LiveTransport | null = null;
  private liveUnsubscribe: (() => void) | null = null;
  private liveDeliveredSamples = 0;
  private livePendingSamples = 0;
  private liveGeneration = 0;
  private liveSource: "simulator" | "websocket" = "simulator";
  private retryableLiveSnapshot: LiveTransportSnapshot | null = null;
  private liveFinalizationPromise: Promise<void> | null = null;
  private missionChoices: MissionChoice[];
  private readonly mediaQuery: MediaQueryList;
  private readonly sceneObserver: IntersectionObserver | null;

  constructor(root: HTMLElement) {
    renderAppShell(root);
    const initialScenario = initialCatalogScenario();
    this.session = generateScenario(initialScenario);
    this.pristineSession = this.session;
    this.catalogIdentity = initialScenario;
    this.pristineCatalogIdentity = initialScenario;
    this.analysis = analyzeSession(this.session);
    this.prepared = this.prepareSession(this.session);
    const rememberedIncidentId = initialIncidentId(initialScenario);
    this.selectedIncidentId =
      this.analysis.incidents.find(({ id }) => id === rememberedIncidentId)?.id ??
      this.analysis.incidents[0]?.id ??
      null;
    this.clock = new ReplayClock({
      duration: elapsedDuration(this.session.runs.candidate),
      initialTime: this.initialElapsedTime(),
    });
    this.faultAnchorTimestamp = this.currentTimestamp;
    this.missionChoices = listScenarioDescriptors().map(({ id, name }) => ({
      value: id,
      label: name,
    }));
    this.mediaQuery = window.matchMedia(MOBILE_QUERY);
    this.mobileLayout = this.mediaQuery.matches;
    this.charts = createTelemetryCharts(byId("charts"), {
      onSelectTimestamp: (timestamp) => this.seekAbsolute(timestamp),
      onSelectIncident: (incident) => this.selectIncident(incident.id, true),
      gapDisplay: "break",
    });
    this.sceneObserver =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            ([entry]) => {
              this.sceneVisible = entry?.isIntersecting ?? true;
              if (this.sceneVisible && this.scene === null) {
                void this.initializeScene();
              }
              this.syncSceneRendering();
            },
            { threshold: 0.02 },
          );
  }

  start(): void {
    this.bindInterface();
    this.sceneObserver?.observe(byId("scene-stage"));
    this.renderAll();
    this.renderFrame();
    this.persistBuiltInContinuity();
    if (this.sceneObserver === null) {
      window.setTimeout(() => void this.initializeScene(), 0);
    }
  }

  private prepareSession(session: ReplaySessionV2): PreparedSession {
    const candidate = sessionRunToTelemetryRun(session.runs.candidate);
    const baseline =
      session.runs.baseline === undefined ? null : sessionRunToTelemetryRun(session.runs.baseline);
    const configuredGapThreshold = session.detectors.rules["timestamp-gap"].threshold;
    const candidateGapThreshold = resolveEffectiveTimestampGapThreshold(
      session.runs.candidate.samples,
      configuredGapThreshold,
      session.runs.candidate.sampleRateHz,
    );
    const baselineGapThreshold =
      session.runs.baseline === undefined
        ? null
        : resolveEffectiveTimestampGapThreshold(
            session.runs.baseline.samples,
            configuredGapThreshold,
            session.runs.baseline.sampleRateHz,
          );
    return {
      candidate,
      baseline,
      candidateGaps: getTimestampGaps(candidate, {
        timestampGapThreshold: candidateGapThreshold,
      }),
      baselineGaps:
        baseline === null || baselineGapThreshold === null
          ? []
          : getTimestampGaps(baseline, { timestampGapThreshold: baselineGapThreshold }),
      baselineAnalysis: baselineAnalysisFor(session),
    };
  }

  private get startTimestamp(): number {
    return this.session.runs.candidate.samples[0]?.timestamp ?? 0;
  }

  private get duration(): number {
    return elapsedDuration(this.session.runs.candidate);
  }

  private get currentTimestamp(): number {
    return this.startTimestamp + this.clock.currentTime;
  }

  private get selectedIncident(): SessionIncident | null {
    return this.analysis.incidents.find(({ id }) => id === this.selectedIncidentId) ?? null;
  }

  private initialElapsedTime(): number {
    const firstIncident = this.analysis.incidents[0];
    return firstIncident === undefined
      ? 0
      : Math.max(0, firstIncident.timestamp - this.startTimestamp);
  }

  private effectiveDetectors(): DetectorConfiguration {
    const detectors = cloneDetectorConfiguration(this.session.detectors);
    for (const { id, reason } of this.analysis.disabledDetectors) {
      if (reason !== "Disabled by configuration.") {
        detectors.rules[id].unavailableReason = reason;
      }
    }
    return detectors;
  }

  private persistBuiltInContinuity(): void {
    const scenario = this.catalogIdentity;
    try {
      if (scenario === null) {
        window.sessionStorage.removeItem(CONTINUITY_SCENARIO_KEY);
        for (const { id } of listScenarioDescriptors()) {
          window.sessionStorage.removeItem(`${CONTINUITY_INCIDENT_PREFIX}${id}`);
        }
      } else {
        window.sessionStorage.setItem(CONTINUITY_SCENARIO_KEY, scenario);
        if (this.selectedIncidentId === null) {
          window.sessionStorage.removeItem(`${CONTINUITY_INCIDENT_PREFIX}${scenario}`);
        } else {
          window.sessionStorage.setItem(
            `${CONTINUITY_INCIDENT_PREFIX}${scenario}`,
            this.selectedIncidentId,
          );
        }
      }
    } catch {
      // Keep replay fully functional when session storage is unavailable.
    }
    try {
      const url = new URL(window.location.href);
      if (scenario === null) {
        url.searchParams.delete("scenario");
        url.searchParams.delete("incident");
      } else {
        url.searchParams.set("scenario", scenario);
        if (this.selectedIncidentId === null) {
          url.searchParams.delete("incident");
        } else {
          url.searchParams.set("incident", this.selectedIncidentId);
        }
      }
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // URL continuity is optional in restricted or non-standard embeddings.
    }
  }

  private resetIncidentFilters(): void {
    this.incidentQuery = "";
    this.severityFilter = "all";
    const search = document.querySelector<HTMLInputElement>("#incident-search");
    if (search !== null) {
      search.value = "";
    }
    const button = document.querySelector<HTMLButtonElement>("#incident-filter");
    if (button !== null) {
      button.dataset.filter = "all";
      button.setAttribute("aria-label", "Show all incidents");
    }
  }

  private selectedIncidentMatchesFilters(): boolean {
    const incident = this.selectedIncident;
    if (incident === null) {
      return true;
    }
    if (this.severityFilter !== "all" && incident.severity !== this.severityFilter) {
      return false;
    }
    const query = this.incidentQuery.trim().toLocaleLowerCase();
    return (
      query === "" ||
      [
        incident.title,
        incident.description,
        incident.detectorId,
        incident.evidence.operatorCheck,
      ].some((value) => value.toLocaleLowerCase().includes(query))
    );
  }

  private chartMetrics(): TelemetryMetricInput[] {
    const routeRule = this.session.detectors.rules["route-deviation"];
    const currentRule = this.session.detectors.rules.overcurrent;
    const latencyRule = this.session.detectors.rules["link-degradation"];
    const metricFor = (runId: string, sampleIndex: number): DerivedSampleMetrics | undefined =>
      runId === this.prepared.candidate.id
        ? this.analysis.metrics[sampleIndex]
        : this.prepared.baselineAnalysis?.metrics[sampleIndex];
    const pathError: TelemetryMetricInput = {
      key: "pathError",
      label: "Route error",
      unit: "m",
      decimals: 2,
      accessor: (_sample, context) =>
        metricFor(context.run.id, context.sampleIndex)?.crossTrackError ?? null,
      domain: { min: 0, includeZero: true },
      thresholds: routeRule.enabled
        ? [{ value: routeRule.threshold, label: `${routeRule.threshold.toFixed(2)} m limit` }]
        : [],
    };
    const current: TelemetryMetricInput = {
      key: "current",
      label: "Motor load",
      unit: "A",
      decimals: 1,
      accessor: (sample) => Math.abs(sample.current),
      thresholds: currentRule.enabled
        ? [{ value: currentRule.threshold, label: `${currentRule.threshold.toFixed(1)} A limit` }]
        : [],
    };
    const latency: TelemetryMetricInput = {
      key: "latency",
      label: "Data age",
      unit: "ms",
      decimals: 0,
      accessor: (sample) => sample.latencyMs,
      domain: { min: 0, includeZero: true },
      thresholds: latencyRule.enabled
        ? [{ value: latencyRule.threshold, label: `${latencyRule.threshold.toFixed(0)} ms limit` }]
        : [],
    };
    if (this.signalPreset === "power") {
      return [
        { key: "speed", label: "Linear speed", unit: "m/s", decimals: 2 },
        { key: "battery", label: "Battery", unit: "%", decimals: 1 },
        current,
        latency,
      ];
    }
    return [
      { key: "speed", label: "Linear speed", unit: "m/s", decimals: 2 },
      pathError,
      current,
      latency,
    ];
  }

  private chartIncidents(): TelemetryIncidentWindow[] {
    const visibleIds = new Set(this.representativeIncidents().map(({ incidentId }) => incidentId));
    if (this.selectedIncidentId !== null) {
      visibleIds.add(this.selectedIncidentId);
    }
    return this.analysis.incidents
      .filter(({ id }) => visibleIds.has(id))
      .map((incident) => {
        const metricKeys = (() => {
          switch (incident.detectorId) {
            case "link-degradation":
            case "timestamp-gap":
            case "sequence-gap":
              return ["latency"];
            case "pose-discontinuity":
            case "route-deviation":
            case "heading-error":
            case "obstacle-clearance":
              return ["pathError"];
            case "overcurrent":
              return ["current"];
            case "low-battery":
              return ["battery"];
            case "safe-stop":
              return ["speed"];
          }
        })();
        return {
          id: incident.id,
          label: incident.title,
          startTimestamp: incident.timestamp,
          endTimestamp: incident.endTimestamp,
          severity: incident.severity,
          metricKeys,
        };
      });
  }

  private renderAll(): void {
    const selectedMissionValue = this.catalogIdentity ?? CUSTOM_MISSION_CHOICE;
    renderMissionChoices(document, this.missionChoices, selectedMissionValue);
    renderMissionOutcome(document, {
      session: this.session,
      analysis: this.analysis,
      baselineAnalysis: this.prepared.baselineAnalysis,
      gaps: this.prepared.candidateGaps,
      selectedMissionValue,
    });
    renderRulesPanel(document, this.effectiveDetectors());
    const hasBaseline = this.prepared.baseline !== null;
    const chartHint = document.querySelector<HTMLElement>(".chart-hint");
    if (chartHint !== null) {
      chartHint.textContent = hasBaseline
        ? "Candidate + baseline / gaps preserved"
        : "Candidate / gaps preserved";
    }
    byId("charts").setAttribute(
      "aria-label",
      hasBaseline ? "Candidate and baseline telemetry charts" : "Candidate telemetry charts",
    );
    const comparisonActive = this.comparisonVisible && hasBaseline;
    byId("scene-stage").dataset.comparison = String(comparisonActive);
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view-mode]")) {
      const compareButton = button.dataset.viewMode === "compare";
      button.disabled = compareButton && !hasBaseline;
      button.setAttribute(
        "aria-pressed",
        String(compareButton ? comparisonActive : !comparisonActive),
      );
      if (compareButton) {
        button.title = hasBaseline ? "Overlay candidate and baseline" : "Baseline unavailable";
      }
    }
    this.renderIncidents();
    this.renderSelection();
    renderReplayStats(document, {
      candidateSamples: this.prepared.candidate.samples.length,
    });
    setText("duration-stat", `${this.duration.toFixed(3)} s`);
    setText(
      "export-scope",
      `${this.prepared.baseline === null ? "Candidate" : "Candidate + baseline"} · incident report`,
    );
    this.updateCharts();
    this.rebuildFallback();
    this.updateSceneData();
    renderMobileTabState(document, {
      active: this.mobileView,
      mobileLayout: this.mobileLayout,
    });
    renderInspectorTabState(document, this.inspectorView);
  }

  private renderIncidents(): void {
    renderIncidentList(document, {
      incidents: this.analysis.incidents,
      maxVisible: 300,
      selectedIncidentId: this.selectedIncidentId,
      filter: {
        query: this.incidentQuery,
        ...(this.severityFilter === "all" ? {} : { severities: [this.severityFilter] }),
      },
      detectors: this.effectiveDetectors(),
      startTimestamp: this.startTimestamp,
    });
  }

  private representativeIncidents(): RepresentativeIncident[] {
    const orderedGroups: readonly (readonly DetectorId[])[] = [
      ["link-degradation", "timestamp-gap", "sequence-gap"],
      ["pose-discontinuity", "heading-error"],
      ["route-deviation", "overcurrent", "obstacle-clearance"],
      ["safe-stop"],
    ];
    const selected: SessionIncident[] = [];
    for (const group of orderedGroups) {
      const incident = this.analysis.incidents.find(
        ({ detectorId, id }) =>
          group.includes(detectorId) && !selected.some((item) => item.id === id),
      );
      if (incident !== undefined) {
        selected.push(incident);
      }
    }
    for (const incident of this.analysis.incidents) {
      if (selected.length >= 4) {
        break;
      }
      if (!selected.some(({ id }) => id === incident.id)) {
        selected.push(incident);
      }
    }
    return selected
      .sort((left, right) => left.timestamp - right.timestamp)
      .slice(0, 4)
      .map(({ id, title, timestamp }) => ({ incidentId: id, label: title, timestamp }));
  }

  private timelineIncidents(): SessionIncident[] {
    const sampled = decimateMap(this.analysis.incidents, 300, (incident) => incident);
    const selected = this.selectedIncident;
    if (selected !== null && !sampled.some(({ id }) => id === selected.id)) {
      sampled[sampled.length - 1] = selected;
    }
    return sampled.sort((left, right) => left.timestamp - right.timestamp);
  }

  private evidenceSparkline(incident: SessionIncident | null): SparklinePoint[] {
    if (incident === null) {
      return [];
    }
    const from = incident.timestamp - 3;
    const to = incident.endTimestamp + 3;
    const samples = this.session.runs.candidate.samples;
    const gapThreshold = resolveEffectiveTimestampGapThreshold(
      samples,
      this.session.detectors.rules["timestamp-gap"].threshold,
      this.session.runs.candidate.sampleRateHz,
    );
    const points: SparklinePoint[] = [];
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (sample === undefined || sample.timestamp < from || sample.timestamp > to) {
        continue;
      }
      const previous = samples[index - 1];
      const interval = previous === undefined ? null : sample.timestamp - previous.timestamp;
      if (previous !== undefined && interval !== null && interval > gapThreshold) {
        points.push({ timestamp: (previous.timestamp + sample.timestamp) / 2, value: null });
      }
      const metric = this.analysis.metrics[index];
      let value: number | null;
      switch (incident.detectorId) {
        case "timestamp-gap":
          value = interval;
          break;
        case "link-degradation":
          value = sample.latencyMs;
          break;
        case "sequence-gap": {
          const delta =
            previous?.sequence === null ||
            previous?.sequence === undefined ||
            sample.sequence === null
              ? null
              : sample.sequence - previous.sequence;
          value = delta === null ? null : delta <= 0 ? delta : Math.max(0, delta - 1);
          break;
        }
        case "pose-discontinuity":
          value =
            previous === undefined
              ? null
              : incident.evidence.unit === "rad"
                ? Math.abs(
                    Math.atan2(
                      Math.sin(sample.pose.yaw - previous.pose.yaw),
                      Math.cos(sample.pose.yaw - previous.pose.yaw),
                    ),
                  )
                : Math.hypot(sample.pose.x - previous.pose.x, sample.pose.y - previous.pose.y);
          break;
        case "route-deviation":
          value = metric?.crossTrackError ?? null;
          break;
        case "heading-error":
          value = metric?.headingError ?? null;
          break;
        case "obstacle-clearance":
          value = metric?.obstacleClearance ?? null;
          break;
        case "overcurrent":
          value = sample.current === null ? null : Math.abs(sample.current);
          break;
        case "low-battery":
          value = sample.battery;
          break;
        case "safe-stop":
          value = sample.speed;
          break;
      }
      points.push({ timestamp: sample.timestamp, value });
    }
    return points;
  }

  private renderSelection(): void {
    const incident = this.selectedIncident;
    const chain =
      this.analysis.evidenceChains.find(({ steps }) =>
        steps.some(({ incidentId }) => incidentId === this.selectedIncidentId),
      ) ?? null;
    renderEvidencePanel(document, {
      incident,
      startTimestamp: this.startTimestamp,
      ...(incident === null ? {} : { rule: this.session.detectors.rules[incident.detectorId] }),
      chain,
      incidents: this.analysis.incidents,
      selectedIncidentId: this.selectedIncidentId,
      sparkline: this.evidenceSparkline(incident),
      confidenceLabel:
        incident === null
          ? "No rule match"
          : incident.evidence.supportingSampleIndices.length >= 3
            ? "Multi-sample match"
            : "Rule match",
    });
    renderTimeline(document, {
      startTimestamp: this.startTimestamp,
      duration: this.duration,
      incidents: this.timelineIncidents(),
      gaps: decimateMap(this.prepared.candidateGaps, 300, (gap) => gap),
      selectedIncidentId: this.selectedIncidentId,
      currentTimestamp: this.currentTimestamp,
    });
    this.charts.setSelectedIncident(this.selectedIncidentId);
    const marker = incident === null ? null : incidentMarker(this.session, incident);
    this.fallback?.setSelectedIncident(marker);
    this.scene?.setMarkers(this.spatialIncidentMarkers());
    if (incident !== null) {
      this.scene?.setSelectedMarker(incident.id);
    } else {
      this.scene?.setSelectedMarker(null);
    }
  }

  private updateCharts(): void {
    const runs = [
      this.prepared.candidate,
      ...(this.prepared.baseline === null ? [] : [this.prepared.baseline]),
    ];
    const gaps = new Map<string, readonly TimestampGap[]>([
      [this.prepared.candidate.id, this.prepared.candidateGaps],
    ]);
    if (this.prepared.baseline !== null) {
      gaps.set(this.prepared.baseline.id, this.prepared.baselineGaps);
    }
    this.charts.update({
      runs,
      gapsByRun: gaps,
      gapDisplay: "break",
      metrics: this.chartMetrics(),
      incidents: this.chartIncidents(),
      selectedIncidentId: this.selectedIncidentId,
      selectedTimestamp: this.currentTimestamp,
    });
  }

  private trajectoryForCandidate(): SceneTrajectoryPoint[] {
    return decimateMap(this.session.runs.candidate.samples, SCENE_POSE_LIMIT, (sample, index) => ({
      x: sample.pose.x,
      y: sample.pose.y,
      deviation: this.analysis.metrics[index]?.crossTrackError ?? 0,
    }));
  }

  private trajectoryForBaseline(): SceneTrajectoryPoint[] {
    return decimateMap(this.session.runs.baseline?.samples ?? [], SCENE_POSE_LIMIT, ({ pose }) => ({
      x: pose.x,
      y: pose.y,
      deviation: 0,
    }));
  }

  private spatialIncidentMarkers(): SceneMarker[] {
    const guideIds = new Set(this.representativeIncidents().map(({ incidentId }) => incidentId));
    return this.analysis.incidents
      .filter(({ id }) => guideIds.has(id) || id === this.selectedIncidentId)
      .map((incident) => incidentMarker(this.session, incident))
      .filter((marker): marker is SceneMarker => marker !== null);
  }

  private rebuildFallback(): void {
    const mount = byId("scene-mount");
    this.fallback?.destroy();
    const warehouse = sceneWarehouse(this.session);
    const baseline = this.prepared.baseline ?? this.prepared.candidate;
    this.fallback = new SpatialFallbackView(mount, {
      candidate: this.prepared.candidate,
      baseline,
      candidateGaps: this.prepared.candidateGaps,
      plannedRoute: this.session.plannedRoute.waypoints,
      plannedRouteClosed: this.session.plannedRoute.closed,
      floorBounds: { ...this.session.environment.floorBounds },
      safetyCorridorWidth: this.session.plannedRoute.corridorWidth,
      racks: warehouse.racks,
      obstacles: warehouse.obstacles,
      ...(warehouse.dock === undefined ? {} : { dock: warehouse.dock }),
      ...(warehouse.goal === undefined ? {} : { goal: warehouse.goal }),
      selectedIncident:
        this.selectedIncident === null ? null : incidentMarker(this.session, this.selectedIncident),
    });
    this.fallback.setComparisonVisible(this.comparisonVisible && this.prepared.baseline !== null);
    if (this.scene !== null && !this.fallbackForced) {
      this.fallback.setHidden(true);
    } else if (this.sceneLoading) {
      this.fallback.setLoading();
    } else if (this.fallbackForced) {
      this.fallback.setUnavailable();
    }
  }

  private updateSceneData(): void {
    if (this.scene === null) {
      return;
    }
    const markers = this.spatialIncidentMarkers();
    this.scene.setWarehouse(sceneWarehouse(this.session));
    this.scene.setPlannedRoute(
      this.session.plannedRoute.waypoints,
      this.session.plannedRoute.corridorWidth,
      this.session.plannedRoute.closed,
    );
    this.scene.setTrajectory(this.trajectoryForCandidate());
    this.scene.setComparisonTrajectory(this.trajectoryForBaseline());
    this.scene.setComparisonVisible(this.comparisonVisible && this.prepared.baseline !== null);
    this.scene.setMarkers(markers);
    this.scene.setSelectedMarker(this.selectedIncidentId);
    this.renderFrame();
  }

  private async initializeScene(): Promise<void> {
    if (this.scene !== null || this.sceneLoading) {
      return;
    }
    this.sceneLoading = true;
    this.fallback?.setLoading();
    byId("scene-mount").setAttribute("aria-busy", "true");
    try {
      const { RobotReplayScene: Scene } = await import("./scene");
      const initial = this.prepared.candidate.samples[0]?.pose ?? { x: 0, y: 0, yaw: 0 };
      this.scene = new Scene(byId("scene-mount"), {
        initialPose: initial,
        cameraMode: this.cameraMode,
        trajectory: this.trajectoryForCandidate(),
        comparison: {
          trajectory: this.trajectoryForBaseline(),
          visible: this.comparisonVisible && this.prepared.baseline !== null,
        },
        warehouse: sceneWarehouse(this.session),
        plannedRoute: this.session.plannedRoute.waypoints,
        plannedRouteClosed: this.session.plannedRoute.closed,
        floorBounds: { ...this.session.environment.floorBounds },
        safetyCorridorWidth: this.session.plannedRoute.corridorWidth,
        markers: this.spatialIncidentMarkers(),
        selectedMarkerId: this.selectedIncidentId,
        cameraControls: {
          zoomIn: byId("scene-zoom-in"),
          zoomOut: byId("scene-zoom-out"),
          frame: byId("reset-view"),
        },
        reducedMotion: window.matchMedia("(prefers-reduced-motion: reduce)").matches,
        maxPixelRatio: 1.5,
        accessibleLabel:
          "Interactive warehouse autonomy replay comparing candidate and baseline paths",
        accessibleDescription: byId("scene-instructions").textContent ?? undefined,
        onContextLost: () => {
          this.fallbackForced = true;
          this.fallback?.setHidden(false);
          this.fallback?.setUnavailable("WebGL context lost · top-down replay remains active");
          this.syncSceneRendering();
        },
        onContextRestored: () => {
          this.fallbackForced = false;
          this.fallback?.setHidden(true);
          this.syncSceneRendering();
        },
      });
      this.sceneLoading = false;
      this.fallback?.setHidden(true);
      byId("scene-mount").setAttribute("aria-busy", "false");
      this.updateSceneData();
      this.syncSceneRendering();
    } catch {
      this.sceneLoading = false;
      this.fallbackForced = true;
      this.fallback?.setHidden(false);
      this.fallback?.setUnavailable();
      byId("scene-mount").setAttribute("aria-busy", "false");
    }
  }

  private syncSceneRendering(): void {
    if (this.scene === null) {
      return;
    }
    this.scene.setRenderingEnabled(this.sceneVisible && !document.hidden && !this.fallbackForced);
  }

  private renderFrame(): void {
    const snapshot = this.clock.tick();
    const timestamp = this.startTimestamp + snapshot.currentTime;
    const candidate = resolveTelemetrySample(
      this.prepared.candidate.samples,
      timestamp,
      this.prepared.candidateGaps,
    );
    const baseline =
      this.prepared.baseline === null
        ? null
        : resolveTelemetrySample(
            this.prepared.baseline.samples,
            timestamp,
            this.prepared.baselineGaps,
          );
    const candidateMetric = metricAtTimestamp(this.analysis.metrics, timestamp);
    const baselineMetric = metricAtTimestamp(
      this.prepared.baselineAnalysis?.metrics ?? [],
      timestamp,
    );
    renderSamplePanel(document, {
      timestamp,
      startTimestamp: this.startTimestamp,
      candidate: toSessionSample(candidate.sample),
      ...(baseline === null ? {} : { baseline: toSessionSample(baseline.sample) }),
      candidateMetric,
      baselineMetric,
      freshness: candidate.status,
      incidents: this.analysis.incidents,
      activeGap: candidate.gap ?? activeGapAt(this.prepared.candidateGaps, timestamp),
      currentThreshold: this.session.detectors.rules.overcurrent.threshold,
      batteryThreshold: this.session.detectors.rules["low-battery"].threshold,
    });
    this.scene?.setPose(candidate.sample.pose);
    this.scene?.setPoseUncertainty(asFinite(candidate.sample.poseSigma));
    if (baseline === null) {
      this.scene?.setComparisonPose(null);
    } else {
      this.scene?.setComparisonPose(baseline.sample.pose);
    }
    this.fallback?.setPose(candidate.sample, baseline?.sample ?? candidate.sample);
    this.charts.setSelectedTimestamp(timestamp);
    this.updateTimelinePlayhead(snapshot.currentTime);
    this.updateTransport(snapshot.playing);
    const status = byId("run-status");
    status.dataset.state = candidate.status === "held-during-gap" ? "gap" : "review";
    const marker = document.createElement("i");
    marker.setAttribute("aria-hidden", "true");
    status.replaceChildren(
      marker,
      document.createTextNode(
        candidate.status === "held-during-gap"
          ? "Holding last valid sample"
          : formatStateLabel(candidate.sample.state),
      ),
    );
    if (snapshot.playing) {
      this.requestAnimation();
    }
  }

  private updateTimelinePlayhead(elapsed: number): void {
    const progress = this.duration <= 0 ? 0 : Math.min(100, (elapsed / this.duration) * 100);
    byId("scrubber-fill").style.width = `${progress}%`;
    byId("playhead").style.left = `${progress}%`;
    const scrubber = byId<HTMLInputElement>("scrubber");
    scrubber.value = String(elapsed);
    scrubber.setAttribute(
      "aria-valuetext",
      `${formatTimecode(elapsed)} of ${formatTimecode(this.duration)}`,
    );
    setText("current-timecode", formatTimecode(elapsed));
    setText("duration-timecode", `/ ${formatTimecode(this.duration)}`);
    setText("scene-timecode", formatTimecode(elapsed));
    const gap = activeGapAt(this.prepared.candidateGaps, this.startTimestamp + elapsed);
    for (const element of document.querySelectorAll<HTMLElement>(
      ".timeline-gap, .timeline-gap-band",
    )) {
      const start = Number(element.dataset.start);
      const end = Number(element.dataset.end);
      element.classList.toggle(
        "active",
        gap !== null && start === gap.startTimestamp && end === gap.endTimestamp,
      );
    }
  }

  private updateTransport(playing: boolean): void {
    const button = byId<HTMLButtonElement>("play-pause");
    button.replaceChildren(playPauseGlyph(playing));
    button.setAttribute("aria-label", playing ? "Pause replay" : "Play replay");
    button.dataset.state = playing ? "playing" : "paused";
    for (const speed of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
      const configuredRate = Number(speed.dataset.speed);
      speed.setAttribute("aria-pressed", String(configuredRate === this.clock.playbackRate));
      if (configuredRate === 1) {
        speed.textContent = this.mobileLayout ? `${this.clock.playbackRate}×` : "1×";
        speed.setAttribute(
          "aria-label",
          this.mobileLayout
            ? `Change playback rate; current rate ${this.clock.playbackRate} times`
            : "Set playback rate to 1 times",
        );
      }
    }
  }

  private requestAnimation(): void {
    if (this.animationFrame !== null || document.hidden) {
      return;
    }
    this.animationFrame = requestAnimationFrame(() => {
      this.animationFrame = null;
      this.renderFrame();
    });
  }

  private togglePlayback(): void {
    this.clock.toggle();
    this.renderFrame();
  }

  private seekElapsed(elapsed: number): void {
    this.clock.seek(Math.max(0, Math.min(this.duration, elapsed)));
    this.renderFrame();
  }

  private seekAbsolute(timestamp: number): void {
    this.seekElapsed(timestamp - this.startTimestamp);
  }

  private selectIncident(id: string, seek: boolean): void {
    const incident = this.analysis.incidents.find((candidate) => candidate.id === id);
    if (incident === undefined) {
      return;
    }
    const focusRegionId = document.activeElement?.closest<HTMLElement>(
      "#event-list, #evidence-chain-list",
    )?.id;
    this.selectedIncidentId = incident.id;
    if (seek) {
      this.seekAbsolute(incident.timestamp);
    }
    this.renderIncidents();
    this.renderSelection();
    this.updateCharts();
    this.persistBuiltInContinuity();
    this.scene?.focusIncident(incident.id, { select: true, distance: 8 });
    if (this.mobileLayout) {
      this.mobileView = "evidence";
      renderMobileTabState(document, { active: this.mobileView, mobileLayout: true });
      if (focusRegionId === "evidence-chain-list") {
        [...byId(focusRegionId).querySelectorAll<HTMLButtonElement>("button[data-incident-id]")]
          .find((button) => button.dataset.incidentId === incident.id)
          ?.focus();
      } else {
        byId<HTMLButtonElement>("mobile-tab-evidence").focus();
      }
    } else if (focusRegionId !== undefined) {
      const region = byId(focusRegionId);
      [...region.querySelectorAll<HTMLButtonElement>("button[data-incident-id]")]
        .find((button) => button.dataset.incidentId === incident.id)
        ?.focus();
    }
  }

  private async loadSession(
    nextSession: ReplaySessionV2,
    options: SessionLoadOptions = {},
  ): Promise<void> {
    const generation = ++this.loadGeneration;
    const sourceChanged =
      nextSession.id !== this.session.id ||
      nextSession.mission.scenario !== this.session.mission.scenario;
    const preservedIncident = options.preserveSelection ? this.selectedIncident : null;
    const shell = byId("app-shell");
    const resumePriorPlayback = this.clock.isPlaying;
    shell.dataset.analysisState = "running";
    this.clock.pause();
    let analysis: SessionAnalysis;
    try {
      assertNotAborted(options.signal);
      analysis = options.analysis ?? (await this.analyzeInWorker(nextSession, options.signal));
      assertNotAborted(options.signal);
    } catch (error) {
      if (generation === this.loadGeneration) {
        this.committedLoadGeneration = generation;
        shell.dataset.analysisState = "complete";
        if (resumePriorPlayback) {
          this.clock.play();
        }
        this.ensureMissionChoice();
        this.renderAll();
        this.renderFrame();
      }
      throw error;
    }
    if (generation !== this.loadGeneration) {
      return;
    }
    this.session = nextSession;
    this.analysis = analysis;
    this.prepared = this.prepareSession(nextSession);
    if (Object.prototype.hasOwnProperty.call(options, "catalogIdentity")) {
      this.catalogIdentity = options.catalogIdentity ?? null;
    }
    if (options.setPristine !== false) {
      this.pristineSession = nextSession;
      this.pristineCatalogIdentity = this.catalogIdentity;
    }
    const previousSelection = (() => {
      if (!options.preserveSelection || preservedIncident === null) {
        return null;
      }
      const exact = this.analysis.incidents.find(({ id }) => id === preservedIncident.id);
      if (exact !== undefined) {
        return exact.id;
      }
      return (
        this.analysis.incidents
          .filter(({ detectorId }) => detectorId === preservedIncident.detectorId)
          .sort(
            (left, right) =>
              Math.abs(left.timestamp - preservedIncident.timestamp) -
                Math.abs(right.timestamp - preservedIncident.timestamp) ||
              left.timestamp - right.timestamp ||
              left.id.localeCompare(right.id),
          )[0]?.id ?? null
      );
    })();
    this.selectedIncidentId = previousSelection ?? this.analysis.incidents[0]?.id ?? null;
    if (sourceChanged || !this.selectedIncidentMatchesFilters()) {
      this.resetIncidentFilters();
    }
    this.clock = new ReplayClock({
      duration: this.duration,
      initialTime:
        options.seekTimestamp === undefined
          ? this.initialElapsedTime()
          : Math.max(0, options.seekTimestamp - this.startTimestamp),
      playbackRate: 1,
    });
    this.committedLoadGeneration = generation;
    shell.dataset.analysisState = "complete";
    this.ensureMissionChoice();
    this.renderAll();
    this.renderFrame();
    this.persistBuiltInContinuity();
    if (options.announce !== undefined) {
      this.showToast(options.announce);
    }
  }

  private ensureMissionChoice(): void {
    this.missionChoices = listScenarioDescriptors().map(({ id, name }) => ({
      value: id,
      label: name,
    }));
    if (this.catalogIdentity === null) {
      this.missionChoices.push({
        value: CUSTOM_MISSION_CHOICE,
        label: `${this.session.mission.id} · ${this.session.mission.title}`,
      });
    }
  }

  private cancelPendingCatalogLoad(announce = false): void {
    const abortController = this.missionLoadAbort;
    if (abortController === null) {
      renderMissionChoices(
        document,
        this.missionChoices,
        this.catalogIdentity ?? CUSTOM_MISSION_CHOICE,
      );
      return;
    }
    this.missionLoadAbort = null;
    this.missionLoadPromise = null;
    abortController.abort();
    this.loadGeneration += 1;
    this.committedLoadGeneration = this.loadGeneration;
    byId("app-shell").dataset.analysisState = "complete";
    this.ensureMissionChoice();
    this.renderAll();
    this.renderFrame();
    if (announce) {
      this.showToast(
        this.catalogIdentity === null
          ? "Kept the current custom session"
          : "Kept the current mission",
      );
    }
  }

  private loadCatalogMission(id: ScenarioId): void {
    if (id === this.catalogIdentity) {
      this.cancelPendingCatalogLoad(this.missionLoadAbort !== null);
      return;
    }
    this.missionLoadAbort?.abort();
    const abortController = new AbortController();
    this.missionLoadAbort = abortController;
    const operation = this.loadSession(generateScenario(id), {
      setPristine: true,
      catalogIdentity: id,
      signal: abortController.signal,
      announce: "Mission loaded",
    })
      .catch((error: unknown) => {
        if (abortController.signal.aborted) {
          return;
        }
        this.ensureMissionChoice();
        renderMissionChoices(
          document,
          this.missionChoices,
          this.catalogIdentity ?? CUSTOM_MISSION_CHOICE,
        );
        this.showToast(
          error instanceof Error ? error.message : "Unable to load this mission",
          "error",
        );
      })
      .finally(() => {
        if (this.missionLoadAbort === abortController) {
          this.missionLoadAbort = null;
          this.missionLoadPromise = null;
        }
      });
    this.missionLoadPromise = operation;
  }

  private async waitForCatalogMission(): Promise<void> {
    while (this.missionLoadPromise !== null) {
      const pending = this.missionLoadPromise;
      await pending;
      if (this.missionLoadPromise === pending) {
        this.missionLoadPromise = null;
      }
    }
  }

  private async waitForSourceTransition(): Promise<void> {
    while (this.missionLoadPromise !== null || this.resetLoadPromise !== null) {
      await this.waitForCatalogMission();
      const reset = this.resetLoadPromise;
      if (reset !== null) {
        await reset;
      }
    }
  }

  private getWorker(): Worker {
    if (typeof Worker === "undefined") {
      throw workerInfrastructureError("Web Workers are unavailable");
    }
    this.worker ??= this.createWorker();
    return this.worker;
  }

  private createWorker(): Worker {
    if (typeof Worker === "undefined") {
      throw workerInfrastructureError("Web Workers are unavailable");
    }
    try {
      const workerUrl = import.meta.env.PROD
        ? "__ROBOT_REPLAY_ANALYSIS_WORKER_URL__"
        : new URL([".", "core", "analysis-worker.ts"].join("/"), import.meta.url);
      return new Worker(workerUrl, {
        type: "module",
        name: "robot-replay-analysis",
      });
    } catch (error) {
      throw workerInfrastructureError(
        error instanceof Error
          ? `Unable to start analysis worker: ${error.message}`
          : "Unable to start analysis worker",
      );
    }
  }

  private requestWorker(
    request: AnalysisWorkerRequest,
    options: {
      signal?: AbortSignal;
      onProgress?: (progress: number, message: string) => void;
    } = {},
  ): Promise<AnalysisWorkerResult> {
    assertNotAborted(options.signal);
    const dedicated = options.signal !== undefined;
    const worker = dedicated ? this.createWorker() : this.getWorker();
    return new Promise((resolve, reject) => {
      const handleMessage = (event: MessageEvent<AnalysisWorkerResponse>): void => {
        const response = event.data;
        if (response.requestId !== request.requestId) {
          return;
        }
        if (response.type === "progress") {
          options.onProgress?.(response.progress, response.message);
          return;
        }
        cleanup();
        if (response.type === "result") {
          resolve(response.result);
        } else if (response.type === "cancelled") {
          reject(new Error("Analysis request was cancelled"));
        } else {
          reject(Object.assign(new Error(response.error.message), response.error));
        }
      };
      const handleError = (): void => {
        cleanup();
        if (!dedicated && this.worker === worker) {
          this.worker.terminate();
          this.worker = null;
        }
        reject(workerInfrastructureError("Analysis worker failed"));
      };
      const handleMessageError = (): void => {
        cleanup();
        if (!dedicated && this.worker === worker) {
          this.worker.terminate();
          this.worker = null;
        }
        reject(workerInfrastructureError("Analysis worker returned an unreadable message"));
      };
      const handleAbort = (): void => {
        cleanup();
        reject(new DOMException("The operation was aborted", "AbortError"));
      };
      const cleanup = (): void => {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
        worker.removeEventListener("messageerror", handleMessageError);
        options.signal?.removeEventListener("abort", handleAbort);
        if (dedicated) {
          worker.terminate();
        }
      };
      if (options.signal?.aborted === true) {
        handleAbort();
        return;
      }
      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.addEventListener("messageerror", handleMessageError);
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      try {
        worker.postMessage(request);
      } catch (error) {
        cleanup();
        reject(
          workerInfrastructureError(
            error instanceof Error
              ? `Unable to send work to the analysis worker: ${error.message}`
              : "Unable to send work to the analysis worker",
          ),
        );
      }
    });
  }

  private async analyzeInWorker(
    session: ReplaySessionV2,
    signal?: AbortSignal,
    onProgress?: (progress: number, message: string) => void,
  ): Promise<SessionAnalysis> {
    const requestId = `analysis-${++this.workerSequence}`;
    try {
      const result = await this.requestWorker(
        {
          type: "analyze",
          requestId,
          session,
        },
        { signal, onProgress },
      );
      if (result.kind === "analysis") {
        return result.analysis;
      }
      throw new Error("Unexpected analysis result");
    } catch (error) {
      assertNotAborted(signal);
      if (
        error instanceof Error &&
        error.name === "WorkerInfrastructureError" &&
        allowsMainThreadAnalysis(session)
      ) {
        return analyzeSession(session);
      }
      throw error;
    }
  }

  private async branchFaultInWorker(
    base: ReplaySessionV2,
    fault: FaultSpecification,
    signal?: AbortSignal,
  ): Promise<{ session: ReplaySessionV2; analysis: SessionAnalysis }> {
    const requestId = `fault-${++this.workerSequence}`;
    try {
      const result = await this.requestWorker(
        {
          type: "branch-fault",
          requestId,
          session: base,
          faults: [fault],
        },
        { signal },
      );
      if (result.kind === "fault-branch" && result.analysis !== undefined) {
        return { session: result.session, analysis: result.analysis };
      }
      throw new Error("Unexpected fault branch result");
    } catch (error) {
      assertNotAborted(signal);
      if (
        error instanceof Error &&
        error.name === "WorkerInfrastructureError" &&
        allowsMainThreadAnalysis(base)
      ) {
        const session = applyFaultBranch(base, fault);
        return { session, analysis: analyzeSession(session) };
      }
      throw error;
    }
  }

  private bindInterface(): void {
    byId("play-pause").addEventListener("click", () => this.togglePlayback());
    byId("step-back").addEventListener("click", () => {
      this.clock.step(-0.1);
      this.renderFrame();
    });
    byId("step-forward").addEventListener("click", () => {
      this.clock.step(0.1);
      this.renderFrame();
    });
    byId<HTMLInputElement>("scrubber").addEventListener("input", (event) => {
      this.seekElapsed(Number((event.currentTarget as HTMLInputElement).value));
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-speed]")) {
      button.addEventListener("click", () => {
        let rate = Number(button.dataset.speed);
        if (this.mobileLayout && rate === 1) {
          const rates = [0.5, 1, 2];
          const currentIndex = rates.indexOf(this.clock.playbackRate);
          rate = rates[(currentIndex + 1) % rates.length] ?? 1;
        }
        if (Number.isFinite(rate) && rate > 0) {
          this.clock.setPlaybackRate(rate);
          this.renderFrame();
        }
      });
    }

    byId("event-list").addEventListener("click", (event) => {
      const button = (event.target as Element).closest<HTMLElement>("[data-incident-id]");
      if (button?.dataset.incidentId !== undefined) {
        this.selectIncident(button.dataset.incidentId, true);
      }
    });
    for (const id of ["timeline-markers", "timeline-gaps", "evidence-chain-list"]) {
      byId(id).addEventListener("click", (event) => {
        const target = (event.target as Element).closest<HTMLElement>(
          "[data-incident-id], [data-timestamp]",
        );
        if (target?.dataset.incidentId !== undefined) {
          this.selectIncident(target.dataset.incidentId, true);
        } else if (target?.dataset.timestamp !== undefined) {
          this.seekAbsolute(Number(target.dataset.timestamp));
        }
      });
    }
    byId<HTMLInputElement>("incident-search").addEventListener("input", (event) => {
      this.incidentQuery = (event.currentTarget as HTMLInputElement).value;
      this.renderIncidents();
    });
    byId("incident-filter").addEventListener("click", () => {
      this.severityFilter =
        this.severityFilter === "all"
          ? "critical"
          : this.severityFilter === "critical"
            ? "warning"
            : "all";
      const button = byId<HTMLButtonElement>("incident-filter");
      button.dataset.filter = this.severityFilter;
      button.setAttribute(
        "aria-label",
        this.severityFilter === "all"
          ? "Show all incidents"
          : `Showing ${this.severityFilter} incidents; activate to change filter`,
      );
      this.renderIncidents();
      this.showToast(
        this.severityFilter === "all"
          ? "Showing all incident severities"
          : `Showing ${this.severityFilter} incidents`,
      );
    });

    for (const tab of document.querySelectorAll<HTMLButtonElement>("[data-mobile-target]")) {
      tab.addEventListener("click", () => {
        this.mobileView = tab.dataset.mobileTarget as MobileView;
        renderMobileTabState(document, {
          active: this.mobileView,
          mobileLayout: this.mobileLayout,
        });
      });
    }
    this.bindRovingTabs(byId("mobile-tabs"), "[data-mobile-target]");
    for (const view of ["evidence", "sample", "rules"] as const) {
      byId(`inspector-tab-${view}`).addEventListener("click", () => {
        this.inspectorView = view;
        renderInspectorTabState(document, view);
        if (view === "sample") {
          this.renderFrame();
        } else {
          this.renderSelection();
        }
      });
    }
    this.bindRovingTabs(
      byId("inspector-tab-evidence").parentElement ?? byId("mobile-panel-evidence"),
      '[role="tab"]',
    );
    byId("open-rules").addEventListener("click", () => {
      this.inspectorView = "rules";
      this.mobileView = "evidence";
      renderInspectorTabState(document, "rules");
      renderMobileTabState(document, {
        active: "evidence",
        mobileLayout: this.mobileLayout,
      });
      byId<HTMLButtonElement>("inspector-tab-rules").focus();
    });
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view-mode]")) {
      button.addEventListener("click", () => {
        this.comparisonVisible = button.dataset.viewMode === "compare";
        for (const peer of document.querySelectorAll<HTMLButtonElement>("[data-view-mode]")) {
          peer.setAttribute("aria-pressed", String(peer === button));
        }
        byId("scene-stage").dataset.comparison = String(this.comparisonVisible);
        this.scene?.setComparisonVisible(this.comparisonVisible && this.prepared.baseline !== null);
        this.fallback?.setComparisonVisible(
          this.comparisonVisible && this.prepared.baseline !== null,
        );
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-camera]")) {
      button.addEventListener("click", () => {
        const mode = button.dataset.camera as RobotCameraMode;
        this.cameraMode = mode;
        this.scene?.setCameraMode(mode);
        for (const peer of document.querySelectorAll<HTMLButtonElement>("[data-camera]")) {
          peer.setAttribute("aria-pressed", String(peer === button));
        }
      });
    }

    byId<HTMLSelectElement>("mission-selector").addEventListener("change", (event) => {
      const id = (event.currentTarget as HTMLSelectElement).value;
      const scenario = catalogScenario(id);
      if (scenario === null) {
        this.cancelPendingCatalogLoad(this.missionLoadAbort !== null);
      } else {
        this.loadCatalogMission(scenario);
      }
    });

    byId("signal-settings").addEventListener("click", () => {
      this.signalPreset = this.signalPreset === "investigation" ? "power" : "investigation";
      this.charts.setMetrics(this.chartMetrics());
      const label = this.signalPreset === "power" ? "Power channels" : "Investigation channels";
      byId("signal-settings").textContent =
        this.signalPreset === "power" ? "Investigation" : "Power";
      this.showToast(`${label} selected`);
    });

    this.bindRules();
    this.bindDialogs();
    this.bindImport();
    this.bindFaultLab();
    this.bindExport();

    this.mediaQuery.addEventListener("change", (event) => {
      const previouslyFocused =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.mobileLayout = event.matches;
      renderMobileTabState(document, {
        active: this.mobileView,
        mobileLayout: this.mobileLayout,
      });
      this.renderFrame();
      requestAnimationFrame(() => {
        this.charts.resize();
        const currentFocus =
          document.activeElement instanceof HTMLElement ? document.activeElement : null;
        if (
          previouslyFocused !== null &&
          previouslyFocused.isConnected &&
          previouslyFocused.getClientRects().length === 0 &&
          (currentFocus === null ||
            currentFocus === document.body ||
            currentFocus === previouslyFocused ||
            currentFocus.getClientRects().length === 0)
        ) {
          (this.mobileLayout
            ? byId<HTMLButtonElement>(`mobile-tab-${this.mobileView}`)
            : byId<HTMLButtonElement>("play-pause")
          ).focus();
        }
      });
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this.clock.pause();
        if (this.animationFrame !== null) {
          cancelAnimationFrame(this.animationFrame);
          this.animationFrame = null;
        }
      } else {
        this.renderFrame();
      }
      this.syncSceneRendering();
    });
    document.addEventListener("keydown", (event) => this.handleKeyboard(event));
    window.addEventListener("beforeunload", () => this.dispose(), { once: true });
  }

  private handleKeyboard(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      const exportPanel = document.querySelector<HTMLElement>("#export-panel");
      if (exportPanel !== null && !exportPanel.hidden) {
        event.preventDefault();
        exportPanel.hidden = true;
        const exportButton = byId<HTMLButtonElement>("export-button");
        exportButton.setAttribute("aria-expanded", "false");
        exportButton.focus();
        return;
      }
    }
    const target = event.target;
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLButtonElement ||
      document.querySelector("dialog[open]") !== null
    ) {
      return;
    }
    if (event.code === "Space") {
      event.preventDefault();
      this.togglePlayback();
      return;
    }
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      this.clock.step(direction * (event.shiftKey ? 1 : 0.1));
      this.renderFrame();
      return;
    }
    if (event.key === "[" || event.key === "]") {
      event.preventDefault();
      const rates = [0.5, 1, 2];
      const current = rates.indexOf(this.clock.playbackRate);
      const next = Math.max(0, Math.min(rates.length - 1, current + (event.key === "[" ? -1 : 1)));
      this.clock.setPlaybackRate(rates[next] ?? 1);
      this.renderFrame();
    }
  }

  private bindRovingTabs(container: HTMLElement, selector: string): void {
    container.addEventListener("keydown", (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        return;
      }
      const tabs = [...container.querySelectorAll<HTMLButtonElement>(selector)];
      const current = tabs.indexOf(event.target as HTMLButtonElement);
      if (current < 0 || tabs.length === 0) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const nextIndex =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? tabs.length - 1
            : (current + (event.key === "ArrowLeft" ? -1 : 1) + tabs.length) % tabs.length;
      const next = tabs[nextIndex];
      next?.focus();
      next?.click();
    });
  }

  private bindDialogs(): void {
    const cancelDialogWork = (dialog: HTMLDialogElement): void => {
      if (dialog.id === "import-dialog") {
        this.importAbort?.abort();
        this.releaseImportFileReference();
      } else if (dialog.id === "fault-dialog") {
        this.faultGeneration += 1;
        this.faultAbort?.abort();
        this.resetLoadAbort?.abort();
      } else if (dialog.id === "live-dialog") {
        this.closeLiveCapture(false);
      }
    };
    const open = (buttonId: string, dialogId: string): void => {
      byId(buttonId).addEventListener("click", () => {
        const dialog = byId<HTMLDialogElement>(dialogId);
        if (!dialog.open) {
          dialog.showModal();
          if (dialog.id === "live-dialog") {
            this.renderLiveActionState();
          }
        }
      });
    };
    open("import-open", "import-dialog");
    open("live-open", "live-dialog");
    open("fault-open", "fault-dialog");
    for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog")) {
      dialog.addEventListener("cancel", () => cancelDialogWork(dialog));
      dialog.addEventListener("keydown", (event) => {
        if (event.key !== "Tab" || !dialog.open) {
          return;
        }
        const focusable = [
          ...dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]',
          ),
        ].filter(
          (element) =>
            !element.hidden &&
            element.getClientRects().length > 0 &&
            element.closest("[inert], [aria-hidden='true']") === null,
        );
        if (focusable.length === 0) {
          event.preventDefault();
          return;
        }
        const first = focusable[0];
        const last = focusable.at(-1);
        const active = document.activeElement;
        if (
          !dialog.contains(active) ||
          (event.shiftKey && active === first) ||
          (!event.shiftKey && active === last)
        ) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-dialog-close]")) {
      button.addEventListener("click", () => {
        const dialog = button.closest<HTMLDialogElement>("dialog");
        if (dialog !== null) {
          const explicitLiveDiscard =
            dialog.id === "live-dialog" &&
            button.closest(".modal-footer") !== null &&
            this.hasRetainedLiveCapture();
          if (explicitLiveDiscard) {
            this.closeLiveCapture(true);
          } else {
            cancelDialogWork(dialog);
          }
          dialog.close("cancel");
        }
      });
    }
    byId<HTMLFormElement>("import-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.importRecording();
    });
    byId<HTMLFormElement>("live-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.connectLiveSource();
    });
    byId<HTMLFormElement>("fault-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void this.applyFaultLab();
    });
    const syncLiveSource = (): void => {
      const source =
        document.querySelector<HTMLInputElement>('input[name="live-source"]:checked')?.value ??
        "simulator";
      byId<HTMLInputElement>("live-url").disabled = source !== "websocket";
      if (this.liveTransport === null) {
        byId<HTMLButtonElement>("live-connect").textContent =
          source === "websocket" ? "Connect WebSocket" : "Start simulator";
      }
    };
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="live-source"]')) {
      radio.addEventListener("change", () => {
        syncLiveSource();
        this.renderLiveActionState();
      });
    }
    syncLiveSource();
  }

  private bindRules(): void {
    const toggles: Array<[string, string, string?]> = [
      ["rule-latency-enabled", "rule-latency-threshold", "rule-latency-duration"],
      ["rule-route-enabled", "rule-route-threshold"],
      ["rule-current-enabled", "rule-current-threshold"],
    ];
    for (const [toggleId, thresholdId, durationId] of toggles) {
      byId<HTMLInputElement>(toggleId).addEventListener("change", (event) => {
        const enabled = (event.currentTarget as HTMLInputElement).checked;
        byId<HTMLInputElement>(thresholdId).disabled = !enabled;
        if (durationId !== undefined) {
          byId<HTMLInputElement>(durationId).disabled = !enabled;
        }
      });
    }
    byId<HTMLFormElement>("rules-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const values = {
        latencyEnabled: byId<HTMLInputElement>("rule-latency-enabled").checked,
        latencyThreshold: Number(byId<HTMLInputElement>("rule-latency-threshold").value),
        latencyDuration: Number(byId<HTMLInputElement>("rule-latency-duration").value) / 1_000,
        routeEnabled: byId<HTMLInputElement>("rule-route-enabled").checked,
        routeThreshold: Number(byId<HTMLInputElement>("rule-route-threshold").value),
        currentEnabled: byId<HTMLInputElement>("rule-current-enabled").checked,
        currentThreshold: Number(byId<HTMLInputElement>("rule-current-threshold").value),
      };
      void this.reanalyzeWithDetectors((detectors) => {
        const latency = detectors.rules["link-degradation"];
        latency.enabled = values.latencyEnabled;
        latency.threshold = values.latencyThreshold;
        latency.minimumDuration = values.latencyDuration;
        const route = detectors.rules["route-deviation"];
        route.enabled = values.routeEnabled;
        route.threshold = values.routeThreshold;
        const current = detectors.rules.overcurrent;
        current.enabled = values.currentEnabled;
        current.threshold = values.currentThreshold;
      }, "Detector configuration applied");
    });
    byId<HTMLFormElement>("rules-form").addEventListener("reset", () => {
      requestAnimationFrame(() => {
        const defaults = generateEastLoopScenario().detectors;
        void this.reanalyzeWithDetectors((detectors) => {
          const restored = cloneDetectorConfiguration(defaults);
          detectors.version = restored.version;
          detectors.rules = restored.rules;
        }, "Default detector configuration restored");
      });
    });
  }

  private async reanalyzeWithDetectors(
    update: (detectors: DetectorConfiguration) => void,
    announce: string,
  ): Promise<void> {
    await this.waitForSourceTransition();
    const base = this.session;
    const next = cloneReplaySession(base);
    update(next.detectors);
    const rootSessionSha256 =
      base.provenance.rootSessionSha256 ??
      fingerprintReplaySessionContent(base === this.pristineSession ? base : this.pristineSession);
    const interpretationFingerprint = fingerprintReplaySessionContent(next);
    next.id = deterministicIdentifier("session-rules", {
      parentSessionId: base.id,
      interpretationFingerprint,
    });
    next.provenance = {
      ...next.provenance,
      source: "derived",
      label: `${base.provenance.label.replace(/ · detector rules$/u, "")} · detector rules`,
      parentSessionId: base.id,
      rootSessionSha256,
      sha256: "0".repeat(64),
      notes: [
        ...(next.provenance.notes ?? []).filter(
          (note) =>
            !note.startsWith("Detector configuration derived locally") &&
            !note.startsWith("Provenance fingerprint uses robot-replay/fault-branch-sha256/"),
        ),
        `Detector configuration derived locally from session ${base.id}; normalized session-content fingerprint recomputed after the rule change.`,
      ],
    };
    next.provenance.sha256 = fingerprintReplaySessionContent(next);
    const timestamp = this.currentTimestamp;
    const updatePristine = base === this.pristineSession;
    try {
      await this.loadSession(next, {
        setPristine: updatePristine,
        catalogIdentity: null,
        seekTimestamp: timestamp,
        preserveSelection: true,
        announce,
      });
    } catch (error) {
      this.showToast(
        error instanceof Error ? error.message : "Unable to apply detector configuration",
        "error",
      );
    }
  }

  private bindImport(): void {
    const fileInput = byId<HTMLInputElement>("import-file");
    const dropZone = byId("import-drop-zone");
    const syncFormatOptions = (): void => {
      const format = byId<HTMLSelectElement>("import-format").value;
      const role = byId<HTMLSelectElement>("import-role");
      const completeOption = role.querySelector<HTMLOptionElement>('option[value="session"]');
      const runOnly = format !== "session-json";
      if (completeOption !== null) {
        completeOption.disabled = runOnly;
      }
      if (runOnly && role.value === "session") {
        role.value = "candidate";
      }
      role.disabled = format === "session-json";
      if (format === "session-json") {
        role.value = "session";
      }
      byId<HTMLSelectElement>("import-time-unit").disabled =
        format === "ros-jsonl" || format === "session-json";
    };
    const updateFile = (file: File | null): void => {
      this.selectedImportFile = file;
      byId<HTMLButtonElement>("import-submit").disabled = file === null;
      const strong = dropZone.querySelector("strong");
      const detail = dropZone.querySelector("span:last-of-type");
      if (strong !== null) {
        strong.textContent = file?.name ?? "Drop a recording or choose a file";
      }
      if (detail !== null) {
        detail.textContent =
          file === null
            ? "Session JSON, CSV, or ROS-bridge JSONL · up to 16 MiB"
            : `${(file.size / 1024).toFixed(1)} KiB · processed locally in the current session`;
      }
      byId("import-errors").hidden = true;
      byId("import-errors").removeAttribute("data-tone");
    };
    fileInput.addEventListener("change", () => updateFile(fileInput.files?.[0] ?? null));
    for (const eventName of ["dragenter", "dragover"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.dataset.dragging = "true";
      });
    }
    for (const eventName of ["dragleave", "drop"]) {
      dropZone.addEventListener(eventName, (event) => {
        event.preventDefault();
        dropZone.dataset.dragging = "false";
      });
    }
    dropZone.addEventListener("drop", (event) => {
      const file = (event as DragEvent).dataTransfer?.files[0] ?? null;
      updateFile(file);
    });
    byId("import-cancel").addEventListener("click", () => this.importAbort?.abort());
    byId<HTMLSelectElement>("import-format").addEventListener("change", syncFormatOptions);
    syncFormatOptions();
  }

  private releaseImportFileReference(): void {
    this.selectedImportFile = null;
    const fileInput = document.querySelector<HTMLInputElement>("#import-file");
    if (fileInput !== null) {
      fileInput.value = "";
    }
    const dropZone = document.querySelector<HTMLElement>("#import-drop-zone");
    const strong = dropZone?.querySelector("strong");
    const detail = dropZone?.querySelector("span:last-of-type");
    if (strong !== null && strong !== undefined) {
      strong.textContent = "Drop a recording or choose a file";
    }
    if (detail !== null && detail !== undefined) {
      detail.textContent = "Session JSON, CSV, or ROS-bridge JSONL · up to 16 MiB";
    }
    const submit = document.querySelector<HTMLButtonElement>("#import-submit");
    if (submit !== null) {
      submit.disabled = true;
    }
  }

  private async importRecording(): Promise<void> {
    const file = this.selectedImportFile;
    if (file === null) {
      return;
    }
    const progress = byId("import-progress");
    const progressBar = byId<HTMLProgressElement>("import-progress-bar");
    const submit = byId<HTMLButtonElement>("import-submit");
    const errorBox = byId("import-errors");
    if (this.importAbort !== null) {
      this.importAbort.abort();
      this.loadGeneration += 1;
      this.committedLoadGeneration = this.loadGeneration;
    }
    const generation = ++this.importGeneration;
    progress.hidden = false;
    errorBox.hidden = true;
    submit.disabled = true;
    this.importAbort = new AbortController();
    const abortController = this.importAbort;
    const assertCurrentImport = (): void => {
      assertNotAborted(abortController.signal);
      if (generation !== this.importGeneration || this.importAbort !== abortController) {
        throw new DOMException("The import was superseded", "AbortError");
      }
    };
    const setProgress = (value: number, label: string): void => {
      if (generation !== this.importGeneration || this.importAbort !== abortController) {
        return;
      }
      progressBar.value = value;
      setText("import-progress-value", `${value}%`);
      setText("import-progress-label", label);
    };
    try {
      await this.waitForSourceTransition();
      assertCurrentImport();
      setProgress(8, "Checking source size…");
      const formatValue = byId<HTMLSelectElement>("import-format").value;
      const roleValue = byId<HTMLSelectElement>("import-role").value;
      const format =
        formatValue === "session-json" ? "json" : (formatValue as "auto" | "csv" | "ros-jsonl");
      const importOptions: Omit<ImportRecordingOptions, "signal"> = {
        format,
        ...(roleValue === "session" ? {} : { role: roleValue as "candidate" | "baseline" }),
        yawUnit: byId<HTMLSelectElement>("import-yaw-unit").value as "radians" | "degrees",
        timestampUnit: byId<HTMLSelectElement>("import-time-unit").value as
          "seconds" | "milliseconds" | "nanoseconds",
        normalizeTimestampOrigin: true,
        sourceName: file.name,
      };
      setProgress(20, "Sending recording to the analysis worker…");
      const workerResult = await this.requestWorker(
        {
          type: "import-recording",
          requestId: `import-${++this.workerSequence}`,
          input: file,
          options: importOptions,
        },
        {
          signal: abortController.signal,
          onProgress: (progressValue, message) =>
            setProgress(Math.round(10 + progressValue * 60), message),
        },
      );
      if (workerResult.kind !== "import-recording") {
        throw new Error("Unexpected import worker result");
      }
      assertCurrentImport();
      const result: ImportedRecording = workerResult.recording;
      setProgress(72, "Building replay session…");
      let next: ReplaySessionV2;
      const warningMessages = result.warnings.map(({ message }) => message);
      if (result.kind === "session") {
        next = cloneReplaySession(result.session);
        if (roleValue !== "session") {
          warningMessages.push(
            "Canonical session JSON preserves its encoded candidate and baseline roles; the complete session was loaded.",
          );
        }
      } else {
        let run = result.run;
        if (result.role === "baseline") {
          const sourceSession = this.session;
          if (run.id === this.session.runs.candidate.id) {
            run = {
              ...run,
              id: deterministicIdentifier(
                "baseline",
                { sourceId: run.id, sourceSha256: result.sha256 },
                new Set([this.session.runs.candidate.id]),
              ),
            };
            warningMessages.push(
              "The imported baseline reused the candidate ID, so it received a different internal ID.",
            );
          }
          const aligned = alignBaselineRun(sourceSession.runs.candidate, {
            ...run,
            role: "baseline",
          });
          const baselineRun: ReplaySessionRun = { ...aligned.run, role: "baseline" };
          assertReplaySessionImportLimits({
            ...sourceSession,
            runs: { ...sourceSession.runs, baseline: baselineRun },
          });
          next = cloneReplaySession(sourceSession);
          next.runs.baseline = baselineRun;
          next.id = deterministicIdentifier("session-composite", {
            candidateSessionId: sourceSession.id,
            candidateFingerprint: sourceSession.provenance.sha256,
            baselineSourceFingerprint: result.sha256,
            baselineId: baselineRun.id,
            alignmentOffsetSeconds: aligned.offsetSeconds,
          });
          next.provenance = {
            source: "derived",
            label: `${sourceSession.provenance.label} + ${result.provenance.label} baseline`,
            importedAt: result.provenance.importedAt ?? sourceSession.provenance.importedAt,
            sha256: "0".repeat(64),
            deterministic:
              sourceSession.provenance.deterministic && result.provenance.deterministic,
            notes: [
              ...(sourceSession.provenance.notes ?? []),
              `Composite candidate source fingerprint: ${sourceSession.provenance.sha256}.`,
              `Composite baseline raw-source fingerprint: ${result.sha256}.`,
              `Baseline source run ID: ${result.run.id}; internal run ID: ${baselineRun.id}.`,
              `Baseline imported locally from ${result.sourceName} (${result.sha256.slice(0, 12)}…).`,
              `Baseline provenance: ${result.provenance.source} · ${result.provenance.label} · acquired ${result.provenance.importedAt ?? "time not supplied"} · raw-source SHA-256 ${result.provenance.sha256}.`,
              `Baseline elapsed-time alignment: added exactly ${String(aligned.offsetSeconds)} s to every normalized timestamp so source start ${String(aligned.baselineStart)} s maps to candidate start ${String(aligned.candidateStart)} s; source time origin ${result.timeOriginExact}.`,
              ...(result.provenance.notes ?? []).map((note) => `Baseline provenance note: ${note}`),
              "Composite fingerprint uses normalized session-content SHA-256 after elapsed-time alignment; parent/root lineage was intentionally reset at this new source boundary.",
            ],
          };
          next.provenance.sha256 = fingerprintReplaySessionContent(next);
        } else {
          warningMessages.push(
            "Robot model, bus voltage, and physical footprint were not present in the run file; energy is unavailable and the generic footprint is visualization-only.",
          );
          const importIdentity = sha256StableValue({
            runId: run.id,
            sourceFingerprint: result.sha256,
          });
          next = createReplaySession({
            id: `session-import-${importIdentity.slice(0, 32)}`,
            candidate: { ...run, role: "candidate" },
            mission: {
              id: `IMPORT-${importIdentity.slice(0, 16).toUpperCase()}`,
              title: run.name,
              subtitle: "Locally imported telemetry investigation",
              site: "Browser-local recording",
              objective:
                "Compare the imported candidate against available route and baseline samples.",
              outcome: run.kind === "normal" ? "nominal" : "degraded",
              scenario: `import-${importIdentity.slice(0, 16)}`,
              tags: ["imported", result.format, "local-only"],
            },
            provenance: result.provenance,
          });
        }
      }
      if (warningMessages.length > 0) {
        next.provenance.notes = [
          ...(next.provenance.notes ?? []),
          ...warningMessages.map((message) => `Import note: ${message}`),
        ];
      }
      assertCurrentImport();
      if (result.kind === "run" && result.role === "baseline") {
        next.provenance.sha256 = fingerprintReplaySessionContent(next);
      }
      assertReplaySessionImportLimits(next);
      setProgress(88, "Finding incidents…");
      await this.loadSession(next, {
        setPristine: true,
        catalogIdentity: null,
        signal: abortController.signal,
        announce: `Imported ${file.name} locally${warningMessages.length === 0 ? "" : ` · ${warningMessages.length} normalization note${warningMessages.length === 1 ? "" : "s"}`}`,
      });
      assertCurrentImport();
      if (this.session !== next) {
        throw new DOMException("The import was superseded", "AbortError");
      }
      setProgress(100, "Import complete");
      if (warningMessages.length === 0) {
        byId<HTMLDialogElement>("import-dialog").close();
      } else {
        errorBox.dataset.tone = "warning";
        errorBox.textContent = `Import completed with ${warningMessages.length} normalization note${warningMessages.length === 1 ? "" : "s"}:\n\n${warningMessages.map((message) => `• ${message}`).join("\n")}`;
        errorBox.hidden = false;
        errorBox.focus();
      }
    } catch (error) {
      if (
        abortController.signal.aborted ||
        generation !== this.importGeneration ||
        this.importAbort !== abortController
      ) {
        setProgress(0, "Import cancelled");
        return;
      }
      errorBox.textContent = publicImportErrorMessage(error);
      errorBox.dataset.tone = "error";
      errorBox.hidden = false;
      setProgress(0, "Import failed");
    } finally {
      if (generation === this.importGeneration && this.importAbort === abortController) {
        this.importAbort = null;
        this.releaseImportFileReference();
      } else {
        submit.disabled = this.selectedImportFile === null;
      }
    }
  }

  private bindFaultLab(): void {
    const controls = {
      duration: byId<HTMLInputElement>("fault-duration"),
      position: byId<HTMLInputElement>("fault-pose-x"),
      yaw: byId<HTMLInputElement>("fault-pose-yaw"),
      load: byId<HTMLInputElement>("fault-load"),
    };
    const selectedType = (): string =>
      document.querySelector<HTMLInputElement>('input[name="fault-type"]:checked')?.value ??
      "dropout";
    const update = (): void => {
      const type = selectedType();
      controls.duration.disabled = type === "pose-reset";
      controls.position.disabled = type !== "pose-reset";
      controls.yaw.disabled = type !== "pose-reset";
      controls.load.disabled = type !== "motor-load";
      controls.duration.min = type === "motor-load" ? "0.5" : "0.1";
      if (type === "motor-load" && Number(controls.duration.value) < 0.5) {
        controls.duration.value = "0.5";
      }
      setText("fault-anchor-time", formatTimecode(this.faultAnchorTimestamp - this.startTimestamp));
      setText("fault-duration-output", `${Number(controls.duration.value).toFixed(1)} s`);
      setText(
        "fault-pose-x-output",
        `${Number(controls.position.value) >= 0 ? "+" : ""}${Number(controls.position.value).toFixed(1)} m`,
      );
      setText(
        "fault-pose-yaw-output",
        `${Number(controls.yaw.value) >= 0 ? "+" : ""}${Number(controls.yaw.value).toFixed(0)}°`,
      );
      setText("fault-load-output", `${Number(controls.load.value).toFixed(1)}×`);
      const samples = this.session.runs.candidate.samples;
      const finalTimestamp = samples.at(-1)?.timestamp ?? this.faultAnchorTimestamp;
      const effectiveDuration =
        type === "motor-load"
          ? Math.max(0.5, Number(controls.duration.value))
          : Number(controls.duration.value);
      const endTimestamp = Math.min(finalTimestamp, this.faultAnchorTimestamp + effectiveDuration);
      const poseChanges = Number(controls.position.value) !== 0 || Number(controls.yaw.value) !== 0;
      const affectedStart = firstTimestampIndex(
        samples,
        this.faultAnchorTimestamp,
        type !== "dropout",
      );
      const affectedEnd = firstTimestampIndex(samples, endTimestamp, true);
      let affected = 0;
      if (type === "pose-reset") {
        affected = poseChanges ? samples.length - affectedStart : 0;
      } else if (type === "dropout") {
        affected = Math.max(0, affectedEnd - affectedStart);
      } else {
        const multiplier = Number(controls.load.value);
        for (let index = affectedStart; index < affectedEnd; index += 1) {
          const current = samples[index]?.current;
          if (current !== null && current !== undefined && current * multiplier !== current) {
            affected += 1;
          }
        }
      }
      const preview = byId("fault-preview");
      const heading = document.createElement("span");
      heading.textContent = "Expected branch";
      const strong = document.createElement("strong");
      strong.textContent =
        type === "dropout"
          ? `${affected} samples removed`
          : type === "pose-reset"
            ? `${affected} poses offset`
            : `${affected} current samples scaled`;
      const note = document.createElement("small");
      note.textContent =
        affected === 0
          ? "Choose a non-zero transformation inside the recorded time range."
          : "Current run stays intact.";
      preview.replaceChildren(heading, strong, note);
      byId<HTMLButtonElement>("fault-apply").disabled = affected === 0;
    };
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="fault-type"]')) {
      radio.addEventListener("change", update);
    }
    for (const control of Object.values(controls)) {
      control.addEventListener("input", update);
    }
    byId("fault-open").addEventListener("click", () => {
      this.clock.pause();
      this.renderFrame();
      this.faultAnchorTimestamp = this.currentTimestamp;
      update();
    });
    byId("fault-reset").addEventListener("click", () => {
      void this.resetFaultBranch();
    });
    update();
  }

  private async resetFaultBranch(): Promise<void> {
    if (this.resetLoadPromise !== null) {
      await this.resetLoadPromise;
      return;
    }
    this.faultGeneration += 1;
    this.faultAbort?.abort();
    this.resetLoadAbort?.abort();
    const abortController = new AbortController();
    this.resetLoadAbort = abortController;
    const resetButton = byId<HTMLButtonElement>("fault-reset");
    const applyButton = byId<HTMLButtonElement>("fault-apply");
    resetButton.disabled = true;
    applyButton.disabled = true;
    const operation = (async (): Promise<void> => {
      try {
        await this.waitForCatalogMission();
        assertNotAborted(abortController.signal);
        const next = cloneReplaySession(this.pristineSession);
        const seekTimestamp = this.currentTimestamp;
        await this.loadSession(next, {
          setPristine: true,
          catalogIdentity: this.pristineCatalogIdentity,
          signal: abortController.signal,
          seekTimestamp,
          announce: "Fault Lab branch reset",
        });
        assertNotAborted(abortController.signal);
        if (this.session !== next) {
          throw new Error("Fault Lab reset was superseded before it could be committed");
        }
        const dialog = byId<HTMLDialogElement>("fault-dialog");
        if (dialog.open) {
          dialog.close();
        }
      } catch (error) {
        if (!abortController.signal.aborted) {
          this.showToast(
            error instanceof Error ? error.message : "Unable to reset the Fault Lab branch",
            "error",
          );
        }
      } finally {
        if (this.resetLoadAbort === abortController) {
          this.resetLoadAbort = null;
        }
        resetButton.disabled = false;
        applyButton.disabled = false;
      }
    })();
    this.resetLoadPromise = operation;
    try {
      await operation;
    } finally {
      if (this.resetLoadPromise === operation) {
        this.resetLoadPromise = null;
      }
    }
  }

  private async applyFaultLab(): Promise<void> {
    byId<HTMLButtonElement>("fault-apply").disabled = true;
    this.faultAbort?.abort();
    const abortController = new AbortController();
    this.faultAbort = abortController;
    const generation = ++this.faultGeneration;
    try {
      await this.waitForSourceTransition();
      assertNotAborted(abortController.signal);
      const type =
        document.querySelector<HTMLInputElement>('input[name="fault-type"]:checked')?.value ??
        "dropout";
      const startTimestamp = this.currentTimestamp;
      const duration = Number(byId<HTMLInputElement>("fault-duration").value);
      let fault: FaultSpecification;
      if (type === "pose-reset") {
        fault = {
          type: "pose-reset",
          startTimestamp,
          offsetX: Number(byId<HTMLInputElement>("fault-pose-x").value),
          offsetY: 0,
          offsetYaw: (Number(byId<HTMLInputElement>("fault-pose-yaw").value) * Math.PI) / 180,
        };
      } else if (type === "motor-load") {
        fault = {
          type: "motor-load",
          startTimestamp,
          duration: Math.max(0.5, duration),
          multiplier: Number(byId<HTMLInputElement>("fault-load").value),
        };
      } else {
        fault = { type: "packet-dropout", startTimestamp, duration };
      }
      const branch = await this.branchFaultInWorker(this.session, fault, abortController.signal);
      if (generation !== this.faultGeneration) {
        return;
      }
      await this.loadSession(branch.session, {
        analysis: branch.analysis,
        setPristine: false,
        catalogIdentity: null,
        signal: abortController.signal,
        seekTimestamp: startTimestamp,
        announce: `${formatStateLabel(fault.type)} branch ready`,
      });
      byId<HTMLDialogElement>("fault-dialog").close();
    } catch (error) {
      if (!abortController.signal.aborted && generation === this.faultGeneration) {
        this.showToast(error instanceof Error ? error.message : "Fault branch failed", "error");
      }
    } finally {
      if (this.faultAbort === abortController) {
        this.faultAbort = null;
      }
      byId<HTMLButtonElement>("fault-apply").disabled = false;
    }
  }

  private hasRetainedLiveCapture(): boolean {
    return (
      this.retryableLiveSnapshot !== null ||
      this.liveFinalizationPromise !== null ||
      this.liveDeliveredSamples + this.livePendingSamples > 0
    );
  }

  private closeLiveCapture(discard: boolean): void {
    if (!discard && this.retryableLiveSnapshot === null) {
      const snapshot = this.liveTransport?.getSnapshot();
      if (snapshot !== undefined && snapshot.samples.length > 0) {
        this.retryableLiveSnapshot = snapshot;
      }
    }
    if (discard) {
      this.retryableLiveSnapshot = null;
    }
    this.disconnectLive();
    this.renderLiveActionState();
  }

  private renderLiveActionState(): void {
    const button = document.querySelector<HTMLButtonElement>("#live-connect");
    if (button === null) {
      return;
    }
    const source =
      document.querySelector<HTMLInputElement>('input[name="live-source"]:checked')?.value ??
      "simulator";
    const finalizing = this.liveFinalizationPromise !== null;
    const retrySnapshot = this.retryableLiveSnapshot;
    const retryAvailable = retrySnapshot !== null;
    const connected =
      this.liveTransport !== null &&
      this.liveTransport.state !== "disconnected" &&
      this.liveTransport.state !== "complete";
    if (finalizing) {
      button.textContent = "Analysing capture…";
      button.disabled = true;
    } else if (retryAvailable) {
      button.textContent = "Retry capture analysis";
      button.disabled = false;
    } else if (connected) {
      button.textContent = "Disconnect";
      button.disabled = false;
    } else {
      button.textContent = source === "websocket" ? "Connect WebSocket" : "Start simulator";
      button.disabled = false;
    }
    const lockSource = finalizing || retryAvailable;
    for (const radio of document.querySelectorAll<HTMLInputElement>('input[name="live-source"]')) {
      radio.disabled = lockSource;
    }
    const url = document.querySelector<HTMLInputElement>("#live-url");
    if (url !== null) {
      url.disabled = lockSource || source !== "websocket";
    }
    const discardButton = document.querySelector<HTMLButtonElement>(
      "#live-dialog .modal-footer [data-dialog-close]",
    );
    if (discardButton !== null) {
      discardButton.textContent = this.hasRetainedLiveCapture() ? "Discard capture" : "Cancel";
    }
    if (retrySnapshot !== null && !finalizing && this.liveTransport === null) {
      byId("connection-status").dataset.state = "error";
      byId("connection-dot").dataset.state = "error";
      setText("connection-state-label", "Analysis retry available");
      setText(
        "connection-state-detail",
        `${retrySnapshot.samples.length.toLocaleString()} retained samples remain in browser memory`,
      );
      setText("connection-buffer", `${retrySnapshot.samples.length.toLocaleString()} retained`);
    }
  }

  private async beginLiveFinalization(
    snapshot: LiveTransportSnapshot,
    generation: number,
  ): Promise<void> {
    if (snapshot.samples.length === 0) {
      return;
    }
    if (this.liveFinalizationPromise !== null) {
      await this.liveFinalizationPromise;
      return;
    }
    this.retryableLiveSnapshot = snapshot;
    const operation = this.finalizeLiveSession(snapshot, generation);
    this.liveFinalizationPromise = operation;
    this.renderLiveActionState();
    try {
      await operation;
    } finally {
      if (this.liveFinalizationPromise === operation) {
        this.liveFinalizationPromise = null;
      }
      this.renderLiveActionState();
    }
  }

  private async connectLiveSource(): Promise<void> {
    const button = byId<HTMLButtonElement>("live-connect");
    if (this.liveFinalizationPromise !== null) {
      return;
    }
    if (this.retryableLiveSnapshot !== null) {
      await this.beginLiveFinalization(this.retryableLiveSnapshot, this.liveGeneration);
      return;
    }
    if (this.liveTransport !== null) {
      const snapshot = this.liveTransport.getSnapshot();
      const active =
        this.liveTransport.state !== "disconnected" && this.liveTransport.state !== "complete";
      if (active || snapshot.samples.length > 0) {
        this.disconnectLive();
        if (snapshot.samples.length > 0) {
          await this.beginLiveFinalization(snapshot, this.liveGeneration);
        }
        return;
      }
    }
    const source =
      document.querySelector<HTMLInputElement>('input[name="live-source"]:checked')?.value ??
      "simulator";
    this.liveSource = source === "websocket" ? "websocket" : "simulator";
    const generation = ++this.liveGeneration;
    button.disabled = true;
    try {
      this.disconnectLive(false);
      this.clock.pause();
      this.renderFrame();
      this.liveDeliveredSamples = 0;
      this.livePendingSamples = 0;
      let transport: LiveTransport;
      if (source === "simulator") {
        const { DeterministicLiveSimulator } = await import("./core/live-simulator");
        transport = new DeterministicLiveSimulator({ playbackRate: 8 });
      } else {
        const { WebSocketLiveClient } = await import("./core/live-transport");
        transport = new WebSocketLiveClient({
          url: byId<HTMLInputElement>("live-url").value,
          maximumSamples: 50_000,
        });
      }
      if (generation !== this.liveGeneration || !byId<HTMLDialogElement>("live-dialog").open) {
        transport.disconnect();
        return;
      }
      this.liveTransport = transport;
      this.liveUnsubscribe = transport.subscribe((update) => this.handleLiveUpdate(update));
      transport.connect();
      this.renderLiveStatus(transport.getSnapshot());
      this.renderLiveActionState();
    } catch (error) {
      if (generation === this.liveGeneration) {
        this.disconnectLive();
        this.renderLiveError(publicLiveErrorMessage(error));
      }
    } finally {
      if (generation === this.liveGeneration) {
        this.renderLiveActionState();
      }
    }
  }

  private handleLiveUpdate(update: LiveTransportUpdate): void {
    const transport = this.liveTransport;
    if (transport === null) {
      return;
    }
    if (update.type === "samples") {
      this.liveDeliveredSamples += update.samples.length;
      if (update.catchUp) {
        this.livePendingSamples = Math.max(0, this.livePendingSamples - update.samples.length);
      }
      this.renderLiveSummary(transport.state);
      const latest = update.samples.at(-1);
      if (latest !== undefined) {
        setText(
          "connection-state-detail",
          `${this.liveDeliveredSamples.toLocaleString()} samples captured locally`,
        );
      }
    } else if (update.type === "delivery") {
      this.livePendingSamples = update.pendingSamples;
      this.renderLiveSummary(transport.state);
    } else if (update.type === "state") {
      this.renderLiveSummary(update.state);
    } else if (update.type === "hello") {
      this.renderLiveSummary(transport.state);
    } else if (update.type === "event") {
      if (update.event.severity === "critical") {
        this.showToast(`Live · ${update.event.title}`);
      }
    } else if (update.type === "error") {
      this.renderLiveError(publicLiveErrorMessage(update.error));
      const generation = this.liveGeneration;
      queueMicrotask(() => {
        if (
          generation !== this.liveGeneration ||
          transport !== this.liveTransport ||
          transport.state !== "disconnected"
        ) {
          return;
        }
        const snapshot = transport.getSnapshot();
        if (snapshot.samples.length === 0) {
          return;
        }
        this.disconnectLive();
        void this.beginLiveFinalization(snapshot, this.liveGeneration);
      });
    } else if (update.type === "end") {
      const snapshot = transport.getSnapshot();
      this.disconnectLive();
      void this.beginLiveFinalization(snapshot, this.liveGeneration);
    }
  }

  private renderLiveStatus(snapshot: LiveTransportSnapshot): void {
    this.liveDeliveredSamples = Math.max(0, snapshot.receivedSamples - snapshot.pendingSamples);
    this.livePendingSamples = snapshot.pendingSamples;
    this.renderLiveSummary(snapshot.state);
  }

  private renderLiveSummary(state: LiveTransportSnapshot["state"]): void {
    const status = byId("connection-status");
    status.dataset.state = state;
    byId("connection-dot").dataset.state = state;
    setText("connection-state-label", formatStateLabel(state));
    const receivedSamples = this.liveDeliveredSamples + this.livePendingSamples;
    const detail =
      state === "live"
        ? `${receivedSamples.toLocaleString()} samples received`
        : state === "complete"
          ? "Stream complete"
          : state === "reconnecting"
            ? "Transport interrupted · reconnect backoff active"
            : state === "stale"
              ? "No recent samples · awaiting source"
              : state === "connecting"
                ? "Connecting to telemetry stream"
                : "No samples received";
    setText("connection-state-detail", detail);
    setText("connection-buffer", `${Math.min(50_000, receivedSamples).toLocaleString()} / 50,000`);
    const button = byId<HTMLButtonElement>("live-connect");
    const connected = state !== "disconnected" && state !== "complete";
    button.textContent = connected ? "Disconnect" : "Start stream";
    this.renderLiveActionState();
  }

  private renderLiveError(message: string): void {
    const status = byId("connection-status");
    status.dataset.state = "error";
    byId("connection-dot").dataset.state = "error";
    setText("connection-state-label", "Connection rejected");
    setText("connection-state-detail", message);
    this.showToast(message, "error");
  }

  private async finalizeLiveSession(
    snapshot: LiveTransportSnapshot,
    generation: number,
  ): Promise<void> {
    if (snapshot.samples.length === 0 || generation !== this.liveGeneration) {
      return;
    }
    try {
      const descriptor = snapshot.session;
      const critical = snapshot.criticalEver;
      const displayedGaps = snapshot.gaps.slice(-128);
      const captureIdentity = sha256StableValue({
        source: this.liveSource,
        descriptor,
        samples: snapshot.samples,
        events: snapshot.events,
        gaps: snapshot.gaps,
        end: snapshot.end,
        receivedSamples: snapshot.receivedSamples,
        receivedEvents: snapshot.receivedEvents,
        receivedGaps: snapshot.receivedGaps,
      });
      const sourceRobotId = descriptor?.robotId ?? "not supplied";
      const runId = `live-run-${captureIdentity.slice(0, 32)}`;
      const sessionId = `live-session-${captureIdentity.slice(0, 32)}`;
      const robotId = deterministicIdentifier("live-robot", {
        captureIdentity,
        sourceRobotId,
      });
      const retainedEventIds = new Set<string>();
      const eventAnnotations = snapshot.events.map((event, index) => {
        const id = deterministicIdentifier(
          "live-event",
          { captureIdentity, sourceEventId: event.id, index },
          retainedEventIds,
        );
        retainedEventIds.add(id);
        return {
          id,
          timestamp: event.timestamp,
          label: `${formatStateLabel(event.severity)} · ${event.title}`,
          body: [
            event.description ?? "Live source event",
            `Kind: ${event.kind}`,
            ...Object.entries(event.details).map(([key, value]) => `${key}: ${String(value)}`),
          ].join("\n"),
          author: "Live event",
        };
      });
      const run: ReplaySessionRun = {
        id: runId,
        name: descriptor?.name ?? "Live telemetry capture",
        role: "candidate",
        kind: critical ? "faulty" : "normal",
        samples: snapshot.samples.map((sample) => ({
          ...sample,
          pose: { ...sample.pose },
        })),
        ...(descriptor?.sampleRateHz === null || descriptor?.sampleRateHz === undefined
          ? {}
          : { sampleRateHz: descriptor.sampleRateHz }),
        description: "Live telemetry run.",
      };
      const session = createReplaySession({
        id: sessionId,
        candidate: run,
        mission: {
          id: "LIVE-001",
          title: descriptor?.name ?? "Live autonomy capture",
          subtitle: "Streaming telemetry investigation",
          site: "Browser live transport",
          objective: "Inspect streamed telemetry as it arrives.",
          outcome: critical ? "degraded" : "nominal",
          scenario: `live-${captureIdentity.slice(0, 16)}`,
          tags: [
            "live",
            "streaming",
            "bounded-buffer",
            this.liveSource === "websocket" ? "user-initiated-network" : "local-simulator",
          ],
        },
        robot: {
          id: robotId,
          name: descriptor?.robotId ?? "Unspecified live robot",
          model: "Mobile robot",
          drive: "unknown",
        },
        annotations: [
          ...eventAnnotations,
          ...displayedGaps.map((gap) => ({
            id: gap.id,
            timestamp: gap.startTimestamp,
            label: `${formatStateLabel(gap.kind)} gap`,
            body: `End: ${gap.endTimestamp ?? "open"}; missing: ${gap.missingSamples ?? "unknown"}; locally dropped: ${gap.droppedSamples}`,
            author: "Live transport",
          })),
        ],
        provenance: {
          source: "live",
          label: descriptor?.source ?? "Live v2 transport",
          importedAt: descriptor?.startedAt ?? new Date().toISOString(),
          deterministic: this.liveSource === "simulator",
        },
      });
      const analysis = await this.analyzeInWorker(session);
      if (generation !== this.liveGeneration) {
        return;
      }
      session.mission.outcome = analysis.incidents.some(
        ({ detectorId }) => detectorId === "safe-stop",
      )
        ? "safe-stop"
        : snapshot.criticalEver ||
            analysis.incidents.some(({ severity }) => severity === "critical")
          ? "degraded"
          : session.mission.outcome;
      session.provenance.sha256 = fingerprintReplaySessionContent(session);
      await this.loadSession(session, {
        analysis,
        setPristine: true,
        catalogIdentity: null,
        announce: "Live run ready",
      });
      if (generation === this.liveGeneration && this.session === session) {
        this.retryableLiveSnapshot = null;
        const dialog = byId<HTMLDialogElement>("live-dialog");
        if (dialog.open) {
          dialog.close();
        }
      } else if (generation === this.liveGeneration) {
        throw new Error("Live capture analysis was superseded before it could be committed");
      }
    } catch {
      if (generation === this.liveGeneration) {
        this.retryableLiveSnapshot = snapshot;
        this.renderLiveError("Capture retained in memory. Retry the analysis.");
        setText("connection-state-label", "Analysis retry available");
        byId<HTMLButtonElement>("live-connect").textContent = "Retry capture analysis";
      }
    }
  }

  private disconnectLive(invalidate = true): void {
    if (invalidate) {
      this.liveGeneration += 1;
    }
    this.liveUnsubscribe?.();
    this.liveUnsubscribe = null;
    this.liveTransport?.disconnect();
    this.liveTransport = null;
    this.liveDeliveredSamples = 0;
    this.livePendingSamples = 0;
    const status = document.querySelector<HTMLElement>("#connection-status");
    if (status !== null) {
      status.dataset.state = "disconnected";
      byId("connection-dot").dataset.state = "disconnected";
      setText("connection-state-label", "Disconnected");
      setText("connection-state-detail", "No samples received");
      setText("connection-buffer", "0 / 50,000");
    }
    const button = document.querySelector<HTMLButtonElement>("#live-connect");
    if (button !== null) {
      const source =
        document.querySelector<HTMLInputElement>('input[name="live-source"]:checked')?.value ??
        "simulator";
      button.textContent = source === "websocket" ? "Connect WebSocket" : "Start simulator";
      if (invalidate) {
        button.disabled = false;
      }
    }
  }

  private bindExport(): void {
    const button = byId<HTMLButtonElement>("export-button");
    const panel = byId("export-panel");
    button.addEventListener("click", () => {
      panel.hidden = !panel.hidden;
      button.setAttribute("aria-expanded", String(!panel.hidden));
      if (!panel.hidden) {
        panel.querySelector<HTMLButtonElement>("button")?.focus();
      }
    });
    for (const [id, format] of [
      ["export-json", "json"],
      ["export-markdown", "markdown"],
      ["export-print", "html"],
    ] as const) {
      byId(id).addEventListener("click", () => {
        void this.exportReport(format).catch((error: unknown) => {
          this.showToast(
            error instanceof Error ? error.message : "Unable to create the incident report",
            "error",
          );
        });
      });
    }
    document.addEventListener("pointerdown", (event) => {
      if (
        !panel.hidden &&
        !panel.contains(event.target as Node) &&
        !button.contains(event.target as Node)
      ) {
        panel.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
    document.addEventListener("focusin", (event) => {
      if (
        !panel.hidden &&
        !panel.contains(event.target as Node) &&
        !button.contains(event.target as Node)
      ) {
        panel.hidden = true;
        button.setAttribute("aria-expanded", "false");
      }
    });
  }

  private async exportReport(format: "json" | "markdown" | "html"): Promise<void> {
    if (this.loadGeneration !== this.committedLoadGeneration || this.missionLoadPromise !== null) {
      this.showToast("Finish loading the active mission before exporting", "error");
      return;
    }
    const exportGeneration = this.committedLoadGeneration;
    const selectedTimestamp = this.currentTimestamp;
    const session = cloneReplaySession(this.session);
    const analysis = this.analysis;
    const prepared = this.prepared;
    const effectiveDetectors = cloneDetectorConfiguration(this.effectiveDetectors());
    const exportStillCurrent = (): boolean =>
      exportGeneration === this.loadGeneration && exportGeneration === this.committedLoadGeneration;
    const reportModule = await import("./reports");
    if (!exportStillCurrent()) {
      this.showToast("Export cancelled because the active session changed", "error");
      return;
    }
    let comparisonAnalysis: SessionAnalysis | null = null;
    if (session.runs.baseline !== undefined) {
      const comparisonSession = cloneReplaySession(session);
      const comparisonRun = comparisonSession.runs.baseline;
      if (comparisonRun !== undefined) {
        comparisonSession.runs.candidate = { ...comparisonRun, role: "candidate" };
        delete comparisonSession.runs.baseline;
        comparisonAnalysis = await this.analyzeInWorker(comparisonSession);
      }
      if (!exportStillCurrent()) {
        this.showToast("Export cancelled because the active session changed", "error");
        return;
      }
    }
    const incidents = analysis.incidents;
    const reportAnalyses: Array<{ analysis: SessionAnalysis; runId: string }> = [
      { analysis, runId: prepared.candidate.id },
      ...(comparisonAnalysis === null || prepared.baseline === null
        ? []
        : [{ analysis: comparisonAnalysis, runId: prepared.baseline.id }]),
    ];
    const incidentById = new Map(
      reportAnalyses.flatMap(({ analysis }) =>
        analysis.incidents.map((incident) => [incident.id, incident] as const),
      ),
    );
    const evidenceRanges = reportAnalyses.flatMap(({ analysis, runId }) =>
      analysis.incidents.map((incident) => ({
        id: `range-${runId}-${incident.id}`,
        label: incident.title,
        startTimestamp: incident.timestamp,
        endTimestamp: incident.endTimestamp,
        runId,
        anomalyId: incident.id,
        startSampleIndex: incident.evidence.sampleRange[0],
        endSampleIndex: incident.evidence.sampleRange[1],
        supportingSampleCount: incident.evidence.supportingSampleIndices.length,
        observed: incident.evidence.observed,
        threshold: incident.evidence.threshold,
        baseline: incident.evidence.baselineDelta,
        unit: incident.evidence.unit,
      })),
    );
    const evidenceChain = reportAnalyses.flatMap(({ analysis, runId }, analysisIndex) =>
      analysis.evidenceChains.flatMap((chain, chainIndex) =>
        chain.steps.map((step, index, steps) => {
          const incident = incidentById.get(step.incidentId);
          const entryId = `chain-${analysisIndex}-${chainIndex}-${step.incidentId}`;
          return {
            id: entryId,
            label: incident?.title ?? step.incidentId,
            timestamp: incident?.timestamp ?? 0,
            ...(incident === undefined ? {} : { endTimestamp: incident.endTimestamp }),
            runId,
            anomalyId: step.incidentId,
            kind:
              step.classification === "protective-response"
                ? ("response" as const)
                : ("condition" as const),
            description: step.rationale,
            relationship: "temporal-correlation" as const,
            ...(index === 0
              ? {}
              : {
                  predecessorIds: [
                    `chain-${analysisIndex}-${chainIndex}-${steps[index - 1]?.incidentId ?? "unknown"}`,
                  ],
                }),
            evidenceRangeIds: [`range-${runId}-${step.incidentId}`],
          };
        }),
      ),
    );
    const metricDelta = (value: number | null, baseline: number | null): number | null =>
      value === null || baseline === null || !Number.isFinite(value) || !Number.isFinite(baseline)
        ? null
        : value - baseline;
    const report = reportModule.createIncidentReport({
      run: {
        ...prepared.candidate,
        kind: incidents.length > 0 ? "faulty" : prepared.candidate.kind,
      },
      anomalies: incidents.map(asLegacyAnomaly),
      ...(prepared.baseline === null
        ? {}
        : {
            comparisonRun: {
              ...prepared.baseline,
              kind:
                (comparisonAnalysis?.incidents.length ?? 0) > 0
                  ? ("faulty" as const)
                  : prepared.baseline.kind,
            },
            comparisonAnomalies: (comparisonAnalysis?.incidents ?? []).map(asLegacyAnomaly),
          }),
      title: `${session.mission.id} · ${session.mission.title}`,
      selectedTimestamp,
      detectorConfigurations: Object.values(effectiveDetectors.rules).map((rule) => {
        const configuredRule = session.detectors.rules[rule.id];
        const availability = reportAnalyses.map(({ runId }) => {
          const run =
            runId === session.runs.candidate.id
              ? session.runs.candidate
              : session.runs.baseline?.id === runId
                ? session.runs.baseline
                : undefined;
          const reason =
            run === undefined
              ? "The report run is unavailable in the active session."
              : (resolveDetectorAvailability(rule.id, session, run) ??
                configuredRule.unavailableReason ??
                null);
          return reason === null ? { runId, available: true } : { runId, available: false, reason };
        });
        const timestampThresholds =
          rule.id === "timestamp-gap"
            ? {
                configuredFloor: rule.threshold,
                effectiveCandidateComparator: resolveEffectiveTimestampGapThreshold(
                  session.runs.candidate.samples,
                  rule.threshold,
                  session.runs.candidate.sampleRateHz,
                ),
                ...(session.runs.baseline === undefined
                  ? {}
                  : {
                      effectiveBaselineComparator: resolveEffectiveTimestampGapThreshold(
                        session.runs.baseline.samples,
                        rule.threshold,
                        session.runs.baseline.sampleRateHz,
                      ),
                    }),
              }
            : {};
        return {
          id: rule.id,
          label: rule.label,
          enabled: rule.enabled,
          thresholds: {
            primary: rule.threshold,
            minimumDurationSeconds: rule.minimumDuration,
            unit: detectorUnit(rule.id),
            ...timestampThresholds,
          },
          availability,
          ...(rule.unavailableReason === undefined
            ? {}
            : { unavailableReason: rule.unavailableReason }),
        };
      }),
      evidenceRanges,
      evidenceChain,
      derivedMetrics: [
        {
          id: "max-route-error",
          label: "Maximum route error",
          value: analysis.summary.maxCrossTrackError,
          unit: "m",
          baselineValue: prepared.baselineAnalysis?.summary.maxCrossTrackError ?? null,
          delta: metricDelta(
            analysis.summary.maxCrossTrackError,
            prepared.baselineAnalysis?.summary.maxCrossTrackError ?? null,
          ),
        },
        {
          id: "packet-delivery",
          label: "Packet delivery",
          value: analysis.summary.packetDeliveryPercent,
          unit: "%",
          baselineValue: prepared.baselineAnalysis?.summary.packetDeliveryPercent ?? null,
          delta: metricDelta(
            analysis.summary.packetDeliveryPercent,
            prepared.baselineAnalysis?.summary.packetDeliveryPercent ?? null,
          ),
        },
        {
          id: "peak-current",
          label: "Peak motor current",
          value: analysis.summary.peakCurrent,
          unit: "A",
          baselineValue: prepared.baselineAnalysis?.summary.peakCurrent ?? null,
          delta: metricDelta(
            analysis.summary.peakCurrent,
            prepared.baselineAnalysis?.summary.peakCurrent ?? null,
          ),
        },
        {
          id: "minimum-clearance",
          label: "Minimum obstacle clearance",
          value: Number.isFinite(analysis.summary.minObstacleClearance)
            ? analysis.summary.minObstacleClearance
            : null,
          unit: "m",
          baselineValue:
            prepared.baselineAnalysis === null ||
            !Number.isFinite(prepared.baselineAnalysis.summary.minObstacleClearance)
              ? null
              : prepared.baselineAnalysis.summary.minObstacleClearance,
          delta: metricDelta(
            Number.isFinite(analysis.summary.minObstacleClearance)
              ? analysis.summary.minObstacleClearance
              : null,
            prepared.baselineAnalysis === null ||
              !Number.isFinite(prepared.baselineAnalysis.summary.minObstacleClearance)
              ? null
              : prepared.baselineAnalysis.summary.minObstacleClearance,
          ),
        },
      ],
      annotations: session.annotations.map((annotation) => ({
        id: annotation.id,
        timestamp: annotation.timestamp,
        text: `${annotation.label}: ${annotation.body}`,
        author: annotation.author,
      })),
      transformations: session.transformations.map((transformation) => ({
        id: transformation.id,
        type: transformation.type,
        startTimestamp: transformation.startTimestamp,
        endTimestamp: transformation.endTimestamp,
        label: `${formatStateLabel(transformation.type)} · ${transformation.affectedSamples} samples`,
        parameters: transformation.parameters,
      })),
    });
    reportModule.downloadIncidentReport(report, format);
    byId("export-panel").hidden = true;
    const exportButton = byId<HTMLButtonElement>("export-button");
    exportButton.setAttribute("aria-expanded", "false");
    exportButton.focus();
    this.showToast(
      format === "html"
        ? "Print-ready HTML report downloaded"
        : `${format.toLocaleUpperCase()} incident report downloaded`,
    );
  }

  private showToast(message: string, tone: "success" | "error" = "success"): void {
    const toast = byId("toast");
    setText("toast-text", message);
    toast.dataset.tone = tone;
    toast.classList.add("visible");
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
    }
    this.toastTimer = window.setTimeout(() => {
      toast.classList.remove("visible");
      this.toastTimer = null;
    }, 3_600);
  }

  private dispose(): void {
    if (this.animationFrame !== null) {
      cancelAnimationFrame(this.animationFrame);
    }
    this.loadGeneration += 1;
    this.importGeneration += 1;
    this.importAbort?.abort();
    this.importAbort = null;
    this.releaseImportFileReference();
    this.faultGeneration += 1;
    this.faultAbort?.abort();
    this.faultAbort = null;
    this.missionLoadAbort?.abort();
    this.missionLoadAbort = null;
    this.missionLoadPromise = null;
    this.retryableLiveSnapshot = null;
    this.disconnectLive();
    this.worker?.terminate();
    this.worker = null;
    this.sceneObserver?.disconnect();
    this.scene?.dispose();
    this.fallback?.destroy();
    this.charts.destroy();
    if (this.toastTimer !== null) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
  }
}

export async function startRobotReplayStudio(root: HTMLElement): Promise<void> {
  const studio = new RobotReplayStudio(root);
  studio.start();
}
