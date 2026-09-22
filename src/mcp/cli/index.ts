#!/usr/bin/env node
import { stderr, stdout } from "node:process";

import { isDirectEntry } from "../../direct-cli.js";
import { main } from "./core.js";

export * from "./core.js";

if (isDirectEntry(import.meta.url)) {
  let brokenPipe = false;
  const handleOutputError = (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") {
      // A downstream command such as `head` intentionally closed the pipe.
      // Treat that as normal Unix pipeline completion and avoid leaking a Node
      // stack trace after the MCP operation has already produced its result.
      brokenPipe = true;
      return;
    }
    throw error;
  };

  stdout.on("error", handleOutputError);
  stderr.on("error", handleOutputError);
  main()
    .then((code) => {
      process.exitCode = brokenPipe ? 0 : code;
    })
    .catch((error: unknown) => {
      if (brokenPipe) {
        process.exitCode = 0;
        return;
      }
      stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
