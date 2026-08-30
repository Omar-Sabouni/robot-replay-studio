import { createReplaySession } from "./session";
import type {
  PlannedRoute,
  ReplayEnvironment,
  ReplayRunRole,
  ReplaySessionRun,
  ReplaySessionV2,
  SessionTelemetrySample,
} from "./types";

export type ScenarioId = "east-loop-incident" | "wheel-slip-drift" | "steady-route";

export interface ScenarioDescriptor {
  id: ScenarioId;
  name: string;
  outcome: ReplaySessionV2["mission"]["outcome"];
  summary: string;
}

export const SCENARIO_CATALOG: readonly ScenarioDescriptor[] = Object.freeze([
  Object.freeze({
    id: "east-loop-incident",
    name: "East Loop / RPL-042",
    outcome: "safe-stop",
    summary: "Link degradation precedes localization reset, route deviation, and safe-stop.",
  }),
  Object.freeze({
    id: "wheel-slip-drift",
    name: "Wheel-slip / RPL-057",
    outcome: "degraded",
    summary: "Sustained traction loss produces heading drift and a recoverable route excursion.",
  }),
  Object.freeze({
    id: "steady-route",
    name: "Steady route / RPL-061",
    outcome: "nominal",
    summary: "Reference mission with all monitored values inside their operating bands.",
  }),
] as const);

const SAMPLE_RATE_HZ = 20;
const DURATION_SECONDS = 45;
const SAMPLE_COUNT = DURATION_SECONDS * SAMPLE_RATE_HZ + 1;

const EAST_LOOP_ROUTE: PlannedRoute = {
  id: "east-loop",
  name: "Warehouse east loop",
  source: "mission-plan",
  corridorWidth: 0.9,
  closed: false,
  waypoints: [
    { id: "dock", x: -6, y: -3, yaw: Math.PI / 2, label: "Dispatch dock" },
    { id: "north-a", x: -6, y: 3, yaw: 0 },
    { id: "cross-a", x: -1, y: 3, yaw: -Math.PI / 2 },
    { id: "turn-a", x: -1, y: -2, yaw: 0 },
    { id: "cross-b", x: 4, y: -2, yaw: Math.PI / 2 },
    { id: "north-b", x: 4, y: 3, yaw: 0 },
    { id: "cross-c", x: 7, y: 3, yaw: -Math.PI / 2 },
    { id: "inspection", x: 7, y: -3, yaw: -Math.PI / 2, label: "Inspection goal" },
  ],
};

const WAREHOUSE: ReplayEnvironment = {
  name: "Warehouse test cell / Bay 2",
  floorBounds: { minX: -8, maxX: 9, minY: -5, maxY: 5 },
  objects: [
    {
      id: "dock-01",
      label: "Dispatch dock",
      kind: "dock",
      x: -6,
      y: -4.35,
      width: 2,
      depth: 0.7,
      height: 0.25,
    },
    {
      id: "rack-a1",
      label: "Rack A1",
      kind: "rack",
      x: -3.3,
      y: 0.35,
      width: 2.5,
      depth: 1.25,
      height: 2.4,
    },
    {
      id: "rack-a2",
      label: "Rack A2",
      kind: "rack",
      x: 1.35,
      y: -3.6,
      width: 2.9,
      depth: 1.2,
      height: 2.4,
    },
    {
      id: "rack-b1",
      label: "Rack B1",
      kind: "rack",
      x: 1.45,
      y: 0.65,
      width: 2.8,
      depth: 1.15,
      height: 2.4,
    },
    {
      id: "rack-c1",
      label: "Rack C1",
      kind: "rack",
      x: 8.5,
      y: 0.2,
      width: 0.6,
      depth: 1.1,
      height: 2.4,
    },
    {
      id: "goal-01",
      label: "Inspection goal",
      kind: "goal",
      x: 7,
      y: -3.9,
      width: 1.25,
      depth: 0.25,
      height: 0.02,
    },
  ],
};

interface RoutePose {
  x: number;
  y: number;
  yaw: number;
}

function normalizeYaw(yaw: number): number {
  const twoPi = Math.PI * 2;
  return ((((yaw + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

function routeLength(route: PlannedRoute): number {
  let length = 0;
  for (let index = 1; index < route.waypoints.length; index += 1) {
    const from = route.waypoints[index - 1];
    const to = route.waypoints[index];
    if (from !== undefined && to !== undefined) {
      length += Math.hypot(to.x - from.x, to.y - from.y);
    }
  }
  return length;
}

function poseAtDistance(route: PlannedRoute, requestedDistance: number): RoutePose {
  let remaining = Math.max(0, Math.min(routeLength(route), requestedDistance));
  for (let index = 1; index < route.waypoints.length; index += 1) {
    const from = route.waypoints[index - 1];
    const to = route.waypoints[index];
    if (from === undefined || to === undefined) {
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (remaining <= length || index === route.waypoints.length - 1) {
      const amount = length === 0 ? 0 : Math.min(1, remaining / length);
      return {
        x: from.x + dx * amount,
        y: from.y + dy * amount,
        yaw: Math.atan2(dy, dx),
      };
    }
    remaining -= length;
  }
  const fallback = route.waypoints.at(-1) ?? { x: 0, y: 0, yaw: 0 };
  return { x: fallback.x, y: fallback.y, yaw: fallback.yaw ?? 0 };
}

function smoothedRouteYaw(route: PlannedRoute, distance: number): number {
  const halfWindow = 0.5;
  const before = poseAtDistance(route, distance - halfWindow);
  const after = poseAtDistance(route, distance + halfWindow);
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  return dx === 0 && dy === 0 ? poseAtDistance(route, distance).yaw : Math.atan2(dy, dx);
}

function round(value: number, digits = 6): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function nominalMotion(timestamp: number): { distance: number; speed: number; state: string } {
  if (timestamp < 1.5) {
    return { distance: 0, speed: 0, state: "standby" };
  }
  const distance = Math.min(routeLength(EAST_LOOP_ROUTE), (timestamp - 1.5) * 0.84);
  if (distance >= routeLength(EAST_LOOP_ROUTE)) {
    return { distance, speed: 0, state: "inspection" };
  }
  return {
    distance,
    // Quantize transcendental output so fingerprints do not depend on the
    // last implementation-specific bits of Math.sin across browser engines.
    speed: round(0.84 + 0.025 * Math.sin(timestamp * 0.63)),
    state: "tracking",
  };
}

type SampleBuilder = (timestamp: number, sequence: number) => SessionTelemetrySample | null;

function samplesFrom(builder: SampleBuilder): SessionTelemetrySample[] {
  const samples: SessionTelemetrySample[] = [];
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    const timestamp = round(index / SAMPLE_RATE_HZ, 3);
    const sample = builder(timestamp, index);
    if (sample !== null) {
      samples.push(sample);
    }
  }
  return samples;
}

function nominalSample(timestamp: number, sequence: number): SessionTelemetrySample {
  const motion = nominalMotion(timestamp);
  const pose = poseAtDistance(EAST_LOOP_ROUTE, motion.distance);
  return {
    timestamp,
    sequence,
    pose: { x: pose.x, y: pose.y, yaw: normalizeYaw(pose.yaw) },
    speed: motion.speed,
    battery: round(91.5 - timestamp * 0.045, 4),
    current:
      motion.speed === 0
        ? 2.2
        : round(7.6 + motion.speed * 3.1 + 0.35 * Math.sin(timestamp * 1.7), 4),
    state: motion.state,
    latencyMs: round(33 + 4 * Math.sin(timestamp * 0.47), 3),
    poseSigma: round(0.026 + 0.003 * Math.sin(timestamp * 0.31) ** 2, 5),
  };
}

function createRun(
  id: string,
  name: string,
  role: ReplayRunRole,
  samples: SessionTelemetrySample[],
  description: string,
  kind: ReplaySessionRun["kind"] = role === "baseline" ? "normal" : "faulty",
): ReplaySessionRun {
  return { id, name, role, kind, samples, description, sampleRateHz: SAMPLE_RATE_HZ };
}

function baselineRun(id: string): ReplaySessionRun {
  return createRun(
    `${id}-baseline`,
    "Reference run",
    "baseline",
    samplesFrom(nominalSample),
    "Reference telemetry for the same route and map.",
    "normal",
  );
}

function sharedSessionContext() {
  return {
    robot: {
      id: "amr-rpl-04",
      name: "RPL-04",
      model: "48 V differential-drive warehouse AMR",
      drive: "differential" as const,
      footprint: { length: 0.82, width: 0.58, safetyMargin: 0.12 },
      nominalVoltage: 48,
    },
    coordinateFrame: {
      id: "warehouse-map",
      label: "Warehouse Bay 2 map",
      convention: "x-east-y-north" as const,
      linearUnit: "metre" as const,
      angularUnit: "radian" as const,
    },
    environment: WAREHOUSE,
    plannedRoute: EAST_LOOP_ROUTE,
  };
}

/** The primary 45-second incident used by the default replay case. */
export function generateEastLoopScenario(): ReplaySessionV2 {
  const baseline = baselineRun("east-loop");
  const candidateSamples = samplesFrom((timestamp, sequence) => {
    if (timestamp >= 18 && timestamp < 18.65) {
      return null;
    }
    const stoppedTimestamp = Math.min(timestamp, 22.4);
    const motion = nominalMotion(stoppedTimestamp);
    const routePose = poseAtDistance(EAST_LOOP_ROUTE, motion.distance);
    const afterReset = timestamp >= 19.1;
    const offsetX = afterReset ? 1.1 : 0;
    const offsetY = afterReset ? -0.4 : 0;
    const offsetYaw = afterReset ? 0.52 : 0;
    const linkRise = Math.max(0, Math.min(1, (timestamp - 16.8) / 1.25));
    const linkLatency =
      timestamp < 16.8
        ? 38 + 7 * Math.sin(timestamp * 1.2)
        : timestamp < 18
          ? 38 + linkRise * 245 + 7 * Math.sin(timestamp * 1.2)
          : timestamp < 19.1
            ? 283
            : 42 + 241 * Math.exp(-(timestamp - 19.1) / 0.85);
    const isSafeStop = timestamp >= 22.4;
    const state = isSafeStop
      ? "safe-stop"
      : timestamp >= 20.15
        ? "constrained-control"
        : afterReset
          ? "localization-recovery"
          : timestamp >= 16.8
            ? "link-degraded"
            : motion.state;
    const speed = isSafeStop ? 0 : Math.max(0.12, motion.speed * (timestamp >= 20.15 ? 0.63 : 1));
    const loadEpisode = timestamp >= 20.25 && timestamp < 22.4;
    return {
      timestamp,
      sequence,
      pose: {
        x: round(routePose.x + offsetX),
        y: round(routePose.y + offsetY),
        yaw: round(normalizeYaw(routePose.yaw + offsetYaw)),
      },
      speed: round(speed, 5),
      battery: round(91.5 - timestamp * 0.052, 4),
      current: isSafeStop
        ? 4.1
        : loadEpisode
          ? round(19.5 + 3.9 * Math.sin(((timestamp - 20.25) / 2.15) * Math.PI), 4)
          : round(7.8 + speed * 3.2 + 0.4 * Math.sin(timestamp * 1.7), 4),
      state,
      latencyMs: round(linkLatency, 3),
      poseSigma: afterReset ? round(0.21 - Math.min(0.11, (timestamp - 19.1) * 0.015), 4) : 0.031,
    };
  });
  return createReplaySession({
    id: "session-rpl-042-east-loop",
    mission: {
      id: "RPL-042",
      title: "East Loop safety intervention",
      subtitle: "Aisle traverse / east loop",
      site: "Warehouse test cell · Bay 2",
      objective: "Reach the east inspection goal without breaching the rack safety envelope.",
      outcome: "safe-stop",
      scenario: "east-loop-incident",
      tags: ["telemetry", "localization", "controls", "protective-stop"],
    },
    ...sharedSessionContext(),
    candidate: createRun(
      "rpl-042-candidate",
      "Incident run",
      "candidate",
      candidateSamples,
      "Packet loss and localization reset branch captured before a protective stop.",
    ),
    baseline,
    provenance: {
      source: "synthetic",
      label: "Deterministic East Loop incident generator v2",
      importedAt: null,
      deterministic: true,
      notes: ["Synthetic engineering scenario; not field telemetry."],
    },
  });
}

/** A second investigation whose drift develops gradually rather than as a reset. */
export function generateWheelSlipScenario(): ReplaySessionV2 {
  const baseline = baselineRun("wheel-slip");
  const candidate = samplesFrom((timestamp, sequence) => {
    const base = nominalSample(timestamp, sequence);
    const rise = Math.max(0, Math.min(1, (timestamp - 14) / 10));
    const recovery = Math.max(0, Math.min(1, (timestamp - 31) / 8));
    const slip = rise * (1 - recovery);
    const lateral = 0.78 * slip + 0.04 * Math.sin(timestamp * 1.1) * slip;
    const heading = 0.48 * slip;
    const routeYaw = smoothedRouteYaw(EAST_LOOP_ROUTE, nominalMotion(timestamp).distance);
    const normalX = -Math.sin(routeYaw);
    const normalY = Math.cos(routeYaw);
    return {
      ...base,
      pose: {
        x: round(base.pose.x + normalX * lateral),
        y: round(base.pose.y + normalY * lateral),
        yaw: round(normalizeYaw(base.pose.yaw + heading)),
      },
      speed: base.speed === null ? null : round(base.speed * (1 - 0.28 * slip), 4),
      current: round((base.current ?? 0) + 4.6 * slip, 4),
      state: slip > 0.12 ? (recovery > 0 ? "traction-recovery" : "traction-limited") : base.state,
      latencyMs: round(36 + 5 * Math.sin(timestamp * 0.7), 3),
      poseSigma: round(0.03 + 0.065 * slip, 4),
    };
  });
  return createReplaySession({
    id: "session-rpl-057-wheel-slip",
    mission: {
      id: "RPL-057",
      title: "Wheel-slip heading drift",
      subtitle: "Loaded aisle / east loop",
      site: "Warehouse test cell · Bay 2",
      objective: "Quantify lateral tracking performance under a controlled traction reduction.",
      outcome: "degraded",
      scenario: "wheel-slip-drift",
      tags: ["controls", "odometry", "pose-estimation", "traction"],
    },
    ...sharedSessionContext(),
    candidate: createRun(
      "rpl-057-candidate",
      "Wheel-slip run",
      "candidate",
      candidate,
      "Gradual lateral and heading drift followed by controller recovery.",
    ),
    baseline,
    provenance: {
      source: "synthetic",
      label: "Deterministic wheel-slip scenario generator v2",
      importedAt: null,
      deterministic: true,
      notes: ["Synthetic engineering scenario; not field telemetry."],
    },
  });
}

/** A clean mission with no detector crossings. */
export function generateNominalScenario(): ReplaySessionV2 {
  const baseline = baselineRun("nominal");
  const candidate = samplesFrom((timestamp, sequence) => {
    const base = nominalSample(timestamp, sequence);
    const lateral = 0.018 * Math.sin(timestamp * 0.55);
    return {
      ...base,
      pose: {
        x: round(base.pose.x - Math.sin(base.pose.yaw) * lateral),
        y: round(base.pose.y + Math.cos(base.pose.yaw) * lateral),
        yaw: round(normalizeYaw(base.pose.yaw + 0.012 * Math.sin(timestamp * 0.4))),
      },
      current: base.current === null ? null : round(base.current + 0.15 * Math.sin(timestamp), 4),
    };
  });
  return createReplaySession({
    id: "session-rpl-061-nominal",
    mission: {
      id: "RPL-061",
      title: "Steady route",
      subtitle: "Post-maintenance run / east loop",
      site: "Warehouse test cell · Bay 2",
      objective: "Review tracking, link, power, and clearance margins after maintenance.",
      outcome: "nominal",
      scenario: "steady-route",
      tags: ["maintenance", "reference", "controls", "telemetry"],
    },
    ...sharedSessionContext(),
    candidate: createRun(
      "rpl-061-candidate",
      "Steady route",
      "candidate",
      candidate,
      "Monitored values remain inside their configured operating bands.",
      "normal",
    ),
    baseline,
    provenance: {
      source: "synthetic",
      label: "Deterministic nominal scenario generator v2",
      importedAt: null,
      deterministic: true,
      notes: ["Synthetic engineering scenario; not field telemetry."],
    },
  });
}

export function generateScenario(id: ScenarioId): ReplaySessionV2 {
  switch (id) {
    case "east-loop-incident":
      return generateEastLoopScenario();
    case "wheel-slip-drift":
      return generateWheelSlipScenario();
    case "steady-route":
      return generateNominalScenario();
    default:
      throw new RangeError(`Unknown scenario ID: ${String(id)}`);
  }
}

/** Fresh sessions on every call, so UI edits cannot mutate catalog templates. */
export function generateScenarioCatalog(): ReplaySessionV2[] {
  return SCENARIO_CATALOG.map(({ id }) => generateScenario(id));
}

export function listScenarioDescriptors(): ScenarioDescriptor[] {
  return SCENARIO_CATALOG.map((descriptor) => ({ ...descriptor }));
}
