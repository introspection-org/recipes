import { describe, expect, it } from "vitest";
import type {
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  ASK_USER_QUESTION_TOOL_NAME,
  ASK_USER_TYPED_ANSWER_OPTION,
  ASK_USER_TYPE_SOMETHING,
  DISMISSED_TEXT,
  askUserQuestionExtension,
  createAskUserQuestionTool,
  stripOptionNumbering,
} from "../src/ask-user-question.js";
import { createRecipeExtensionRegistrationRegistry } from "../src/extensions.js";
import { withoutLastCharacter } from "../src/interaction-tui.js";
import {
  autoResolveInteractions,
  formatInteractionResume,
} from "../src/interactions.js";

interface UiCall {
  kind: "select" | "input" | "custom";
  title: string;
  options?: string[];
}

function fakeCtx(opts: {
  hasUI: boolean;
  mode?: "tui" | "rpc" | "print";
  selectResults?: Array<string | undefined>;
  inputResults?: Array<string | undefined>;
  customInputs?: string[];
}): { ctx: ExtensionContext; calls: UiCall[]; aborts: () => number } {
  const calls: UiCall[] = [];
  let aborts = 0;
  const selectResults = [...(opts.selectResults ?? [])];
  const inputResults = [...(opts.inputResults ?? [])];
  const ctx = {
    hasUI: opts.hasUI,
    mode: opts.mode ?? "tui",
    abort() {
      aborts += 1;
    },
    ui: {
      async select(title: string, options: string[]) {
        calls.push({ kind: "select", title, options });
        const next = selectResults.shift();
        // Tests name a choice by its number prefix ("2.") or "Done".
        return next === undefined
          ? undefined
          : options.find(
              (option) =>
                option === next ||
                option.startsWith(next) ||
                option.includes(`] ${next}`),
            );
      },
      async input(title: string) {
        calls.push({ kind: "input", title });
        return inputResults.shift();
      },
      ...(opts.customInputs
        ? {
            async custom<T>(
              factory: (
                tui: { requestRender(): void },
                theme: {
                  fg(color: string, text: string): string;
                  bold(text: string): string;
                },
                keybindings: object,
                done: (result: T) => void,
              ) => {
                render(width: number): string[];
                handleInput?(data: string): void;
                dispose?(): void;
              },
            ) {
              let result: T | undefined;
              const component = factory(
                { requestRender() {} },
                { fg: (_color, text) => text, bold: (text) => text },
                {},
                (value) => {
                  result = value;
                },
              );
              calls.push({
                kind: "custom",
                title: "",
                options: component.render(120),
              });
              for (const input of opts.customInputs ?? []) {
                component.handleInput?.(input);
              }
              component.dispose?.();
              return result;
            },
          }
        : {}),
      notify() {},
    },
  } as unknown as ExtensionContext;
  return { ctx, calls, aborts: () => aborts };
}

function run(
  tool: ToolDefinition,
  params: unknown,
  ctx: ExtensionContext,
  toolCallId = "call-1",
) {
  return tool.execute(
    toolCallId,
    params as never,
    undefined,
    undefined,
    ctx as never,
  ) as Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: Record<string, any>;
  }>;
}

const authQuestion = {
  question: "Which sign-in method should the app use?",
  header: "Auth",
  options: [
    { label: "1. Passkeys", description: "No passwords; newest browsers only" },
    { label: "2) Email link", description: "Works everywhere; slower sign-in" },
    { label: "Password" },
  ],
};

const featuresQuestion = {
  question: "Which features should ship in the first release?",
  header: "Features",
  options: [{ label: "Search" }, { label: "Export" }, { label: "Sharing" }],
  multiSelect: true,
};

const terminalEnv = {};
const pauseEnv = { PI_INTERRUPT_RESUME: "1" };

/**
 * A pause/resume host's view of a paused Recipe tool result, reduced to what
 * a chat panel renders: the host copies `options`, `message` and `selection`
 * into the interrupt metadata, keys the interrupt by kind and tool call, and
 * shows `metadata.header` as the title, `metadata.question` as the prompt and
 * `metadata.options` (with descriptions) as option buttons.
 */
function hostPanelView(toolCallId: string, details: Record<string, any>) {
  const request = details.interrupt;
  if (request?.outcome?.type !== "awaiting_user") return null;
  const metadata = {
    ...(request.metadata ?? {}),
    question: request.message,
    ...(request.selection ? { selection: request.selection } : {}),
    options: request.metadata?.options ?? request.options,
    toolName: ASK_USER_QUESTION_TOOL_NAME,
  };
  const kind = metadata.kind ?? request.reason;
  const confirmation =
    request.reason === "confirmation" || request.reason === "tool_call";
  return {
    id: `${kind}:${toolCallId}`,
    interaction: confirmation ? "confirmation" : "question",
    title: metadata.header ?? metadata.title ?? "Question",
    prompt: metadata.question,
    options: (metadata.options ?? []).map(
      (option: { label: string; value?: string; description?: string }) => ({
        label: option.label,
        value: option.value ?? option.label,
        description: option.description ?? null,
      }),
    ),
  };
}

describe("ask_user_question tool", () => {
  it("is sequential and carries the usage guidance", () => {
    const tool = createAskUserQuestionTool({ env: terminalEnv });
    expect(tool.name).toBe("ask_user_question");
    expect(tool.executionMode).toBe("sequential");
    for (const guidance of [
      "One decision per question",
      "about 30 seconds",
      "bare option label still makes sense",
      "Don't list the options inside the question",
      'don\'t add a "change it" option',
      "Prefer this over asking in plain text",
    ]) {
      expect(tool.description).toContain(guidance);
    }
    const questions = (tool.parameters as any).properties.questions;
    expect(questions.minItems).toBe(1);
    expect(questions.maxItems).toBe(4);
    expect(questions.items.properties.options.minItems).toBe(2);
    expect(questions.items.properties.options.maxItems).toBe(4);
    expect(questions.items.required).toEqual(["question", "header", "options"]);
  });

  it("strips numbering the model put in labels", () => {
    expect(stripOptionNumbering("1. Yes")).toBe("Yes");
    expect(stripOptionNumbering("2) No")).toBe("No");
    expect(stripOptionNumbering("(3) Maybe")).toBe("Maybe");
    expect(stripOptionNumbering("b. Slow")).toBe("Slow");
    expect(stripOptionNumbering("1.5x speed")).toBe("1.5x speed");
    expect(stripOptionNumbering("Apples")).toBe("Apples");
  });

  describe("terminal", () => {
    it("numbers options, strips model numbers and adds the typed-answer option", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = fakeCtx({ hasUI: true, selectResults: ["2."] });

      const result = await run(tool, { questions: [authQuestion] }, ctx);

      expect(calls).toEqual([
        {
          kind: "select",
          title: "Which sign-in method should the app use?",
          options: [
            "1. Passkeys — No passwords; newest browsers only",
            "2. Email link — Works everywhere; slower sign-in",
            "3. Password",
            `4. ${ASK_USER_TYPED_ANSWER_OPTION}`,
          ],
        },
      ]);
      expect(result.content[0]!.text).toBe("Auth: Email link");
      expect(result.details).toEqual({
        questions: [
          {
            question: "Which sign-in method should the app use?",
            header: "Auth",
            multiSelect: false,
            outcome: "answered",
            answers: ["Email link"],
          },
        ],
        answers: { "Which sign-in method should the app use?": "Email link" },
      });
    });

    it("opens a text input for the typed answer", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = fakeCtx({
        hasUI: true,
        selectResults: ["4."],
        inputResults: ["  SSO through Okta  "],
      });

      const result = await run(tool, { questions: [authQuestion] }, ctx);

      expect(calls.map((call) => call.kind)).toEqual(["select", "input"]);
      expect(result.content[0]!.text).toBe("Auth: SSO through Okta");
    });

    it("declines when the dialog is dismissed or the typed answer is empty", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx } = fakeCtx({
        hasUI: true,
        selectResults: [undefined],
      });

      const result = await run(tool, { questions: [authQuestion] }, ctx);

      expect(result.content[0]!.text).toBe(
        "Auth: (no answer)\n\nUser declined to answer. Proceed with your best judgment.",
      );
      expect(result.details.questions[0].outcome).toBe("declined");
      expect(result.details.answers).toEqual({});
    });

    it("asks several questions in order and summarises each", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = fakeCtx({
        hasUI: true,
        mode: "rpc",
        selectResults: ["1.", "1.", "3.", "Done"],
      });

      const result = await run(
        tool,
        { questions: [authQuestion, featuresQuestion] },
        ctx,
      );

      expect(calls[1]!.options).toEqual([
        "[ ] 1. Search",
        "[ ] 2. Export",
        "[ ] 3. Sharing",
        `4. ${ASK_USER_TYPED_ANSWER_OPTION}`,
        "Done",
      ]);
      expect(calls[3]!.options!.slice(0, 3)).toEqual([
        "[x] 1. Search",
        "[ ] 2. Export",
        "[x] 3. Sharing",
      ]);
      expect(result.content[0]!.text).toBe(
        "Auth: Passkeys\nFeatures: Search, Sharing",
      );
      expect(result.details.questions[1]).toMatchObject({
        multiSelect: true,
        answers: ["Search", "Sharing"],
      });
      expect(result.details.answers).toEqual({
        "Which sign-in method should the app use?": "Passkeys",
        "Which features should ship in the first release?": "Search, Sharing",
      });
    });

    it("uses the TUI toggle list for multiSelect with the typed-answer option", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = fakeCtx({
        hasUI: true,
        mode: "tui",
        // Toggle 2, move to the typed-answer row, Enter.
        customInputs: ["2", "\x1b[B", "\x1b[B", "\x1b[B", "\r"],
        inputResults: ["Audit log"],
      });

      const result = await run(tool, { questions: [featuresQuestion] }, ctx);

      expect(calls[0]!.kind).toBe("custom");
      expect(calls[0]!.options!.join("\n")).toContain(
        `4. ${ASK_USER_TYPE_SOMETHING}`,
      );
      expect(calls[1]!.kind).toBe("input");
      expect(result.content[0]!.text).toBe("Features: Export, Audit log");
    });
  });

  describe("terminal list: type to answer", () => {
    const tui = (customInputs: string[], inputResults: string[] = []) =>
      fakeCtx({ hasUI: true, mode: "tui", customInputs, inputResults });

    it("takes typed text as the answer without opening a separate input", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = tui([..."Magic link", "\r"]);
      const result = await run(tool, { questions: [authQuestion] }, ctx);
      expect(calls.map((call) => call.kind)).toEqual(["custom"]);
      const shown = calls[0]!.options!.join("\n");
      expect(shown).toContain(`4. ${ASK_USER_TYPE_SOMETHING}`);
      // Titles only: option descriptions aren't repeated under each choice.
      expect(shown).not.toContain("No passwords; newest browsers only");
      expect(result.content[0]!.text).toBe("Auth: Magic link");
    });

    it("picks an option by its digit or with Enter, and digits are text once typing starts", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const byDigit = await run(
        tool,
        { questions: [authQuestion] },
        tui(["2"]).ctx,
      );
      expect(byDigit.content[0]!.text).toBe("Auth: Email link");
      const byEnter = await run(
        tool,
        { questions: [authQuestion] },
        tui(["\x1b[B", "\x1b[B", "\r"]).ctx,
      );
      expect(byEnter.content[0]!.text).toBe("Auth: Password");
      const typed = await run(
        tool,
        { questions: [authQuestion] },
        tui([..."v2 SSO", "\r"]).ctx,
      );
      expect(typed.content[0]!.text).toBe("Auth: v2 SSO");
    });

    it("backspace edits, and Esc clears the typed text before it dismisses", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const edited = await run(
        tool,
        { questions: [authQuestion] },
        tui([..."SSOx", "\x7f", "\r"]).ctx,
      );
      expect(edited.content[0]!.text).toBe("Auth: SSO");
      const cleared = await run(
        tool,
        { questions: [authQuestion] },
        tui([..."SSO", "\x1b", "1"]).ctx,
      );
      expect(cleared.content[0]!.text).toBe("Auth: Passkeys");
    });

    it("takes a bracketed paste, also split across events, as typed text", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const whole = await run(
        tool,
        { questions: [authQuestion] },
        tui(["\x1b[200~Magic link\x1b[201~", "\r"]).ctx,
      );
      expect(whole.content[0]!.text).toBe("Auth: Magic link");
      const split = await run(
        tool,
        { questions: [authQuestion] },
        tui(["\x1b[200~Magic", "\nlink 2", "\x1b[201~", "\r"]).ctx,
      );
      expect(split.content[0]!.text).toBe("Auth: Magic link 2");
      // Tabs become spaces and other control characters are dropped, never the whole paste.
      const tabbed = await run(
        tool,
        { questions: [authQuestion] },
        tui(["\x1b[200~Magic\tlink\x07\x1b[201~", "\r"]).ctx,
      );
      expect(tabbed.content[0]!.text).toBe("Auth: Magic link");
    });

    it("backspace removes a whole character, emoji included", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const result = await run(
        tool,
        { questions: [authQuestion] },
        tui([..."SSO", "😀", "\x7f", "\r"]).ctx,
      );
      expect(result.content[0]!.text).toBe("Auth: SSO");
      expect(withoutLastCharacter("ok👍🏽")).toBe("ok");
      expect(withoutLastCharacter("x😀")).toBe("x");
    });

    it("stops the turn when the user presses Esc, so the agent waits for their message", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, aborts } = tui(["\x1b"]);
      const result = await run(
        tool,
        { questions: [authQuestion, featuresQuestion] },
        ctx,
      );
      expect(aborts()).toBe(1);
      expect(result.content[0]!.text).toBe(DISMISSED_TEXT);
    });

    it("adds typed text to the toggled options in a multi-select list", async () => {
      const tool = createAskUserQuestionTool({ env: terminalEnv });
      const { ctx, calls } = tui(["2", ..."Audit log", "\r"]);
      const result = await run(tool, { questions: [featuresQuestion] }, ctx);
      expect(calls.map((call) => call.kind)).toEqual(["custom"]);
      expect(result.content[0]!.text).toBe("Features: Export, Audit log");
    });
  });

  describe("pause/resume host", () => {
    it("emits one interrupt the platform panel renders as a question", async () => {
      const tool = createAskUserQuestionTool({ env: pauseEnv });
      const { ctx } = fakeCtx({ hasUI: false });

      const result = await run(
        tool,
        { questions: [authQuestion] },
        ctx,
        "call-7",
      );

      expect(result.content).toEqual([
        { type: "text", text: "Awaiting user response." },
      ]);
      expect(result.details.interrupt).toEqual({
        reason: "input_required",
        message: "Which sign-in method should the app use?",
        // Bare labels: the panel lists them itself and always offers free text.
        options: [
          {
            label: "Passkeys",
            description: "No passwords; newest browsers only",
          },
          {
            label: "Email link",
            description: "Works everywhere; slower sign-in",
          },
          { label: "Password" },
        ],
        selection: "single",
        metadata: {
          kind: "ask_user_question",
          header: "Auth",
          question: "Which sign-in method should the app use?",
        },
        outcome: { type: "awaiting_user" },
      });
      expect(hostPanelView("call-7", result.details)).toEqual({
        id: "ask_user_question:call-7",
        interaction: "question",
        title: "Auth",
        prompt: "Which sign-in method should the app use?",
        options: [
          {
            label: "Passkeys",
            value: "Passkeys",
            description: "No passwords; newest browsers only",
          },
          {
            label: "Email link",
            value: "Email link",
            description: "Works everywhere; slower sign-in",
          },
          { label: "Password", value: "Password", description: null },
        ],
      });
      // The panel resumes with `{ answer }`, typed or picked.
      expect(
        formatInteractionResume({
          status: "resolved",
          payload: { answer: "Email link" },
        }),
      ).toBe("Answer: Email link");
    });

    it("marks multiSelect questions as multiple selection", async () => {
      const tool = createAskUserQuestionTool({ env: pauseEnv });
      const { ctx } = fakeCtx({ hasUI: false });

      const result = await run(tool, { questions: [featuresQuestion] }, ctx);

      expect(result.details.interrupt).toMatchObject({
        selection: "multiple",
        options: [
          { label: "Search" },
          { label: "Export" },
          { label: "Sharing" },
        ],
        metadata: { header: "Features" },
      });
    });

    it("asks for one call per question so one pause carries several interrupts", async () => {
      const tool = createAskUserQuestionTool({ env: pauseEnv });
      const questions = (tool.parameters as any).properties.questions;
      expect(questions.maxItems).toBe(1);
      expect(tool.description).toContain(
        "make one call per question in the same turn",
      );

      const { ctx } = fakeCtx({ hasUI: false });
      // Two calls in one turn: the host collects both interrupts into one
      // pause and the panel steps through them (1 of 2, 2 of 2).
      const first = await run(
        tool,
        { questions: [authQuestion] },
        ctx,
        "call-1",
      );
      const second = await run(
        tool,
        { questions: [featuresQuestion] },
        ctx,
        "call-2",
      );
      expect(
        [first, second].map((result, index) =>
          hostPanelView(`call-${index + 1}`, result.details),
        ),
      ).toMatchObject([
        { id: "ask_user_question:call-1", title: "Auth" },
        { id: "ask_user_question:call-2", title: "Features" },
      ]);

      // A call that still carries several questions shows nothing and says why.
      const several = await run(
        tool,
        { questions: [authQuestion, featuresQuestion] },
        ctx,
      );
      expect(several.details.interrupt).toBeUndefined();
      expect(several.content[0]!.text).toContain(
        "Nothing was shown to the user",
      );
      expect(several.content[0]!.text).toContain(
        "call it 2 times in the same turn",
      );
    });

    it("prefers a local dialog when the host also has a UI", async () => {
      const tool = createAskUserQuestionTool({ env: pauseEnv });
      const { ctx } = fakeCtx({ hasUI: true, selectResults: ["3."] });

      const result = await run(tool, { questions: [authQuestion] }, ctx);

      expect(result.content[0]!.text).toBe("Auth: Password");
    });
  });

  describe("headless", () => {
    it("declines every question under PI_ASK_USER_AUTO_APPROVE", async () => {
      const tool = createAskUserQuestionTool({
        env: { PI_ASK_USER_AUTO_APPROVE: "1" },
      });
      const { ctx, calls } = fakeCtx({ hasUI: true });

      const result = await run(
        tool,
        { questions: [authQuestion, featuresQuestion] },
        ctx,
      );

      expect(calls).toHaveLength(0);
      expect(result.content[0]!.text).toBe(
        "Auth: (no answer)\nFeatures: (no answer)\n\n" +
          "The user did not answer every question. Proceed with your best judgment for those.",
      );
    });

    it("tells the model to ask in chat when nothing can be shown", async () => {
      const tool = createAskUserQuestionTool({ env: {} });
      const { ctx } = fakeCtx({ hasUI: false, mode: "print" });

      const result = await run(
        tool,
        { questions: [authQuestion, featuresQuestion] },
        ctx,
      );

      expect(result.content[0]!.text).toContain(
        "User interaction is unavailable in this session; nothing was shown to the user.",
      );
      expect(result.details.interrupt.outcome).toEqual({ type: "unavailable" });
    });

    it("declines inside a child agent without opening a dialog", async () => {
      const tool = createAskUserQuestionTool({ env: pauseEnv });
      const { ctx, calls } = fakeCtx({ hasUI: true });

      const result = await autoResolveInteractions(() =>
        run(tool, { questions: [authQuestion] }, ctx),
      );

      expect(calls).toHaveLength(0);
      expect(result.details.questions[0].outcome).toBe("declined");
    });
  });

  describe("registration", () => {
    function fakePi() {
      const registered: ToolDefinition[] = [];
      return {
        registered,
        pi: { registerTool: (tool: ToolDefinition) => registered.push(tool) },
      };
    }

    it("registers the built-in tool", async () => {
      const { pi, registered } = fakePi();
      await askUserQuestionExtension(
        createRecipeExtensionRegistrationRegistry(),
      )(pi as never);
      expect(registered.map((tool) => tool.name)).toEqual([
        "ask_user_question",
      ]);
    });

    it("passes the session environment to the tool", async () => {
      const { pi, registered } = fakePi();
      await askUserQuestionExtension(undefined, pauseEnv)(pi as never);
      const { ctx } = fakeCtx({ hasUI: false });
      const result = await run(
        registered[0]!,
        { questions: [authQuestion] },
        ctx,
      );
      expect(result.details.interrupt.outcome).toEqual({
        type: "awaiting_user",
      });

      const headless = fakePi();
      await askUserQuestionExtension(undefined, {
        PI_ASK_USER_AUTO_APPROVE: "1",
      })(headless.pi as never);
      const { ctx: uiCtx, calls } = fakeCtx({ hasUI: true });
      const declined = await run(
        headless.registered[0]!,
        { questions: [authQuestion] },
        uiCtx,
      );
      expect(calls).toHaveLength(0);
      expect(declined.details.questions[0].outcome).toBe("declined");
    });

    it("keeps a Recipe extension's own ask_user_question", async () => {
      const { pi, registered } = fakePi();
      const registrations = createRecipeExtensionRegistrationRegistry();
      registrations.claim("tool", "ask_user_question", "extensions/ask.js");
      await askUserQuestionExtension(registrations)(pi as never);
      expect(registered).toHaveLength(0);
    });
  });
});
