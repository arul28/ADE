import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const home = vi.hoisted(() => ({ dir: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => home.dir }, homedir: () => home.dir };
});

import {
  applyModelManifest,
  BUNDLED_MODEL_MANIFEST,
  getActiveModelManifest,
  getAppDefaultModelDescriptor,
} from "../../../shared/modelRegistry";
import { MODEL_MANIFEST_REMOTE_URL } from "../../../shared/modelManifest";
import {
  initializeModelManifestService,
  refreshModelManifest,
  refreshModelManifestIfStale,
  shutdownModelManifestService,
} from "./modelManifestService";

const NEWER_MANIFEST = {
  ...BUNDLED_MODEL_MANIFEST,
  updatedAt: "2099-01-01T00:00:00Z",
  defaults: { app: [{ model: "openai/gpt-6-sol" }] },
};

function jsonResponse(body: unknown, init?: { status?: number; etag?: string }): Response {
  return new Response(init?.status === 304 ? null : JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: init?.etag ? { etag: init.etag } : {},
  });
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("modelManifestService", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    home.dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-model-manifest-"));
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    shutdownModelManifestService();
    applyModelManifest(BUNDLED_MODEL_MANIFEST);
    vi.unstubAllGlobals();
    fs.rmSync(home.dir, { recursive: true, force: true });
  });

  it("applies a newer remote manifest, caches it, and revalidates with its ETag", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(NEWER_MANIFEST, { etag: "\"v2\"" }));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await settle();
    await refreshModelManifest();

    expect(fetchMock).toHaveBeenCalledWith(MODEL_MANIFEST_REMOTE_URL, expect.anything());
    expect(getAppDefaultModelDescriptor()?.id).toBe("openai/gpt-6-sol");
    const cached = JSON.parse(fs.readFileSync(path.join(home.dir, ".ade", "model-manifest.json"), "utf-8"));
    expect(cached).toMatchObject({ etag: "\"v2\"", manifest: { updatedAt: "2099-01-01T00:00:00Z" } });

    fetchMock.mockResolvedValueOnce(jsonResponse(null, { status: 304 }));
    await refreshModelManifest();
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ headers: { "If-None-Match": "\"v2\"" } });
    expect(getAppDefaultModelDescriptor()?.id).toBe("openai/gpt-6-sol");
  });

  it("starts from the disk cache before the network answers", async () => {
    fs.mkdirSync(path.join(home.dir, ".ade"), { recursive: true });
    fs.writeFileSync(
      path.join(home.dir, ".ade", "model-manifest.json"),
      JSON.stringify({ fetchedAtMs: Date.now(), etag: "\"v2\"", manifest: NEWER_MANIFEST }),
    );
    fetchMock.mockReturnValue(new Promise(() => {}));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await vi.waitFor(() => {
      expect(getActiveModelManifest()?.manifest.updatedAt).toBe("2099-01-01T00:00:00Z");
    });
  });

  it("ignores a remote manifest older than the one this build shipped", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...NEWER_MANIFEST, updatedAt: "2020-01-01T00:00:00Z" }));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await settle();
    await refreshModelManifest();
    expect(getActiveModelManifest()?.manifest.updatedAt).toBe(BUNDLED_MODEL_MANIFEST.updatedAt);
    expect(getAppDefaultModelDescriptor()?.id).toBe("anthropic/claude-opus-5-5");
  });

  it("does not let an older remote copy evict the last good disk cache", async () => {
    const cacheFile = path.join(home.dir, ".ade", "model-manifest.json");
    fs.mkdirSync(path.join(home.dir, ".ade"), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify({ fetchedAtMs: 0, etag: "\"v2\"", manifest: NEWER_MANIFEST }));
    fetchMock.mockResolvedValue(jsonResponse({ ...NEWER_MANIFEST, updatedAt: "2098-01-01T00:00:00Z" }, { etag: "\"old\"" }));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await settle();
    await refreshModelManifest();
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    expect(cached.manifest.updatedAt).toBe("2099-01-01T00:00:00Z");
    expect(getActiveModelManifest()?.manifest.updatedAt).toBe("2099-01-01T00:00:00Z");
  });

  it("does not cache a same-timestamp copy with different content", async () => {
    const cacheFile = path.join(home.dir, ".ade", "model-manifest.json");
    fetchMock.mockResolvedValueOnce(jsonResponse(NEWER_MANIFEST, { etag: "\"v2\"" }));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await settle();
    await refreshModelManifest();
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8")).etag).toBe("\"v2\"");

    // Edited without bumping updatedAt.
    fetchMock.mockResolvedValueOnce(jsonResponse(
      { ...NEWER_MANIFEST, defaults: { app: [{ model: "openai/gpt-6-luna" }] } },
      { etag: "\"v2-unbumped\"" },
    ));
    await refreshModelManifest();
    const cached = JSON.parse(fs.readFileSync(cacheFile, "utf-8"));
    expect(cached.etag).toBe("\"v2\"");
    expect(cached.manifest.defaults.app[0].model).toBe("openai/gpt-6-sol");
    expect(getAppDefaultModelDescriptor()?.id).toBe("openai/gpt-6-sol");
  });

  it("lets a later agent runtime turn fetching on after an offline runtime started it", async () => {
    initializeModelManifestService({ adeVersion: "1.2.80", fetchRemote: false });
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(jsonResponse(null, { status: 304 }));
    initializeModelManifestService({ adeVersion: "1.2.80", fetchRemote: true });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("backs off after a failure so picker opens do not hammer the network", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    initializeModelManifestService({ adeVersion: "1.2.80" });
    await settle();
    await refreshModelManifest();
    const callsAfterFailure = fetchMock.mock.calls.length;
    refreshModelManifestIfStale();
    await refreshModelManifest();
    await settle();
    expect(fetchMock.mock.calls.length).toBe(callsAfterFailure);
  });

  it("never touches the network when remote fetches are off", async () => {
    initializeModelManifestService({ adeVersion: "1.2.80", fetchRemote: false });
    await settle();
    await refreshModelManifest();
    refreshModelManifestIfStale();
    await settle();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
