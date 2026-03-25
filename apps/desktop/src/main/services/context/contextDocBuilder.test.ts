import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openKvDb, type AdeDb } from "../state/kvDb";
import { readContextStatus, runContextDocGeneration } from "./contextDocBuilder";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as const;
}

function buildValidPrdDoc(summary = "ADE is a local-first desktop workspace for orchestrating coding agents."): string {
  return [
    "# PRD.ade",
    "",
    "## What this is",
    summary,
    "",
    "## Who it's for",
    "- Solo AI-native developers coordinating multiple agents.",
    "- Small teams working across parallel lanes and PRs.",
    "",
    "## Feature areas",
    "- Lanes, missions, PR workflows, and proof capture.",
    "- CTO and MCP-backed operator flows.",
    "",
    "## Current state",
    "- Desktop app is the main product surface.",
    "- Context docs are bounded agent bootstrap cards.",
    "",
    "## Working norms",
    "- Prefer service-first fixes over renderer-only workarounds.",
    "- Keep IPC, preload, shared types, and renderer code aligned.",
    "",
  ].join("\n");
}

function buildValidArchitectureDoc(summary = "ADE uses a trusted Electron main process, typed preload bridge, and untrusted renderer."): string {
  return [
    "# ARCHITECTURE.ade",
    "",
    "## System shape",
    summary,
    "",
    "## Core services",
    "- Main-process services own git, files, processes, missions, and context generation.",
    "- The MCP server reuses shared ADE services.",
    "",
    "## Data and state",
    "- Project state lives under `.ade/`.",
    "- Runtime metadata primarily lives in `.ade/ade.db`.",
    "",
    "## Integration points",
    "- Renderer talks to trusted services over typed IPC.",
    "- External AI, GitHub, and Linear connect through service adapters.",
    "",
    "## Key patterns",
    "- Enforce trust boundaries in code paths.",
    "- Keep generated context distinct from canonical docs.",
    "",
  ].join("\n");
}

function createAiIntegrationService(text: string) {
  return {
    getMode: () => "subscription" as const,
    generateInitialContext: vi.fn(async () => ({
      text,
      structuredOutput: null,
      provider: "claude",
      model: "anthropic/claude-sonnet-4-6",
      sessionId: null,
      inputTokens: null,
      outputTokens: null,
      durationMs: 25,
    })),
  };
}

async function createFixture(): Promise<{
  projectRoot: string;
  packsDir: string;
  db: AdeDb;
}> {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-context-doc-builder-"));
  const packsDir = path.join(projectRoot, ".ade", "packs");
  fs.mkdirSync(packsDir, { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "features"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "docs", "architecture"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "README.md"), "# ADE\n\nLocal-first workspace for coding agents.\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "AGENTS.md"), [
    "# ADE Project Instructions",
    "",
    "## Working norms",
    "- Preserve existing desktop app patterns before introducing new abstractions.",
    "- Prefer fixing the underlying service or shared type rather than layering renderer-only workarounds on top.",
    "- Keep IPC contracts, preload types, shared types, and renderer usage in sync whenever an interface changes.",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "PRD.md"), [
    "# ADE product requirements document",
    "",
    "ADE is a local-first desktop control plane for coding agents.",
    "",
    "## Product surfaces",
    "- Lanes",
    "- Missions",
    "- PRs",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "features", "MISSIONS.md"), [
    "# Missions",
    "",
    "Missions plan and supervise multi-step work across agents.",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "SYSTEM_OVERVIEW.md"), [
    "# ADE system overview",
    "",
    "ADE uses a trusted Electron main process with a typed preload bridge.",
    "",
    "## Trust boundaries",
    "- Renderer remains untrusted.",
    "",
  ].join("\n"), "utf8");
  fs.writeFileSync(path.join(projectRoot, "docs", "architecture", "CONTEXT_CONTRACT.md"), [
    "# Context documentation contract",
    "",
    "Generated docs must stay distinct and compact.",
    "",
  ].join("\n"), "utf8");
  const db = await openKvDb(path.join(projectRoot, ".ade", "ade.db"), createLogger() as any);
  return { projectRoot, packsDir, db };
}

describe("contextDocBuilder", () => {
  const cleanupRoots: string[] = [];
  const cleanupDbs: AdeDb[] = [];

  afterEach(() => {
    while (cleanupDbs.length > 0) {
      cleanupDbs.pop()?.close();
    }
    while (cleanupRoots.length > 0) {
      fs.rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  it("accepts narrated JSON output and writes ready docs", async () => {
    const fixture = await createFixture();
    cleanupRoots.push(fixture.projectRoot);
    cleanupDbs.push(fixture.db);

    const ai = createAiIntegrationService([
      "Here are the updated cards:",
      "```json",
      JSON.stringify({
        prd: buildValidPrdDoc(),
        architecture: buildValidArchitectureDoc(),
      }),
      "```",
    ].join("\n"));

    const result = await runContextDocGeneration({
      db: fixture.db,
      logger: createLogger() as any,
      projectRoot: fixture.projectRoot,
      projectId: "project-1",
      packsDir: fixture.packsDir,
      laneService: {} as any,
      projectConfigService: {} as any,
      aiIntegrationService: ai as any,
    }, {
      provider: "unified",
    });

    expect(result.degraded).toBe(false);
    expect(result.docResults).toEqual([
      expect.objectContaining({ id: "prd_ade", health: "ready", source: "ai" }),
      expect.objectContaining({ id: "architecture_ade", health: "ready", source: "ai" }),
    ]);

    const prdBody = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "PRD.ade.md"), "utf8");
    const archBody = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "ARCHITECTURE.ade.md"), "utf8");
    expect(prdBody).toContain("## What this is");
    expect(archBody).toContain("## System shape");

    const status = readContextStatus({
      db: fixture.db,
      projectId: "project-1",
      projectRoot: fixture.projectRoot,
      packsDir: fixture.packsDir,
    });
    expect(status.docs.map((doc) => ({ id: doc.id, health: doc.health, source: doc.source }))).toEqual([
      { id: "prd_ade", health: "ready", source: "ai" },
      { id: "architecture_ade", health: "ready", source: "ai" },
    ]);
  });

  it("preserves previous good docs when replacement output is invalid", async () => {
    const fixture = await createFixture();
    cleanupRoots.push(fixture.projectRoot);
    cleanupDbs.push(fixture.db);

    const firstResult = await runContextDocGeneration({
      db: fixture.db,
      logger: createLogger() as any,
      projectRoot: fixture.projectRoot,
      projectId: "project-1",
      packsDir: fixture.packsDir,
      laneService: {} as any,
      projectConfigService: {} as any,
      aiIntegrationService: createAiIntegrationService(JSON.stringify({
        prd: buildValidPrdDoc("ADE gives operators a local-first control plane."),
        architecture: buildValidArchitectureDoc("ADE routes all repo mutation through trusted main-process services."),
      })) as any,
    }, {
      provider: "unified",
    });

    expect(firstResult.degraded).toBe(false);
    const firstPrd = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "PRD.ade.md"), "utf8");
    const firstArch = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "ARCHITECTURE.ade.md"), "utf8");

    const degradedResult = await runContextDocGeneration({
      db: fixture.db,
      logger: createLogger() as any,
      projectRoot: fixture.projectRoot,
      projectId: "project-1",
      packsDir: fixture.packsDir,
      laneService: {} as any,
      projectConfigService: {} as any,
      aiIntegrationService: createAiIntegrationService("not valid json") as any,
    }, {
      provider: "unified",
    });

    expect(degradedResult.degraded).toBe(true);
    expect(degradedResult.docResults).toEqual([
      expect.objectContaining({ id: "prd_ade", health: "ready", source: "previous_good" }),
      expect.objectContaining({ id: "architecture_ade", health: "ready", source: "previous_good" }),
    ]);
    expect(degradedResult.warnings.some((warning) => warning.code === "generator_invalid_prd")).toBe(true);
    expect(degradedResult.warnings.some((warning) => warning.code === "generator_invalid_architecture")).toBe(true);

    expect(fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "PRD.ade.md"), "utf8")).toBe(firstPrd);
    expect(fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "ARCHITECTURE.ade.md"), "utf8")).toBe(firstArch);
  });

  it("rejects overlapping docs and falls back to compact deterministic cards", async () => {
    const fixture = await createFixture();
    cleanupRoots.push(fixture.projectRoot);
    cleanupDbs.push(fixture.db);

    const sharedParagraph = "ADE coordinates lane mission operator branch worktree session review queue merge artifact transcript context bootstrap provider runtime preload renderer mainprocess sqlite storage secrets cache github linear automation routing policy validation proof retrieval sync checkpoint telemetry resilience isolation auditability discoverability onboarding settings workspace orchestration supervision conflictprediction reviewqueue providerselection contextdelivery intervention history exports ownership contracts services adapters.";
    const duplicatedDoc = [
      "# PRD.ade",
      "",
      "## What this is",
      sharedParagraph,
      "",
      "## Who it's for",
      `- ${sharedParagraph}`,
      "",
      "## Feature areas",
      `- ${sharedParagraph}`,
      "",
      "## Current state",
      `- ${sharedParagraph}`,
      "",
      "## Working norms",
      `- ${sharedParagraph}`,
      "",
    ].join("\n");
    const duplicatedArchitecture = duplicatedDoc
      .replace("# PRD.ade", "# ARCHITECTURE.ade")
      .replace("## What this is", "## System shape")
      .replace("## Who it's for", "## Core services")
      .replace("## Feature areas", "## Data and state")
      .replace("## Current state", "## Integration points")
      .replace("## Working norms", "## Key patterns");

    const result = await runContextDocGeneration({
      db: fixture.db,
      logger: createLogger() as any,
      projectRoot: fixture.projectRoot,
      projectId: "project-1",
      packsDir: fixture.packsDir,
      laneService: {} as any,
      projectConfigService: {} as any,
      aiIntegrationService: createAiIntegrationService(JSON.stringify({
        prd: duplicatedDoc,
        architecture: duplicatedArchitecture,
      })) as any,
    }, {
      provider: "unified",
    });

    expect(result.degraded).toBe(true);
    expect(result.warnings.some((warning) => warning.code === "generator_overlap_rejected")).toBe(true);
    expect(result.docResults).toEqual([
      expect.objectContaining({ id: "prd_ade", health: "fallback", source: "deterministic" }),
      expect.objectContaining({ id: "architecture_ade", health: "fallback", source: "deterministic" }),
    ]);

    const prdBody = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "PRD.ade.md"), "utf8");
    const archBody = fs.readFileSync(path.join(fixture.projectRoot, ".ade", "context", "ARCHITECTURE.ade.md"), "utf8");
    expect(prdBody.length).toBeLessThanOrEqual(8_000);
    expect(archBody.length).toBeLessThanOrEqual(8_000);
    expect(prdBody).not.toContain("## Directory tree");
    expect(archBody).not.toContain("## Directory tree");
  });

  it("marks generated docs as stale when canonical docs become newer", async () => {
    const fixture = await createFixture();
    cleanupRoots.push(fixture.projectRoot);
    cleanupDbs.push(fixture.db);

    await runContextDocGeneration({
      db: fixture.db,
      logger: createLogger() as any,
      projectRoot: fixture.projectRoot,
      projectId: "project-1",
      packsDir: fixture.packsDir,
      laneService: {} as any,
      projectConfigService: {} as any,
      aiIntegrationService: createAiIntegrationService(JSON.stringify({
        prd: buildValidPrdDoc(),
        architecture: buildValidArchitectureDoc(),
      })) as any,
    }, {
      provider: "unified",
    });

    const future = new Date(Date.now() + 60_000);
    const canonicalPrd = path.join(fixture.projectRoot, "docs", "PRD.md");
    fs.utimesSync(canonicalPrd, future, future);

    const status = readContextStatus({
      db: fixture.db,
      projectId: "project-1",
      projectRoot: fixture.projectRoot,
      packsDir: fixture.packsDir,
    });

    expect(status.docs.every((doc) => doc.health === "stale")).toBe(true);
    expect(status.docs.every((doc) => doc.staleReason === "older_than_canonical_docs")).toBe(true);
  });
});
