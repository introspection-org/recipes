import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { createServer } from "@emulators/core";
import {
  type GoogleSeedConfig,
  googlePlugin,
  seedFromConfig,
} from "@emulators/google";

import type { GoogleEndpoints } from "../src/index.js";

/** The bearer the package sends behind the egress; the emulator accepts it as the person's token. */
const PLACEHOLDER_TOKEN = "introspection-egress";
export const PERSON = "person@example.com";

/** The env the egress-native placeholder path reads (`packages/channels/slack/src/client.ts`). */
export const EGRESS_ENV = { INTROSPECTION_TASK_ID: "task-1" };

export interface RunningEmulator {
  url: string;
  endpoints: GoogleEndpoints;
  close(): Promise<void>;
}

/**
 * Vercel Labs' Google emulator (`@emulators/google`), a stateful in-memory
 * Gmail, Calendar and Drive, served on an ephemeral local port through
 * `node:http` so the REST clients reach it over real HTTP.
 */
export async function startGoogleEmulator(
  seed: GoogleSeedConfig,
): Promise<RunningEmulator> {
  const { app, store } = createServer(googlePlugin, {
    tokens: { [PLACEHOLDER_TOKEN]: { login: PERSON, id: 1 } },
  });
  googlePlugin.seed?.(store, "http://localhost");
  seedFromConfig(store, "http://localhost", seed);

  const server: Server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(name, value);
      else if (Array.isArray(value))
        for (const item of value) headers.append(name, item);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const response = await app.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers,
        body:
          body && req.method !== "GET" && req.method !== "HEAD"
            ? body
            : undefined,
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    endpoints: {
      gmail: `${url}/gmail/v1`,
      calendar: `${url}/calendar/v3`,
      drive: `${url}/drive/v3`,
      driveUpload: `${url}/upload/drive/v3`,
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
