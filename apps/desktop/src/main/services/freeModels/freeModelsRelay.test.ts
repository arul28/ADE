import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createFreeModelsRelay, type FreeModelsRelay } from "./freeModelsRelay";

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders; body: string };

/** A stand-in account server: records each request and answers with `respond`. */
async function startUpstream(
  respond: (req: http.IncomingMessage, res: http.ServerResponse, seen: Seen) => void,
): Promise<{ baseUrl: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const entry = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      seen.push(entry);
      respond(req, res, entry);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function relayFor(baseUrl: string, tokens: { calls: Array<{ forceRefresh?: boolean } | undefined>; next: () => string | null }): FreeModelsRelay {
  const relay = createFreeModelsRelay({
    baseUrl: () => baseUrl,
    accessToken: async (options) => {
      tokens.calls.push(options);
      return tokens.next();
    },
    signedIn: () => true,
  });
  cleanups.push(() => relay.close());
  return relay;
}

const completion = (baseURL: string, apiKey: string, body = { model: "glm-5.3-flash", stream: true }) => fetch(`${baseURL}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("freeModelsRelay", () => {
  it.each([
    ["a wrong key", (own: string) => `${own}x`],
    ["no key", () => ""],
  ])("refuses %s on a chat's path and never calls the account server", async (_label, keyFor) => {
    const upstream = await startUpstream((_req, res) => res.end("{}"));
    cleanups.push(upstream.close);
    const tokens = { calls: [] as Array<{ forceRefresh?: boolean } | undefined>, next: () => "account-token" };
    const relay = relayFor(upstream.baseUrl, tokens);
    const chat = await relay.register("chat-a");

    const response = await completion(chat.baseURL, keyFor(chat.apiKey));

    expect(response.status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
    expect(tokens.calls).toHaveLength(0);
  });

  it("refuses chat A's key on chat B's path", async () => {
    const upstream = await startUpstream((_req, res) => res.end("{}"));
    cleanups.push(upstream.close);
    const relay = relayFor(upstream.baseUrl, { calls: [], next: () => "account-token" });
    const chatA = await relay.register("chat-a");
    const chatB = await relay.register("chat-b");

    const response = await completion(chatB.baseURL, chatA.apiKey);

    expect(response.status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it("refuses a released chat's key", async () => {
    const upstream = await startUpstream((_req, res) => res.end("{}"));
    cleanups.push(upstream.close);
    const relay = relayFor(upstream.baseUrl, { calls: [], next: () => "account-token" });
    // Another chat keeps the server listening on the same port.
    await relay.register("chat-keep");
    const chat = await relay.register("chat-a");
    chat.release();

    const response = await completion(chat.baseURL, chat.apiKey);

    expect(response.status).toBe(401);
    expect(upstream.seen).toHaveLength(0);
  });

  it("refreshes the token once on the account server's 401, and never retries again", async () => {
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "token expired", code: "unauthorized" } }));
    });
    cleanups.push(upstream.close);
    let issued = 0;
    const tokens = { calls: [] as Array<{ forceRefresh?: boolean } | undefined>, next: () => `token-${++issued}` };
    const relay = relayFor(upstream.baseUrl, tokens);
    const chat = await relay.register("chat-a");

    const response = await completion(chat.baseURL, chat.apiKey);

    expect(response.status).toBe(401);
    expect(upstream.seen.map((entry) => entry.headers.authorization)).toEqual(["Bearer token-1", "Bearer token-2"]);
    expect(tokens.calls).toEqual([undefined, { forceRefresh: true }]);
    // The same request both times.
    expect(upstream.seen[0]!.body).toBe(upstream.seen[1]!.body);
  });

  // OpenCode retries 408, 409, 429 and 5xx by itself; Gravity asks for no retries.
  it.each([
    [403, 403],
    [429, 403],
    [503, 403],
  ])("sends a %i refusal once and answers OpenCode %i with the same body", async (upstreamStatus, relayed) => {
    const body = { error: { message: "Open the chat in ADE.", code: "free_models_not_watched" } };
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(upstreamStatus, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    cleanups.push(upstream.close);
    const tokens = { calls: [] as Array<{ forceRefresh?: boolean } | undefined>, next: () => "account-token" };
    const relay = relayFor(upstream.baseUrl, tokens);
    const chat = await relay.register("chat-a");

    const response = await completion(chat.baseURL, chat.apiKey);

    expect(response.status).toBe(relayed);
    expect(await response.json()).toEqual(body);
    expect(upstream.seen).toHaveLength(1);
    expect(tokens.calls).toHaveLength(1);
  });

  it("streams the account server's answer through as it arrives, with the chat named", async () => {
    let sendRest: (() => void) | null = null;
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      // The rest waits until the client has read the first event.
      sendRest = () => {
        res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n');
        res.end("data: [DONE]\n\n");
      };
    });
    cleanups.push(upstream.close);
    const relay = relayFor(upstream.baseUrl, { calls: [], next: () => "account-token" });
    const chat = await relay.register("chat-a");

    const response = await completion(chat.baseURL, chat.apiKey);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const first = decoder.decode((await reader.read()).value);
    expect(first).toBe('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
    sendRest!();
    let rest = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += decoder.decode(value, { stream: true });
    }

    expect(rest).toBe('data: {"choices":[{"delta":{"content":"lo"}}]}\n\ndata: [DONE]\n\n');
    const [request] = upstream.seen;
    expect(request!.method).toBe("POST");
    expect(request!.url).toBe("/cloud/free-models/v1/chat/completions");
    expect(request!.headers.authorization).toBe("Bearer account-token");
    expect(request!.headers["x-ade-chat-id"]).toBe("chat-a");
    expect(JSON.parse(request!.body)).toEqual({ model: "glm-5.3-flash", stream: true });
  });

  it("ends a request in flight when its chat is released", async () => {
    let upstreamClosed: () => void = () => {};
    const closed = new Promise<void>((resolve) => { upstreamClosed = resolve; });
    const upstream = await startUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: {}\n\n");
      res.once("close", () => upstreamClosed());
    });
    cleanups.push(upstream.close);
    const relay = relayFor(upstream.baseUrl, { calls: [], next: () => "account-token" });
    // Another chat keeps the server up, so only the release can end this one.
    await relay.register("chat-keep");
    const chat = await relay.register("chat-a");
    const response = await completion(chat.baseURL, chat.apiKey);
    const reader = response.body!.getReader();
    await reader.read();

    chat.release();

    await closed;
    await expect(reader.read()).rejects.toThrow();
  });
});
