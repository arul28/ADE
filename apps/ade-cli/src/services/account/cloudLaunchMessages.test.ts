import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudApiError } from "../../../../desktop/src/shared/cloudApiClient";
import {
  CHAT_QUEUE_JOURNAL_KEY,
  deliverInOrder,
  deliverQueuedMessages,
  readMessageJournal,
  writeMessageJournal,
  type OrderedMessage,
} from "./cloudLaunchMessages";

const logger = { info: () => {}, warn: () => {} };

/**
 * One computer's view of the server queue: the journal is a real file, so a
 * "restart" is a second run that reads it back.
 */
describe("deliverInOrder", () => {
  let dir: string;
  let file: string;
  let sent: string[];
  let reports: Array<{ messageId: string; state: string; error?: string }>;
  let claims: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-message-journal-"));
    file = path.join(dir, "chat-messages.json");
    sent = [];
    reports = [];
    claims = [];
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const run = async (
    messages: OrderedMessage[],
    behavior: { claim?: (id: string) => Promise<void>; send?: (message: OrderedMessage) => Promise<void> } = {},
  ) => {
    const journal = readMessageJournal(file, CHAT_QUEUE_JOURNAL_KEY, logger);
    return await deliverInOrder(messages, {
      journal,
      saveJournal: () => writeMessageJournal(file, journal),
      claim: async (messageId) => {
        claims.push(messageId);
        await behavior.claim?.(messageId);
      },
      report: async (messageId, _claimId, state, error) => {
        reports.push({ messageId, state, ...(error ? { error } : {}) });
      },
      send: async (message) => {
        await behavior.send?.(message);
        sent.push(message.messageId);
      },
      logger,
      logMeta: {},
    });
  };
  const queued = (messageId: string, seq: number): OrderedMessage => ({ messageId, seq, state: "queued", text: `text ${seq}` });

  it("sends each message once, in order, and a report that was lost is sent again without a second send", async () => {
    expect(await run([queued("b", 2), queued("a", 1)])).toBe(true);
    expect(sent).toEqual(["a", "b"]);
    // The server never got the reports: it still says `sending` for both.
    reports = [];
    expect(await run([{ ...queued("a", 1), state: "sending" }, { ...queued("b", 2), state: "sending" }])).toBe(true);
    expect(sent).toEqual(["a", "b"]);
    expect(reports).toEqual([{ messageId: "a", state: "delivered" }, { messageId: "b", state: "delivered" }]);
  });

  it("reports a message the computer may have sent before a restart as failed, never sends it again", async () => {
    // A crash after the attempt was written: the journal says attempted, the server says sending.
    const journal = readMessageJournal(file, CHAT_QUEUE_JOURNAL_KEY, logger);
    journal.attempted = ["x"];
    journal.claims.x = "claim-x";
    writeMessageJournal(file, journal);
    expect(await run([{ ...queued("x", 2), state: "sending" }])).toBe(true);
    expect(sent).toEqual([]);
    expect(reports).toEqual([{ messageId: "x", state: "failed", error: expect.stringContaining("couldn't confirm") }]);
  });

  it("stops at a claim that did not get through, so no later message goes first", async () => {
    let fail = true;
    const claim = async (id: string) => {
      if (id === "a" && fail) throw new CloudApiError("timeout", "timeout", 408);
    };
    expect(await run([queued("a", 1), queued("b", 2)], { claim })).toBe(false);
    expect(sent).toEqual([]);
    expect(claims).toEqual(["a"]);
    // The next round claims with the same id and sends both.
    fail = false;
    const firstClaim = readMessageJournal(file, CHAT_QUEUE_JOURNAL_KEY, logger).claims.a;
    expect(await run([queued("a", 1), queued("b", 2)], { claim })).toBe(true);
    expect(readMessageJournal(file, CHAT_QUEUE_JOURNAL_KEY, logger).claims.a).toBe(firstClaim);
    expect(sent).toEqual(["a", "b"]);
  });

  it("leaves a message the server gave to another claim alone", async () => {
    const claim = async () => {
      throw new CloudApiError("taken", "message_taken", 409);
    };
    expect(await run([queued("a", 1)], { claim })).toBe(true);
    expect(sent).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("does not count a send the chat refused for a running turn as an attempt", async () => {
    let busy = true;
    const send = async () => {
      if (busy) throw Object.assign(new Error("turn running"), { code: "turn_in_flight" });
    };
    expect(await run([queued("a", 1)], { send })).toBe(false);
    expect(reports).toEqual([]);
    busy = false;
    // The server still says `sending` under this computer's claim: it is sent now, once.
    expect(await run([{ ...queued("a", 1), state: "sending" }], { send })).toBe(true);
    expect(sent).toEqual(["a"]);
    expect(reports).toEqual([{ messageId: "a", state: "delivered" }]);
  });
});

/**
 * A launch's queued messages: the server API is faked (the network boundary).
 * A continued CLI row takes no chat send, so each message is typed at its prompt.
 */
describe("deliverQueuedMessages", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ade-launch-messages-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it("types a continued CLI's messages at its prompt, never through the chat send, and reports an ended CLI as failed", async () => {
    const reports: Array<[string, string]> = [];
    const typed: Array<[string, string]> = [];
    const chatSends: string[] = [];
    const idleWaits: string[] = [];
    const api = {
      launchMessages: async () => ({ messages: [
        { messageId: "first", seq: 1, state: "queued", text: "opened the CLI" },
        { messageId: "m2", seq: 2, state: "queued", text: "Run the tests." },
        { messageId: "m3", seq: 3, state: "queued", text: "Then lint." },
      ] }),
      claimLaunchMessage: async () => {},
      reportLaunchMessage: async (_launchId: string, messageId: string, report: { state: string }) => {
        reports.push([messageId, report.state]);
      },
    };
    let ended = false;
    const deps = {
      launchId: "launch-1",
      logger,
      stateFile: path.join(dir, "boot.json"),
      api: () => api as never,
      sendChatMessage: async (_projectId: string, sessionId: string) => {
        chatSends.push(sessionId);
        throw new Error("Chat session 'cli-1' was not found.");
      },
      waitForChatIdle: async (_projectId: string, sessionId: string) => {
        idleWaits.push(sessionId);
        return true;
      },
      typeIntoCli: async (_projectId: string, sessionId: string, message: { text: string }) => {
        typed.push([sessionId, message.text]);
        return ended ? "ended" as const : "delivered" as const;
      },
    };

    expect(await deliverQueuedMessages(deps, "project-1", { sessionId: "cli-1", kind: "cli" })).toBe(true);
    expect(typed).toEqual([["cli-1", "Run the tests."], ["cli-1", "Then lint."]]);
    expect([chatSends, idleWaits]).toEqual([[], []]);
    expect(reports).toEqual([["m2", "delivered"], ["m3", "delivered"]]);

    // A CLI whose process ended: the message reads failed, not delivered.
    fs.rmSync(`${deps.stateFile}.messages.json`, { force: true });
    reports.length = 0;
    ended = true;
    api.launchMessages = async () => ({ messages: [{ messageId: "m4", seq: 4, state: "queued", text: "One more." }] });
    expect(await deliverQueuedMessages(deps, "project-1", { sessionId: "cli-1", kind: "cli" })).toBe(true);
    expect(reports).toEqual([["m4", "failed"]]);
  });
});
