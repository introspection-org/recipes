import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  SHOW_ARTIFACT_TOOL_NAME,
  artifactViewerExtension,
  artifactFilesFor,
  recipeSubcommand,
  recipeSubcommandCompletions,
  recipeSubcommandNames,
  resolveArtifactPath,
  splitRecipeSubcommand,
  wantsArtifactViewer,
  type ArtifactViewerOptions,
} from "../src/artifact-viewer.js";
import { createRecipeExtensionRegistrationRegistry } from "../src/extensions.js";

const KEYS = {
  up: "\x1b[A",
  down: "\x1b[B",
  pageUp: "\x1b[5~",
  pageDown: "\x1b[6~",
  escape: "\x1b",
  altR: "\x1br",
};

interface Component {
  render(width: number): string[];
  handleInput?(data: string): void;
  dispose?(): void;
}

interface FakeOverlay {
  component: Component;
  options: Record<string, any>;
  focused: boolean;
  closed: boolean;
  focusCalls: number;
  unfocusCalls: number;
}

/**
 * A fake of Pi's `ctx.ui` for overlays: `custom()` builds the component,
 * hands back a handle whose focus the test can read, and, like Pi, disposes
 * the component after `done()`.
 */
function fakeCtx(cwd: string, mode: "tui" | "rpc" | "print" = "tui") {
  const overlays: FakeOverlay[] = [];
  const notices: Array<{ message: string; level?: string }> = [];
  let renders = 0;
  const ui = {
    custom<T>(
      factory: (
        tui: object,
        theme: object,
        keybindings: object,
        done: (result: T) => void,
      ) => Component,
      options: Record<string, any>,
    ): Promise<T> {
      return new Promise<T>((resolvePromise) => {
        const overlay = {
          focused: false,
          closed: false,
          focusCalls: 0,
          unfocusCalls: 0,
          options,
        } as FakeOverlay;
        overlay.component = factory(
          {
            requestRender() {
              renders += 1;
            },
            terminal: { rows: 12 },
          },
          {
            fg: (_color: string, text: string) => text,
            bold: (text: string) => text,
            italic: (text: string) => text,
            underline: (text: string) => text,
            strikethrough: (text: string) => text,
          },
          {},
          (result) => {
            overlay.closed = true;
            overlay.focused = false;
            overlay.component.dispose?.();
            resolvePromise(result);
          },
        );
        overlays.push(overlay);
        // Pi focuses a new overlay unless it is non-capturing.
        overlay.focused = !options.overlayOptions?.nonCapturing;
        options.onHandle?.({
          focus() {
            overlay.focusCalls += 1;
            overlay.focused = true;
          },
          unfocus() {
            overlay.unfocusCalls += 1;
            overlay.focused = false;
          },
          isFocused: () => overlay.focused,
          isHidden: () => false,
          setHidden() {},
          hide() {},
          getBounds: () => undefined,
        });
      });
    },
    notify(message: string, level?: string) {
      notices.push({ message, level });
    },
  };
  const ctx = {
    cwd,
    mode,
    hasUI: mode !== "print",
    ui,
  } as unknown as ExtensionContext;
  return {
    ctx,
    overlays,
    notices,
    get renders() {
      return renders;
    },
  };
}

type Handler = (...args: any[]) => any;

function fakePi() {
  const tools: ToolDefinition[] = [];
  const commands = new Map<string, { handler: Handler }>();
  const shortcuts = new Map<string, { handler: Handler }>();
  const events = new Map<string, Handler[]>();
  return {
    tools,
    commands,
    shortcuts,
    events,
    pi: {
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerCommand: (name: string, options: { handler: Handler }) =>
        commands.set(name, options),
      registerShortcut: (key: string, options: { handler: Handler }) =>
        shortcuts.set(key, options),
      on: (event: string, handler: Handler) =>
        events.set(event, [...(events.get(event) ?? []), handler]),
    },
  };
}

/** A watcher the test fires by hand, recording which files are watched. */
function fakeWatcher() {
  const active = new Map<string, () => void>();
  const stopped: string[] = [];
  const watchFile: NonNullable<ArtifactViewerOptions["watchFile"]> = (
    path,
    onChange,
  ) => {
    active.set(path, onChange);
    return () => {
      active.delete(path);
      stopped.push(path);
    };
  };
  return { active, stopped, watchFile };
}

async function setup(
  options: ArtifactViewerOptions = {},
  mode?: "tui" | "rpc" | "print",
) {
  const fake = fakePi();
  await artifactViewerExtension(
    createRecipeExtensionRegistrationRegistry(),
    options,
  )(fake.pi as never);
  const ui = fakeCtx(workspace, mode);
  const tool = fake.tools[0]!;
  const show = (path: string, extra: { ref?: string; diff?: string } = {}) =>
    tool.execute(
      "call-1",
      { path, ...extra } as never,
      undefined,
      undefined,
      ui.ctx as never,
    ) as Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: Record<string, any>;
    }>;
  const subcommand = (name: string) => recipeSubcommand(fake.pi, name)!;
  return { ...fake, ...ui, tool, show, subcommand };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

let workspace: string;

/** A terminal style escape, so a test can read the text the panel draws. */
const ANSI_STYLE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

// The panel highlights code with Pi's theme, which Pi loads before any extension runs.
beforeAll(() => initTheme("dark"));

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "artifact-viewer-"));
  mkdirSync(join(workspace, "evals", "cases"), { recursive: true });
  writeFileSync(
    join(workspace, "brief.md"),
    "# Design brief\n\nShip the **first** cut.\n",
  );
  writeFileSync(
    join(workspace, "evals", "cases", "refund.md"),
    "# Refund case\n",
  );
  writeFileSync(join(workspace, "notes.txt"), "plain text\n");
  writeFileSync(join(workspace, "photo.png"), Buffer.from([0x89, 0x50, 0, 1]));
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(workspace, { recursive: true, force: true });
});

describe("show_artifact tool", () => {
  it("opens a non-capturing overlay in the top-right corner", async () => {
    const { show, overlays, tool } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    expect(tool.name).toBe(SHOW_ARTIFACT_TOOL_NAME);
    expect(tool.description).toContain("instead of only printing its path");

    const result = await show("brief.md");

    expect(result.content[0]!.text).toContain("Showing brief.md");
    expect(result.details).toMatchObject({
      path: "brief.md",
      shown: true,
      kind: "markdown",
      content: "# Design brief\n\nShip the **first** cut.\n",
    });
    expect(overlays).toHaveLength(1);
    const { options, component, focused } = overlays[0]!;
    expect(options.overlay).toBe(true);
    expect(options.overlayOptions).toMatchObject({
      anchor: "top-right",
      width: "45%",
      margin: 1,
      nonCapturing: true,
    });
    expect(focused).toBe(true);

    const lines = component.render(60);
    expect(lines).toHaveLength(10); // 12 rows minus the top and bottom margin
    expect(lines[0]).toContain("brief.md");
    expect(lines[0]).toMatch(/1-\d+\/\d+/);
    expect(lines.join("\n")).toContain("Design brief");
    expect(lines.join("\n")).toContain("first");
    expect(lines.at(-1)).toContain("q/Esc close");
  });

  it("shows a file as unreadable once it links outside the working directory", async () => {
    const watcher = fakeWatcher();
    const { show, overlays } = await setup({
      watchFile: watcher.watchFile,
      debounceMs: 0,
    });
    await show("brief.md");
    const outside = mkdtempSync(join(tmpdir(), "artifact-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# Secret\n");
      rmSync(join(workspace, "brief.md"));
      symlinkSync(join(outside, "secret.md"), join(workspace, "brief.md"));
      watcher.active.get(join(workspace, "brief.md"))!();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const text = overlays[0]!.component.render(60).join("\n");
      expect(text).not.toContain("Secret");
      expect(text).toContain("cannot be read");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("replaces the content when another file is shown", async () => {
    const watcher = fakeWatcher();
    const { show, overlays } = await setup({ watchFile: watcher.watchFile });
    await show("brief.md");
    await show("evals/cases/refund.md");

    expect(overlays).toHaveLength(1);
    const text = overlays[0]!.component.render(60).join("\n");
    expect(text).toContain("evals/cases/refund.md");
    expect(text).toContain("Refund case");
    expect(text).not.toContain("Design brief");
    expect(watcher.stopped).toEqual([join(workspace, "brief.md")]);
    expect([...watcher.active.keys()]).toEqual([
      join(workspace, "evals", "cases", "refund.md"),
    ]);
  });

  it("carries the file in its details outside the interactive terminal", async () => {
    for (const mode of ["print", "rpc"] as const) {
      const { show, overlays } = await setup({}, mode);
      const result = await show("brief.md");
      expect(result.content[0]!.text).toContain("tell them where the file is");
      expect(result.details).toEqual({
        path: "brief.md",
        shown: false,
        kind: "markdown",
        language: expect.any(String),
        content: "# Design brief\n\nShip the **first** cut.\n",
      });
      expect(overlays).toHaveLength(0);
    }
  });

  it("names a pushed, unchanged file by its repository instead of carrying it", async () => {
    const remote = join(workspace, "remote.git");
    const app = join(workspace, "app");
    const run = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();
    const commit = (cwd: string, message: string) =>
      run(
        cwd,
        "-c",
        "user.email=t@t",
        "-c",
        "user.name=t",
        "commit",
        "-qam",
        message,
      );
    run(workspace, "init", "-q", "--bare", "-b", "main", remote);
    run(workspace, "clone", "-q", remote, app);
    writeFileSync(join(app, "notes.md"), "# Notes\n");
    run(app, "add", "notes.md");
    commit(app, "notes");
    run(app, "push", "-q", "origin", "HEAD:main");
    const head = run(app, "rev-parse", "HEAD");
    const roots: string[] = [];
    const { show } = await setup(
      {
        artifactRepository: (root) => {
          roots.push(root);
          return root.endsWith("/app") ? { id: "repo-1" } : undefined;
        },
      },
      "rpc",
    );

    const referenced = await show("app/notes.md");
    expect(referenced.details).toMatchObject({
      content: "",
      source: { repository_id: "repo-1", commit: head, path: "notes.md" },
    });

    // An edit the remote doesn't have rides along instead.
    writeFileSync(join(app, "notes.md"), "# Notes\nmore\n");
    const edited = await show("app/notes.md");
    expect(edited.details.source).toBeUndefined();
    expect(edited.details.content).toBe("# Notes\nmore\n");
    // ...but the pushed commit itself can still be named.
    expect(
      (await show("app/notes.md", { ref: "HEAD" })).details.source,
    ).toEqual({
      repository_id: "repo-1",
      commit: head,
      path: "notes.md",
    });

    // A commit not yet pushed isn't on the host either.
    commit(app, "more");
    const unpushed = await show("app/notes.md");
    expect(unpushed.details.source).toBeUndefined();
    expect(unpushed.details.content).toBe("# Notes\nmore\n");

    // A folder that isn't a repository the host serves is never named.
    writeFileSync(join(workspace, "plain.md"), "x\n");
    expect((await show("plain.md")).details.source).toBeUndefined();
  });

  it("keeps a file past 1 MB in the host's store during the call, and names it", async () => {
    const big = "x".repeat(1100 * 1024) + "\n";
    writeFileSync(join(workspace, "big.txt"), big);
    const stored: Array<{ path: string; bytes: number; mimeType: string }> = [];
    const { show } = await setup(
      {
        storeArtifact: async ({ path, content, mimeType }) => {
          stored.push({ path, bytes: content.length, mimeType });
          return { id: "file-1" };
        },
      },
      "rpc",
    );
    const result = await show("big.txt");
    expect(stored).toEqual([
      { path: "big.txt", bytes: big.length, mimeType: "text/plain" },
    ]);
    expect(result.details).toMatchObject({
      path: "big.txt",
      kind: "text",
      content: "",
      file: { id: "file-1", bytes: big.length },
    });
    expect(result.details.truncated).toBeUndefined();
    // A file under the cap rides inline, and nothing is stored.
    await show("notes.txt");
    expect(stored).toHaveLength(1);
  });

  it("without a store, refuses a file past 1 MB as before", async () => {
    writeFileSync(join(workspace, "big.txt"), "x".repeat(1100 * 1024));
    const { show } = await setup({}, "rpc");
    await expect(show("big.txt")).rejects.toThrow(
      /over the 1024 KB the viewer reads/,
    );
  });

  it("shows any text file, and HTML as its own kind", async () => {
    writeFileSync(join(workspace, "page.html"), "<h1>Hi</h1>\n");
    const { show } = await setup({}, "rpc");
    expect((await show("notes.txt")).details).toMatchObject({
      kind: "text",
      content: "plain text\n",
    });
    expect((await show("page.html")).details).toMatchObject({
      kind: "html",
      language: "html",
    });
  });

  it("diffs against the version it last showed", async () => {
    const { show } = await setup({}, "rpc");
    const first = await show("notes.txt", { diff: "previous" });
    expect(first.details.diff).toBeUndefined();
    expect(first.content[0]!.text).toContain(
      "Nothing of notes.txt was shown earlier",
    );
    writeFileSync(join(workspace, "notes.txt"), "plain text\nmore\n");
    const second = await show("notes.txt", { diff: "previous" });
    expect(second.details.content).toBe("plain text\nmore\n");
    expect(second.details.diff).toMatchObject({
      against: "the version shown before",
      text: expect.stringContaining("+2 more"),
    });
  });

  it("heads the panel with the git branch and the change against HEAD, and d switches to the diff", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "notes.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
    writeFileSync(join(workspace, "notes.txt"), "plain text\nmore\n");
    const { show, overlays } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    const result = await show("notes.txt");
    // No diff asked for: the file opens, and its diff against HEAD rides along for `d`.
    expect(result.details).toMatchObject({
      git: { branch: "main", dirty: true },
      diff: { against: "HEAD", added: 1, removed: 0 },
    });
    expect(result.details.opens).toBeUndefined();
    const panel = overlays[0]!.component;
    const plain = (lines: string[]) =>
      lines.map((line) => line.replace(ANSI_STYLE, ""));
    const header = plain(panel.render(100))[0]!;
    expect(header).toContain("notes.txt  git:(main) ✗  +1 −0 vs HEAD");
    expect(header).not.toContain("[diff]");
    panel.handleInput!("d");
    const diffed = plain(panel.render(100));
    expect(diffed[0]).toContain("[diff]");
    expect(diffed.join("\n")).toContain("+2 more");
    expect(diffed.at(-1)).toContain("d file");
  });

  it("says so when a ref is asked for outside a git repository", async () => {
    const { show } = await setup({}, "rpc");
    await expect(show("notes.txt", { ref: "HEAD" })).rejects.toThrow(
      "notes.txt isn't in a git repository, so it has no version at HEAD.",
    );
    await expect(show("notes.txt", { diff: "HEAD" })).rejects.toThrow(
      "isn't in a git repository",
    );
  });

  it("shows a file as of a git commit, or diffs against one", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q");
    git("-c", "user.email=t@t", "-c", "user.name=t", "add", "notes.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
    writeFileSync(join(workspace, "notes.txt"), "changed\n");
    const { show } = await setup({}, "rpc");
    expect((await show("notes.txt", { ref: "HEAD" })).details).toMatchObject({
      ref: "HEAD",
      content: "plain text\n",
    });
    const diffed = await show("notes.txt", { diff: "HEAD" });
    expect(diffed.details.content).toBe("changed\n");
    expect(diffed.details.diff).toMatchObject({
      against: "HEAD",
      text: expect.stringContaining("-1 plain text"),
    });
    // A file added since the base diffs as all added, as git diff shows it.
    writeFileSync(join(workspace, "fresh.txt"), "new\n");
    expect(
      (await show("fresh.txt", { diff: "HEAD" })).details.diff,
    ).toMatchObject({ against: "HEAD", added: 1, removed: 0 });
    await expect(show("fresh.txt", { diff: "nope" })).rejects.toThrow(
      /has no version at nope/,
    );
    // A deleted file diffs as all removed against a base that has it.
    git("add", "fresh.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "fresh");
    rmSync(join(workspace, "fresh.txt"));
    const removed = await show("fresh.txt", { diff: "HEAD" });
    expect(removed.details.content).toBe("");
    expect(removed.details.diff).toMatchObject({ added: 0, removed: 1 });
    await expect(show("fresh.txt", { diff: "HEAD~1" })).rejects.toThrow(
      "fresh.txt does not exist, and isn't in HEAD~1 either.",
    );
    await expect(show("fresh.txt")).rejects.toThrow(/does not exist/);
    // A ref reads git's version, whatever the working tree now holds there.
    rmSync(join(workspace, "notes.txt"));
    expect((await show("notes.txt", { ref: "HEAD" })).details).toMatchObject({
      content: "plain text\n",
    });
    writeFileSync(join(workspace, "notes.txt"), Buffer.from([0x89, 0, 1]));
    expect((await show("notes.txt", { ref: "HEAD" })).details).toMatchObject({
      content: "plain text\n",
    });
    writeFileSync(join(workspace, "blob.txt"), Buffer.from([0x89, 0, 1]));
    git("add", "blob.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "blob");
    await expect(show("blob.txt", { ref: "HEAD" })).rejects.toThrow(
      "blob.txt at HEAD is not a text file, so it can't be shown.",
    );
    await expect(show("notes.txt", { ref: "--output=x" })).rejects.toThrow(
      /is not a git ref/,
    );
    await expect(show("notes.txt", { ref: "nope" })).rejects.toThrow(
      /has no version at nope/,
    );
  });
});

describe("path validation", () => {
  it("accepts markdown files inside the working directory", () => {
    expect(resolveArtifactPath(workspace, "./evals/cases/refund.md")).toEqual({
      absolutePath: join(workspace, "evals", "cases", "refund.md"),
      relativePath: "evals/cases/refund.md",
    });
    expect(
      resolveArtifactPath(workspace, join(workspace, "brief.md")).relativePath,
    ).toBe("brief.md");
  });

  it("refuses paths outside the working directory", () => {
    expect(() => resolveArtifactPath(workspace, "../elsewhere.md")).toThrow(
      /outside the working directory/,
    );
    expect(() => resolveArtifactPath(workspace, "/etc/hosts.md")).toThrow(
      /outside the working directory/,
    );
  });

  it("refuses a symlink that points outside the working directory", () => {
    const outside = mkdtempSync(join(tmpdir(), "artifact-outside-"));
    try {
      writeFileSync(join(outside, "secret.md"), "# not yours\n");
      symlinkSync(join(outside, "secret.md"), join(workspace, "link.md"));
      expect(() => resolveArtifactPath(workspace, "link.md")).toThrow(
        /links outside the working directory/,
      );
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("refuses missing and non-markdown files", () => {
    expect(() => resolveArtifactPath(workspace, "missing.md")).toThrow(
      "missing.md does not exist. Write the file first, then show it.",
    );
    expect(() => resolveArtifactPath(workspace, "notes.txt")).toThrow(
      "notes.txt is not a markdown file; only .md and .markdown files can be shown for now.",
    );
    mkdirSync(join(workspace, "folder.md"));
    expect(() => resolveArtifactPath(workspace, "folder.md")).toThrow(
      "folder.md is not a file.",
    );
    expect(() => resolveArtifactPath(workspace, "  ")).toThrow(
      "Give the path of a markdown file to show.",
    );
  });

  it("fails the tool call without opening a panel", async () => {
    const { show, overlays } = await setup();
    await expect(show("../elsewhere.md")).rejects.toThrow(
      /outside the working directory/,
    );
    await expect(show("photo.png")).rejects.toThrow(/not a text file/);
    expect(overlays).toHaveLength(0);
  });
});

describe("artifact panel", () => {
  it("scrolls with the arrow and page keys", async () => {
    writeFileSync(
      join(workspace, "long.md"),
      Array.from({ length: 40 }, (_, index) => `Line ${index + 1}\n`).join(
        "\n",
      ),
    );
    const { show, overlays } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    await show("long.md");
    const panel = overlays[0]!.component;
    const body = () => panel.render(60).slice(1, -1).join("\n");

    expect(panel.render(60)[0]).toContain("1-8/");
    expect(body()).toContain("Line 1");
    panel.handleInput!(KEYS.down);
    panel.handleInput!(KEYS.down);
    expect(panel.render(60)[0]).toContain("3-10/");
    panel.handleInput!(KEYS.up);
    expect(panel.render(60)[0]).toContain("2-9/");
    panel.handleInput!(KEYS.pageDown);
    expect(panel.render(60)[0]).toContain("9-16/");
    panel.handleInput!(KEYS.pageUp);
    panel.handleInput!(KEYS.pageUp);
    expect(panel.render(60)[0]).toContain("1-8/");
    for (let index = 0; index < 50; index += 1)
      panel.handleInput!(KEYS.pageDown);
    const [, , last, total] = /(\d+)-(\d+)\/(\d+)/.exec(panel.render(60)[0]!)!;
    expect(last).toBe(total);
    expect(body()).toContain("Line 40");
  });

  it("opens the file with the system opener on o", async () => {
    const opened: string[] = [];
    const { show, overlays } = await setup({
      watchFile: fakeWatcher().watchFile,
      openExternal: (path) => {
        opened.push(path);
      },
    });
    await show("brief.md");
    overlays[0]!.component.handleInput!("o");
    await flush();
    expect(opened).toEqual([join(workspace, "brief.md")]);
  });

  it("reports an opener failure instead of throwing", async () => {
    const { show, overlays, notices } = await setup({
      watchFile: fakeWatcher().watchFile,
      openExternal: async () => {
        throw new Error("no opener");
      },
    });
    await show("brief.md");
    overlays[0]!.component.handleInput!("o");
    await flush();
    expect(notices).toEqual([
      { message: "Could not open brief.md: no opener", level: "error" },
    ]);
  });

  it("closes on q and Esc and stops watching", async () => {
    const watcher = fakeWatcher();
    const { show, overlays } = await setup({ watchFile: watcher.watchFile });

    await show("brief.md");
    overlays[0]!.component.handleInput!("q");
    expect(overlays[0]!.closed).toBe(true);
    expect(watcher.active.size).toBe(0);

    await show("brief.md");
    expect(overlays).toHaveLength(2);
    overlays[1]!.component.handleInput!(KEYS.escape);
    expect(overlays[1]!.closed).toBe(true);
    expect(watcher.stopped).toHaveLength(2);
  });

  it("re-renders when the file changes on disk, keeping the scroll position", async () => {
    vi.useFakeTimers();
    const watcher = fakeWatcher();
    const path = join(workspace, "long.md");
    const lines = Array.from(
      { length: 30 },
      (_, index) => `Line ${index + 1}\n`,
    );
    writeFileSync(path, lines.join("\n"));
    const { show, overlays } = await setup({
      watchFile: watcher.watchFile,
      debounceMs: 50,
    });
    await show("long.md");
    const panel = overlays[0]!.component;
    panel.render(60);
    panel.handleInput!(KEYS.down);

    writeFileSync(path, ["Line 1 (revised)\n", ...lines.slice(1)].join("\n"));
    const changed = watcher.active.get(path)!;
    changed();
    changed();
    expect(panel.render(60).join("\n")).not.toContain("revised");
    vi.advanceTimersByTime(50);
    panel.handleInput!(KEYS.up);
    const text = panel.render(60).join("\n");
    expect(text).toContain("Line 1 (revised)");

    rmSync(path);
    changed();
    vi.advanceTimersByTime(50);
    expect(panel.render(60).join("\n")).toContain("This file was removed");
  });
});

describe("/recipe view and /recipe close", () => {
  it("opens the given file", async () => {
    const { subcommand, ctx, overlays } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    await subcommand("view")(" @evals/cases/refund.md ", ctx as never);
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.focused).toBe(true);
    expect(overlays[0]!.component.render(60)[0]).toContain(
      "evals/cases/refund.md",
    );
  });

  it("takes --diff and --ref, and reports a ref with no such version", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q");
    git("add", "notes.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
    writeFileSync(join(workspace, "notes.txt"), "changed\n");
    const { subcommand, ctx, overlays, notices } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    await subcommand("view")("notes.txt --diff HEAD", ctx as never);
    expect(overlays).toHaveLength(1);
    await subcommand("view")("notes.txt --ref=nope", ctx as never);
    expect(notices.at(-1)).toEqual({
      message:
        "notes.txt has no version at nope in the working directory's git repository.",
      level: "warning",
    });
  });

  it("opens a bare --diff on the diff against HEAD, the file before or after it", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: workspace, stdio: "pipe" });
    git("init", "-q", "-b", "main");
    git("add", "notes.txt");
    git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "first");
    writeFileSync(join(workspace, "notes.txt"), "changed\n");
    const { subcommand, ctx, overlays, notices } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    const header = () =>
      overlays.at(-1)!.component.render(100)[0]!.replace(ANSI_STYLE, "");
    for (const args of ["notes.txt --diff", "--diff notes.txt"]) {
      await subcommand("view")(args, ctx as never);
      expect(header()).toContain(
        "notes.txt  git:(main) ✗  +1 −1 vs HEAD  [diff]",
      );
    }
    // With no file named, a ref after --diff diffs the last file shown, never opens a file called HEAD.
    for (const args of ["--diff HEAD", "--diff=HEAD"]) {
      const before = notices.length;
      await subcommand("view")(args, ctx as never);
      expect(notices.length).toBe(before);
      expect(header()).toContain(
        "notes.txt  git:(main) ✗  +1 −1 vs HEAD  [diff]",
      );
    }
    // An untracked file seen for the first time has nothing to diff against.
    writeFileSync(join(workspace, "fresh.txt"), "new\n");
    await subcommand("view")("fresh.txt --diff", ctx as never);
    expect(notices.at(-1)!.message).toContain("nothing to diff against");
  });

  it("reports a bad path as a notice", async () => {
    const { subcommand, ctx, overlays, notices } = await setup();
    await subcommand("view")("photo.png", ctx as never);
    expect(overlays).toHaveLength(0);
    expect(notices[0]).toEqual({
      message: "photo.png is not a text file, so it can't be shown.",
      level: "warning",
    });
  });

  it("with no argument, opens the last file the agent wrote or showed", async () => {
    const { subcommand, events, ctx, overlays, notices, show } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    const view = (args: string, context: unknown) =>
      subcommand("view")(args, context as never);
    await view("", ctx);
    expect(overlays).toHaveLength(0);
    expect(notices[0]!.message).toContain("Usage: /recipe view <file>");

    const toolResult = (toolName: string, path: string, isError = false) => {
      for (const handler of events.get("tool_result") ?? []) {
        handler({ toolName, input: { path }, isError }, ctx);
      }
    };
    toolResult("write", "evals/cases/refund.md");
    toolResult("write", "notes.txt");
    toolResult("write", "photo.png");
    toolResult("edit", "missing.md", true);
    // A binary file and a failed edit leave the last text file in place.
    await view("", ctx);
    expect(overlays[0]!.component.render(60)[0]).toContain("notes.txt");

    overlays[0]!.component.handleInput!("q");
    await show("brief.md");
    overlays[1]!.component.handleInput!("q");
    await view("", ctx);
    expect(overlays[2]!.component.render(60)[0]).toContain("brief.md");
  });

  it("needs the interactive terminal", async () => {
    const { subcommand, ctx, overlays, notices } = await setup({}, "rpc");
    await subcommand("view")("brief.md", ctx as never);
    expect(overlays).toHaveLength(0);
    expect(notices[0]!.message).toBe(
      "/recipe view needs Pi's interactive terminal.",
    );
  });
});

describe("/recipe completions", () => {
  it("lists the subcommands, then the workspace's text files for view", async () => {
    const { pi } = await setup();
    const names = (prefix: string) =>
      recipeSubcommandCompletions(pi, prefix, workspace).map(
        (item) => item.label,
      );
    expect(names("")).toEqual(["view"]);
    expect(names("v")).toEqual(["view"]);
    const files = recipeSubcommandCompletions(pi, "view ", workspace);
    // The usual review folders first, then markdown, then other text; binary files are never offered.
    expect(files.map((item) => item.value)).toEqual([
      "view evals/cases/refund.md",
      "view brief.md",
      "view notes.txt",
    ]);
    expect(
      recipeSubcommandCompletions(pi, "view REF", workspace).map(
        (item) => item.label,
      ),
    ).toEqual(["evals/cases/refund.md"]);
    expect(recipeSubcommandCompletions(pi, "close x", workspace)).toEqual([]);
  });

  it("skips hidden folders and build output", () => {
    mkdirSync(join(workspace, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(workspace, "node_modules", "pkg", "README.md"), "x");
    mkdirSync(join(workspace, ".pi"), { recursive: true });
    writeFileSync(join(workspace, ".pi", "notes.md"), "x");
    // Review folders first, then markdown, then other text; binary files are left out.
    expect(artifactFilesFor(workspace, "").map((item) => item.value)).toEqual([
      "evals/cases/refund.md",
      "brief.md",
      "notes.txt",
    ]);
  });
});

describe("registration", () => {
  it("registers the tool and /recipe view, no shortcut and no top-level command", async () => {
    const { tools, commands, shortcuts, events, pi } = await setup();
    expect(tools.map((tool) => tool.name)).toEqual(["show_artifact"]);
    expect([...commands.keys()]).toEqual([]);
    expect(recipeSubcommandNames(pi)).toEqual(["view"]);
    expect([...shortcuts.keys()]).toEqual([]);
    expect([...events.keys()].sort()).toEqual([
      "session_shutdown",
      "tool_result",
    ]);
  });

  it("closes the panel when the session shuts down", async () => {
    const watcher = fakeWatcher();
    const { show, overlays, events } = await setup({
      watchFile: watcher.watchFile,
    });
    await show("brief.md");
    for (const handler of events.get("session_shutdown") ?? []) handler({});
    expect(overlays[0]!.closed).toBe(true);
    expect(watcher.active.size).toBe(0);
  });

  it("keeps a Recipe extension's own show_artifact", async () => {
    const { pi, tools, commands } = fakePi();
    const registrations = createRecipeExtensionRegistrationRegistry();
    registrations.claim("tool", "show_artifact", "extensions/show.js");
    await artifactViewerExtension(registrations)(pi as never);
    expect(tools).toHaveLength(0);
    expect(commands.size).toBe(0);
  });

  it("is opted into by listing show_artifact in tools", () => {
    expect(wantsArtifactViewer(["read", "show_artifact"])).toBe(true);
    expect(wantsArtifactViewer(["read", "ask_user_question"])).toBe(false);
  });
});

describe("default file watcher", () => {
  it("sees a file replaced on disk", async () => {
    const { watchFileWithFs } = await import("../src/artifact-viewer.js");
    const path = join(workspace, "brief.md");
    let changes = 0;
    const stop = watchFileWithFs(path, () => {
      changes += 1;
    });
    try {
      // Editors often save by writing a new file and renaming it over the old one.
      writeFileSync(join(workspace, "brief.md.tmp"), "# Revised\n");
      const { renameSync } = await import("node:fs");
      renameSync(join(workspace, "brief.md.tmp"), path);
      for (let waited = 0; changes === 0 && waited < 2000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(changes).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });

  it("sees an edit to the file a symlink points to, in another folder", async () => {
    const { watchFileWithFs } = await import("../src/artifact-viewer.js");
    mkdirSync(join(workspace, "reports"));
    symlinkSync(
      join("..", "brief.md"),
      join(workspace, "reports", "latest.md"),
    );
    let changes = 0;
    const stop = watchFileWithFs(
      join(workspace, "reports", "latest.md"),
      () => {
        changes += 1;
      },
    );
    try {
      writeFileSync(
        join(workspace, "brief.md"),
        "# Revised through the target\n",
      );
      for (let waited = 0; changes === 0 && waited < 2000; waited += 20) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(changes).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});

describe("splitRecipeSubcommand", () => {
  it("keeps the argument's own whitespace", () => {
    expect(splitRecipeSubcommand('view "a  b.md"')).toEqual({
      name: "view",
      args: '"a  b.md"',
    });
    expect(splitRecipeSubcommand("view   notes/a  b.md")).toEqual({
      name: "view",
      args: "notes/a  b.md",
    });
  });

  it("gives a bare subcommand no arguments", () => {
    expect(splitRecipeSubcommand("close")).toEqual({ name: "close", args: "" });
    expect(splitRecipeSubcommand("")).toEqual({ name: "", args: "" });
  });
});
