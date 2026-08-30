/** Canonical protocol identifier for browser-consumable live telemetry. */
export const LIVE_PROTOCOL_SCHEMA = "robot-replay/live/2.0" as const;

/** Maximum accepted size of one JSON WebSocket message (one mebibyte). */
export const MAX_LIVE_MESSAGE_BYTES = 1_048_576;

/**
 * Slowest cadence admitted by the live transport: one sample every 20 seconds.
 * This keeps the declared wire contract compatible with the browser client's
 * bounded, cadence-aware freshness window.
 */
export const MIN_LIVE_SAMPLE_RATE_HZ = 0.05;
const MAX_LIVE_SAMPLE_RATE_HZ = 1e9;

export interface LivePose2D {
  /** Position in metres in the session coordinate frame. */
  x: number;
  /** Position in metres in the session coordinate frame. */
  y: number;
  /** Heading in radians. */
  yaw: number;
}

/**
 * A normalized live sample. Optional channels are always represented by null,
 * which prevents missing sensor data from being mistaken for a measured zero.
 */
export interface LiveTelemetrySample {
  /** Seconds from the session time origin. */
  timestamp: number;
  sequence: number | null;
  pose: LivePose2D;
  /** Metres per second. */
  speed: number | null;
  /** Remaining charge in percent. */
  battery: number | null;
  /** Motor current in amperes. Negative values may represent regeneration. */
  current: number | null;
  state: string | null;
  /** End-to-end transport latency in milliseconds. */
  latencyMs: number | null;
  /** One-sigma planar pose uncertainty in metres. */
  poseSigma: number | null;
}

export interface LiveSessionDescriptor {
  id: string;
  source: string;
  name: string | null;
  robotId: string | null;
  sampleRateHz: number | null;
  /** Optional ISO-8601 wall-clock anchor. Replay still uses sample timestamps. */
  startedAt: string | null;
}

export interface LiveHelloMessage {
  type: "hello";
  schema: typeof LIVE_PROTOCOL_SCHEMA;
  session: LiveSessionDescriptor;
}

export interface LiveSampleMessage {
  type: "sample";
  sample: LiveTelemetrySample;
}

export type LiveEventSeverity = "info" | "warning" | "critical";
export type LiveEventDetail = string | number | boolean | null;

export interface LiveStreamEvent {
  id: string;
  timestamp: number;
  kind: string;
  severity: LiveEventSeverity;
  title: string;
  description: string | null;
  details: Readonly<Record<string, LiveEventDetail>>;
}

export interface LiveEventMessage {
  type: "event";
  event: LiveStreamEvent;
}

export interface LiveEndMessage {
  type: "end";
  timestamp: number | null;
  reason: string;
}

export type LiveMessage = LiveHelloMessage | LiveSampleMessage | LiveEventMessage | LiveEndMessage;

export type LiveProtocolErrorCode =
  "invalid-json" | "message-too-large" | "invalid-message" | "unsupported-schema";

/** A validation error with a stable code and JSON-style field path. */
export class LiveProtocolError extends Error {
  readonly code: LiveProtocolErrorCode;
  readonly path: string;

  constructor(code: LiveProtocolErrorCode, path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "LiveProtocolError";
    this.code = code;
    this.path = path;
  }
}

function fail(
  path: string,
  message: string,
  code: LiveProtocolErrorCode = "invalid-message",
): never {
  throw new LiveProtocolError(code, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(path, "must be an object");
  }
  return value;
}

function text(value: unknown, path: string, maximumLength = 256): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(path, "must be a non-empty string");
  }
  if (value.length > maximumLength) {
    fail(path, `must contain at most ${maximumLength} characters`);
  }
  return value;
}

function optionalText(value: unknown, path: string, maximumLength = 256): string | null {
  return value === undefined || value === null ? null : text(value, path, maximumLength);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "must be a finite number");
  }
  return value;
}

function nonNegativeNumber(value: unknown, path: string): number {
  const result = finiteNumber(value, path);
  if (result < 0) {
    fail(path, "must be greater than or equal to zero");
  }
  return result;
}

function optionalNumber(
  value: unknown,
  path: string,
  options: { nonNegative?: boolean; minimum?: number; maximum?: number } = {},
): number | null {
  if (value === undefined || value === null) {
    return null;
  }
  const result = options.nonNegative ? nonNegativeNumber(value, path) : finiteNumber(value, path);
  if (options.minimum !== undefined && result < options.minimum) {
    fail(path, `must be greater than or equal to ${options.minimum}`);
  }
  if (options.maximum !== undefined && result > options.maximum) {
    fail(path, `must be less than or equal to ${options.maximum}`);
  }
  return result;
}

function validIsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (match === null) {
    return false;
  }
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

function parseHello(message: Record<string, unknown>): LiveHelloMessage {
  if (message.schema !== LIVE_PROTOCOL_SCHEMA) {
    fail(
      "message.schema",
      `must equal ${JSON.stringify(LIVE_PROTOCOL_SCHEMA)}`,
      "unsupported-schema",
    );
  }

  const input = record(message.session, "message.session");
  const sampleRateHz = optionalNumber(input.sampleRateHz, "message.session.sampleRateHz", {
    minimum: MIN_LIVE_SAMPLE_RATE_HZ,
    maximum: MAX_LIVE_SAMPLE_RATE_HZ,
  });
  if (sampleRateHz !== null && !Number.isFinite(1 / sampleRateHz)) {
    fail(
      "message.session.sampleRateHz",
      `must be between ${MIN_LIVE_SAMPLE_RATE_HZ} and ${MAX_LIVE_SAMPLE_RATE_HZ} Hz`,
    );
  }
  const startedAt = optionalText(input.startedAt, "message.session.startedAt", 64);
  if (startedAt !== null && !validIsoTimestamp(startedAt)) {
    fail("message.session.startedAt", "must be a valid ISO-8601 date-time");
  }

  return {
    type: "hello",
    schema: LIVE_PROTOCOL_SCHEMA,
    session: {
      id: text(input.id, "message.session.id"),
      source: text(input.source, "message.session.source"),
      name: optionalText(input.name, "message.session.name"),
      robotId: optionalText(input.robotId, "message.session.robotId"),
      sampleRateHz,
      startedAt,
    },
  };
}

function parseSample(message: Record<string, unknown>): LiveSampleMessage {
  const input = record(message.sample, "message.sample");
  const pose = record(input.pose, "message.sample.pose");
  const sequence = optionalNumber(input.sequence, "message.sample.sequence", {
    nonNegative: true,
  });
  if (sequence !== null && !Number.isSafeInteger(sequence)) {
    fail("message.sample.sequence", "must be a safe integer");
  }

  return {
    type: "sample",
    sample: {
      timestamp: nonNegativeNumber(input.timestamp, "message.sample.timestamp"),
      sequence,
      pose: {
        x: finiteNumber(pose.x, "message.sample.pose.x"),
        y: finiteNumber(pose.y, "message.sample.pose.y"),
        yaw: finiteNumber(pose.yaw, "message.sample.pose.yaw"),
      },
      speed: optionalNumber(input.speed, "message.sample.speed"),
      battery: optionalNumber(input.battery, "message.sample.battery", {
        minimum: 0,
        maximum: 100,
      }),
      current: optionalNumber(input.current, "message.sample.current"),
      state: optionalText(input.state, "message.sample.state"),
      latencyMs: optionalNumber(input.latencyMs, "message.sample.latencyMs", {
        nonNegative: true,
      }),
      poseSigma: optionalNumber(input.poseSigma, "message.sample.poseSigma", {
        nonNegative: true,
      }),
    },
  };
}

function parseEvent(message: Record<string, unknown>): LiveEventMessage {
  const input = record(message.event, "message.event");
  const severity = input.severity;
  if (severity !== "info" && severity !== "warning" && severity !== "critical") {
    fail("message.event.severity", 'must be "info", "warning", or "critical"');
  }

  const detailsInput =
    input.details === undefined ? {} : record(input.details, "message.event.details");
  const details: Record<string, LiveEventDetail> = {};
  for (const [key, value] of Object.entries(detailsInput)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    ) {
      fail(`message.event.details.${key}`, "must be a string, number, boolean, or null");
    }
    if (typeof value === "number" && !Number.isFinite(value)) {
      fail(`message.event.details.${key}`, "must be finite");
    }
    details[key] = value;
  }

  return {
    type: "event",
    event: {
      id: text(input.id, "message.event.id"),
      timestamp: nonNegativeNumber(input.timestamp, "message.event.timestamp"),
      kind: text(input.kind, "message.event.kind"),
      severity,
      title: text(input.title, "message.event.title"),
      description: optionalText(input.description, "message.event.description", 2_000),
      details,
    },
  };
}

function parseEnd(message: Record<string, unknown>): LiveEndMessage {
  return {
    type: "end",
    timestamp: optionalNumber(message.timestamp, "message.timestamp", { nonNegative: true }),
    reason: text(message.reason, "message.reason", 512),
  };
}

function decodeJson(input: string): unknown {
  if (new TextEncoder().encode(input).byteLength > MAX_LIVE_MESSAGE_BYTES) {
    fail("message", `must be at most ${MAX_LIVE_MESSAGE_BYTES} bytes`, "message-too-large");
  }
  try {
    return JSON.parse(input) as unknown;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid JSON";
    fail("message", reason, "invalid-json");
  }
}

/**
 * Decode and validate one v2 live message from JSON text, UTF-8 binary data, or
 * an already decoded object. This is the sole decoder used by both WebSocket
 * connections and the deterministic simulator.
 */
export function decodeLiveMessage(input: string | ArrayBuffer | unknown): LiveMessage {
  let value: unknown = input;
  if (typeof input === "string") {
    value = decodeJson(input);
  } else if (input instanceof ArrayBuffer) {
    if (input.byteLength > MAX_LIVE_MESSAGE_BYTES) {
      fail("message", `must be at most ${MAX_LIVE_MESSAGE_BYTES} bytes`, "message-too-large");
    }
    value = decodeJson(new TextDecoder("utf-8", { fatal: true }).decode(input));
  }

  const message = record(value, "message");
  switch (message.type) {
    case "hello":
      return parseHello(message);
    case "sample":
      return parseSample(message);
    case "event":
      return parseEvent(message);
    case "end":
      return parseEnd(message);
    default:
      return fail("message.type", 'must be "hello", "sample", "event", or "end"');
  }
}
