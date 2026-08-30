import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createTelemetryCharts } from "../src/charts";
import type { TelemetryRun, TelemetrySample, TimestampGap } from "../src/core/types";

type FakeListener = (event: Event) => void;

class FakeElement {
  readonly children: FakeElement[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Set<FakeListener>>();
  readonly style: Record<string, string> = {};
  parent: FakeElement | null = null;
  className = "";
  textContent = "";
  clientWidth = 0;
  type = "";
  value = "";
  min = "";
  max = "";
  step = "";
  disabled = false;
  replaceCount = 0;

  constructor(readonly tagName: string) {}

  append(...nodes: FakeElement[]): void {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes: FakeElement[]): void {
    this.replaceCount += 1;
    this.children.splice(0, this.children.length);
    this.append(...nodes);
  }

  remove(): void {
    if (this.parent === null) {
      return;
    }
    const index = this.parent.children.indexOf(this);
    if (index >= 0) {
      this.parent.children.splice(index, 1);
    }
    this.parent = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener !== "function") {
      return;
    }
    const listeners = this.listeners.get(type) ?? new Set<FakeListener>();
    listeners.add(listener as FakeListener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    if (typeof listener === "function") {
      this.listeners.get(type)?.delete(listener as FakeListener);
    }
  }

  dispatch(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  getBoundingClientRect(): DOMRect {
    return {
      x: 0,
      y: 0,
      width: this.clientWidth,
      height: 0,
      top: 0,
      right: this.clientWidth,
      bottom: 0,
      left: 0,
      toJSON: () => ({}),
    };
  }

  queryAll(predicate: (element: FakeElement) => boolean): FakeElement[] {
    const matches: FakeElement[] = predicate(this) ? [this] : [];
    for (const child of this.children) {
      matches.push(...child.queryAll(predicate));
    }
    return matches;
  }
}

class FakeDocument {
  createElement(name: string): HTMLElement {
    return new FakeElement(name) as unknown as HTMLElement;
  }

  createElementNS(_namespace: string, name: string): SVGElement {
    return new FakeElement(name) as unknown as SVGElement;
  }
}

function eventWithKey(
  key: string,
  shiftKey = false,
): KeyboardEvent & {
  prevented: boolean;
  stopped: boolean;
} {
  const result = {
    key,
    shiftKey,
    prevented: false,
    stopped: false,
    preventDefault() {
      result.prevented = true;
    },
    stopPropagation() {
      result.stopped = true;
    },
  };
  return result as unknown as KeyboardEvent & { prevented: boolean; stopped: boolean };
}

function sample(timestamp: number, value = timestamp): TelemetrySample {
  return {
    timestamp,
    sequence: Math.round(timestamp * 10),
    pose: { x: timestamp, y: 0, yaw: 0 },
    speed: value,
    battery: 80 - value,
    current: 5 + value,
    state: "tracking",
  };
}

function run(samples: TelemetrySample[], id = "fault"): TelemetryRun {
  return {
    id,
    name: id === "fault" ? "Fault candidate" : "Nominal baseline",
    kind: id === "fault" ? "faulty" : "normal",
    samples,
  };
}

function gap(startTimestamp: number, endTimestamp: number): TimestampGap {
  return {
    startTimestamp,
    endTimestamp,
    startSampleIndex: 1,
    endSampleIndex: 2,
    duration: endTimestamp - startTimestamp,
    threshold: 0.25,
  };
}

function root(width: number): FakeElement {
  const element = new FakeElement("div");
  element.clientWidth = width;
  return element;
}

function byClass(element: FakeElement, className: string): FakeElement[] {
  return element.queryAll(
    (candidate) =>
      candidate.className.split(/\s+/).includes(className) ||
      candidate.getAttribute("class")?.split(/\s+/).includes(className) === true,
  );
}

let previousDocument: Document | undefined;

beforeEach(() => {
  previousDocument = globalThis.document;
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: new FakeDocument(),
  });
});

afterEach(() => {
  if (previousDocument === undefined) {
    Reflect.deleteProperty(globalThis, "document");
  } else {
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: previousDocument,
    });
  }
});

describe("TelemetryCharts", () => {
  it("keeps legacy connected paths by default and breaks only the configured run", () => {
    const samples = [sample(0), sample(0.1), sample(0.8), sample(0.9)];
    const chartRoot = root(640);
    const connected = createTelemetryCharts(chartRoot as unknown as HTMLElement, {
      runs: [run(samples)],
      gaps: [gap(0.1, 0.8)],
    });
    const connectedElement = connected.element as unknown as FakeElement;
    const connectedPath = byClass(connectedElement, "telemetry-charts__series")[0];
    expect(connectedPath?.getAttribute("d")?.match(/M/g)).toHaveLength(1);
    connected.destroy();

    const brokenRoot = root(640);
    const broken = createTelemetryCharts(brokenRoot as unknown as HTMLElement, {
      runs: [run(samples), run(samples, "baseline")],
      gapsByRun: new Map([["fault", [gap(0.1, 0.8)]]]),
      gapDisplay: "break",
      selectedTimestamp: 0.4,
    });
    const brokenElement = broken.element as unknown as FakeElement;
    const paths = byClass(brokenElement, "telemetry-charts__series");
    expect(paths[0]?.getAttribute("d")?.match(/M/g)).toHaveLength(2);
    expect(paths[1]?.getAttribute("d")?.match(/M/g)).toHaveLength(1);
    expect(byClass(brokenElement, "telemetry-charts__gap-band")).toHaveLength(3);
    expect(byClass(brokenElement, "telemetry-charts__selected-value")[0]?.textContent).toContain(
      "NO DATA",
    );
  });

  it("keeps static paths cached while moving the cursor", () => {
    const chartRoot = root(640);
    const chart = createTelemetryCharts(chartRoot as unknown as HTMLElement, {
      runs: [run([sample(0), sample(0.1), sample(0.2)])],
      selectedTimestamp: 0,
    });
    const element = chart.element as unknown as FakeElement;
    const staticLayer = byClass(element, "telemetry-charts__static")[0];
    const firstPath = byClass(element, "telemetry-charts__series")[0];
    const replacements = staticLayer?.replaceCount;

    chart.setSelectedTimestamp(0.1);

    expect(byClass(element, "telemetry-charts__series")[0]).toBe(firstPath);
    expect(staticLayer?.replaceCount).toBe(replacements);
  });

  it("uses container-width coordinates and bounds large paths to about two points per pixel", () => {
    const chartRoot = root(320);
    const samples = Array.from({ length: 10_000 }, (_, index) =>
      sample(index / 100, Math.sin(index / 7)),
    );
    const chart = createTelemetryCharts(chartRoot as unknown as HTMLElement, {
      runs: [run(samples)],
    });
    const element = chart.element as unknown as FakeElement;
    const svg = element.queryAll((candidate) => candidate.tagName === "svg")[0];
    const path = byClass(element, "telemetry-charts__series")[0];
    expect(svg?.getAttribute("viewBox")).toBe("0 0 320 260");
    expect((path?.getAttribute("d")?.match(/[ML]/g) ?? []).length).toBeLessThanOrEqual(504);

    chartRoot.clientWidth = 800;
    chart.resize();
    expect(svg?.getAttribute("viewBox")).toBe("0 0 800 240");
  });

  it("names a non-focusable image and emits one callback per keyboard seek", () => {
    const onSelect: number[] = [];
    const chartRoot = root(640);
    const samples = Array.from({ length: 16 }, (_, index) => sample(index * 0.2));
    const chart = createTelemetryCharts(chartRoot as unknown as HTMLElement, {
      runs: [run(samples)],
      selectedTimestamp: 0,
      onSelectTimestamp: (timestamp) => onSelect.push(timestamp),
    });
    const element = chart.element as unknown as FakeElement;
    const svg = element.queryAll((candidate) => candidate.tagName === "svg")[0];
    const range = byClass(element, "telemetry-charts__cursor-control")[0];
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-labelledby")).toMatch(/telemetry-charts-title/);
    expect(svg?.getAttribute("tabindex")).toBeNull();
    expect(range?.type).toBe("range");

    const sampleStep = eventWithKey("ArrowRight");
    range?.dispatch("keydown", sampleStep);
    expect(onSelect).toHaveLength(1);
    expect(onSelect[0]).toBeCloseTo(0.2);
    expect(sampleStep.prevented).toBe(true);
    expect(sampleStep.stopped).toBe(true);

    const oneSecondStep = eventWithKey("ArrowRight", true);
    range?.dispatch("keydown", oneSecondStep);
    expect(onSelect).toHaveLength(2);
    expect(onSelect[1]).toBeCloseTo(1.2);
  });
});
