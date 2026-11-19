import { parseMaybeJson, type TrajectoryEvent } from "./trajectory.js";

interface SessionEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  timestamp?: unknown;
  message?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        isRecord(part) && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

/** The entries on the session's active branch, oldest first. */
function activeBranch(entries: readonly SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) {
    if (typeof entry.id === "string") byId.set(entry.id, entry);
  }
  const branch: SessionEntry[] = [];
  let entry = [...entries]
    .reverse()
    .find((candidate) => candidate.type !== "session");
  while (entry) {
    branch.push(entry);
    entry =
      typeof entry.parentId === "string" ? byId.get(entry.parentId) : undefined;
  }
  return branch.reverse();
}

/**
 * A Pi session file as judge evidence: what the user and the assistant said
 * and the tools the assistant ran, on the session's active branch. The system
 * prompt, reasoning, and the entries Pi keeps for its own state are not
 * evidence.
 */
export function trajectoryFromPiSession(
  sessionJsonl: string,
): TrajectoryEvent[] {
  const entries = sessionJsonl
    .split("\n")
    .filter((raw) => raw.trim())
    .map((raw, index) => {
      try {
        return JSON.parse(raw) as SessionEntry;
      } catch {
        throw new Error(`session line ${index + 1} is not JSON`);
      }
    });
  if (entries[0]?.type !== "session") {
    throw new Error("not a Pi session file: its first line is not a session");
  }
  const events: TrajectoryEvent[] = [];
  for (const entry of activeBranch(entries)) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    const timestamp =
      typeof entry.timestamp === "string" ? { timestamp: entry.timestamp } : {};
    if (message.role === "user") {
      events.push({
        type: "message",
        role: "user",
        content: text(message.content),
        ...timestamp,
      });
    } else if (message.role === "assistant") {
      const said = text(message.content);
      if (said) {
        events.push({
          type: "message",
          role: "assistant",
          content: said,
          ...timestamp,
        });
      }
      for (const part of Array.isArray(message.content)
        ? message.content
        : []) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        events.push({
          type: "tool_call",
          id: String(part.id),
          name: String(part.name),
          ...(isRecord(part.arguments) ? { arguments: part.arguments } : {}),
          ...timestamp,
        });
      }
    } else if (message.role === "toolResult") {
      const output = text(message.content);
      events.push({
        type: "tool_result",
        tool_call_id: String(message.toolCallId),
        ...(typeof message.toolName === "string"
          ? { name: message.toolName }
          : {}),
        ...(message.isError === true
          ? { error: { type: "ToolError", message: output } }
          : { content: parseMaybeJson(output) }),
        ...timestamp,
      });
    }
  }
  return events;
}
