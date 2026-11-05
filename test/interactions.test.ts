import { describe, expect, it, vi } from "vitest";
import type {
  ExtensionContext,
  ExtensionUIDialogOptions,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_RPC_DIALOG_TIMEOUT_MS,
  ASK_USER_REASON_CONFIRMATION,
  ASK_USER_REASON_INPUT_REQUIRED,
  ASK_USER_REASON_TOOL_CALL,
  askUser,
  askUserApproval,
  askUserQuestion,
  autoResolveInteractions,
  formatInteractionOutcome,
  formatInteractionResume,
  type AskUserOutcome,
} from "../src/interactions.js";

interface FakeUiCall {
  kind: "select" | "input" | "confirm" | "custom";
  title: string;
  options?: string[];
  dialog?: ExtensionUIDialogOptions;
}

function fakeCtx(opts: {
  hasUI: boolean;
  mode?: "tui" | "rpc" | "print";
  selectResults?: Array<string | undefined>;
  inputResults?: Array<string | undefined>;
  customInputs?: string[];
}): { ctx: ExtensionContext; calls: FakeUiCall[] } {
  const calls: FakeUiCall[] = [];
  const selectResults = [...(opts.selectResults ?? [])];
  const inputResults = [...(opts.inputResults ?? [])];
  const ctx = {
    hasUI: opts.hasUI,
    mode: opts.mode ?? "tui",
    ui: {
      async select(
        title: string,
        options: string[],
        dialog?: ExtensionUIDialogOptions,
      ) {
        calls.push({ kind: "select", title, options, dialog });
        return selectResults.shift();
      },
      async input(
        title: string,
        _placeholder?: string,
        dialog?: ExtensionUIDialogOptions,
      ) {
        calls.push({ kind: "input", title, dialog });
        return inputResults.shift();
      },
      async confirm() {
        calls.push({ kind: "confirm", title: "" });
        return false;
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
              ) =>
                | {
                    handleInput?(data: string): void;
                    dispose?(): void;
                  }
                | Promise<{
                    handleInput?(data: string): void;
                    dispose?(): void;
                  }>,
            ) {
              calls.push({ kind: "custom", title: "" });
              let result: T | undefined;
              const component = await factory(
                { requestRender() {} },
                {
                  fg: (_color, text) => text,
                  bold: (text) => text,
                },
                {},
                (value) => {
                  result = value;
                },
              );
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
  return { ctx, calls };
}

const question = {
  reason: ASK_USER_REASON_INPUT_REQUIRED,
  message: "Which beverage?",
};

describe("askUser", () => {
  it("auto-approve declines questions and approves confirmations without dialogs", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, selectResults: ["Tea"] });
    const env = { PI_ASK_USER_AUTO_APPROVE: "1" };

    const declined = await askUser(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env,
    });
    expect(declined.outcome).toEqual({ type: "declined" });
    expect(declined.content).toEqual([
      {
        type: "text",
        text: "User declined to answer. Proceed with your best judgment.",
      },
    ]);

    const approved = await askUser(
      { reason: ASK_USER_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-2", ctx, signal: undefined, env },
    );
    expect(approved.outcome).toEqual({ type: "approved" });
    expect(approved.content[0].text).toBe("Approved.");
    expect(calls).toHaveLength(0);
  });

  it("answers an option question through a select dialog", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, selectResults: ["Tea"] });
    const result = await askUser(
      { ...question, options: ["Tea", "Coffee"] },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );
    expect(result.outcome).toEqual({ type: "answered", answer: "Tea" });
    expect(result.content).toEqual([{ type: "text", text: "Answer: Tea" }]);
    expect(calls).toEqual([
      expect.objectContaining({
        kind: "select",
        title: "Which beverage?",
        options: ["Tea", "Coffee", "Other"],
      }),
    ]);
  });

  it("allows a custom input answer from an option question", async () => {
    const { ctx, calls } = fakeCtx({
      hasUI: true,
      selectResults: ["Other"],
      inputResults: ["  Sparkling  "],
    });
    const result = await askUser(
      { ...question, options: ["Tea", "Coffee"] },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );
    expect(result.outcome).toEqual({
      type: "answered",
      answer: "Sparkling",
    });
    expect(result.content).toEqual([
      { type: "text", text: "Answer: Sparkling" },
    ]);
    expect(calls).toEqual([
      expect.objectContaining({
        kind: "select",
        options: ["Tea", "Coffee", "Other"],
      }),
      expect.objectContaining({
        kind: "input",
        title: "Answer",
      }),
    ]);
  });

  it("answers a multiple-choice question through a portable toggle walk", async () => {
    const { ctx, calls } = fakeCtx({
      hasUI: true,
      selectResults: ["[ ] Tea", "[ ] Water", "Done"],
    });
    const result = await askUser(
      {
        ...question,
        selection: "multiple",
        options: [
          { label: "Tea", value: "tea" },
          { label: "Coffee", value: "coffee" },
          { label: "Water", value: "water" },
        ],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({
      type: "answered",
      answers: ["tea", "water"],
    });
    expect(result.content).toEqual([
      { type: "text", text: 'Answers: ["tea","water"]' },
    ]);
    expect(calls.map((call) => call.options)).toEqual([
      ["[ ] Tea", "[ ] Coffee", "[ ] Water", "Other", "Done"],
      ["[x] Tea", "[ ] Coffee", "[ ] Water", "Other", "Done"],
      ["[x] Tea", "[ ] Coffee", "[x] Water", "Other", "Done"],
    ]);
  });

  it("uses a native custom TUI for multiple selection", async () => {
    const { ctx, calls } = fakeCtx({
      hasUI: true,
      customInputs: ["1", "2", "\x1b[B", "\x1b[B", "\x1b[B", "\r"],
    });
    const result = await askUser(
      {
        ...question,
        selection: "multiple",
        options: [
          { label: "Tea", value: "tea", description: "Calming" },
          { label: "Coffee", value: "coffee", description: "Energizing" },
        ],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({
      type: "answered",
      answers: ["tea", "coffee"],
    });
    expect(calls).toEqual([expect.objectContaining({ kind: "custom" })]);
  });

  it("includes a custom answer in a multiple-choice response", async () => {
    const { ctx } = fakeCtx({
      hasUI: true,
      selectResults: ["[ ] Tea", "Other"],
      inputResults: ["  Sparkling  "],
    });
    const result = await askUser(
      {
        ...question,
        selection: "multiple",
        options: ["Tea", "Coffee"],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({
      type: "answered",
      answers: ["Tea", "Sparkling"],
    });
  });

  it("deduplicates a portable custom answer matching a selected option", async () => {
    const { ctx } = fakeCtx({
      hasUI: true,
      selectResults: ["[ ] Tea", "Other"],
      inputResults: ["  Tea  "],
    });
    const result = await askUser(
      {
        ...question,
        selection: "multiple",
        options: ["Tea", "Coffee"],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({
      type: "answered",
      answers: ["Tea"],
    });
  });

  it("deduplicates a TUI custom answer matching a selected option", async () => {
    const { ctx } = fakeCtx({
      hasUI: true,
      customInputs: ["1", "\x1b[B", "\x1b[B", "\r"],
      inputResults: ["  Tea  "],
    });
    const result = await askUser(
      {
        ...question,
        selection: "multiple",
        options: ["Tea"],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({
      type: "answered",
      answers: ["Tea"],
    });
  });

  it("rejects multiple selection without usable options", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    await expect(
      askUser(
        { ...question, selection: "multiple", options: ["  "] },
        { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
      ),
    ).rejects.toThrow("Multiple selection requires at least one option");
  });

  it("returns option values while preserving structured option details", async () => {
    const { ctx } = fakeCtx({ hasUI: true, selectResults: ["Tea"] });
    const result = await askUser(
      {
        ...question,
        options: [
          {
            label: "Tea",
            value: "tea",
            description: "A calming cup of tea.",
          },
          { label: "Coffee", value: "coffee" },
        ],
      },
      { toolCallId: "tool-1", ctx, signal: undefined, env: {} },
    );
    expect(result.outcome).toEqual({ type: "answered", answer: "tea" });
    expect(result.details.interrupt.options).toEqual([
      {
        label: "Tea",
        value: "tea",
        description: "A calming cup of tea.",
      },
      { label: "Coffee", value: "coffee" },
    ]);
  });

  it("answers a free-form question through an input dialog", async () => {
    const { ctx } = fakeCtx({ hasUI: true, inputResults: ["  Chai  "] });
    const result = await askUser(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
    });
    expect(result.outcome).toEqual({ type: "answered", answer: "Chai" });
    expect(result.content[0].text).toBe("Answer: Chai");
  });

  it("treats empty and dismissed dialog answers as declines", async () => {
    for (const inputResult of ["", "   ", undefined]) {
      const { ctx } = fakeCtx({ hasUI: true, inputResults: [inputResult] });
      const result = await askUser(question, {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: {},
      });
      expect(result.outcome).toEqual({ type: "declined" });
      expect(result.content[0].text).toBe(
        "User declined to answer. Proceed with your best judgment.",
      );
    }
  });

  it("propagates a turn abort instead of fabricating a decline", async () => {
    const controller = new AbortController();
    const { ctx } = fakeCtx({ hasUI: true, selectResults: [undefined] });
    controller.abort();
    await expect(
      askUser(
        { ...question, options: ["Tea", "Coffee"] },
        { toolCallId: "tool-1", ctx, signal: controller.signal, env: {} },
      ),
    ).rejects.toThrow("User interaction aborted");
  });

  it("walks approvals through select + optional feedback input", async () => {
    const approve = fakeCtx({ hasUI: true, selectResults: ["Approve"] });
    const approved = await askUser(
      { reason: ASK_USER_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-1", ctx: approve.ctx, signal: undefined, env: {} },
    );
    expect(approved.outcome).toEqual({ type: "approved" });
    expect(approved.content[0].text).toBe("Approved.");
    expect(approve.calls).toEqual([
      expect.objectContaining({
        kind: "select",
        options: ["Approve", "Request changes"],
      }),
    ]);

    const revise = fakeCtx({
      hasUI: true,
      selectResults: ["Request changes"],
      inputResults: ["Rename the flag"],
    });
    const revision = await askUser(
      { reason: ASK_USER_REASON_CONFIRMATION, message: "Ship the plan?" },
      { toolCallId: "tool-2", ctx: revise.ctx, signal: undefined, env: {} },
    );
    expect(revision.outcome).toEqual({
      type: "revision_requested",
      feedback: "Rename the flag",
    });
    expect(revision.content[0].text).toBe(
      "Revision requested. Feedback: Rename the flag",
    );

    const reviseNoFeedback = fakeCtx({
      hasUI: true,
      selectResults: ["Request changes"],
      inputResults: [""],
    });
    const bare = await askUser(
      { reason: ASK_USER_REASON_CONFIRMATION, message: "Ship the plan?" },
      {
        toolCallId: "tool-3",
        ctx: reviseNoFeedback.ctx,
        signal: undefined,
        env: {},
      },
    );
    expect(bare.outcome).toEqual({ type: "revision_requested" });
    expect(bare.content[0].text).toBe("Revision requested.");
  });

  it("formats structured display copy for local approval dialogs", async () => {
    const approve = fakeCtx({ hasUI: true, selectResults: ["Approve"] });
    const result = await askUser(
      {
        reason: ASK_USER_REASON_TOOL_CALL,
        message: "Approve search proposal: Sydney product leaders?",
        display: {
          kind: "search_proposal",
          title: "Sydney product leaders",
          body: "Find senior product leaders in Sydney tech companies.",
          sections: [
            {
              title: "Starting angles",
              items: [
                "Product leaders in Sydney",
                "Growth product leaders in Sydney",
              ],
            },
          ],
        },
      },
      { toolCallId: "tool-1", ctx: approve.ctx, signal: undefined, env: {} },
    );

    expect(result.outcome).toEqual({ type: "approved" });
    expect(approve.calls[0]).toEqual(
      expect.objectContaining({
        kind: "select",
        title:
          "Sydney product leaders\n\n" +
          "Find senior product leaders in Sydney tech companies.\n\n" +
          "Starting angles:\n" +
          "- Product leaders in Sydney\n" +
          "- Growth product leaders in Sydney",
        options: ["Approve", "Request changes"],
      }),
    );
    expect(result.details.interrupt.display?.kind).toBe("search_proposal");
  });

  it("applies the default dialog timeout in RPC mode only", async () => {
    const rpc = fakeCtx({ hasUI: true, mode: "rpc", inputResults: ["yes"] });
    await askUser(question, {
      toolCallId: "tool-1",
      ctx: rpc.ctx,
      signal: undefined,
      env: {},
    });
    expect(rpc.calls[0].dialog?.timeout).toBe(DEFAULT_RPC_DIALOG_TIMEOUT_MS);

    const tui = fakeCtx({ hasUI: true, mode: "tui", inputResults: ["yes"] });
    await askUser(question, {
      toolCallId: "tool-1",
      ctx: tui.ctx,
      signal: undefined,
      env: {},
    });
    expect(tui.calls[0].dialog?.timeout).toBeUndefined();

    const override = fakeCtx({ hasUI: true, mode: "tui", inputResults: ["y"] });
    await askUser(question, {
      toolCallId: "tool-1",
      ctx: override.ctx,
      signal: undefined,
      timeoutMs: 5_000,
      env: {},
    });
    expect(override.calls[0].dialog?.timeout).toBe(5_000);
  });

  it("prefers a custom interactive walk and falls through on undefined", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true, inputResults: ["fallback"] });
    const custom = await askUser(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
      interactive: async () => ({ type: "answered", answer: "Custom" }),
    });
    expect(custom.content[0].text).toBe("Answer: Custom");
    expect(calls).toHaveLength(0);

    const fallthrough = await askUser(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
      interactive: async () => undefined,
    });
    expect(fallthrough.content[0].text).toBe("Answer: fallback");
    expect(calls).toEqual([expect.objectContaining({ kind: "input" })]);
  });

  it("returns a recipe interrupt request when the host supports resume", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUser(
      {
        ...question,
        options: ["Tea", "Coffee"],
        metadata: { kind: "question", header: "Beverage" },
        expiresAt: "2026-07-09T00:00:00Z",
      },
      {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );
    expect(result.outcome).toEqual({ type: "awaiting_user" });
    expect(result.content).toEqual([
      { type: "text", text: "Awaiting user response." },
    ]);
    expect(result.details.interrupt).toEqual({
      reason: "input_required",
      message: "Which beverage?",
      options: [{ label: "Tea" }, { label: "Coffee" }],
      metadata: {
        kind: "question",
        header: "Beverage",
      },
      expiresAt: "2026-07-09T00:00:00Z",
      outcome: { type: "awaiting_user" },
    });
  });

  it("askUserQuestion builds native question interrupt details", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUserQuestion(
      {
        question: "Which market?",
        header: "Market",
        options: [
          {
            label: "Sydney (Recommended)",
            value: "sydney",
            description: "Focus the search in Sydney.",
          },
          {
            label: "Melbourne",
            value: "melbourne",
            description: "Focus the search in Melbourne.",
          },
        ],
      },
      {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );

    expect(result.details.interrupt).toEqual({
      reason: "input_required",
      message: "Which market?",
      options: [
        {
          label: "Sydney (Recommended)",
          value: "sydney",
          description: "Focus the search in Sydney.",
        },
        {
          label: "Melbourne",
          value: "melbourne",
          description: "Focus the search in Melbourne.",
        },
      ],
      metadata: {
        kind: "ask_user_question",
        header: "Market",
        question: "Which market?",
      },
      outcome: { type: "awaiting_user" },
    });
  });

  it("exposes multiple selection to interrupt-capable hosts", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUserQuestion(
      {
        question: "Which markets?",
        selection: "multiple",
        options: ["Sydney", "Melbourne"],
      },
      {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );

    expect(result.details.interrupt).toEqual({
      reason: "input_required",
      message: "Which markets?",
      options: [{ label: "Sydney" }, { label: "Melbourne" }],
      selection: "multiple",
      metadata: {
        kind: "ask_user_question",
        question: "Which markets?",
      },
      outcome: { type: "awaiting_user" },
    });
  });

  it("askUserApproval builds native approval display and metadata", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUserApproval(
      {
        kind: "plan_search",
        message: "Approve search proposal: Sydney product leaders?",
        title: "Sydney product leaders",
        body: "Find senior product leaders in Sydney tech companies.",
        sections: [
          {
            title: "Starting angles",
            items: ["Product leaders", "Growth product leaders"],
          },
        ],
        metadata: {
          proposal: "Find senior product leaders in Sydney tech companies.",
        },
      },
      {
        toolCallId: "tool-9",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );

    expect(result.details.interrupt).toEqual({
      reason: "confirmation",
      message: "Approve search proposal: Sydney product leaders?",
      metadata: {
        kind: "plan_search",
        title: "Sydney product leaders",
        body: "Find senior product leaders in Sydney tech companies.",
        sections: [
          {
            title: "Starting angles",
            items: ["Product leaders", "Growth product leaders"],
          },
        ],
        proposal: "Find senior product leaders in Sydney tech companies.",
      },
      display: {
        kind: "plan_search",
        title: "Sydney product leaders",
        body: "Find senior product leaders in Sydney tech companies.",
        sections: [
          {
            title: "Starting angles",
            items: ["Product leaders", "Growth product leaders"],
          },
        ],
      },
      outcome: { type: "awaiting_user" },
    });
  });

  it("uses the same native approval details before remote resume", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUser(
      { reason: ASK_USER_REASON_CONFIRMATION, message: "Ship the plan?" },
      {
        toolCallId: "tool-9",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );
    expect(result.details.interrupt).toEqual({
      reason: "confirmation",
      message: "Ship the plan?",
      outcome: { type: "awaiting_user" },
    });
  });

  it("keeps tool-call approvals as native display data before remote resume", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const display = {
      kind: "search_proposal",
      title: "Sydney product leaders",
      body: "Find senior product leaders in Sydney tech companies.",
      sections: [
        {
          title: "Starting angles",
          items: ["Product leaders", "Growth product leaders"],
        },
      ],
    };

    const result = await askUser(
      {
        reason: ASK_USER_REASON_TOOL_CALL,
        message: "Approve search proposal: Sydney product leaders?",
        display,
        metadata: { kind: "plan_search", proposalId: "proposal-1" },
      },
      {
        toolCallId: "tool-9",
        ctx,
        signal: undefined,
        env: { PI_INTERRUPT_RESUME: "1" },
      },
    );

    expect(result.details.interrupt).toEqual({
      reason: "tool_call",
      message: "Approve search proposal: Sydney product leaders?",
      metadata: {
        kind: "plan_search",
        proposalId: "proposal-1",
      },
      display,
      outcome: { type: "awaiting_user" },
    });
  });

  it("auto-resolves interactions inside a child agent run", async () => {
    const { ctx, calls } = fakeCtx({ hasUI: true });
    const env = { PI_INTERRUPT_RESUME: "1" };

    const questionResult = await autoResolveInteractions(() =>
      askUser(question, { toolCallId: "tool-1", ctx, signal: undefined, env }),
    );
    expect(questionResult.outcome).toEqual({ type: "declined" });

    const approvalResult = await autoResolveInteractions(() =>
      askUserApproval(
        {
          kind: "plan_search",
          message: "Approve the plan?",
          title: "Search plan",
        },
        { toolCallId: "tool-2", ctx, signal: undefined, env },
      ),
    );
    expect(approvalResult.outcome).toEqual({ type: "approved" });
    expect(calls).toEqual([]);

    const { ctx: headlessCtx } = fakeCtx({ hasUI: false });
    const outside = await askUser(question, {
      toolCallId: "tool-1",
      ctx: headlessCtx,
      signal: undefined,
      env,
    });
    expect(outside.outcome).toEqual({ type: "awaiting_user" });
  });

  it("shares child auto-resolution across separately loaded package copies", async () => {
    vi.resetModules();
    const isolated = await import("../src/interactions.js");
    const { ctx } = fakeCtx({ hasUI: false });

    const result = await autoResolveInteractions(() =>
      isolated.askUserApproval(
        { title: "Child plan" },
        {
          toolCallId: "tool-isolated",
          ctx,
          signal: undefined,
          env: { PI_INTERRUPT_RESUME: "1" },
        },
      ),
    );

    expect(result.outcome).toEqual({ type: "approved" });
  });

  it("reports unavailability when no interaction channel exists", async () => {
    const { ctx } = fakeCtx({ hasUI: false });
    const result = await askUser(question, {
      toolCallId: "tool-1",
      ctx,
      signal: undefined,
      env: {},
    });
    expect(result.outcome).toEqual({ type: "unavailable" });
    expect(result.content[0].text).toContain("nothing was shown to the user");
    expect(result.content[0].text).toContain("normal assistant reply");
  });

  it("renders the frozen envelope table byte-for-byte", async () => {
    // Shared wire contract with interrupt-capable hosts: the host synthesizes
    // these exact literals when resuming a paused run, so the locally-rendered
    // envelopes must match byte-for-byte.
    const table: Array<{ outcome: AskUserOutcome; text: string }> = [
      { outcome: { type: "answered", answer: "Tea" }, text: "Answer: Tea" },
      {
        outcome: { type: "answered", answers: ["Tea", "Water"] },
        text: 'Answers: ["Tea","Water"]',
      },
      { outcome: { type: "approved" }, text: "Approved." },
      {
        outcome: { type: "approved", feedback: "Ship it" },
        text: "Approved. Feedback: Ship it",
      },
      {
        outcome: { type: "revision_requested" },
        text: "Revision requested.",
      },
      {
        outcome: { type: "revision_requested", feedback: "Rename the flag" },
        text: "Revision requested. Feedback: Rename the flag",
      },
      {
        outcome: { type: "declined" },
        text: "User declined to answer. Proceed with your best judgment.",
      },
    ];

    for (const entry of table) {
      const { ctx } = fakeCtx({ hasUI: true });
      const result = await askUser(question, {
        toolCallId: "tool-1",
        ctx,
        signal: undefined,
        env: {},
        interactive: async () => entry.outcome,
      });
      expect(result.content).toEqual([{ type: "text", text: entry.text }]);
      expect(formatInteractionOutcome(entry.outcome)).toBe(entry.text);
    }
  });

  it("formats host resume records into the frozen interaction envelope", () => {
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { answer: "  Tea  " },
      }),
    ).toBe("Answer: Tea");
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { answers: ["  Tea  ", "Water", "Tea", "", 42] },
      }),
    ).toBe('Answers: ["Tea","Water"]');
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { approved: true, feedback: "  Ship it  " },
      }),
    ).toBe("Approved. Feedback: Ship it");
    expect(
      formatInteractionResume({
        status: "resolved",
        payload: { approved: false },
      }),
    ).toBe("Revision requested.");
    expect(formatInteractionResume({ status: "cancelled" })).toBe(
      "User declined to answer. Proceed with your best judgment.",
    );
    expect(formatInteractionResume({ status: "expired" })).toBe(
      "Interrupt response: expired",
    );
  });
});
