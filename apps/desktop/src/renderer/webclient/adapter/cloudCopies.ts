import { cloudShape, type CloudCreateProgress, type CloudShapeId } from "../../../shared/adeCloud";
import { CloudApiError, type CloudApiClient } from "../../../shared/cloudApiClient";
import type { CloudCopyRecord } from "../../../../../account-directory/src/cloud/contract";

/**
 * ADE Web's Copy… of a computer: ADE's server runs it (`POST
 * /cloud/instances/:id/copy`, `copies.ts`), so the web needs no computer of
 * the person's. It reports as the desktop's copy does (`onCreateProgress`,
 * ending in `done` or `failed`), so the card's own Copy… works here.
 *
 * Followed by a read every few seconds while one runs, and none otherwise.
 * Closing the tab stops only the following; the copy goes on there.
 */

const POLL_MS = 4_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Reads that fail in a row before this tab stops following. */
const READ_FAILURES = 30;

export function createWebCloudCopies(api: () => CloudApiClient | null) {
  const listeners = new Set<(progress: CloudCreateProgress) => void>();
  /** The copies this tab follows, by the card's request id. */
  const followed = new Map<string, string>();
  const emit = (progress: CloudCreateProgress) => {
    for (const listener of listeners) listener(progress);
  };

  const follow = async (requestId: string, first: CloudCopyRecord) => {
    let record = first;
    let lastLine = "";
    let failures = 0;
    for (;;) {
      const instanceId = record.targetInstanceId ?? undefined;
      if (record.state === "done") {
        emit({
          requestId,
          stage: "done",
          message: `${record.name} is ready: a copy with the same files.`,
          result: { instanceId: record.targetInstanceId!, machineKey: record.targetMachineKey, name: record.name, joined: record.targetMachineKey != null, renamed: true },
        });
        return;
      }
      if (record.state === "failed" || record.state === "cancelled") {
        const message = record.error ?? record.message;
        emit({ requestId, stage: "failed", message, error: message });
        return;
      }
      // A fresh approval link with the same line is news too: the card's Approve opens the current one.
      const line = `${record.message}|${record.approvalUrl ?? ""}`;
      if (line !== lastLine) {
        lastLine = line;
        const stage = record.state === "copying" ? "creating" : record.state === "joining" ? "signing_in" : "approve_elsewhere";
        emit({ requestId, stage, message: record.message, ...(instanceId ? { instanceId } : {}), ...(record.approvalUrl ? { approvalUrl: record.approvalUrl } : {}) });
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      try {
        const client = api();
        if (!client) throw new Error("Sign in to ADE here to follow the copy.");
        record = await client.copy(record.copyId);
        failures = 0;
      } catch (error) {
        failures += 1;
        const gone = error instanceof CloudApiError && error.status === 404;
        if (gone || failures >= READ_FAILURES) {
          const message = gone
            ? "ADE Cloud lost track of the copy. Check your computers list."
            : "ADE can't reach ADE Cloud to follow the copy. It goes on there; check your computers list.";
          emit({ requestId, stage: "failed", message, error: message });
          return;
        }
      }
    }
  };

  return {
    copyMachine: async (args: { requestId: string; instanceId: string; name?: string | null; shape?: string | null }): Promise<{ started: boolean }> => {
      if (followed.has(args.requestId)) return { started: true };
      const client = api();
      if (!client) throw new Error("Sign in to ADE here to copy a computer.");
      const shape = args.shape ? cloudShape(args.shape as CloudShapeId) : null;
      if (args.shape && !shape) throw new Error("Pick a size.");
      const start = async (copyId: string): Promise<CloudCopyRecord> => {
        try {
          return await client.startCopy(args.instanceId, {
            copyId,
            ...(args.name?.trim() ? { name: args.name.trim() } : {}),
            ...(shape ? { resources: { cpu: shape.cpu, memoryGb: shape.memoryGb } } : {}),
            origin: "person",
          });
        } catch (error) {
          // An older server has no copies; only the desktop app can copy there.
          if (error instanceof CloudApiError && error.status === 404) throw new Error("Copy this computer from the ADE desktop app. ADE Cloud can't copy it from here yet.");
          throw error;
        }
      };
      // The copy's id is the card's request id when it is one, so a retried start follows the same copy, as on the desktop.
      const requestCopyId = args.requestId.trim().toLowerCase();
      let record = await start(UUID.test(requestCopyId) ? requestCopyId : crypto.randomUUID());
      // That copy ended without one: a Retry makes a new one.
      if (record.state === "failed" || record.state === "cancelled") record = await start(crypto.randomUUID());
      followed.set(args.requestId, record.copyId);
      void follow(args.requestId, record).finally(() => followed.delete(args.requestId));
      return { started: true };
    },
    onCreateProgress: (cb: (progress: CloudCreateProgress) => void) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    /**
     * Before the copy signs in, the server deletes it; after, it is a whole
     * computer and the server says no (409 `copy_signed_in`), so the card
     * keeps following it. The follow loop reads the cancelled record next.
     */
    cancelCreate: async (requestId: string) => {
      const copyId = followed.get(requestId);
      const client = api();
      if (!copyId || !client) return { cancelled: false };
      try {
        // A 200 is a cancel taken: done now, or at the end of the step that runs.
        const record = await client.cancelCopy(copyId);
        return { cancelled: record.state !== "done" };
      } catch {
        return { cancelled: false };
      }
    },
  };
}
