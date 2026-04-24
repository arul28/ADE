import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openKvDb } from "../state/kvDb";
import { createWorkerAgentService } from "./workerAgentService";

function createLogger() {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  } as any;
}

async function createFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ade-worker-agents-"));
  const adeDir = path.join(root, ".ade");
  fs.mkdirSync(adeDir, { recursive: true });
  const dbPath = path.join(adeDir, "ade.db");
  const db = await openKvDb(dbPath, createLogger());
  const projectId = "project-test";
  const service = createWorkerAgentService({
    db,
    projectId,
    adeDir,
  });
  return { root, adeDir, db, projectId, service };
}

describe("workerAgentService", () => {
  it("creates, edits, and removes worker agents with unlink-on-delete", async () => {
    const fixture = await createFixture();
    const manager = fixture.service.saveAgent({
      name: "Backend Lead",
      role: "engineer",
      adapterType: "claude-local",
      adapterConfig: { model: "sonnet" },
    });
    const report = fixture.service.saveAgent({
      name: "Backend IC",
      role: "engineer",
      reportsTo: manager.id,
      adapterType: "codex-local",
      adapterConfig: { model: "gpt-5.3-codex" },
    });

    const edited = fixture.service.saveAgent({
      id: report.id,
      name: "Backend Engineer",
      role: "engineer",
      reportsTo: manager.id,
      adapterType: "codex-local",
      adapterConfig: { model: "gpt-5.3-codex-spark" },
      capabilities: ["api", "tests"],
    });
    expect(edited.name).toBe("Backend Engineer");
    expect(edited.capabilities).toEqual(["api", "tests"]);

    fixture.service.removeAgent(manager.id);
    const unlinked = fixture.service.getAgent(report.id);
    expect(unlinked?.reportsTo).toBeNull();
    expect(fixture.service.getAgent(manager.id)).toBeNull();
    expect(fixture.service.getAgent(manager.id, { includeDeleted: true })?.deletedAt).toBeTruthy();

    fixture.db.close();
  });

  it("reconstructs org tree and chain-of-command", async () => {
    const fixture = await createFixture();
    const lead = fixture.service.saveAgent({
      name: "Lead",
      role: "engineer",
      adapterType: "claude-local",
      adapterConfig: {},
    });
    const mid = fixture.service.saveAgent({
      name: "Mid",
      role: "engineer",
      reportsTo: lead.id,
      adapterType: "claude-local",
      adapterConfig: {},
    });
    const junior = fixture.service.saveAgent({
      name: "Junior",
      role: "qa",
      reportsTo: mid.id,
      adapterType: "process",
      adapterConfig: { command: "echo" },
    });

    const tree = fixture.service.listOrgTree();
    expect(tree.length).toBe(1);
    expect(tree[0]?.id).toBe(lead.id);
    expect(tree[0]?.reports[0]?.id).toBe(mid.id);
    expect(tree[0]?.reports[0]?.reports[0]?.id).toBe(junior.id);

    const chain = fixture.service.getChainOfCommand(junior.id);
    expect(chain.map((entry) => entry.id)).toEqual([junior.id, mid.id, lead.id]);

    fixture.db.close();
  });

  it("blocks cycle creation and 50-hop overflow", async () => {
    const fixture = await createFixture();
    const a = fixture.service.saveAgent({
      name: "A",
      role: "engineer",
      adapterType: "claude-local",
      adapterConfig: {},
    });
    const b = fixture.service.saveAgent({
      name: "B",
      role: "engineer",
      reportsTo: a.id,
      adapterType: "claude-local",
      adapterConfig: {},
    });

    expect(() =>
      fixture.service.saveAgent({
        id: a.id,
        name: "A",
        role: "engineer",
        reportsTo: b.id,
        adapterType: "claude-local",
        adapterConfig: {},
      })
    ).toThrow(/cycle/i);

    let parentId = b.id;
    for (let i = 0; i < 49; i += 1) {
      const node = fixture.service.saveAgent({
        name: `worker-${i}`,
        role: "general",
        reportsTo: parentId,
        adapterType: "process",
        adapterConfig: { command: "echo" },
      });
      parentId = node.id;
    }

    expect(() =>
      fixture.service.saveAgent({
        name: "overflow-node",
        role: "general",
        reportsTo: parentId,
        adapterType: "process",
        adapterConfig: { command: "echo" },
      })
    ).toThrow(/50 hops/i);

    fixture.db.close();
  });

  it("rejects raw secret-like adapter config values", async () => {
    const fixture = await createFixture();
    expect(() =>
      fixture.service.saveAgent({
        name: "Remote",
        role: "researcher",
        adapterType: "openclaw-webhook",
        adapterConfig: {
          url: "https://example.com/hook",
          headers: {
            Authorization: "Bearer sk-secret-value",
          },
        },
      })
    ).toThrow(/raw secret-like value/i);

    const ok = fixture.service.saveAgent({
      name: "Remote 2",
      role: "researcher",
      adapterType: "openclaw-webhook",
      adapterConfig: {
        url: "https://example.com/hook",
        headers: {
          Authorization: "Bearer ${env:OPENCLAW_WEBHOOK_TOKEN}",
        },
      },
    });
    expect(ok.id).toBeTruthy();

    fixture.db.close();
  });

  it("normalizes legacy full_mcp worker session logs as full tooling", async () => {
    const fixture = await createFixture();
    const worker = fixture.service.saveAgent({
      name: "Legacy Worker",
      role: "engineer",
      adapterType: "codex-local",
      adapterConfig: {},
    });
    const sessionsPath = path.join(fixture.adeDir, "agents", worker.slug, "sessions.jsonl");
    fs.writeFileSync(
      sessionsPath,
      `${JSON.stringify({
        sessionId: "legacy-session",
        summary: "Legacy worker session",
        startedAt: "2026-03-05T10:00:00.000Z",
        endedAt: "2026-03-05T10:05:00.000Z",
        provider: "codex",
        modelId: "openai/gpt-5.3-codex",
        capabilityMode: "full_mcp",
        createdAt: "2026-03-05T10:06:00.000Z",
      })}\n`,
      "utf8"
    );

    expect(fixture.service.listSessionLogs(worker.id, 10)[0]?.capabilityMode).toBe("full_tooling");

    fixture.db.close();
  });
});
