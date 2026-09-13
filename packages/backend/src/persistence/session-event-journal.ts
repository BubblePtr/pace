// Session Event Journal — the persistence half of replay (ADR-0020, slice 6).
// The Gateway appends boundary envelopes here; snapshots read them back so a
// reattaching client rebuilds its runtime model statically. Files are plain
// JSONL so history survives a process restart and stays auditable.

import * as fs from "node:fs";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  RuntimeGatewayEventEnvelope,
  RuntimeGatewayEventInput,
} from "@pace/core";

// Pace's own data lives outside ~/.pi — that directory is Pi's session truth
// and Pace only observes it. PIGUI_DATA_DIR remains a one-minor-version alias.
function resolveDataDirOverride(env: NodeJS.ProcessEnv): string | undefined {
  if (env.PACE_DATA_DIR) return env.PACE_DATA_DIR;
  if (env.PIGUI_DATA_DIR) {
    console.warn("PIGUI_DATA_DIR is deprecated; use PACE_DATA_DIR.");
    return env.PIGUI_DATA_DIR;
  }
}

export function resolveDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  return resolveDataDirOverride(env) || join(homeDir, ".pace");
}

export function migrateDataDir(env: NodeJS.ProcessEnv, homeDir: string): string {
  const override = resolveDataDirOverride(env);
  if (override) {
    return override;
  }

  const dataDir = resolveDataDir(env, homeDir);
  const legacyDataDir = join(homeDir, ".pigui");
  if (fs.existsSync(legacyDataDir)) {
    try {
      if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0 && fs.readdirSync(legacyDataDir).length > 0) {
        fs.rmdirSync(dataDir);
      }
      if (!fs.existsSync(dataDir)) fs.renameSync(legacyDataDir, dataDir);
    } catch (error) {
      console.warn(`Pace could not migrate ${legacyDataDir} to ${dataDir}; continuing with the old directory.`, error);
      return legacyDataDir;
    }
  }
  fs.mkdirSync(dataDir, { recursive: true });
  return dataDir;
}

export type SessionEventJournal = {
  append(envelope: RuntimeGatewayEventEnvelope): void;
  flush?(): Promise<void>;
  read(piSessionId: string): Promise<RuntimeGatewayEventEnvelope[]>;
};

export type PreparedSessionEventJournalFork = {
  eventsBeforeForkPoint: RuntimeGatewayEventEnvelope[];
  sourceSessionId?: string;
};

export type FileSessionEventJournalOptions = {
  dataDir: string;
};

function cloneEnvelope(envelope: RuntimeGatewayEventEnvelope): RuntimeGatewayEventEnvelope {
  return { ...envelope, payload: { ...envelope.payload } };
}

function isForkPointEvent(
  envelope: RuntimeGatewayEventEnvelope,
  piEntryId: string,
) {
  return envelope.payload.piEntryId === piEntryId;
}

export async function prepareSessionEventJournalFork(input: {
  journal: SessionEventJournal;
  sourcePiSessionId: string;
  piEntryId: string;
}): Promise<PreparedSessionEventJournalFork> {
  const sourceEvents = await input.journal.read(input.sourcePiSessionId);
  const eventsBeforeForkPoint: RuntimeGatewayEventEnvelope[] = [];
  let sourceSessionId: string | undefined;

  for (const sourceEvent of sourceEvents) {
    sourceSessionId = sourceEvent.sessionId;

    if (isForkPointEvent(sourceEvent, input.piEntryId)) {
      return {
        eventsBeforeForkPoint,
        ...(sourceSessionId ? { sourceSessionId } : {}),
      };
    }

    eventsBeforeForkPoint.push(cloneEnvelope(sourceEvent));
  }

  throw new Error(
    `Fork point "${input.piEntryId}" was not found in the Session Event Journal.`,
  );
}

const IDENTITY_FIELD_NAMES = new Set([
  "piSessionId",
  "runtimeId",
  "runId",
  "turnId",
  "messageId",
  "partId",
]);

function rewriteIdentityString(
  value: string,
  sourcePiSessionId: string,
  targetPiSessionId: string,
) {
  return value.split(sourcePiSessionId).join(targetPiSessionId);
}

function rewriteIdentityFields(
  value: unknown,
  sourcePiSessionId: string,
  targetPiSessionId: string,
  fieldName?: string,
): unknown {
  if (typeof value === "string") {
    return fieldName && IDENTITY_FIELD_NAMES.has(fieldName)
      ? rewriteIdentityString(value, sourcePiSessionId, targetPiSessionId)
      : value;
  }

  if (Array.isArray(value)) {
    return value.map((item) =>
      rewriteIdentityFields(item, sourcePiSessionId, targetPiSessionId),
    );
  }

  if (typeof value !== "object" || value === null) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, nestedValue]) => [
      key,
      rewriteIdentityFields(
        nestedValue,
        sourcePiSessionId,
        targetPiSessionId,
        key,
      ),
    ]),
  );
}

export function copiedSessionEventInputsForFork(input: {
  prepared: PreparedSessionEventJournalFork;
  sourcePiSessionId: string;
  targetSessionId: string;
  targetPiSessionId: string;
}): RuntimeGatewayEventInput[] {
  return input.prepared.eventsBeforeForkPoint.map((sourceEvent) => ({
    sessionId: input.targetSessionId,
    piSessionId: input.targetPiSessionId,
    turnId: sourceEvent.turnId
      ? rewriteIdentityString(
          sourceEvent.turnId,
          input.sourcePiSessionId,
          input.targetPiSessionId,
        )
      : undefined,
    type: sourceEvent.type,
    ts: sourceEvent.ts,
    payload: rewriteIdentityFields(
      sourceEvent.payload,
      input.sourcePiSessionId,
      input.targetPiSessionId,
    ) as Record<string, unknown>,
  }));
}

export function forkMarkerEventInput(input: {
  prepared: PreparedSessionEventJournalFork;
  sourcePiSessionId: string;
  targetSessionId: string;
  targetPiSessionId: string;
  piEntryId: string;
}): RuntimeGatewayEventInput {
  return {
    sessionId: input.targetSessionId,
    piSessionId: input.targetPiSessionId,
    type: "fork",
    payload: {
      kind: "fork",
      sourcePiSessionId: input.sourcePiSessionId,
      ...(input.prepared.sourceSessionId
        ? { sourceSessionId: input.prepared.sourceSessionId }
        : {}),
      piEntryId: input.piEntryId,
    },
  };
}

export function createInMemorySessionEventJournal(): SessionEventJournal {
  const entries = new Map<string, RuntimeGatewayEventEnvelope[]>();

  return {
    append(envelope) {
      const session = entries.get(envelope.piSessionId) ?? [];

      session.push(cloneEnvelope(envelope));
      entries.set(envelope.piSessionId, session);
    },

    async read(piSessionId) {
      return (entries.get(piSessionId) ?? []).map(cloneEnvelope);
    },
  };
}

// URI-encoding keeps path separators out of the file name, so a hostile
// session id cannot traverse outside the sessions directory.
function journalFileName(piSessionId: string) {
  return `${encodeURIComponent(piSessionId)}.jsonl`;
}

function parseJournalLines(jsonl: string): RuntimeGatewayEventEnvelope[] {
  const envelopes: RuntimeGatewayEventEnvelope[] = [];

  for (const line of jsonl.split("\n")) {
    if (!line.trim()) {
      continue;
    }

    try {
      envelopes.push(JSON.parse(line) as RuntimeGatewayEventEnvelope);
    } catch {
      // A torn trailing line (crash mid-append) must not poison the rest of
      // the journal.
      continue;
    }
  }

  return envelopes;
}

function withoutRedundantToolUpdates(
  envelopes: RuntimeGatewayEventEnvelope[],
): RuntimeGatewayEventEnvelope[] {
  const ended = new Set<string>();
  const lastUpdate = new Map<string, number>();

  for (const [index, { payload }] of envelopes.entries()) {
    if (payload.type !== "tool" || typeof payload.toolCallId !== "string") continue;
    if (payload.phase === "end") ended.add(payload.toolCallId);
    if (payload.phase === "update") lastUpdate.set(payload.toolCallId, index);
  }

  // End events supersede cumulative snapshots. For a crash mid-tool, replay
  // still needs the last partial result to show the output produced before it.
  return envelopes.filter(({ payload }, index) => {
    if (payload.type !== "tool" || payload.phase !== "update") return true;
    return typeof payload.toolCallId === "string" &&
      !ended.has(payload.toolCallId) && lastUpdate.get(payload.toolCallId) === index;
  });
}

export function createFileSessionEventJournal(
  options: FileSessionEventJournalOptions,
): SessionEventJournal {
  const sessionsDir = join(options.dataDir, "sessions");
  const buffered = new Map<string, RuntimeGatewayEventEnvelope[]>();
  // Appends are serialized on one chain; a failed write is reported but must
  // not break the chain or the in-memory buffer.
  let pendingWrites: Promise<void> = Promise.resolve();

  const bufferFor = (piSessionId: string) => {
    const session = buffered.get(piSessionId) ?? [];

    buffered.set(piSessionId, session);

    return session;
  };

  return {
    flush: () => pendingWrites,
    append(envelope) {
      bufferFor(envelope.piSessionId).push(cloneEnvelope(envelope));

      const line = `${JSON.stringify(envelope)}\n`;
      const path = join(sessionsDir, journalFileName(envelope.piSessionId));

      pendingWrites = pendingWrites
        .then(async () => {
          await mkdir(sessionsDir, { recursive: true });
          await appendFile(path, line, "utf8");
        })
        .catch((error) => {
          console.error(
            `Pace session event journal failed to append to "${path}":`,
            error,
          );
        });
    },

    async read(piSessionId) {
      await pendingWrites;

      const session = buffered.get(piSessionId);

      if (session) {
        const retained = withoutRedundantToolUpdates(session);
        buffered.set(piSessionId, retained);
        return retained.map(cloneEnvelope);
      }

      // Not seen in this process: a prior process may have journaled it.
      try {
        const restored = withoutRedundantToolUpdates(parseJournalLines(
          await readFile(join(sessionsDir, journalFileName(piSessionId)), "utf8"),
        ));

        buffered.set(piSessionId, restored);

        return restored.map(cloneEnvelope);
      } catch {
        return [];
      }
    },
  };
}
