// #region docs:improve/fakes/handlers
import {
  type McpServer,
  notImplemented,
  text,
  toolsOf,
} from "@introspection-ai/eval-simulate/mcp";
import { contract } from "./contract.ts";
import type { State } from "./entities.ts";

const { config, answer } = toolsOf(contract);

export function register(server: McpServer, state: State) {
  server.registerTool(
    "update-record",
    config("update-record"),
    async ({ object, record_id, values }) => {
      if (object !== "deals") return notImplemented(`updating ${object}`);
      const deal = state.deals.find((item) => item.id === record_id);
      if (!deal)
        return text(`The record with ID "${record_id}" was not found.`, true);
      if (deal.id === state.failUpdate)
        return text("The CRM rejected the update.", true);
      deal.stage = String((values as Record<string, unknown>).stage); // the captured schema types `values` as any object;
      return answer("update-record", { record_id: deal.id }); // encoded as answers.ts declares: TOON
    },
  );
  // ...one registerTool per tool in the manifest
}
// #endregion docs:improve/fakes/handlers

/** The read tools the docs leave out, in the order tools.ts captured them. */
export function registerReads(server: McpServer, state: State) {
  const records = (object: string) =>
    object === "deals"
      ? state.deals
      : object === "companies"
        ? state.companies
        : undefined;

  server.registerTool(
    "list-records",
    config("list-records"),
    async ({ object, limit }) => {
      const found = records(object);
      if (!found) return notImplemented(`listing ${object}`);
      return answer("list-records", { records: found.slice(0, limit) });
    },
  );
  server.registerTool(
    "get-records-by-ids",
    config("get-records-by-ids"),
    async ({ object, record_ids }) => {
      const found = records(object);
      if (!found) return notImplemented(`reading ${object}`);
      return answer("get-records-by-ids", {
        records: found.filter((item) => record_ids.includes(item.id)),
      });
    },
  );
}
