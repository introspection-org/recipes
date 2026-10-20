// #region docs:patterns/memory-and-data/load-memory
import { readFile } from "node:fs/promises";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

const FILES = ["/workspace/memories/preferences.md"];
const extension: ExtensionFactory = (pi) => {
  pi.on("before_agent_start", async (event) => {
    const parts = await Promise.all(FILES.map((f) => readFile(f, "utf8").catch(() => "")));
    return { systemPrompt: `${event.systemPrompt}\n\n<memory>\n${parts.join("\n")}\n</memory>` };
  });
};
export default extension;
// #endregion docs:patterns/memory-and-data/load-memory
