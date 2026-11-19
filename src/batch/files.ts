import { createReadStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

/** The file operations a batch needs; inject your own to keep a batch's files anywhere. */
export interface BatchFiles {
  /** The file's text, or null when it does not exist yet. */
  read(path: string): Promise<string | null>;
  /**
   * The file's lines, one at a time, so a large input never sits in memory
   * whole; null when it does not exist. Without it a batch reads the text.
   */
  lines?(path: string): Promise<AsyncIterable<string> | null>;
  /** Append one line and make it durable before resolving. */
  appendLine(path: string, line: string): Promise<void>;
  /** Replace the file's content in one step, so a reader never sees a partial file. */
  write(path: string, text: string): Promise<void>;
  /** Names of the regular files directly in `dir`; empty when it does not exist. */
  list(dir: string): Promise<string[]>;
  /** Remove a file; one already gone is not an error. */
  remove(path: string): Promise<void>;
}

let tempCounter = 0;

/**
 * A text stream's lines, read only as fast as they are taken: the stream's
 * own iterator waits for each read, where `readline`'s keeps reading ahead
 * and buffers lines a slow reader has not taken yet.
 */
async function* splitLines(
  chunks: AsyncIterable<string>,
): AsyncGenerator<string> {
  let rest = "";
  for await (const chunk of chunks) {
    rest += chunk;
    for (let end = rest.indexOf("\n"); end >= 0; end = rest.indexOf("\n")) {
      yield rest.slice(0, end);
      rest = rest.slice(end + 1);
    }
  }
  if (rest) yield rest;
}

/** `BatchFiles` on the local file system, each append and write synced before it resolves. */
export const nodeBatchFiles: BatchFiles = {
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },
  async lines(path) {
    const stream = createReadStream(path, { encoding: "utf8" });
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once("open", () => resolve());
        stream.once("error", reject);
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    return splitLines(stream);
  },
  async appendLine(path, line) {
    await mkdir(dirname(path), { recursive: true });
    const handle = await open(path, "a");
    try {
      await handle.write(`${line}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
  async list(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  },
  async remove(path) {
    await rm(path, { force: true });
  },
  async write(path, text) {
    await mkdir(dirname(path), { recursive: true });
    tempCounter += 1;
    const temp = `${path}.${process.pid}.${tempCounter}.tmp`;
    const handle = await open(temp, "w");
    try {
      await handle.write(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  },
};
