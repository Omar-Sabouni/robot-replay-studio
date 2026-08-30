import {
  LIVE_PROTOCOL_SCHEMA,
  LiveProtocolError,
  decodeLiveMessage,
  type LiveEndMessage,
  type LiveHelloMessage,
  type LiveMessage,
  type LiveSessionDescriptor,
  type LiveStreamEvent,
  type LiveTelemetrySample,
} from "./live-protocol";

export const MAX_LIVE_SAMPLES = 50_000;
export const LIVE_RECONNECT_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000] as const;
/** A WebSocket frame is intentionally smaller than the generic decoder limit. */
export const MAX_LIVE_SOCKET_MESSAGE_BYTES = 256 * 1_024;
export const MAX_LIVE_SOCKET_QUEUE_MESSAGES = 32;
export const MAX_LIVE_SOCKET_QUEUE_BYTES = 1_024 * 1_024;

const MAX_STORED_EVENTS = 128;
const MAX_STORED_GAPS = 2_000;
const MAX_TRACKED_EVENT_IDENTITIES = 50_000;
const DEFAULT_STALE_AFTER_MS = 3_000;
/** Allow three declared sample periods before treating a connected source as stale. */
export const LIVE_STALE_SAMPLE_PERIOD_FACTOR = 3;
/** The admitted 0.05 Hz cadence therefore produces at most a 60-second window. */
export const MAX_LIVE_CADENCE_STALE_AFTER_MS = 60_000;
const DEFAULT_CATCH_UP_BATCH_SIZE = 250;
const MAX_RETAINED_EVENT_DESCRIPTION_CHARACTERS = 1_000;
const MAX_RETAINED_EVENT_DETAIL_ENTRIES = 32;
const MAX_RETAINED_EVENT_DETAIL_KEY_CHARACTERS = 96;
const MAX_RETAINED_EVENT_DETAIL_VALUE_CHARACTERS = 256;
const MAX_RETAINED_EVENT_DETAIL_CHARACTERS = 4_096;
const MAX_REENTRANT_INGEST_MESSAGES = 1_024;

export type LiveConnectionState =
  "disconnected" | "connecting" | "live" | "stale" | "reconnecting" | "complete";

export type LiveGapKind = "sequence" | "timestamp" | "transport" | "retention";

/** A visible interval where source data or locally retained history is absent. */
export interface LiveGap {
  id: string;
  kind: LiveGapKind;
  startTimestamp: number;
  /** Null while a disconnected transport has not delivered its next sample. */
  endTimestamp: number | null;
  startSequence: number | null;
  endSequence: number | null;
  missingSamples: number | null;
  /** Number of old samples deliberately removed by the bounded buffer. */
  droppedSamples: number;
}

export interface LiveTransportSnapshot {
  state: LiveConnectionState;
  session: LiveSessionDescriptor | null;
  samples: readonly LiveTelemetrySample[];
  events: readonly LiveStreamEvent[];
  gaps: readonly LiveGap[];
  end: LiveEndMessage | null;
  paused: boolean;
  catchingUp: boolean;
  pendingSamples: number;
  receivedSamples: number;
  droppedSamples: number;
  receivedEvents: number;
  droppedEvents: number;
  receivedGaps: number;
  droppedGaps: number;
  /** True once any critical source event has been observed, even if its detail was evicted. */
  criticalEver: boolean;
}

export interface LiveReceiveQueueSnapshot {
  queuedMessages: number;
  queuedBytes: number;
  maximumMessages: number;
  maximumBytes: number;
}

export type LiveTransportUpdate =
  | {
      type: "state";
      previous: LiveConnectionState;
      state: LiveConnectionState;
    }
  | {
      type: "hello";
      message: LiveHelloMessage;
    }
  | {
      type: "samples";
      samples: readonly LiveTelemetrySample[];
      catchUp: boolean;
    }
  | {
      type: "event";
      event: LiveStreamEvent;
    }
  | {
      type: "end";
      message: LiveEndMessage;
    }
  | {
      type: "gap";
      gap: LiveGap;
    }
  | {
      type: "delivery";
      paused: boolean;
      catchingUp: boolean;
      pendingSamples: number;
    }
  | {
      type: "error";
      error: Error;
    };

export type LiveTransportListener = (update: LiveTransportUpdate) => void;
export type LiveResumeMode = "catch-up" | "live";

export interface LiveTransport {
  readonly state: LiveConnectionState;
  readonly paused: boolean;
  readonly catchingUp: boolean;
  connect(): void;
  disconnect(): void;
  pauseDelivery(): void;
  resumeDelivery(mode?: LiveResumeMode): void;
  getSnapshot(): LiveTransportSnapshot;
  subscribe(listener: LiveTransportListener): () => void;
}

interface BufferedSample {
  ordinal: number;
  sample: LiveTelemetrySample;
}

class SampleRing {
  private readonly slots: Array<BufferedSample | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.slots = new Array<BufferedSample | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  get first(): BufferedSample | undefined {
    return this.count === 0 ? undefined : this.slots[this.start];
  }

  get last(): BufferedSample | undefined {
    if (this.count === 0) {
      return undefined;
    }
    return this.slots[(this.start + this.count - 1) % this.capacity];
  }

  push(entry: BufferedSample): BufferedSample | undefined {
    if (this.count < this.capacity) {
      this.slots[(this.start + this.count) % this.capacity] = entry;
      this.count += 1;
      return undefined;
    }

    const evicted = this.slots[this.start];
    this.slots[this.start] = entry;
    this.start = (this.start + 1) % this.capacity;
    return evicted;
  }

  entriesAfter(ordinal: number, limit: number): readonly BufferedSample[] {
    const entries: BufferedSample[] = [];
    const first = this.first;
    if (first === undefined) {
      return entries;
    }
    // Retained ordinals are contiguous, so catch-up can begin at the cursor
    // instead of rescanning the ring from its oldest entry for every batch.
    const initialOffset = Math.min(this.count, Math.max(0, ordinal - first.ordinal + 1));
    for (let offset = initialOffset; offset < this.count && entries.length < limit; offset += 1) {
      const entry = this.slots[(this.start + offset) % this.capacity];
      if (entry !== undefined && entry.ordinal > ordinal) {
        entries.push(entry);
      }
    }
    return entries;
  }

  toSamples(): readonly LiveTelemetrySample[] {
    const result: LiveTelemetrySample[] = [];
    for (let offset = 0; offset < this.count; offset += 1) {
      const entry = this.slots[(this.start + offset) % this.capacity];
      if (entry !== undefined) {
        result.push(entry.sample);
      }
    }
    return result;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

interface AppendResult {
  entry: BufferedSample;
  gaps: readonly LiveGap[];
}

function sameTelemetrySample(left: LiveTelemetrySample, right: LiveTelemetrySample): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.sequence === right.sequence &&
    left.pose.x === right.pose.x &&
    left.pose.y === right.pose.y &&
    left.pose.yaw === right.pose.yaw &&
    left.speed === right.speed &&
    left.battery === right.battery &&
    left.current === right.current &&
    left.state === right.state &&
    left.latencyMs === right.latencyMs &&
    left.poseSigma === right.poseSigma
  );
}

function retainSampleForHistory(sample: LiveTelemetrySample): LiveTelemetrySample {
  return Object.freeze({
    ...sample,
    pose: Object.freeze({ ...sample.pose }),
  });
}

function retainEventForHistory(event: LiveStreamEvent): LiveStreamEvent {
  const details = Object.create(null) as Record<string, string | number | boolean | null>;
  let retainedCharacters = 0;
  let retainedEntries = 0;

  for (const [rawKey, rawValue] of Object.entries(event.details)) {
    if (retainedEntries >= MAX_RETAINED_EVENT_DETAIL_ENTRIES) {
      break;
    }
    const key = rawKey.slice(0, MAX_RETAINED_EVENT_DETAIL_KEY_CHARACTERS);
    if (key === "" || Object.hasOwn(details, key)) {
      continue;
    }
    const value =
      typeof rawValue === "string"
        ? rawValue.slice(0, MAX_RETAINED_EVENT_DETAIL_VALUE_CHARACTERS)
        : rawValue;
    const valueCharacters = typeof value === "string" ? value.length : 16;
    const entryCharacters = key.length + valueCharacters;
    if (retainedCharacters + entryCharacters > MAX_RETAINED_EVENT_DETAIL_CHARACTERS) {
      break;
    }
    details[key] = value;
    retainedCharacters += entryCharacters;
    retainedEntries += 1;
  }

  return Object.freeze({
    ...event,
    description:
      event.description === null
        ? null
        : event.description.slice(0, MAX_RETAINED_EVENT_DESCRIPTION_CHARACTERS),
    details: Object.freeze(details),
  });
}

function retainMessageForDeferredIngest(message: LiveMessage): LiveMessage {
  switch (message.type) {
    case "hello":
      return Object.freeze({
        type: "hello",
        schema: message.schema,
        session: Object.freeze({ ...message.session }),
      });
    case "sample":
      return Object.freeze({ type: "sample", sample: retainSampleForHistory(message.sample) });
    case "event":
      return Object.freeze({ type: "event", event: retainEventForHistory(message.event) });
    case "end":
      return Object.freeze({ ...message });
  }
}

class LiveStore {
  readonly samples: SampleRing;
  session: LiveSessionDescriptor | null = null;
  readonly events: LiveStreamEvent[] = [];
  readonly gaps: LiveGap[] = [];
  end: LiveEndMessage | null = null;
  receivedSamples = 0;
  droppedSamples = 0;
  receivedEvents = 0;
  droppedEvents = 0;
  receivedGaps = 0;
  droppedGaps = 0;
  criticalEver = false;

  private nextOrdinal = 1;
  private nextGapId = 1;
  private lastNonNullSequence: number | null = null;
  private maximumEvidenceTimestamp: number | null = null;
  private readonly eventIds = new Set<string>();
  private openTransportGapId: string | null = null;
  private retentionGapId: string | null = null;

  constructor(capacity: number) {
    this.samples = new SampleRing(capacity);
  }

  get hasEnded(): boolean {
    return this.end !== null;
  }

  attachSession(session: LiveSessionDescriptor): LiveSessionDescriptor {
    const changed = this.session !== null && this.session.id !== session.id;
    if (changed) {
      this.clear();
    }
    const retained = Object.freeze({ ...session });
    this.session = retained;
    return retained;
  }

  appendSample(sample: LiveTelemetrySample): AppendResult | null {
    const previous = this.samples.last?.sample;
    if (
      previous !== undefined &&
      this.openTransportGapId !== null &&
      sameTelemetrySample(previous, sample)
    ) {
      // A reconnecting producer may replay its last acknowledged sample. It is
      // safe to accept only an exact replay and it must not affect accounting.
      return null;
    }
    if (previous !== undefined && sample.timestamp <= previous.timestamp) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.sample.timestamp",
        `must be greater than the previous timestamp (${previous.timestamp})`,
      );
    }
    if (
      this.lastNonNullSequence !== null &&
      sample.sequence !== null &&
      sample.sequence <= this.lastNonNullSequence
    ) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.sample.sequence",
        `must be greater than the last non-null sequence (${this.lastNonNullSequence})`,
      );
    }

    const newGaps: LiveGap[] = [];
    const transportGapClosed = this.closeTransportGap(sample);
    if (transportGapClosed !== null) {
      newGaps.push(transportGapClosed);
    } else if (previous !== undefined) {
      const inferred = this.inferSourceGap(previous, sample);
      if (inferred !== null) {
        this.addGap(inferred);
        newGaps.push(inferred);
      }
    }

    const retainedSample = retainSampleForHistory(sample);
    const entry = { ordinal: this.nextOrdinal, sample: retainedSample };
    this.nextOrdinal += 1;
    this.receivedSamples += 1;
    this.maximumEvidenceTimestamp = Math.max(
      this.maximumEvidenceTimestamp ?? sample.timestamp,
      sample.timestamp,
    );
    if (sample.sequence !== null) {
      this.lastNonNullSequence = sample.sequence;
    }
    const evicted = this.samples.push(entry);
    if (evicted !== undefined) {
      this.droppedSamples += 1;
      const retentionGap = this.updateRetentionGap(evicted.sample);
      newGaps.push(retentionGap);
    }
    return { entry, gaps: newGaps };
  }

  appendEvent(event: LiveStreamEvent): LiveStreamEvent {
    const retained = retainEventForHistory(event);
    if (this.eventIds.has(retained.id)) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.event.id",
        "must be unique within the current session",
      );
    }
    if (this.eventIds.size >= MAX_TRACKED_EVENT_IDENTITIES) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.event.id",
        `cannot accept more than ${MAX_TRACKED_EVENT_IDENTITIES} unique event IDs before reset`,
      );
    }
    this.eventIds.add(retained.id);
    this.receivedEvents += 1;
    this.criticalEver ||= retained.severity === "critical";
    this.maximumEvidenceTimestamp = Math.max(
      this.maximumEvidenceTimestamp ?? retained.timestamp,
      retained.timestamp,
    );
    this.events.push(retained);
    if (this.events.length > MAX_STORED_EVENTS) {
      this.events.shift();
      this.droppedEvents += 1;
    }
    return retained;
  }

  markDisconnected(): LiveGap | null {
    const previous = this.samples.last?.sample;
    if (previous === undefined || this.openTransportGapId !== null) {
      return null;
    }
    const gap: LiveGap = Object.freeze({
      id: this.createGapId(),
      kind: "transport",
      startTimestamp: previous.timestamp,
      endTimestamp: null,
      startSequence: previous.sequence,
      endSequence: null,
      missingSamples: null,
      droppedSamples: 0,
    });
    this.openTransportGapId = gap.id;
    this.addGap(gap);
    return gap;
  }

  validateEnd(message: LiveEndMessage): void {
    if (
      message.timestamp !== null &&
      this.maximumEvidenceTimestamp !== null &&
      message.timestamp < this.maximumEvidenceTimestamp
    ) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.timestamp",
        `must be greater than or equal to the maximum observed sample/event timestamp (${this.maximumEvidenceTimestamp})`,
      );
    }
  }

  commitEnd(message: LiveEndMessage): { message: LiveEndMessage; gap: LiveGap | null } {
    const retainedMessage = Object.freeze({ ...message });
    let closedGap: LiveGap | null = null;
    if (message.timestamp !== null && this.openTransportGapId !== null) {
      const index = this.gaps.findIndex((gap) => gap.id === this.openTransportGapId);
      this.openTransportGapId = null;
      const current = this.gaps[index];
      if (index >= 0 && current !== undefined) {
        closedGap = Object.freeze({
          ...current,
          endTimestamp: message.timestamp,
          endSequence: null,
          missingSamples: null,
        });
        this.gaps[index] = closedGap;
      }
    }
    this.end = retainedMessage;
    return { message: retainedMessage, gap: closedGap };
  }

  clear(): void {
    this.samples.clear();
    this.session = null;
    this.events.length = 0;
    this.gaps.length = 0;
    this.end = null;
    this.receivedSamples = 0;
    this.droppedSamples = 0;
    this.receivedEvents = 0;
    this.droppedEvents = 0;
    this.receivedGaps = 0;
    this.droppedGaps = 0;
    this.criticalEver = false;
    this.nextOrdinal = 1;
    this.nextGapId = 1;
    this.lastNonNullSequence = null;
    this.maximumEvidenceTimestamp = null;
    this.eventIds.clear();
    this.openTransportGapId = null;
    this.retentionGapId = null;
  }

  private inferSourceGap(
    previous: LiveTelemetrySample,
    sample: LiveTelemetrySample,
  ): LiveGap | null {
    if (
      previous.sequence !== null &&
      sample.sequence !== null &&
      sample.sequence > previous.sequence + 1
    ) {
      return {
        id: this.createGapId(),
        kind: "sequence",
        startTimestamp: previous.timestamp,
        endTimestamp: sample.timestamp,
        startSequence: previous.sequence,
        endSequence: sample.sequence,
        missingSamples: sample.sequence - previous.sequence - 1,
        droppedSamples: 0,
      };
    }

    const sampleRateHz = this.session?.sampleRateHz;
    // Without sequence numbers or a declared cadence, a slow source is not
    // distinguishable from a dropout. Do not invent missing-data evidence.
    if (sampleRateHz === null || sampleRateHz === undefined) {
      return null;
    }
    const threshold = Math.max(0.25, 3 / sampleRateHz);
    if (sample.timestamp - previous.timestamp > threshold) {
      return {
        id: this.createGapId(),
        kind: "timestamp",
        startTimestamp: previous.timestamp,
        endTimestamp: sample.timestamp,
        startSequence: previous.sequence,
        endSequence: sample.sequence,
        missingSamples: null,
        droppedSamples: 0,
      };
    }
    return null;
  }

  private closeTransportGap(sample: LiveTelemetrySample): LiveGap | null {
    if (this.openTransportGapId === null) {
      return null;
    }
    const index = this.gaps.findIndex((gap) => gap.id === this.openTransportGapId);
    this.openTransportGapId = null;
    if (index < 0) {
      return null;
    }
    const current = this.gaps[index];
    if (current === undefined) {
      return null;
    }
    const closed: LiveGap = Object.freeze({
      ...current,
      endTimestamp: sample.timestamp,
      endSequence: sample.sequence,
      missingSamples:
        current.startSequence === null || sample.sequence === null
          ? null
          : Math.max(0, sample.sequence - current.startSequence - 1),
    });
    this.gaps[index] = closed;
    return closed;
  }

  private updateRetentionGap(evicted: LiveTelemetrySample): LiveGap {
    const retained = this.samples.first?.sample ?? evicted;
    const index = this.gaps.findIndex((gap) => gap.id === this.retentionGapId);
    if (index >= 0) {
      const current = this.gaps[index];
      if (current !== undefined) {
        const updated: LiveGap = Object.freeze({
          ...current,
          endTimestamp: retained.timestamp,
          endSequence: retained.sequence,
          droppedSamples: this.droppedSamples,
        });
        this.gaps[index] = updated;
        return updated;
      }
    }

    const gap: LiveGap = Object.freeze({
      id: this.createGapId(),
      kind: "retention",
      startTimestamp: evicted.timestamp,
      endTimestamp: retained.timestamp,
      startSequence: evicted.sequence,
      endSequence: retained.sequence,
      missingSamples: null,
      droppedSamples: this.droppedSamples,
    });
    this.retentionGapId = gap.id;
    this.addGap(gap);
    return gap;
  }

  private addGap(gap: LiveGap): void {
    this.receivedGaps += 1;
    this.gaps.push(Object.isFrozen(gap) ? gap : Object.freeze(gap));
    if (this.gaps.length <= MAX_STORED_GAPS) {
      return;
    }
    const removed = this.gaps.shift();
    this.droppedGaps += 1;
    if (removed?.id === this.openTransportGapId) {
      this.openTransportGapId = null;
    }
    if (removed?.id === this.retentionGapId) {
      this.retentionGapId = null;
    }
  }

  private createGapId(): string {
    const id = `live-gap-${this.nextGapId}`;
    this.nextGapId += 1;
    return id;
  }
}

export interface LiveDeliveryOptions {
  maximumSamples?: number;
  catchUpBatchSize?: number;
  schedule?: (callback: () => void, delayMs: number) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

function normalizePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function sameSessionDescriptor(left: LiveSessionDescriptor, right: LiveSessionDescriptor): boolean {
  return (
    left.id === right.id &&
    left.source === right.source &&
    left.name === right.name &&
    left.robotId === right.robotId &&
    left.sampleRateHz === right.sampleRateHz &&
    left.startedAt === right.startedAt
  );
}

function defaultSchedule(callback: () => void, delayMs: number): unknown {
  return globalThis.setTimeout(callback, delayMs);
}

function defaultCancel(handle: unknown): void {
  globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
}

/**
 * State/buffer controller shared by built-in and application-specific sources.
 * Custom transports should decode with `decodeLiveMessage`, then call `ingest`.
 */
export class LiveMessageTransport {
  private readonly store: LiveStore;
  private readonly listeners = new Set<LiveTransportListener>();
  private readonly catchUpBatchSize: number;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private connectionState: LiveConnectionState = "disconnected";
  private deliveryPaused = false;
  private catchUpActive = false;
  private deliveryCursor = 0;
  private catchUpHandle: unknown = null;
  private lifecycleVersion = 0;
  private stateVersion = 0;
  private ending = false;
  private resetAfterEnd = false;
  private ingestActive = false;
  private readonly deferredIngest: Array<{ message: LiveMessage; lifecycleVersion: number }> = [];

  constructor(options: LiveDeliveryOptions = {}) {
    const requestedMaximum = normalizePositiveInteger(
      options.maximumSamples ?? MAX_LIVE_SAMPLES,
      "maximumSamples",
    );
    const maximumSamples = Math.min(requestedMaximum, MAX_LIVE_SAMPLES);
    this.store = new LiveStore(maximumSamples);
    this.catchUpBatchSize = normalizePositiveInteger(
      options.catchUpBatchSize ?? DEFAULT_CATCH_UP_BATCH_SIZE,
      "catchUpBatchSize",
    );
    this.schedule = options.schedule ?? defaultSchedule;
    this.cancelScheduled = options.cancelScheduled ?? defaultCancel;
  }

  get state(): LiveConnectionState {
    return this.connectionState;
  }

  get paused(): boolean {
    return this.deliveryPaused;
  }

  get catchingUp(): boolean {
    return this.catchUpActive;
  }

  get session(): LiveSessionDescriptor | null {
    return this.store.session;
  }

  /** Monotonic within one reset boundary; unlike getSnapshot(), this does not copy history. */
  get receivedSampleCount(): number {
    return this.store.receivedSamples;
  }

  get hasEnded(): boolean {
    return this.store.hasEnded;
  }

  transition(state: LiveConnectionState): void {
    if (state === this.connectionState) {
      return;
    }
    const previous = this.connectionState;
    this.connectionState = state;
    this.stateVersion += 1;
    this.notify({ type: "state", previous, state });
  }

  ingest(message: LiveMessage): void {
    if (this.ending) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.type",
        "cannot accept data while the end message is being committed",
      );
    }
    if (this.ingestActive) {
      if (this.deferredIngest.length >= MAX_REENTRANT_INGEST_MESSAGES) {
        throw new LiveProtocolError(
          "invalid-message",
          "message",
          `cannot queue more than ${MAX_REENTRANT_INGEST_MESSAGES} reentrant messages`,
        );
      }
      this.deferredIngest.push({
        message: retainMessageForDeferredIngest(message),
        lifecycleVersion: this.lifecycleVersion,
      });
      return;
    }

    this.ingestActive = true;
    try {
      this.ingestMessage(message);
      while (this.deferredIngest.length > 0) {
        const deferred = this.deferredIngest.shift();
        if (deferred !== undefined && deferred.lifecycleVersion === this.lifecycleVersion) {
          this.ingestMessage(deferred.message);
        }
      }
    } catch (error) {
      this.deferredIngest.length = 0;
      throw error;
    } finally {
      this.ingestActive = false;
    }
  }

  private ingestMessage(message: LiveMessage): void {
    if (this.ending) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.type",
        "cannot accept data while the end message is being committed",
      );
    }
    if (message.type === "hello") {
      const lifecycleVersion = this.lifecycleVersion;
      if (this.connectionState === "complete") {
        throw new LiveProtocolError(
          "invalid-message",
          "message.type",
          "cannot accept hello after end; call reset() before starting another session",
        );
      }
      const activeSession = this.store.session;
      if (activeSession !== null && !sameSessionDescriptor(activeSession, message.session)) {
        throw new LiveProtocolError(
          "invalid-message",
          "message.session",
          "cannot replace the active stream without reset()",
        );
      }
      const retainedSession = this.store.attachSession(message.session);
      const retainedMessage: LiveHelloMessage = Object.freeze({
        type: "hello",
        schema: message.schema,
        session: retainedSession,
      });
      const stateVersion = this.stateVersion;
      const stateChanged = this.connectionState !== "live";
      this.transition("live");
      const expectedStateVersion = stateVersion + (stateChanged ? 1 : 0);
      if (
        lifecycleVersion !== this.lifecycleVersion ||
        expectedStateVersion !== this.stateVersion ||
        this.connectionState !== "live"
      ) {
        return;
      }
      this.notify({
        type: "hello",
        message: retainedMessage,
      });
      return;
    }
    if (this.store.session === null) {
      throw new LiveProtocolError(
        "invalid-message",
        "message.type",
        "a hello message must be accepted before stream data",
      );
    }
    if (this.connectionState === "complete") {
      throw new LiveProtocolError(
        "invalid-message",
        "message.type",
        "cannot accept data after the end message",
      );
    }

    if (message.type === "sample") {
      const lifecycleVersion = this.lifecycleVersion;
      const stateVersion = this.stateVersion;
      const result = this.store.appendSample(message.sample);
      if (result === null) {
        return;
      }
      for (const gap of result.gaps) {
        this.notify({ type: "gap", gap });
        if (lifecycleVersion !== this.lifecycleVersion || stateVersion !== this.stateVersion) {
          return;
        }
      }
      if (lifecycleVersion !== this.lifecycleVersion || stateVersion !== this.stateVersion) {
        return;
      }
      if (!this.deliveryPaused && !this.catchUpActive) {
        this.deliveryCursor = result.entry.ordinal;
        this.notify({ type: "samples", samples: [result.entry.sample], catchUp: false });
      } else {
        this.notifyDelivery();
      }
      return;
    }
    if (message.type === "event") {
      const retainedEvent = this.store.appendEvent(message.event);
      this.notify({ type: "event", event: retainedEvent });
      return;
    }

    // Capture terminal fields before the synchronous catch-up notifications;
    // callers retaining their input object cannot change what gets committed.
    const retainedEndInput: LiveEndMessage = Object.freeze({ ...message });
    this.store.validateEnd(retainedEndInput);
    const lifecycleVersion = this.lifecycleVersion;
    this.ending = true;
    this.flushPendingForEnd(lifecycleVersion);
    if (lifecycleVersion !== this.lifecycleVersion) {
      return;
    }
    const committed = this.store.commitEnd(retainedEndInput);
    if (committed.gap !== null) {
      this.notify({ type: "gap", gap: committed.gap });
    }
    this.transition("complete");
    if (lifecycleVersion !== this.lifecycleVersion) {
      return;
    }
    this.notify({ type: "end", message: committed.message });
    this.ending = false;
    if (this.resetAfterEnd) {
      this.resetAfterEnd = false;
      this.reset();
    }
  }

  markDisconnected(): void {
    const gap = this.store.markDisconnected();
    if (gap !== null) {
      this.notify({ type: "gap", gap });
    }
  }

  report(error: unknown): void {
    this.notify({
      type: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  pauseDelivery(): void {
    if (this.deliveryPaused || this.ending) {
      return;
    }
    this.cancelCatchUp();
    this.deliveryPaused = true;
    this.notifyDelivery();
  }

  resumeDelivery(mode: LiveResumeMode = "catch-up"): void {
    if (this.ending || (!this.deliveryPaused && !this.catchUpActive)) {
      return;
    }
    const lifecycleVersion = this.lifecycleVersion;
    this.deliveryPaused = false;
    if (mode === "live") {
      this.cancelCatchUp();
      this.deliveryCursor = this.store.samples.last?.ordinal ?? this.deliveryCursor;
      this.notifyDelivery();
      return;
    }
    this.catchUpActive = this.pendingSamples() > 0;
    this.notifyDelivery();
    if (this.stateIsComplete()) {
      this.catchUpActive = false;
      return;
    }
    if (this.catchUpActive && lifecycleVersion === this.lifecycleVersion && !this.deliveryPaused) {
      this.scheduleCatchUp();
    }
  }

  getSnapshot(): LiveTransportSnapshot {
    return {
      state: this.connectionState,
      session: this.store.session,
      samples: this.store.samples.toSamples(),
      events: [...this.store.events],
      gaps: [...this.store.gaps],
      end: this.store.end,
      paused: this.deliveryPaused,
      catchingUp: this.catchUpActive,
      pendingSamples: this.pendingSamples(),
      receivedSamples: this.store.receivedSamples,
      droppedSamples: this.store.droppedSamples,
      receivedEvents: this.store.receivedEvents,
      droppedEvents: this.store.droppedEvents,
      receivedGaps: this.store.receivedGaps,
      droppedGaps: this.store.droppedGaps,
      criticalEver: this.store.criticalEver,
    };
  }

  subscribe(listener: LiveTransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    if (this.ending) {
      this.resetAfterEnd = true;
      return;
    }
    this.lifecycleVersion += 1;
    this.ending = false;
    this.resetAfterEnd = false;
    this.cancelCatchUp();
    this.store.clear();
    this.deliveryPaused = false;
    this.deliveryCursor = 0;
    this.transition("disconnected");
    this.notifyDelivery();
  }

  private pendingSamples(): number {
    const firstOrdinal = this.store.samples.first?.ordinal;
    const lastOrdinal = this.store.samples.last?.ordinal;
    if (firstOrdinal === undefined || lastOrdinal === undefined) {
      return 0;
    }
    return Math.max(0, lastOrdinal - Math.max(this.deliveryCursor, firstOrdinal - 1));
  }

  private scheduleCatchUp(): void {
    if (this.catchUpHandle !== null || !this.catchUpActive) {
      return;
    }
    this.catchUpHandle = this.schedule(() => {
      this.catchUpHandle = null;
      this.deliverCatchUpBatch();
    }, 0);
  }

  private deliverCatchUpBatch(): void {
    if (this.deliveryPaused || !this.catchUpActive) {
      return;
    }
    const lifecycleVersion = this.lifecycleVersion;
    const stateVersion = this.stateVersion;
    const firstOrdinal = this.store.samples.first?.ordinal;
    if (firstOrdinal !== undefined && this.deliveryCursor < firstOrdinal - 1) {
      this.deliveryCursor = firstOrdinal - 1;
    }
    const entries = this.store.samples.entriesAfter(this.deliveryCursor, this.catchUpBatchSize);
    if (entries.length > 0) {
      const last = entries[entries.length - 1];
      if (last !== undefined) {
        this.deliveryCursor = last.ordinal;
      }
      this.notify({
        type: "samples",
        samples: entries.map((entry) => entry.sample),
        catchUp: true,
      });
      if (lifecycleVersion !== this.lifecycleVersion || this.deliveryPaused) {
        return;
      }
      if (this.stateIsComplete()) {
        this.catchUpActive = false;
        return;
      }
      if (stateVersion !== this.stateVersion) {
        this.catchUpActive = this.pendingSamples() > 0;
        this.notifyDelivery();
        if (this.stateIsComplete()) {
          this.catchUpActive = false;
          return;
        }
        if (
          this.catchUpActive &&
          lifecycleVersion === this.lifecycleVersion &&
          !this.deliveryPaused
        ) {
          this.scheduleCatchUp();
        }
        return;
      }
    }
    this.catchUpActive = this.pendingSamples() > 0;
    this.notifyDelivery();
    if (this.stateIsComplete()) {
      this.catchUpActive = false;
      return;
    }
    if (this.catchUpActive && lifecycleVersion === this.lifecycleVersion && !this.deliveryPaused) {
      this.scheduleCatchUp();
    }
  }

  private flushPendingForEnd(lifecycleVersion: number): void {
    const terminalOrdinal = this.store.samples.last?.ordinal ?? this.deliveryCursor;
    const hadDeferredDelivery =
      this.deliveryPaused || this.catchUpActive || terminalOrdinal > this.deliveryCursor;
    this.cancelCatchUp();
    this.deliveryPaused = false;

    const firstOrdinal = this.store.samples.first?.ordinal;
    if (firstOrdinal !== undefined && this.deliveryCursor < firstOrdinal - 1) {
      this.deliveryCursor = firstOrdinal - 1;
    }
    this.catchUpActive = this.deliveryCursor < terminalOrdinal;
    while (this.catchUpActive) {
      const entries = this.store.samples
        .entriesAfter(this.deliveryCursor, this.catchUpBatchSize)
        .filter((entry) => entry.ordinal <= terminalOrdinal);
      if (entries.length === 0) {
        break;
      }
      const last = entries[entries.length - 1];
      if (last === undefined) {
        break;
      }
      this.deliveryCursor = last.ordinal;
      this.notify({
        type: "samples",
        samples: entries.map((entry) => entry.sample),
        catchUp: true,
      });
      if (lifecycleVersion !== this.lifecycleVersion) {
        return;
      }
      this.catchUpActive = this.deliveryCursor < terminalOrdinal;
    }
    this.catchUpActive = false;
    if (hadDeferredDelivery) {
      this.notifyDelivery();
    }
  }

  private stateIsComplete(): boolean {
    return this.connectionState === "complete";
  }

  private cancelCatchUp(): void {
    if (this.catchUpHandle !== null) {
      this.cancelScheduled(this.catchUpHandle);
      this.catchUpHandle = null;
    }
    this.catchUpActive = false;
  }

  private notifyDelivery(): void {
    this.notify({
      type: "delivery",
      paused: this.deliveryPaused,
      catchingUp: this.catchUpActive,
      pendingSamples: this.pendingSamples(),
    });
  }

  private notify(update: LiveTransportUpdate): void {
    if (update.type === "samples" && !Object.isFrozen(update.samples)) {
      Object.freeze(update.samples);
    }
    const retainedUpdate = Object.freeze(update);
    for (const listener of this.listeners) {
      try {
        listener(retainedUpdate);
      } catch {
        // A faulty view subscriber must not stop ingestion or reconnect logic.
      }
    }
  }
}

interface LiveSocketOpenEvent {
  readonly type: string;
}

interface LiveSocketMessageEvent {
  readonly data: unknown;
}

interface LiveSocketCloseEvent {
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean;
}

export interface LiveSocket {
  binaryType: "arraybuffer" | "blob";
  onopen: ((event: LiveSocketOpenEvent) => void) | null;
  onmessage: ((event: LiveSocketMessageEvent) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: LiveSocketCloseEvent) => void) | null;
  close(code?: number, reason?: string): void;
}

export type LiveSocketFactory = (url: string, protocols?: string | readonly string[]) => LiveSocket;

export interface WebSocketLiveClientOptions extends LiveDeliveryOptions {
  url: string;
  protocols?: string | readonly string[];
  /**
   * Handshake timeout and minimum sample-freshness window. A declared low-rate
   * cadence can extend this window to three sample periods, capped at 60 s.
   */
  staleAfterMs?: number;
  autoReconnect?: boolean;
  /** Override for tests or non-window runtimes. */
  pageProtocol?: string;
  webSocketFactory?: LiveSocketFactory;
}

/**
 * Validate a user-entered endpoint. Secure pages may only connect to `wss:`;
 * cleartext sockets are restricted to the loopback hosts allowed by the page
 * CSP, and credentials/fragments are rejected in every context.
 */
export function validateLiveWebSocketUrl(
  input: string,
  pageProtocol = typeof location === "undefined" ? "" : location.protocol,
): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new TypeError("The live endpoint must be an absolute ws: or wss: URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new TypeError("The live endpoint must use ws: or wss:");
  }
  if (pageProtocol === "https:" && url.protocol !== "wss:") {
    throw new TypeError("An HTTPS page may only connect to a secure wss: endpoint");
  }
  if (url.protocol === "ws:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new TypeError("A cleartext ws: endpoint must use localhost or 127.0.0.1");
  }
  if (url.username !== "" || url.password !== "") {
    throw new TypeError("Credentials must not be embedded in a live endpoint URL");
  }
  if (url.hash !== "") {
    throw new TypeError("A live endpoint URL must not contain a fragment");
  }
  return url;
}

function defaultSocketFactory(url: string, protocols?: string | readonly string[]): LiveSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("WebSocket is unavailable in this browser");
  }
  const socket =
    protocols === undefined
      ? new WebSocket(url)
      : new WebSocket(url, typeof protocols === "string" ? protocols : [...protocols]);
  return socket as unknown as LiveSocket;
}

async function normalizeSocketData(data: unknown): Promise<string | ArrayBuffer | unknown> {
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    if (data.size > MAX_LIVE_SOCKET_MESSAGE_BYTES) {
      throw new LiveProtocolError(
        "message-too-large",
        "message",
        `must be at most ${MAX_LIVE_SOCKET_MESSAGE_BYTES} bytes`,
      );
    }
    return data.text();
  }
  if (ArrayBuffer.isView(data)) {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }
  return data;
}

function encodedByteLength(value: string): number {
  if (value.length > MAX_LIVE_SOCKET_MESSAGE_BYTES) {
    return MAX_LIVE_SOCKET_MESSAGE_BYTES + 1;
  }
  return new TextEncoder().encode(value).byteLength;
}

function socketDataByteLength(data: unknown): number {
  if (typeof data === "string") {
    return encodedByteLength(data);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }

  // Object input is useful to lightweight socket fakes. Native WebSockets only
  // deliver the string/binary cases above.
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(data);
  } catch {
    throw new LiveProtocolError("invalid-message", "message", "must be JSON serializable");
  }
  if (serialized === undefined) {
    throw new LiveProtocolError("invalid-message", "message", "must contain JSON data");
  }
  return encodedByteLength(serialized);
}

/** Browser-only WebSocket transport with bounded history and capped reconnect backoff. */
export class WebSocketLiveClient implements LiveTransport {
  private readonly core: LiveMessageTransport;
  private readonly url: string;
  private readonly protocols: string | readonly string[] | undefined;
  private readonly staleAfterMs: number;
  private readonly autoReconnect: boolean;
  private readonly socketFactory: LiveSocketFactory;
  private readonly schedule: (callback: () => void, delayMs: number) => unknown;
  private readonly cancelScheduled: (handle: unknown) => void;
  private socket: LiveSocket | null = null;
  private reconnectHandle: unknown = null;
  private staleHandle: unknown = null;
  private reconnectAttempt = 0;
  private generation = 0;
  private stopped = true;
  private completed = false;
  private receivedHello = false;
  private terminalDispatchActive = false;
  private terminalAction: "connect" | "disconnect" | "reset" | null = null;
  private messageQueue: Promise<void> = Promise.resolve();
  private queuedMessages = 0;
  private queuedBytes = 0;

  constructor(options: WebSocketLiveClientOptions) {
    this.url = validateLiveWebSocketUrl(options.url, options.pageProtocol).toString();
    this.protocols = options.protocols;
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs <= 0) {
      throw new RangeError("staleAfterMs must be a finite number greater than zero");
    }
    this.autoReconnect = options.autoReconnect ?? true;
    this.socketFactory = options.webSocketFactory ?? defaultSocketFactory;
    this.schedule = options.schedule ?? defaultSchedule;
    this.cancelScheduled = options.cancelScheduled ?? defaultCancel;
    this.core = new LiveMessageTransport(options);
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

  getReceiveQueueSnapshot(): LiveReceiveQueueSnapshot {
    return {
      queuedMessages: this.queuedMessages,
      queuedBytes: this.queuedBytes,
      maximumMessages: MAX_LIVE_SOCKET_QUEUE_MESSAGES,
      maximumBytes: MAX_LIVE_SOCKET_QUEUE_BYTES,
    };
  }

  connect(): void {
    if (this.terminalDispatchActive) {
      this.terminalAction = "connect";
      return;
    }
    if (
      this.core.state === "connecting" ||
      this.core.state === "live" ||
      this.core.state === "stale" ||
      this.core.state === "reconnecting"
    ) {
      return;
    }
    this.stopped = false;
    this.completed = false;
    this.reconnectAttempt = 0;
    const connectGeneration = this.generation + 1;
    this.generation = connectGeneration;
    if (this.core.state === "complete" || this.core.hasEnded) {
      this.core.reset();
    }
    if (connectGeneration !== this.generation || this.stopped) {
      return;
    }
    this.openSocket(false);
  }

  disconnect(markTransportBoundary = true): void {
    if (this.terminalDispatchActive) {
      this.terminalAction = "disconnect";
      return;
    }
    this.stopped = true;
    this.completed = false;
    this.clearReconnect();
    this.clearStale();
    const disconnectGeneration = this.generation + 1;
    this.generation = disconnectGeneration;
    this.receivedHello = false;
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(1000, "user disconnected");
      } catch (error) {
        this.core.report(error);
      }
    }
    if (!this.socketAttemptIsStopped(disconnectGeneration)) {
      return;
    }
    if (markTransportBoundary && !this.core.hasEnded) {
      this.core.markDisconnected();
      if (!this.socketAttemptIsStopped(disconnectGeneration)) {
        return;
      }
    }
    this.core.transition("disconnected");
  }

  reset(): void {
    if (this.terminalDispatchActive) {
      this.terminalAction = "reset";
      return;
    }
    const resetGeneration = this.generation + 1;
    this.disconnect(false);
    if (!this.socketAttemptIsStopped(resetGeneration)) {
      return;
    }
    this.core.reset();
  }

  pauseDelivery(): void {
    this.core.pauseDelivery();
  }

  resumeDelivery(mode: LiveResumeMode = "catch-up"): void {
    if (this.terminalDispatchActive) {
      return;
    }
    this.core.resumeDelivery(mode);
  }

  getSnapshot(): LiveTransportSnapshot {
    return this.core.getSnapshot();
  }

  subscribe(listener: LiveTransportListener): () => void {
    return this.core.subscribe(listener);
  }

  private openSocket(reconnecting: boolean): void {
    this.clearReconnect();
    this.receivedHello = false;
    const generation = this.generation + 1;
    this.generation = generation;
    const expectedState: LiveConnectionState = reconnecting ? "reconnecting" : "connecting";
    this.core.transition(expectedState);
    if (!this.socketAttemptIsActive(generation, expectedState)) {
      return;
    }

    let socket: LiveSocket;
    try {
      socket = this.socketFactory(this.url, this.protocols);
    } catch (error) {
      if (!this.socketAttemptIsActive(generation, expectedState)) {
        return;
      }
      // Constructor/factory failures are configuration or platform failures;
      // retrying the same inputs forever cannot recover them.
      this.stopped = true;
      this.completed = false;
      this.core.report(error);
      if (generation !== this.generation || !this.stopped) {
        return;
      }
      this.core.transition("disconnected");
      return;
    }
    if (!this.socketAttemptIsActive(generation, expectedState)) {
      try {
        socket.close(1000, "connection attempt canceled");
      } catch {
        // The canceled attempt is already detached from application state.
      }
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.onopen = () => {
      if (generation !== this.generation) {
        return;
      }
      this.armStale(generation);
    };
    socket.onmessage = (event) => {
      this.enqueueSocketMessage(event.data, generation);
    };
    socket.onerror = () => {
      if (generation === this.generation) {
        this.core.report(new Error("The live WebSocket reported a transport error"));
      }
    };
    socket.onclose = (event) => {
      if (generation !== this.generation) {
        return;
      }
      // Invalidate any Blob decoding still queued for this closed connection.
      const reconnectGeneration = this.generation + 1;
      this.generation = reconnectGeneration;
      this.socket = null;
      this.clearStale();
      this.receivedHello = false;
      if (this.completed || this.stopped) {
        return;
      }
      if (!event.wasClean || event.code !== 1000) {
        const suffix = event.reason === "" ? "" : `: ${event.reason}`;
        this.core.report(new Error(`Live WebSocket closed with code ${event.code}${suffix}`));
      }
      if (reconnectGeneration !== this.generation || this.completed || this.stopped) {
        return;
      }
      this.core.markDisconnected();
      if (reconnectGeneration !== this.generation || this.completed || this.stopped) {
        return;
      }
      this.scheduleReconnect();
    };
    // Bound a socket that never reaches `open` as well as an opened socket
    // that never supplies its required hello message. `onopen` rearms this so
    // the protocol handshake receives a fresh full window.
    this.armStale(generation);
  }

  private enqueueSocketMessage(data: unknown, generation: number): void {
    if (generation !== this.generation || this.stopped || this.completed) {
      return;
    }

    let byteLength: number;
    try {
      byteLength = socketDataByteLength(data);
    } catch (error) {
      this.rejectSocketData(error, generation, 1002, "invalid live telemetry");
      return;
    }
    if (byteLength > MAX_LIVE_SOCKET_MESSAGE_BYTES) {
      this.rejectSocketData(
        new LiveProtocolError(
          "message-too-large",
          "message",
          `must be at most ${MAX_LIVE_SOCKET_MESSAGE_BYTES} bytes`,
        ),
        generation,
        1009,
        "live message too large",
      );
      return;
    }
    if (
      this.queuedMessages >= MAX_LIVE_SOCKET_QUEUE_MESSAGES ||
      this.queuedBytes + byteLength > MAX_LIVE_SOCKET_QUEUE_BYTES
    ) {
      this.rejectSocketData(
        new Error(
          `Live receive queue exceeded ${MAX_LIVE_SOCKET_QUEUE_MESSAGES} messages or ` +
            `${MAX_LIVE_SOCKET_QUEUE_BYTES} bytes`,
        ),
        generation,
        1008,
        "live receive queue full",
      );
      return;
    }

    this.queuedMessages += 1;
    this.queuedBytes += byteLength;
    const process = async (): Promise<void> => {
      try {
        await this.processSocketMessage(data, generation);
      } finally {
        this.queuedMessages = Math.max(0, this.queuedMessages - 1);
        this.queuedBytes = Math.max(0, this.queuedBytes - byteLength);
      }
    };
    // The rejection handler keeps one unexpected task failure from wedging all
    // later accounting. Normal decode failures are handled inside the task.
    this.messageQueue = this.messageQueue.then(process, process);
  }

  private async processSocketMessage(data: unknown, generation: number): Promise<void> {
    try {
      if (generation !== this.generation) {
        return;
      }
      const normalized = await normalizeSocketData(data);
      if (generation !== this.generation) {
        return;
      }
      const message = decodeLiveMessage(normalized);
      if (!this.receivedHello && message.type !== "hello") {
        throw new LiveProtocolError(
          "invalid-message",
          "message.type",
          "the first message on a connection must be hello",
        );
      }
      if (message.type === "hello") {
        if (this.receivedHello) {
          throw new LiveProtocolError(
            "invalid-message",
            "message.type",
            "hello may only appear once per connection",
          );
        }
        this.receivedHello = true;
      }
      if (message.type === "end") {
        // Detach and commit the old connection before synchronous terminal
        // listeners can request a replacement. Lifecycle requests are applied
        // only after every completion/end listener has observed the old run.
        const completedSocket = this.socket;
        this.socket = null;
        this.completed = true;
        this.stopped = true;
        this.generation += 1;
        this.clearStale();
        this.receivedHello = false;
        if (completedSocket !== null) {
          completedSocket.onopen = null;
          completedSocket.onmessage = null;
          completedSocket.onerror = null;
          completedSocket.onclose = null;
        }
        this.terminalDispatchActive = true;
        let terminalError: unknown = null;
        try {
          this.core.ingest(message);
        } catch (error) {
          terminalError = error;
        } finally {
          this.terminalDispatchActive = false;
        }
        try {
          completedSocket?.close(1000, "stream complete");
        } catch (error) {
          this.core.report(error);
        }
        const terminalAction = this.terminalAction;
        this.terminalAction = null;
        if (terminalError !== null) {
          this.completed = false;
          const failedTerminalGeneration = this.generation;
          this.core.report(terminalError);
          if (!this.socketAttemptIsStopped(failedTerminalGeneration)) {
            return;
          }
          this.core.markDisconnected();
          if (!this.socketAttemptIsStopped(failedTerminalGeneration)) {
            return;
          }
          this.core.transition("disconnected");
        } else if (terminalAction === "connect") {
          this.connect();
        } else if (terminalAction === "disconnect") {
          this.disconnect();
        } else if (terminalAction === "reset") {
          this.reset();
        }
        return;
      }
      const receivedSamplesBefore = this.core.receivedSampleCount;
      this.core.ingest(message);
      if (
        message.type === "hello" &&
        generation === this.generation &&
        !this.completed &&
        !this.stopped
      ) {
        // The socket-open timer is only a handshake bound. Once the source has
        // declared its cadence, wait long enough for a conforming first sample.
        this.armStale(generation);
      }
      const retainedSample =
        message.type === "sample" && this.core.receivedSampleCount > receivedSamplesBefore;
      if (retainedSample && generation === this.generation && !this.completed && !this.stopped) {
        if (this.core.state === "stale") {
          this.core.transition("live");
        }
        if (generation !== this.generation || this.completed || this.stopped) {
          return;
        }
        this.reconnectAttempt = 0;
        this.armStale(generation);
      }
    } catch (error) {
      const closeCode =
        error instanceof LiveProtocolError && error.code === "message-too-large" ? 1009 : 1002;
      const closeReason = closeCode === 1009 ? "live message too large" : "invalid live telemetry";
      this.rejectSocketData(error, generation, closeCode, closeReason);
    }
  }

  private rejectSocketData(
    error: unknown,
    generation: number,
    closeCode: number,
    closeReason: string,
  ): void {
    if (generation !== this.generation) {
      return;
    }
    this.stopped = true;
    this.completed = false;
    this.clearReconnect();
    this.clearStale();
    const rejectionGeneration = this.generation + 1;
    this.generation = rejectionGeneration;
    this.receivedHello = false;

    const socket = this.socket;
    let socketCloseError: unknown = null;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      try {
        socket.close(closeCode, closeReason);
      } catch (closeError) {
        socketCloseError = closeError;
      }
    }
    this.core.report(error);
    if (!this.socketAttemptIsStopped(rejectionGeneration)) {
      return;
    }
    if (socketCloseError !== null) {
      this.core.report(socketCloseError);
      if (!this.socketAttemptIsStopped(rejectionGeneration)) {
        return;
      }
    }
    this.core.markDisconnected();
    if (!this.socketAttemptIsStopped(rejectionGeneration)) {
      return;
    }
    this.core.transition("disconnected");
  }

  private armStale(generation: number): void {
    this.clearStale();
    this.staleHandle = this.schedule(() => {
      this.staleHandle = null;
      if (
        generation === this.generation &&
        !this.completed &&
        !this.stopped &&
        (this.core.state === "connecting" ||
          this.core.state === "reconnecting" ||
          this.core.state === "live")
      ) {
        this.core.transition("stale");
        if (
          generation !== this.generation ||
          this.completed ||
          this.stopped ||
          !this.coreStateIs("stale")
        ) {
          return;
        }
        const staleSocket = this.socket;
        this.socket = null;
        const reconnectGeneration = this.generation + 1;
        this.generation = reconnectGeneration;
        this.receivedHello = false;
        if (staleSocket !== null) {
          staleSocket.onopen = null;
          staleSocket.onmessage = null;
          staleSocket.onerror = null;
          staleSocket.onclose = null;
          try {
            staleSocket.close(4000, "sample freshness timeout");
          } catch (error) {
            this.core.report(error);
          }
        }
        if (reconnectGeneration !== this.generation || this.completed || this.stopped) {
          return;
        }
        this.core.markDisconnected();
        if (reconnectGeneration !== this.generation || this.completed || this.stopped) {
          return;
        }
        this.scheduleReconnect();
      }
    }, this.freshnessTimeoutMs());
  }

  private freshnessTimeoutMs(): number {
    const sampleRateHz = this.core.session?.sampleRateHz;
    if (sampleRateHz === null || sampleRateHz === undefined) {
      return this.staleAfterMs;
    }
    const cadenceWindowMs = Math.min(
      MAX_LIVE_CADENCE_STALE_AFTER_MS,
      (LIVE_STALE_SAMPLE_PERIOD_FACTOR * 1_000) / sampleRateHz,
    );
    // `staleAfterMs` remains an operator-selectable lower bound. The cadence
    // extension never makes an explicitly more tolerant configuration stricter.
    return Math.max(this.staleAfterMs, cadenceWindowMs);
  }

  private socketAttemptIsActive(generation: number, expectedState: LiveConnectionState): boolean {
    return (
      generation === this.generation &&
      !this.stopped &&
      !this.completed &&
      this.core.state === expectedState
    );
  }

  private coreStateIs(state: LiveConnectionState): boolean {
    return this.core.state === state;
  }

  private socketAttemptIsStopped(generation: number): boolean {
    return generation === this.generation && this.stopped && !this.completed;
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.completed || !this.autoReconnect) {
      this.core.transition("disconnected");
      return;
    }
    const delayIndex = Math.min(this.reconnectAttempt, LIVE_RECONNECT_DELAYS_MS.length - 1);
    const delay = LIVE_RECONNECT_DELAYS_MS[delayIndex] ?? LIVE_RECONNECT_DELAYS_MS[0];
    this.reconnectAttempt += 1;
    const generation = this.generation;
    this.core.transition("reconnecting");
    if (
      generation !== this.generation ||
      this.stopped ||
      this.completed ||
      !this.coreStateIs("reconnecting")
    ) {
      return;
    }
    this.reconnectHandle = this.schedule(() => {
      this.reconnectHandle = null;
      if (
        generation === this.generation &&
        !this.stopped &&
        !this.completed &&
        this.coreStateIs("reconnecting")
      ) {
        this.openSocket(true);
      }
    }, delay);
  }

  private clearReconnect(): void {
    if (this.reconnectHandle !== null) {
      this.cancelScheduled(this.reconnectHandle);
      this.reconnectHandle = null;
    }
  }

  private clearStale(): void {
    if (this.staleHandle !== null) {
      this.cancelScheduled(this.staleHandle);
      this.staleHandle = null;
    }
  }
}

/**
 * Utility for custom transports and tests that need exactly the canonical hello
 * payload without duplicating the protocol identifier.
 */
export function createLiveHello(session: LiveSessionDescriptor): LiveHelloMessage {
  return {
    type: "hello",
    schema: LIVE_PROTOCOL_SCHEMA,
    session,
  };
}
