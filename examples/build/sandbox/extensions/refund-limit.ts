// #region docs:build/sandbox/block-tool-call
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const extension: ExtensionFactory = (pi) => {
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "issue_refund") return;
    const limit = Number(process.env.REFUND_LIMIT);
    const amount = Number((event.input as { amount?: unknown }).amount);
    if (!Number.isFinite(limit) || !(amount <= limit)) {
      return {
        block: true,
        reason: `Refunds over ${process.env.REFUND_LIMIT ?? "the limit"} need approval. Call save_draft instead.`,
      };
    }
  });
};
export default extension;
// #endregion docs:build/sandbox/block-tool-call
