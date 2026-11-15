/**
 * A session's span identity from OpenTelemetry baggage: the conversation id a
 * caller sets around the session (a batch prompt's, say) names it unless
 * `meta` does, and every other entry is added to its spans.
 */
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveRecipe } from "../src/recipe/resolve.js";
import {
  createAgentSession,
  type RecipeSessionHandle,
} from "../src/session.js";
import { cleanEnv, writeFixtureRecipe } from "../src/test-utils.js";
import { useAsyncContext, withBaggage } from "./helpers/otel-context.js";

const instrumentSession = vi.hoisted(() => vi.fn(() => ({ detach: vi.fn() })));

vi.mock("@introspection-sdk/introspection-pi", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@introspection-sdk/introspection-pi")
  >()),
  instrumentSession,
}));

interface PassedOptions {
  meta: { conversationId: string };
  extraAttributes?: () => Record<string, string>;
}

const handles: RecipeSessionHandle[] = [];
const cleanups: Array<() => void> = [];

afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.dispose();
  for (const cleanup of cleanups.splice(0)) cleanup();
  instrumentSession.mockClear();
});

async function openInBaggage(
  entries: Record<string, string>,
  otel: Parameters<typeof createAgentSession>[0]["otel"],
): Promise<PassedOptions> {
  const { recipeDir, workspaceDir, cleanup } = writeFixtureRecipe();
  cleanups.push(cleanup);
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("anthropic", async () => ({
    type: "api_key",
    key: "test-key",
  }));
  const teardown = useAsyncContext();
  try {
    const handle = await withBaggage(entries, () =>
      createAgentSession({
        recipe: resolveRecipe({ recipeDir }),
        cwd: workspaceDir,
        credentials,
        env: cleanEnv(),
        otel,
      }),
    );
    handles.push(handle);
  } finally {
    teardown();
  }
  return (
    instrumentSession.mock.calls[0] as unknown[] | undefined
  )?.[1] as PassedOptions;
}

describe("a session's identity from baggage", () => {
  it("takes its conversation id from baggage, and every other entry onto its spans", async () => {
    const options = await openInBaggage(
      { "gen_ai.conversation.id": "batch-7:03", "acme.request_id": "r-1" },
      {
        tracer: {} as never,
        extraAttributes: () => ({ "acme.tenant": "t-1" }),
      },
    );

    expect(options.meta.conversationId).toBe("batch-7:03");
    // The conversation id is the span's identity, never a second attribute.
    expect(options.extraAttributes?.()).toEqual({
      "acme.request_id": "r-1",
      "acme.tenant": "t-1",
    });
  });

  it("keeps a conversation id named in meta over the one in baggage", async () => {
    const options = await openInBaggage(
      { "gen_ai.conversation.id": "from-baggage" },
      { tracer: {} as never, meta: { conversationId: "explicit" } },
    );
    expect(options.meta.conversationId).toBe("explicit");
  });

  it("generates a conversation id when neither names one", async () => {
    const options = await openInBaggage({}, { tracer: {} as never });
    expect(options.meta.conversationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.extraAttributes).toBeUndefined();
  });
});
