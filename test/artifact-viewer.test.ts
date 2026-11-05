import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  SHOW_ARTIFACT_TOOL_NAME,
  artifactViewerExtension,
  markdownFilesFor,
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
  const show = (path: string) =>
    tool.execute(
      "call-1",
      { path } as never,
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
    expect(result.details).toEqual({ path: "brief.md", shown: true });
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

  it("returns the path as text outside the interactive terminal", async () => {
    for (const mode of ["print", "rpc"] as const) {
      const { show, overlays } = await setup({}, mode);
      const result = await show("brief.md");
      expect(result.content[0]!.text).toBe(
        "The file is at brief.md. The artifact panel is only available in Pi's interactive terminal, so tell the user where the file is.",
      );
      expect(result.details).toEqual({ path: "brief.md", shown: false });
      expect(overlays).toHaveLength(0);
    }
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
    await expect(show("notes.txt")).rejects.toThrow(/not a markdown file/);
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

  it("reports a bad path as a notice", async () => {
    const { subcommand, ctx, overlays, notices } = await setup();
    await subcommand("view")("notes.txt", ctx as never);
    expect(overlays).toHaveLength(0);
    expect(notices[0]).toEqual({
      message:
        "notes.txt is not a markdown file; only .md and .markdown files can be shown for now.",
      level: "warning",
    });
  });

  it("with no argument, opens the last markdown file the agent wrote or showed", async () => {
    const { subcommand, events, ctx, overlays, notices, show } = await setup({
      watchFile: fakeWatcher().watchFile,
    });
    const view = (args: string, context: unknown) =>
      subcommand("view")(args, context as never);
    await view("", ctx);
    expect(overlays).toHaveLength(0);
    expect(notices[0]!.message).toContain("Usage: /recipe view <file.md>");

    const toolResult = (toolName: string, path: string, isError = false) => {
      for (const handler of events.get("tool_result") ?? []) {
        handler({ toolName, input: { path }, isError }, ctx);
      }
    };
    toolResult("write", "evals/cases/refund.md");
    toolResult("write", "notes.txt");
    toolResult("edit", "missing.md", true);
    await view("", ctx);
    expect(overlays[0]!.component.render(60)[0]).toContain(
      "evals/cases/refund.md",
    );

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
  it("lists the subcommands, then the workspace's markdown files for view", async () => {
    const { pi } = await setup();
    const names = (prefix: string) =>
      recipeSubcommandCompletions(pi, prefix, workspace).map(
        (item) => item.label,
      );
    expect(names("")).toEqual(["view"]);
    expect(names("v")).toEqual(["view"]);
    const files = recipeSubcommandCompletions(pi, "view ", workspace);
    // The usual review folders come first; text files are never offered.
    expect(files.map((item) => item.value)).toEqual([
      "view evals/cases/refund.md",
      "view brief.md",
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
    expect(markdownFilesFor(workspace, "").map((item) => item.value)).toEqual([
      "evals/cases/refund.md",
      "brief.md",
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
