/**
 * ADE Web: the stand-in "sync client" of a binding the account answers (a
 * project tab bound to ADE Cloud, or a lane pin of a cloud computer that is
 * asleep or deleted). `createAdeWebAdapter` runs over it as over any machine,
 * so every surface reads it the same way.
 *
 * - The commands it lists are the reads the account reader answers
 *   (`shared/adeCloud/accountReader.ts`). Every other read takes the
 *   adapter's own fallback, and every other write is refused before it is
 *   sent (`CommandCaller`): nothing reaches a computer from here.
 * - It never dials, never polls and never wakes anything.
 */

import { markExpected } from "../../../shared/expectedError";
import type { RemoteOpenProjectBinding } from "../../../shared/types";
import type { SyncRemoteCommandDescriptor } from "../../../shared/types/sync";
import {
  ADE_CLOUD_NEEDS_LANE_SENTENCE,
  type AdeCloudAccountReader,
  type AdeCloudReadScope,
} from "../../../shared/adeCloud/accountReader";
import type { AdeSyncClient, AdeSyncClientStatus } from "../sync";
import { ADE_CLOUD_INTEGRATION_WEB_COMMANDS } from "../../../shared/adeCloud/integrationReads";

/** Web command names, in the desktop runtime vocabulary the reader answers. */
const COMMANDS: Readonly<Record<string, { domain: string; action: string }>> = {
  "lanes.list": { domain: "lane", action: "list" },
  "sessions.list": { domain: "session", action: "list" },
  "work.listSessions": { domain: "session", action: "list" },
  "chat.listSessions": { domain: "chat", action: "listSessions" },
  "git.listRecentCommits": { domain: "git", action: "listRecentCommits" },
  "git.getSyncStatus": { domain: "git", action: "getSyncStatus" },
  "diff.getChanges": { domain: "diff", action: "getChanges" },
  // Linear and Jira reads of the account (`integrationReads.ts`).
  ...ADE_CLOUD_INTEGRATION_WEB_COMMANDS,
};

const DESCRIPTORS: SyncRemoteCommandDescriptor[] = Object.keys(COMMANDS).map((action) => ({
  action,
  scope: "project",
  policy: { viewerAllowed: true },
}));

function needsLane(): Error {
  return markExpected(new Error(ADE_CLOUD_NEEDS_LANE_SENTENCE), "user");
}

export function createAdeCloudSyncClient(args: {
  binding: RemoteOpenProjectBinding;
  reader: AdeCloudAccountReader;
  scope: AdeCloudReadScope;
}): AdeSyncClient {
  const { binding, reader, scope } = args;
  const status: AdeSyncClientStatus = {
    state: "connected",
    endpoint: null,
    envId: binding.targetId,
    hostDeviceId: null,
    hostName: binding.runtimeName,
    connectedAt: null,
    lastSeenAt: null,
    error: null,
    activeProjectId: binding.projectId,
    selectedEnvId: binding.targetId,
    readiness: "ready",
  };

  const answerOrRefuse = async (domain: string, action: string, request: Record<string, unknown>): Promise<unknown> => {
    const answer = await reader.answer(scope, { domain, action, args: request });
    if (!answer.handled) throw needsLane();
    return answer.result;
  };

  const known: Record<string, unknown> = {
    getStatus: () => status,
    subscribe: () => () => {},
    isRetryingDial: () => false,
    getCommandDescriptors: () => DESCRIPTORS,
    getProjectCatalog: async () => ({ projects: [] }),
    sendCommand: async (action: string, commandArgs: Record<string, unknown>) => {
      const command = COMMANDS[action];
      if (!command) throw needsLane();
      return await answerOrRefuse(command.domain, command.action, commandArgs ?? {});
    },
    requestFile: async (action: string, fileArgs: Record<string, unknown>) =>
      await answerOrRefuse("file", action, fileArgs ?? {}),
    disconnect: () => undefined,
  };

  return new Proxy(known, {
    get(target, property) {
      if (typeof property !== "string") return undefined;
      if (Object.hasOwn(target, property)) return target[property];
      // Live feeds: there are none at rest.
      if (/^(on|subscribe)[A-Z]/.test(property)) return () => () => {};
      if (/^(supports|is)[A-Z]/.test(property)) return () => false;
      if (/^(unsubscribe|send)[A-Z]/.test(property)) return () => undefined;
      if (/^(request|pair|switch)[A-Z]/.test(property)) return async () => { throw needsLane(); };
      return null;
    },
  }) as unknown as AdeSyncClient;
}
