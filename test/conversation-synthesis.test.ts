import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  conversationSynthesis,
  type ConversationModelCall,
  type ConversationSynthesisInput,
} from "../src/prompts/index.js";

// Real-shaped and edge-case conversations, with @1's output pinned in the snapshot.
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "conversation-synthesis",
);

/** Keep `timestamp_ns` exact: it is past what a JSON number holds. */
function load(file: string): {
  name: string;
  input: ConversationSynthesisInput;
} {
  return JSON.parse(
    readFileSync(join(FIXTURES, file), "utf8"),
    (key, value, context?: { source?: string }) =>
      key === "timestamp_ns" &&
      typeof value === "number" &&
      context?.source !== undefined
        ? context.source
        : value,
  );
}

/** What a prompt is made of: its sections, messages by role and lane, and events by kind. */
function shape(prompt: string) {
  return {
    sections: [...prompt.matchAll(/^ {2}<(\w+)/gm)].map((m) => m[1]),
    messages: [
      ...prompt.matchAll(
        /<message ref="(\w+)" role="(\w+)"(?: lane="([^"]+)")?>/g,
      ),
    ].map((m) => (m[3] ? `${m[1]}:${m[2]}@${m[3]}` : `${m[1]}:${m[2]}`)),
    events: [...prompt.matchAll(/<event ref="(\w+)" kind="(\w+)">/g)].map(
      (m) => `${m[1]}:${m[2]}`,
    ),
    length: prompt.length,
  };
}

/** 160 calls past the transcript cap: the opening messages and the tail survive. */
function longConversation(): ConversationSynthesisInput {
  const t0 = Date.parse("2026-11-12T09:00:00Z");
  return {
    conversation_id: "conv-long",
    completed_at: "2026-11-12T12:00:00Z",
    span_count: 320,
    model_calls: Array.from({ length: 160 }, (_, i) => ({
      span_id: `span-${String(i).padStart(2, "0")}`,
      response_id: `resp-${String(i).padStart(2, "0")}`,
      timestamp: new Date(t0 + i * 60_000).toISOString().replace(".000", ""),
      timestamp_ns: `${BigInt(t0 + i * 60_000) * 1_000_000n}`,
      input_message_count: 2 * i + 1,
      input_new_messages: [
        {
          role: "user",
          parts: [{ type: "text", content: `Continue with step ${i}.` }],
        },
      ],
      output_messages: [
        {
          role: "assistant",
          parts: [
            { type: "text", content: `Step ${i}: ${"details ".repeat(760)}` },
          ],
        },
      ],
    })),
    prior_observations: [],
  };
}

describe("conversation_synthesis@1 renders each fixture as pinned", () => {
  for (const file of readdirSync(FIXTURES).filter((name) =>
    name.endsWith(".json"),
  )) {
    const fixture = load(file);
    it(fixture.name, () => {
      const built = conversationSynthesis.build(fixture.input, 1_000_000);
      expect({
        shape: shape(built.prompt),
        digest: built.digest ?? null,
        state: built.state,
      }).toMatchSnapshot();
    });
  }

  it("long_conversation_capped", () => {
    const built = conversationSynthesis.build(longConversation(), 1_000_000);
    expect(built.prompt).toContain("truncated");
    expect({
      shape: shape(built.prompt),
      digest: built.digest ?? null,
      state: built.state,
    }).toMatchSnapshot();
  });
});

const T0 = Date.parse("2026-11-19T09:00:00Z");
let next = 0;
const call = (
  window: { role: string; text: string }[],
  output: string,
  options: { count?: number; agent?: string } = {},
): ConversationModelCall => {
  const ms = T0 + next++ * 60_000;
  return {
    span_id: `s${next}`,
    timestamp: new Date(ms).toISOString(),
    timestamp_ns: `${BigInt(ms) * 1_000_000n}`,
    input_message_count: options.count ?? 1,
    input_new_messages: window.map(({ role, text }) => ({
      role,
      parts: [{ type: "text", content: text }],
    })),
    output_messages: [
      { role: "assistant", parts: [{ type: "text", content: output }] },
    ],
    ...(options.agent ? { agent_name: options.agent } : {}),
  };
};
const transcript = (prompt: string) =>
  [
    ...prompt.matchAll(
      /<message ref="\w+" role="(\w+)"(?: lane="([^"]+)")?>([^<]*)<\/message>/g,
    ),
  ].map((m) => `${m[2] ? `${m[2]}/` : ""}${m[1]}: ${m[3]}`);

describe("conversation_synthesis@1 reads the processor's windows", () => {
  it("keeps a new message that repeats earlier text", () => {
    next = 0;
    const built = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-19T09:10:00Z",
        model_calls: [
          call([{ role: "user", text: "Reply with done." }], "done", {
            count: 1,
            agent: "agent",
          }),
          call([{ role: "user", text: "Reply with done." }], "done", {
            count: 3,
            agent: "agent",
          }),
        ],
      },
      300_000,
    );
    expect(transcript(built.prompt)).toEqual([
      "user: Reply with done.",
      "assistant: done",
      "user: Reply with done.",
      "assistant: done",
    ]);
  });

  it("brings a subagent's task, not the history its first window inherited, then its own turns", () => {
    next = 0;
    const built = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-19T09:10:00Z",
        model_calls: [
          call(
            [{ role: "user", text: "Research the market." }],
            "Delegating.",
            { count: 1, agent: "agent" },
          ),
          call(
            [
              { role: "user", text: "Research the market." },
              { role: "assistant", text: "Delegating." },
              { role: "user", text: "Find three competitors." },
            ],
            "Found three.",
            { count: 3, agent: "researcher" },
          ),
          call(
            [{ role: "user", text: "Now their prices." }],
            "Listed prices.",
            { count: 5, agent: "researcher" },
          ),
          call([{ role: "user", text: "Thanks." }], "You're welcome.", {
            count: 3,
            agent: "agent",
          }),
        ],
      },
      300_000,
    );
    expect(transcript(built.prompt)).toEqual([
      "user: Research the market.",
      "assistant: Delegating.",
      "researcher/user: Find three competitors.",
      "researcher/assistant: Found three.",
      "researcher/user: Now their prices.",
      "researcher/assistant: Listed prices.",
      "user: Thanks.",
      "assistant: You're welcome.",
    ]);
    // A lane's input size is its own: the root's 3 after the subagent's 5 is no compaction.
    expect(built.prompt).not.toContain("<context_compactions");
    const plan = (
      built.state as unknown as {
        plan: { watermark_next: { root_lane: string; lanes: string[] } };
      }
    ).plan;
    expect(plan.watermark_next.root_lane).toBe("name:agent");
    expect(plan.watermark_next.lanes.sort()).toEqual([
      "name:agent",
      "name:researcher",
    ]);
  });

  it("continues a lane begun in an earlier segment with its whole window", () => {
    next = 10;
    const built = conversationSynthesis.build(
      {
        conversation_id: "c",
        completed_at: "2026-11-19T09:20:00Z",
        model_calls: [
          call(
            [
              { role: "user", text: "And their revenue." },
              { role: "user", text: "In euros." },
            ],
            "Done.",
            {
              count: 7,
              agent: "researcher",
            },
          ),
        ],
        watermark: {
          watermark: "2026-11-19T09:05:00Z",
          segment: 1,
          root_lane: "name:agent",
          lanes: ["name:agent", "name:researcher"],
          last_input_count: 3,
        },
      },
      300_000,
    );
    expect(transcript(built.prompt)).toEqual([
      "researcher/user: And their revenue.",
      "researcher/user: In euros.",
      "researcher/assistant: Done.",
    ]);
  });
});
