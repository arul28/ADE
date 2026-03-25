import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { ContextDocStatus, ContextStatus } from "../../../shared/types";
import {
  describeContextDocHealth,
  isContextDocReady,
  listActionableContextDocs,
  listContextDocsByHealth,
  parsePackBody,
  relativeTime,
  shortId,
} from "./contextShared";

function makeDoc(health: ContextDocStatus["health"], id: ContextDocStatus["id"] = "prd_ade"): ContextDocStatus {
  return {
    id, label: "PRD", preferredPath: "/docs/prd.md", exists: true,
    sizeBytes: 100, updatedAt: null, fingerprint: null, staleReason: null,
    fallbackCount: 0, health, source: "ai",
  };
}

function makeStatus(docs: ContextDocStatus[]): ContextStatus {
  return {
    docs, canonicalDocsPresent: docs.length, canonicalDocsScanned: docs.length,
    canonicalDocsFingerprint: "abc", canonicalDocsUpdatedAt: null,
    projectExportFingerprint: null, projectExportUpdatedAt: null,
    contextManifestRefs: { project: null, packs: null, transcripts: null },
    fallbackWrites: 0, insufficientContextCount: 0, warnings: [],
    generation: {
      state: "idle", requestedAt: null, startedAt: null, finishedAt: null,
      error: null, source: null, event: null, reason: null,
      provider: null, modelId: null, reasoningEffort: null,
    },
  };
}

describe("isContextDocReady", () => {
  it("returns true only for ready health", () => {
    expect(isContextDocReady(makeDoc("ready"))).toBe(true);
    expect(isContextDocReady(makeDoc("missing"))).toBe(false);
    expect(isContextDocReady(makeDoc("stale"))).toBe(false);
    expect(isContextDocReady(null)).toBe(false);
    expect(isContextDocReady(undefined)).toBe(false);
  });
});

describe("listContextDocsByHealth", () => {
  it("filters docs by health value", () => {
    const status = makeStatus([makeDoc("ready", "prd_ade"), makeDoc("missing", "architecture_ade")]);
    expect(listContextDocsByHealth(status, "missing")).toHaveLength(1);
    expect(listContextDocsByHealth(status, "stale")).toEqual([]);
    expect(listContextDocsByHealth(null, "ready")).toEqual([]);
  });
});

describe("listActionableContextDocs", () => {
  it("returns docs where health is not ready", () => {
    const status = makeStatus([
      makeDoc("ready", "prd_ade"),
      makeDoc("missing", "architecture_ade"),
      makeDoc("stale", "architecture_ade"),
    ]);
    expect(listActionableContextDocs(status)).toHaveLength(2);
    expect(listActionableContextDocs(null)).toEqual([]);
  });
});

describe("describeContextDocHealth", () => {
  it("maps all health values to human-readable strings", () => {
    expect(describeContextDocHealth(makeDoc("missing"))).toBe("missing");
    expect(describeContextDocHealth(makeDoc("incomplete"))).toBe("incomplete");
    expect(describeContextDocHealth(makeDoc("fallback"))).toBe("deterministic fallback");
    expect(describeContextDocHealth(makeDoc("stale"))).toBe("stale");
    expect(describeContextDocHealth(makeDoc("ready"))).toBe("ready");
  });
});

describe("parsePackBody", () => {
  it("parses JSON header and markdown sections", () => {
    const body = '```json\n{"schema": "v1"}\n```\n\n# Section\nContent here.';
    const result = parsePackBody(body);
    expect(result.header).toEqual({ schema: "v1" });
    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].heading).toBe("Section");
  });

  it("handles body with no JSON header", () => {
    const result = parsePackBody("# Title\nContent\n## Sub\nMore");
    expect(result.header).toBeNull();
    expect(result.sections).toHaveLength(2);
  });

  it("strips ADE internal markers and collapses newlines", () => {
    const result = parsePackBody("<!-- ADE_INTERNAL_FLAG -->\n# Title\n\n\n\nContent.");
    expect(result.sections[0].heading).toBe("Title");
    expect(result.sections[0].content).not.toContain("\n\n\n");
  });

  it("handles empty body", () => {
    expect(parsePackBody("")).toEqual({ header: null, sections: [] });
  });
});

describe("relativeTime", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-03-25T12:00:00Z")); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns 'never' for null/empty", () => {
    expect(relativeTime(null)).toBe("never");
    expect(relativeTime("")).toBe("never");
  });

  it("returns relative time descriptions", () => {
    expect(relativeTime("2026-03-25T11:59:30Z")).toBe("just now");
    expect(relativeTime("2026-03-25T11:55:00Z")).toBe("5m ago");
    expect(relativeTime("2026-03-25T09:00:00Z")).toBe("3h ago");
    expect(relativeTime("2026-03-23T12:00:00Z")).toBe("2d ago");
  });

  it("returns raw string for invalid dates", () => {
    expect(relativeTime("not-a-date")).toBe("not-a-date");
  });
});

describe("shortId", () => {
  it("truncates and handles edge cases", () => {
    expect(shortId("abc", 10)).toBe("abc");
    expect(shortId("abcdefghijklmno", 5)).toBe("abcde");
    expect(shortId(null)).toBe("-");
    expect(shortId("   ")).toBe("-");
  });
});
