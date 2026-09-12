import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAdeGitignore } from "../../../shared/adeLayout";
import { openKvDb } from "../state/kvDb";
import {
  CTO_LIVE_STATE_MAX_CHARS,
  createCtoStateService,
  renderCtoLiveStateBlock,
  type CtoLiveStateSnapshot,
  type CtoLiveStateSources,
} from "./ctoStateService";
import { buildCtoCapabilityManifest } from "./ctoPromptContent";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createStateFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-cto-state-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-test";
  return { root, adeDir, db, projectId };
}

describe("ctoStateService", () => {
  it("creates default CTO identity and current context when absent", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const snapshot = service.getSnapshot();
    expect(snapshot.identity.name).toBe("CTO");
    expect(snapshot.identity.version).toBeGreaterThanOrEqual(1);

    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "identity.yaml"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "CURRENT.md"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.adeDir, "cto", "sessions.jsonl"))).toBe(false);
    expect(buildAdeGitignore()).not.toContain("!cto/identity.yaml");
    expect(buildAdeGitignore()).not.toContain("cto/CURRENT.md");

    fixture.db.close();
  });

  it("nulls a stored model preference whose provider cannot steer a live turn", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    // OpenCode stages every mid-turn message, so a CTO seated there would hold
    // every child report until the current turn ended. The write normalizes
    // away rather than sticking, which is what puts the surface on its picker.
    service.updateIdentity({
      modelPreferences: { provider: "opencode", model: "gpt-5.2", modelId: "opencode/openai/gpt-5.2" },
    });
    expect(service.getIdentity().modelPreferences).toBeNull();

    // Cursor qualifies through interrupt-and-resend, so it is kept.
    service.updateIdentity({
      modelPreferences: { provider: "cursor", model: "composer-1", reasoningEffort: null },
    });
    expect(service.getIdentity().modelPreferences).toMatchObject({ provider: "cursor", model: "composer-1" });

    // An explicit null clears the pick outright.
    service.updateIdentity({ modelPreferences: null });
    expect(service.getIdentity().modelPreferences).toBeNull();

    fixture.db.close();
  });

  /**
   * The provider check alone let a pick through whose model no longer exists,
   * and the surface only found out when `ensureIdentitySession` threw on it.
   * An unusable stored pick has exactly one honest outcome on this branch —
   * null, which is what shows the picker.
   */
  it("nulls a stored model preference whose model id no longer resolves", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    // The provider steers live turns, so the old check kept this. The model is
    // gone from the registry, so nothing can launch it.
    service.updateIdentity({
      modelPreferences: { provider: "anthropic", model: "sonnet-from-a-retired-build", modelId: "claude-retired-9" },
    });
    expect(service.getIdentity().modelPreferences).toBeNull();

    // A real id on the same provider is still kept — the check rejects
    // unresolvable ids, not stored ids.
    service.updateIdentity({
      modelPreferences: { provider: "anthropic", model: "sonnet", modelId: "anthropic/claude-sonnet-5" },
    });
    expect(service.getIdentity().modelPreferences).toMatchObject({ modelId: "anthropic/claude-sonnet-5" });

    fixture.db.close();
  });

  it("recreates files from DB-only state", async () => {
    const fixture = await createStateFixture();
    const identityPayload = {
      name: "CTO",
      version: 7,
      persona: "DB canonical identity",
      modelPreferences: { provider: "claude", model: "sonnet" },
      updatedAt: "2026-03-05T12:00:00.000Z",
    };

    fixture.db.run(
      `insert into cto_identity_state(project_id, version, payload_json, updated_at) values(?, ?, ?, ?)`,
      [fixture.projectId, identityPayload.version, JSON.stringify(identityPayload), identityPayload.updatedAt]
    );

    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    const snapshot = service.getSnapshot();
    expect(snapshot.identity.persona).toBe("DB canonical identity");

    const identityFile = fs.readFileSync(path.join(fixture.adeDir, "cto", "identity.yaml"), "utf8");
    expect(identityFile).toContain("DB canonical identity");

    fixture.db.close();
  });

  it("recreates DB rows from file-only state", async () => {
    const fixture = await createStateFixture();
    const ctoDir = path.join(fixture.adeDir, "cto");
    fs.mkdirSync(ctoDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctoDir, "identity.yaml"),
      [
        "name: CTO",
        "version: 4",
        'persona: "File identity"',
        "modelPreferences:",
        '  provider: "codex"',
        '  model: "gpt-5.3-codex"',
        'updatedAt: "2026-03-05T13:00:00.000Z"',
        "",
      ].join("\n"),
      "utf8"
    );

    createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const identityRow = fixture.db.get<{ payload_json: string }>(
      `select payload_json from cto_identity_state where project_id = ? limit 1`,
      [fixture.projectId]
    );
    expect(JSON.parse(identityRow?.payload_json ?? "{}").persona).toBe("File identity");

    fixture.db.close();
  });

  it("keeps session log integrity and backfills DB from jsonl", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const entry = service.appendSessionLog({
      sessionId: "session-1",
      summary: "First CTO session",
      startedAt: "2026-03-05T10:00:00.000Z",
      endedAt: "2026-03-05T10:05:00.000Z",
      provider: "codex",
      modelId: "openai/gpt-5.3-codex",
      capabilityMode: "full_tooling",
    });
    expect(entry.sessionId).toBe("session-1");
    expect(service.getSessionLogs(10).length).toBe(1);

    fixture.db.run(`delete from cto_session_logs where project_id = ? and session_id = ?`, [fixture.projectId, "session-1"]);
    const afterDelete = fixture.db.get<{ count: number }>(
      `select count(*) as count from cto_session_logs where project_id = ? and session_id = ?`,
      [fixture.projectId, "session-1"]
    );
    expect(Number(afterDelete?.count ?? 0)).toBe(0);

    const recovered = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });
    const logs = recovered.getSessionLogs(10);
    expect(logs.length).toBe(1);
    expect(logs[0]?.summary).toBe("First CTO session");

    fixture.db.close();
  });

  it("normalizes legacy full_mcp session logs as full tooling", async () => {
    const fixture = await createStateFixture();
    const ctoDir = path.join(fixture.adeDir, "cto");
    fs.mkdirSync(ctoDir, { recursive: true });
    fs.writeFileSync(
      path.join(ctoDir, "sessions.jsonl"),
      `${JSON.stringify({
        sessionId: "legacy-session",
        summary: "Legacy CTO session",
        startedAt: "2026-03-05T10:00:00.000Z",
        endedAt: "2026-03-05T10:05:00.000Z",
        provider: "codex",
        modelId: "openai/gpt-5.3-codex",
        capabilityMode: "full_mcp",
        createdAt: "2026-03-05T10:06:00.000Z",
      })}\n`,
      "utf8"
    );

    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    expect(service.getSessionLogs(10)[0]?.capabilityMode).toBe("full_tooling");

    fixture.db.close();
  });

  it("generates current context docs from recent CTO sessions", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.appendSessionLog({
      sessionId: "session-mobile",
      summary: "Investigated navigation regressions and proposed a stack-level fix.",
      startedAt: "2026-05-22T00:00:00.000Z",
      endedAt: "2026-05-22T00:10:00.000Z",
      provider: "codex",
      modelId: "gpt-5.5",
      capabilityMode: "full_tooling",
    });

    service.syncDerivedContextDoc();

    const currentDoc = fs.readFileSync(path.join(fixture.adeDir, "cto", "CURRENT.md"), "utf8");
    expect(currentDoc).toContain("Recent CTO sessions");
    expect(currentDoc).toContain("navigation regressions");

    const reconstruction = service.buildReconstructionContext(10);
    expect(reconstruction).toContain("Current working context");
    expect(reconstruction).toContain("navigation regressions");

    fixture.db.close();
  });

  it("preserves onboarding state and extended identity fields across reloads", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    service.updateIdentity({
      personality: "casual",
      constraints: ["no force push", "write tests"],
      systemPromptExtension: "Stay calm under pressure.",
      communicationStyle: {
        verbosity: "adaptive",
        proactivity: "balanced",
        escalationThreshold: "low",
      },
    });
    service.completeOnboardingStep("identity");

    const reloaded = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    expect(reloaded.getOnboardingState().completedSteps).toEqual(["identity"]);
    expect(reloaded.getOnboardingState().completedAt).toBeTruthy();
    expect(reloaded.getIdentity().personality).toBe("casual");
    expect(reloaded.getIdentity().constraints).toEqual(["no force push", "write tests"]);
    expect(reloaded.getIdentity().systemPromptExtension).toBe("Stay calm under pressure.");
    expect(reloaded.getIdentity().communicationStyle).toEqual({
      verbosity: "adaptive",
      proactivity: "balanced",
      escalationThreshold: "low",
    });

    fixture.db.close();
  });

  it("builds a structured CTO prompt preview with immutable doctrine and preset overlay", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const preview = service.previewSystemPrompt();
    expect(preview.sections.map((section) => section.id)).toEqual(["doctrine", "personality", "continuity", "memory", "knowledge", "capabilities"]);
    expect(preview.sections[0]?.content).toContain("You are the CTO for the current project inside ADE.");
    expect(preview.sections[1]?.content).toContain("Operate as a strategic CTO.");
    expect(preview.sections[2]?.content).toContain("Immutable doctrine");
    expect(preview.sections[2]?.content).toContain("Do not write ephemeral turn-by-turn status");
    // Memory section: teaches persistent memory + saveMemory/searchMemory usage
    expect(preview.sections[3]?.content).toContain("persistent memory");
    expect(preview.sections[3]?.content).toContain("saveMemory");
    // Knowledge section: ADE architecture, chat vs terminal disambiguation, task routing, model selection
    expect(preview.sections[4]?.content).toContain("ADE Architecture");
    expect(preview.sections[4]?.content).toContain("spawnChat");
    expect(preview.sections[4]?.content).toContain("createTerminal");
    expect(preview.sections[4]?.content).toContain("Model Selection");
    expect(preview.sections[4]?.content).toContain("ade actions run <domain.action>");
    expect(preview.sections[4]?.content).toContain("bundled `ade-*` skills");
    // Capabilities section: schema authority plus cross-tool operating rules
    expect(preview.sections[5]?.content).toContain("ADE operator tools");
    expect(preview.sections[5]?.content).toContain("registered ADE operator tool schemas");
    expect(preview.sections[5]?.content).not.toContain("listLanes —");
    expect(preview.sections[5]?.content).toContain("UI navigation is suggestion-only.");
    expect(preview.prompt).toContain("Immutable ADE doctrine");
    expect(preview.prompt).toContain("Selected personality overlay");
    expect(preview.prompt).toContain("ADE environment knowledge");
    expect(preview.prompt).toContain("ADE operator tools");

    fixture.db.close();
  });

  it("uses the custom personality overlay without removing the immutable doctrine", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
    });

    const snapshot = service.updateIdentity({
      personality: "custom",
      customPersonality: "Be sharp, skeptical, and deeply execution-focused.",
      persona: "Legacy custom note",
    });
    const preview = service.previewSystemPrompt(snapshot.identity);

    expect(preview.sections[0]?.content).toContain("You are the CTO for the current project inside ADE.");
    expect(preview.sections[1]?.content).toContain("Be sharp, skeptical, and deeply execution-focused.");
    expect(preview.prompt).toContain("Immutable ADE doctrine");
    expect(preview.prompt).toContain("Be sharp, skeptical, and deeply execution-focused.");

    fixture.db.close();
  });

  // The capability manifest keeps the cross-tool operating rules in one place.
  // It used to instruct
  // "always default laneId to the CTO's current lane" — the CTO's lane is the
  // project's primary lane, so every agent it launched ran against the primary
  // worktree.
  it("keeps CTO-launched work off the CTO's own lane", () => {
    const manifest = buildCtoCapabilityManifest();

    expect(manifest).not.toMatch(/default laneId to the CTO's current lane/i);
    expect(manifest).toMatch(/never launch implementation work on your own lane/i);
    expect(manifest).toMatch(/primary lane/i);
  });

  it("does not duplicate registered tool descriptions in the manifest", () => {
    const manifest = buildCtoCapabilityManifest();

    expect(manifest).toContain("registered ADE operator tool schemas");
    expect(manifest).not.toContain("spawnChat —");
    expect(manifest).not.toContain("createLane —");
    expect(manifest).toContain("# Operating Rules");
  });

  /* ── Live project state ── */

  /**
   * Fake live-state sources shaped exactly like the `Pick` the service takes,
   * so the builder is exercised through the real dependency surface rather
   * than a parallel one.
   */
  function createFakeLiveStateSources(options: {
    lanes: number;
    chats: number;
    prs: number;
    automationRuns: number;
    schedulesPerChat?: number;
    awaitingEveryNthChat?: number;
  }): CtoLiveStateSources {
    const lanes = Array.from({ length: options.lanes }, (_, index) => ({
      id: `lane-${index}`,
      name: `feature/some-reasonably-long-lane-name-${index}`,
      status: { dirty: index % 2 === 0, ahead: index, behind: index % 3, remoteBehind: 0, rebaseInProgress: false },
    }));
    const chats = Array.from({ length: options.chats }, (_, index) => ({
      sessionId: `session-0000-${String(index).padStart(4, "0")}`,
      laneId: `lane-${index % Math.max(1, options.lanes)}`,
      provider: "claude",
      model: "sonnet",
      status: "idle",
      startedAt: "2026-09-11T00:00:00.000Z",
      endedAt: null,
      lastActivityAt: "2026-09-11T00:00:00.000Z",
      lastOutputPreview: null,
      summary: `Working through the ${index}th slice of the extraction program and reporting back.`,
      title: `Extraction slice ${index} — a fairly long chat title as they go`,
      nextWakeAt: null,
      ...(options.awaitingEveryNthChat && index % options.awaitingEveryNthChat === 0
        ? { awaitingInput: true }
        : {}),
      ...(index % 2 === 1 ? { orchestrationParentSessionId: "session-cto", spawnKind: "subagent" as const } : {}),
      scheduledWork: Array.from({ length: options.schedulesPerChat ?? 0 }, (_, slot) => ({
        id: `sched-${index}-${slot}`,
        sessionId: `session-${index}`,
        kind: "cron" as const,
        status: "scheduled" as const,
        title: `Nightly job ${slot} for chat ${index}`,
        prompt: "do the thing",
        createdAt: "2026-09-11T00:00:00.000Z",
        durable: true,
        cancellable: true,
        nextRunAt: "2026-09-12T03:30:00.000Z",
      })),
    }));
    const prs = Array.from({ length: options.prs }, (_, index) => ({
      id: `pr-${index}`,
      laneId: `lane-${index % Math.max(1, options.lanes)}`,
      githubPrNumber: 1200 + index,
      title: `feat(chat): a realistically long pull request title number ${index}`,
      state: "open",
      checksStatus: "pending",
      reviewStatus: "changes_requested",
    }));
    const runs = Array.from({ length: options.automationRuns }, (_, index) => ({
      id: `run-${index}`,
      automationId: `automation-${index % 4}`,
      status: "succeeded",
      startedAt: "2026-09-11T00:00:00.000Z",
      endedAt: "2026-09-11T00:01:00.000Z",
    }));
    return {
      laneService: { list: async () => lanes } as unknown as CtoLiveStateSources["laneService"],
      prService: { listAll: () => prs } as unknown as CtoLiveStateSources["prService"],
      automationService: {
        list: () => Array.from({ length: 4 }, (_, index) => ({ id: `automation-${index}`, name: `Nightly automation ${index}` })),
        // Honours `limit` exactly as the real `listRuns` does, including its
        // own hard cap of 500. A fake that returned everything would hide a
        // caller that asks for eight rows and then calls eight the total.
        listRuns: (listArgs?: { limit?: number }) => runs.slice(
          0,
          typeof listArgs?.limit === "number"
            ? Math.max(1, Math.min(500, Math.floor(listArgs.limit)))
            : 100,
        ),
      } as unknown as CtoLiveStateSources["automationService"],
      listChats: (async () => chats) as unknown as CtoLiveStateSources["listChats"],
    };
  }

  it("builds the live state block from the operator tools' own dependency shapes", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => createFakeLiveStateSources({
        lanes: 2,
        chats: 2,
        prs: 1,
        automationRuns: 1,
        schedulesPerChat: 1,
        awaitingEveryNthChat: 2,
      }),
    });

    // Nothing is injected until a turn asks for a refresh: the block is
    // per-turn state, not boot state.
    expect(service.buildReconstructionContext(8)).not.toContain("Live project state");

    await service.refreshLiveState();
    const context = service.buildReconstructionContext(8);

    expect(context).toContain("Live project state (captured");
    expect(context).toContain("feature/some-reasonably-long-lane-name-0");
    expect(context).toContain("clean, 1 ahead, 1 behind");
    expect(context).toContain("#1200");
    expect(context).toContain("checks pending, review changes_requested");
    expect(context).toContain("subagent of session-cto");
    expect(context).toContain("Waiting on you (1)");
    // Most urgent first: the cap eats the automation-run tail, never approvals.
    expect(context.indexOf("Waiting on you")).toBeLessThan(context.indexOf("Recent automation runs"));
    expect(context).toContain("Nightly job 0 for chat 0");
    expect(context).toContain("Nightly automation 0");
    // The block is LAST, because the turn-context prefix truncates by keeping
    // the tail — the freshest section must be the one a budget cannot cut.
    expect(context.indexOf("Live project state")).toBeGreaterThan(context.indexOf("CTO Identity"));

    fixture.db.close();
  });

  it("degrades to a named note when one source throws instead of blanking the block", async () => {
    const fixture = await createStateFixture();
    const sources = createFakeLiveStateSources({ lanes: 1, chats: 1, prs: 1, automationRuns: 1 });
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => ({
        ...sources,
        laneService: {
          list: async () => { throw new Error("lane service down"); },
        } as unknown as CtoLiveStateSources["laneService"],
      }),
    });

    await service.refreshLiveState();
    const context = service.buildReconstructionContext(8);
    expect(context).toContain("Unavailable this turn: lanes.");
    // The rest of the block still rendered.
    expect(context).toContain("Open PRs (1)");

    fixture.db.close();
  });

  it("reports overflow counts instead of rendering every row", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => createFakeLiveStateSources({
        lanes: 40,
        chats: 40,
        prs: 40,
        automationRuns: 40,
      }),
    });

    const snapshot = await service.refreshLiveState();
    expect(snapshot).not.toBeNull();
    expect(snapshot!.lanesTotal).toBe(40);
    expect(snapshot!.lanes).toHaveLength(12);
    const block = renderCtoLiveStateBlock(snapshot!, Number.MAX_SAFE_INTEGER);
    expect(block).toContain("and 28 more lanes.");
    expect(block).toContain("and 25 more chats.");
    expect(block).toContain("and 28 more PRs.");

    fixture.db.close();
  });

  /**
   * Automation runs are the one section whose source cannot be counted whole —
   * `listRuns` takes a limit and has no count API — so the total used to be
   * fetched at the display cap, which made it structurally impossible for the
   * count to exceed 8 or for the overflow line to fire.
   */
  it("counts automation runs past the rows it shows, and says `at least` when it cannot count them all", async () => {
    const fixture = await createStateFixture();
    const service = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => createFakeLiveStateSources({
        lanes: 1,
        chats: 1,
        prs: 1,
        automationRuns: 40,
      }),
    });

    const snapshot = await service.refreshLiveState();
    expect(snapshot!.automationRunsTotal).toBe(40);
    expect(snapshot!.automationRunsTotalIsFloor).toBe(false);
    expect(snapshot!.automationRuns).toHaveLength(8);
    const block = renderCtoLiveStateBlock(snapshot!, Number.MAX_SAFE_INTEGER);
    expect(block).toContain("Recent automation runs (40)");
    expect(block).toContain("and 32 more runs.");

    // Past the counting window the count is a floor, and the block says so
    // rather than naming a precise number it cannot know.
    const busy = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => createFakeLiveStateSources({
        lanes: 1,
        chats: 1,
        prs: 1,
        automationRuns: 900,
      }),
    });
    const busySnapshot = await busy.refreshLiveState();
    expect(busySnapshot!.automationRunsTotal).toBe(500);
    expect(busySnapshot!.automationRunsTotalIsFloor).toBe(true);
    const busyBlock = renderCtoLiveStateBlock(busySnapshot!, Number.MAX_SAFE_INTEGER);
    expect(busyBlock).toContain("Recent automation runs (500+)");
    expect(busyBlock).toContain("and at least 492 more runs.");

    fixture.db.close();
  });

  /**
   * The cap is measured, not guessed, and this test is the measurement: it
   * fails if a future section pushes the realistic or worst-case size past what
   * `CTO_LIVE_STATE_MAX_CHARS` was chosen for, forcing a re-measure rather than
   * letting the block quietly start truncating itself in production.
   */
  it("stays inside its measured cap at this project's real size and at the worst case", async () => {
    const fixture = await createStateFixture();

    // This project as measured on 2026-09-11: 11 lanes (6 active), 7 chat
    // sessions, 16 open PRs, 37 recorded automation runs.
    const realistic = createCtoStateService({
      db: fixture.db,
      projectId: fixture.projectId,
      adeDir: fixture.adeDir,
      getLiveStateSources: () => createFakeLiveStateSources({
        lanes: 6,
        chats: 7,
        prs: 16,
        automationRuns: 37,
        schedulesPerChat: 1,
      }),
    });
    const realisticSnapshot = await realistic.refreshLiveState();
    const realisticBlock = renderCtoLiveStateBlock(realisticSnapshot!);
    // Measured 2026-09-11: 4591 characters.
    expect(realisticBlock.length).toBeGreaterThan(4_300);
    expect(realisticBlock.length).toBeLessThan(4_900);
    // Nothing this project can currently produce is truncated.
    expect(realisticBlock).not.toContain("(live state truncated)");

    // The worst case the per-section row caps allow, with every string at its
    // own clip limit.
    const worst: CtoLiveStateSnapshot = {
      capturedAt: "2026-09-11T00:00:00.000Z",
      lanes: Array.from({ length: 12 }, (_, i) => ({
        id: "l".repeat(40), name: "n".repeat(60), dirty: true, ahead: i, behind: i,
      })),
      lanesTotal: 999,
      chats: Array.from({ length: 15 }, () => ({
        sessionId: "s".repeat(40),
        title: "t".repeat(60),
        laneId: "l".repeat(40),
        status: "active",
        note: "x".repeat(120),
        parentSessionId: "p".repeat(40),
        spawnKind: "subagent",
      })),
      chatsTotal: 999,
      pullRequests: Array.from({ length: 12 }, (_, i) => ({
        number: 10000 + i, title: "t".repeat(70), laneId: "l".repeat(40),
        checks: "changes_requested", review: "changes_requested",
      })),
      pullRequestsTotal: 999,
      approvals: Array.from({ length: 10 }, () => ({ sessionId: "s".repeat(40), title: "t".repeat(70) })),
      approvalsTotal: 999,
      scheduledWork: Array.from({ length: 10 }, () => ({
        sessionId: "s".repeat(40), title: "t".repeat(60), status: "scheduled",
        nextRunAt: "2026-09-12T03:30:00.000Z",
      })),
      scheduledWorkTotal: 999,
      automationRuns: Array.from({ length: 8 }, () => ({
        name: "n".repeat(60), status: "succeeded", at: "2026-09-11T00:00:00.000Z",
      })),
      automationRunsTotal: 999,
      automationRunsTotalIsFloor: false,
      unavailable: [],
    };
    const worstRaw = renderCtoLiveStateBlock(worst, Number.MAX_SAFE_INTEGER);
    // Measured 2026-09-11: 12578 characters — every row present with every
    // string at its clip limit. A new section that moves this number has to
    // move the cap with it.
    expect(worstRaw.length).toBeGreaterThan(12_000);
    expect(worstRaw.length).toBeLessThan(13_500);
    expect(worstRaw.length).toBeGreaterThan(CTO_LIVE_STATE_MAX_CHARS);

    // ...and the cap holds it, line-aligned, with an explicit marker.
    const capped = renderCtoLiveStateBlock(worst);
    expect(capped.length).toBeLessThanOrEqual(CTO_LIVE_STATE_MAX_CHARS + 32);
    expect(capped.endsWith("(live state truncated)")).toBe(true);
    // Every surviving row is whole: the worst-case rows are built from repeated
    // characters, so a cut row would show a short run.
    const rows = capped.split("\n").filter((line) => line.startsWith("- ") && line.includes("l".repeat(40)));
    for (const row of rows) {
      expect(row).toContain("l".repeat(40));
    }

    fixture.db.close();
  });
});
