import { type McpServer, notImplemented, text, toolsOf } from "@introspection-ai/recipe-fakes-mcp";
import { contract } from "./contract.ts";

export interface Note {
  id: string;
  title: string;
}

export interface State {
  now: string;
  notes: Note[];
  // A note whose read answers with a result that breaks the output schema.
  brokenId: string | null;
}

const { config, answer } = toolsOf(contract);

export function register(server: McpServer, state: State) {
  server.registerTool("list-notes", config("list-notes"), async ({ limit, order, filter }) => {
    let notes = [...state.notes];
    if (filter?.op === "gt") return notImplemented(`the filter op ${filter.op}`);
    if (filter?.op === "eq") notes = notes.filter((note) => note.title === filter.value);
    if (filter?.op === "contains")
      notes = notes.filter((note) => note.title.includes(filter.value));
    if (order === "desc") notes.reverse();
    const lines = notes.slice(0, limit).map((note) => `${note.id}: ${note.title}`);
    return answer("list-notes", [`limit: ${limit}`, `order: ${order}`, ...lines].join("\n"));
  });

  server.registerTool("create-note", config("create-note"), async ({ title }) => {
    const note = { id: `note-${state.notes.length + 1}`, title };
    state.notes.push(note);
    return answer("create-note", `Created ${note.id}`);
  });

  server.registerTool("get-note", config("get-note"), async ({ id }) => {
    const note = state.notes.find((item) => item.id === id);
    if (!note) return text(`Note ${id} not found.`, true);
    if (id === state.brokenId) return text(note.title);
    return answer("get-note", { id: note.id, title: note.title });
  });
}
