import {
  accountProjectIdOfTarget,
  deeplinkTargetTakesOwnership,
  ownershipOfTarget,
  type DeeplinkTarget,
} from "../../../shared/deeplinks";
import { resolveAccountProjectLink, type AccountProjectListResult } from "../../../shared/accountProject";
import type { OwnedLinkFailure } from "./ownedLinkResolution";

// Loaded only for a link that names an account project, so a plain start of
// ADE Web does not pay for the account list code.

/**
 * What a link's account project id (L33) means before the owner routing, in
 * the phone's and the desktop's order (`resolveAccountProjectLink`):
 *
 * - `go`: route the link as `target` (its ownership may now name the copy
 *   that the account list picked).
 * - `stop`: the link ends here with `failure`; `noCopy` names the project to
 *   open with no machine.
 */
export type AccountProjectLinkStep =
  | { kind: "go"; target: DeeplinkTarget }
  | { kind: "stop"; failure: OwnedLinkFailure; noCopy: { id: string; name: string } | null };

export function accountProjectLinkStep(
  target: DeeplinkTarget,
  list: AccountProjectListResult,
  onlineMachineKeys: readonly string[],
): AccountProjectLinkStep {
  const id = accountProjectIdOfTarget(target);
  if (!id || list.state !== "ready" || !deeplinkTargetTakesOwnership(target)) return { kind: "go", target };
  const owner = ownershipOfTarget(target);
  const online = new Set(onlineMachineKeys);
  const resolved = resolveAccountProjectLink(id, owner, list, onlineMachineKeys, (key) => online.has(key));
  switch (resolved.kind) {
    case "removed":
      return {
        kind: "stop",
        noCopy: null,
        failure: {
          kind: "project-removed",
          title: `${resolved.name} was removed from ADE.`,
          detail: "Add it again in ADE on a computer that has it, then open the link again.",
          retryable: false,
          offerComputers: false,
        },
      };
    case "unknown":
      return owner
        ? { kind: "go", target }
        : {
          kind: "stop",
          noCopy: null,
          failure: {
            kind: "project-unknown",
            title: "This project isn't in your ADE account.",
            detail: "The link may be from another ADE account.",
            retryable: false,
            offerComputers: false,
          },
        };
    case "noCopy":
      return {
        kind: "stop",
        noCopy: { id: resolved.project.id, name: resolved.project.name },
        failure: {
          kind: "no-copy",
          title: `No computer that is online has a copy of ${resolved.project.name}.`,
          detail: "It opened with no computer. Start ADE on a computer that has it, or add a copy.",
          retryable: true,
          offerComputers: true,
        },
      };
    case "copy": {
      const samePair = owner?.accountMachineKey === resolved.machineKey && owner.projectId === resolved.checkoutId;
      // A lane or a chat lives in the folder its own pair names.
      if (samePair || (owner && target.kind !== "pr")) return { kind: "go", target };
      return {
        kind: "go",
        target: {
          ...target,
          ownership: { accountMachineKey: resolved.machineKey, projectId: resolved.checkoutId, accountProjectId: resolved.project.id },
        } as DeeplinkTarget,
      };
    }
  }
}

