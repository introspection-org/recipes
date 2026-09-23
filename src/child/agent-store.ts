/**
 * Filesystem persistence for background agent runs.
 *
 * Each run owns `<workspace>/.pi/agents/<runId>/status.json` — a rolling
 * snapshot of the run state. Snapshots let a later Pi process in the same
 * workspace rehydrate
 * run ids referenced by a resumed conversation: rehydrated runs are readable
 * (status/wait) but not controllable, and a run persisted as `running` died
 * with the previous process, so it is flipped to `interrupted` on rehydrate
 * rather than silently "resumed".
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type ChildRunStatus = "running" | "completed" | "failed" | "interrupted";
export type ChildToolStatus = "running" | "completed" | "failed";

export interface ChildToolActivity {
  id: string;
  name: string;
  args: unknown;
  status: ChildToolStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
}

export interface ChildRunSnapshot {
  id: string;
  agent: string;
  label?: string;
  prompt: string;
  status: ChildRunStatus;
  startedAt: string;
  completedAt?: string;
  output?: string;
  error?: string;
  toolCalls: ChildToolActivity[];
}

const RUN_STATUSES: readonly string[] = [
  "running",
  "completed",
  "failed",
  "interrupted",
];

function normalizeChildRunSnapshot(value: unknown): ChildRunSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const original = value as Record<string, unknown>;
  const prompt =
    typeof original.prompt === "string"
      ? original.prompt
      : typeof original.task === "string"
        ? original.task
        : undefined;
  const record: Record<string, unknown> = { ...original, prompt };
  delete record.task;
  if (
    !(
      typeof record.id === "string" &&
      typeof record.agent === "string" &&
      typeof record.prompt === "string" &&
      typeof record.status === "string" &&
      RUN_STATUSES.includes(record.status) &&
      typeof record.startedAt === "string" &&
      Array.isArray(record.toolCalls)
    )
  ) {
    return null;
  }
  return record as unknown as ChildRunSnapshot;
}

export class ChildAgentRunStore {
  private readonly root: string;
  // Concurrent writes to one status.json interleave (each truncates on open),
  // so snapshot writes for a run are chained behind the previous one.
  private readonly pendingWrites = new Map<string, Promise<void>>();

  constructor(workspaceDir: string) {
    this.root = join(workspaceDir, ".pi", "agents");
  }

  async writeStatus(snapshot: ChildRunSnapshot): Promise<void> {
    const previous = this.pendingWrites.get(snapshot.id) ?? Promise.resolve();
    const write = previous
      .catch(() => {})
      .then(async () => {
        const runDir = join(this.root, snapshot.id);
        await mkdir(runDir, { recursive: true });
        await writeFile(
          join(runDir, "status.json"),
          `${JSON.stringify(snapshot, null, 2)}\n`,
          "utf8"
        );
      });
    this.pendingWrites.set(snapshot.id, write);
    try {
      await write;
    } finally {
      if (this.pendingWrites.get(snapshot.id) === write) {
        this.pendingWrites.delete(snapshot.id);
      }
    }
  }

  /**
   * Status snapshots persisted by any prior process for this workspace, one
   * per `.pi/agents/<runId>/status.json`. Unreadable or malformed entries are
   * skipped — rehydration is best-effort.
   */
  async readPersistedSnapshots(): Promise<ChildRunSnapshot[]> {
    let runIds: string[];
    try {
      runIds = await readdir(this.root);
    } catch {
      return [];
    }
    const snapshots: ChildRunSnapshot[] = [];
    for (const runId of runIds) {
      try {
        const raw = await readFile(
          join(this.root, runId, "status.json"),
          "utf8"
        );
        const parsed = normalizeChildRunSnapshot(JSON.parse(raw));
        if (parsed?.id === runId) {
          snapshots.push(parsed);
        }
      } catch {
        // skip unreadable runs
      }
    }
    return snapshots;
  }
}
