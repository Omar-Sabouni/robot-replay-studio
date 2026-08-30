import {
  LIVE_PROTOCOL_SCHEMA,
  MIN_LIVE_SAMPLE_RATE_HZ,
  decodeLiveMessage,
  type LiveEventMessage,
  type LiveHelloMessage,
  type LiveMessage,
  type LiveSampleMessage,
  type LiveStreamEvent,
} from "./live-protocol";
import {
  LiveMessageTransport,
  MAX_LIVE_SAMPLES,
  type LiveConnectionState,
  type LiveDeliveryOptions,
  type LiveResumeMode,
  type LiveTransport,
  type LiveTransportListener,
  type LiveTransportSnapshot,
} from "./live-transport";

const DEFAULT_SAMPLE_RATE_HZ = 20;
const DEFAULT_DURATION_SECONDS = 45;
const LOCALIZATION_RESET_TIMESTAMP = 19.1;
const SAFE_STOP_TIMESTAMP = 22.4;

export interface LiveSimulatorScenarioOptions {
  sampleRateHz?: number;
  durationSeconds?: number;
  sessionId?: string;
  sessionName?: string;
  robotId?: string;
}

export interface DeterministicLiveSimulatorOptions
  extends LiveSimulatorScenarioOptions, LiveDeliveryOptions {
  /** Wall-clock acceleration. A value of 10 emits ten session seconds per second. */
  playbackRate?: number;
}

function finitePositive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a finite number greater than zero`);
  }
  return value;
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function sampleAt(timestamp: number, sequence: number): LiveSampleMessage {
  const localizationFault = timestamp >= LOCALIZATION_RESET_TIMESTAMP;
  const safeStop = timestamp >= SAFE_STOP_TIMESTAMP;
  const controlSaturation = timestamp >= 20.4 && !safeStop;
  const recoveryAge = Math.max(0, timestamp - LOCALIZATION_RESET_TIMESTAMP);
  const poseTimestamp = Math.min(timestamp, SAFE_STOP_TIMESTAMP);
  const poseRecoveryAge = Math.max(0, poseTimestamp - LOCALIZATION_RESET_TIMESTAMP);
  const poseHasLocalizationFault = poseTimestamp >= LOCALIZATION_RESET_TIMESTAMP;
  const lateralOffset = poseHasLocalizationFault ? 1.15 * Math.exp(-poseRecoveryAge / 5.5) : 0;
  const longitudinalOffset = poseHasLocalizationFault ? 0.58 * Math.exp(-poseRecoveryAge / 4.5) : 0;
  const latencyMs =
    timestamp < 16.8
      ? 28 + 5 * Math.sin(timestamp * 0.8)
      : timestamp < 18
        ? 35 + ((timestamp - 16.8) / 1.2) * 430
        : timestamp < 19.1
          ? 465
          : 42 + 60 * Math.exp(-(timestamp - 19.1) / 1.8);
  const state = safeStop
    ? "safe-stop"
    : controlSaturation
      ? "control-limited"
      : localizationFault
        ? "localization-recovery"
        : "autonomous";

  return {
    type: "sample",
    sample: {
      // Keep the source timestamp exact. Rounding can place the final sample
      // just beyond an otherwise valid configured terminal duration.
      timestamp,
      sequence,
      pose: {
        x: round(poseTimestamp * 0.42 + longitudinalOffset),
        y: round(0.32 * Math.sin(poseTimestamp / 4.8) + lateralOffset),
        yaw: round(0.065 * Math.cos(poseTimestamp / 4.8) + (poseHasLocalizationFault ? 0.28 : 0)),
      },
      speed: safeStop ? 0 : round(0.76 + 0.08 * Math.sin(timestamp / 3.2)),
      battery: round(Math.max(0, 92 - timestamp * 0.045), 3),
      current: safeStop
        ? 2.1
        : controlSaturation
          ? round(22.5 + 2.8 * Math.sin(timestamp * 5))
          : round(6.4 + 1.2 * Math.sin(timestamp * 1.4)),
      state,
      latencyMs: round(latencyMs, 2),
      poseSigma: round(localizationFault ? 0.08 + 0.68 * Math.exp(-recoveryAge / 5) : 0.045),
    },
  };
}

function simulatorEvents(durationSeconds: number): readonly LiveStreamEvent[] {
  const events: LiveStreamEvent[] = [
    {
      id: "sim-link-degradation",
      timestamp: 16.8,
      kind: "link-degradation",
      severity: "warning",
      title: "Telemetry latency rising",
      description: "End-to-end latency crossed the 250 ms investigation threshold.",
      details: { thresholdMs: 250, peakMs: 465 },
    },
    {
      id: "sim-localization-reset",
      timestamp: LOCALIZATION_RESET_TIMESTAMP,
      kind: "localization-reset",
      severity: "critical",
      title: "Localization reset",
      description: "The estimated pose shifted after the telemetry dropout.",
      details: { translationMetres: 1.29, headingRadians: 0.28 },
    },
    {
      id: "sim-control-saturation",
      timestamp: 20.4,
      kind: "control-saturation",
      severity: "warning",
      title: "Motor load elevated",
      description: "Corrective steering pushed motor current above its operating threshold.",
      details: { thresholdAmps: 18 },
    },
    {
      id: "sim-safe-stop",
      timestamp: SAFE_STOP_TIMESTAMP,
      kind: "safe-stop",
      severity: "critical",
      title: "Safety stop engaged",
      description: "The autonomy controller stopped the robot inside the safety envelope.",
      details: { commandedSpeed: 0 },
    },
  ];
  return events.filter((event) => event.timestamp <= durationSeconds);
}

function canonical(message: LiveMessage): LiveMessage {
  // Deliberately exercise the same JSON decoder used by external WebSockets.
  return decodeLiveMessage(JSON.stringify(message));
}

/**
 * Build the deterministic warehouse-AMR stream used by the browser simulator.
 * No random input, external file, timer, or network source affects this output.
 */
export function createDeterministicLiveMessages(
  options: LiveSimulatorScenarioOptions = {},
): readonly LiveMessage[] {
  const sampleRateHz = finitePositive(
    options.sampleRateHz ?? DEFAULT_SAMPLE_RATE_HZ,
    "sampleRateHz",
  );
  const durationSeconds = finitePositive(
    options.durationSeconds ?? DEFAULT_DURATION_SECONDS,
    "durationSeconds",
  );
  if (sampleRateHz > 240) {
    throw new RangeError("sampleRateHz must be less than or equal to 240");
  }
  if (sampleRateHz < MIN_LIVE_SAMPLE_RATE_HZ || !Number.isFinite(1 / sampleRateHz)) {
    throw new RangeError(
      `sampleRateHz must be greater than or equal to ${MIN_LIVE_SAMPLE_RATE_HZ}`,
    );
  }
  if (durationSeconds > 3_600) {
    throw new RangeError("durationSeconds must be less than or equal to 3600");
  }
  const sampleSlotCount = Math.floor(durationSeconds * sampleRateHz) + 1;
  if (!Number.isSafeInteger(sampleSlotCount) || sampleSlotCount > MAX_LIVE_SAMPLES) {
    throw new RangeError(
      `sampleRateHz and durationSeconds must define at most ${MAX_LIVE_SAMPLES} sample slots`,
    );
  }

  const hello: LiveHelloMessage = {
    type: "hello",
    schema: LIVE_PROTOCOL_SCHEMA,
    session: {
      id: options.sessionId ?? "warehouse-amr-incident-live",
      source: "Robot Replay Studio Live Simulator",
      name: options.sessionName ?? "Warehouse AMR — localization incident",
      robotId: options.robotId ?? "AMR-07",
      sampleRateHz,
      startedAt: null,
    },
  };
  const messages: LiveMessage[] = [canonical(hello)];
  const events = simulatorEvents(durationSeconds);
  let nextEvent = 0;
  const finalIndex = sampleSlotCount - 1;

  for (let index = 0; index <= finalIndex; index += 1) {
    const timestamp = index / sampleRateHz;
    while (events[nextEvent] !== undefined && (events[nextEvent]?.timestamp ?? 0) <= timestamp) {
      const event = events[nextEvent];
      if (event !== undefined) {
        const eventMessage: LiveEventMessage = { type: "event", event };
        messages.push(canonical(eventMessage));
      }
      nextEvent += 1;
    }

    // The missing interval is intentional. Sequence numbers continue so the
    // shared transport records it as evidence rather than interpolating it.
    if (timestamp >= 18 && timestamp < 18.7) {
      continue;
    }
    messages.push(canonical(sampleAt(timestamp, index)));
  }

  while (events[nextEvent] !== undefined) {
    const event = events[nextEvent];
    if (event !== undefined) {
      messages.push(canonical({ type: "event", event }));
    }
    nextEvent += 1;
  }
  messages.push(
    canonical({
      type: "end",
      timestamp: Math.max(durationSeconds, finalIndex / sampleRateHz),
      reason: "Stream complete",
    }),
  );
  return messages;
}

function messageTimestamp(message: LiveMessage): number | null {
  switch (message.type) {
    case "sample":
      return message.sample.timestamp;
    case "event":
      return message.event.timestamp;
    case "end":
      return message.timestamp;
    default:
      return null;
  }
}

/** A local stream source with the same decoder, buffer, and pause semantics as WebSocket. */
export class DeterministicLiveSimulator implements LiveTransport {
  private readonly core: LiveMessageTransport;
  private readonly messages: readonly LiveMessage[];
  private readonly playbackRate: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private timerHandle: unknown = null;
  private messageIndex = 0;
  private previousTimestamp = 0;
  private running = false;
  private generation = 0;
  private dispatchActive = false;
  private dispatchTerminal = false;
  private deferredAction: "restart" | "disconnect" | null = null;

  constructor(options: DeterministicLiveSimulatorOptions = {}) {
    this.playbackRate = finitePositive(options.playbackRate ?? 1, "playbackRate");
    this.schedule =
      options.schedule ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
    this.cancelScheduled =
      options.cancelScheduled ??
      ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
    this.core = new LiveMessageTransport(options);
    this.messages = createDeterministicLiveMessages(options);
  }

  get state(): LiveConnectionState {
    return this.core.state;
  }

  get paused(): boolean {
    return this.core.paused;
  }

  get catchingUp(): boolean {
    return this.core.catchingUp;
  }

  connect(): void {
    if (this.dispatchActive) {
      if (this.dispatchTerminal || this.deferredAction === "disconnect") {
        this.deferredAction = "restart";
      }
      return;
    }
    if (this.running || this.core.state === "live" || this.core.state === "connecting") {
      return;
    }
    if (this.messageIndex > 0 || this.core.state === "complete") {
      this.restart();
      return;
    }
    this.generation += 1;
    this.running = true;
    this.core.transition("connecting");
    this.scheduleNext(0);
  }

  disconnect(): void {
    if (this.dispatchActive) {
      this.deferredAction = "disconnect";
      return;
    }
    this.generation += 1;
    this.running = false;
    this.clearTimer();
    this.core.transition("disconnected");
  }

  restart(): void {
    if (this.dispatchActive) {
      this.deferredAction = "restart";
      return;
    }
    this.running = false;
    this.clearTimer();
    this.messageIndex = 0;
    this.previousTimestamp = 0;
    const restartGeneration = this.generation + 1;
    this.generation = restartGeneration;
    this.core.reset();
    if (
      restartGeneration !== this.generation ||
      this.running ||
      this.core.state !== "disconnected"
    ) {
      return;
    }
    this.connect();
  }

  pauseDelivery(): void {
    this.core.pauseDelivery();
  }

  resumeDelivery(mode: LiveResumeMode = "catch-up"): void {
    this.core.resumeDelivery(mode);
  }

  getSnapshot(): LiveTransportSnapshot {
    return this.core.getSnapshot();
  }

  subscribe(listener: LiveTransportListener): () => void {
    return this.core.subscribe(listener);
  }

  private scheduleNext(delayMs: number): void {
    if (!this.running || this.timerHandle !== null) {
      return;
    }
    const generation = this.generation;
    this.timerHandle = this.schedule(() => {
      this.timerHandle = null;
      if (generation === this.generation) {
        this.emitNext(generation);
      }
    }, delayMs);
  }

  private emitNext(generation: number): void {
    if (!this.running || generation !== this.generation) {
      return;
    }
    const sourceMessage = this.messages[this.messageIndex];
    if (sourceMessage === undefined) {
      this.running = false;
      return;
    }

    // Serialize and decode at delivery time too, guarding against future demo
    // generator changes that accidentally diverge from the wire contract.
    const message = decodeLiveMessage(JSON.stringify(sourceMessage));
    const terminal = message.type === "end";
    if (terminal) {
      // Commit the old run before terminal callbacks can synchronously restart.
      this.messageIndex += 1;
      const timestamp = messageTimestamp(message);
      if (timestamp !== null) {
        this.previousTimestamp = timestamp;
      }
      this.running = false;
    }
    if (terminal) {
      this.dispatchActive = true;
      this.dispatchTerminal = true;
      let terminalError: unknown = null;
      try {
        this.core.ingest(message);
      } catch (error) {
        terminalError = error;
      } finally {
        this.dispatchActive = false;
        this.dispatchTerminal = false;
      }
      const terminalAction = this.deferredAction;
      this.deferredAction = null;
      if (terminalError !== null) {
        this.core.report(terminalError);
        this.disconnect();
      } else if (terminalAction === "restart") {
        this.restart();
      } else if (terminalAction === "disconnect") {
        this.disconnect();
      }
      return;
    }
    this.dispatchActive = true;
    this.dispatchTerminal = false;
    let dispatchError: unknown = null;
    try {
      this.core.ingest(message);
    } catch (error) {
      dispatchError = error;
    } finally {
      this.dispatchActive = false;
    }
    const deferredAction = this.deferredAction;
    this.deferredAction = null;
    if (dispatchError !== null) {
      this.core.report(dispatchError);
      this.disconnect();
      return;
    }
    if (deferredAction === "restart") {
      this.restart();
      return;
    }
    if (deferredAction === "disconnect") {
      this.disconnect();
      return;
    }
    if (!this.running || generation !== this.generation) {
      return;
    }
    this.messageIndex += 1;
    const timestamp = messageTimestamp(message);
    if (timestamp !== null) {
      this.previousTimestamp = timestamp;
    }
    const next = this.messages[this.messageIndex];
    const nextTimestamp = next === undefined ? null : messageTimestamp(next);
    const sessionDelay =
      nextTimestamp === null ? 0 : Math.max(0, nextTimestamp - this.previousTimestamp);
    this.scheduleNext((sessionDelay * 1_000) / this.playbackRate);
  }

  private clearTimer(): void {
    if (this.timerHandle !== null) {
      this.cancelScheduled(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
