import {
  assertReplaySession,
  cloneReplaySession,
  fingerprintReplaySessionContent,
  fingerprintReplaySessionInterpretation,
  MAX_REPLAY_IDENTIFIER_LENGTH,
  sha256StableValue,
} from "./session";
import type {
  AppliedFaultTransformation,
  FaultSpecification,
  MotorLoadFault,
  PacketDropoutFault,
  PoseResetFault,
  ReplaySessionV2,
} from "./types";

/**
 * A branch is a deterministic derivation from an already fingerprinted parent.
 * Versioning the recipe keeps the compact digest auditable if transforms evolve.
 */
const FAULT_BRANCH_FINGERPRINT_ALGORITHM = "robot-replay/fault-branch-sha256/v3";
const ROOT_SESSION_FINGERPRINT_ALGORITHM = "robot-replay/root-session-sha256/v1";
const FAULT_BRANCH_NOTE = "Modified locally by deterministic Fault Lab transformations.";
const FAULT_FINGERPRINT_NOTE = `Provenance fingerprint uses ${FAULT_BRANCH_FINGERPRINT_ALGORITHM} over the root-session fingerprint, interpretation context, resulting candidate recording, and ordered cumulative transformations.`;

function withoutRepeatedSuffix(value: string, suffix: string): string {
  let result = value;
  while (result.endsWith(suffix)) {
    result = result.slice(0, -suffix.length);
  }
  return result;
}

function rootCandidateId(id: string): string {
  let result = id;
  const suffix = /--branch-\d+-[0-9a-f]{16}$/;
  while (suffix.test(result)) {
    result = result.replace(suffix, "");
  }
  return result;
}

function rootSessionFingerprint(session: ReplaySessionV2): string {
  // A root hash carried by a pristine import is an unauthenticated claim. Only
  // an existing transformation chain can legitimately carry its established
  // root forward; otherwise anchor the lineage in the source actually loaded.
  if (session.transformations.length > 0 && session.provenance.rootSessionSha256 !== undefined) {
    return session.provenance.rootSessionSha256;
  }
  return sha256StableValue({
    algorithm: ROOT_SESSION_FINGERPRINT_ALGORITHM,
    sourceSha256: session.provenance.sha256,
    contentSha256: fingerprintReplaySessionContent(session),
  });
}

function sliceIdentifierPrefix(value: string, maximumLength: number): string {
  if (value.length <= maximumLength) {
    return value;
  }
  let end = maximumLength;
  const previous = value.charCodeAt(end - 1);
  const next = value.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return value.slice(0, end).normalize("NFC");
}

function derivedIdentifier(
  root: string,
  suffix: string,
  reserved: ReadonlySet<string> = new Set(),
): string {
  let discriminator = 0;
  while (true) {
    const uniqueSuffix = discriminator === 0 ? suffix : `${suffix}-${discriminator + 1}`;
    if (uniqueSuffix.length >= MAX_REPLAY_IDENTIFIER_LENGTH) {
      throw new RangeError("derived identifier suffix exceeds the replay schema limit");
    }
    const prefix = sliceIdentifierPrefix(root, MAX_REPLAY_IDENTIFIER_LENGTH - uniqueSuffix.length);
    const candidate = `${prefix}${uniqueSuffix}`;
    if (!reserved.has(candidate)) {
      return candidate;
    }
    discriminator += 1;
  }
}

function allocateTransformationId(
  specification: FaultSpecification,
  transformationIndex: number,
  reserved: ReadonlySet<string>,
): string {
  const root = `${specification.type}-${specification.startTimestamp.toFixed(3)}-${transformationIndex}`;
  return derivedIdentifier(root, "", reserved);
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new RangeError(`${name} must be finite`);
  }
}

function requireRange(value: number, minimum: number, maximum: number, name: string): void {
  requireFinite(value, name);
  if (value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}`);
  }
}

export function validateFaultSpecification(
  session: ReplaySessionV2,
  specification: FaultSpecification,
): void {
  const firstTimestamp = session.runs.candidate.samples[0]?.timestamp;
  const lastTimestamp = session.runs.candidate.samples.at(-1)?.timestamp;
  if (firstTimestamp === undefined || lastTimestamp === undefined) {
    throw new RangeError("the candidate run must contain telemetry samples");
  }
  requireFinite(specification.startTimestamp, "startTimestamp");
  if (
    specification.startTimestamp < firstTimestamp ||
    specification.startTimestamp > lastTimestamp
  ) {
    throw new RangeError("startTimestamp must fall inside the candidate run");
  }
  switch (specification.type) {
    case "packet-dropout":
      requireRange(specification.duration, 0.1, 3, "duration");
      if (specification.startTimestamp >= lastTimestamp) {
        throw new RangeError("packet-dropout must start before the final candidate sample");
      }
      break;
    case "pose-reset":
      requireRange(specification.offsetX, -2, 2, "offsetX");
      requireRange(specification.offsetY, -2, 2, "offsetY");
      requireRange(specification.offsetYaw, -Math.PI / 2, Math.PI / 2, "offsetYaw");
      if (
        specification.offsetX === 0 &&
        specification.offsetY === 0 &&
        specification.offsetYaw === 0
      ) {
        throw new RangeError("pose-reset must include at least one non-zero offset");
      }
      break;
    case "motor-load":
      requireRange(specification.duration, 0.5, 5, "duration");
      requireRange(specification.multiplier, 1, 3, "multiplier");
      if (specification.startTimestamp >= lastTimestamp) {
        throw new RangeError("motor-load must start before the final candidate sample");
      }
      if (specification.multiplier === 1) {
        throw new RangeError("motor-load multiplier must change the recorded current");
      }
      {
        const endTimestamp = Math.min(
          lastTimestamp,
          specification.startTimestamp + specification.duration,
        );
        for (const sample of session.runs.candidate.samples) {
          if (
            sample.timestamp >= specification.startTimestamp &&
            sample.timestamp < endTimestamp &&
            sample.current !== null &&
            !Number.isFinite(sample.current * specification.multiplier)
          ) {
            throw new RangeError(
              `motor-load would produce non-finite current at ${sample.timestamp.toFixed(3)} s`,
            );
          }
        }
      }
      break;
  }
}

function normalizeYaw(yaw: number): number {
  const twoPi = Math.PI * 2;
  return ((((yaw + Math.PI) % twoPi) + twoPi) % twoPi) - Math.PI;
}

function applyToCandidate(
  session: ReplaySessionV2,
  specification: FaultSpecification,
  id: string,
): AppliedFaultTransformation {
  const run = session.runs.candidate;
  const finalTimestamp = run.samples.at(-1)?.timestamp ?? specification.startTimestamp;
  switch (specification.type) {
    case "packet-dropout": {
      const endTimestamp = Math.min(
        finalTimestamp,
        specification.startTimestamp + specification.duration,
      );
      const originalCount = run.samples.length;
      run.samples = run.samples.filter(
        ({ timestamp }) => timestamp <= specification.startTimestamp || timestamp >= endTimestamp,
      );
      return {
        id,
        type: specification.type,
        startTimestamp: specification.startTimestamp,
        endTimestamp,
        parameters: { duration: specification.duration },
        affectedSamples: originalCount - run.samples.length,
      };
    }
    case "pose-reset": {
      let affectedSamples = 0;
      for (const sample of run.samples) {
        if (sample.timestamp >= specification.startTimestamp) {
          const nextX = sample.pose.x + specification.offsetX;
          const nextY = sample.pose.y + specification.offsetY;
          const nextYaw =
            specification.offsetYaw === 0
              ? sample.pose.yaw
              : normalizeYaw(sample.pose.yaw + specification.offsetYaw);
          if (nextX !== sample.pose.x || nextY !== sample.pose.y || nextYaw !== sample.pose.yaw) {
            sample.pose.x = nextX;
            sample.pose.y = nextY;
            sample.pose.yaw = nextYaw;
            affectedSamples += 1;
          }
        }
      }
      return {
        id,
        type: specification.type,
        startTimestamp: specification.startTimestamp,
        endTimestamp: finalTimestamp,
        parameters: {
          offsetX: specification.offsetX,
          offsetY: specification.offsetY,
          offsetYaw: specification.offsetYaw,
        },
        affectedSamples,
      };
    }
    case "motor-load": {
      const endTimestamp = Math.min(
        finalTimestamp,
        specification.startTimestamp + specification.duration,
      );
      let affectedSamples = 0;
      for (const sample of run.samples) {
        if (
          sample.timestamp >= specification.startTimestamp &&
          sample.timestamp < endTimestamp &&
          sample.current !== null
        ) {
          const nextCurrent = sample.current * specification.multiplier;
          if (nextCurrent !== sample.current) {
            sample.current = nextCurrent;
            affectedSamples += 1;
          }
        }
      }
      return {
        id,
        type: specification.type,
        startTimestamp: specification.startTimestamp,
        endTimestamp,
        parameters: {
          duration: specification.duration,
          multiplier: specification.multiplier,
        },
        affectedSamples,
      };
    }
  }
}

/**
 * Create a deterministic, non-destructive candidate branch. The source
 * session and its samples are never mutated.
 */
export function applyFaultBranch(
  sourceSession: ReplaySessionV2,
  specification: FaultSpecification,
): ReplaySessionV2 {
  return applyFaultBranches(sourceSession, [specification]);
}

/** Apply several Fault Lab operations in order while cloning only once. */
export function applyFaultBranches(
  sourceSession: ReplaySessionV2,
  specifications: readonly FaultSpecification[],
): ReplaySessionV2 {
  if (specifications.length === 0) {
    return cloneReplaySession(sourceSession);
  }
  const branch = cloneReplaySession(sourceSession);
  const priorTransformations = branch.transformations.length;
  const transformationIds = new Set(branch.transformations.map(({ id }) => id));
  specifications.forEach((specification, index) => {
    validateFaultSpecification(branch, specification);
    const transformationId = allocateTransformationId(
      specification,
      priorTransformations + index + 1,
      transformationIds,
    );
    const transformation = applyToCandidate(branch, specification, transformationId);
    if (transformation.affectedSamples === 0) {
      throw new RangeError(`${specification.type} did not affect any candidate samples`);
    }
    branch.transformations.push(transformation);
    transformationIds.add(transformation.id);
  });
  const rootSessionId = sourceSession.provenance.parentSessionId ?? sourceSession.id;
  const rootCandidateIdentifier = rootCandidateId(sourceSession.runs.candidate.id);
  const rootSessionSha256 = rootSessionFingerprint(sourceSession);
  const interpretationSha256 = fingerprintReplaySessionInterpretation(sourceSession);
  const branchCandidateName = `${withoutRepeatedSuffix(sourceSession.runs.candidate.name, " · modified")} · modified`;
  const branchProvenanceLabel = `${withoutRepeatedSuffix(sourceSession.provenance.label, " · Fault Lab branch")} · Fault Lab branch`;
  const branchNotes = [
    ...(branch.provenance.notes ?? []).filter(
      (note) =>
        note !== FAULT_BRANCH_NOTE &&
        !note.startsWith("Provenance fingerprint uses robot-replay/fault-branch-sha256/"),
    ),
    FAULT_BRANCH_NOTE,
    FAULT_FINGERPRINT_NOTE,
  ];
  branch.runs.candidate.name = branchCandidateName;
  branch.runs.candidate.kind = "faulty";
  if (branch.mission.outcome === "nominal") {
    branch.mission.outcome = "degraded";
  }
  const branchFingerprint = sha256StableValue({
    algorithm: FAULT_BRANCH_FINGERPRINT_ALGORITHM,
    rootSessionId,
    rootSessionSha256,
    interpretationSha256,
    mission: branch.mission,
    candidate: {
      ...branch.runs.candidate,
      id: rootCandidateIdentifier,
    },
    transformations: branch.transformations,
    provenanceContext: {
      source: "derived",
      label: branchProvenanceLabel,
      importedAt: branch.provenance.importedAt,
      deterministic: branch.provenance.deterministic,
      notes: branchNotes,
    },
  });
  const branchSuffix = branchFingerprint.slice(0, 16);
  branch.id = derivedIdentifier(
    rootSessionId,
    `--fault-lab-${branch.transformations.length}-${branchSuffix}`,
  );
  branch.runs.candidate.id = derivedIdentifier(
    rootCandidateIdentifier,
    `--branch-${branch.transformations.length}-${branchSuffix}`,
    new Set(branch.runs.baseline === undefined ? [] : [branch.runs.baseline.id]),
  );
  branch.provenance = {
    ...branch.provenance,
    source: "derived",
    label: branchProvenanceLabel,
    parentSessionId: rootSessionId,
    rootSessionSha256,
    sha256: branchFingerprint,
    notes: branchNotes,
  };
  assertReplaySession(branch);
  return branch;
}

export function branchPacketDropout(
  session: ReplaySessionV2,
  startTimestamp: number,
  duration: number,
): ReplaySessionV2 {
  const fault: PacketDropoutFault = { type: "packet-dropout", startTimestamp, duration };
  return applyFaultBranch(session, fault);
}

export function branchPoseReset(
  session: ReplaySessionV2,
  startTimestamp: number,
  offsetX: number,
  offsetY: number,
  offsetYaw: number,
): ReplaySessionV2 {
  const fault: PoseResetFault = {
    type: "pose-reset",
    startTimestamp,
    offsetX,
    offsetY,
    offsetYaw,
  };
  return applyFaultBranch(session, fault);
}

export function branchMotorLoad(
  session: ReplaySessionV2,
  startTimestamp: number,
  duration: number,
  multiplier: number,
): ReplaySessionV2 {
  const fault: MotorLoadFault = {
    type: "motor-load",
    startTimestamp,
    duration,
    multiplier,
  };
  return applyFaultBranch(session, fault);
}

/**
 * Reset is intentionally based on the pristine session retained by the UI;
 * packet removal cannot be honestly reconstructed from a serialized branch.
 */
export function resetFaultBranch(originalSession: ReplaySessionV2): ReplaySessionV2 {
  if (originalSession.transformations.length > 0) {
    throw new RangeError("resetFaultBranch requires the pristine source session");
  }
  return cloneReplaySession(originalSession);
}

export const createFaultBranch = applyFaultBranch;
