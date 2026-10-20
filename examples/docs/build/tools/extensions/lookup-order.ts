// #region docs:build/tools/write-tool
import { type ExtensionFactory, defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const lookupOrder = defineTool({
  name: "lookup_order",
  label: "Look up order",
  description: "Read one order record by id.",
  parameters: Type.Object({ orderId: Type.String() }),
  execute: async (_id, params) => {
    const res = await fetch(`https://orders.example.com/v1/orders/${params.orderId}`);
    return {
      content: [{ type: "text" as const, text: await res.text() }],
      details: { orderId: params.orderId },
    };
  },
});

const extension: ExtensionFactory = (pi) => {
  pi.registerTool(lookupOrder);
};
export default extension;
// #endregion docs:build/tools/write-tool
