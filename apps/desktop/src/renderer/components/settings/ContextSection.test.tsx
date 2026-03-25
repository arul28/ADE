/* @vitest-environment jsdom */

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ContextSection } from "./ContextSection";

describe("ContextSection", () => {
  const originalAde = globalThis.window.ade;

  afterEach(() => {
    cleanup();
    if (originalAde === undefined) {
      delete (globalThis.window as any).ade;
    } else {
      globalThis.window.ade = originalAde;
    }
  });

  it("explains that skill files are indexed for retrieval but managed in workspace", async () => {
    let onStatusChanged: ((status: any) => void) | null = null;
    globalThis.window.ade = {
      context: {
        getStatus: async () => ({
          docs: [],
          generation: { state: "idle", source: "manual", event: null, error: null },
        }),
        onStatusChanged: (cb: (status: any) => void) => {
          onStatusChanged = cb;
          return () => {
            if (onStatusChanged === cb) onStatusChanged = null;
          };
        },
        getPrefs: () => new Promise<never>(() => {}),
        savePrefs: async () => undefined,
        generateDocs: async () => ({
          generatedAt: "2026-03-25T12:00:00.000Z",
          degraded: false,
          docResults: [],
          warnings: [],
        }),
      },
      ai: {
        getStatus: async () => ({}),
      },
      memory: {
        listIndexedSkills: async () => [],
        reindexSkills: async () => [],
      },
      app: {
        revealPath: async () => undefined,
      },
    } as any;

    render(
      <MemoryRouter initialEntries={["/settings?tab=workspace"]}>
        <ContextSection />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/ADE indexes them for retrieval and dedupe/i)).toBeTruthy();
    expect(screen.getByText(/manages the files here instead of showing them as standalone entries in the generic Memory browser/i)).toBeTruthy();
    expect(onStatusChanged).not.toBeNull();
  });

  it("treats fallback docs as actionable and updates when status events arrive", async () => {
    let listener: ((status: any) => void) | null = null;
    const baseStatus = {
      canonicalDocsPresent: 2,
      canonicalDocsScanned: 2,
      canonicalDocsFingerprint: "fingerprint",
      canonicalDocsUpdatedAt: "2026-03-25T12:00:00.000Z",
      projectExportFingerprint: null,
      projectExportUpdatedAt: null,
      contextManifestRefs: {
        project: null,
        packs: null,
        transcripts: null,
      },
      fallbackWrites: 0,
      insufficientContextCount: 0,
      warnings: [],
      generation: {
        state: "idle",
        requestedAt: null,
        startedAt: null,
        finishedAt: null,
        error: null,
        source: null,
        event: null,
        reason: null,
        provider: null,
        modelId: null,
        reasoningEffort: null,
      },
    };

    globalThis.window.ade = {
      context: {
        getStatus: async () => ({
          ...baseStatus,
          docs: [
            {
              id: "prd_ade",
              label: "PRD (ADE minimized)",
              preferredPath: ".ade/context/PRD.ade.md",
              exists: true,
              sizeBytes: 96,
              updatedAt: "2026-03-25T12:00:00.000Z",
              fingerprint: "prd",
              staleReason: null,
              fallbackCount: 0,
              health: "fallback",
              source: "deterministic",
            },
          ],
        }),
        onStatusChanged: (cb: (status: any) => void) => {
          listener = cb;
          return () => {
            if (listener === cb) listener = null;
          };
        },
        getPrefs: async () => ({
          provider: "unified",
          modelId: null,
          reasoningEffort: null,
          events: {},
        }),
        savePrefs: async () => undefined,
        generateDocs: vi.fn(async () => ({
          generatedAt: "2026-03-25T12:00:00.000Z",
          degraded: false,
          docResults: [],
          warnings: [],
        })),
      },
      ai: {
        getStatus: async () => ({}),
      },
      memory: {
        listIndexedSkills: async () => [],
        reindexSkills: async () => [],
      },
      app: {
        revealPath: async () => undefined,
      },
    } as any;

    render(
      <MemoryRouter initialEntries={["/settings?tab=workspace"]}>
        <ContextSection />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/deterministic fallback via deterministic/i)).toBeTruthy();

    act(() => {
      listener?.({
        ...baseStatus,
        docs: [
          {
            id: "prd_ade",
            label: "PRD (ADE minimized)",
            preferredPath: ".ade/context/PRD.ade.md",
            exists: true,
            sizeBytes: 640,
            updatedAt: "2026-03-25T12:05:00.000Z",
            fingerprint: "prd-new",
            staleReason: null,
            fallbackCount: 0,
            health: "ready",
            source: "ai",
          },
        ],
      });
    });

    expect(await screen.findByText(/ready via ai/i)).toBeTruthy();
  });
});
