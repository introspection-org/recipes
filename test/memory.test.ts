import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_INDEX_MAX_BYTES,
  DEFAULT_MEMORY_INDEX_MAX_LINES,
  MemoryContextConfigError,
  formatMemoryForPrompt,
  loadMemoryIndex,
} from "../src/memory.js";

describe("memory context", () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
  });

  function workspace(): string {
    const root = mkdtempSync(join(tmpdir(), "recipes-memory-"));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    return root;
  }

  it("loads an explicit memory index relative to the session cwd", () => {
    const cwd = workspace();
    mkdirSync(join(cwd, "memories"));
    writeFileSync(join(cwd, "memories", "MEMORY.md"), "- durable fact\n");

    const result = loadMemoryIndex({
      cwd,
      indexPath: "memories/MEMORY.md",
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.memory).toMatchObject({
      filePath: join(cwd, "memories", "MEMORY.md"),
      baseDir: join(cwd, "memories"),
      content: "- durable fact",
      maxLines: DEFAULT_MEMORY_INDEX_MAX_LINES,
      maxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES,
      truncated: false,
    });
  });

  it("treats a missing or empty memory index as absent", () => {
    const cwd = workspace();
    expect(loadMemoryIndex({ cwd, indexPath: "missing/MEMORY.md" })).toEqual({
      memory: null,
      diagnostics: [],
    });

    writeFileSync(join(cwd, "MEMORY.md"), "  \n");
    expect(loadMemoryIndex({ cwd, indexPath: "MEMORY.md" })).toEqual({
      memory: null,
      diagnostics: [],
    });
  });

  it("bounds the index by lines and bytes", () => {
    const cwd = workspace();
    writeFileSync(
      join(cwd, "MEMORY.md"),
      Array.from({ length: 250 }, (_, index) => `line ${index + 1}`).join("\n"),
    );

    const lines = loadMemoryIndex({ cwd, indexPath: "MEMORY.md" });
    expect(lines.memory?.content).toContain(
      `line ${DEFAULT_MEMORY_INDEX_MAX_LINES}`,
    );
    expect(lines.memory?.content).not.toContain(
      `line ${DEFAULT_MEMORY_INDEX_MAX_LINES + 1}`,
    );
    expect(lines.memory?.truncated).toBe(true);

    writeFileSync(
      join(cwd, "MEMORY.md"),
      "x".repeat(DEFAULT_MEMORY_INDEX_MAX_BYTES + 1),
    );
    const bytes = loadMemoryIndex({ cwd, indexPath: "MEMORY.md" });
    expect(Buffer.byteLength(bytes.memory?.content ?? "", "utf8")).toBe(
      DEFAULT_MEMORY_INDEX_MAX_BYTES,
    );
    expect(bytes.memory?.truncated).toBe(true);
  });

  it("does not truncate exactly maxLines followed by a newline", () => {
    const cwd = workspace();
    const content = Array.from(
      { length: DEFAULT_MEMORY_INDEX_MAX_LINES },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    writeFileSync(join(cwd, "MEMORY.md"), `${content}\n`);

    const result = loadMemoryIndex({ cwd, indexPath: "MEMORY.md" });

    expect(result.memory?.content).toBe(content);
    expect(result.memory?.truncated).toBe(false);
    expect(formatMemoryForPrompt(result.memory)).not.toContain("line 200...");
  });

  it("preserves a valid replacement character at the byte boundary", () => {
    const cwd = workspace();
    writeFileSync(join(cwd, "MEMORY.md"), "\uFFFDx");

    const result = loadMemoryIndex({
      cwd,
      indexPath: "MEMORY.md",
      maxBytes: 3,
    });

    expect(result.memory?.content).toBe("\uFFFD");
    expect(result.memory?.truncated).toBe(true);
  });

  it("formats safe XML", () => {
    const prompt = formatMemoryForPrompt({
      filePath: '/tmp/<memory & "notes">/MEMORY.md',
      baseDir: "/tmp/memory",
      content: "- <fact> & detail",
      maxLines: DEFAULT_MEMORY_INDEX_MAX_LINES,
      maxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES,
      truncated: true,
    });

    expect(prompt).toContain("<memories>");
    expect(prompt).toContain("<memory>");
    expect(prompt).toContain(
      "<location>/tmp/&lt;memory &amp; &quot;notes&quot;&gt;/MEMORY.md</location>",
    );
    expect(prompt).toContain("<content>");
    expect(prompt).toContain("- &lt;fact&gt; &amp; detail");
    expect(prompt).toContain(
      "The following memories contain durable context and preferences that should inform your work:",
    );
    expect(prompt).toContain("- &lt;fact&gt; &amp; detail...");
  });

  it("bounds memory content after XML escaping", () => {
    const prompt = formatMemoryForPrompt({
      filePath: "/tmp/MEMORY.md",
      baseDir: "/tmp",
      content: "&".repeat(DEFAULT_MEMORY_INDEX_MAX_BYTES),
      maxLines: DEFAULT_MEMORY_INDEX_MAX_LINES,
      maxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES,
      truncated: false,
    });
    const content = prompt.match(/<content>\n([\s\S]*?)\n {4}<\/content>/)?.[1];

    expect(content).toBeDefined();
    expect(Buffer.byteLength(content ?? "", "utf8")).toBeLessThanOrEqual(
      DEFAULT_MEMORY_INDEX_MAX_BYTES,
    );
    expect(content).toMatch(/&amp;\.\.\.$/);
  });

  it("reapplies the line bound after a memory override", () => {
    const prompt = formatMemoryForPrompt({
      filePath: "/tmp/MEMORY.md",
      baseDir: "/tmp",
      content: Array.from(
        { length: 20 },
        (_, index) => `line ${index + 1}`,
      ).join("\r"),
      maxLines: 5,
      maxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES,
      truncated: false,
    });
    const content = prompt.match(/<content>\n([\s\S]*?)\n {4}<\/content>/)?.[1];

    expect(content?.split("\n")).toHaveLength(5);
    expect(content).toContain("line 5...");
    expect(content).not.toContain("line 6");
  });

  it("returns no prompt for absent memory", () => {
    expect(formatMemoryForPrompt(null)).toBe("");
  });

  it("rejects limits outside the bounded prompt contract", () => {
    const cwd = workspace();
    expect(() =>
      loadMemoryIndex({ cwd, indexPath: "MEMORY.md", maxLines: 0 }),
    ).toThrow(MemoryContextConfigError);
    expect(() =>
      loadMemoryIndex({
        cwd,
        indexPath: "MEMORY.md",
        maxBytes: DEFAULT_MEMORY_INDEX_MAX_BYTES + 1,
      }),
    ).toThrow(MemoryContextConfigError);
  });
});
