import { analyzeSession, type AnalyzeSessionOptions } from "./analysis";
import { applyFaultBranches } from "./faults";
import {
  importRecording,
  RecordingImportError,
  type ImportedRecording,
  type ImportIssue,
  type ImportRecordingInput,
  type ImportRecordingOptions,
} from "./importers";
import { generateScenario, type ScenarioId } from "./scenarios";
import type { FaultSpecification, ReplaySessionV2, SessionAnalysis } from "./types";

export type AnalysisWorkerImportOptions = Omit<ImportRecordingOptions, "signal">;

export type AnalysisWorkerRequest =
  | {
      type: "analyze";
      requestId: string;
      session: ReplaySessionV2;
      options?: AnalyzeSessionOptions;
    }
  | {
      type: "generate-scenario";
      requestId: string;
      scenarioId: ScenarioId;
      analyze?: boolean;
      options?: AnalyzeSessionOptions;
    }
  | {
      type: "branch-fault";
      requestId: string;
      session: ReplaySessionV2;
      faults: FaultSpecification[];
      analyze?: boolean;
      options?: AnalyzeSessionOptions;
    }
  | {
      /** Parse locally inside the worker so large recordings never block UI. */
      type: "import-recording";
      requestId: string;
      input: ImportRecordingInput;
      options?: AnalysisWorkerImportOptions;
    }
  | {
      type: "cancel";
      requestId: string;
    };

export type AnalysisWorkerPhase =
  | "queued"
  | "preparing"
  | "generating"
  | "branching"
  | "reading-import"
  | "parsing-import"
  | "deriving-metrics"
  | "detecting-incidents"
  | "complete";

export type AnalysisWorkerResult =
  | { kind: "analysis"; analysis: SessionAnalysis }
  | { kind: "scenario"; session: ReplaySessionV2; analysis?: SessionAnalysis }
  | { kind: "fault-branch"; session: ReplaySessionV2; analysis?: SessionAnalysis }
  | { kind: "import-recording"; recording: ImportedRecording };

export type AnalysisWorkerResponse =
  | {
      type: "progress";
      requestId: string;
      phase: AnalysisWorkerPhase;
      progress: number;
      message: string;
    }
  | { type: "result"; requestId: string; result: AnalysisWorkerResult }
  | {
      type: "error";
      requestId: string;
      error: {
        code: string;
        message: string;
        stack?: string;
        issues?: ImportIssue[];
        totalIssueCount?: number;
        truncated?: boolean;
      };
    }
  | { type: "cancelled"; requestId: string };

export type AnalysisWorkerEmitter = (response: AnalysisWorkerResponse) => void;

interface WorkerEndpoint {
  postMessage(message: AnalysisWorkerResponse): void;
  onmessage: ((event: MessageEvent<AnalysisWorkerRequest>) => void) | null;
}

const cancelledRequestIds = new Set<string>();
const activeRequestIds = new Set<string>();

function progress(
  emit: AnalysisWorkerEmitter,
  requestId: string,
  phase: AnalysisWorkerPhase,
  amount: number,
  message: string,
): void {
  emit({ type: "progress", requestId, phase, progress: amount, message });
}

function yieldToMessageLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function ensureActive(requestId: string, emit: AnalysisWorkerEmitter): boolean {
  if (!cancelledRequestIds.delete(requestId)) {
    return true;
  }
  emit({ type: "cancelled", requestId });
  return false;
}

function errorCode(error: unknown): string {
  if (error instanceof RecordingImportError) {
    return "IMPORT_FAILED";
  }
  if (error instanceof RangeError) {
    return "INVALID_REQUEST";
  }
  if (error instanceof TypeError) {
    return "INVALID_DATA";
  }
  return "ANALYSIS_FAILED";
}

/**
 * Testable worker dispatcher. Progress stages yield to the message loop so a
 * cancel request can be observed before the next expensive synchronous phase.
 */
export async function handleAnalysisWorkerRequest(
  request: AnalysisWorkerRequest,
  emit: AnalysisWorkerEmitter,
): Promise<void> {
  if (request.type === "cancel") {
    // Unknown/finished request IDs are intentionally ignored. Retaining them
    // as tombstones could cancel an unrelated future request that reuses an ID.
    if (activeRequestIds.has(request.requestId)) {
      cancelledRequestIds.add(request.requestId);
    }
    return;
  }
  if (activeRequestIds.has(request.requestId)) {
    emit({
      type: "error",
      requestId: request.requestId,
      error: {
        code: "INVALID_REQUEST",
        message: `Request ID ${request.requestId} is already active.`,
      },
    });
    return;
  }
  activeRequestIds.add(request.requestId);
  try {
    progress(emit, request.requestId, "queued", 0.02, "Request queued");
    await yieldToMessageLoop();
    if (!ensureActive(request.requestId, emit)) {
      return;
    }

    if (request.type === "analyze") {
      progress(emit, request.requestId, "deriving-metrics", 0.35, "Deriving replay metrics");
      await yieldToMessageLoop();
      if (!ensureActive(request.requestId, emit)) {
        return;
      }
      progress(emit, request.requestId, "detecting-incidents", 0.7, "Evaluating detector rules");
      const analysis = analyzeSession(request.session, request.options);
      progress(emit, request.requestId, "complete", 1, "Analysis complete");
      emit({
        type: "result",
        requestId: request.requestId,
        result: { kind: "analysis", analysis },
      });
      return;
    }

    if (request.type === "import-recording") {
      progress(emit, request.requestId, "reading-import", 0.15, "Reading local recording");
      await yieldToMessageLoop();
      if (!ensureActive(request.requestId, emit)) {
        return;
      }
      progress(emit, request.requestId, "parsing-import", 0.45, "Checking telemetry channels");
      const recording = await importRecording(request.input, request.options);
      if (!ensureActive(request.requestId, emit)) {
        return;
      }
      progress(emit, request.requestId, "complete", 1, "Recording ready");
      emit({
        type: "result",
        requestId: request.requestId,
        result: { kind: "import-recording", recording },
      });
      return;
    }

    if (request.type === "generate-scenario") {
      progress(emit, request.requestId, "generating", 0.25, "Generating deterministic mission");
      const session = generateScenario(request.scenarioId);
      await yieldToMessageLoop();
      if (!ensureActive(request.requestId, emit)) {
        return;
      }
      const analysis =
        request.analyze === false ? undefined : analyzeSession(session, request.options);
      progress(emit, request.requestId, "complete", 1, "Scenario ready");
      emit({
        type: "result",
        requestId: request.requestId,
        result: { kind: "scenario", session, ...(analysis === undefined ? {} : { analysis }) },
      });
      return;
    }

    progress(emit, request.requestId, "branching", 0.25, "Applying Fault Lab branch");
    const session = applyFaultBranches(request.session, request.faults);
    await yieldToMessageLoop();
    if (!ensureActive(request.requestId, emit)) {
      return;
    }
    const analysis =
      request.analyze === false ? undefined : analyzeSession(session, request.options);
    progress(emit, request.requestId, "complete", 1, "Fault branch ready");
    emit({
      type: "result",
      requestId: request.requestId,
      result: { kind: "fault-branch", session, ...(analysis === undefined ? {} : { analysis }) },
    });
  } catch (error) {
    const detail = error instanceof Error ? error : new Error("Unknown worker failure");
    const importDetail =
      error instanceof RecordingImportError
        ? {
            issues: [...error.issues],
            totalIssueCount: error.totalIssueCount,
            truncated: error.truncated,
          }
        : {};
    emit({
      type: "error",
      requestId: request.requestId,
      error: {
        code: errorCode(error),
        message: detail.message,
        ...(detail.stack === undefined ? {} : { stack: detail.stack }),
        ...importDetail,
      },
    });
  } finally {
    activeRequestIds.delete(request.requestId);
    cancelledRequestIds.delete(request.requestId);
  }
}

export function installAnalysisWorker(endpoint: WorkerEndpoint): void {
  endpoint.onmessage = (event): void => {
    void handleAnalysisWorkerRequest(event.data, (response) => endpoint.postMessage(response));
  };
}

const globalEndpoint = globalThis as unknown as WorkerEndpoint & {
  document?: unknown;
  importScripts?: unknown;
};
if (
  globalEndpoint.document === undefined &&
  typeof globalEndpoint.postMessage === "function" &&
  "importScripts" in globalEndpoint
) {
  installAnalysisWorker(globalEndpoint);
}
