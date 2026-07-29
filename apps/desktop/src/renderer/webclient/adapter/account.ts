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
  };
}
