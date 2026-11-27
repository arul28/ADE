import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle, Circle, FolderSimple, FolderSimplePlus } from "@phosphor-icons/react";
import { Dialog } from "../ui/dialog";
import { Banner } from "../ui/notice";
import { MENU_ITEM_CLASS } from "../ui/MenuSubmenu";
import { copyJobKey, startCopyJob, useCopyJobs, watchCopyJobs } from "./projectCopyJobs";
import { joinMachinePath, readMachineDefaultParentDir, type CopyOpenTarget } from "./projectCopies";
import { pathFlavorOf } from "../../../shared/pathCase";
import { normalizePathForComparison } from "../../lib/pathUtils";

/** The folder that holds `path`, in that machine's own spelling; null at a root. */
function parentFolderOf(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const windows = pathFlavorOf(trimmed) === "win32";
  const index = Math.max(trimmed.lastIndexOf("/"), windows ? trimmed.lastIndexOf("\\") : -1);
  if (index <= 0) return null;
  const parent = trimmed.slice(0, index);
  // `C:` alone is the drive's root: keep its separator.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}\\` : parent;
}

const LAST_FOLDER_KEY = "ade.cloneFolder.byMachine.v1";

function readLastFolders(): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(LAST_FOLDER_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The folder a clone on this machine used last, remembered per machine. */
function lastCloneFolder(machineId: string): string | null {
  const value = readLastFolders()[machineId];
  return typeof value === "string" && value.trim() ? value : null;
}

function rememberCloneFolder(machineId: string, folder: string): void {
  try {
    window.localStorage.setItem(LAST_FOLDER_KEY, JSON.stringify({ ...readLastFolders(), [machineId]: folder }));
  } catch {
    // This window's copy only.
  }
}

export type CloneDialogMachine = {
  /** The job's machine id (a remote target id, or this computer's id). */
  machineId: string;
  name: string;
  /** Null for this computer. Every call of the clone goes to this target. */
  targetId: string | null;
};

/**
 * Clone a project onto one of the account's machines before a chat runs
 * there. It looks like the "Computers with a copy" list: folder rows on that
 * machine (the last one used there, the folders of its other projects, its
 * default folder), "Other folder…", and the full path the clone goes to. The
 * clone runs as the first step (`startCopyJob`), on that machine's own
 * connection. A failure keeps the dialog open with Retry and Change folder,
 * and the message is not sent.
 */
export function CloneToMachineDialog({
  open,
  machine,
  repoKey,
  url,
  repoName,
  otherProjectPaths,
  confirmLabel = "Clone & send",
  sendsMessage = true,
  onCancel,
  onReady,
}: {
  open: boolean;
  machine: CloneDialogMachine;
  repoKey: string;
  url: string;
  repoName: string;
  /** Folders of other projects on that machine: their parents are suggested. */
  otherProjectPaths: readonly string[];
  confirmLabel?: string;
  /** A message waits on the clone (the composer), or the project just opens after it (the project page). */
  sendsMessage?: boolean;
  onCancel: () => void;
  /** The copy is there: send the message to it. */
  onReady: (target: CopyOpenTarget) => void;
}) {
  const [defaultFolder, setDefaultFolder] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(() => lastCloneFolder(machine.machineId));
  const [otherOpen, setOtherOpen] = useState(false);
  const [otherValue, setOtherValue] = useState("");
  useEffect(() => (open ? watchCopyJobs(repoKey) : undefined), [open, repoKey]);
  const job = useCopyJobs(repoKey).find((entry) => entry.key === copyJobKey(repoKey, machine.machineId)) ?? null;
  const cloning = job?.status === "cloning";
  const failed = job?.status === "failed" ? job : null;

  // The machine's own default folder, read once on that machine's connection.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void readMachineDefaultParentDir(machine.targetId).then((value) => {
      if (!cancelled && value) setDefaultFolder(value);
    });
    return () => {
      cancelled = true;
    };
  }, [machine.targetId, open]);

  const rows = useMemo(() => {
    const seen = new Set<string>();
    const list: Array<{ folder: string; why: string }> = [];
    const add = (folder: string | null, why: string) => {
      if (!folder) return;
      // Windows folds case; a Linux folder name is its own.
      const key = normalizePathForComparison(folder);
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ folder, why });
    };
    add(lastCloneFolder(machine.machineId), "Last used here");
    for (const path of otherProjectPaths) add(parentFolderOf(path), "Has other projects");
    add(defaultFolder, "Default folder");
    return list.slice(0, 5);
  }, [defaultFolder, machine.machineId, otherProjectPaths]);

  // "Other folder…" with nothing typed has no folder: Clone stays off.
  const folder = otherOpen ? otherValue.trim() || null : picked || rows[0]?.folder || null;
  useEffect(() => {
    if (!picked && rows[0]) setPicked(rows[0].folder);
  }, [picked, rows]);

  // A failed try may still hold its ready callback: send once, whichever run lands.
  const sentRef = useRef(false);
  useEffect(() => {
    if (open) sentRef.current = false;
  }, [open]);
  // The clone finishes after the dialog closes, but a closed dialog opens nothing over where the person went.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const start = () => {
    if (!folder) return;
    rememberCloneFolder(machine.machineId, folder);
    // A failed job runs again with the folder picked now.
    startCopyJob({ repoKey, url, name: repoName, parentDir: folder, displayName: repoName, machine }, (target) => {
      if (sentRef.current || !mountedRef.current) return;
      sentRef.current = true;
      onReady(target);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !cloning) onCancel();
      }}
      title={`Clone ${repoName} on ${machine.name}`}
      description={sendsMessage ? "It has no copy yet. ADE clones it there, then sends your message." : "It has no copy yet. ADE clones it there, then opens it."}
      size="sm"
      actions={[
        { label: cloning ? "Cloning…" : failed ? "Retry" : confirmLabel, onClick: start, busy: cloning, disabled: cloning || !folder },
        { label: "Cancel", onClick: onCancel, disabled: cloning },
      ]}
    >
      <div className="flex flex-col gap-2">
        <div role="radiogroup" aria-label={`Folders on ${machine.name}`} className="flex flex-col">
          {rows.map((row) => {
            const selected = !otherOpen && folder === row.folder;
            return (
              <button
                key={row.folder}
                type="button"
                role="radio"
                aria-checked={selected}
                className={MENU_ITEM_CLASS}
                disabled={cloning}
                onClick={() => {
                  setOtherOpen(false);
                  setPicked(row.folder);
                }}
              >
                {selected ? <CheckCircle size={14} weight="fill" style={{ color: "var(--color-accent)" }} aria-hidden /> : <Circle size={14} aria-hidden style={{ color: "var(--kit-text-3)" }} />}
                <FolderSimple size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate" title={row.folder}>{row.folder}</span>
                  <span className="text-[10.5px]" style={{ color: "var(--kit-text-3)" }}>{row.why}</span>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="radio"
            aria-checked={otherOpen}
            className={MENU_ITEM_CLASS}
            disabled={cloning}
            onClick={() => setOtherOpen(true)}
          >
            {otherOpen ? <CheckCircle size={14} weight="fill" style={{ color: "var(--color-accent)" }} aria-hidden /> : <Circle size={14} aria-hidden style={{ color: "var(--kit-text-3)" }} />}
            <FolderSimplePlus size={13} aria-hidden style={{ color: "var(--kit-text-3)" }} />
            <span>Other folder…</span>
          </button>
          {otherOpen ? (
            <input
              className="kit-input mx-3 mt-1"
              data-size="sm"
              autoFocus
              spellCheck={false}
              placeholder={rows[0]?.folder && pathFlavorOf(rows[0].folder) === "win32" ? "C:\\Users\\you\\code" : "~/code"}
              aria-label="Folder on that machine"
              value={otherValue}
              onChange={(event) => setOtherValue(event.target.value)}
            />
          ) : null}
        </div>
        {folder ? (
          <p className="m-0 truncate text-[11.5px]" style={{ color: "var(--kit-text-2)" }} title={joinMachinePath(folder, repoName)}>
            Clones to <span className="font-mono">{joinMachinePath(folder, repoName)}</span>
          </p>
        ) : null}
        {failed ? (
          <Banner
            layout="inline"
            model={{
              id: `clone-to-machine-${failed.key}`,
              tone: "error",
              title: `Couldn't clone on ${machine.name}`,
              detail: `${failed.failure?.reason ?? "The machine didn't say why."}${sendsMessage ? " Your message is not sent." : ""} Retry, or pick another folder.`,
              actions: [{ label: "Change folder", onClick: () => setOtherOpen(true) }],
            }}
          />
        ) : null}
      </div>
    </Dialog>
  );
}
