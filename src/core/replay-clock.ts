import type { ReplayClockSnapshot } from "./types";

export type MonotonicNow = () => number;

export interface ReplayClockOptions {
  /** Replay duration in seconds. */
  duration: number;
  initialTime?: number;
  playbackRate?: number;
  /** Monotonic time source in milliseconds, normally performance.now(). */
  now?: MonotonicNow;
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function requireFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number greater than or equal to zero`);
  }
}

function requirePlaybackRate(value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError("playbackRate must be a finite number greater than zero");
  }
}

/**
 * Deterministic replay timekeeper with an injectable monotonic clock. It has no
 * browser event-loop dependency: callers decide when to call `tick()`.
 */
export class ReplayClock {
  private readonly now: MonotonicNow;
  private lastUpdateMs: number;
  private timeSeconds: number;
  private durationSeconds: number;
  private rate: number;
  private playing = false;

  constructor(options: ReplayClockOptions) {
    requireFiniteNonNegative(options.duration, "duration");
    requireFiniteNonNegative(options.initialTime ?? 0, "initialTime");
    requirePlaybackRate(options.playbackRate ?? 1);

    this.durationSeconds = options.duration;
    this.timeSeconds = this.clamp(options.initialTime ?? 0);
    this.rate = options.playbackRate ?? 1;
    this.now = options.now ?? defaultNow;
    this.lastUpdateMs = this.readNow();
  }

  get currentTime(): number {
    return this.tick().currentTime;
  }

  get duration(): number {
    return this.durationSeconds;
  }

  get playbackRate(): number {
    return this.rate;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  get progress(): number {
    const currentTime = this.currentTime;
    return this.durationSeconds === 0 ? 0 : currentTime / this.durationSeconds;
  }

  play(nowMs = this.readNow()): ReplayClockSnapshot {
    const snapshot = this.tick(nowMs);
    if (this.durationSeconds === 0) {
      return snapshot;
    }
    if (this.timeSeconds >= this.durationSeconds) {
      this.timeSeconds = 0;
    }
    this.lastUpdateMs = nowMs;
    this.playing = true;
    return this.snapshot();
  }

  pause(nowMs = this.readNow()): ReplayClockSnapshot {
    this.tick(nowMs);
    this.playing = false;
    return this.snapshot();
  }

  toggle(nowMs = this.readNow()): ReplayClockSnapshot {
    return this.playing ? this.pause(nowMs) : this.play(nowMs);
  }

  seek(timeSeconds: number, nowMs = this.readNow()): ReplayClockSnapshot {
    requireFiniteNonNegative(timeSeconds, "timeSeconds");
    this.requireMonotonicAnchor(nowMs);
    this.timeSeconds = this.clamp(timeSeconds);
    this.lastUpdateMs = nowMs;
    if (this.timeSeconds >= this.durationSeconds) {
      this.playing = false;
    }
    return this.snapshot();
  }

  /** A step always pauses playback, matching frame-step controls in replay tools. */
  step(deltaSeconds: number, nowMs = this.readNow()): ReplayClockSnapshot {
    if (!Number.isFinite(deltaSeconds)) {
      throw new RangeError("deltaSeconds must be finite");
    }
    this.tick(nowMs);
    this.playing = false;
    this.timeSeconds = this.clamp(this.timeSeconds + deltaSeconds);
    this.lastUpdateMs = nowMs;
    return this.snapshot();
  }

  setPlaybackRate(playbackRate: number, nowMs = this.readNow()): ReplayClockSnapshot {
    requirePlaybackRate(playbackRate);
    this.tick(nowMs);
    this.rate = playbackRate;
    this.lastUpdateMs = nowMs;
    return this.snapshot();
  }

  setDuration(duration: number, nowMs = this.readNow()): ReplayClockSnapshot {
    requireFiniteNonNegative(duration, "duration");
    this.tick(nowMs);
    this.durationSeconds = duration;
    this.timeSeconds = this.clamp(this.timeSeconds);
    if (this.timeSeconds >= this.durationSeconds) {
      this.playing = false;
    }
    this.lastUpdateMs = nowMs;
    return this.snapshot();
  }

  reset(): ReplayClockSnapshot {
    this.playing = false;
    this.timeSeconds = 0;
    this.lastUpdateMs = this.readNow();
    return this.snapshot();
  }

  tick(nowMs = this.readNow()): ReplayClockSnapshot {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("the monotonic clock must return a finite number");
    }
    if (nowMs < this.lastUpdateMs) {
      throw new RangeError("the monotonic clock cannot move backwards");
    }

    if (this.playing) {
      const elapsedSeconds = (nowMs - this.lastUpdateMs) / 1_000;
      this.timeSeconds = this.clamp(this.timeSeconds + elapsedSeconds * this.rate);
      if (this.timeSeconds >= this.durationSeconds) {
        this.playing = false;
      }
    }
    this.lastUpdateMs = nowMs;
    return this.snapshot();
  }

  private snapshot(): ReplayClockSnapshot {
    return {
      currentTime: this.timeSeconds,
      duration: this.durationSeconds,
      progress: this.durationSeconds === 0 ? 0 : this.timeSeconds / this.durationSeconds,
      playbackRate: this.rate,
      playing: this.playing,
    };
  }

  private clamp(value: number): number {
    return Math.max(0, Math.min(this.durationSeconds, value));
  }

  private readNow(): number {
    const value = this.now?.() ?? defaultNow();
    if (!Number.isFinite(value)) {
      throw new RangeError("the monotonic clock must return a finite number");
    }
    return value;
  }

  private requireMonotonicAnchor(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("the monotonic clock must return a finite number");
    }
    if (nowMs < this.lastUpdateMs) {
      throw new RangeError("the monotonic clock cannot move backwards");
    }
  }
}
