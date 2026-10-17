import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createComputerUseArtifactBrokerService } from "../../../../desktop/src/main/services/computerUse/computerUseArtifactBrokerService";
import { openKvDb, type AdeDb } from "../../../../desktop/src/main/services/state/kvDb";
import { createComputerUseNamespace } from "../../../../desktop/src/renderer/webclient/adapter/computerUse";
import { CommandCaller } from "../../../../desktop/src/renderer/webclient/adapter/infra/commandCaller";
import { createSyncRemoteCommandService } from "./syncRemoteCommandService";

/**
 * The hosted web client's proof citation, end to end in one process: the web
 * adapter's `computerUse.listArtifacts` through the real `CommandCaller` (its
 * descriptor check included), into the sync host's remote command service, onto
 * a real artifact broker over a scratch project database. Only the socket is
 * stubbed: `sendCommand` hands the command straight to the host service.
 */

const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

function logger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as never;
}

describe("web proof citations, end to end", () => {
  let projectRoot: string;
  let db: AdeDb;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ade-web-proof-e2e-"));
    db = await openKvDb(path.join(projectRoot, ".ade.db"), logger());
    db.run(
      "insert into projects(id, root_path, display_name, default_base_ref, created_at, last_opened_at) values (?, ?, ?, ?, ?, ?)",
      ["project-1", projectRoot, "ADE", "main", "2026-03-12T14:00:00.000Z", "2026-03-12T14:00:00.000Z"],
    );
  });

  afterEach(() => {
    db.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function hostWith(broker: unknown) {
    return createSyncRemoteCommandService({
      db,
      projectRoot,
      laneService: {},
      prService: {},
      ptyService: {},
      sessionService: {},
      fileService: {},
      computerUseArtifactBrokerService: broker,
      logger: logger(),
    } as never);
  }

  /** The web client's view of a host: the real CommandCaller over a socket stub. */
  function webClientOf(service: ReturnType<typeof hostWith>, { reachable = true } = {}) {
    const client = {
      getStatus: () => ({ selectedEnvId: "env-1", state: "connected" }),
      getCommandDescriptors: () => service.getDescriptors(),
      sendCommand: async (action: string, args: Record<string, unknown>) => {
        if (!reachable) throw Object.assign(new Error("The ADE machine is not connected."), { code: "host_unavailable" });
        return service.execute({ commandId: `cmd-${action}`, action, args } as never);
      },
    };
    const state = { getProjectId: () => "project-1" };
    const commands = new CommandCaller(client as never, state as never);
    return createComputerUseNamespace({ client, commands, state } as never) as unknown as {
      listArtifacts: (args: Record<string, unknown>) => Promise<Array<{ id: string; title: string }>>;
    };
  }

  it("answers a cited proof with the record the machine holds, and an empty list only for an unknown id", async () => {
    const broker = createComputerUseArtifactBrokerService({
      db,
      projectId: "project-1",
      projectRoot,
      logger: logger(),
    });
    const shot = path.join(projectRoot, "before-the-fix.png");
    fs.writeFileSync(shot, PNG_1X1);
    const ingested = await broker.ingestAsync({
      backend: { name: "agent-browser" },
      owners: [{ kind: "lane", id: "lane-1" }],
      inputs: [{ kind: "screenshot", title: "Before the fix", path: shot }],
    });
    const artifactId = ingested.artifacts[0]!.id;
    const web = webClientOf(hostWith(broker));

    const rows = await web.listArtifacts({ artifactId, limit: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: artifactId, title: "Before the fix" });

    // The machine answers, and it has no such record: that is an authoritative empty.
    await expect(web.listArtifacts({ artifactId: "no-such-proof", limit: 1 })).resolves.toEqual([]);
  });

  it("rejects, rather than answering empty, when the machine cannot be reached", async () => {
    const broker = { listArtifacts: () => [] };
    const web = webClientOf(hostWith(broker), { reachable: false });

    await expect(web.listArtifacts({ artifactId: "art-1" })).rejects.toThrow(/not connected/);
  });

  it("rejects with the update message when the host predates the command", async () => {
    const web = webClientOf(hostWith(null));

    await expect(web.listArtifacts({ artifactId: "art-1" })).rejects.toThrow(/computerUse\.listArtifacts/);
  });
});
