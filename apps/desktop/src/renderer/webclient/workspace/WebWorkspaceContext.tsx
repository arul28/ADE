import React, { createContext, useContext, useMemo } from "react";
import type { AdeAccountMachine } from "../../../shared/types/account";
import type { BrowserAccountSnapshot } from "../account/client";
import type { FederatedWebAdapter } from "../adapter/federated";
import type {
  WebMachineSessionManager,
  WebMachineWorkspaceSnapshot,
} from "./WebMachineSessionManager";
import { mergeWebMachines, type WebMachineEntry } from "./webWorkspaceModel";

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
  /**
   * Connect whichever route a merged machine row has — saved browser pairing
   * first, account adoption otherwise — and resolve its live target id.
   */
  connectMachineEntry(machine: WebMachineEntry): Promise<string>;
  /**
   * Drop a machine's cached project catalogs from this browser, under every key
   * the machine may be stored against (see `webMachineCatalogKeys`).
   */
  forgetMachineCatalog(machineKeys: readonly string[]): void;
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

/**
 * The workspace when there is one. Shared desktop components (the welcome page,
 * the top bar) render in both apps, so they ask instead of assuming.
 */
export function useOptionalWebWorkspace(): WebWorkspaceContextValue | null {
  return useContext(WebWorkspaceContext);
}

/**
 * The merged machine rows for the current workspace, or an empty list on the
 * desktop. Every surface that lists machines derives them the same way, so they
 * cannot disagree about which machines exist or what state they are in.
 */
export function useWebMachines(): WebMachineEntry[] {
  const workspace = useOptionalWebWorkspace();
  return useMemo(() => (
    workspace
      ? mergeWebMachines({
          accountMachines: workspace.account.machines,
          snapshot: workspace.snapshot,
          relayBaseUrls: workspace.account.relayBaseUrls,
        })
      : []
  ), [workspace]);
}
