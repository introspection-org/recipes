// #region docs:patterns/agent-follow-ups/scheduling-tool
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const env = process.env;
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${env.INTROSPECTION_BASE_API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.INTROSPECTION_TOKEN}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`follow-up refused (${res.status}): ${await res.text()}`);
  return res.status === 204 ? null : res.json();
};
const timezone = JSON.parse(env.INTROSPECTION_TASK_METADATA_JSON ?? "{}").timezone;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "follow_up",
    label: "Follow up",
    description: "Schedule a turn in this conversation: cron (repeating, user's zone) or at (ISO time, once). Pass id to move a one-off.",
    parameters: Type.Object({
      id: Type.Optional(Type.String()),
      title: Type.String(),
      prompt: Type.String({ description: "Self-contained: it arrives as a new message." }),
      cron: Type.Optional(Type.String()),
      at: Type.Optional(Type.String()),
    }),
    async execute(_callId, p) {
      const saved = p.id
        ? await api("PATCH", `/v1/automations/${p.id}`, { next_trigger_at: p.at, prompt: p.prompt })
        : await api("POST", "/v1/automations", {
            name: p.title, prompt: p.prompt,
            task_id: env.INTROSPECTION_TASK_ID, runtime_group_id: env.INTROSPECTION_RUNTIME_GROUP_ID,
            ...(p.cron
              ? { trigger_type: "cron", cron_schedule: p.cron, metadata: { cron_schedules: [p.cron], timezone } }
              : { trigger_type: "manual", next_trigger_at: p.at }),
          });
      return { content: [{ type: "text", text: `${saved.id} next ${saved.next_trigger_at}` }], details: {} };
    },
  });
}
// #endregion docs:patterns/agent-follow-ups/scheduling-tool
