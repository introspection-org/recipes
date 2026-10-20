// #region docs:patterns/ask-the-user/ask-tools
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { askUserApproval, askUserQuestion } from "@introspection-ai/recipes/interactions";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ask_user_question",
    label: "Ask user",
    description: "Ask the user a clarifying question and wait for the answer.",
    parameters: Type.Object({ question: Type.String(), options: Type.Optional(Type.Array(Type.String())) }),
    executionMode: "sequential",
    async execute(toolCallId, p, signal, _onUpdate, ctx) {
      return await askUserQuestion({ question: p.question, options: p.options }, { toolCallId, ctx, signal });
    },
  });
  pi.registerTool({
    name: "request_approval",
    label: "Request approval",
    description: "Ask the user to approve an action before taking it.",
    parameters: Type.Object({ title: Type.String(), body: Type.String() }),
    executionMode: "sequential",
    async execute(toolCallId, p, signal, _onUpdate, ctx) {
      return await askUserApproval({ title: p.title, body: p.body }, { toolCallId, ctx, signal });
    },
  });
}
// #endregion docs:patterns/ask-the-user/ask-tools
