/**
 * Where a machine's page will show what the personal-mesh work adds about a
 * machine (lane `8fbb5263`): what it can do, how often work should go to it,
 * and the copies of other machines' work it holds. Each one renders nothing
 * until a real source hands it data — no placeholders, no invented values.
 *
 * Shapes mirror that lane's names where it has them (`RemoteWorkCopy` in
 * `main/services/remoteWork/remoteWorkCopyService.ts`); the rest are the
 * smallest shape the page needs and are expected to be replaced by theirs.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GitBranch } from "@phosphor-icons/react";
import type { OpenProjectBinding } from "../../../../shared/types";
import type { RemoteWorkCopyListing } from "../../../../shared/types/remoteWork";
import { remoteProjectBindingKey } from "../../../../shared/projectIdentity";
import { relativeWhen } from "../../../lib/format";
import { showToast } from "../../app/toast/toastStore";
import { confirmDialog } from "../../ui/dialog/confirm";
import { formatBytes } from "../storage/storageView";

/** What a machine can run, as its brain reports it. */
export type MachineCapabilities = {
  /** CLIs signed in there, by provider id. */
  signedInClis?: readonly string[];
  /** Xcode and simulators, on a Mac. */
  xcode?: { version: string | null; simulators: number } | null;
  os?: string | null;
  disk?: { freeBytes: number; totalBytes: number } | null;
  runningBuilds?: number;
  warmCaches?: readonly string[];
  /** 1-minute load average over core count, 0–1+. */
  load?: number | null;
};

/** How often other machines should send work here. */
export type MachinePreference = "prefer" | "normal" | "less-often" | "manual";

/** A copy of another machine's work kept here: `remote_work.list` (`RemoteWorkCopyListing`). */
export type MachineWorkCopy = RemoteWorkCopyListing;

/** The capability map, once a machine reports one. */
export function MachineCapabilitiesArea({ capabilities }: { capabilities: MachineCapabilities | null }): ReactNode {
  if (!capabilities) return null;
  return null;
}

/** The "Prefer / Normal / Less often / Manual" row, once it can be read and set. */
export function MachinePreferenceRow({ preference }: { preference: MachinePreference | null }): ReactNode {
  if (!preference) return null;
  return null;
}

/**
 * "Work from other machines": the copies this machine keeps for chats on other
 * machines (`ade shell start --machine`, `ade apple … --machine`), with their
 * size and Delete. Read through the machine's pin; nothing when there are none
 * or the machine cannot be reached. Copies also go by themselves (a week
 * unused, the chat deleted or archived, low disk), so this is for clearing
 * space now.
 */
export function MachineWorkCopies({
  pin,
  reach,
  isThisMachine,
}: {
  pin: OpenProjectBinding | null;
  reach: boolean;
  /** The page is This computer: only then may a copy in another project get a local pin. */
  isThisMachine: boolean;
}): ReactNode {
  const [copies, setCopies] = useState<MachineWorkCopy[] | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const pinKey = pin?.key ?? null;
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!reach || !window.ade?.remoteWork?.list) {
      setCopies(null);
      return undefined;
    }
    let cancelled = false;
    void window.ade.remoteWork.list(pinRef.current)
      .then((rows) => { if (!cancelled) setCopies(rows); })
      // An older ADE there has no such action: show nothing, as with none.
      .catch(() => { if (!cancelled) setCopies(null); });
    return () => { cancelled = true; };
  }, [reach, pinKey, epoch]);
  if (!copies || copies.length === 0) return null;

  const remove = async (copy: MachineWorkCopy) => {
    const ok = await confirmDialog({
      title: `Delete the work copy for a chat on ${copy.machineName ?? "another machine"}?`,
      message: "Its folder, installed packages and build output are deleted here. Pushed work is safe; anything not pushed from this copy is lost. The chat makes a new copy the next time it runs a command here.",
      confirmLabel: "Delete",
      tone: "error",
    });
    if (!ok) return;
    const target = pinForCopy(pinRef.current, copy, isThisMachine);
    if (target === "unreachable") return;
    setDeleting(copy.owner);
    try {
      await window.ade.remoteWork.delete({ owner: copy.owner, projectId: copy.projectId }, target);
      setEpoch((value) => value + 1);
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't delete the work copy", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDeleting(null);
    }
  };

  return (
    <section className="ade-mx-group">
      <h2 className="kit-eyebrow ade-mx-group-title">Work from other machines</h2>
      <div className="ade-mx-group-rows">
        {copies.map((copy) => {
          const unreachable = pinForCopy(pin, copy, isThisMachine) === "unreachable";
          return (
          <div key={copy.owner} className="ade-mx-srow">
            <span className="ade-mx-srow-icon" aria-hidden><GitBranch size={14} /></span>
            <span className="ade-mx-srow-text">
              <span className="ade-mx-srow-title">
                {copy.machineName ? `Chat on ${copy.machineName}` : "Chat on another machine"}
                {copy.branch ? ` · ${copy.branch}` : ""}
              </span>
              <span className="ade-mx-srow-value">
                {[
                  copy.sizeBytes == null ? "Size unknown" : formatBytes(copy.sizeBytes),
                  `used ${relativeWhen(copy.lastUsedAt)}`,
                  copy.running ? "a command is running" : null,
                ].filter(Boolean).join(" · ")}
              </span>
            </span>
            <span className="ade-mx-srow-control">
              <button
                type="button"
                className="ade-mx-srow-link disabled:cursor-not-allowed disabled:opacity-40"
                disabled={deleting !== null || copy.running === true || unreachable}
                title={copy.running
                  ? "A command still runs in this copy. Stop it first."
                  : unreachable
                    ? "This copy is in another project there. Delete it from that project's tab."
                    : undefined}
                onClick={() => { void remove(copy); }}
              >
                {deleting === copy.owner ? "Deleting…" : "Delete"}
              </button>
            </span>
          </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * The pin for the project that holds `copy` on the page's machine: delete
 * runs in that project. "unreachable" when no pin can be built without
 * guessing: a local pin is only ever built for This computer, so a delete can
 * never fall through to this computer while the page names another machine.
 */
function pinForCopy(
  pagePin: OpenProjectBinding | null,
  copy: MachineWorkCopy,
  isThisMachine: boolean,
): OpenProjectBinding | null | "unreachable" {
  const displayName = copy.projectRoot.split(/[\\/]/).pop() || copy.projectRoot;
  if (pagePin?.kind === "remote") {
    if (!copy.projectId || pagePin.projectId === copy.projectId) return pagePin;
    return {
      ...pagePin,
      key: remoteProjectBindingKey(pagePin.targetId, copy.projectId),
      projectId: copy.projectId,
      rootPath: copy.projectRoot,
      displayName,
    };
  }
  if (!isThisMachine) {
    // Another machine reached without a remote pin: only its own project's copy, unpinned.
    return pagePin == null && copy.projectId == null ? null : "unreachable";
  }
  if (pagePin?.kind === "local" && pagePin.rootPath === copy.projectRoot) return pagePin;
  return { kind: "local", key: copy.projectRoot, rootPath: copy.projectRoot, displayName };
}
