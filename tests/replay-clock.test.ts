import { describe, expect, it } from "vitest";

import { ReplayClock } from "../src/core/replay-clock";

function manualClock(initial = 1_000): {
  now: () => number;
  advance: (milliseconds: number) => void;
} {
  let time = initial;
  return {
    now: () => time,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe("ReplayClock", () => {
  it("starts paused and advances only while playing", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 10, initialTime: 2, now: source.now });

    source.advance(2_000);
    expect(clock.currentTime).toBe(2);
    expect(clock.isPlaying).toBe(false);

    clock.play();
    source.advance(1_500);
    expect(clock.currentTime).toBeCloseTo(3.5);
    expect(clock.isPlaying).toBe(true);

    clock.pause();
    source.advance(2_000);
    expect(clock.currentTime).toBeCloseTo(3.5);
  });

  it("changes rate without losing elapsed time", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 20, now: source.now });

    clock.play();
    source.advance(1_000);
    clock.setPlaybackRate(2);
    source.advance(1_500);

    expect(clock.currentTime).toBeCloseTo(4);
    expect(clock.playbackRate).toBe(2);
  });

  it("anchors a seek performed during playback", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 20, now: source.now });

    clock.play();
    source.advance(2_000);
    clock.seek(8);
    source.advance(500);

    expect(clock.currentTime).toBeCloseTo(8.5);
  });

  it("pauses when stepping and clamps at both ends", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 3, initialTime: 1, now: source.now });

    clock.play();
    source.advance(500);
    expect(clock.step(0.25)).toMatchObject({ currentTime: 1.75, playing: false });
    expect(clock.step(-10).currentTime).toBe(0);
    expect(clock.step(10).currentTime).toBe(3);
  });

  it("stops precisely at the duration and restarts from zero on play", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 2, initialTime: 1.5, now: source.now });

    clock.play();
    source.advance(1_000);
    expect(clock.tick()).toMatchObject({ currentTime: 2, progress: 1, playing: false });

    expect(clock.play()).toMatchObject({ currentTime: 0, playing: true });
  });

  it("supports toggle, reset and duration changes", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 4, now: source.now });

    expect(clock.toggle().playing).toBe(true);
    source.advance(1_000);
    expect(clock.toggle()).toMatchObject({ currentTime: 1, playing: false });
    expect(clock.setDuration(0.5)).toMatchObject({ currentTime: 0.5, playing: false });
    expect(clock.reset()).toMatchObject({ currentTime: 0, progress: 0, playing: false });
  });

  it("rejects invalid durations, rates, seeks and backwards clocks", () => {
    const source = manualClock();
    expect(() => new ReplayClock({ duration: -1, now: source.now })).toThrow(RangeError);
    expect(() => new ReplayClock({ duration: 1, playbackRate: 0, now: source.now })).toThrow(
      RangeError,
    );

    const clock = new ReplayClock({ duration: 2, now: source.now });
    expect(() => clock.seek(-1)).toThrow(RangeError);
    expect(() => clock.setPlaybackRate(Number.NaN)).toThrow(RangeError);
    expect(() => clock.tick(999)).toThrow(RangeError);
  });

  it("validates seek anchors before mutating replay state", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 5, initialTime: 1, now: source.now });

    expect(() => clock.seek(4, Number.NaN)).toThrow(RangeError);
    expect(clock.currentTime).toBe(1);
    expect(() => clock.seek(4, 999)).toThrow(RangeError);
    expect(clock.currentTime).toBe(1);
  });

  it("supports a zero-duration clock with the default monotonic source", () => {
    const clock = new ReplayClock({ duration: 0 });

    expect(clock.duration).toBe(0);
    expect(clock.progress).toBe(0);
    expect(clock.play()).toMatchObject({
      currentTime: 0,
      duration: 0,
      progress: 0,
      playing: false,
    });
  });

  it("stops on a seek to the end and rejects invalid step and duration values", () => {
    const source = manualClock();
    const clock = new ReplayClock({ duration: 4, initialTime: 1, now: source.now });

    clock.play();
    expect(clock.seek(4)).toMatchObject({ currentTime: 4, playing: false });
    expect(() => clock.step(Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => clock.setDuration(-1)).toThrow(RangeError);
    expect(() => clock.tick(Number.NaN)).toThrow(RangeError);
  });

  it("rejects a non-finite injected monotonic source during construction", () => {
    expect(() => new ReplayClock({ duration: 1, now: () => Number.POSITIVE_INFINITY })).toThrow(
      RangeError,
    );
  });
});
