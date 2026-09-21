import { createServer, type IncomingMessage, type Server } from "node:http";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CliProxyApiManagementClient,
  type CliProxyApiAuthFile,
} from "./cliProxyApiManagement";

type RecordedRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  body: unknown;
};

let server: Server;
let port: number;
const requests: RecordedRequest[] = [];

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function sendJson(response: { statusCode: number; setHeader(name: string, value: string): void; end(body: string): void }, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

beforeEach(async () => {
  requests.length = 0;
  server = createServer(async (request, response) => {
    const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    const rawBody = await readBody(request);
    let body: unknown = undefined;
    if (rawBody.length > 0) body = JSON.parse(rawBody) as unknown;
    requests.push({
      method: request.method ?? "",
      path: `${requestUrl.pathname}${requestUrl.search}`,
      authorization: request.headers.authorization,
      body,
    });

    if (request.headers.authorization !== "Bearer management-test-key") {
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }

    const route = `${request.method ?? ""} ${requestUrl.pathname}`;
    if (route === "GET /v0/management/auth-files") {
      const file: CliProxyApiAuthFile = {
        id: "claude-user",
        auth_index: "auth-1",
        provider: "claude",
        email: "user@example.test",
        disabled: false,
        quota: { signals: { remaining: "0.75" } },
        cooldowns: { sonnet: null },
        id_token: { chatgpt_plan_type: "plus" },
      };
      sendJson(response, 200, { files: [file] });
      return;
    }
    if (route === "GET /v0/management/anthropic-auth-url") {
      sendJson(response, 200, { status: "ok", url: "https://login.example.test/claude", state: "claude-state" });
      return;
    }
    if (route === "GET /v0/management/codex-auth-url") {
      sendJson(response, 200, { status: "ok", url: "https://login.example.test/codex", state: "codex-state" });
      return;
    }
    if (route === "GET /v0/management/get-auth-status") {
      sendJson(response, 200, { status: requestUrl.searchParams.get("state") === "complete" ? "ok" : "wait" });
      return;
    }
    if (route === "DELETE /v0/management/auth-files") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (route === "PATCH /v0/management/auth-files/fields") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (route === "PATCH /v0/management/auth-files/status") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (route === "POST /v0/management/reset-quota") {
      sendJson(response, 200, { status: "ok", auth_index: "auth-1" });
      return;
    }
    if (route === "POST /v0/management/quota/fetch") {
      sendJson(response, 200, { groups: [{ name: "codex", buckets: [] }] });
      return;
    }
    if (route === "POST /v0/management/api-call") {
      sendJson(response, 200, {
        status_code: 204,
        header: { "x-test": ["ok"] },
        body: "",
      });
      return;
    }
    sendJson(response, 404, { error: "not found" });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("fake server did not bind");
      port = address.port;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

describe("CLIProxyAPI management client", () => {
  it("calls the management API with the bearer key and typed payloads", async () => {
    const client = new CliProxyApiManagementClient({
      port,
      managementKey: "management-test-key",
    });

    const files = await client.listAuthFiles();
    expect(files[0]?.auth_index).toBe("auth-1");
    expect(files[0]?.quota?.signals?.remaining).toBe("0.75");
    expect(files[0]?.id_token?.chatgpt_plan_type).toBe("plus");
    expect((files[0]?.cooldowns as { sonnet: null }).sonnet).toBeNull();
    expect(await client.getAuthUrl("claude")).toMatchObject({ state: "claude-state" });
    expect(await client.getAuthUrl("codex")).toMatchObject({ state: "codex-state" });
    expect(await client.getAuthStatus("pending state")).toEqual({ status: "wait" });
    expect(await client.deleteAuthFile("account one.json")).toEqual({ status: "ok" });
    expect(await client.patchAuthFileFields({ name: "account.json", prefix: "team" })).toEqual({ status: "ok" });
    expect(await client.setAuthFileStatus({ name: "account.json", disabled: true })).toEqual({ status: "ok" });
    expect(await client.resetQuota("auth-1")).toMatchObject({ status: "ok", auth_index: "auth-1" });
    expect(await client.quotaFetch("auth-1")).toMatchObject({ groups: [{ name: "codex" }] });
    expect(await client.apiCall({
      authIndex: "auth-1",
      method: "get",
      url: "https://upstream.example.test/ping",
      header: { Accept: "application/json" },
      data: "{}",
    })).toEqual({ status_code: 204, header: { "x-test": ["ok"] }, body: "" });

    expect(requests.every((request) => request.authorization === "Bearer management-test-key")).toBe(true);
    expect(requests.find((request) => request.method === "DELETE")?.path)
      .toBe("/v0/management/auth-files?name=account%20one.json");
    expect(requests.find((request) => request.path === "/v0/management/auth-files/fields")?.body)
      .toEqual({ name: "account.json", prefix: "team" });
    expect(requests.find((request) => request.path === "/v0/management/quota/fetch")?.body)
      .toEqual({ auth_index: "auth-1" });
    expect(requests.find((request) => request.path === "/v0/management/api-call")?.body)
      .toEqual({
        auth_index: "auth-1",
        method: "GET",
        url: "https://upstream.example.test/ping",
        header: { Accept: "application/json" },
        data: "{}",
      });
  });
});
