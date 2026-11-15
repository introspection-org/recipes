/**
 * The OpenTelemetry baggage entry naming the conversation a session records
 * under: a session takes it as its conversation id when its `otel.meta` names
 * none, and a batch sets it around each prompt's session.
 */
export const CONVERSATION_ID_BAGGAGE = "gen_ai.conversation.id";
