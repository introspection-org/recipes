import type { State as Mail } from "../mcp/mail/handlers.ts";
import type { State as Notes } from "../mcp/notes/handlers.ts";

export interface World {
  notes: Notes;
  mail: Mail;
}

export const SCENARIOS: Record<string, (world: World) => void> = {
  quiet: () => {},
  broken: (world) => {
    world.notes.brokenId = "note-1";
  },
};

export function world(scenario = "quiet", clock: Date | string = new Date()): World {
  const change = Object.hasOwn(SCENARIOS, scenario) ? SCENARIOS[scenario] : undefined;
  if (!change) throw new Error(`Unknown scenario ${scenario}`);
  const now = new Date(clock).toISOString();
  const states: World = {
    notes: {
      now,
      notes: [
        { id: "note-1", title: "Kickoff" },
        { id: "note-2", title: "Pricing call" },
        { id: "note-3", title: "Pricing follow-up" },
      ],
      brokenId: null,
    },
    mail: { now, emails: [] },
  };
  change(states);
  return states;
}
