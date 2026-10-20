// #region docs:patterns/structured-output/submit-tool
import { type ExtensionFactory, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export const Triage = Type.Object({
  category: Type.Union([Type.Literal("billing"), Type.Literal("bug"), Type.Literal("other")]),
  priority: Type.Integer({ minimum: 1, maximum: 4 }),
  summary: Type.String({ maxLength: 280 }),
});

const submitResult = defineTool({
  name: "submit_result",
  label: "Submit result",
  description: "Submit the final triage. Call exactly once, as your last action.",
  parameters: Triage,
  execute: async () => ({ content: [{ type: "text" as const, text: "Saved." }], details: {} }),
});

const extension: ExtensionFactory = (pi) => pi.registerTool(submitResult);
export default extension;
// #endregion docs:patterns/structured-output/submit-tool
