import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ATTACHMENT_UPLOAD_PATH,
  createAttachmentUploadRegistry,
  type AttachmentUploadRegistry,
} from "./attachmentUploadService";

const FALLTHROUGH_BODY = "fell-through";

describe("attachmentUploadService", () => {
  let tempRoot: string;
  let server: http.Server;
  let baseUrl: string;
  let registry: AttachmentUploadRegistry;
  let nowMs: number;

  const attachmentsDir = () => path.join(tempRoot, ".ade", "attachments");

  const listedAttachments = (): string[] => {
    try {
      return fs.readdirSync(attachmentsDir()).sort();
    } catch {
      return [];
    }
  };

  const startServer = async (target: AttachmentUploadRegistry): Promise<void> => {
    server = http.createServer((request, response) => {
      if (target.handleRequest(request, response)) return;
      // Stands in for the real 426 loopback-probe fall-through.
      response.writeHead(426, { "content-type": "text/plain" });
      response.end(FALLTHROUGH_BODY);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (typeof address !== "object" || !address) throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${address.port}`;
  };

  beforeEach(async () => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-upload-"));
    nowMs = 1_700_000_000_000;
    registry = createAttachmentUploadRegistry({ now: () => nowMs, maxBytes: 1024 });
    await startServer(registry);
  });

  afterEach(async () => {
    registry.dispose();
    await new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const upload = async (
    ticket: string | null,
    body: BodyInit,
    init: RequestInit = {},
  ): Promise<Response> =>
    await fetch(`${baseUrl}${ATTACHMENT_UPLOAD_PATH}`, {
      method: "POST",
      ...init,
      headers: {
        ...(ticket ? { authorization: `Bearer ${ticket}` } : {}),
        ...(init.headers ?? {}),
      },
      body,
    });

  it("stores a posted body under the project attachments dir and returns its path", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "diagram.PNG" });
    expect(issued.path).toBe(ATTACHMENT_UPLOAD_PATH);
    expect(issued.maxBytes).toBe(1024);
    expect(issued.expiresAtMs).toBeGreaterThan(nowMs);

    const content = Buffer.from("attachment-bytes-\u0000\u00ff", "binary");
    const response = await upload(issued.ticket, content);
    expect(response.status).toBe(200);
    const result = (await response.json()) as { path: string };

    expect(path.dirname(result.path)).toBe(path.resolve(attachmentsDir()));
    expect(path.extname(result.path)).toBe(".png");
    expect(fs.readFileSync(result.path)).toEqual(content);
    expect(listedAttachments()).toHaveLength(1);
    expect(registry.pendingCount()).toBe(0);
  });

  it("falls through for any other pathname", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "GET" });
    expect(response.status).toBe(426);
    expect(await response.text()).toBe(FALLTHROUGH_BODY);
  });

  it("handles the upload path even with a query string appended", async () => {
    const response = await fetch(`${baseUrl}${ATTACHMENT_UPLOAD_PATH}?ticket=nope`, { method: "GET" });
    // Handled by the registry (405), not the 426 fall-through.
    expect(response.status).toBe(405);
  });

  it("rejects a request with no Authorization header", async () => {
    registry.issue({ projectRoot: tempRoot, filename: "a.png" });
    const response = await upload(null, "hello");
    expect(response.status).toBe(401);
    expect(listedAttachments()).toEqual([]);
  });

  it("rejects an unknown ticket", async () => {
    registry.issue({ projectRoot: tempRoot, filename: "a.png" });
    const response = await upload("not-a-real-ticket", "hello");
    expect(response.status).toBe(401);
    expect(listedAttachments()).toEqual([]);
  });

  it("rejects an expired ticket", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "a.png" });
    nowMs = issued.expiresAtMs + 1;
    const response = await upload(issued.ticket, "hello");
    expect(response.status).toBe(401);
    expect(listedAttachments()).toEqual([]);
  });

  it("consumes a ticket on first use so a replay is rejected", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "a.txt" });
    const first = await upload(issued.ticket, "hello");
    expect(first.status).toBe(200);
    const replay = await upload(issued.ticket, "hello again");
    expect(replay.status).toBe(401);
    expect(listedAttachments()).toHaveLength(1);
  });

  it("rejects a non-POST method", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "a.png" });
    const response = await fetch(`${baseUrl}${ATTACHMENT_UPLOAD_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${issued.ticket}` },
    });
    expect(response.status).toBe(405);
    expect(listedAttachments()).toEqual([]);
  });

  it("rejects a declared Content-Length over the cap before reading the body", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "a.bin" });
    const response = await upload(issued.ticket, Buffer.alloc(2048, 7));
    expect(response.status).toBe(413);
    expect(listedAttachments()).toEqual([]);
  });

  it("caps a chunked body that declares no Content-Length and leaves no .part file", async () => {
    const issued = registry.issue({ projectRoot: tempRoot, filename: "a.bin" });
    const status = await new Promise<number | null>((resolve) => {
      let observed: number | null = null;
      const request = http.request(
        `${baseUrl}${ATTACHMENT_UPLOAD_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${issued.ticket}`,
            "transfer-encoding": "chunked",
          },
        },
        (response) => {
          observed = response.statusCode ?? null;
          response.resume();
          response.on("end", () => resolve(observed));
          response.on("close", () => resolve(observed));
        },
      );
      // The server answers and drops the socket while we are still writing, so
      // a write-side EPIPE/ECONNRESET is expected — it must not mask a missing
      // response, hence `observed` is the only thing we resolve with.
      request.on("error", () => resolve(observed));
      const chunk = Buffer.alloc(512, 3);
      for (let index = 0; index < 8; index += 1) request.write(chunk);
      request.end();
    });
    // Not `.catch(() => 413)`: a transport failure must fail the test, not pass it.
    expect(status).toBe(413);
    // The response is only written after the `.part` cleanup, so by the time
    // the client sees 413 the attachments dir must hold nothing at all — no
    // final file and no leftover partial.
    expect(listedAttachments()).toEqual([]);
  });

  it("never lets a traversal-shaped filename escape the attachments dir", async () => {
    for (const filename of ["../../../../etc/passwd", "x.png/../../evil.sh", "..\\..\\evil.bat"]) {
      const issued = registry.issue({ projectRoot: tempRoot, filename });
      const response = await upload(issued.ticket, "payload");
      expect(response.status).toBe(200);
      const result = (await response.json()) as { path: string };
      expect(path.dirname(result.path)).toBe(path.resolve(attachmentsDir()));
      // Basename is a fresh UUID plus at most a sanitized extension.
      expect(path.basename(result.path, path.extname(result.path))).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(fs.existsSync(result.path)).toBe(true);
    }
    expect(fs.existsSync(path.join(tempRoot, ".ade", "evil.sh"))).toBe(false);
  });

  it("refuses to issue a ticket without a project root", () => {
    expect(() => registry.issue({ projectRoot: "   ", filename: "a.png" })).toThrow(
      /project root/i,
    );
  });

  it("prunes expired tickets instead of leaking them", () => {
    const first = registry.issue({ projectRoot: tempRoot, filename: "a.png" });
    expect(registry.pendingCount()).toBe(1);
    nowMs = first.expiresAtMs + 1;
    registry.issue({ projectRoot: tempRoot, filename: "b.png" });
    expect(registry.pendingCount()).toBe(1);
  });
});
