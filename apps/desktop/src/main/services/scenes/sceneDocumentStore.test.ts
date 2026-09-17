import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import { ingestSceneSnapshot } from "./sceneSnapshotIngest";

import { SCENE_CONTENT_SECURITY_POLICY } from "../../../shared/chatScene";
import { createSceneDocumentStore, parseSceneRequestId } from "./sceneDocumentStore";
import { clampSceneCaptureRect, decodeScenePngDataUrl } from "./sceneSnapshot";

describe("scene document store", () => {
  it("serves a prepared document with the scene policy headers", () => {
    const store = createSceneDocumentStore();
    const prepared = store.put("<!doctype html><p>hello</p>");

    expect(prepared.url).toBe(`ade-scene://view/${prepared.id}`);

    const response = store.respond(prepared.url);
    expect(response.status).toBe(200);
    expect(response.body).toBe("<!doctype html><p>hello</p>");
    expect(response.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(response.headers["Content-Security-Policy"]).toBe(SCENE_CONTENT_SECURITY_POLICY);
    expect(response.headers["Referrer-Policy"]).toBe("no-referrer");
  });

  it("404s an unknown id, a foreign scheme, and a URL with no id", () => {
    const store = createSceneDocumentStore();
    store.put("<p>known</p>");

    for (const url of [
      "ade-scene://view/does-not-exist",
      "ade-artifact://view/anything",
      "ade-scene://view/",
      "ade-scene://other/abc",
      "ade-scene://view/a/b",
      "not a url",
    ]) {
      const response = store.respond(url);
      expect(response.status, url).toBe(404);
      expect(response.headers["Content-Security-Policy"], url).toBeUndefined();
    }
  });

  it("never serves anything it was not handed — there is no path to read", () => {
    const store = createSceneDocumentStore();
    expect(store.respond("ade-scene://view/../../etc/passwd").status).toBe(404);
    expect(store.respond("ade-scene:///etc/passwd").status).toBe(404);
  });

  it("evicts the oldest document once the cap is reached", () => {
    let counter = 0;
    const store = createSceneDocumentStore({ capacity: 3, makeId: () => `id-${counter++}` });

    const first = store.put("<p>1</p>");
    const second = store.put("<p>2</p>");
    store.put("<p>3</p>");
    expect(store.size()).toBe(3);
    expect(store.respond(first.url).status).toBe(200);

    const fourth = store.put("<p>4</p>");
    expect(store.size()).toBe(3);
    expect(store.respond(first.url).status).toBe(404);
    expect(store.respond(second.url).status).toBe(200);
    expect(store.respond(fourth.url).status).toBe(200);
  });

  it("accepts both the authority and rooted URL spellings", () => {
    expect(parseSceneRequestId("ade-scene://view/abc123")).toBe("abc123");
    expect(parseSceneRequestId("ade-scene:///view/abc123")).toBe("abc123");
    expect(parseSceneRequestId("ade-scene://view/abc%2Fdef")).toBe("abc/def");
    expect(parseSceneRequestId("https://view/abc123")).toBeNull();
  });
});

/* --- The snapshot half: what a freeze may capture, and what may be decoded. --- */

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("clampSceneCaptureRect", () => {
  const content = { width: 1200, height: 800 };

  it("keeps a rect that already fits", () => {
    expect(clampSceneCaptureRect({ x: 10, y: 20, width: 300, height: 200 }, content))
      .toEqual({ x: 10, y: 20, width: 300, height: 200 });
  });

  it("clamps an overhanging or negative rect into the content box", () => {
    expect(clampSceneCaptureRect({ x: -40, y: -10, width: 5000, height: 5000 }, content))
      .toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(clampSceneCaptureRect({ x: 1100, y: 700, width: 400, height: 400 }, content))
      .toEqual({ x: 1100, y: 700, width: 100, height: 100 });
  });

  /**
   * The regression this exists for: shifting a negative origin while keeping
   * the size captured a rect the same size as the scene, in a place the scene
   * was not — a scrolled-off scene froze as a picture of the top of the window.
   */
  it("intersects a scrolled-off rect instead of sliding it into view", () => {
    expect(clampSceneCaptureRect({ x: 0, y: -300, width: 400, height: 400 }, content))
      .toEqual({ x: 0, y: 0, width: 400, height: 100 });
    expect(clampSceneCaptureRect({ x: -50, y: 10, width: 200, height: 50 }, content))
      .toEqual({ x: 0, y: 10, width: 150, height: 50 });
  });

  it("returns null for a rect entirely off the content box", () => {
    expect(clampSceneCaptureRect({ x: 0, y: -300, width: 400, height: 200 }, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 1300, y: 0, width: 400, height: 200 }, content)).toBeNull();
  });

  it("returns null when nothing capturable is left", () => {
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: 0, height: 10 }, content)).toBeNull();
    expect(clampSceneCaptureRect(null, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: Number.NaN, height: 10 }, content)).toBeNull();
    expect(clampSceneCaptureRect({ x: 0, y: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("decodeScenePngDataUrl", () => {
  it("decodes a PNG data URL", () => {
    const dataUrl = `data:image/png;base64,${PNG_HEADER.toString("base64")}`;
    expect(decodeScenePngDataUrl(dataUrl)?.equals(PNG_HEADER)).toBe(true);
  });

  it("rejects a non-PNG, a foreign mime type, and an empty payload", () => {
    expect(decodeScenePngDataUrl(`data:image/png;base64,${Buffer.from("not a png").toString("base64")}`)).toBeNull();
    expect(decodeScenePngDataUrl(`data:image/jpeg;base64,${PNG_HEADER.toString("base64")}`)).toBeNull();
    expect(decodeScenePngDataUrl("data:image/png;base64,")).toBeNull();
    expect(decodeScenePngDataUrl(null)).toBeNull();
    expect(decodeScenePngDataUrl(undefined)).toBeNull();
  });
});

/* --- Filing a scene snapshot into the artifact store (sceneSnapshotIngest.ts). --- */

/**
 * The one narrow ingest an agent-adjacent caller can reach, so the jail around
 * it is the contract. Every case here is about a path that must NOT be filed:
 * the store is the only place a snapshot may come from, and `resolve` is string
 * arithmetic that a symlink planted inside the store walks straight out of.
 */
describe("ingesting a scene snapshot", () => {
  type Ingested = Parameters<Parameters<typeof ingestSceneSnapshot>[0]["broker"]["ingest"]>[0];

  function createFixture() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-ingest-"));
    const artifactsRoot = path.join(resolveAdeLayout(projectRoot).artifactsDir, "computer-use");
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const filed: Ingested[] = [];
    const broker = { ingest: (payload: Ingested) => { filed.push(payload); } };
    return { projectRoot, artifactsRoot, filed, broker: broker as never };
  }

  function writePng(dir: string, name: string): string {
    const target = path.join(dir, name);
    fs.writeFileSync(target, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return target;
  }

  afterEach(() => { vi.restoreAllMocks(); });

  it("files a snapshot that is already inside the project's artifact store", async () => {
    const { projectRoot, artifactsRoot, filed, broker } = createFixture();
    const shot = writePng(artifactsRoot, "scene-1.png");

    const result = await ingestSceneSnapshot({
      projectRoot,
      broker,
      agentChatService: null,
      args: { path: shot, title: "  Lane throughput  " },
    });

    expect(result).toEqual({ filed: true, ownerSessionId: null, artifactId: null });
    expect(filed).toHaveLength(1);
    expect(filed[0]?.inputs[0]).toMatchObject({
      kind: "screenshot",
      title: "Lane throughput",
      mimeType: "image/png",
    });
    // No claimed session, so nothing may be attributed to one.
    expect(filed[0]?.owners).toBeUndefined();
  });

  /**
   * The lexical half, and it must answer the same way whether or not the file
   * exists — otherwise the refusal itself is a probe for files elsewhere.
   */
  it("refuses a path outside the store without looking at the filesystem", async () => {
    const { projectRoot, broker } = createFixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-outside-"));
    const real = writePng(elsewhere, "secret.png");
    const statSpy = vi.spyOn(fs, "statSync");

    for (const candidate of [real, path.join(elsewhere, "does-not-exist.png")]) {
      await expect(ingestSceneSnapshot({
        projectRoot,
        broker,
        agentChatService: null,
        args: { path: candidate },
      })).rejects.toThrow(/artifact store/);
    }
    expect(statSpy).not.toHaveBeenCalled();

    await expect(ingestSceneSnapshot({
      projectRoot,
      broker,
      agentChatService: null,
      args: { path: "   " },
    })).rejects.toThrow(/path is required/);
  });

  /**
   * The regression the real-path check exists for: a link planted under the
   * store passes string-only containment, and the ingest below it follows the
   * link — so the jail and the read disagreed about which file they meant.
   */
  it("refuses a symlink inside the store that points out of it", async () => {
    const { projectRoot, artifactsRoot, filed, broker } = createFixture();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-link-"));
    const secret = writePng(elsewhere, "secret.png");
    const link = path.join(artifactsRoot, "looks-local.png");
    fs.symlinkSync(secret, link);

    await expect(ingestSceneSnapshot({
      projectRoot,
      broker,
      agentChatService: null,
      args: { path: link },
    })).rejects.toThrow(/artifact store/);
    expect(filed).toHaveLength(0);
  });

  it("refuses a missing file and an empty one with the same answer", async () => {
    const { projectRoot, artifactsRoot, broker } = createFixture();
    const empty = path.join(artifactsRoot, "empty.png");
    fs.writeFileSync(empty, "");

    for (const candidate of [path.join(artifactsRoot, "gone.png"), empty]) {
      await expect(ingestSceneSnapshot({
        projectRoot,
        broker,
        agentChatService: null,
        args: { path: candidate },
      })).rejects.toThrow(/snapshot is missing/);
    }
  });

  /**
   * Proof is chat-scoped, and a claimed session is a claim: an id this project
   * cannot resolve drops the OWNER rather than the artifact, because an
   * unattributed snapshot is a smaller loss than a misattributed one.
   */
  it("keeps a resolvable owner and drops one this project cannot resolve", async () => {
    const { projectRoot, artifactsRoot, filed, broker } = createFixture();
    const shot = writePng(artifactsRoot, "scene-2.png");
    const agentChatService = {
      getSessionSummary: async (id: string) => (id === "chat-known" ? { id } : null),
    } as never;

    const known = await ingestSceneSnapshot({
      projectRoot, broker, agentChatService, args: { path: shot, sessionId: "chat-known" },
    });
    expect(known.ownerSessionId).toBe("chat-known");
    expect(filed.at(-1)?.owners).toEqual([{ kind: "chat_session", id: "chat-known" }]);

    const stranger = await ingestSceneSnapshot({
      projectRoot, broker, agentChatService, args: { path: shot, sessionId: "chat-elsewhere" },
    });
    expect(stranger).toEqual({ filed: true, ownerSessionId: null, artifactId: null });
    expect(filed.at(-1)?.owners).toBeUndefined();
  });
});
