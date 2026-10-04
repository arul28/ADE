import { isUnsupportedAdeActionError, parseCodedErrorMessage } from "../../shared/codedError";
import type { OpenProjectBinding } from "../../shared/types";

/**
 * Whether a host's answer to `getBranchChanges` means "this host has no branch
 * diffs", as opposed to a real failure (an unresolvable base) worth showing.
 *
 * An older brain answers the runtime action with `action_not_callable` /
 * "Action 'x' is not callable"; the web client's command caller answers an
 * unadvertised remote command with `unsupported_action`.
 */
export function isBranchDiffUnsupported(error: unknown): boolean {
  if (isUnsupportedAdeActionError(error)) return true;
  const { code, message } = parseCodedErrorMessage(error);
  const errorCode = (error as { code?: unknown } | null)?.code;
  return code === "unsupported_action"
    || errorCode === "unsupported_action"
    || code === "unsupported_command"
    || /is unavailable on the connected ADE host|Unsupported remote command/i.test(message);
}

const supportByLane = new Map<string, Promise<boolean>>();

/**
 * Whether the host behind a lane understands `mode: "branch"`, asked once per
 * lane and machine. An older host reads an unknown mode as "unstaged" without
 * complaint, so a surface offers Branch only after this answered true. A lane
 * whose base cannot be resolved still supports the mode: its diff shows that
 * error, which is the useful thing to see.
 */
export function hostSupportsBranchDiff(laneId: string, pin?: OpenProjectBinding | null): Promise<boolean> {
  const key = `${pin?.key ?? ""}\u0000${laneId}`;
  let pending = supportByLane.get(key);
  if (!pending) {
    const getBranchChanges = window.ade?.diff?.getBranchChanges;
    pending = getBranchChanges
      ? getBranchChanges({ laneId }, pin).then((result) => result != null, (error: unknown) => !isBranchDiffUnsupported(error))
      : Promise.resolve(false);
    supportByLane.set(key, pending);
  }
  return pending;
}
