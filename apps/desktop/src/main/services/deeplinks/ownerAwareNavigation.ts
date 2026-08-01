import type {
  AppNavigationRequest,
  AppNavigationTarget,
} from "../../../shared/types";
import type { DeeplinkOwnership } from "../../../shared/deeplinks";

export type OwnerAwareNavigationDependencies = {
  getLocalMachineKey(): string;
  resolveLocalProjectRoot(projectId: string): string | null;
  deliverLocal(projectRoot: string, request: AppNavigationRequest): Promise<void>;
  findRemote(
    accountMachineKey: string,
    projectId: string,
  ): unknown | null;
  openRemote(
    accountMachineKey: string,
    projectId: string,
  ): Promise<unknown>;
  deliverRemote(handle: unknown, request: AppNavigationRequest): Promise<void>;
};

export function appNavigationOwnership(
  target: AppNavigationTarget,
): DeeplinkOwnership | null {
  if (target.kind !== "work" && target.kind !== "chat" && target.kind !== "pr") {
    return null;
  }
  const accountMachineKey =
    typeof target.ownership?.accountMachineKey === "string"
      ? target.ownership.accountMachineKey.trim()
      : "";
  const projectId =
    typeof target.ownership?.projectId === "string"
      ? target.ownership.projectId.trim()
      : "";
  return accountMachineKey && projectId
    ? { accountMachineKey, projectId }
    : null;
}

/**
 * Route account-owned navigation before the normal focused-window fallback.
 * Returns false only for ordinary, machine-unscoped navigation.
 */
export async function dispatchOwnerAwareNavigation(
  request: AppNavigationRequest,
  deps: OwnerAwareNavigationDependencies,
): Promise<boolean> {
  const ownership = appNavigationOwnership(request.target);
  if (!ownership) return false;

  if (ownership.accountMachineKey === deps.getLocalMachineKey().trim()) {
    const projectRoot = deps.resolveLocalProjectRoot(ownership.projectId);
    if (!projectRoot) {
      throw new Error(
        `Project ${ownership.projectId} is no longer available on this ADE machine.`,
      );
    }
    await deps.deliverLocal(projectRoot, request);
    return true;
  }

  const existing = deps.findRemote(
    ownership.accountMachineKey,
    ownership.projectId,
  );
  const handle = existing ?? await deps.openRemote(
    ownership.accountMachineKey,
    ownership.projectId,
  );
  await deps.deliverRemote(handle, request);
  return true;
}

export type OwnerNavigationFailureCopy = {
  title: string;
  message: string;
  detail: string;
};

export function ownerNavigationFailureCopy(
  error: unknown,
): OwnerNavigationFailureCopy {
  const detail = error instanceof Error && error.message.trim()
    ? error.message.trim()
    : "The owning ADE machine did not accept the destination.";
  const incompatible = (
    /older ADE|does not support|method not found|code -32601|runtime incompatible|update ADE/i
      .test(detail)
  );
  if (incompatible) {
    return {
      title: "Update the owning ADE machine",
      message: "This item belongs to a machine running an incompatible ADE service.",
      detail: `${detail}\n\nUpdate and restart ADE on that host, then retry from Activity.`,
    };
  }
  if (/project .* no longer available on this ADE machine/i.test(detail)) {
    return {
      title: "Project no longer available",
      message: "ADE found the owning machine, but that project is no longer registered there.",
      detail: `${detail}\n\nOpen or restore the project on that machine, then retry from Activity.`,
    };
  }
  return {
    title: "Owning machine unavailable",
    message: "ADE couldn’t open this item on the machine and project that own it.",
    detail: `${detail}\n\nReconnect that machine from Connections, then retry from Activity.`,
  };
}
