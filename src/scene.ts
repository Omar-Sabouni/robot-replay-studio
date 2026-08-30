import * as THREE from "three";

export type RobotCameraMode = "orbit" | "follow";

export type SceneRenderMode = "continuous" | "manual";

/** Semantic colors and emphasis for one replay layer. */
export interface SceneLayerStyle {
  bodyColor?: THREE.ColorRepresentation;
  panelColor?: THREE.ColorRepresentation;
  accentColor?: THREE.ColorRepresentation;
  trajectoryColor?: THREE.ColorRepresentation;
  pointColor?: THREE.ColorRepresentation;
  robotOpacity?: number;
  trajectoryOpacity?: number;
  dashedTrajectory?: boolean;
  dashSize?: number;
  gapSize?: number;
}

/** A point in telemetry/map coordinates. `y` is mapped to Three.js' ground-plane z axis. */
export interface ScenePoint {
  x: number;
  y: number;
}

/** A replay point can optionally carry cross-track error for deviation colouring. */
export interface SceneTrajectoryPoint extends ScenePoint {
  /** Absolute or signed path deviation in metres. */
  deviation?: number;
  /** Alias accepted by derived-metric pipelines. `deviation` takes precedence. */
  pathError?: number;
}

/**
 * Pose heading is expressed in radians, counter-clockwise from the positive x axis.
 * `yaw` matches the replay telemetry model; `heading` remains a convenient alias.
 */
export type RobotPose = ScenePoint &
  ({ yaw: number; heading?: number } | { heading: number; yaw?: number });

export type SceneMarkerKind = "warning" | "critical" | "state" | "waypoint";

export interface SceneMarker extends ScenePoint {
  id?: string;
  kind?: SceneMarkerKind;
  label?: string;
}

export type SceneObstacleKind = "rack" | "wall" | "pallet" | "hazard";

/** Axis-aligned map obstacle, optionally rotated around its centre. */
export interface SceneObstacle extends ScenePoint {
  id?: string;
  kind?: SceneObstacleKind;
  width: number;
  depth: number;
  height?: number;
  yaw?: number;
  label?: string;
}

export interface SceneAisleMarking {
  points: readonly ScenePoint[];
  width?: number;
  dashed?: boolean;
  color?: THREE.ColorRepresentation;
}

export interface SceneDock extends ScenePoint {
  width?: number;
  depth?: number;
  yaw?: number;
  label?: string;
}

/** Axis-aligned map extent in telemetry coordinates. */
export interface SceneFloorBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Optional map geometry rendered behind the replay layers. */
export interface SceneWarehouseLayout {
  floorBounds?: SceneFloorBounds;
  racks?: readonly SceneObstacle[];
  obstacles?: readonly SceneObstacle[];
  aisleMarkings?: readonly SceneAisleMarking[];
  dock?: SceneDock | null;
  goal?: ScenePoint | null;
  plannedRoute?: readonly ScenePoint[];
  plannedRouteClosed?: boolean;
  safetyCorridorWidth?: number;
}

/** Elliptical 2D pose uncertainty in metres, centred on the primary robot. */
export interface ScenePoseUncertainty {
  radius?: number;
  majorAxis?: number;
  minorAxis?: number;
  yaw?: number;
  confidence?: number;
  visible?: boolean;
}

export interface SceneDeviationScale {
  warningAt?: number;
  criticalAt?: number;
  nominalColor?: THREE.ColorRepresentation;
  warningColor?: THREE.ColorRepresentation;
  criticalColor?: THREE.ColorRepresentation;
}

/** Existing buttons can be connected without coupling the scene to app markup. */
export interface SceneCameraControls {
  zoomIn?: HTMLElement;
  zoomOut?: HTMLElement;
  frame?: HTMLElement;
}

export interface SceneFocusOptions {
  distance?: number;
  durationMs?: number;
  select?: boolean;
}

export interface ComparisonSceneState {
  pose?: RobotPose;
  trajectory?: readonly SceneTrajectoryPoint[];
  visible?: boolean;
}

export interface RobotReplaySceneOptions {
  cameraMode?: RobotCameraMode;
  initialPose?: RobotPose;
  trajectory?: readonly SceneTrajectoryPoint[];
  comparison?: ComparisonSceneState;
  target?: ScenePoint | null;
  markers?: readonly SceneMarker[];
  /** Omit for the default warehouse shell; pass `false` for the legacy open grid. */
  warehouse?: SceneWarehouseLayout | false;
  /** Convenient top-level overrides for session map data. */
  floorBounds?: SceneFloorBounds;
  plannedRoute?: readonly ScenePoint[];
  plannedRouteClosed?: boolean;
  safetyCorridorWidth?: number;
  obstacles?: readonly SceneObstacle[];
  uncertainty?: number | ScenePoseUncertainty | null;
  selectedMarkerId?: string | null;
  deviationScale?: SceneDeviationScale;
  cameraControls?: SceneCameraControls;
  primaryStyle?: SceneLayerStyle;
  comparisonStyle?: SceneLayerStyle;
  accessibleLabel?: string;
  accessibleDescription?: string;
  renderMode?: SceneRenderMode;
  reducedMotion?: boolean;
  maxPixelRatio?: number;
  shadowMapSize?: number;
  onContextLost?: (event: WebGLContextEvent) => void;
  onContextRestored?: (event: Event) => void;
}

interface RobotRig {
  root: THREE.Group;
  wheels: THREE.Group[];
  lidar: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial>;
}

interface PointerDrag {
  pointerId: number;
  x: number;
  y: number;
  panning: boolean;
}

interface PointerPosition {
  x: number;
  y: number;
}

interface TouchGesture {
  centreX: number;
  centreY: number;
  distance: number;
}

interface CameraFocusTransition {
  fromTarget: THREE.Vector3;
  toTarget: THREE.Vector3;
  fromDistance: number;
  toDistance: number;
  elapsed: number;
  duration: number;
}

interface ResolvedDeviationScale {
  warningAt: number;
  criticalAt: number;
  nominalColor: THREE.Color;
  warningColor: THREE.Color;
  criticalColor: THREE.Color;
}

interface ResolvedSceneLayerStyle {
  bodyColor: THREE.ColorRepresentation;
  panelColor: THREE.ColorRepresentation;
  accentColor: THREE.ColorRepresentation;
  accentEmissiveColor: THREE.ColorRepresentation;
  darkColor: THREE.ColorRepresentation;
  robotOpacity: number;
  darkOpacity: number;
  trajectoryColor: THREE.ColorRepresentation;
  pointColor: THREE.ColorRepresentation;
  trajectoryOpacity: number;
  pointOpacity: number;
  dashedTrajectory: boolean;
  dashSize: number;
  gapSize: number;
}

const DEFAULT_POSE: RobotPose = { x: 0, y: 0, yaw: 0 };
const FLOOR_SIZE = 80;
const DEFAULT_FLOOR_BOUNDS: Readonly<SceneFloorBounds> = {
  minX: -FLOOR_SIZE / 2,
  maxX: FLOOR_SIZE / 2,
  minY: -FLOOR_SIZE / 2,
  maxY: FLOOR_SIZE / 2,
};
const ROBOT_GROUND_OFFSET = 0.02;
const MIN_ORBIT_DISTANCE = 2.8;
const MAX_ORBIT_DISTANCE = 42;
const DEFAULT_CORRIDOR_WIDTH = 1.6;
const UP = new THREE.Vector3(0, 1, 0);
const DEFAULT_ACCESSIBLE_LABEL = "Interactive robot replay scene";
const DEFAULT_ACCESSIBLE_DESCRIPTION = [
  "Use arrow keys to rotate the camera.",
  "Hold Shift with the arrow keys to pan.",
  "Use plus and minus to zoom, and Home to frame all visible trajectories.",
  "On touch screens, pinch to zoom and drag with two fingers to pan.",
].join(" ");
const CAMERA_KEY_SHORTCUTS = [
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Shift+ArrowLeft",
  "Shift+ArrowRight",
  "Shift+ArrowUp",
  "Shift+ArrowDown",
  "Plus",
  "Minus",
  "Home",
].join(" ");

const finite = (value: number, label: string): number => {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${label} must be a finite number`);
  }
  return value;
};

const unitInterval = (value: number, label: string): number => {
  finite(value, label);
  if (value < 0 || value > 1) {
    throw new RangeError(`${label} must be between 0 and 1`);
  }
  return value;
};

const positive = (value: number, label: string): number => {
  finite(value, label);
  if (value <= 0) {
    throw new RangeError(`${label} must be greater than 0`);
  }
  return value;
};

const resolveLayerStyle = (
  style: SceneLayerStyle | undefined,
  comparison: boolean,
): ResolvedSceneLayerStyle => {
  const defaultRobotOpacity = comparison ? 0.38 : 1;
  const robotOpacity =
    style?.robotOpacity === undefined
      ? defaultRobotOpacity
      : unitInterval(
          style.robotOpacity,
          `${comparison ? "comparison" : "primary"}Style.robotOpacity`,
        );
  const defaultTrajectoryOpacity = comparison ? 0.82 : 0.96;
  const trajectoryOpacity =
    style?.trajectoryOpacity === undefined
      ? defaultTrajectoryOpacity
      : unitInterval(
          style.trajectoryOpacity,
          `${comparison ? "comparison" : "primary"}Style.trajectoryOpacity`,
        );
  const accentColor = style?.accentColor ?? (comparison ? 0x55a9d6 : 0xb7d600);
  const customRobotOpacity = style?.robotOpacity !== undefined;
  const customTrajectoryOpacity = style?.trajectoryOpacity !== undefined;

  return {
    bodyColor: style?.bodyColor ?? (comparison ? 0x164a68 : 0x536400),
    panelColor: style?.panelColor ?? (comparison ? 0x276b91 : 0x839900),
    accentColor,
    accentEmissiveColor:
      style?.accentColor === undefined ? (comparison ? 0x164a68 : 0x536400) : accentColor,
    darkColor: 0x111820,
    robotOpacity,
    darkOpacity: customRobotOpacity ? robotOpacity : comparison ? 0.28 : 1,
    trajectoryColor: style?.trajectoryColor ?? (comparison ? 0x55a9d6 : 0xb7d600),
    pointColor: style?.pointColor ?? (comparison ? 0x9dd9f5 : 0xd8f52c),
    trajectoryOpacity,
    pointOpacity: customTrajectoryOpacity
      ? Math.min(0.9, trajectoryOpacity * 0.9)
      : comparison
        ? 0.7
        : 0.86,
    dashedTrajectory: style?.dashedTrajectory ?? comparison,
    dashSize:
      style?.dashSize === undefined
        ? 0.22
        : positive(style.dashSize, `${comparison ? "comparison" : "primary"}Style.dashSize`),
    gapSize:
      style?.gapSize === undefined
        ? 0.14
        : positive(style.gapSize, `${comparison ? "comparison" : "primary"}Style.gapSize`),
  };
};

const resolveDeviationScale = (scale: SceneDeviationScale | undefined): ResolvedDeviationScale => {
  const warningAt = positive(scale?.warningAt ?? 0.35, "deviationScale.warningAt");
  const criticalAt = positive(scale?.criticalAt ?? 0.8, "deviationScale.criticalAt");
  if (criticalAt <= warningAt) {
    throw new RangeError("deviationScale.criticalAt must be greater than warningAt");
  }
  return {
    warningAt,
    criticalAt,
    nominalColor: new THREE.Color(scale?.nominalColor ?? 0x55a9d6),
    warningColor: new THREE.Color(scale?.warningColor ?? 0xf2a900),
    criticalColor: new THREE.Color(scale?.criticalColor ?? 0xe5483f),
  };
};

const defaultWarehouseLayout = (): SceneWarehouseLayout => ({
  floorBounds: { minX: -2.5, maxX: 10.8, minY: -5.2, maxY: 5.2 },
  racks: [
    { id: "rack-a1", kind: "rack", x: 1.2, y: -3.45, width: 2.2, depth: 0.82 },
    { id: "rack-a2", kind: "rack", x: 4.3, y: -3.45, width: 2.2, depth: 0.82 },
    { id: "rack-a3", kind: "rack", x: 7.4, y: -3.45, width: 2.2, depth: 0.82 },
    { id: "rack-b1", kind: "rack", x: 1.2, y: 3.45, width: 2.2, depth: 0.82 },
    { id: "rack-b2", kind: "rack", x: 4.3, y: 3.45, width: 2.2, depth: 0.82 },
    { id: "rack-b3", kind: "rack", x: 7.4, y: 3.45, width: 2.2, depth: 0.82 },
  ],
  aisleMarkings: [
    {
      points: [
        { x: -1.4, y: -2.25 },
        { x: 10.2, y: -2.25 },
      ],
      dashed: true,
    },
    {
      points: [
        { x: -1.4, y: 2.25 },
        { x: 10.2, y: 2.25 },
      ],
      dashed: true,
    },
  ],
  dock: { x: -0.75, y: 0, width: 1.3, depth: 1.55, label: "DOCK 04" },
});

const validatePoint = (point: ScenePoint, label: string): void => {
  finite(point.x, `${label}.x`);
  finite(point.y, `${label}.y`);
};

const validateFloorBounds = (bounds: SceneFloorBounds, label = "floorBounds"): void => {
  finite(bounds.minX, `${label}.minX`);
  finite(bounds.maxX, `${label}.maxX`);
  finite(bounds.minY, `${label}.minY`);
  finite(bounds.maxY, `${label}.maxY`);
  if (bounds.maxX <= bounds.minX || bounds.maxY <= bounds.minY) {
    throw new RangeError(`${label} must have positive width and depth`);
  }
};

const closedRoutePoints = (
  points: readonly ScenePoint[],
  closed: boolean,
): readonly ScenePoint[] => {
  const first = points[0];
  const last = points.at(-1);
  if (
    !closed ||
    points.length < 3 ||
    first === undefined ||
    last === undefined ||
    (first.x === last.x && first.y === last.y)
  ) {
    return points;
  }
  return [...points, first];
};

const poseHeading = (pose: RobotPose, label = "pose"): number => {
  const heading = pose.yaw ?? pose.heading;
  if (heading === undefined) {
    throw new RangeError(`${label}.yaw must be a finite number`);
  }
  return finite(heading, `${label}.yaw`);
};

const setMaterialOpacity = (material: THREE.Material | THREE.Material[], opacity: number): void => {
  for (const item of Array.isArray(material) ? material : [material]) {
    item.transparent = true;
    item.opacity = opacity;
    item.depthWrite = opacity >= 1;
  }
};

const disposeMaterial = (material: THREE.Material, textures: Set<THREE.Texture>): void => {
  for (const value of Object.values(material)) {
    if (value instanceof THREE.Texture && !textures.has(value)) {
      textures.add(value);
      value.dispose();
    }
  }
  material.dispose();
};

const disposeObject = (root: THREE.Object3D): void => {
  const geometries = new Set<THREE.BufferGeometry>();
  const materialSet = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  root.traverse((object) => {
    if (
      object instanceof THREE.Mesh ||
      object instanceof THREE.Line ||
      object instanceof THREE.Points
    ) {
      if (!geometries.has(object.geometry)) {
        geometries.add(object.geometry);
        object.geometry.dispose();
      }
      const objectMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of objectMaterials) {
        if (!materialSet.has(material)) {
          materialSet.add(material);
          disposeMaterial(material, textures);
        }
      }
    } else if (object instanceof THREE.Sprite) {
      const spriteMaterials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of spriteMaterials) {
        if (!materialSet.has(material)) {
          materialSet.add(material);
          disposeMaterial(material, textures);
        }
      }
    }
  });
};

const clearGroup = (group: THREE.Group): void => {
  disposeObject(group);
  for (const child of [...group.children]) {
    group.remove(child);
  }
};

const worldPosition = (point: ScenePoint, elevation = 0): THREE.Vector3 =>
  new THREE.Vector3(point.x, elevation, point.y);

const createLabelSprite = (text: string, accent: string): THREE.Sprite => {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");

  if (context !== null) {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "rgba(17, 24, 32, 0.95)";
    context.fillRect(8, 8, 496, 104);
    context.strokeStyle = accent;
    context.lineWidth = 3;
    context.strokeRect(8, 8, 496, 104);
    context.font = "600 42px system-ui, sans-serif";
    context.fillStyle = "#ffffff";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(text.slice(0, 28), 256, 61, 464);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(2.4, 0.6, 1);
  sprite.position.y = 1.24;
  sprite.renderOrder = 20;
  return sprite;
};

const createRobot = (ghost: boolean, style: ResolvedSceneLayerStyle): RobotRig => {
  const root = new THREE.Group();
  root.name = ghost ? "comparison-robot" : "primary-robot";

  const opacity = style.robotOpacity;
  const bodyMaterial = new THREE.MeshStandardMaterial({
    color: style.bodyColor,
    metalness: 0.72,
    roughness: 0.28,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const panelMaterial = new THREE.MeshStandardMaterial({
    color: style.panelColor,
    metalness: 0.58,
    roughness: 0.35,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const accentMaterial = new THREE.MeshStandardMaterial({
    color: style.accentColor,
    emissive: style.accentEmissiveColor,
    emissiveIntensity: ghost ? 0.08 : 0.14,
    metalness: 0.2,
    roughness: 0.3,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  });
  const darkMaterial = new THREE.MeshStandardMaterial({
    color: style.darkColor,
    metalness: 0.42,
    roughness: 0.7,
    transparent: style.darkOpacity < 1,
    opacity: style.darkOpacity,
    depthWrite: style.darkOpacity >= 1,
  });

  const base = new THREE.Mesh(new THREE.BoxGeometry(1.08, 0.22, 0.7), bodyMaterial);
  base.position.y = 0.3;
  base.castShadow = !ghost;
  base.receiveShadow = !ghost;
  root.add(base);

  const lowerDeck = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.5, 0.16, 12), panelMaterial);
  lowerDeck.scale.z = 0.78;
  lowerDeck.position.y = 0.23;
  lowerDeck.castShadow = !ghost;
  root.add(lowerDeck);

  const top = new THREE.Mesh(new THREE.BoxGeometry(0.58, 0.18, 0.48), panelMaterial);
  top.position.set(-0.08, 0.49, 0);
  top.castShadow = !ghost;
  root.add(top);

  const railGeometry = new THREE.BoxGeometry(0.82, 0.045, 0.045);
  for (const z of [-0.347, 0.347]) {
    const rail = new THREE.Mesh(railGeometry, accentMaterial);
    rail.position.set(0.03, 0.41, z);
    root.add(rail);
  }

  const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.13, 0.52), darkMaterial);
  bumper.position.set(0.58, 0.25, 0);
  root.add(bumper);

  const lightGeometry = new THREE.BoxGeometry(0.03, 0.055, 0.12);
  for (const z of [-0.19, 0.19]) {
    const light = new THREE.Mesh(lightGeometry, accentMaterial);
    light.position.set(0.624, 0.34, z);
    root.add(light);
  }

  const wheels: THREE.Group[] = [];
  const wheelGeometry = new THREE.CylinderGeometry(0.2, 0.2, 0.11, 24);
  for (const z of [-0.405, 0.405]) {
    const pivot = new THREE.Group();
    pivot.position.set(-0.03, 0.2, z);
    const tire = new THREE.Mesh(wheelGeometry, darkMaterial);
    tire.rotation.x = Math.PI / 2;
    tire.castShadow = !ghost;
    pivot.add(tire);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.085, 0.085, 0.116, 20), accentMaterial);
    hub.rotation.x = Math.PI / 2;
    pivot.add(hub);
    wheels.push(pivot);
    root.add(pivot);
  }

  const caster = new THREE.Mesh(new THREE.SphereGeometry(0.09, 18, 12), darkMaterial);
  caster.position.set(0.39, 0.1, 0);
  caster.castShadow = !ghost;
  root.add(caster);

  const lidar = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.155, 0.12, 32), accentMaterial);
  lidar.position.set(-0.08, 0.68, 0);
  lidar.castShadow = !ghost;
  root.add(lidar);

  const lidarCap = new THREE.Mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.05, 32), darkMaterial);
  lidarCap.position.set(-0.08, 0.765, 0);
  root.add(lidarCap);

  const direction = new THREE.Mesh(new THREE.ConeGeometry(0.105, 0.32, 3), accentMaterial);
  direction.rotation.z = -Math.PI / 2;
  direction.position.set(0.78, 0.04, 0);
  root.add(direction);

  if (!ghost) {
    const aura = new THREE.Mesh(
      new THREE.RingGeometry(0.72, 0.76, 64),
      new THREE.MeshBasicMaterial({
        color: style.accentColor,
        transparent: true,
        opacity: 0.3,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    aura.rotation.x = -Math.PI / 2;
    aura.position.y = 0.012;
    root.add(aura);
  }

  return { root, wheels, lidar };
};

/**
 * Self-contained Three.js viewport for synthetic 2D mobile-robot replay data.
 * Construct with a container, or construct without one and call `mount` later.
 */
export class RobotReplayScene {
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(43, 1, 0.05, 220);
  private readonly renderer: THREE.WebGLRenderer;
  private readonly primaryRobot: RobotRig;
  private readonly comparisonRobot: RobotRig;
  private readonly primaryStyle: ResolvedSceneLayerStyle;
  private readonly comparisonStyle: ResolvedSceneLayerStyle;
  private readonly trajectoryGroup = new THREE.Group();
  private readonly comparisonTrajectoryGroup = new THREE.Group();
  private readonly markerGroup = new THREE.Group();
  private readonly targetGroup = new THREE.Group();
  private readonly floorGroup = new THREE.Group();
  private readonly warehouseGroup = new THREE.Group();
  private readonly plannedRouteGroup = new THREE.Group();
  private readonly safetyCorridorGroup = new THREE.Group();
  private readonly obstacleGroup = new THREE.Group();
  private readonly uncertaintyGroup = new THREE.Group();
  private readonly selectedIncidentGroup = new THREE.Group();
  private readonly orbitTarget = new THREE.Vector3();
  private readonly followLookTarget = new THREE.Vector3();
  private readonly deviationScale: ResolvedDeviationScale;
  private readonly markerRecords = new Map<string, SceneMarker>();
  private readonly markerGroups = new Map<string, THREE.Group>();
  private readonly activePointers = new Map<number, PointerPosition>();
  private readonly resizeObserver: ResizeObserver | null;
  private readonly maxPixelRatio: number;
  private readonly shadowMapSize: number;
  private readonly onContextLostCallback: ((event: WebGLContextEvent) => void) | undefined;
  private readonly onContextRestoredCallback: ((event: Event) => void) | undefined;
  private container: HTMLElement | null = null;
  private animationFrame: number | null = null;
  private lastFrameTime = 0;
  private disposed = false;
  private contextLostValue = false;
  private renderingEnabledValue = true;
  private renderModeValue: SceneRenderMode;
  private reducedMotionValue: boolean;
  private mode: RobotCameraMode;
  private pose: RobotPose;
  private comparisonPose: RobotPose | null = null;
  private pointerDrag: PointerDrag | null = null;
  private touchGesture: TouchGesture | null = null;
  private cameraFocusTransition: CameraFocusTransition | null = null;
  private cameraControlsCleanup: (() => void) | null = null;
  private selectedMarkerId: string | null = null;
  private selectedBaseMarkerLabel: THREE.Sprite | null = null;
  private uncertainty: ScenePoseUncertainty | null = null;
  private uncertaintyFill: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial> | null = null;
  private uncertaintyEdge: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial> | null = null;
  private primaryTrajectoryPoints: readonly SceneTrajectoryPoint[] = [];
  private comparisonTrajectoryPoints: readonly SceneTrajectoryPoint[] = [];
  private plannedRouteExplicit = false;
  private plannedRouteClosed = false;
  private explicitFloorBounds = false;
  private safetyCorridorWidth = DEFAULT_CORRIDOR_WIDTH;
  private orbitAzimuth = Math.PI / 4;
  private orbitPolar = 0.93;
  private orbitDistance = 12.5;
  private followDistance = 5.6;
  private wheelTravel = 0;

  public constructor(container?: HTMLElement, options: RobotReplaySceneOptions = {}) {
    this.maxPixelRatio = Math.max(0.5, positive(options.maxPixelRatio ?? 1.5, "maxPixelRatio"));
    this.shadowMapSize = Math.round(
      THREE.MathUtils.clamp(positive(options.shadowMapSize ?? 1024, "shadowMapSize"), 256, 4096),
    );
    this.renderModeValue = options.renderMode ?? "continuous";
    if (this.renderModeValue !== "continuous" && this.renderModeValue !== "manual") {
      throw new RangeError('renderMode must be "continuous" or "manual"');
    }
    this.reducedMotionValue = options.reducedMotion ?? false;
    this.primaryStyle = resolveLayerStyle(options.primaryStyle, false);
    this.comparisonStyle = resolveLayerStyle(options.comparisonStyle, true);
    this.deviationScale = resolveDeviationScale(options.deviationScale);
    this.primaryRobot = createRobot(false, this.primaryStyle);
    this.comparisonRobot = createRobot(true, this.comparisonStyle);
    this.onContextLostCallback = options.onContextLost;
    this.onContextRestoredCallback = options.onContextRestored;
    this.mode = options.cameraMode ?? "orbit";
    this.pose = options.initialPose ?? DEFAULT_POSE;
    validatePoint(this.pose, "initialPose");
    poseHeading(this.pose, "initialPose");

    this.scene.background = new THREE.Color(0x070c10);
    this.scene.fog = new THREE.FogExp2(0x070c10, 0.027);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.04;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x070c10, 1);
    this.renderer.domElement.style.display = "block";
    this.renderer.domElement.style.width = "100%";
    this.renderer.domElement.style.height = "100%";
    this.syncCanvasInteractionMode();
    this.renderer.domElement.tabIndex = 0;
    this.renderer.domElement.setAttribute("role", "application");
    this.renderer.domElement.setAttribute(
      "aria-label",
      options.accessibleLabel?.trim() || DEFAULT_ACCESSIBLE_LABEL,
    );
    this.renderer.domElement.setAttribute(
      "aria-description",
      options.accessibleDescription?.trim() || DEFAULT_ACCESSIBLE_DESCRIPTION,
    );
    this.renderer.domElement.setAttribute("aria-keyshortcuts", CAMERA_KEY_SHORTCUTS);

    this.camera.position.set(8, 7.2, 8);
    this.camera.lookAt(0, 0, 0);

    this.buildEnvironment();
    this.buildTarget();
    this.floorGroup.name = "warehouse-floor";
    this.warehouseGroup.name = "warehouse-environment";
    this.plannedRouteGroup.name = "planned-route";
    this.safetyCorridorGroup.name = "safety-corridor";
    this.obstacleGroup.name = "warehouse-obstacles";
    this.uncertaintyGroup.name = "pose-uncertainty";
    this.selectedIncidentGroup.name = "selected-incident";
    this.selectedIncidentGroup.visible = false;
    this.uncertaintyGroup.visible = false;
    this.primaryRobot.root.position.y = ROBOT_GROUND_OFFSET;
    this.comparisonRobot.root.position.y = ROBOT_GROUND_OFFSET;
    this.comparisonRobot.root.visible = false;
    this.comparisonTrajectoryGroup.visible = false;
    this.scene.add(
      this.floorGroup,
      this.warehouseGroup,
      this.safetyCorridorGroup,
      this.plannedRouteGroup,
      this.obstacleGroup,
      this.trajectoryGroup,
      this.comparisonTrajectoryGroup,
      this.markerGroup,
      this.targetGroup,
      this.uncertaintyGroup,
      this.selectedIncidentGroup,
      this.primaryRobot.root,
      this.comparisonRobot.root,
    );

    this.installCanvasControls();
    this.resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.resize());

    const warehouse =
      options.warehouse === undefined ? defaultWarehouseLayout() : options.warehouse;
    this.setWarehouse(warehouse);
    if (options.floorBounds !== undefined) {
      this.setFloorBounds(options.floorBounds);
    }
    if (options.safetyCorridorWidth !== undefined) {
      this.safetyCorridorWidth = positive(options.safetyCorridorWidth, "safetyCorridorWidth");
    }
    if (options.obstacles !== undefined) {
      this.setObstacles(options.obstacles);
    }

    this.setPose(this.pose);
    this.setTrajectory(options.trajectory ?? []);
    this.setMarkers(options.markers ?? []);
    this.setComparison(options.comparison ?? null);
    if (options.plannedRoute !== undefined) {
      this.setPlannedRoute(
        options.plannedRoute,
        options.safetyCorridorWidth,
        options.plannedRouteClosed,
      );
    } else if (
      (options.safetyCorridorWidth !== undefined || options.plannedRouteClosed !== undefined) &&
      this.plannedRouteGroup.userData.points
    ) {
      this.plannedRouteClosed = options.plannedRouteClosed ?? this.plannedRouteClosed;
      this.replacePlannedRoute(
        this.plannedRouteGroup.userData.points as readonly ScenePoint[],
        this.safetyCorridorWidth,
      );
    }
    if (Object.hasOwn(options, "target")) {
      this.setTarget(options.target ?? null);
    } else if (warehouse !== false && warehouse.goal !== undefined) {
      this.setTarget(warehouse.goal);
    } else {
      this.setTarget(null);
    }
    this.setUncertainty(options.uncertainty ?? null);
    this.setSelectedMarker(options.selectedMarkerId ?? null);
    if (options.cameraControls !== undefined) {
      this.bindCameraControls(options.cameraControls);
    }

    if (container !== undefined) {
      this.mount(container);
    }
  }

  /** The renderer canvas, useful for accessibility hooks and browser tests. */
  public get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  public get cameraMode(): RobotCameraMode {
    return this.mode;
  }

  public get renderMode(): SceneRenderMode {
    return this.renderModeValue;
  }

  public get renderingEnabled(): boolean {
    return this.renderingEnabledValue;
  }

  public get reducedMotion(): boolean {
    return this.reducedMotionValue;
  }

  public get isContextLost(): boolean {
    return this.contextLostValue;
  }

  /** Updates the canvas label without replacing the renderer or its event handlers. */
  public setAccessibleLabel(label: string): void {
    this.assertActive();
    const normalized = label.trim();
    if (normalized.length === 0) {
      throw new RangeError("accessible label must not be empty");
    }
    this.renderer.domElement.setAttribute("aria-label", normalized);
  }

  /** Switches between the compatibility animation loop and on-demand rendering. */
  public setRenderMode(mode: SceneRenderMode): void {
    this.assertActive();
    if (mode !== "continuous" && mode !== "manual") {
      throw new RangeError('renderMode must be "continuous" or "manual"');
    }
    if (mode === this.renderModeValue) {
      return;
    }
    this.cancelScheduledRender();
    this.renderModeValue = mode;
    this.lastFrameTime = 0;
    this.requestRender();
  }

  /** Suspends or resumes scheduled rendering. Explicit `renderOnce` calls still work. */
  public setRenderingEnabled(enabled: boolean): void {
    this.assertActive();
    if (enabled === this.renderingEnabledValue) {
      return;
    }
    this.renderingEnabledValue = enabled;
    this.lastFrameTime = 0;
    if (enabled) {
      this.requestRender();
    } else {
      this.cancelScheduledRender();
    }
  }

  /** Disables decorative animation and follow-camera easing when enabled. */
  public setReducedMotion(reduced: boolean): void {
    this.assertActive();
    if (reduced === this.reducedMotionValue) {
      return;
    }
    this.reducedMotionValue = reduced;
    if (reduced) {
      this.finishFocusTransition();
      this.resetDecorativeTransforms();
    }
    this.invalidate();
  }

  /** Renders one synchronous frame, including while scheduled rendering is suspended. */
  public renderOnce(time = performance.now()): void {
    this.assertActive();
    finite(time, "render time");
    if (this.contextLostValue) {
      return;
    }
    if (this.renderModeValue === "manual") {
      this.cancelScheduledRender();
    }
    this.renderAt(time);
    if (this.cameraFocusTransition !== null) {
      this.requestRender();
    }
  }

  public mount(container: HTMLElement): this {
    this.assertActive();
    if (this.container === container) {
      this.resize();
      return this;
    }

    if (this.container !== null) {
      this.resizeObserver?.unobserve(this.container);
      this.renderer.domElement.remove();
    }

    this.container = container;
    container.append(this.renderer.domElement);
    this.resizeObserver?.observe(container);
    this.resize();
    this.requestRender();
    return this;
  }

  public setPose(pose: RobotPose): void {
    this.assertActive();
    validatePoint(pose, "pose");
    poseHeading(pose);

    const distance = Math.hypot(pose.x - this.pose.x, pose.y - this.pose.y);
    if (distance < 5) {
      this.wheelTravel += distance;
    }
    this.pose = { ...pose };
    this.applyPose(this.primaryRobot, pose, this.wheelTravel);
    this.updateUncertaintyTransform();
    this.invalidate();
  }

  public setTrajectory(points: readonly SceneTrajectoryPoint[]): void {
    this.assertActive();
    this.primaryTrajectoryPoints = points.map((point) => ({ ...point }));
    this.replaceTrajectory(this.trajectoryGroup, points, this.primaryStyle);
    if (!this.plannedRouteExplicit && this.comparisonTrajectoryGroup.children.length === 0) {
      this.plannedRouteClosed = false;
      this.replacePlannedRoute(points, this.safetyCorridorWidth);
    }
    this.invalidate();
  }

  /** Replaces the procedural map shell without affecting replay poses or trajectories. */
  public setWarehouse(layout: SceneWarehouseLayout | false): void {
    this.assertActive();
    clearGroup(this.warehouseGroup);
    if (layout === false) {
      this.replaceFloor(DEFAULT_FLOOR_BOUNDS, false);
      this.setObstacles([]);
      this.plannedRouteExplicit = false;
      this.plannedRouteClosed = false;
      this.replacePlannedRoute(this.inferredPlannedRoute(), this.safetyCorridorWidth);
      this.invalidate();
      return;
    }

    this.replaceFloor(layout.floorBounds ?? DEFAULT_FLOOR_BOUNDS, layout.floorBounds !== undefined);
    for (const [index, marking] of (layout.aisleMarkings ?? []).entries()) {
      if (marking.points.length < 2) {
        continue;
      }
      marking.points.forEach((point, pointIndex) =>
        validatePoint(point, `warehouse.aisleMarkings[${index}].points[${pointIndex}]`),
      );
      this.warehouseGroup.add(this.createAisleMarking(marking));
    }
    if (layout.dock !== undefined && layout.dock !== null) {
      validatePoint(layout.dock, "warehouse.dock");
      this.warehouseGroup.add(this.createDock(layout.dock));
    }

    this.setObstacles([...(layout.racks ?? []), ...(layout.obstacles ?? [])]);
    if (layout.safetyCorridorWidth !== undefined) {
      this.safetyCorridorWidth = positive(
        layout.safetyCorridorWidth,
        "warehouse.safetyCorridorWidth",
      );
    }
    if (layout.plannedRoute !== undefined) {
      this.setPlannedRoute(
        layout.plannedRoute,
        this.safetyCorridorWidth,
        layout.plannedRouteClosed,
      );
    } else {
      this.plannedRouteExplicit = false;
      this.plannedRouteClosed = false;
      this.replacePlannedRoute(this.inferredPlannedRoute(), this.safetyCorridorWidth);
    }
    if (layout.goal !== undefined) {
      this.setTarget(layout.goal);
    }
    this.invalidate();
  }

  /** Updates the rendered map extent without changing routes or obstacles. */
  public setFloorBounds(bounds: SceneFloorBounds): void {
    this.assertActive();
    this.replaceFloor(bounds, true);
    this.invalidate();
  }

  /** Sets the planned centreline and its translucent safety corridor. */
  public setPlannedRoute(
    points: readonly ScenePoint[],
    corridorWidth?: number,
    closed?: boolean,
  ): void {
    this.assertActive();
    if (corridorWidth !== undefined) {
      this.safetyCorridorWidth = positive(corridorWidth, "safetyCorridorWidth");
    }
    points.forEach((point, index) => validatePoint(point, `plannedRoute[${index}]`));
    this.plannedRouteExplicit = true;
    this.plannedRouteClosed = closed ?? false;
    this.replacePlannedRoute(points, this.safetyCorridorWidth);
    this.invalidate();
  }

  public setObstacles(obstacles: readonly SceneObstacle[]): void {
    this.assertActive();
    clearGroup(this.obstacleGroup);
    for (const [index, obstacle] of obstacles.entries()) {
      validatePoint(obstacle, `obstacles[${index}]`);
      positive(obstacle.width, `obstacles[${index}].width`);
      positive(obstacle.depth, `obstacles[${index}].depth`);
      if (obstacle.height !== undefined) {
        positive(obstacle.height, `obstacles[${index}].height`);
      }
      if (obstacle.yaw !== undefined) {
        finite(obstacle.yaw, `obstacles[${index}].yaw`);
      }
      this.obstacleGroup.add(this.createObstacle(obstacle));
    }
    this.invalidate();
  }

  /** Updates or hides the primary robot's ground-plane uncertainty ellipse. */
  public setUncertainty(uncertainty: number | ScenePoseUncertainty | null): void {
    this.assertActive();
    if (uncertainty === null) {
      if (this.uncertainty === null && !this.uncertaintyGroup.visible) {
        return;
      }
      this.uncertainty = null;
      this.uncertaintyGroup.visible = false;
      this.invalidate();
      return;
    }

    const resolved = typeof uncertainty === "number" ? { radius: uncertainty } : uncertainty;
    const major = positive(resolved.majorAxis ?? resolved.radius ?? 0, "uncertainty.majorAxis");
    const minor = positive(resolved.minorAxis ?? resolved.radius ?? major, "uncertainty.minorAxis");
    if (resolved.yaw !== undefined) {
      finite(resolved.yaw, "uncertainty.yaw");
    }
    const confidence =
      resolved.confidence === undefined
        ? 0.95
        : unitInterval(resolved.confidence, "uncertainty.confidence");
    const visible = resolved.visible ?? true;
    const previous = this.uncertainty;
    if (
      previous !== null &&
      previous.majorAxis === major &&
      previous.minorAxis === minor &&
      previous.yaw === resolved.yaw &&
      previous.confidence === confidence &&
      (previous.visible ?? true) === visible &&
      this.uncertaintyGroup.visible === visible
    ) {
      return;
    }

    const { fill, edge } = this.ensureUncertaintyVisuals();
    fill.scale.set(major, minor, 1);
    edge.scale.set(major, minor, 1);
    fill.material.opacity = 0.08 + confidence * 0.08;
    this.uncertainty = {
      majorAxis: major,
      minorAxis: minor,
      yaw: resolved.yaw,
      confidence,
      visible,
    };
    this.updateUncertaintyTransform();
    this.uncertaintyGroup.visible = visible;
    this.invalidate();
  }

  /** Convenience for telemetry channels that expose a scalar pose sigma. */
  public setPoseUncertainty(radius: number | null): void {
    this.setUncertainty(radius);
  }

  /** Selects an incident marker and adds a high-emphasis beacon. */
  public setSelectedMarker(id: string | null): boolean {
    this.assertActive();
    if (id === null) {
      this.restoreSelectedBaseMarkerLabel();
      this.selectedMarkerId = null;
      clearGroup(this.selectedIncidentGroup);
      this.selectedIncidentGroup.visible = false;
      this.invalidate();
      return true;
    }
    const marker = this.markerRecords.get(id);
    if (marker === undefined) {
      return false;
    }
    this.showSelectedMarker(marker, id);
    return true;
  }

  /** Focuses an incident by marker id or coordinates. Returns false for an unknown id. */
  public focusIncident(markerOrId: string | SceneMarker, options: SceneFocusOptions = {}): boolean {
    this.assertActive();
    const marker = typeof markerOrId === "string" ? this.markerRecords.get(markerOrId) : markerOrId;
    if (marker === undefined) {
      return false;
    }
    validatePoint(marker, "incident");
    if (options.select ?? true) {
      this.showSelectedMarker(
        marker,
        typeof markerOrId === "string" ? markerOrId : (marker.id ?? null),
      );
    }
    this.beginFocusTransition(marker, options);
    return true;
  }

  public focusMarker(id: string, options: SceneFocusOptions = {}): boolean {
    return this.focusIncident(id, options);
  }

  public zoomIn(): void {
    this.zoomBy(1 / 1.18);
  }

  public zoomOut(): void {
    this.zoomBy(1.18);
  }

  /** Connects optional external camera buttons and returns an idempotent cleanup callback. */
  public bindCameraControls(controls: SceneCameraControls | null): () => void {
    this.assertActive();
    this.cameraControlsCleanup?.();
    this.cameraControlsCleanup = null;
    if (controls === null) {
      return () => undefined;
    }
    const bindings: Array<[HTMLElement | undefined, EventListener]> = [
      [controls.zoomIn, () => this.zoomIn()],
      [controls.zoomOut, () => this.zoomOut()],
      [controls.frame, () => this.frameScene()],
    ];
    for (const [element, listener] of bindings) {
      element?.addEventListener("click", listener);
    }
    let active = true;
    const cleanup = (): void => {
      if (!active) {
        return;
      }
      active = false;
      for (const [element, listener] of bindings) {
        element?.removeEventListener("click", listener);
      }
      if (this.cameraControlsCleanup === cleanup) {
        this.cameraControlsCleanup = null;
      }
    };
    this.cameraControlsCleanup = cleanup;
    return cleanup;
  }

  public setCameraMode(mode: RobotCameraMode): void {
    this.assertActive();
    if (mode === this.mode) {
      return;
    }
    this.cameraFocusTransition = null;

    if (mode === "orbit") {
      this.orbitTarget.copy(worldPosition(this.pose, 0.35));
      const offset = this.camera.position.clone().sub(this.orbitTarget);
      const spherical = new THREE.Spherical().setFromVector3(offset);
      this.orbitDistance = THREE.MathUtils.clamp(spherical.radius, 2.8, 42);
      this.orbitPolar = THREE.MathUtils.clamp(spherical.phi, 0.18, Math.PI / 2 - 0.025);
      this.orbitAzimuth = spherical.theta;
    } else {
      this.followLookTarget.copy(worldPosition(this.pose, 0.4));
    }
    this.mode = mode;
    this.syncCanvasInteractionMode();
    this.invalidate();
  }

  public setTarget(target: ScenePoint | null): void {
    this.assertActive();
    if (target === null) {
      this.targetGroup.visible = false;
      this.invalidate();
      return;
    }
    validatePoint(target, "target");
    this.targetGroup.position.copy(worldPosition(target, 0.015));
    this.targetGroup.visible = true;
    this.invalidate();
  }

  public setMarkers(markers: readonly SceneMarker[]): void {
    this.assertActive();
    this.selectedBaseMarkerLabel = null;
    clearGroup(this.markerGroup);
    this.markerRecords.clear();
    this.markerGroups.clear();
    for (const [index, marker] of markers.entries()) {
      validatePoint(marker, `markers[${index}]`);
      const group = this.createMarker(marker);
      this.markerGroup.add(group);
      if (marker.id !== undefined) {
        this.markerRecords.set(marker.id, { ...marker });
        this.markerGroups.set(marker.id, group);
      }
    }
    if (this.selectedMarkerId !== null) {
      const selected = this.markerRecords.get(this.selectedMarkerId);
      if (selected === undefined) {
        this.setSelectedMarker(null);
      } else {
        this.showSelectedMarker(selected, this.selectedMarkerId);
      }
    }
    this.invalidate();
  }

  public setComparison(comparison: ComparisonSceneState | null): void {
    this.assertActive();
    if (comparison === null) {
      this.setComparisonPose(null);
      this.setComparisonTrajectory(null);
      return;
    }

    this.setComparisonPose(comparison.pose ?? null);
    this.setComparisonTrajectory(comparison.trajectory ?? null);
    const visible = comparison.visible ?? true;
    this.comparisonRobot.root.visible = visible && comparison.pose !== undefined;
    this.comparisonTrajectoryGroup.visible = visible && (comparison.trajectory?.length ?? 0) > 0;
    this.invalidate();
  }

  public setComparisonPose(pose: RobotPose | null): void {
    this.assertActive();
    if (pose === null) {
      this.comparisonPose = null;
      this.comparisonRobot.root.visible = false;
      this.invalidate();
      return;
    }
    validatePoint(pose, "comparisonPose");
    poseHeading(pose, "comparisonPose");
    this.comparisonPose = { ...pose };
    this.comparisonRobot.root.visible = true;
    this.applyPose(this.comparisonRobot, pose, 0);
    this.invalidate();
  }

  public setComparisonTrajectory(points: readonly SceneTrajectoryPoint[] | null): void {
    this.assertActive();
    this.comparisonTrajectoryPoints = (points ?? []).map((point) => ({ ...point }));
    this.replaceTrajectory(this.comparisonTrajectoryGroup, points ?? [], this.comparisonStyle);
    this.comparisonTrajectoryGroup.visible = (points?.length ?? 0) > 0;
    if (!this.plannedRouteExplicit) {
      this.plannedRouteClosed = false;
      this.replacePlannedRoute(points ?? this.primaryTrajectoryPoints, this.safetyCorridorWidth);
    }
    this.invalidate();
  }

  public setComparisonVisible(visible: boolean): void {
    this.assertActive();
    this.comparisonRobot.root.visible = visible && this.comparisonPose !== null;
    this.comparisonTrajectoryGroup.visible =
      visible && this.comparisonTrajectoryGroup.children.length > 0;
    this.invalidate();
  }

  /** Frames the current primary trajectory, or the robot when no trajectory is loaded. */
  public frameTrajectory(): void {
    this.assertActive();
    this.cameraFocusTransition = null;
    const box = new THREE.Box3().setFromObject(this.trajectoryGroup);
    if (box.isEmpty()) {
      this.orbitTarget.copy(worldPosition(this.pose, 0.25));
      this.orbitDistance = 10;
    } else {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.orbitTarget.copy(sphere.center);
      this.orbitTarget.y = 0.2;
      this.orbitDistance = THREE.MathUtils.clamp(sphere.radius * 2.4 + 3, 6, 42);
    }
    this.mode = "orbit";
    this.orbitPolar = 0.88;
    this.invalidate();
  }

  /** Frames both currently visible trajectories, falling back to visible robot poses. */
  public frameVisibleTrajectories(): void {
    this.assertActive();
    this.cameraFocusTransition = null;
    const box = new THREE.Box3();
    let hasContent = false;
    const include = (object: THREE.Object3D): void => {
      const objectBox = new THREE.Box3().setFromObject(object);
      if (!objectBox.isEmpty()) {
        box.union(objectBox);
        hasContent = true;
      }
    };

    if (this.trajectoryGroup.visible && this.trajectoryGroup.children.length > 0) {
      include(this.trajectoryGroup);
    }
    if (
      this.comparisonTrajectoryGroup.visible &&
      this.comparisonTrajectoryGroup.children.length > 0
    ) {
      include(this.comparisonTrajectoryGroup);
    }
    if (!hasContent) {
      include(this.primaryRobot.root);
      if (this.comparisonRobot.root.visible) {
        include(this.comparisonRobot.root);
      }
    }

    if (!hasContent || box.isEmpty()) {
      this.orbitTarget.copy(worldPosition(this.pose, 0.25));
      this.orbitDistance = 10;
    } else {
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      this.orbitTarget.copy(sphere.center);
      this.orbitTarget.y = 0.2;
      this.orbitDistance = THREE.MathUtils.clamp(sphere.radius * 2.4 + 3, 6, 42);
    }
    this.mode = "orbit";
    this.orbitPolar = 0.88;
    this.invalidate();
  }

  /** Frames the active run together with route, obstacles, dock, and goal. */
  public frameScene(): void {
    this.assertActive();
    const box = new THREE.Box3();
    let hasContent = false;
    const sceneObjects = [
      this.trajectoryGroup,
      this.comparisonTrajectoryGroup,
      this.plannedRouteGroup,
      this.obstacleGroup,
      this.warehouseGroup,
      this.targetGroup,
      ...(this.explicitFloorBounds ? [this.floorGroup] : []),
    ];
    for (const object of sceneObjects) {
      if (!object.visible) {
        continue;
      }
      const objectBox = new THREE.Box3().setFromObject(object);
      if (!objectBox.isEmpty()) {
        box.union(objectBox);
        hasContent = true;
      }
    }
    if (!hasContent || box.isEmpty()) {
      this.frameVisibleTrajectories();
      return;
    }
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    this.cameraFocusTransition = null;
    this.orbitTarget.copy(sphere.center);
    this.orbitTarget.y = 0.2;
    this.orbitDistance = THREE.MathUtils.clamp(sphere.radius * 2.15 + 3, 7, MAX_ORBIT_DISTANCE);
    this.mode = "orbit";
    this.orbitPolar = 0.84;
    this.invalidate();
  }

  public resize(): void {
    if (this.disposed || this.container === null) {
      return;
    }
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.maxPixelRatio));
    this.renderer.setSize(width, height, false);
    this.invalidate();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.cancelScheduledRender();
    if (this.container !== null) {
      this.resizeObserver?.unobserve(this.container);
    }
    this.resizeObserver?.disconnect();
    this.cameraControlsCleanup?.();
    this.cameraControlsCleanup = null;
    this.activePointers.clear();
    this.removeCanvasControls();
    disposeObject(this.scene);
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.container = null;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("RobotReplayScene has been disposed");
    }
  }

  private buildEnvironment(): void {
    const hemisphere = new THREE.HemisphereLight(0xc8dbe4, 0x070c10, 1.1);
    this.scene.add(hemisphere);

    const keyLight = new THREE.DirectionalLight(0xffffff, 3.2);
    keyLight.position.set(7, 11, 5);
    keyLight.castShadow = true;
    keyLight.shadow.mapSize.set(this.shadowMapSize, this.shadowMapSize);
    keyLight.shadow.camera.near = 0.5;
    keyLight.shadow.camera.far = 34;
    keyLight.shadow.camera.left = -14;
    keyLight.shadow.camera.right = 14;
    keyLight.shadow.camera.top = 14;
    keyLight.shadow.camera.bottom = -14;
    keyLight.shadow.bias = -0.0002;
    this.scene.add(keyLight);

    const originRing = new THREE.Mesh(
      new THREE.RingGeometry(0.92, 0.945, 80),
      new THREE.MeshBasicMaterial({
        color: 0x52636c,
        transparent: true,
        opacity: 0.44,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    originRing.rotation.x = -Math.PI / 2;
    originRing.position.y = 0.012;
    this.scene.add(originRing);

    const xAxis = new THREE.ArrowHelper(
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0.018, 0),
      1.55,
      0x6e7b82,
      0.18,
      0.08,
    );
    const yAxis = new THREE.ArrowHelper(
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(0, 0.018, 0),
      1.55,
      0x005a96,
      0.18,
      0.08,
    );
    this.scene.add(xAxis, yAxis);
  }

  private replaceFloor(bounds: SceneFloorBounds, explicit: boolean): void {
    validateFloorBounds(bounds, "warehouse.floorBounds");
    clearGroup(this.floorGroup);
    this.explicitFloorBounds = explicit;
    const width = bounds.maxX - bounds.minX;
    const depth = bounds.maxY - bounds.minY;
    const centreX = (bounds.minX + bounds.maxX) / 2;
    const centreY = (bounds.minY + bounds.maxY) / 2;
    const gridSize = Math.max(width, depth);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(width, depth),
      new THREE.MeshStandardMaterial({
        color: 0x111820,
        metalness: 0.38,
        roughness: 0.79,
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(centreX, -0.012, centreY);
    floor.receiveShadow = true;

    const fineDivisions = Math.round(THREE.MathUtils.clamp(gridSize * 2, 4, 240));
    const fineGrid = new THREE.GridHelper(gridSize, fineDivisions, 0x344650, 0x1b2931);
    fineGrid.position.set(centreX, 0.003, centreY);
    fineGrid.scale.set(width / gridSize, 1, depth / gridSize);
    setMaterialOpacity(fineGrid.material, 0.31);

    const majorDivisions = Math.round(THREE.MathUtils.clamp(gridSize / 2, 2, 100));
    const majorGrid = new THREE.GridHelper(gridSize, majorDivisions, 0x52636c, 0x344650);
    majorGrid.position.set(centreX, 0.006, centreY);
    majorGrid.scale.set(width / gridSize, 1, depth / gridSize);
    setMaterialOpacity(majorGrid.material, 0.22);

    const boundaryPoints = [
      new THREE.Vector3(bounds.minX, 0.011, bounds.minY),
      new THREE.Vector3(bounds.maxX, 0.011, bounds.minY),
      new THREE.Vector3(bounds.maxX, 0.011, bounds.maxY),
      new THREE.Vector3(bounds.minX, 0.011, bounds.maxY),
      new THREE.Vector3(bounds.minX, 0.011, bounds.minY),
    ];
    const boundary = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(boundaryPoints),
      new THREE.LineBasicMaterial({
        color: 0x52636c,
        transparent: true,
        opacity: 0.58,
        depthWrite: false,
      }),
    );
    boundary.renderOrder = 2;
    this.floorGroup.add(floor, fineGrid, majorGrid, boundary);
  }

  private createGroundStrip(
    from: ScenePoint,
    to: ScenePoint,
    width: number,
    material: THREE.Material,
    elevation: number,
  ): THREE.Mesh {
    const deltaX = to.x - from.x;
    const deltaY = to.y - from.y;
    const length = Math.hypot(deltaX, deltaY);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(length, 0.012, width), material);
    strip.position.set((from.x + to.x) / 2, elevation, (from.y + to.y) / 2);
    strip.rotation.y = -Math.atan2(deltaY, deltaX);
    strip.receiveShadow = true;
    return strip;
  }

  private createAisleMarking(marking: SceneAisleMarking): THREE.Group {
    const group = new THREE.Group();
    group.name = "aisle-marking";
    const width = positive(marking.width ?? 0.055, "aisleMarking.width");
    const material = new THREE.MeshBasicMaterial({
      color: marking.color ?? 0xb7d600,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    });
    for (let index = 1; index < marking.points.length; index += 1) {
      const from = marking.points[index - 1];
      const to = marking.points[index];
      if (from === undefined || to === undefined) {
        continue;
      }
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (length <= Number.EPSILON) {
        continue;
      }
      if (!(marking.dashed ?? true)) {
        group.add(this.createGroundStrip(from, to, width, material, 0.012));
        continue;
      }
      const dash = 0.62;
      const cycle = 1.05;
      const count = Math.ceil(length / cycle);
      for (let dashIndex = 0; dashIndex < count; dashIndex += 1) {
        const startRatio = Math.min(1, (dashIndex * cycle) / length);
        const endRatio = Math.min(1, (dashIndex * cycle + dash) / length);
        if (endRatio <= startRatio) {
          continue;
        }
        const start = {
          x: THREE.MathUtils.lerp(from.x, to.x, startRatio),
          y: THREE.MathUtils.lerp(from.y, to.y, startRatio),
        };
        const end = {
          x: THREE.MathUtils.lerp(from.x, to.x, endRatio),
          y: THREE.MathUtils.lerp(from.y, to.y, endRatio),
        };
        group.add(this.createGroundStrip(start, end, width, material, 0.012));
      }
    }
    return group;
  }

  private createDock(dock: SceneDock): THREE.Group {
    const group = new THREE.Group();
    group.name = "warehouse-dock";
    const width = positive(dock.width ?? 1.35, "dock.width");
    const depth = positive(dock.depth ?? 1.5, "dock.depth");
    const yaw = finite(dock.yaw ?? 0, "dock.yaw");
    group.position.copy(worldPosition(dock));
    group.rotation.y = -yaw;

    const pad = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.035, depth),
      new THREE.MeshStandardMaterial({
        color: 0x26343c,
        metalness: 0.28,
        roughness: 0.75,
      }),
    );
    pad.position.y = 0.012;
    pad.receiveShadow = true;
    group.add(pad);

    const edgeMaterial = new THREE.MeshBasicMaterial({
      color: 0xb7d600,
      transparent: true,
      opacity: 0.84,
      depthWrite: false,
    });
    const stripeCount = 7;
    for (let index = 0; index < stripeCount; index += 1) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(width / (stripeCount * 1.8), 0.012, depth * 0.16),
        edgeMaterial,
      );
      stripe.position.set(-width / 2 + ((index + 0.5) * width) / stripeCount, 0.038, depth * 0.39);
      stripe.rotation.y = Math.PI / 5;
      group.add(stripe);
    }
    const bumperMaterial = new THREE.MeshStandardMaterial({
      color: 0x070c10,
      metalness: 0.48,
      roughness: 0.5,
    });
    for (const x of [-width * 0.32, width * 0.32]) {
      const bumper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.24, 0.18), bumperMaterial);
      bumper.position.set(x, 0.12, -depth * 0.42);
      bumper.castShadow = true;
      group.add(bumper);
    }
    if (dock.label?.trim()) {
      const label = createLabelSprite(dock.label, "#f05a1a");
      label.position.set(0, 0.95, -depth * 0.45);
      label.scale.set(1.65, 0.42, 1);
      group.add(label);
    }
    return group;
  }

  private createObstacle(obstacle: SceneObstacle): THREE.Group {
    const group = new THREE.Group();
    const kind = obstacle.kind ?? "rack";
    const height = positive(
      obstacle.height ?? (kind === "rack" ? 2.05 : kind === "wall" ? 1.4 : 0.72),
      "obstacle.height",
    );
    group.name = obstacle.id ?? `obstacle-${kind}`;
    group.position.copy(worldPosition(obstacle));
    group.rotation.y = -finite(obstacle.yaw ?? 0, "obstacle.yaw");

    if (kind === "rack") {
      const steel = new THREE.MeshStandardMaterial({
        color: 0x52636c,
        metalness: 0.76,
        roughness: 0.34,
      });
      const shelfMaterial = new THREE.MeshStandardMaterial({
        color: 0x26343c,
        metalness: 0.46,
        roughness: 0.55,
      });
      const cargoMaterial = new THREE.MeshStandardMaterial({
        color: 0x005a96,
        metalness: 0.08,
        roughness: 0.78,
      });
      for (const x of [-obstacle.width / 2, obstacle.width / 2]) {
        for (const z of [-obstacle.depth / 2, obstacle.depth / 2]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.07, height, 0.07), steel);
          post.position.set(x, height / 2, z);
          post.castShadow = true;
          group.add(post);
        }
      }
      for (const ratio of [0.08, 0.5, 0.94]) {
        const shelf = new THREE.Mesh(
          new THREE.BoxGeometry(obstacle.width + 0.08, 0.065, obstacle.depth + 0.06),
          shelfMaterial,
        );
        shelf.position.y = height * ratio;
        shelf.castShadow = true;
        shelf.receiveShadow = true;
        group.add(shelf);
      }
      for (const x of [-obstacle.width * 0.25, obstacle.width * 0.2]) {
        const cargo = new THREE.Mesh(
          new THREE.BoxGeometry(obstacle.width * 0.34, height * 0.27, obstacle.depth * 0.68),
          cargoMaterial,
        );
        cargo.position.set(x, height * 0.3, 0);
        cargo.castShadow = true;
        group.add(cargo);
      }
    } else {
      const color = kind === "hazard" ? 0x8a5d00 : kind === "pallet" ? 0x52636c : 0x344650;
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(obstacle.width, height, obstacle.depth),
        new THREE.MeshStandardMaterial({
          color,
          metalness: kind === "wall" ? 0.52 : 0.12,
          roughness: kind === "wall" ? 0.52 : 0.76,
          transparent: kind === "hazard",
          opacity: kind === "hazard" ? 0.78 : 1,
        }),
      );
      body.position.y = height / 2;
      body.castShadow = true;
      body.receiveShadow = true;
      group.add(body);
      if (kind === "hazard") {
        const warning = new THREE.Mesh(
          new THREE.RingGeometry(0.18, 0.24, 3),
          new THREE.MeshBasicMaterial({ color: 0xf2a900, side: THREE.DoubleSide }),
        );
        warning.position.set(0, height + 0.03, 0);
        warning.rotation.x = -Math.PI / 2;
        group.add(warning);
      }
    }
    return group;
  }

  private inferredPlannedRoute(): readonly SceneTrajectoryPoint[] {
    return this.comparisonTrajectoryPoints.length > 0
      ? this.comparisonTrajectoryPoints
      : this.primaryTrajectoryPoints;
  }

  private replacePlannedRoute(points: readonly ScenePoint[], corridorWidth: number): void {
    clearGroup(this.plannedRouteGroup);
    clearGroup(this.safetyCorridorGroup);
    this.plannedRouteGroup.userData.points = points.map((point) => ({ ...point }));
    this.plannedRouteGroup.userData.closed = this.plannedRouteClosed;
    const renderPoints = closedRoutePoints(points, this.plannedRouteClosed);
    if (renderPoints.length < 2) {
      return;
    }
    const corridorMaterial = new THREE.MeshBasicMaterial({
      color: 0x005a96,
      transparent: true,
      opacity: 0.105,
      depthWrite: false,
    });
    for (let index = 1; index < renderPoints.length; index += 1) {
      const from = renderPoints[index - 1];
      const to = renderPoints[index];
      if (from === undefined || to === undefined) {
        continue;
      }
      if (Math.hypot(to.x - from.x, to.y - from.y) <= Number.EPSILON) {
        continue;
      }
      const strip = this.createGroundStrip(from, to, corridorWidth, corridorMaterial, 0.007);
      strip.renderOrder = 1;
      this.safetyCorridorGroup.add(strip);
    }

    const geometry = new THREE.BufferGeometry().setFromPoints(
      renderPoints.map((point) => worldPosition(point, 0.024)),
    );
    const line = new THREE.Line(
      geometry,
      new THREE.LineDashedMaterial({
        color: 0x55a9d6,
        dashSize: 0.28,
        gapSize: 0.16,
        transparent: true,
        opacity: 0.82,
        depthWrite: false,
      }),
    );
    line.computeLineDistances();
    line.renderOrder = 3;
    this.plannedRouteGroup.add(line);
  }

  private showSelectedMarker(marker: SceneMarker, id: string | null): void {
    this.restoreSelectedBaseMarkerLabel();
    clearGroup(this.selectedIncidentGroup);
    this.selectedIncidentGroup.scale.setScalar(1);
    this.selectedIncidentGroup.rotation.set(0, 0, 0);
    this.selectedMarkerId = id;
    this.selectedIncidentGroup.position.copy(worldPosition(marker, 0.028));

    const color = marker.kind === "critical" ? 0xe5483f : 0xf2a900;
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.92,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
    const outer = new THREE.Mesh(new THREE.RingGeometry(0.31, 0.37, 48), material);
    outer.rotation.x = -Math.PI / 2;
    outer.renderOrder = 12;
    const inner = new THREE.Mesh(new THREE.RingGeometry(0.12, 0.16, 32), material);
    inner.rotation.x = -Math.PI / 2;
    inner.position.y = 0.006;
    inner.renderOrder = 12;
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.12, 2.15, 20, 1, true),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    beam.position.y = 1.08;
    beam.renderOrder = 11;
    const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.13, 0), material);
    cap.position.y = 1.9;
    cap.renderOrder = 13;
    const accent = `#${color.toString(16).padStart(6, "0")}`;
    const label = createLabelSprite(marker.label?.trim() || "Selected incident", accent);
    label.position.y = 2.55;
    label.scale.set(2.05, 0.52, 1);
    label.material.depthTest = false;
    const baseLabel =
      id === null ? undefined : this.markerGroups.get(id)?.getObjectByName("marker-label");
    if (baseLabel instanceof THREE.Sprite) {
      baseLabel.visible = false;
      this.selectedBaseMarkerLabel = baseLabel;
    }
    this.selectedIncidentGroup.add(outer, inner, beam, cap, label);
    this.selectedIncidentGroup.visible = true;
    this.invalidate();
  }

  private restoreSelectedBaseMarkerLabel(): void {
    if (this.selectedBaseMarkerLabel === null) {
      return;
    }
    this.selectedBaseMarkerLabel.visible = true;
    this.selectedBaseMarkerLabel = null;
  }

  private beginFocusTransition(marker: ScenePoint, options: SceneFocusOptions): void {
    if (this.mode !== "orbit") {
      this.setCameraMode("orbit");
    }
    const target = worldPosition(marker, 0.28);
    const distance = THREE.MathUtils.clamp(
      positive(options.distance ?? 7.2, "focus distance"),
      MIN_ORBIT_DISTANCE,
      MAX_ORBIT_DISTANCE,
    );
    const durationMs = finite(options.durationMs ?? 520, "focus duration");
    if (durationMs < 0) {
      throw new RangeError("focus duration must not be negative");
    }
    if (this.reducedMotionValue || durationMs === 0) {
      this.cameraFocusTransition = null;
      this.orbitTarget.copy(target);
      this.orbitDistance = distance;
    } else {
      this.cameraFocusTransition = {
        fromTarget: this.orbitTarget.clone(),
        toTarget: target,
        fromDistance: this.orbitDistance,
        toDistance: distance,
        elapsed: 0,
        duration: durationMs / 1_000,
      };
    }
    this.orbitPolar = Math.min(this.orbitPolar, 0.86);
    this.invalidate();
  }

  private finishFocusTransition(): void {
    if (this.cameraFocusTransition === null) {
      return;
    }
    this.orbitTarget.copy(this.cameraFocusTransition.toTarget);
    this.orbitDistance = this.cameraFocusTransition.toDistance;
    this.cameraFocusTransition = null;
  }

  private zoomBy(multiplier: number): void {
    this.assertActive();
    positive(multiplier, "zoom multiplier");
    this.cameraFocusTransition = null;
    if (this.mode === "orbit") {
      this.orbitDistance = THREE.MathUtils.clamp(
        this.orbitDistance * multiplier,
        MIN_ORBIT_DISTANCE,
        MAX_ORBIT_DISTANCE,
      );
    } else {
      this.followDistance = THREE.MathUtils.clamp(this.followDistance * multiplier, 3.2, 11);
    }
    this.invalidate();
  }

  private ensureUncertaintyVisuals(): {
    fill: THREE.Mesh<THREE.CircleGeometry, THREE.MeshBasicMaterial>;
    edge: THREE.Mesh<THREE.RingGeometry, THREE.MeshBasicMaterial>;
  } {
    if (this.uncertaintyFill !== null && this.uncertaintyEdge !== null) {
      return { fill: this.uncertaintyFill, edge: this.uncertaintyEdge };
    }

    const fill = new THREE.Mesh(
      new THREE.CircleGeometry(1, 64),
      new THREE.MeshBasicMaterial({
        color: 0x55a9d6,
        transparent: true,
        opacity: 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    fill.rotation.x = -Math.PI / 2;
    fill.position.y = 0.014;
    fill.renderOrder = 2;

    const edge = new THREE.Mesh(
      new THREE.RingGeometry(0.965, 1, 64),
      new THREE.MeshBasicMaterial({
        color: 0x9dd9f5,
        transparent: true,
        opacity: 0.66,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    edge.rotation.x = -Math.PI / 2;
    edge.position.y = 0.017;
    edge.renderOrder = 3;

    this.uncertaintyFill = fill;
    this.uncertaintyEdge = edge;
    this.uncertaintyGroup.add(fill, edge);
    return { fill, edge };
  }

  private updateUncertaintyTransform(): void {
    if (this.uncertainty === null) {
      return;
    }
    this.uncertaintyGroup.position.set(this.pose.x, 0, this.pose.y);
    this.uncertaintyGroup.rotation.y = -(this.uncertainty.yaw ?? poseHeading(this.pose));
  }

  private buildTarget(): void {
    this.targetGroup.name = "target-marker";
    const outer = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.47, 64),
      new THREE.MeshBasicMaterial({
        color: this.primaryStyle.accentColor,
        transparent: true,
        opacity: 0.82,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    outer.rotation.x = -Math.PI / 2;

    const inner = new THREE.Mesh(
      new THREE.RingGeometry(0.1, 0.14, 32),
      new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 0.92,
        side: THREE.DoubleSide,
        depthWrite: false,
      }),
    );
    inner.rotation.x = -Math.PI / 2;

    const crossMaterial = new THREE.LineBasicMaterial({
      color: this.primaryStyle.accentColor,
      transparent: true,
      opacity: 0.72,
      depthWrite: false,
    });
    const cross = new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(-0.28, 0.005, 0),
        new THREE.Vector3(0.28, 0.005, 0),
        new THREE.Vector3(0, 0.005, -0.28),
        new THREE.Vector3(0, 0.005, 0.28),
      ]),
      crossMaterial,
    );
    const goalPost = new THREE.Mesh(
      new THREE.CylinderGeometry(0.018, 0.018, 0.72, 10),
      new THREE.MeshBasicMaterial({
        color: this.primaryStyle.accentColor,
        transparent: true,
        opacity: 0.72,
      }),
    );
    goalPost.position.y = 0.36;
    const goalAccent = `#${new THREE.Color(this.primaryStyle.accentColor).getHexString()}`;
    const goalLabel = createLabelSprite("INSPECTION GOAL", goalAccent);
    goalLabel.position.y = 0.98;
    goalLabel.scale.set(1.85, 0.46, 1);
    this.targetGroup.add(outer, inner, cross, goalPost, goalLabel);
    this.targetGroup.visible = false;
  }

  private createMarker(marker: SceneMarker): THREE.Group {
    const group = new THREE.Group();
    group.name = marker.id ?? `marker-${marker.kind ?? "state"}`;
    group.position.copy(worldPosition(marker, 0.02));

    const kind = marker.kind ?? "state";
    const color =
      kind === "critical"
        ? 0xe5483f
        : kind === "warning"
          ? 0xf2a900
          : kind === "waypoint"
            ? 0x55a9d6
            : 0x9db5c0;
    const material = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.9,
      side: THREE.DoubleSide,
      depthWrite: false,
    });

    const ring = new THREE.Mesh(new THREE.RingGeometry(0.18, 0.23, 32), material);
    ring.rotation.x = -Math.PI / 2;
    group.add(ring);

    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.52, 8), material);
    stem.position.y = 0.27;
    group.add(stem);

    const capGeometry =
      kind === "warning" || kind === "critical"
        ? new THREE.ConeGeometry(0.12, 0.22, 3)
        : new THREE.OctahedronGeometry(0.1, 0);
    const cap = new THREE.Mesh(capGeometry, material);
    cap.position.y = 0.61;
    group.add(cap);

    return group;
  }

  private replaceTrajectory(
    group: THREE.Group,
    points: readonly SceneTrajectoryPoint[],
    style: ResolvedSceneLayerStyle,
  ): void {
    clearGroup(group);
    if (points.length === 0) {
      return;
    }
    points.forEach((point, index) => {
      validatePoint(point, `trajectory[${index}]`);
      const deviation = point.deviation ?? point.pathError;
      if (deviation !== undefined) {
        finite(deviation, `trajectory[${index}].deviation`);
      }
    });

    const comparison = style === this.comparisonStyle;
    const vertices = points.map((point) => worldPosition(point, comparison ? 0.028 : 0.04));
    const geometry = new THREE.BufferGeometry().setFromPoints(vertices);
    const hasDeviation =
      !comparison && points.some((point) => Number.isFinite(point.deviation ?? point.pathError));
    if (hasDeviation) {
      const colors: number[] = [];
      for (const point of points) {
        const raw = point.deviation ?? point.pathError;
        const color =
          raw === undefined
            ? new THREE.Color(style.trajectoryColor)
            : this.colorForDeviation(Math.abs(raw));
        colors.push(color.r, color.g, color.b);
      }
      geometry.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
    }
    const lineMaterial = style.dashedTrajectory
      ? new THREE.LineDashedMaterial({
          color: hasDeviation ? 0xffffff : style.trajectoryColor,
          dashSize: style.dashSize,
          gapSize: style.gapSize,
          transparent: true,
          opacity: style.trajectoryOpacity,
          depthWrite: false,
          vertexColors: hasDeviation,
        })
      : new THREE.LineBasicMaterial({
          color: hasDeviation ? 0xffffff : style.trajectoryColor,
          transparent: true,
          opacity: style.trajectoryOpacity,
          depthWrite: false,
          vertexColors: hasDeviation,
        });

    const line = new THREE.Line(geometry, lineMaterial);
    if (lineMaterial instanceof THREE.LineDashedMaterial) {
      line.computeLineDistances();
    }
    line.renderOrder = 4;
    group.add(line);

    const pointMaterial = new THREE.PointsMaterial({
      color: hasDeviation ? 0xffffff : style.pointColor,
      size: comparison ? 0.055 : 0.075,
      transparent: true,
      opacity: style.pointOpacity,
      sizeAttenuation: true,
      depthWrite: false,
      vertexColors: hasDeviation,
    });
    const telemetryPoints = new THREE.Points(geometry, pointMaterial);
    telemetryPoints.renderOrder = 5;
    group.add(telemetryPoints);
  }

  private colorForDeviation(deviation: number): THREE.Color {
    if (deviation <= this.deviationScale.warningAt) {
      return this.deviationScale.nominalColor
        .clone()
        .lerp(this.deviationScale.warningColor, deviation / this.deviationScale.warningAt);
    }
    if (deviation >= this.deviationScale.criticalAt) {
      return this.deviationScale.criticalColor.clone();
    }
    const amount =
      (deviation - this.deviationScale.warningAt) /
      (this.deviationScale.criticalAt - this.deviationScale.warningAt);
    return this.deviationScale.warningColor.clone().lerp(this.deviationScale.criticalColor, amount);
  }

  private applyPose(rig: RobotRig, pose: RobotPose, wheelTravel: number): void {
    rig.root.position.set(pose.x, ROBOT_GROUND_OFFSET, pose.y);
    rig.root.rotation.y = -poseHeading(pose);
    const wheelAngle = -wheelTravel / 0.2;
    for (const wheel of rig.wheels) {
      wheel.rotation.z = wheelAngle;
    }
  }

  private installCanvasControls(): void {
    const canvas = this.renderer.domElement;
    canvas.addEventListener("pointerdown", this.onPointerDown);
    canvas.addEventListener("pointermove", this.onPointerMove);
    canvas.addEventListener("pointerup", this.onPointerUp);
    canvas.addEventListener("pointercancel", this.onPointerUp);
    canvas.addEventListener("wheel", this.onWheel, { passive: false });
    canvas.addEventListener("keydown", this.onKeyDown);
    canvas.addEventListener("contextmenu", this.onContextMenu);
    canvas.addEventListener("webglcontextlost", this.onContextLost);
    canvas.addEventListener("webglcontextrestored", this.onContextRestored);
  }

  private syncCanvasInteractionMode(): void {
    const orbiting = this.mode === "orbit";
    this.renderer.domElement.style.touchAction = orbiting ? "none" : "pan-y pinch-zoom";
    this.renderer.domElement.style.cursor = orbiting ? "grab" : "default";
  }

  private removeCanvasControls(): void {
    const canvas = this.renderer.domElement;
    canvas.removeEventListener("pointerdown", this.onPointerDown);
    canvas.removeEventListener("pointermove", this.onPointerMove);
    canvas.removeEventListener("pointerup", this.onPointerUp);
    canvas.removeEventListener("pointercancel", this.onPointerUp);
    canvas.removeEventListener("wheel", this.onWheel);
    canvas.removeEventListener("keydown", this.onKeyDown);
    canvas.removeEventListener("contextmenu", this.onContextMenu);
    canvas.removeEventListener("webglcontextlost", this.onContextLost);
    canvas.removeEventListener("webglcontextrestored", this.onContextRestored);
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.mode !== "orbit") {
      if (event.pointerType === "mouse") {
        this.renderer.domElement.focus({ preventScroll: true });
      }
      return;
    }
    this.renderer.domElement.focus({ preventScroll: true });
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    this.renderer.domElement.setPointerCapture(event.pointerId);
    if (this.activePointers.size >= 2) {
      if (this.mode !== "orbit") {
        this.setCameraMode("orbit");
      }
      this.cameraFocusTransition = null;
      this.pointerDrag = null;
      this.touchGesture = this.gestureForPointers();
    } else {
      this.pointerDrag = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        panning: event.button === 2 || event.shiftKey,
      };
      this.touchGesture = null;
    }
    this.renderer.domElement.style.cursor = "grabbing";
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) {
      return;
    }
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (this.activePointers.size >= 2) {
      if (this.mode !== "orbit") {
        this.setCameraMode("orbit");
      }
      const nextGesture = this.gestureForPointers();
      if (nextGesture !== null && this.touchGesture !== null) {
        const scale = this.touchGesture.distance / Math.max(nextGesture.distance, 1);
        this.orbitDistance = THREE.MathUtils.clamp(
          this.orbitDistance * scale,
          MIN_ORBIT_DISTANCE,
          MAX_ORBIT_DISTANCE,
        );
        this.panOrbitPixels(
          nextGesture.centreX - this.touchGesture.centreX,
          nextGesture.centreY - this.touchGesture.centreY,
        );
      }
      this.cameraFocusTransition = null;
      this.touchGesture = nextGesture;
      this.invalidate();
      return;
    }
    if (this.mode !== "orbit" || this.pointerDrag?.pointerId !== event.pointerId) {
      return;
    }
    const deltaX = event.clientX - this.pointerDrag.x;
    const deltaY = event.clientY - this.pointerDrag.y;
    this.pointerDrag.x = event.clientX;
    this.pointerDrag.y = event.clientY;

    if (this.pointerDrag.panning) {
      this.panOrbitPixels(deltaX, deltaY);
    } else {
      this.orbitAzimuth -= deltaX * 0.006;
      this.orbitPolar = THREE.MathUtils.clamp(
        this.orbitPolar + deltaY * 0.005,
        0.18,
        Math.PI / 2 - 0.025,
      );
    }
    this.cameraFocusTransition = null;
    this.invalidate();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.activePointers.has(event.pointerId)) {
      return;
    }
    if (this.renderer.domElement.hasPointerCapture(event.pointerId)) {
      this.renderer.domElement.releasePointerCapture(event.pointerId);
    }
    this.activePointers.delete(event.pointerId);
    if (this.activePointers.size >= 2) {
      this.pointerDrag = null;
      this.touchGesture = this.gestureForPointers();
      return;
    }
    this.touchGesture = null;
    const remaining = this.activePointers.entries().next().value as
      [number, PointerPosition] | undefined;
    this.pointerDrag =
      remaining === undefined
        ? null
        : {
            pointerId: remaining[0],
            x: remaining[1].x,
            y: remaining[1].y,
            panning: false,
          };
    if (this.activePointers.size === 0) {
      this.renderer.domElement.style.cursor = this.mode === "orbit" ? "grab" : "default";
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const multiplier = Math.exp(event.deltaY * 0.001);
    if (this.mode === "orbit") {
      this.orbitDistance = THREE.MathUtils.clamp(
        this.orbitDistance * multiplier,
        MIN_ORBIT_DISTANCE,
        MAX_ORBIT_DISTANCE,
      );
    } else {
      this.followDistance = THREE.MathUtils.clamp(this.followDistance * multiplier, 3.2, 11);
    }
    this.cameraFocusTransition = null;
    this.invalidate();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.altKey || event.ctrlKey || event.metaKey) {
      return;
    }

    const isArrow =
      event.key === "ArrowLeft" ||
      event.key === "ArrowRight" ||
      event.key === "ArrowUp" ||
      event.key === "ArrowDown";
    const isZoomIn = event.key === "+" || event.key === "=" || event.key === "Add";
    const isZoomOut = event.key === "-" || event.key === "_" || event.key === "Subtract";
    if (!isArrow && !isZoomIn && !isZoomOut && event.key !== "Home") {
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Home") {
      this.frameVisibleTrajectories();
      return;
    }

    if (this.mode !== "orbit") {
      this.setCameraMode("orbit");
    }

    if (isZoomIn) {
      this.orbitDistance = THREE.MathUtils.clamp(
        this.orbitDistance / 1.12,
        MIN_ORBIT_DISTANCE,
        MAX_ORBIT_DISTANCE,
      );
    } else if (isZoomOut) {
      this.orbitDistance = THREE.MathUtils.clamp(
        this.orbitDistance * 1.12,
        MIN_ORBIT_DISTANCE,
        MAX_ORBIT_DISTANCE,
      );
    } else if (event.shiftKey) {
      const horizontal = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
      const vertical = event.key === "ArrowUp" ? 1 : event.key === "ArrowDown" ? -1 : 0;
      this.panOrbit(horizontal, vertical);
    } else if (event.key === "ArrowLeft") {
      this.orbitAzimuth += 0.08;
    } else if (event.key === "ArrowRight") {
      this.orbitAzimuth -= 0.08;
    } else if (event.key === "ArrowUp") {
      this.orbitPolar = THREE.MathUtils.clamp(this.orbitPolar - 0.06, 0.18, Math.PI / 2 - 0.025);
    } else if (event.key === "ArrowDown") {
      this.orbitPolar = THREE.MathUtils.clamp(this.orbitPolar + 0.06, 0.18, Math.PI / 2 - 0.025);
    }
    this.cameraFocusTransition = null;
    this.invalidate();
  };

  private gestureForPointers(): TouchGesture | null {
    const pointers = [...this.activePointers.values()];
    const first = pointers[0];
    const second = pointers[1];
    if (first === undefined || second === undefined) {
      return null;
    }
    return {
      centreX: (first.x + second.x) / 2,
      centreY: (first.y + second.y) / 2,
      distance: Math.hypot(second.x - first.x, second.y - first.y),
    };
  }

  private panOrbitPixels(deltaX: number, deltaY: number): void {
    const scale = this.orbitDistance * 0.00155;
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.y = 0;
    right.normalize();
    const forward = new THREE.Vector3().crossVectors(UP, right).normalize();
    this.orbitTarget.addScaledVector(right, -deltaX * scale);
    this.orbitTarget.addScaledVector(forward, deltaY * scale);
  }

  private panOrbit(horizontal: number, vertical: number): void {
    this.camera.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    right.y = 0;
    right.normalize();
    const forward = new THREE.Vector3().crossVectors(UP, right).normalize();
    const step = THREE.MathUtils.clamp(this.orbitDistance * 0.045, 0.18, 1.4);
    this.orbitTarget.addScaledVector(right, horizontal * step);
    this.orbitTarget.addScaledVector(forward, vertical * step);
  }

  private readonly onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
  };

  private readonly onContextLost = (event: Event): void => {
    const contextEvent = event as WebGLContextEvent;
    contextEvent.preventDefault();
    if (this.disposed) {
      return;
    }
    this.contextLostValue = true;
    this.cancelScheduledRender();
    this.onContextLostCallback?.(contextEvent);
  };

  private readonly onContextRestored = (event: Event): void => {
    if (this.disposed) {
      return;
    }
    this.contextLostValue = false;
    this.lastFrameTime = 0;
    this.resize();
    this.onContextRestoredCallback?.(event);
    this.requestRender();
  };

  private invalidate(): void {
    this.requestRender();
  }

  private requestRender(): void {
    if (
      this.disposed ||
      this.contextLostValue ||
      !this.renderingEnabledValue ||
      this.container === null ||
      this.animationFrame !== null
    ) {
      return;
    }
    this.animationFrame = requestAnimationFrame(this.renderFrame);
  }

  private cancelScheduledRender(): void {
    if (this.animationFrame === null) {
      return;
    }
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  private readonly renderFrame = (time: number): void => {
    this.animationFrame = null;
    if (
      this.disposed ||
      this.contextLostValue ||
      !this.renderingEnabledValue ||
      this.container === null
    ) {
      return;
    }
    this.renderAt(time);
    if (this.renderModeValue === "continuous" || this.cameraFocusTransition !== null) {
      this.requestRender();
    }
  };

  private renderAt(time: number): void {
    const delta =
      this.lastFrameTime === 0 ? 0 : Math.min(Math.max((time - this.lastFrameTime) / 1000, 0), 0.1);
    this.lastFrameTime = time;
    this.updateCamera(delta);
    this.animateScene(time, delta);
    this.renderer.render(this.scene, this.camera);
  }

  private updateCamera(delta: number): void {
    if (this.mode === "orbit") {
      if (this.cameraFocusTransition !== null) {
        this.cameraFocusTransition.elapsed += delta;
        const progress = THREE.MathUtils.clamp(
          this.cameraFocusTransition.elapsed / this.cameraFocusTransition.duration,
          0,
          1,
        );
        const eased = 1 - (1 - progress) ** 3;
        this.orbitTarget.lerpVectors(
          this.cameraFocusTransition.fromTarget,
          this.cameraFocusTransition.toTarget,
          eased,
        );
        this.orbitDistance = THREE.MathUtils.lerp(
          this.cameraFocusTransition.fromDistance,
          this.cameraFocusTransition.toDistance,
          eased,
        );
        if (progress >= 1) {
          this.finishFocusTransition();
        }
      }
      const sinPolar = Math.sin(this.orbitPolar);
      this.camera.position.set(
        this.orbitTarget.x + this.orbitDistance * sinPolar * Math.sin(this.orbitAzimuth),
        this.orbitTarget.y + this.orbitDistance * Math.cos(this.orbitPolar),
        this.orbitTarget.z + this.orbitDistance * sinPolar * Math.cos(this.orbitAzimuth),
      );
      this.camera.lookAt(this.orbitTarget);
      return;
    }

    const robotPosition = worldPosition(this.pose, 0);
    const heading = poseHeading(this.pose);
    const forward = new THREE.Vector3(Math.cos(heading), 0, Math.sin(heading));
    const desiredPosition = robotPosition
      .clone()
      .addScaledVector(forward, -this.followDistance)
      .add(new THREE.Vector3(0, 3.15, 0));
    const desiredLookAt = robotPosition
      .clone()
      .addScaledVector(forward, 1.15)
      .add(new THREE.Vector3(0, 0.43, 0));
    const smoothing =
      this.reducedMotionValue || this.renderModeValue === "manual" ? 1 : 1 - Math.exp(-delta * 6.4);
    this.camera.position.lerp(desiredPosition, smoothing);
    this.followLookTarget.lerp(desiredLookAt, smoothing);
    this.camera.lookAt(this.followLookTarget);
  }

  private animateScene(time: number, delta: number): void {
    if (this.reducedMotionValue) {
      return;
    }
    this.primaryRobot.lidar.rotation.y += delta * 2.2;
    this.comparisonRobot.lidar.rotation.y += delta * 2.2;

    if (this.targetGroup.visible) {
      const pulse = 1 + Math.sin(time * 0.0032) * 0.08;
      this.targetGroup.scale.setScalar(pulse);
      this.targetGroup.rotation.y += delta * 0.2;
    }

    for (const [index, marker] of this.markerGroup.children.entries()) {
      const pulse = 1 + Math.sin(time * 0.0035 + index * 0.8) * 0.045;
      marker.scale.setScalar(pulse);
    }
    if (this.selectedIncidentGroup.visible) {
      const pulse = 1 + Math.sin(time * 0.0048) * 0.075;
      this.selectedIncidentGroup.scale.setScalar(pulse);
    }
  }

  private resetDecorativeTransforms(): void {
    this.primaryRobot.lidar.rotation.y = 0;
    this.comparisonRobot.lidar.rotation.y = 0;
    this.targetGroup.scale.setScalar(1);
    this.targetGroup.rotation.y = 0;
    for (const marker of this.markerGroup.children) {
      marker.scale.setScalar(1);
    }
    this.selectedIncidentGroup.scale.setScalar(1);
  }
}

export default RobotReplayScene;
