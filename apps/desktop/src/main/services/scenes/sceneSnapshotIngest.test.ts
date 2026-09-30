import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveAdeLayout } from "../../../shared/adeLayout";
import { resolveSceneStillOwner, SceneStillScopeKeyError } from "./sceneStills";
import { ingestSceneSnapshot } from "./sceneSnapshotIngest";

/**
 * The one narrow ingest an agent-adjacent caller can reach, so the jail around
 * it is the contract. Most of what follows is about a path that must NOT be
 * filed: the store is the only place a snapshot may come from, and `resolve` is
 * string arithmetic that a symlink planted inside the store walks straight out
 * of. The rest is ownership, which decides whose drawer the picture lands in.
 */

describe("ingesting a scene snapshot", () => {
  type Ingested = Parameters<Parameters<typeof ingestSceneSnapshot>[0]["broker"]["ingest"]>[0];

  /**
   * A broker with all three methods a filing can reach.
   *
   * `ingest` alone was not enough and the gap was invisible: an OWNED still is
   * a pruned still — both disk bounds are scoped to the owner — so the moment a
   * case resolved an owner it also ran `listArtifacts` and `deleteArtifacts`.
   * Suites papered over that with a second inline broker, which meant the
   * fixture no longer described what the code under test calls.
   */
  function createFixture() {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-scene-ingest-"));
    const artifactsRoot = path.join(resolveAdeLayout(projectRoot).artifactsDir, "computer-use");
    fs.mkdirSync(artifactsRoot, { recursive: true });
    const filed: Ingested[] = [];
    const broker = {
      ingest: (payload: Ingested) => { filed.push(payload); },
      listArtifacts: () => [],
      deleteArtifacts: () => ({ deleted: [], missing: [], failed: [], freedBytes: 0 }),
    } as unknown as Parameters<typeof ingestSceneSnapshot>[0]["broker"];
    return { projectRoot, artifactsRoot, filed, broker };
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

  /**
   * The PRESENCE of a scope key is what tells a still from the Proof button on
   * this side, so a blank one is not an anonymous still — it is a still about
   * to be filed as evidence. The desktop refuses the same call before it
   * writes any bytes; this is the other half of that agreement.
   */
  it("refuses a still whose scope key is blank rather than filing it as proof", async () => {
    const { projectRoot, artifactsRoot, filed, broker } = createFixture();
    const shot = writePng(artifactsRoot, "scene-blank.png");

    // Typed, because the desktop handler catches exactly this one and answers
    // null rather than logging a failure — see `requireSceneStillScopeKey`.
    await expect(ingestSceneSnapshot({
      projectRoot,
      broker,
      agentChatService: null,
      args: { path: shot, sceneScopeKey: "   " },
    })).rejects.toThrow(SceneStillScopeKeyError);
    expect(filed).toHaveLength(0);
  });
});

/**
 * The owner both filing sides resolve through, so the desktop handler and the
 * runtime action cannot disagree about whose drawer a picture lands in.
 */
describe("resolveSceneStillOwner", () => {
  const agentChatService = {
    getSessionSummary: async (id: string) => (id === "chat-known" ? { id } : null),
  };

  it("believes a claim this project can resolve, and drops one it cannot", async () => {
    await expect(resolveSceneStillOwner({
      agentChatService,
      claimedSessionId: "  chat-known  ",
    })).resolves.toBe("chat-known");

    await expect(resolveSceneStillOwner({
      agentChatService,
      claimedSessionId: "chat-elsewhere",
    })).resolves.toBeNull();
  });

  /** A runtime with no chat service can check nothing, so it believes nothing. */
  it("drops a claim it has no way to check", async () => {
    await expect(resolveSceneStillOwner({
      agentChatService: null,
      claimedSessionId: "chat-known",
    })).resolves.toBeNull();
  });

  /** A chat service that throws must not fail the filing. */
  it("drops a claim the lookup threw on", async () => {
    await expect(resolveSceneStillOwner({
      agentChatService: { getSessionSummary: async () => { throw new Error("db is locked"); } },
      claimedSessionId: "chat-known",
    })).resolves.toBeNull();
  });
});
