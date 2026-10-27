// Phone wire budget: the bytes a phone receives on a cold connect, a reconnect and one big chat's first
// page, from a real sync host serving the seeded synthetic project (test/syntheticPerfProject.ts).
// The phone copies the iOS hello (capabilities, per-envelope deflate, binary frames, no
// permessage-deflate) and acks every changeset batch. Nothing is shaped or timed; only bytes count.
//
// The budgets sit about 10% above what main sends today, so they only stop regressions. Lower them as
// the wire gets cheaper, never raise them to pass (docs/perf/macos-baseline.md, "Network and remote").
// Not counted: replies to commands (lanes, work sessions, PRs) from services this test does not run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSyntheticPerfProject, type SyntheticPerfProject } from "../../test/syntheticPerfProject";
import {
  PHONE_CHAT_SUBSCRIBE_MAX_BYTES,
  catchUpMeasurementPhone,
  helloMeasurementPhone,
  pairMeasurementPhone,
  startMeasurementSyncHost,
  type MeasurementPhone,
  type MeasurementSyncHost,
  type PhoneIdentity,
} from "../../test/phoneWireHarness";

/**
 * Wire bytes a phone receives, per scenario. Measured on main at db74bb75f (2026-10-26): cold
 * 240.9 KB (changesets 168 KB, brain_status 31 KB, roster 18 KB, chat page 16 KB, hello_ok 8 KB),
 * reconnect 42.6 KB (the full roster again, hello_ok, the chat page), big chat first page 15.7 KB.
 * After the P1 phone pass (brain_status only when a peer catches up, roster resume by sinceSeq,
 * null-free roster rows): cold 210.4 KB (brain_status 1.3 KB, roster 16.6 KB), reconnect 25.0 KB
 * (roster 131 B; hello_ok and the chat page are what is left).
 */
const BUDGET = {
  coldConnectBytes: 232_000,
  reconnectBytes: 27_500,
  bigChatFirstPageBytes: 17_500,
};

describe("phone wire budget on the synthetic project", () => {
  let dir = "";
  let fixture: SyntheticPerfProject;
  let host: MeasurementSyncHost;
  let url = "";
  let identity: PhoneIdentity;
  let caughtUpDbVersion = 0;
  let rosterSeq = 0;
  let chatSeq: number | null = null;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-wire-budget-"));
    fixture = await buildSyntheticPerfProject(path.join(dir, "project"), { chats: 300, lanes: 6, bigTurns: 400 });
    host = await startMeasurementSyncHost({
      projectRoot: fixture.projectRoot,
      projectId: fixture.projectId,
      secretsDir: path.join(dir, "secrets"),
      pollIntervalMs: 5,
    });
    url = `ws://127.0.0.1:${host.port}`;
    identity = await pairMeasurementPhone(url, host.pin, "BUDGET-PHONE-0001", "budgetphonesite00000000000000001");
  }, 120_000);

  afterAll(async () => {
    await host?.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function openBigChat(phone: MeasurementPhone, sinceSeq: number | null) {
    phone.send("chat_subscribe", {
      sessionId: fixture.bigChatId,
      maxBytes: PHONE_CHAT_SUBSCRIBE_MAX_BYTES,
      ...(sinceSeq != null ? { sinceSeq } : {}),
    });
    return phone.next((message) => message.type === "chat_subscribe" && message.payload?.sessionId === fixture.bigChatId, "chat_subscribe");
  }

  it("cold connect: hello, roster, catalog, the whole replica and the big chat's first page", async () => {
    const { phone, hello } = await helloMeasurementPhone(url, identity, 0);
    phone.send("roster_subscribe", {});
    phone.send("project_catalog_request", {}, "catalog");
    const roster = await phone.next((message) => message.type === "roster_snapshot", "roster_snapshot");
    rosterSeq = Number(roster.payload.seq);
    await phone.next((message) => message.type === "project_catalog", "project_catalog");
    const serverDbVersion = Number(hello.payload.serverDbVersion);
    expect(serverDbVersion).toBeGreaterThan(0);
    caughtUpDbVersion = (await catchUpMeasurementPhone(phone, 0, serverDbVersion)).applied;
    const chat = await openBigChat(phone, null);
    const seqs = (chat.payload.events ?? []).map((event: { seq?: number }) => Number(event.seq)).filter(Number.isFinite);
    chatSeq = seqs.length ? Math.max(...seqs) : null;
    const coldConnectBytes = phone.bytes();
    await phone.close();
    console.log(JSON.stringify({ wireBudget: "cold", coldConnectBytes, bigChatFirstPageBytes: chat.wireBytes, byType: phone.bytesByType() }));
    expect(coldConnectBytes).toBeLessThanOrEqual(BUDGET.coldConnectBytes);
    expect(chat.wireBytes).toBeLessThanOrEqual(BUDGET.bigChatFirstPageBytes);
  }, 120_000);

  it("reconnect: a caught-up phone with its roster seq and chat cursor", async () => {
    expect(caughtUpDbVersion).toBeGreaterThan(0);
    const { phone, hello } = await helloMeasurementPhone(url, identity, caughtUpDbVersion);
    phone.send("roster_subscribe", { sinceSeq: rosterSeq });
    phone.send("project_catalog_request", {}, "catalog");
    await phone.next((message) => message.type === "roster_snapshot" || message.type === "roster_delta", "roster");
    await phone.next((message) => message.type === "project_catalog", "project_catalog");
    await catchUpMeasurementPhone(phone, caughtUpDbVersion, Number(hello.payload.serverDbVersion));
    await openBigChat(phone, chatSeq);
    const reconnectBytes = phone.bytes();
    await phone.close();
    console.log(JSON.stringify({ wireBudget: "reconnect", reconnectBytes, byType: phone.bytesByType() }));
    expect(reconnectBytes).toBeLessThanOrEqual(BUDGET.reconnectBytes);
  }, 60_000);
});
