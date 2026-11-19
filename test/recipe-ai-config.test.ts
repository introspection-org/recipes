import { describe, expect, it } from "vitest";
import {
  parseRecipeAgentAiConfig,
  parseRecipeAgentModelConfig,
  RecipeModelConfigError,
} from "../src/recipe/model.js";

// Every rule an agent's `ai:` and older `model:` blocks follow, pinned by what
// each parses to or the error it gives, so a change to how they are parsed
// shows here as a diff.

const AI_VALID: Record<string, unknown> = {
  everything: {
    model: "anthropic/claude-sonnet-5-5",
    fallbacks: [" openai/gpt-6-luna ", "google/gemini-3"],
    thinking_level: "low",
    options: { max_tokens: 10, temperature: 0.2, cache_retention: "long" },
    providers: {
      openrouter: { routing: { order: ["a"], a_future_field: 1 } },
      anthropic: { betas: ["b1"], context_management: { edits: [] } },
      vercel_ai_gateway: { routing: { only: ["x"] } },
    },
  },
  empty: {},
  blank_model: { model: "   " },
  trimmed_model: { model: "  openai/gpt-6-luna  " },
  empty_options: { options: {} },
  empty_fallbacks: { fallbacks: [] },
  each_thinking_level: { thinking_level: "max" },
  empty_providers: { providers: {} },
  empty_anthropic: { providers: { anthropic: {} } },
  openrouter_without_routing: { providers: { openrouter: {} } },
  nested_option_values_are_opaque: {
    options: { metadata: { anyKey: [1, { deep: true }] } },
  },
};

const AI_INVALID: Record<string, unknown> = {
  not_an_object: "openai/gpt",
  null: null,
  an_array: [],
  unknown_key: { model: "a/b", name: "a/b" },
  model_not_a_string: { model: 3 },
  fallbacks_not_an_array: { fallbacks: "a/b" },
  fallback_without_provider: { fallbacks: ["claude-sonnet-5-5"] },
  fallback_leading_slash: { fallbacks: ["/model"] },
  fallback_trailing_slash: { fallbacks: ["provider/"] },
  fallback_blank: { fallbacks: ["  "] },
  fallback_not_a_string: { fallbacks: [3] },
  thinking_level_unknown: { thinking_level: "extreme" },
  thinking_level_not_a_string: { thinking_level: 1 },
  options_not_an_object: { options: [] },
  options_camel_case_key: { options: { maxTokens: 1 } },
  options_host_owned_api_key: { options: { api_key: "x" } },
  options_host_owned_headers: { options: { headers: {} } },
  options_host_owned_reasoning: { options: { reasoning: "high" } },
  options_host_owned_session_id: { options: { session_id: "s" } },
  providers_not_an_object: { providers: [] },
  providers_unknown: { providers: { bedrock: {} } },
  openrouter_not_an_object: { providers: { openrouter: 1 } },
  openrouter_unknown_key: { providers: { openrouter: { order: ["a"] } } },
  openrouter_routing_not_an_object: {
    providers: { openrouter: { routing: [] } },
  },
  anthropic_not_an_object: { providers: { anthropic: "x" } },
  anthropic_unknown_key: { providers: { anthropic: { beta: ["x"] } } },
  anthropic_betas_not_strings: { providers: { anthropic: { betas: [1] } } },
  anthropic_context_management_not_an_object: {
    providers: { anthropic: { context_management: 1 } },
  },
  vercel_not_an_object: { providers: { vercel_ai_gateway: 1 } },
  vercel_unknown_key: { providers: { vercel_ai_gateway: { only: ["x"] } } },
  vercel_routing_not_an_object: {
    providers: { vercel_ai_gateway: { routing: "x" } },
  },
  vercel_routing_host_owned_byok: {
    providers: { vercel_ai_gateway: { routing: { byok: {}, only: ["x"] } } },
  },
};

const MODEL_VALID: Record<string, unknown> = {
  everything: {
    name: "anthropic/claude-sonnet-5-5",
    thinking_level: "high",
    temperature: 0,
    max_tokens: 5,
    cache_retention: "short",
    timeout_ms: 10,
    max_retries: 0,
    max_retry_delay_ms: 0,
    providers: {
      openrouter: { routing: { order: ["a"], sort: "price" } },
      anthropic: { betas: ["b"], context_management: {} },
    },
  },
  empty: {},
  blank_name: { name: " " },
  fractional_temperature: { temperature: 1.5 },
};

const MODEL_INVALID: Record<string, unknown> = {
  not_an_object: "gpt",
  null: null,
  unknown_key: { model: "a/b" },
  ai_key_fallbacks: { fallbacks: ["a/b"] },
  name_not_a_string: { name: 3 },
  negative_temperature: { temperature: -1 },
  temperature_not_a_number: { temperature: "hot" },
  zero_max_tokens: { max_tokens: 0 },
  fractional_max_tokens: { max_tokens: 1.5 },
  zero_timeout: { timeout_ms: 0 },
  negative_retries: { max_retries: -1 },
  negative_retry_delay: { max_retry_delay_ms: -5 },
  unknown_cache_retention: { cache_retention: "forever" },
  unknown_thinking_level: { thinking_level: "extreme" },
  vercel_is_ai_only: { providers: { vercel_ai_gateway: {} } },
  openrouter_routing_unknown_key: {
    providers: { openrouter: { routing: { a_future_field: 1 } } },
  },
  anthropic_unknown_key: { providers: { anthropic: { beta: [] } } },
};

function errorOf(parse: () => unknown): string {
  try {
    parse();
  } catch (error) {
    expect(error).toBeInstanceOf(RecipeModelConfigError);
    return (error as Error).message;
  }
  throw new Error("expected the block to be refused");
}

describe("an agent's ai: block", () => {
  it.each(Object.entries(AI_VALID))("parses %s", (_, value) => {
    expect(parseRecipeAgentAiConfig("Agent", value)).toMatchSnapshot();
  });
  it.each(Object.entries(AI_INVALID))("refuses %s", (_, value) => {
    expect(
      errorOf(() => parseRecipeAgentAiConfig("Agent", value)),
    ).toMatchSnapshot();
  });
  it("reads an absent block as no settings", () => {
    expect(parseRecipeAgentAiConfig("Agent", undefined)).toBeUndefined();
  });
});

describe("an agent's older model: block", () => {
  it.each(Object.entries(MODEL_VALID))("parses %s", (_, value) => {
    expect(parseRecipeAgentModelConfig("Agent", value)).toMatchSnapshot();
  });
  it.each(Object.entries(MODEL_INVALID))("refuses %s", (_, value) => {
    expect(
      errorOf(() => parseRecipeAgentModelConfig("Agent", value)),
    ).toMatchSnapshot();
  });
  it("reads an absent block as no settings", () => {
    expect(parseRecipeAgentModelConfig("Agent", undefined)).toBeUndefined();
  });
});
