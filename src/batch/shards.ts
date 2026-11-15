import { join } from "node:path";
import type { BatchFiles } from "./files.js";

/** Where the runner records results and reads back what an earlier run recorded. */
export interface BatchResults {
  /** Every recorded result line, oldest first; the last line per `custom_id` wins. */
  read(): Promise<string>;
  append(line: string): Promise<void>;
}

/** Results in one JSONL file: the simplest store, resumable from the file itself. */
export function jsonlResults(files: BatchFiles, path: string): BatchResults {
  return {
    read: async () => (await files.read(path)) ?? "",
    append: (line) => files.appendLine(path, line),
  };
}

/** Results kept in memory: for a batch run once in this process, with nothing to resume. */
export function memoryResults(): BatchResults {
  let text = "";
  return {
    read: async () => text,
    append: async (line) => {
      text += `${line}\n`;
    },
  };
}

/** `results` → `results-00001.jsonl`: sortable, and never written twice. */
export function shardName(stem: string, index: number): string {
  return `${stem}-${String(index).padStart(5, "0")}.jsonl`;
}

function shardIndex(stem: string, name: string): number | null {
  const match = new RegExp(`^${stem}-(\\d{5,})\\.jsonl$`).exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * Results recorded in immutable numbered shards. Lines append to an open
 * file in `workDir`; `seal()` moves what it holds into `dir` as the next
 * shard, which never changes afterwards. A host that copies results elsewhere
 * (from `onProgress`, say) copies each sealed shard once.
 *
 * Appends and seals share one queue, so a seal never splits a line. A run
 * that starts beside an open file a dead process left seals it first: its
 * complete lines are results, and a torn last line is dropped, so that line
 * runs again.
 */
export class ResultShards implements BatchResults {
  private queue: Promise<unknown> = Promise.resolve();
  private openLines = 0;
  private nextIndex = 1;
  private readonly openPath: string;

  constructor(
    private readonly files: BatchFiles,
    private readonly dir: string,
    workDir: string,
    private readonly stem: string,
  ) {
    this.openPath = join(workDir, `${stem}.open.jsonl`);
  }

  /** The sealed shards' names, in order. */
  async sealed(): Promise<string[]> {
    const names = await this.files.list(this.dir);
    return names
      .map((name) => ({ name, index: shardIndex(this.stem, name) }))
      .filter(
        (entry): entry is { name: string; index: number } =>
          entry.index !== null,
      )
      .sort((a, b) => a.index - b.index)
      .map((entry) => entry.name);
  }

  async read(): Promise<string> {
    const leftover = await this.files.read(this.openPath);
    if (leftover !== null) {
      const complete = leftover.slice(0, leftover.lastIndexOf("\n") + 1);
      await this.files.write(this.openPath, complete);
      this.openLines = complete
        .split("\n")
        .filter((line) => line.trim()).length;
    }
    const names = await this.sealed();
    const last = names.at(-1);
    this.nextIndex =
      last === undefined ? 1 : (shardIndex(this.stem, last) ?? 0) + 1;
    await this.seal();
    const texts = await Promise.all(
      (await this.sealed()).map((name) =>
        this.files.read(join(this.dir, name)),
      ),
    );
    return texts.map((text) => text ?? "").join("");
  }

  append(line: string): Promise<void> {
    return this.enqueue(async () => {
      await this.files.appendLine(this.openPath, line);
      this.openLines += 1;
    });
  }

  /** Move the open lines into `dir` as the next shard; resolves to its name, or null when there was nothing to seal. */
  seal(): Promise<string | null> {
    return this.enqueue(async () => {
      if (this.openLines === 0) return null;
      const text = (await this.files.read(this.openPath)) ?? "";
      const name = shardName(this.stem, this.nextIndex);
      // Written before the open file is removed: a crash between the two
      // leaves the lines in both, and the last line per custom_id wins.
      await this.files.write(join(this.dir, name), text);
      await this.files.remove(this.openPath);
      this.nextIndex += 1;
      this.openLines = 0;
      return name;
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
