import type { DeeplinkOwnership } from "../../shared/deeplinks";
import type { OpenProjectBinding } from "../../shared/types";

/**
 * The account computer and project a link to something in this project should
 * name, so it opens there from anywhere (another computer, the web app, the
 * phone). `pin` is the row's machine when it is not this tab's; otherwise the
 * tab's own binding, or its local root. Null when ADE can't tell (a remote
 * host that never paired through the account): the link still opens, without
 * the machine.
 */
export async function linkOwnershipFor(args: {
  pin: OpenProjectBinding | null | undefined;
  tabBinding: OpenProjectBinding | null | undefined;
  projectRoot: string | null | undefined;
}): Promise<DeeplinkOwnership | null> {
  const root = args.projectRoot?.trim() ?? "";
  const binding: OpenProjectBinding | null = args.pin
    ?? args.tabBinding
    ?? (root ? { kind: "local", key: `local:${root}`, rootPath: root, displayName: "" } : null);
  if (!binding) return null;
  try {
    return (await window.ade.remoteRuntime.linkOwnership(binding)) ?? null;
  } catch {
    return null;
  }
}
