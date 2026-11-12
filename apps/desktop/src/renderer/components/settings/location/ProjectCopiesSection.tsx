import { useEffect, useMemo, useState } from "react";
import { CheckCircle, CircleNotch, Desktop, Plus, XCircle } from "@phosphor-icons/react";
import { THIS_MACHINE_ID } from "../../../../shared/machineIdentity";
import type { RepositoryCopy } from "../../../../shared/repositoryTab";
import { repositoryTabForBinding, useActiveRepositoryTab } from "../../../state/repositoryScope";
import { useAccountProjectList, useRepositoryCopies, useStartOn } from "../../../state/useRepositoryCopies";
import { useAppStore } from "../../../state/appStore";
import { originUrlForBinding } from "../../lanes/laneMachines";
import { isWebClientMode } from "../../../lib/webClientMode";
import { ModernRow, ModernRows, ModernSection } from "../primitives";
import { repoKeyForOriginIdentity } from "../../projects/projectCopies";
import { retryCopyJob, startCopyJob, subscribeCopyJobReady, useCopyJobs, watchCopyJobs, type CopyJob } from "../../projects/projectCopyJobs";
import { PROJECT_COPIES_CHANGED_EVENT, requestRemoveProject } from "../../projects/removeProjectRequest";

/** The binding key the tab bar gives a copy: a local folder by its path, a remote copy by its binding key. */
function tabBindingKey(copy: RepositoryCopy): string | null {
  if (!copy.address) return null;
  return copy.address.kind === "local" ? copy.address.rootPath : copy.address.key;
}

function CopyStateDot({ online }: { online: boolean }) {
  return <span className="kit-dot" data-state={online ? "ok" : undefined} aria-hidden style={{ flexShrink: 0 }} />;
}

/**
 * Settings → Project → Location, the copies (S13b): every computer that has
 * this project, where its folder is, which copy is main, and which computers
 * could take a copy. Remove opens the same window as the tab's menu, on that
 * one copy. Add a copy clones on that computer with its default folder.
 *
 * Remote machines: each row's action goes to its own machine (the copy's
 * address, or the clone job's target). An offline machine is never called;
 * its row says its folder stays.
 */
export function ProjectCopiesSection() {
  // This computer's project list is read on mount and on window focus. A
  // removal or a finished copy in this window changes it with no focus, so
  // the list mounts again and reads it.
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    const bump = () => setGeneration((value) => value + 1);
    window.addEventListener(PROJECT_COPIES_CHANGED_EVENT, bump);
    const stopJobs = subscribeCopyJobReady(bump);
    return () => {
      window.removeEventListener(PROJECT_COPIES_CHANGED_EVENT, bump);
      stopJobs();
    };
  }, []);
  return <ProjectCopiesList key={generation} />;
}

function ProjectCopiesList() {
  const webMode = isWebClientMode();
  const scopeTab = useActiveRepositoryTab();
  const binding = useAppStore((state) => state.projectBinding);
  const list = useAccountProjectList();
  // A local project's binding is built before the recents tell its origin, so
  // the scope tab can say "this computer only" for a GitHub repository. The
  // origin the recents remember puts the tab back on its repository.
  const rememberedOrigin = scopeTab?.kind === "this_computer_only" && binding?.kind === "local" && !binding.gitOriginUrl
    ? originUrlForBinding(binding)
    : null;
  const tab = useMemo(
    () => (rememberedOrigin && binding ? repositoryTabForBinding({ ...binding, gitOriginUrl: rememberedOrigin }, list) : scopeTab),
    [binding, list, rememberedOrigin, scopeTab],
  );
  const copies = useRepositoryCopies(tab);
  const { choices } = useStartOn(tab);
  const repoKey = tab?.kind === "account" ? repoKeyForOriginIdentity(tab.repoKeys[0]?.slice("repo:".length) ?? null) : null;
  useEffect(() => (repoKey ? watchCopyJobs(repoKey) : undefined), [repoKey]);
  const jobs = useCopyJobs(repoKey);

  // Computers that are online and have no copy: "Start on" lists them as
  // "clone first". ADE Cloud is not one (a lane computer is never a copy).
  const cloneable = useMemo(
    () => choices.flatMap((choice) => (choice.kind === "clone" ? [choice] : [])),
    [choices],
  );
  const shownCopies = useMemo(() => copies.filter((copy) => !copy.isAdeCloud), [copies]);
  const jobFor = (machineId: string): CopyJob | null =>
    jobs.find((job) => job.machine.machineId === machineId) ?? null;
  const inUseKey = binding?.kind === "remote" ? binding.key : binding?.rootPath ?? null;

  if (!tab) return null;

  const addCopy = (machineId: string, machineName: string) => {
    if (!repoKey) return;
    const name = repoKey.split("/").pop() ?? tab.displayName;
    startCopyJob({
      repoKey,
      url: `https://${repoKey}`,
      name,
      parentDir: null,
      displayName: name,
      machine: { machineId, name: machineName, targetId: machineId === THIS_MACHINE_ID ? null : machineId },
    });
  };

  return (
    <ModernSection
      group="Project"
      anchor="project-copies"
      title="Copies"
      hint="Each computer keeps its own folder of this project. New lanes start in the main one."
      actions={inUseKey && !webMode ? (
        <button
          type="button"
          className="ade-modern-btn ade-modern-btn-danger"
          onClick={() => requestRemoveProject({ kind: "copy", bindingKey: inUseKey })}
        >
          Remove project…
        </button>
      ) : undefined}
    >
      <ModernRows>
        {shownCopies.length === 0 && cloneable.length === 0 ? (
          <ModernRow title="No copy yet" hint="No computer has a folder of this project." />
        ) : null}
        {shownCopies.map((copy) => {
          const key = tabBindingKey(copy);
          return (
            <ModernRow
              key={`${copy.machineId}\n${copy.rootPath}`}
              leading={<CopyStateDot online={copy.online} />}
              title={(
                <span style={{ display: "inline-flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {copy.isThisMachine && !/^this computer$/i.test(copy.machineName.trim())
                      ? `${copy.machineName} (this computer)`
                      : copy.machineName}
                  </span>
                  {copy.isMain ? <span className="kit-tag" data-tone="accent">Main</span> : null}
                  {key && key === inUseKey ? <span className="kit-tag">Open here</span> : null}
                </span>
              )}
              hint={(
                <span style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <code title={copy.rootPath} style={{ overflowWrap: "anywhere" }}>{copy.rootPath}</code>
                  {copy.online ? null : <span>Offline. The folder stays where it is.</span>}
                </span>
              )}
              control={copy.online && key && !webMode ? (
                <button
                  type="button"
                  className="ade-modern-btn"
                  onClick={() => requestRemoveProject({
                    kind: "copy",
                    bindingKey: key,
                    copy: {
                      machine: {
                        machineId: copy.machineId,
                        name: copy.machineName,
                        targetId: copy.isThisMachine ? null : copy.machineId,
                        isLocal: copy.isThisMachine,
                        online: copy.online,
                      },
                      rootPath: copy.rootPath,
                      bindingKey: key,
                      projectId: copy.isThisMachine ? null : copy.checkoutId,
                    },
                  })}
                >
                  Remove…
                </button>
              ) : undefined}
            />
          );
        })}
        {repoKey && !webMode
          ? cloneable.map((choice) => {
            const job = jobFor(choice.machineId);
            return (
              <ModernRow
                key={`clone\n${choice.machineId}`}
                leading={<Desktop size={14} aria-hidden style={{ opacity: 0.6, flexShrink: 0 }} />}
                title={choice.machineName}
                hint={job?.status === "failed"
                  ? <span style={{ color: "var(--kit-crit)" }}>{job.failure?.reason ?? "The copy could not be added."}</span>
                  : job?.status === "cloning"
                    ? "Adding a copy in its default folder…"
                    : job?.status === "ready"
                      ? "Copy added."
                      : "No copy on this computer."}
                control={job?.status === "cloning" ? (
                  <CircleNotch size={14} weight="bold" className="animate-spin" aria-label="Adding a copy" />
                ) : job?.status === "ready" ? (
                  <CheckCircle size={14} weight="fill" style={{ color: "var(--kit-ok)" }} aria-label="Copy added" />
                ) : (
                  <button
                    type="button"
                    className="ade-modern-btn"
                    onClick={() => (job?.status === "failed" ? retryCopyJob(job.key) : addCopy(choice.machineId, choice.machineName))}
                  >
                    {job?.status === "failed" ? <XCircle size={12} aria-hidden /> : <Plus size={12} aria-hidden />}
                    {job?.status === "failed" ? "Try again" : "Add a copy"}
                  </button>
                )}
              />
            );
          })
          : null}
      </ModernRows>
    </ModernSection>
  );
}
