import type { TelemetryRun, TelemetrySample, TimestampGap } from "./core/types";
import type { SceneDock, SceneFloorBounds, SceneMarker, SceneObstacle, ScenePoint } from "./scene";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const VIEW_WIDTH = 1_000;
const VIEW_HEIGHT = 560;
const PADDING = 58;
const MAX_FALLBACK_PATH_POINTS = 4_000;

interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

interface TelemetryPathPoint {
  sample: TelemetrySample;
  move: boolean;
}

export interface SpatialFallbackOptions {
  candidate: TelemetryRun;
  baseline: TelemetryRun;
  candidateGaps?: readonly TimestampGap[];
  /** Defaults to the baseline path when omitted. */
  plannedRoute?: readonly ScenePoint[];
  plannedRouteClosed?: boolean;
  floorBounds?: SceneFloorBounds;
  safetyCorridorWidth?: number;
  obstacles?: readonly SceneObstacle[];
  racks?: readonly SceneObstacle[];
  dock?: SceneDock | null;
  goal?: ScenePoint | null;
  selectedIncident?: SceneMarker | null;
  label?: string;
  candidateOnlyLabel?: string;
}

function svgElement<K extends keyof SVGElementTagNameMap>(
  name: K,
  attributes: Readonly<Record<string, string | number>> = {},
): SVGElementTagNameMap[K] {
  const element = document.createElementNS(SVG_NAMESPACE, name);
  for (const [attribute, value] of Object.entries(attributes)) {
    element.setAttribute(attribute, String(value));
  }
  return element;
}

function boundsFor(
  runs: readonly TelemetryRun[],
  points: readonly ScenePoint[] = [],
  obstacles: readonly SceneObstacle[] = [],
  floorBounds?: SceneFloorBounds,
): Bounds {
  let minX = floorBounds?.minX ?? Number.POSITIVE_INFINITY;
  let maxX = floorBounds?.maxX ?? Number.NEGATIVE_INFINITY;
  let minY = floorBounds?.minY ?? Number.POSITIVE_INFINITY;
  let maxY = floorBounds?.maxY ?? Number.NEGATIVE_INFINITY;
  for (const run of runs) {
    for (const sample of run.samples) {
      minX = Math.min(minX, sample.pose.x);
      maxX = Math.max(maxX, sample.pose.x);
      minY = Math.min(minY, sample.pose.y);
      maxY = Math.max(maxY, sample.pose.y);
    }
  }
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  for (const obstacle of obstacles) {
    const radius = Math.hypot(obstacle.width, obstacle.depth) / 2;
    minX = Math.min(minX, obstacle.x - radius);
    maxX = Math.max(maxX, obstacle.x + radius);
    minY = Math.min(minY, obstacle.y - radius);
    maxY = Math.max(maxY, obstacle.y + radius);
  }
  if (![minX, maxX, minY, maxY].every(Number.isFinite)) {
    return { minX: -1, maxX: 1, minY: -1, maxY: 1 };
  }
  if (maxX === minX) {
    minX -= 1;
    maxX += 1;
  }
  if (maxY === minY) {
    minY -= 1;
    maxY += 1;
  }
  return { minX, maxX, minY, maxY };
}

function scaleFactor(bounds: Bounds): number {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const availableWidth = VIEW_WIDTH - PADDING * 2;
  const availableHeight = VIEW_HEIGHT - PADDING * 2;
  return Math.min(availableWidth / spanX, availableHeight / spanY);
}

function scalePoint(point: ScenePoint, bounds: Bounds): { x: number; y: number } {
  const spanX = bounds.maxX - bounds.minX;
  const spanY = bounds.maxY - bounds.minY;
  const scale = scaleFactor(bounds);
  const contentWidth = spanX * scale;
  const contentHeight = spanY * scale;
  return {
    x: (VIEW_WIDTH - contentWidth) / 2 + (point.x - bounds.minX) * scale,
    y: (VIEW_HEIGHT + contentHeight) / 2 - (point.y - bounds.minY) * scale,
  };
}

function scalePose(sample: TelemetrySample, bounds: Bounds): { x: number; y: number } {
  return scalePoint(sample.pose, bounds);
}

function representativeIndices(
  length: number,
  limit: number,
  requiredIndices: readonly number[] = [],
): number[] {
  if (length <= 0 || limit <= 0) {
    return [];
  }
  if (length <= limit) {
    return Array.from({ length }, (_, index) => index);
  }

  const prioritizedRequired = [...new Set([0, length - 1, ...requiredIndices])].filter(
    (index) => index >= 0 && index < length,
  );
  if (prioritizedRequired.length >= limit) {
    return prioritizedRequired.slice(0, limit).sort((left, right) => left - right);
  }

  const required = prioritizedRequired.sort((left, right) => left - right);
  const selected = new Set(required);
  const remaining = limit - selected.size;
  for (let slot = 1; slot <= remaining; slot += 1) {
    selected.add(Math.round((slot * (length - 1)) / (remaining + 1)));
  }
  return [...selected].sort((left, right) => left - right);
}

function representativePoints<T>(points: readonly T[], limit: number): T[] {
  return representativeIndices(points.length, limit).map((index) => points[index] as T);
}

function validateFloorBounds(bounds: SceneFloorBounds): void {
  if (
    !Number.isFinite(bounds.minX) ||
    !Number.isFinite(bounds.maxX) ||
    !Number.isFinite(bounds.minY) ||
    !Number.isFinite(bounds.maxY) ||
    bounds.maxX <= bounds.minX ||
    bounds.maxY <= bounds.minY
  ) {
    throw new RangeError("floorBounds must have finite positive width and depth");
  }
}

function representativeRoute(
  points: readonly ScenePoint[],
  closed: boolean,
): readonly ScenePoint[] {
  const first = points[0];
  const last = points.at(-1);
  const needsClosingPoint =
    closed &&
    points.length >= 3 &&
    first !== undefined &&
    last !== undefined &&
    (first.x !== last.x || first.y !== last.y);
  const representative = representativePoints(
    points,
    needsClosingPoint ? MAX_FALLBACK_PATH_POINTS - 1 : MAX_FALLBACK_PATH_POINTS,
  );
  return needsClosingPoint && first !== undefined ? [...representative, first] : representative;
}

function gapBreakIndices(
  samples: readonly TelemetrySample[],
  gaps: readonly TimestampGap[] = [],
): number[] {
  const boundaryLookup = new Map<number, Set<number>>();
  for (const gap of gaps) {
    const endTimestamps = boundaryLookup.get(gap.startTimestamp) ?? new Set<number>();
    endTimestamps.add(gap.endTimestamp);
    boundaryLookup.set(gap.startTimestamp, endTimestamps);
  }

  const breakIndices: number[] = [];
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1] as TelemetrySample;
    const current = samples[index] as TelemetrySample;
    if (boundaryLookup.get(previous.timestamp)?.has(current.timestamp) === true) {
      breakIndices.push(index);
    }
  }
  return breakIndices;
}

function representativeTelemetryPath(
  samples: readonly TelemetrySample[],
  gaps: readonly TimestampGap[] = [],
): TelemetryPathPoint[] {
  const breakIndices = gapBreakIndices(samples, gaps);
  const requiredIndices = [...breakIndices, ...breakIndices.map((index) => index - 1)];
  const selectedIndices = representativeIndices(
    samples.length,
    MAX_FALLBACK_PATH_POINTS,
    requiredIndices,
  );

  let previousIndex = -1;
  let nextBreak = 0;
  return selectedIndices.map((index) => {
    while ((breakIndices[nextBreak] ?? Number.POSITIVE_INFINITY) <= previousIndex) {
      nextBreak += 1;
    }
    const move =
      previousIndex < 0 || (breakIndices[nextBreak] ?? Number.POSITIVE_INFINITY) <= index;
    previousIndex = index;
    return { sample: samples[index] as TelemetrySample, move };
  });
}

function pathFor(points: readonly TelemetryPathPoint[], bounds: Bounds): string {
  let path = "";
  for (const { sample, move } of points) {
    const point = scalePose(sample, bounds);
    const command = move ? "M" : "L";
    path += `${command}${point.x.toFixed(2)},${point.y.toFixed(2)}`;
  }
  return path;
}

function pathForPoints(points: readonly ScenePoint[], bounds: Bounds): string {
  return points
    .map((point, index) => {
      const scaled = scalePoint(point, bounds);
      return `${index === 0 ? "M" : "L"}${scaled.x.toFixed(2)},${scaled.y.toFixed(2)}`;
    })
    .join("");
}

function defaultObstaclesFor(bounds: Bounds): SceneObstacle[] {
  const spanX = Math.max(bounds.maxX - bounds.minX, 3);
  const spanY = Math.max(bounds.maxY - bounds.minY, 2);
  const rackWidth = Math.max(0.9, spanX * 0.18);
  const rackDepth = Math.max(0.38, Math.min(0.8, spanY * 0.22));
  const top = bounds.maxY + Math.max(0.65, spanY * 0.28);
  const bottom = bounds.minY - Math.max(0.65, spanY * 0.28);
  return [0.2, 0.5, 0.8].flatMap((ratio, index) => {
    const x = bounds.minX + spanX * ratio;
    return [
      {
        id: `fallback-rack-top-${index}`,
        kind: "rack" as const,
        x,
        y: top,
        width: rackWidth,
        depth: rackDepth,
      },
      {
        id: `fallback-rack-bottom-${index}`,
        kind: "rack" as const,
        x,
        y: bottom,
        width: rackWidth,
        depth: rackDepth,
      },
    ];
  });
}

function obstaclePolygon(obstacle: SceneObstacle, bounds: Bounds): string {
  const yaw = obstacle.yaw ?? 0;
  const cosine = Math.cos(yaw);
  const sine = Math.sin(yaw);
  const corners = [
    [-obstacle.width / 2, -obstacle.depth / 2],
    [obstacle.width / 2, -obstacle.depth / 2],
    [obstacle.width / 2, obstacle.depth / 2],
    [-obstacle.width / 2, obstacle.depth / 2],
  ] as const;
  return corners
    .map(([localX, localY]) => {
      const point = scalePoint(
        {
          x: obstacle.x + localX * cosine - localY * sine,
          y: obstacle.y + localX * sine + localY * cosine,
        },
        bounds,
      );
      return `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
    })
    .join(" ");
}

/** Lightweight top-down replay used while Three.js loads and when WebGL is unavailable. */
export class SpatialFallbackView {
  readonly element: HTMLElement;

  private readonly bounds: Bounds;
  private readonly candidatePoint: SVGCircleElement;
  private readonly baselinePoint: SVGCircleElement;
  private readonly candidateHeading: SVGLineElement;
  private readonly baselineHeading: SVGLineElement;
  private readonly status: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly description: SVGDescElement;
  private readonly selectedIncidentGroup: SVGGElement;
  private readonly selectedIncidentLabel: SVGTextElement;
  private readonly comparisonLabel: string;
  private readonly candidateOnlyLabel: string;
  private comparisonVisible = true;
  private selectedIncidentName: string | null = null;

  constructor(container: HTMLElement, options: SpatialFallbackOptions) {
    const plannedRoute =
      options.plannedRoute ?? options.baseline.samples.map((sample) => sample.pose);
    if (options.floorBounds !== undefined) {
      validateFloorBounds(options.floorBounds);
    }
    const dock =
      options.dock === undefined
        ? options.baseline.samples[0] === undefined
          ? null
          : {
              x: options.baseline.samples[0].pose.x,
              y: options.baseline.samples[0].pose.y,
              width: 0.95,
              depth: 1.15,
              label: "DOCK",
            }
        : options.dock;
    const goal =
      options.goal === undefined
        ? (options.candidate.samples.at(-1)?.pose ?? options.baseline.samples.at(-1)?.pose ?? null)
        : options.goal;
    for (const [index, point] of plannedRoute.entries()) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new RangeError(`plannedRoute[${index}] coordinates must be finite`);
      }
    }
    const plannedRoutePath = representativeRoute(plannedRoute, options.plannedRouteClosed ?? false);
    const extraPoints = [
      ...plannedRoutePath,
      ...(dock === null ? [] : [dock]),
      ...(goal === null ? [] : [goal]),
      ...(options.selectedIncident === null || options.selectedIncident === undefined
        ? []
        : [options.selectedIncident]),
    ];
    for (const [index, point] of extraPoints.entries()) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        throw new RangeError(`map point ${index} coordinates must be finite`);
      }
    }
    const replayBounds = boundsFor(
      [options.candidate, options.baseline],
      extraPoints,
      [],
      options.floorBounds,
    );
    const hasObstacleInput = options.obstacles !== undefined || options.racks !== undefined;
    const obstacles = hasObstacleInput
      ? [...(options.racks ?? []), ...(options.obstacles ?? [])]
      : defaultObstaclesFor(replayBounds);
    for (const [index, obstacle] of obstacles.entries()) {
      if (
        !Number.isFinite(obstacle.x) ||
        !Number.isFinite(obstacle.y) ||
        !Number.isFinite(obstacle.width) ||
        !Number.isFinite(obstacle.depth) ||
        obstacle.width <= 0 ||
        obstacle.depth <= 0
      ) {
        throw new RangeError(`obstacles[${index}] must have finite positive geometry`);
      }
    }
    this.bounds = boundsFor(
      [options.candidate, options.baseline],
      extraPoints,
      obstacles,
      options.floorBounds,
    );
    const baselinePathPoints = representativeTelemetryPath(options.baseline.samples);
    const candidatePathPoints = representativeTelemetryPath(
      options.candidate.samples,
      options.candidateGaps,
    );
    this.comparisonLabel =
      options.label ?? "Top-down robot replay comparing the fault candidate and nominal baseline";
    this.candidateOnlyLabel =
      options.candidateOnlyLabel ?? "Top-down robot replay showing the fault candidate";
    this.element = document.createElement("div");
    this.element.className = "spatial-fallback";
    this.element.dataset.comparison = "true";

    this.svg = svgElement("svg", {
      viewBox: `0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`,
      role: "img",
      "aria-label": this.comparisonLabel,
      preserveAspectRatio: "xMidYMid meet",
    });
    const title = svgElement("title");
    title.textContent = "Top-down robot replay fallback";
    this.description = svgElement("desc");
    this.description.textContent =
      "Warehouse plan with a safety corridor, planned route, obstacles, solid vermilion candidate path, and subdued dashed nominal baseline.";
    this.svg.append(title, this.description);

    const renderedFloorBounds = options.floorBounds ?? this.bounds;
    const floorCorners = [
      { x: renderedFloorBounds.minX, y: renderedFloorBounds.minY },
      { x: renderedFloorBounds.maxX, y: renderedFloorBounds.minY },
      { x: renderedFloorBounds.maxX, y: renderedFloorBounds.maxY },
      { x: renderedFloorBounds.minX, y: renderedFloorBounds.maxY },
    ].map((point) => scalePoint(point, this.bounds));
    const floorLayer = svgElement("polygon", {
      points: floorCorners.map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`).join(" "),
      fill: "#232b32",
      stroke: "#52636c",
      "stroke-width": 2,
      "vector-effect": "non-scaling-stroke",
      "aria-hidden": "true",
    });
    const floorTopLeft = scalePoint(
      { x: renderedFloorBounds.minX, y: renderedFloorBounds.maxY },
      this.bounds,
    );
    const floorBottomRight = scalePoint(
      { x: renderedFloorBounds.maxX, y: renderedFloorBounds.minY },
      this.bounds,
    );
    const grid = svgElement("g", { class: "fallback-grid", "aria-hidden": "true" });
    for (let index = 0; index <= 10; index += 1) {
      const progress = index / 10;
      const x = floorTopLeft.x + (floorBottomRight.x - floorTopLeft.x) * progress;
      const y = floorTopLeft.y + (floorBottomRight.y - floorTopLeft.y) * progress;
      grid.append(
        svgElement("line", {
          x1: x,
          y1: floorTopLeft.y,
          x2: x,
          y2: floorBottomRight.y,
        }),
        svgElement("line", {
          x1: floorTopLeft.x,
          y1: y,
          x2: floorBottomRight.x,
          y2: y,
        }),
      );
    }

    const corridorWidth = options.safetyCorridorWidth ?? 1.6;
    if (!Number.isFinite(corridorWidth) || corridorWidth <= 0) {
      throw new RangeError("safetyCorridorWidth must be a finite positive number");
    }
    const routePathData = pathForPoints(plannedRoutePath, this.bounds);
    const corridor = svgElement("path", {
      d: routePathData,
      fill: "none",
      stroke: "#34414c",
      "stroke-width": corridorWidth * scaleFactor(this.bounds),
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      opacity: 0.16,
      "aria-hidden": "true",
    });
    const plannedPath = svgElement("path", {
      d: routePathData,
      fill: "none",
      stroke: "#55a9d6",
      "stroke-width": 2.5,
      "stroke-dasharray": "7 6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "vector-effect": "non-scaling-stroke",
      opacity: 0.9,
      "aria-hidden": "true",
    });

    const obstacleLayer = svgElement("g", {
      class: "fallback-obstacles",
      "aria-hidden": "true",
    });
    for (const obstacle of obstacles) {
      const kind = obstacle.kind ?? "rack";
      const polygon = svgElement("polygon", {
        points: obstaclePolygon(obstacle, this.bounds),
        fill:
          kind === "hazard"
            ? "#6b4700"
            : kind === "pallet"
              ? "#59666d"
              : kind === "wall"
                ? "#344650"
                : "#26343c",
        stroke: kind === "hazard" ? "#f2a900" : "#6e7b82",
        "stroke-width": 2,
        "vector-effect": "non-scaling-stroke",
      });
      obstacleLayer.append(polygon);
      if (kind === "rack") {
        const yaw = obstacle.yaw ?? 0;
        const cosine = Math.cos(yaw);
        const sine = Math.sin(yaw);
        for (const offset of [-0.45, 0, 0.45]) {
          const localY = offset * obstacle.depth;
          const from = scalePoint(
            {
              x: obstacle.x - obstacle.width * 0.41 * cosine - localY * sine,
              y: obstacle.y - obstacle.width * 0.41 * sine + localY * cosine,
            },
            this.bounds,
          );
          const to = scalePoint(
            {
              x: obstacle.x + obstacle.width * 0.41 * cosine - localY * sine,
              y: obstacle.y + obstacle.width * 0.41 * sine + localY * cosine,
            },
            this.bounds,
          );
          obstacleLayer.append(
            svgElement("line", {
              x1: from.x,
              y1: from.y,
              x2: to.x,
              y2: to.y,
              stroke: "#52636c",
              "stroke-width": 1,
              "vector-effect": "non-scaling-stroke",
            }),
          );
        }
      }
    }

    const dockLayer = svgElement("g", { "aria-hidden": "true" });
    if (dock !== null) {
      const dockObstacle: SceneObstacle = {
        ...dock,
        width: dock.width ?? 1.1,
        depth: dock.depth ?? 1.3,
        kind: "hazard",
      };
      dockLayer.append(
        svgElement("polygon", {
          points: obstaclePolygon(dockObstacle, this.bounds),
          fill: "#26343c",
          stroke: "#f2a900",
          "stroke-width": 3,
          "stroke-dasharray": "8 5",
          "vector-effect": "non-scaling-stroke",
        }),
      );
      const position = scalePoint(dock, this.bounds);
      const label = svgElement("text", {
        x: position.x,
        y: position.y + 4,
        fill: "#f2a900",
        "font-size": 13,
        "font-family": "system-ui, Arial, sans-serif",
        "font-weight": 700,
        "text-anchor": "middle",
      });
      label.textContent = dock.label ?? "DOCK";
      dockLayer.append(label);
    }

    const goalLayer = svgElement("g", { "aria-hidden": "true" });
    if (goal !== null) {
      const position = scalePoint(goal, this.bounds);
      goalLayer.append(
        svgElement("circle", {
          cx: position.x,
          cy: position.y,
          r: 15,
          fill: "none",
          stroke: "#ffffff",
          "stroke-width": 3,
          "vector-effect": "non-scaling-stroke",
        }),
        svgElement("circle", {
          cx: position.x,
          cy: position.y,
          r: 5,
          fill: "#f05a1a",
        }),
      );
    }

    const baselinePath = svgElement("path", {
      class: "fallback-path fallback-path--baseline",
      d: pathFor(baselinePathPoints, this.bounds),
    });
    const candidatePath = svgElement("path", {
      class: "fallback-path fallback-path--candidate",
      d: pathFor(candidatePathPoints, this.bounds),
    });
    this.baselinePoint = svgElement("circle", {
      class: "fallback-point fallback-point--baseline",
      r: 9,
    });
    this.candidatePoint = svgElement("circle", {
      class: "fallback-point fallback-point--candidate",
      r: 11,
    });
    this.baselineHeading = svgElement("line", {
      class: "fallback-heading fallback-heading--baseline",
    });
    this.candidateHeading = svgElement("line", {
      class: "fallback-heading fallback-heading--candidate",
    });
    this.selectedIncidentGroup = svgElement("g", {
      "aria-hidden": "true",
      visibility: "hidden",
    });
    this.selectedIncidentGroup.append(
      svgElement("circle", {
        r: 20,
        fill: "none",
        stroke: "#e5483f",
        "stroke-width": 4,
        "vector-effect": "non-scaling-stroke",
      }),
      svgElement("circle", {
        r: 7,
        fill: "#e5483f",
        opacity: 0.92,
      }),
      svgElement("line", {
        x1: 0,
        y1: -22,
        x2: 0,
        y2: -52,
        stroke: "#e5483f",
        "stroke-width": 3,
        "vector-effect": "non-scaling-stroke",
      }),
    );
    this.selectedIncidentLabel = svgElement("text", {
      x: 0,
      y: -60,
      fill: "#ffffff",
      "font-size": 15,
      "font-family": "system-ui, Arial, sans-serif",
      "font-weight": 700,
      "text-anchor": "middle",
      stroke: "#1e252b",
      "stroke-width": 4,
      "paint-order": "stroke",
    });
    this.selectedIncidentGroup.append(this.selectedIncidentLabel);
    this.svg.append(
      floorLayer,
      grid,
      corridor,
      plannedPath,
      obstacleLayer,
      dockLayer,
      goalLayer,
      baselinePath,
      candidatePath,
      this.baselineHeading,
      this.candidateHeading,
      this.baselinePoint,
      this.candidatePoint,
      this.selectedIncidentGroup,
    );

    this.status = document.createElement("div");
    this.status.className = "spatial-fallback__status";
    this.status.setAttribute("role", "status");
    this.status.setAttribute("aria-live", "polite");
    this.status.setAttribute("aria-atomic", "true");
    this.status.innerHTML =
      '<span class="fallback-spinner" aria-hidden="true"></span><span>Loading spatial renderer</span>';
    this.element.append(this.svg, this.status);
    container.append(this.element);
    this.setSelectedIncident(options.selectedIncident ?? null);
  }

  setPose(candidate: TelemetrySample, baseline: TelemetrySample): void {
    this.positionMarker(this.candidatePoint, this.candidateHeading, candidate);
    this.positionMarker(this.baselinePoint, this.baselineHeading, baseline);
  }

  setComparisonVisible(visible: boolean): void {
    this.comparisonVisible = visible;
    this.element.dataset.comparison = String(visible);
    this.svg.setAttribute("aria-label", visible ? this.comparisonLabel : this.candidateOnlyLabel);
    this.updateDescription();
  }

  setSelectedIncident(incident: SceneMarker | null): void {
    if (incident === null) {
      this.selectedIncidentName = null;
      this.selectedIncidentGroup.setAttribute("visibility", "hidden");
      this.element.dataset.incidentSelected = "false";
      this.updateDescription();
      return;
    }
    if (!Number.isFinite(incident.x) || !Number.isFinite(incident.y)) {
      throw new RangeError("selectedIncident coordinates must be finite");
    }
    const position = scalePoint(incident, this.bounds);
    this.selectedIncidentGroup.setAttribute(
      "transform",
      `translate(${position.x.toFixed(2)} ${position.y.toFixed(2)})`,
    );
    this.selectedIncidentGroup.setAttribute("visibility", "visible");
    this.selectedIncidentName = incident.label?.trim() || "Selected incident";
    this.selectedIncidentLabel.textContent = this.selectedIncidentName;
    this.element.dataset.incidentSelected = "true";
    this.updateDescription();
  }

  setLoading(): void {
    this.element.dataset.state = "loading";
    this.status.replaceChildren();
    const spinner = document.createElement("span");
    spinner.className = "fallback-spinner";
    spinner.ariaHidden = "true";
    this.status.append(spinner, document.createTextNode("Loading spatial renderer"));
  }

  setUnavailable(message = "3D rendering unavailable · top-down replay active"): void {
    this.element.dataset.state = "unavailable";
    this.status.textContent = message;
  }

  setHidden(hidden: boolean): void {
    this.element.hidden = hidden;
  }

  destroy(): void {
    this.element.remove();
  }

  private updateDescription(): void {
    const base = this.comparisonVisible
      ? "Warehouse plan with safety corridor, planned route, obstacles, solid vermilion candidate path, and subdued dashed nominal baseline."
      : "Warehouse plan with safety corridor, planned route, obstacles, and solid vermilion fault candidate path.";
    this.description.textContent =
      this.selectedIncidentName === null
        ? base
        : `${base} Selected incident: ${this.selectedIncidentName}.`;
  }

  private positionMarker(
    point: SVGCircleElement,
    heading: SVGLineElement,
    sample: TelemetrySample,
  ): void {
    const position = scalePose(sample, this.bounds);
    const length = 28;
    point.setAttribute("cx", String(position.x));
    point.setAttribute("cy", String(position.y));
    heading.setAttribute("x1", String(position.x));
    heading.setAttribute("y1", String(position.y));
    heading.setAttribute("x2", String(position.x + Math.cos(sample.pose.yaw) * length));
    heading.setAttribute("y2", String(position.y - Math.sin(sample.pose.yaw) * length));
  }
}
