/**
 * ADE Cloud launches straight from the account server, for a client with no
 * computer of its own (the web app; the iPhone has its own copy in Swift).
 * The routes are in `account-directory/src/cloud/contract.ts`
 * ("Launches from the web and the phone"). Account-level: no pin. These
 * calls go to the account server, never to the tab's machine.
 */

import type {
  CloudAccountSignIns,
  CloudLaunchList,
  CloudLaunchMessage,
  CloudLaunchRecord,
  CloudLaunchStartRequest,
  CloudLaunchState,
  CloudModelCatalog,
} from "../../../account-directory/src/cloud/contract";

export type {
  CloudAccountSignIn,
  CloudAccountSignIns,
  CloudCatalogModel,
  CloudCatalogProvider,
  CloudLaunchList,
  CloudLaunchMessage,
  CloudLaunchRecord,
  CloudLaunchSignIn,
  CloudLaunchStage,
  CloudLaunchStartRequest,
  CloudLaunchState,
  CloudLaunchSummary,
  CloudModelCatalog,
  CloudRemoteSignInKind,
  CloudRemoteSignInStatus,
} from "../../../account-directory/src/cloud/contract";
export { CLOUD_REMOTE_SIGN_IN, cloudRemoteSignInOf, cloudRemoteSignInRefusal } from "../../../account-directory/src/cloud/contract";

export type AccountCloudLaunchesBridge = {
  start: (launch: CloudLaunchStartRequest) => Promise<CloudLaunchRecord>;
  status: (launchId: string) => Promise<CloudLaunchRecord>;
  active: () => Promise<CloudLaunchList>;
  cancel: (launchId: string) => Promise<CloudLaunchRecord>;
  messages: (launchId: string) => Promise<{ messages: CloudLaunchMessage[] }>;
  addMessage: (launchId: string, message: { messageId: string; text: string }) => Promise<CloudLaunchMessage>;
  signIns: () => Promise<CloudAccountSignIns>;
  saveSignIn: (signInId: string, key: string) => Promise<CloudAccountSignIns>;
  removeSignIn: (signInId: string) => Promise<CloudAccountSignIns>;
  models: () => Promise<CloudModelCatalog>;
};

/** Launch states that are still on their way to a chat. */
export const CLOUD_LAUNCH_IN_PROGRESS: ReadonlySet<CloudLaunchState> = new Set<CloudLaunchState>([
  "draft",
  "making",
  "joining",
  "needs_approval",
  "joined",
  "waiting_for_sign_in",
]);

/** A new launch id: the server takes only a UUID. */
export function newCloudLaunchId(): string {
  return globalThis.crypto.randomUUID();
}

/** A new id for a queued message: 1 to 64 of `A-Za-z0-9_-`. */
export function newCloudMessageId(): string {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return `msg_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
