// #region docs:build/tools/lifecycle-hook
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const extension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", async (event) => ({
    systemPrompt: `${event.systemPrompt}\n\nToday is ${new Date().toDateString()}.`,
  }));
};
export default extension;
// #endregion docs:build/tools/lifecycle-hook
