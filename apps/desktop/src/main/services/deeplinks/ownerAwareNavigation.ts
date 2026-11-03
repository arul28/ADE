import type {
  AppNavigationRequest,
  AppNavigationTarget,
} from "../../../shared/types";
import type { DeeplinkOwnership } from "../../../shared/deeplinks";

export type OwnerAwareNavigationDependencies = {
  getLocalMachineKey(): string;
  resolveLocalProjectRoot(projectId: string, projectRoot: string | null): string | null;
  deliverLocal(projectRoot: string, request: AppNavigationRequest): Promise<void>;
  findRemote(
    accountMachineKey: string,
    projectId: string,
    projectRoot: string | null,
  ): unknown | null;
  openRemote(
    accountMachineKey: string,
    projectId: string,
    projectRoot: string | null,
  ): Promise<unknown>;
  deliverRemote(handle: unknown, request: AppNavigationRequest): Promise<void>;
};

export function appNavigationOwnership(
  target: AppNavigationTarget,
): DeeplinkOwnership | null {
  if (target.kind !== "work" && target.kind !== "chat" && target.kind !== "pr" && target.kind !== "lane") {
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
  // Legacy links only: `projectRoot` is parsed but never minted, and it is what
  // rescues a link whose `projectId` is the publishing machine's private uuid.
  // Typed as unknown because ownership also arrives over IPC, where the field
  // is whatever the sender put there.
  const rawProjectRoot: unknown = target.ownership?.projectRoot;
  const projectRoot = typeof rawProjectRoot === "string" ? rawProjectRoot.trim() : "";
  return accountMachineKey && projectId
    ? { accountMachineKey, projectId, ...(projectRoot ? { projectRoot } : {}) }
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

  const ownedProjectRoot = ownership.projectRoot?.trim() || null;

  if (ownership.accountMachineKey === deps.getLocalMachineKey().trim()) {
    const projectRoot = deps.resolveLocalProjectRoot(
      ownership.projectId,
      ownedProjectRoot,
    );
    if (!projectRoot) {
      throw new Error(
        `Project ${ownership.projectId} is no longer available on this ADE machine.`,
      );
    }
    await deps.deliverLocal(projectRoot, request);
    return true;
  }

  // Reuse before open: a window already showing this project is the answer, and
  // opening would otherwise take a second window (or, historically, rebind the
  // one the user was working in).
  const existing = deps.findRemote(
    ownership.accountMachineKey,
    ownership.projectId,
    ownedProjectRoot,
  );
  const handle = existing ?? await deps.openRemote(
    ownership.accountMachineKey,
    ownership.projectId,
    ownedProjectRoot,
  );
  await deps.deliverRemote(handle, request);
  return true;
}

export type OwnerNavigationFailureCopy = {
  title: string;
  message: string;
  detail: string;
};

/**
 * What to tell the person when a link or an Activity item could not be opened
 * on the machine and project that own it. The cause is one of the sentences
 * `describeAttentionOpenFailure` and the local resolver write; each gets the
 * step that fixes it, never a generic "reconnect".
 */
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
      title: "Update ADE on that computer",
      message: "This belongs to a computer running an older ADE.",
      detail: `${detail}\n\nUpdate and restart ADE there, then open it again.`,
    };
  }
  if (/project .* no longer available on this ADE machine/i.test(detail)) {
    return {
      title: "Project not on this computer",
      message: "This belongs to a project that is no longer open in ADE on this computer.",
      detail: `${detail}\n\nAdd the project back in ADE, then open it again.`,
    };
  }
  if (/could not open this project|remote project (?:is required|was not found)/i.test(detail)) {
    return {
      title: "Project not on that computer",
      message: "ADE reached the computer, but that project is no longer in ADE there.",
      detail: `${detail}\n\nAdd the project back in ADE on that computer, then open it again.`,
    };
  }
  if (/not reachable right now/i.test(detail)) {
    return {
      title: "Computer offline",
      message: "The computer this belongs to is not reachable right now.",
      detail: `${detail}\n\nOpen it again once that computer is awake and ADE is running.`,
    };
  }
  if (/could not pair/i.test(detail)) {
    return {
      title: "Couldn’t reach that computer",
      message: "ADE couldn’t pair with the computer this belongs to.",
      detail: `${detail}\n\nIt opens only on computers signed in to the same ADE account.`,
    };
  }
  return {
    title: "Couldn’t open this",
    message: "ADE couldn’t open this on the computer and project that own it.",
    detail: `${detail}\n\nCheck the computer in Settings → Computers, then open it again.`,
  };
}
