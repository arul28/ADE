import React, { createContext, useContext } from "react";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { BrowserAccountSnapshot } from "../account/client";
import type { FederatedWebAdapter } from "../adapter/federated";
import type {
  WebMachineSessionManager,
  WebMachineWorkspaceSnapshot,
} from "./WebMachineSessionManager";

export type WebWorkspaceContextValue = {
  account: BrowserAccountSnapshot;
  snapshot: WebMachineWorkspaceSnapshot;
  manager: WebMachineSessionManager;
  adapter: FederatedWebAdapter;
  connectingMachineKey: string | null;
  directoryLoading: boolean;
  notice: string | null;
  dismissNotice(): void;
  consumePendingProjectPath(): string | null;
  signIn(): void;
  signOut(): Promise<void>;
  retryDirectory(): Promise<void>;
  connectAccountMachine(machine: AdeAccountMachine): Promise<string>;
  connectEnvironment(targetId: string): Promise<void>;
  renameMachine(machineKey: string, customName: string | null): Promise<void>;
  removeAccountMachine(machineKey: string): Promise<void>;
  forgetEnvironment(targetId: string): Promise<void>;
};

const WebWorkspaceContext = createContext<WebWorkspaceContextValue | null>(null);

export function WebWorkspaceProvider({
  value,
  children,
}: {
  value: WebWorkspaceContextValue;
  children: React.ReactNode;
}) {
  return (
    <WebWorkspaceContext.Provider value={value}>
      {children}
    </WebWorkspaceContext.Provider>
  );
}

export function useWebWorkspace(): WebWorkspaceContextValue {
  const value = useContext(WebWorkspaceContext);
  if (!value) throw new Error("Web workspace is not available outside ADE Web.");
  return value;
}
