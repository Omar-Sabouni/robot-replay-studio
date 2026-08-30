import type {
  DetectorConfiguration,
  DetectorId,
  DetectorRuleConfig,
  DerivedSampleMetrics,
  EvidenceChain,
  ReplaySampleStatus,
  ReplaySessionV2,
  SessionAnalysis,
  SessionIncident,
  SessionTelemetrySample,
  TimestampGap,
} from "../core/types";
import {
  detectorDigits,
  detectorExpression,
  detectorRuleDescription,
  detectorRuleSummary,
  detectorShortCode,
  finiteValue,
  formatFreshness,
  formatNumber,
  formatSeconds,
  formatSigned,
  formatStateLabel,
  formatTimecode,
  nearestIncident,
  UNAVAILABLE_LABEL,
} from "./session-view";

export type RenderScope = Document | DocumentFragment | Element;

type OutcomeTone = "nominal" | "warning" | "critical";

function documentFor(scope: RenderScope): Document {
  if (scope.nodeType === 9) {
    return scope as Document;
  }
  if (scope.ownerDocument === null) {
    throw new Error("Renderer scope is not attached to a document");
  }
  return scope.ownerDocument;
}

function find<T extends Element>(scope: RenderScope, id: string): T | null {
  return scope.querySelector<T>(`#${id}`);
}

function setText(scope: RenderScope, id: string, value: string): void {
  const target = find<HTMLElement>(scope, id);
  if (target !== null) {
    target.textContent = value;
  }
}

function setUnavailableState(element: HTMLElement, unavailable: boolean): void {
  element.classList.toggle("is-unavailable", unavailable);
  element.dataset.available = String(!unavailable);
  if (unavailable) {
    element.setAttribute("aria-label", "Unavailable; channel was not recorded");
    element.title = "Unavailable; channel was not recorded";
  } else {
    element.removeAttribute("aria-label");
    element.removeAttribute("title");
  }
}

/** Replace a value safely while preserving the shell's small unit styling. */
export function renderMeasurement(
  element: HTMLElement | null,
  value: number | string | null | undefined,
  unit = "",
  digits = 1,
  signed = false,
): void {
  if (element === null) {
    return;
  }
  const unavailable =
    value === null || value === undefined || (typeof value === "number" && !Number.isFinite(value));
  setUnavailableState(element, unavailable);
  if (unavailable) {
    element.textContent = UNAVAILABLE_LABEL;
    return;
  }
  const text = typeof value === "number" ? formatNumber(value, { digits, signed }) : value;
  const doc = element.ownerDocument;
  const valueText = doc.createTextNode(text);
  if (unit === "") {
    element.replaceChildren(valueText);
    return;
  }
  const unitElement = doc.createElement("small");
  unitElement.textContent = unit;
  element.replaceChildren(valueText, doc.createTextNode(" "), unitElement);
}

function setTone(element: Element | null, tone: OutcomeTone): void {
  if (element instanceof HTMLElement) {
    element.dataset.tone = tone;
  }
}

function parentKpi(scope: RenderScope, valueId: string): Element | null {
  return find(scope, valueId)?.closest(".outcome-kpi") ?? null;
}

function runSummaryLabel(session: ReplaySessionV2): string {
  const comparison = session.runs.baseline === undefined ? "Candidate" : "Candidate + baseline";
  const sampleCount = session.runs.candidate.samples.length.toLocaleString();
  const sampleRate = session.runs.candidate.sampleRateHz;
  return `${comparison} · ${sampleCount} samples${sampleRate === undefined ? "" : ` · ${formatNumber(sampleRate, { digits: 1, trimTrailingZeros: true })} Hz`}`;
}

function outcomeLabel(outcome: ReplaySessionV2["mission"]["outcome"]): string {
  switch (outcome) {
    case "nominal":
      return "Nominal";
    case "degraded":
      return "Degraded";
    case "safe-stop":
      return "Safe-stop";
  }
}

function outcomeTone(outcome: ReplaySessionV2["mission"]["outcome"]): OutcomeTone {
  switch (outcome) {
    case "nominal":
      return "nominal";
    case "degraded":
      return "warning";
    case "safe-stop":
      return "critical";
  }
}

function baselineDelta(value: number | null, baseline: number | null): number | null {
  return value === null || baseline === null ? null : value - baseline;
}

export interface MissionChoice {
  value: string;
  label: string;
}

export function renderMissionChoices(
  scope: RenderScope,
  choices: readonly MissionChoice[],
  selectedValue: string,
): void {
  const selector = find<HTMLSelectElement>(scope, "mission-selector");
  if (selector === null) {
    return;
  }
  const doc = documentFor(scope);
  const options = choices.map(({ value, label }) => {
    const option = doc.createElement("option");
    option.value = value;
    option.textContent = label;
    option.selected = value === selectedValue;
    return option;
  });
  selector.replaceChildren(...options);
  selector.value = selectedValue;
}

export interface MissionOutcomeRenderState {
  session: ReplaySessionV2;
  analysis: SessionAnalysis;
  baselineAnalysis?: SessionAnalysis | null;
  gaps?: readonly TimestampGap[];
  selectedMissionValue?: string;
}

/** Render mission identity and the six mission outcome KPIs. */
export function renderMissionOutcome(scope: RenderScope, state: MissionOutcomeRenderState): void {
  const { session, analysis } = state;
  const baselineSummary = state.baselineAnalysis?.summary ?? null;
  const safeStop = analysis.incidents.find(({ detectorId }) => detectorId === "safe-stop");
  const effectiveOutcome: ReplaySessionV2["mission"]["outcome"] =
    safeStop !== undefined
      ? "safe-stop"
      : analysis.incidents.some(({ severity }) => severity === "critical")
        ? "degraded"
        : session.mission.outcome;
  const title = find<HTMLElement>(scope, "mission-title");
  if (title !== null) {
    const doc = title.ownerDocument;
    const id = doc.createElement("span");
    id.textContent = `· ${session.mission.id}`;
    title.replaceChildren(doc.createTextNode(`${session.mission.title} `), id);
  }
  setText(scope, "mission-subtitle", session.mission.subtitle);
  setText(scope, "mission-run-summary", runSummaryLabel(session));
  const selector = find<HTMLSelectElement>(scope, "mission-selector");
  if (selector !== null && state.selectedMissionValue !== undefined) {
    selector.value = state.selectedMissionValue;
  }

  const missionState = find<HTMLElement>(scope, "outcome-state");
  if (missionState !== null) {
    const glyph = missionState.ownerDocument.createElement("span");
    glyph.className = "status-glyph";
    glyph.setAttribute("aria-hidden", "true");
    missionState.replaceChildren(
      glyph,
      missionState.ownerDocument.createTextNode(outcomeLabel(effectiveOutcome)),
    );
  }
  setTone(parentKpi(scope, "outcome-state"), outcomeTone(effectiveOutcome));
  const firstTimestamp = session.runs.candidate.samples[0]?.timestamp ?? 0;
  setText(
    scope,
    "outcome-state-time",
    safeStop === undefined
      ? "End state"
      : `at ${formatTimecode(safeStop.timestamp - firstTimestamp)}`,
  );

  renderMeasurement(
    find(scope, "outcome-route-error"),
    analysis.summary.maxCrossTrackError,
    "m",
    2,
  );
  const routeDelta = baselineDelta(
    finiteValue(analysis.summary.maxCrossTrackError),
    finiteValue(baselineSummary?.maxCrossTrackError),
  );
  setText(
    scope,
    "outcome-route-error-delta",
    routeDelta === null ? "Baseline unavailable" : `${formatSigned(routeDelta, 2)} m vs baseline`,
  );

  renderMeasurement(
    find(scope, "outcome-clearance"),
    analysis.summary.minObstacleClearance,
    "m",
    2,
  );
  const clearance = finiteValue(analysis.summary.minObstacleClearance);
  const clearanceRule = session.detectors.rules["obstacle-clearance"];
  const margin = clearance === null ? null : clearance - clearanceRule.threshold;
  setText(
    scope,
    "outcome-clearance-margin",
    margin === null
      ? "Clearance unavailable"
      : `${formatNumber(Math.abs(margin), { digits: 2 })} m ${margin < 0 ? "inside" : "outside"} limit`,
  );
  setTone(
    parentKpi(scope, "outcome-clearance"),
    margin !== null && margin < 0 ? "critical" : "nominal",
  );
}

export interface IncidentFilterState {
  query?: string;
  severities?: ReadonlySet<SessionIncident["severity"]> | readonly SessionIncident["severity"][];
  detectorIds?: ReadonlySet<DetectorId> | readonly DetectorId[];
}

function includesFilterValue<T>(
  filter: ReadonlySet<T> | readonly T[] | undefined,
  value: T,
): boolean {
  if (filter === undefined) {
    return true;
  }
  return Array.isArray(filter)
    ? (filter as readonly T[]).includes(value)
    : (filter as ReadonlySet<T>).has(value);
}

export function filterIncidents(
  incidents: readonly SessionIncident[],
  filter: IncidentFilterState = {},
): SessionIncident[] {
  const query = filter.query?.trim().toLocaleLowerCase() ?? "";
  return incidents.filter((incident) => {
    if (!includesFilterValue(filter.severities, incident.severity)) {
      return false;
    }
    if (!includesFilterValue(filter.detectorIds, incident.detectorId)) {
      return false;
    }
    if (query === "") {
      return true;
    }
    return [
      incident.title,
      incident.description,
      incident.detectorId,
      incident.evidence.operatorCheck,
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

function warningIcon(doc: Document): SVGSVGElement {
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.classList.add("icon");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 4 3.5 19h17L12 4ZM12 9v4m0 3h.01");
  svg.append(path);
  return svg;
}

export interface IncidentListRenderState {
  incidents: readonly SessionIncident[];
  maxVisible?: number;
  selectedIncidentId?: string | null;
  filter?: IncidentFilterState;
  detectors?: DetectorConfiguration;
  startTimestamp?: number;
}

/** Render incident buttons only; controllers can use event delegation on data-incident-id. */
export function renderIncidentList(
  scope: RenderScope,
  state: IncidentListRenderState,
): readonly SessionIncident[] {
  const list = find<HTMLElement>(scope, "event-list");
  const filtered = filterIncidents(state.incidents, state.filter);
  const maximum = Math.max(1, state.maxVisible ?? Number.POSITIVE_INFINITY);
  let visible = filtered;
  if (filtered.length > maximum) {
    const selected = new Set<string>();
    if (state.selectedIncidentId !== null && state.selectedIncidentId !== undefined) {
      selected.add(state.selectedIncidentId);
    }
    const slots = Math.max(1, maximum - selected.size);
    for (let index = 0; index < slots; index += 1) {
      const sourceIndex = Math.round((index / Math.max(1, slots - 1)) * (filtered.length - 1));
      const incident = filtered[sourceIndex];
      if (incident !== undefined) {
        selected.add(incident.id);
      }
    }
    visible = filtered.filter(({ id }) => selected.has(id)).slice(0, maximum);
  }
  setText(scope, "detected-stat", String(state.incidents.length));
  setText(scope, "mobile-incident-count", String(state.incidents.length));
  if (list === null) {
    return visible;
  }
  const doc = list.ownerDocument;
  if (visible.length === 0) {
    const empty = doc.createElement("div");
    empty.className = "event-empty";
    empty.id = "event-empty";
    empty.textContent =
      state.incidents.length === 0
        ? "No incidents detected in this candidate run."
        : "No incidents match the current filter.";
    list.replaceChildren(empty);
    return visible;
  }
  const start = state.startTimestamp ?? 0;
  const cards: HTMLElement[] = visible.map((incident) => {
    const card = doc.createElement("button");
    card.type = "button";
    card.className = `event-card ${incident.severity}`;
    card.dataset.incidentId = incident.id;
    card.dataset.timestamp = String(incident.timestamp);
    card.dataset.endTimestamp = String(incident.endTimestamp);
    card.dataset.detector = incident.detectorId;
    const selected = incident.id === state.selectedIncidentId;
    card.classList.toggle("active", selected);
    if (selected) {
      card.setAttribute("aria-current", "true");
    }

    const icon = doc.createElement("span");
    icon.className = "event-icon";
    icon.append(warningIcon(doc));
    const copy = doc.createElement("span");
    copy.className = "event-copy";
    const title = doc.createElement("strong");
    title.textContent = incident.title;
    const description = doc.createElement("span");
    description.textContent = incident.description;
    copy.append(title, description);
    const time = doc.createElement("time");
    time.className = "event-time";
    time.dateTime = `PT${Math.max(0, incident.timestamp - start)}S`;
    time.textContent = formatTimecode(incident.timestamp - start);
    card.setAttribute(
      "aria-label",
      `${formatStateLabel(incident.severity)} incident at ${time.textContent}: ${incident.title}. ${incident.description}`,
    );
    card.append(icon, copy, time);
    return card;
  });
  if (visible.length < filtered.length) {
    const summary = doc.createElement("p");
    summary.className = "event-render-summary";
    summary.textContent = `Showing ${visible.length.toLocaleString()} representative incidents of ${filtered.length.toLocaleString()}. Refine the filter to inspect a narrower set.`;
    cards.push(summary);
  }
  list.replaceChildren(...cards);
  return visible;
}

export interface SparklinePoint {
  timestamp: number;
  value: number | null;
}

function renderSparkline(
  scope: RenderScope,
  points: readonly SparklinePoint[],
  threshold: number | null,
  label: string,
): void {
  const mount = find<HTMLElement>(scope, "evidence-sparkline");
  if (mount === null) {
    return;
  }
  const finitePoints = points.filter(
    (point): point is { timestamp: number; value: number } =>
      Number.isFinite(point.timestamp) && finiteValue(point.value) !== null,
  );
  if (finitePoints.length < 2) {
    const unavailable = mount.ownerDocument.createElement("p");
    unavailable.className = "sparkline-unavailable";
    unavailable.textContent = "Signal unavailable for this evidence window.";
    mount.replaceChildren(unavailable);
    mount.setAttribute("aria-label", `${label}: signal unavailable`);
    return;
  }
  const doc = mount.ownerDocument;
  const svg = doc.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 320 72");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", "56");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", label);
  const minTime = Math.min(...finitePoints.map(({ timestamp }) => timestamp));
  const maxTime = Math.max(...finitePoints.map(({ timestamp }) => timestamp));
  const values = finitePoints.map(({ value }) => value);
  if (threshold !== null && Number.isFinite(threshold)) {
    values.push(threshold);
  }
  let minValue = Math.min(...values);
  let maxValue = Math.max(...values);
  if (minValue === maxValue) {
    minValue -= 1;
    maxValue += 1;
  }
  const x = (timestamp: number): number =>
    8 + ((timestamp - minTime) / Math.max(0.001, maxTime - minTime)) * 304;
  const y = (value: number): number => 64 - ((value - minValue) / (maxValue - minValue)) * 56;

  if (threshold !== null && Number.isFinite(threshold)) {
    const line = doc.createElementNS("http://www.w3.org/2000/svg", "line");
    line.classList.add("sparkline-threshold");
    line.setAttribute("x1", "8");
    line.setAttribute("x2", "312");
    line.setAttribute("y1", String(y(threshold)));
    line.setAttribute("y2", String(y(threshold)));
    line.setAttribute("stroke", "#f2a900");
    line.setAttribute("stroke-dasharray", "5 4");
    line.setAttribute("vector-effect", "non-scaling-stroke");
    svg.append(line);
  }
  let currentPath: string[] = [];
  const paths: SVGPathElement[] = [];
  const flush = (): void => {
    if (currentPath.length < 2) {
      currentPath = [];
      return;
    }
    const path = doc.createElementNS("http://www.w3.org/2000/svg", "path");
    path.classList.add("sparkline-signal");
    path.setAttribute("d", currentPath.join(" "));
    path.setAttribute("fill", "none");
    path.setAttribute("vector-effect", "non-scaling-stroke");
    paths.push(path);
    currentPath = [];
  };
  for (const point of points) {
    const value = finiteValue(point.value);
    if (!Number.isFinite(point.timestamp) || value === null) {
      flush();
      continue;
    }
    currentPath.push(
      `${currentPath.length === 0 ? "M" : "L"}${x(point.timestamp).toFixed(2)},${y(value).toFixed(2)}`,
    );
  }
  flush();
  svg.append(...paths);
  mount.replaceChildren(svg);
  mount.setAttribute("aria-label", label);
}

function evidenceValue(value: number | string, digits: number): string | number {
  return typeof value === "number" ? Number(formatNumber(value, { digits })) : value;
}

export interface EvidencePanelRenderState {
  incident: SessionIncident | null;
  startTimestamp?: number;
  rule?: DetectorRuleConfig | null;
  chain?: EvidenceChain | null;
  incidents?: readonly SessionIncident[];
  selectedIncidentId?: string | null;
  sparkline?: readonly SparklinePoint[];
  confidenceLabel?: string;
  sequenceLabel?: string;
}

export function renderEvidencePanel(scope: RenderScope, state: EvidencePanelRenderState): void {
  const { incident } = state;
  if (incident === null) {
    setText(scope, "inspector-title", "No incident selected");
    setText(scope, "sequence-value", "—");
    renderMeasurement(find(scope, "evidence-observed"), null);
    renderMeasurement(find(scope, "evidence-threshold"), null);
    const verdict = find<HTMLElement>(scope, "evidence-observed")?.closest<HTMLElement>(
      ".evidence-verdict",
    );
    if (verdict !== null && verdict !== undefined) {
      verdict.dataset.severity = "nominal";
    }
    setText(scope, "evidence-sparkline-label", "Detector channel unavailable");
    setText(scope, "evidence-sparkline-threshold-label", "No threshold crossed");
    setText(scope, "evidence-rule-code", "No detector event");
    setText(scope, "rule-summary-title", "No configured boundary crossed");
    setText(
      scope,
      "evidence-rule-description",
      "Select Rules to inspect or adjust the detector configuration.",
    );
    const expression = find<HTMLElement>(scope, "evidence-rule-expression");
    if (expression !== null) {
      const code = expression.ownerDocument.createElement("code");
      code.textContent = "all enabled rules clear";
      expression.replaceChildren(code);
    }
    const transport = find<HTMLElement>(scope, "transport-context");
    if (transport !== null) {
      const label = transport.ownerDocument.createElement("strong");
      label.textContent = "No incident selected";
      transport.replaceChildren(label);
    }
    renderSparkline(scope, [], null, "Detector channel unavailable");
    renderEvidenceChain(scope, null, [], null, state.startTimestamp);
    return;
  }
  const digits = detectorDigits(incident.detectorId);
  const unit = incident.evidence.unit === "state" ? "" : incident.evidence.unit;
  const startTimestamp = state.startTimestamp ?? 0;
  setText(scope, "inspector-title", incident.title);
  setText(scope, "sequence-value", state.sequenceLabel ?? incident.id.toLocaleUpperCase());
  renderMeasurement(
    find(scope, "evidence-observed"),
    evidenceValue(incident.evidence.observed, digits),
    unit,
    digits,
  );
  renderMeasurement(
    find(scope, "evidence-threshold"),
    evidenceValue(incident.evidence.threshold, digits),
    unit,
    digits,
  );
  const signalLabel = (() => {
    switch (incident.detectorId) {
      case "timestamp-gap":
        return "Sample interval";
      case "sequence-gap":
        return "Missing packets";
      case "pose-discontinuity":
        return "Adjacent pose jump";
      case "overcurrent":
        return "Current magnitude";
      case "low-battery":
        return "Battery reserve";
      case "link-degradation":
        return "Link data age";
      case "route-deviation":
        return "Cross-track error";
      case "heading-error":
        return "Heading error";
      case "obstacle-clearance":
        return "Obstacle clearance";
      case "safe-stop":
        return "Robot speed";
    }
  })();
  setText(scope, "evidence-sparkline-label", `${signalLabel} · evidence window`);
  setText(scope, "evidence-sparkline-threshold-label", "Configured threshold");

  const verdict = find<HTMLElement>(scope, "evidence-observed")?.closest(".evidence-verdict");
  if (verdict instanceof HTMLElement) {
    verdict.dataset.severity = incident.severity;
  }
  const rule = state.rule ?? null;
  setText(scope, "evidence-rule-code", detectorShortCode(incident.detectorId));
  setText(scope, "rule-summary-title", rule === null ? incident.title : detectorRuleSummary(rule));
  setText(
    scope,
    "evidence-rule-description",
    rule === null ? incident.description : detectorRuleDescription(rule),
  );
  const expression = find<HTMLElement>(scope, "evidence-rule-expression");
  if (expression !== null) {
    const code = expression.ownerDocument.createElement("code");
    code.textContent =
      rule === null ? `${incident.detectorId} rule matched` : detectorExpression(rule);
    expression.replaceChildren(code);
  }
  const transport = find<HTMLElement>(scope, "transport-context");
  if (transport !== null) {
    const doc = transport.ownerDocument;
    const code = doc.createElement("span");
    code.dataset.severity = incident.severity;
    code.textContent = detectorShortCode(incident.detectorId);
    const title = doc.createElement("strong");
    title.textContent = incident.title;
    transport.replaceChildren(code, title);
  }

  const numericThreshold =
    typeof incident.evidence.threshold === "number" ? incident.evidence.threshold : null;
  renderSparkline(
    scope,
    state.sparkline ?? [],
    numericThreshold,
    `${incident.title}; detector channel around ${formatTimecode(incident.timestamp - startTimestamp)}`,
  );
  renderEvidenceChain(
    scope,
    state.chain ?? null,
    state.incidents ?? [incident],
    state.selectedIncidentId ?? incident.id,
    state.startTimestamp,
  );
}

function classificationLabel(
  classification: EvidenceChain["steps"][number]["classification"],
): string {
  switch (classification) {
    case "earliest-crossing":
      return "Earliest detector crossing";
    case "subsequent-crossing":
      return "Subsequent crossing";
    case "protective-response":
      return "Protective response";
  }
}

export function renderEvidenceChain(
  scope: RenderScope,
  chain: EvidenceChain | null,
  incidents: readonly SessionIncident[],
  selectedIncidentId: string | null,
  startTimestamp = 0,
): void {
  const list = find<HTMLOListElement>(scope, "evidence-chain-list");
  if (list === null) {
    return;
  }
  const doc = list.ownerDocument;
  const focusedIncidentId = list.contains(doc.activeElement)
    ? (doc.activeElement?.closest<HTMLElement>("[data-incident-id]")?.dataset.incidentId ?? null)
    : null;
  const incidentById = new Map(incidents.map((incident) => [incident.id, incident]));
  if (chain === null || chain.steps.length === 0) {
    const empty = doc.createElement("li");
    empty.className = "evidence-chain-empty";
    empty.textContent = "No linked detector sequence.";
    list.replaceChildren(empty);
  } else {
    const items = chain.steps.map((step) => {
      const incident = incidentById.get(step.incidentId);
      const item = doc.createElement("li");
      item.dataset.incidentId = step.incidentId;
      item.dataset.classification = step.classification;
      const selected = step.incidentId === selectedIncidentId;
      item.dataset.state = selected ? "active" : "idle";
      const button = doc.createElement("button");
      button.type = "button";
      button.className = "evidence-chain-step";
      button.dataset.incidentId = step.incidentId;
      if (selected) {
        button.setAttribute("aria-current", "true");
      }
      button.setAttribute(
        "aria-label",
        `${classificationLabel(step.classification)}: ${incident?.title ?? step.incidentId}`,
      );
      const marker = doc.createElement("i");
      marker.setAttribute("aria-hidden", "true");
      const copy = doc.createElement("div");
      copy.className = "evidence-chain-copy";
      const time = doc.createElement("time");
      time.textContent =
        incident === undefined
          ? UNAVAILABLE_LABEL
          : formatSeconds(incident.timestamp - startTimestamp, 1);
      const title = doc.createElement("strong");
      title.textContent = incident?.title ?? step.incidentId;
      copy.append(time, title);
      button.append(marker, copy);
      item.append(button);
      return item;
    });
    list.replaceChildren(...items);
  }

  if (focusedIncidentId !== null) {
    const replacement = [
      ...list.querySelectorAll<HTMLButtonElement>("button[data-incident-id]"),
    ].find(({ dataset }) => dataset.incidentId === focusedIncidentId);
    if (replacement !== undefined) {
      const restoreFocus = (): void => {
        const activeElement = doc.activeElement;
        const activeIncidentId =
          activeElement?.closest<HTMLElement>("[data-incident-id]")?.dataset.incidentId;
        const focusWasLostOrRemainsOnIncident =
          activeElement === null ||
          activeElement === doc.body ||
          activeIncidentId === focusedIncidentId;
        if (
          replacement.isConnected &&
          replacement.closest("[hidden]") === null &&
          focusWasLostOrRemainsOnIncident
        ) {
          replacement.focus({ preventScroll: true });
        }
      };
      if (doc.defaultView === null) {
        queueMicrotask(restoreFocus);
      } else {
        doc.defaultView.setTimeout(restoreFocus, 50);
      }
    }
  }
}

export interface SamplePanelRenderState {
  timestamp: number;
  startTimestamp?: number;
  candidate: SessionTelemetrySample | null;
  baseline?: SessionTelemetrySample | null;
  candidateMetric?: DerivedSampleMetrics | null;
  baselineMetric?: DerivedSampleMetrics | null;
  freshness: ReplaySampleStatus;
  incidents?: readonly SessionIncident[];
  activeGap?: TimestampGap | null;
  currentThreshold?: number;
  batteryThreshold?: number;
}

function renderSampleMeasurement(
  scope: RenderScope,
  id: string,
  value: number | null | undefined,
  unit: string,
  digits: number,
  signed = false,
): void {
  renderMeasurement(find(scope, id), value, unit, digits, signed);
}

export function renderSamplePanel(scope: RenderScope, state: SamplePanelRenderState): void {
  const elapsed = state.timestamp - (state.startTimestamp ?? 0);
  setText(scope, "timestamp-value", formatTimecode(elapsed));
  const freshness = find<HTMLElement>(scope, "sample-freshness");
  if (freshness !== null) {
    const marker = freshness.ownerDocument.createElement("i");
    marker.setAttribute("aria-hidden", "true");
    freshness.replaceChildren(
      marker,
      freshness.ownerDocument.createTextNode(formatFreshness(state.freshness)),
    );
    freshness.dataset.status = state.freshness;
  }
  const candidate = state.candidate;
  const baseline = state.baseline ?? null;
  renderSampleMeasurement(scope, "speed-value", candidate?.speed, "m/s", 2);
  renderSampleMeasurement(scope, "baseline-speed-value", baseline?.speed, "m/s", 2);
  renderSampleMeasurement(scope, "current-value", candidate?.current, "A", 1);
  renderSampleMeasurement(scope, "baseline-current-value", baseline?.current, "A", 1);
  renderSampleMeasurement(scope, "battery-value", candidate?.battery, "%", 1);
  renderSampleMeasurement(scope, "baseline-battery-value", baseline?.battery, "%", 1);
  renderSampleMeasurement(
    scope,
    "delta-value",
    state.candidateMetric?.crossTrackError,
    "m",
    2,
    true,
  );
  renderSampleMeasurement(
    scope,
    "baseline-delta-value",
    state.baselineMetric?.crossTrackError,
    "m",
    2,
    true,
  );
  renderSampleMeasurement(scope, "pose-x", candidate?.pose.x, "", 3, true);
  renderSampleMeasurement(scope, "baseline-pose-x", baseline?.pose.x, "", 3, true);
  renderSampleMeasurement(scope, "pose-y", candidate?.pose.y, "", 3, true);
  renderSampleMeasurement(scope, "baseline-pose-y", baseline?.pose.y, "", 3, true);
  renderSampleMeasurement(
    scope,
    "pose-yaw",
    candidate === null ? null : (candidate.pose.yaw * 180) / Math.PI,
    "°",
    1,
    true,
  );
  renderSampleMeasurement(
    scope,
    "baseline-pose-yaw",
    baseline === null ? null : (baseline.pose.yaw * 180) / Math.PI,
    "°",
    1,
    true,
  );
  setText(scope, "state-value", formatStateLabel(candidate?.state));
  const sequence = finiteValue(candidate?.sequence);
  if (sequence !== null && find(scope, "inspector-panel-evidence")?.hasAttribute("hidden")) {
    setText(scope, "sequence-value", `SEQ-${Math.trunc(sequence).toString().padStart(4, "0")}`);
  }

  const currentCell = find<HTMLElement>(scope, "current-cell");
  currentCell?.classList.toggle(
    "warning",
    finiteValue(candidate?.current) !== null &&
      Math.abs(candidate?.current ?? 0) > (state.currentThreshold ?? 18),
  );
  const batteryCell = find<HTMLElement>(scope, "battery-cell");
  batteryCell?.classList.toggle(
    "warning",
    finiteValue(candidate?.battery) !== null &&
      (candidate?.battery ?? Number.POSITIVE_INFINITY) < (state.batteryThreshold ?? 20),
  );

  const diagnostic = find<HTMLElement>(scope, "diagnostic-card");
  if (state.activeGap !== undefined && state.activeGap !== null) {
    if (diagnostic !== null) {
      diagnostic.dataset.severity = "gap";
    }
    setText(scope, "diagnostic-relation", "Telemetry gap");
    setText(
      scope,
      "nearest-delta",
      `RESUME ${formatTimecode(state.activeGap.endTimestamp - (state.startTimestamp ?? 0))}`,
    );
    setText(scope, "nearest-title", "Holding last valid observation");
    setText(
      scope,
      "nearest-description",
      "No interpolation is performed across the missing-data interval.",
    );
    return;
  }
  const closest = nearestIncident(state.incidents ?? [], state.timestamp);
  if (closest === null) {
    if (diagnostic !== null) {
      diagnostic.dataset.severity = "none";
    }
    setText(scope, "diagnostic-relation", "Diagnostics");
    setText(scope, "nearest-delta", "CLEAR");
    setText(scope, "nearest-title", "No incidents detected");
    setText(
      scope,
      "nearest-description",
      "All enabled and available detector rules report a clean run.",
    );
    return;
  }
  if (diagnostic !== null) {
    diagnostic.dataset.severity = closest.severity;
  }
  const offset = closest.timestamp - state.timestamp;
  setText(
    scope,
    "diagnostic-relation",
    Math.abs(offset) < 0.000_5
      ? "Active incident"
      : offset > 0
        ? "Next incident"
        : "Previous incident",
  );
  setText(
    scope,
    "nearest-delta",
    Math.abs(offset) < 0.000_5
      ? "T±00.000"
      : `${offset > 0 ? "T+" : "T−"}${Math.abs(offset).toFixed(3)}`,
  );
  setText(scope, "nearest-title", closest.title);
  setText(scope, "nearest-description", closest.description);
}

function updateRuleControl(
  scope: RenderScope,
  rule: DetectorRuleConfig,
  ids: { enabled: string; threshold: string; duration?: string },
): void {
  const enabled = find<HTMLInputElement>(scope, ids.enabled);
  if (enabled !== null) {
    enabled.checked = rule.enabled;
    enabled.disabled = rule.unavailableReason !== undefined;
    enabled.title = rule.unavailableReason ?? "";
  }
  const threshold = find<HTMLInputElement>(scope, ids.threshold);
  if (threshold !== null) {
    threshold.value = String(rule.threshold);
    threshold.disabled = rule.unavailableReason !== undefined || !rule.enabled;
    threshold.title = rule.unavailableReason ?? "";
  }
  if (ids.duration !== undefined) {
    const duration = find<HTMLInputElement>(scope, ids.duration);
    if (duration !== null) {
      duration.value = String(rule.minimumDuration * 1_000);
      duration.disabled = rule.unavailableReason !== undefined || !rule.enabled;
      duration.title = rule.unavailableReason ?? "";
    }
  }
}

export function renderRulesPanel(scope: RenderScope, configuration: DetectorConfiguration): void {
  const rules = Object.values(configuration.rules);
  const available = rules.filter(({ unavailableReason }) => unavailableReason === undefined);
  const enabled = available.filter((rule) => rule.enabled);
  setText(scope, "rules-enabled-count", `${enabled.length} enabled`);
  updateRuleControl(scope, configuration.rules["link-degradation"], {
    enabled: "rule-latency-enabled",
    threshold: "rule-latency-threshold",
    duration: "rule-latency-duration",
  });
  updateRuleControl(scope, configuration.rules["route-deviation"], {
    enabled: "rule-route-enabled",
    threshold: "rule-route-threshold",
  });
  updateRuleControl(scope, configuration.rules.overcurrent, {
    enabled: "rule-current-enabled",
    threshold: "rule-current-threshold",
  });

  const form = find<HTMLFormElement>(scope, "rules-form");
  if (form !== null) {
    let unavailable =
      form.parentElement?.querySelector<HTMLElement>(".unavailable-detectors") ?? null;
    const disabled = rules.filter(({ unavailableReason }) => unavailableReason !== undefined);
    if (disabled.length === 0) {
      unavailable?.remove();
    } else {
      const doc = form.ownerDocument;
      if (unavailable === null) {
        unavailable = doc.createElement("section");
        unavailable.className = "unavailable-detectors";
        form.before(unavailable);
      }
      const heading = doc.createElement("strong");
      heading.textContent = "Unavailable detectors";
      const list = doc.createElement("ul");
      for (const rule of disabled) {
        const item = doc.createElement("li");
        item.textContent = `${rule.label}: ${rule.unavailableReason ?? "required channel unavailable"}`;
        list.append(item);
      }
      unavailable.replaceChildren(heading, list);
    }
  }
}

export interface TimelineRenderState {
  startTimestamp: number;
  duration: number;
  incidents: readonly SessionIncident[];
  gaps?: readonly TimestampGap[];
  selectedIncidentId?: string | null;
  currentTimestamp?: number;
  tickCount?: number;
}

function timelinePercent(
  timestamp: number,
  state: Pick<TimelineRenderState, "startTimestamp" | "duration">,
): number {
  if (!Number.isFinite(timestamp) || state.duration <= 0) {
    return 0;
  }
  return Math.min(100, Math.max(0, ((timestamp - state.startTimestamp) / state.duration) * 100));
}

export function renderTimelineWindows(scope: RenderScope, state: TimelineRenderState): void {
  const mount = find<HTMLElement>(scope, "timeline-windows");
  if (mount === null) {
    return;
  }
  const doc = mount.ownerDocument;
  const windows = state.incidents.map((incident) => {
    const window = doc.createElement("span");
    window.className = `timeline-window timeline-window--${incident.severity}`;
    window.dataset.incidentId = incident.id;
    window.setAttribute("aria-hidden", "true");
    window.style.left = `${timelinePercent(incident.timestamp, state)}%`;
    const width =
      state.duration <= 0
        ? 0
        : ((incident.endTimestamp - incident.timestamp) / state.duration) * 100;
    window.style.width = `${Math.max(0.15, width)}%`;
    window.title = `${incident.title}: ${formatTimecode(incident.timestamp - state.startTimestamp)}–${formatTimecode(incident.endTimestamp - state.startTimestamp)}`;
    if (incident.id === state.selectedIncidentId) {
      window.classList.add("active");
    }
    return window;
  });
  mount.replaceChildren(...windows);
}

export function renderTimelineMarkers(scope: RenderScope, state: TimelineRenderState): void {
  const mount = find<HTMLElement>(scope, "timeline-markers");
  if (mount === null) {
    return;
  }
  const doc = mount.ownerDocument;
  const focusedIncidentId = mount.contains(doc.activeElement)
    ? (doc.activeElement?.closest<HTMLElement>("[data-incident-id]")?.dataset.incidentId ?? null)
    : null;
  const sorted = [...state.incidents].sort((left, right) => left.timestamp - right.timestamp);
  const clusterIndices = new Map<string, { index: number; total: number }>();
  let cluster: SessionIncident[] = [];
  const flushCluster = (): void => {
    cluster.forEach((incident, index) =>
      clusterIndices.set(incident.id, { index, total: cluster.length }),
    );
    cluster = [];
  };
  for (const incident of sorted) {
    const previous = cluster.at(-1);
    if (
      previous !== undefined &&
      Math.abs(
        timelinePercent(incident.timestamp, state) - timelinePercent(previous.timestamp, state),
      ) >= 1.75
    ) {
      flushCluster();
    }
    cluster.push(incident);
  }
  flushCluster();

  const markers = sorted.map((incident) => {
    const marker = doc.createElement("button");
    marker.type = "button";
    marker.className = `timeline-marker ${incident.severity}`;
    marker.dataset.incidentId = incident.id;
    marker.dataset.timestamp = String(incident.timestamp);
    marker.dataset.elapsed = String(incident.timestamp - state.startTimestamp);
    const position = timelinePercent(incident.timestamp, state);
    marker.style.left = `${position}%`;
    if (position < 8) {
      marker.classList.add("timeline-marker--start");
    } else if (position > 92) {
      marker.classList.add("timeline-marker--end");
    }
    const clusterPosition = clusterIndices.get(incident.id);
    if (clusterPosition !== undefined) {
      marker.dataset.clusterIndex = String(clusterPosition.index);
      marker.dataset.clusterCount = String(clusterPosition.total);
      marker.style.setProperty("--marker-lane-offset", `${(clusterPosition.index % 3) * 4}px`);
    }
    const label = `${formatStateLabel(incident.severity)}, ${formatTimecode(incident.timestamp - state.startTimestamp)}, ${incident.title}`;
    marker.dataset.label = label;
    marker.setAttribute("aria-label", label);
    if (incident.id === state.selectedIncidentId) {
      marker.classList.add("active");
      marker.setAttribute("aria-current", "true");
    }
    return marker;
  });
  mount.replaceChildren(...markers);
  if (focusedIncidentId !== null) {
    markers
      .find(({ dataset }) => dataset.incidentId === focusedIncidentId)
      ?.focus({ preventScroll: true });
  }
}

export function renderTimelineGaps(scope: RenderScope, state: TimelineRenderState): void {
  const mount = find<HTMLElement>(scope, "timeline-gaps");
  if (mount === null) {
    return;
  }
  const doc = mount.ownerDocument;
  const focusedGap = mount.contains(doc.activeElement)
    ? {
        start: (doc.activeElement as HTMLElement).dataset.start,
        end: (doc.activeElement as HTMLElement).dataset.end,
      }
    : null;
  const nodes: Node[] = [];
  const buttons: HTMLButtonElement[] = [];
  for (const gap of state.gaps ?? []) {
    const midpoint = (gap.startTimestamp + gap.endTimestamp) / 2;
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "timeline-gap";
    button.style.left = `${timelinePercent(midpoint, state)}%`;
    button.dataset.start = String(gap.startTimestamp);
    button.dataset.end = String(gap.endTimestamp);
    button.dataset.timestamp = String(midpoint);
    button.setAttribute(
      "aria-label",
      `Telemetry gap from ${formatTimecode(gap.startTimestamp - state.startTimestamp)} to ${formatTimecode(gap.endTimestamp - state.startTimestamp)}; seek to midpoint`,
    );
    const band = doc.createElement("span");
    band.className = "timeline-gap-band";
    band.style.left = `${timelinePercent(gap.startTimestamp, state)}%`;
    band.style.width = `${state.duration <= 0 ? 0 : Math.max(0.15, (gap.duration / state.duration) * 100)}%`;
    band.dataset.start = String(gap.startTimestamp);
    band.dataset.end = String(gap.endTimestamp);
    band.setAttribute("aria-hidden", "true");
    const active =
      state.currentTimestamp !== undefined &&
      state.currentTimestamp > gap.startTimestamp &&
      state.currentTimestamp < gap.endTimestamp;
    button.classList.toggle("active", active);
    band.classList.toggle("active", active);
    buttons.push(button);
    nodes.push(button, band);
  }
  mount.replaceChildren(...nodes);
  if (focusedGap?.start !== undefined && focusedGap.end !== undefined) {
    buttons
      .find(({ dataset }) => dataset.start === focusedGap.start && dataset.end === focusedGap.end)
      ?.focus({ preventScroll: true });
  }
}

export function renderTimelineTicks(scope: RenderScope, state: TimelineRenderState): void {
  const mount = find<HTMLElement>(scope, "timeline-ticks");
  if (mount === null) {
    return;
  }
  const doc = mount.ownerDocument;
  const count = Math.max(2, Math.floor(state.tickCount ?? 6));
  const ticks = Array.from({ length: count }, (_, index) => {
    const tick = doc.createElement("span");
    tick.textContent = formatTimecode((state.duration * index) / (count - 1), false);
    return tick;
  });
  mount.replaceChildren(...ticks);
}

export function renderTimeline(scope: RenderScope, state: TimelineRenderState): void {
  renderTimelineWindows(scope, state);
  renderTimelineGaps(scope, state);
  renderTimelineMarkers(scope, state);
  renderTimelineTicks(scope, state);
  const scrubber = find<HTMLInputElement>(scope, "scrubber");
  const elapsed = Math.min(
    state.duration,
    Math.max(0, (state.currentTimestamp ?? state.startTimestamp) - state.startTimestamp),
  );
  if (scrubber !== null) {
    scrubber.min = "0";
    scrubber.max = String(Math.max(0, state.duration));
    scrubber.value = String(elapsed);
    scrubber.setAttribute(
      "aria-valuetext",
      `${formatTimecode(elapsed)} of ${formatTimecode(state.duration)}`,
    );
  }
  const progress = state.duration <= 0 ? 0 : (elapsed / state.duration) * 100;
  const fill = find<HTMLElement>(scope, "scrubber-fill");
  if (fill !== null) {
    fill.style.width = `${progress}%`;
  }
  const playhead = find<HTMLElement>(scope, "playhead");
  if (playhead !== null) {
    playhead.style.left = `${progress}%`;
  }
  setText(scope, "current-timecode", formatTimecode(elapsed));
  setText(scope, "duration-timecode", `/ ${formatTimecode(state.duration)}`);
  setText(scope, "scene-timecode", formatTimecode(elapsed));
}

export interface ReplayStatsRenderState {
  candidateSamples: number;
}

export function renderReplayStats(scope: RenderScope, state: ReplayStatsRenderState): void {
  setText(scope, "sample-stat", `${state.candidateSamples.toLocaleString()} samples`);
}

export type MobileView = "replay" | "incidents" | "evidence" | "signals";
export type InspectorView = "evidence" | "sample" | "rules";

export interface MobileTabRenderState {
  active: MobileView;
  /** True at the mobile breakpoint; desktop and tablet keep all workbench panels exposed. */
  mobileLayout: boolean;
}

export function renderMobileTabState(scope: RenderScope, state: MobileTabRenderState): void {
  const doc = documentFor(scope);
  const shell = find<HTMLElement>(scope, "app-shell");
  const previousLayout = shell?.dataset.mobileLayout;
  const layoutChanged =
    previousLayout !== undefined && (previousLayout === "true") !== state.mobileLayout;
  const focusedElement = doc.activeElement;
  const focusedPanel = focusedElement?.closest<HTMLElement>("[data-mobile-panel]") ?? null;
  const focusedTab = focusedElement?.closest<HTMLButtonElement>("[data-mobile-target]") ?? null;
  if (shell !== null) {
    if (state.mobileLayout && focusedTab?.dataset.mobileTarget !== undefined) {
      shell.dataset.lastFocusedMobileTab = focusedTab.dataset.mobileTarget;
    }
    shell.dataset.mobileView = state.active;
    shell.dataset.mobileLayout = String(state.mobileLayout);
  }
  for (const view of ["replay", "incidents", "evidence", "signals"] as const) {
    const selected = view === state.active;
    const tab = find<HTMLButtonElement>(scope, `mobile-tab-${view}`);
    tab?.setAttribute("aria-selected", String(selected));
    if (tab !== null) {
      tab.tabIndex = selected ? 0 : -1;
    }
    const panel = find<HTMLElement>(scope, `mobile-panel-${view}`);
    if (panel !== null) {
      panel.dataset.mobileActive = String(selected);
      panel.hidden = state.mobileLayout && !selected;
      if (state.mobileLayout) {
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute(
          "aria-label",
          `${view === "evidence" ? "Detector" : formatStateLabel(view)} workspace`,
        );
      } else {
        panel.removeAttribute("role");
        panel.removeAttribute("aria-label");
      }
    }
  }

  if (!layoutChanged) {
    return;
  }
  const rememberedMobileTab = shell?.dataset.lastFocusedMobileTab;
  const focusLostDuringMobileTransition =
    focusedElement === doc.body && rememberedMobileTab !== undefined;
  if (
    state.mobileLayout &&
    ((focusedPanel !== null && focusedPanel.dataset.mobilePanel !== state.active) ||
      focusLostDuringMobileTransition)
  ) {
    const activeTab = find<HTMLButtonElement>(scope, `mobile-tab-${state.active}`);
    activeTab?.focus({ preventScroll: true });
    if (shell !== null && activeTab !== null) {
      shell.dataset.lastFocusedMobileTab = state.active;
    }
    return;
  }
  if (
    !state.mobileLayout &&
    (focusedTab !== null || (focusedElement === doc.body && rememberedMobileTab !== undefined))
  ) {
    const targetView = focusedTab?.dataset.mobileTarget ?? rememberedMobileTab ?? state.active;
    const targetPanel = find<HTMLElement>(scope, `mobile-panel-${targetView}`);
    const nextTarget = [
      ...(targetPanel?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      ) ?? []),
    ].find((candidate) => candidate.closest("[hidden]") === null);
    nextTarget?.focus({ preventScroll: true });
  }
}

export function renderInspectorTabState(scope: RenderScope, active: InspectorView): void {
  for (const view of ["evidence", "sample", "rules"] as const) {
    const selected = view === active;
    const tab = find<HTMLButtonElement>(scope, `inspector-tab-${view}`);
    tab?.setAttribute("aria-selected", String(selected));
    if (tab !== null) {
      tab.tabIndex = selected ? 0 : -1;
    }
    const panel = find<HTMLElement>(scope, `inspector-panel-${view}`);
    if (panel !== null) {
      panel.hidden = !selected;
    }
  }
}
