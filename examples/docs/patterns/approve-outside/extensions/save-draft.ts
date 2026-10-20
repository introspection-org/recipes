// #region docs:patterns/approve-outside/draft-tool
import { type ExtensionFactory, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const saveDraft = defineTool({
  name: "save_draft",
  label: "Save draft",
  description: "Save an email for a person to send or discard. You cannot send it.",
  parameters: Type.Object({ id: Type.String(), to: Type.Array(Type.String()), subject: Type.String(), body: Type.String() }),
  execute: async (_id, p) => ({ content: [{ type: "text" as const, text: `Draft ${p.id} saved for review.` }], details: {} }),
});
const extension: ExtensionFactory = (pi) => pi.registerTool(saveDraft);
export default extension;
// #endregion docs:patterns/approve-outside/draft-tool
