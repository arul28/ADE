/**
 * Repository tabs bound to ADE Cloud.
 *
 * A project tab binds to an own computer's copy when one is online. When none
 * is, the tab is bound to ADE Cloud (`shared/adeCloud/binding.ts`) and shows
 * the normal project tabs. When an own computer with a copy comes online, the
 * tab moves to that copy (`useAdeCloudTabFollowsCopy`), as a tab moves to
 * another copy when its computer leaves.
 */

import { useEffect, useRef } from "react";
import type { AccountProjectView } from "../../shared/accountProject";
import { isAdeCloudBinding, type AdeCloudBindingProject } from "../../shared/adeCloud/binding";
import { captureError } from "../../shared/sentry/capture";
import { useAppStore } from "./appStore";
import { useActiveRepositoryCopies } from "./repositoryScope";
import { readAccountProjectList } from "./useRepositoryCopies";

/** The GitHub address of an account project. */
function accountProjectOrigin(project: Pick<AccountProjectView, "host" | "owner" | "name">): string {
  return `https://${project.host || "github.com"}/${project.owner}/${project.name}`;
}

/** The ADE Cloud tab of an account project. */
export function adeCloudProjectOf(project: Pick<AccountProjectView, "id" | "host" | "owner" | "name">, displayName?: string | null): AdeCloudBindingProject {
  return {
    accountProjectId: project.id,
    displayName: displayName?.trim() || project.name,
    gitOriginUrl: accountProjectOrigin(project),
  };
}

/**
 * The ADE Cloud tab of a repository tab id: an account project id (`ap_…`),
 * or `repo:<host>/<owner>/<name>` before the account knows the repository.
 */
export function adeCloudProjectForTabId(tabId: string, displayName: string): AdeCloudBindingProject {
  const list = readAccountProjectList();
  const project = list.state === "ready" ? list.projects.find((entry) => entry.id === tabId) : undefined;
  if (project) return adeCloudProjectOf(project, displayName);
  const address = tabId.startsWith("repo:") ? tabId.slice("repo:".length) : null;
  return {
    accountProjectId: tabId,
    displayName,
    gitOriginUrl: address ? `https://${address}` : null,
  };
}

/**
 * While the tab in front is bound to ADE Cloud, an own computer with a copy
 * of its repository that comes online takes the tab. The page the person is
 * on stays (`carryWorkView`). A lane's own ADE Cloud computer never takes a
 * tab: ADE Cloud is already the tab's machine. One try per copy while it
 * stays online, so a copy that refuses the open does not loop. A copy that
 * goes offline is forgotten, so its next return tries again.
 */
export function useAdeCloudTabFollowsCopy(): void {
  const binding = useAppStore((state) => state.projectBinding);
  const busy = useAppStore((state) => state.projectTransition != null);
  const onAdeCloud = isAdeCloudBinding(binding);
  const copies = useActiveRepositoryCopies(onAdeCloud);
  const tried = useRef(new Set<string>());
  useEffect(() => {
    const online = new Set(copies.flatMap((entry) => (entry.online && entry.address ? [entry.address.key] : [])));
    for (const key of tried.current) {
      if (!online.has(key)) tried.current.delete(key);
    }
    if (!onAdeCloud || busy) return;
    const copy = copies.find((entry) => (
      entry.online && entry.address && !entry.isAdeCloud && !isAdeCloudBinding(entry.address) && !tried.current.has(entry.address.key)
    ));
    const address = copy?.address;
    if (!address) return;
    tried.current.add(address.key);
    const store = useAppStore.getState();
    const open = address.kind === "local"
      ? store.switchProjectToPath(address.rootPath, { carryWorkView: true })
      : store.switchRemoteProject(address.targetId, address.projectId, { carryWorkView: true });
    void Promise.resolve(open).catch((error: unknown) => {
      captureError(error, { fingerprint: ["repository-tabs", "ade-cloud-follow-copy"], level: "warning", handled: true });
    });
  }, [busy, copies, onAdeCloud]);
}
