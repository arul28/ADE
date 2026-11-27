import type {
  AppNavigationRequest,
  AppNavigationTarget,
} from "../../../shared/types";
import { isAccountProjectId, type DeeplinkOwnership } from "../../../shared/deeplinks";
import {
  resolveAccountProjectLink,
  type AccountProjectListResult,
} from "../../../shared/accountProject";
import { BRAND } from "../../../shared/brand";

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
  /**
   * `openRemote` failed. When the copy's computer is an ADE Cloud computer
   * that sleeps (opening never wakes one), show the repository on ADE Cloud
   * instead and answer true; false leaves the failure to the caller.
   */
  openAsleepOnAdeCloud(error: unknown, ownership: DeeplinkOwnership, request: AppNavigationRequest): Promise<boolean>;
};

export function appNavigationOwnership(
  target: AppNavigationTarget,
): DeeplinkOwnership | null {
  if (target.kind !== "work" && target.kind !== "chat" && target.kind !== "pr" && target.kind !== "lane" && target.kind !== "automation-run") {
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
        `Project ${ownership.projectId} is no longer available on this ${BRAND.NAME} machine.`,
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
  let handle = existing;
  if (!handle) {
    try {
      handle = await deps.openRemote(
        ownership.accountMachineKey,
        ownership.projectId,
        ownedProjectRoot,
      );
    } catch (error) {
      if (await deps.openAsleepOnAdeCloud(error, ownership, request)) return true;
      throw error;
    }
  }
  await deps.deliverRemote(handle, request);
  return true;
}

/** A project copy on one machine, as an Activity item or a link names it. */
export type AccountProjectCopyRef = {
  machineKey: string;
  /** The copy's registry id (`checkoutId`), when the caller has it. */
  projectId?: string | null;
  rootPath?: string | null;
};

/**
 * The request that opens a copy's repository on ADE Cloud, for a copy whose
 * computer sleeps: an `account-project` request (`no-copy`, since no copy can
 * be reached without waking one), as a link with no reachable copy gets. The
 * account project is the one the link named, else the one that lists this
 * copy (same machine, same checkout id or folder). Null when the account
 * lists none.
 */
export function adeCloudNavigationForCopy(
  request: AppNavigationRequest,
  list: AccountProjectListResult,
  copy: AccountProjectCopyRef,
): AppNavigationRequest | null {
  if (list.state !== "ready") return null;
  const machineKey = copy.machineKey.trim();
  const checkoutId = copy.projectId?.trim() || null;
  const rootPath = copy.rootPath?.trim() || null;
  const named = namedAccountProjectId(request.target);
  // A named project, or the one it was merged into; never another project
  // that happens to list the folder.
  const namedProject = named ? resolveAccountProjectLink(named, null, list, [], () => false) : null;
  const project = namedProject
    ? (namedProject.kind === "noCopy" ? namedProject.project : null)
    : list.projects.find((entry) => entry.copies.some((row) => (
      row.machineKey === machineKey
      && ((checkoutId !== null && row.checkoutId === checkoutId) || (rootPath !== null && row.rootPath === rootPath))
    )));
  if (!project) return null;
  return {
    ...request,
    target: { kind: "account-project", accountProjectId: project.id, name: project.name, reason: "no-copy" },
  };
}

/** The account project a link names: its own `accountProjectId`, else its ownership's (L33). */
function namedAccountProjectId(target: AppNavigationTarget): string | null {
  if (target.kind !== "work" && target.kind !== "chat" && target.kind !== "pr" && target.kind !== "lane" && target.kind !== "automation-run") return null;
  const id = target.accountProjectId ?? target.ownership?.accountProjectId ?? null;
  return isAccountProjectId(id) ? id : null;
}

export type AccountProjectNavigationDependencies = {
  /** This computer's `projects.accountList`, with its `retired` ids. */
  readAccountList(): Promise<AccountProjectListResult>;
  getLocalMachineKey(): string;
  /** Machine keys this desktop holds a live connection to. */
  connectedMachineKeys(): readonly string[];
  /** Machine keys the account directory shows online (one read; empty on failure). */
  onlineMachineKeys(): Promise<readonly string[]>;
};

/**
 * A link that names an account project (`accountProjectId`, L33), resolved
 * before the owner routing: the phone's order (`resolveAccountProjectLink`).
 *
 * - No account id, or no list on this computer: the request goes on as it
 *   came (old links keep their old route).
 * - A merged id follows to its project; the request gets that project's
 *   reachable copy as its owner, so the owner routing opens it there.
 * - A lane or a chat lives in one place. When the link's own pair names a
 *   reachable copy, the old route opens it; a different copy cannot.
 * - No reachable copy: an `account-project` request (`no-copy`), which opens
 *   the repository tab with no machine.
 * - A removed id, or an id the account does not hold (with no pair to fall
 *   back on): an `account-project` request that says so.
 */
export async function resolveAccountProjectNavigation(
  request: AppNavigationRequest,
  deps: AccountProjectNavigationDependencies,
): Promise<AppNavigationRequest> {
  const target = request.target;
  const id = namedAccountProjectId(target);
  if (!id) return request;
  const list = await deps.readAccountList().catch(() => null);
  if (!list || list.state !== "ready") return request;
  const owner = appNavigationOwnership(target);
  const local = deps.getLocalMachineKey().trim();
  const connected = deps.connectedMachineKeys();
  const online = await deps.onlineMachineKeys().catch(() => [] as readonly string[]);
  const order = [...new Set([...(local ? [local] : []), ...connected, ...online])];
  const reachable = new Set(order);
  const resolved = resolveAccountProjectLink(id, owner, list, order, (key) => reachable.has(key));
  // `projectId`: the project the link ends at after its merges. The page reads
  // projects and copies by it, so the old id would show no copies.
  const tell = (reason: "no-copy" | "removed" | "unknown", name: string | null, projectId: string = id): AppNavigationRequest => ({
    ...request,
    target: { kind: "account-project", accountProjectId: projectId, name, reason },
  });
  switch (resolved.kind) {
    case "removed":
      return tell("removed", resolved.name);
    case "unknown":
      return owner ? request : tell("unknown", null);
    case "noCopy":
      return tell("no-copy", resolved.project.name, resolved.project.id);
    case "copy": {
      const samePair = owner?.accountMachineKey === resolved.machineKey && owner.projectId === resolved.checkoutId;
      if (samePair) return request;
      // The linked lane or chat is in the folder the pair names; another
      // copy does not have it, so the old route tries that folder.
      if (owner && target.kind !== "pr") return request;
      const ownership: DeeplinkOwnership = {
        accountMachineKey: resolved.machineKey,
        projectId: resolved.checkoutId,
        accountProjectId: resolved.project.id,
      };
      return { ...request, target: { ...target, ownership } as AppNavigationTarget };
    }
  }
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
    : `The owning ${BRAND.NAME} machine did not accept the destination.`;
  const incompatible = (
    /older ADE|does not support|method not found|code -32601|runtime incompatible|update ADE/i
      .test(detail)
  );
  if (incompatible) {
    return {
      title: `Update ${BRAND.NAME} on that computer`,
      message: `This belongs to a computer running an older ${BRAND.NAME}.`,
      detail: `${detail}\n\nUpdate and restart ${BRAND.NAME} there, then open it again.`,
    };
  }
  if (/project .* no longer available on this ADE machine/i.test(detail)) {
    return {
      title: "Project not on this computer",
      message: `This belongs to a project that is no longer open in ${BRAND.NAME} on this computer.`,
      detail: `${detail}\n\nAdd the project back in ${BRAND.NAME}, then open it again.`,
    };
  }
  if (/could not open this project|remote project (?:is required|was not found)/i.test(detail)) {
    return {
      title: "Project not on that computer",
      message: `${BRAND.NAME} reached the computer, but that project is no longer in ${BRAND.NAME} there.`,
      detail: `${detail}\n\nAdd the project back in ${BRAND.NAME} on that computer, then open it again.`,
    };
  }
  if (/not reachable right now/i.test(detail)) {
    return {
      title: "Computer offline",
      message: "The computer this belongs to is not reachable right now.",
      detail: `${detail}\n\nOpen it again once that computer is awake and ${BRAND.NAME} is running.`,
    };
  }
  if (/could not pair/i.test(detail)) {
    return {
      title: "Couldn’t reach that computer",
      message: `${BRAND.NAME} couldn’t pair with the computer this belongs to.`,
      detail: `${detail}\n\nIt opens only on computers signed in to the same ${BRAND.NAME} account.`,
    };
  }
  return {
    title: "Couldn’t open this",
    message: `${BRAND.NAME} couldn’t open this on the computer and project that own it.`,
    detail: `${detail}\n\nCheck the computer in Settings → Computers, then open it again.`,
  };
}
