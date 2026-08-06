import type {
  AdeAccountMachinesResult,
  AdeAccountStatus,
} from "../../../shared/types/account";
import {
  browserAccountIsSignedIn,
  type BrowserAccountClient,
  type BrowserAccountSnapshot,
  type BrowserAccountState,
} from "../account/client";

function loginStatus(state: BrowserAccountState): "pending" | "signed_in" | "expired" {
  if (browserAccountIsSignedIn(state)) return "signed_in";
  if (state === "auth_expired") return "expired";
  return "pending";
}

export function browserAccountStatus(snapshot: BrowserAccountSnapshot): AdeAccountStatus {
  return {
    signedIn: browserAccountIsSignedIn(snapshot.state),
    userId: snapshot.userId,
    email: snapshot.email,
    name: snapshot.name,
    expiresAt: snapshot.expiresAt,
    provider: null,
    imageUrl: snapshot.imageUrl,
    configured: snapshot.state !== "unconfigured",
  };
}

function machinesResult(snapshot: BrowserAccountSnapshot): AdeAccountMachinesResult {
  switch (snapshot.state) {
    case "signed_in":
      return { state: "ok", machines: snapshot.machines, message: snapshot.message };
    case "signed_out":
      return { state: "signed_out", machines: [], message: snapshot.message };
    case "auth_expired":
      return { state: "auth_expired", machines: [], message: snapshot.message };
    case "unconfigured":
      return { state: "not_configured", machines: [], message: snapshot.message };
    case "loading":
    case "directory_unavailable":
      return { state: "unavailable", machines: [], message: snapshot.message };
  }
}

export function createAccountNamespace(
  accountClient: BrowserAccountClient,
): Window["ade"]["account"] {
  return {
    status: async () => browserAccountStatus(accountClient.getSnapshot()),
    startLogin: async () => {
      const authorizeUrl = await accountClient.startSignIn();
      return {
        sessionId: "browser-redirect",
        authorizeUrl,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
      };
    },
    pollLogin: async () => {
      const snapshot = accountClient.getSnapshot();
      return {
        status: loginStatus(snapshot.state),
        message: snapshot.message,
        authStatus: browserAccountStatus(snapshot),
      };
    },
    cancelLogin: async () => browserAccountStatus(accountClient.getSnapshot()),
    // The device flow exists so a machine's own brain can earn a pairing grant
    // and spend it locally. A hosted browser has no brain, so it has nothing to
    // re-pair; the affordance that uses this is hidden in web mode, and this
    // says why rather than starting a sign-in that could never help.
    startDeviceLogin: async () => {
      throw new Error("Open ADE on the computer you want to reconnect, then try again there.");
    },
    pollDeviceLogin: async () => ({
      status: "error" as const,
      message: "Open ADE on the computer you want to reconnect, then try again there.",
      intervalSec: null,
      authStatus: browserAccountStatus(accountClient.getSnapshot()),
    }),
    cancelDeviceLogin: async () => browserAccountStatus(accountClient.getSnapshot()),
    signOut: async () => browserAccountStatus(await accountClient.signOut()),
    listMachines: async () => machinesResult(await accountClient.loadMachines()),
    renameMachine: async (machineKey: string, customName: string | null) =>
      await accountClient.renameMachine(machineKey, customName),
    // A hosted browser is a controller, not an account-directory machine.
    getLocalMachineIdentity: async () => ({ machineKey: "", deviceId: "" }),
    pairMachine: async () => {
      throw new Error("Choose this machine from the web machine switcher.");
    },
    onPairMachineProgress: () => () => {},
    removeMachine: async (machineKey: string) => await accountClient.removeMachine(machineKey),
    // Reconnecting re-registers the machine the ADE brain runs on. A hosted
    // browser has no brain of its own, so it cannot repair anything; the action
    // is hidden in web mode rather than left to fail here.
    repairMachinePairing: async () => {
      throw new Error("Open ADE on the computer you want to reconnect, then try again there.");
    },
  };
}
