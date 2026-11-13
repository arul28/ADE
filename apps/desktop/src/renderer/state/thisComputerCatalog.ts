/**
 * This computer's folders as its brain registers them (the catalog). The
 * desktop's recents stop at 24; the catalog has every folder. Home, the
 * copies menu, the sidebar and Settings › Location read this one store, so a
 * folder one of them counts as this computer's copy is one all of them list.
 * Desktop only: ADE Web has no brain of its own.
 */
import { useSyncExternalStore } from "react";
import { captureError } from "../../shared/sentry/capture";
import type { RecentProjectSummary } from "../../shared/types";
import { normalizePathForComparison } from "../lib/pathUtils";

const NO_FOLDERS: readonly RecentProjectSummary[] = [];
let folders: readonly RecentProjectSummary[] = NO_FOLDERS;
const listeners = new Set<() => void>();
let reading = false;
let readAgain = false;

/** The same folders in the same order: a read that changes nothing keeps the list that shows. */
function sameFolders(a: readonly RecentProjectSummary[], b: readonly RecentProjectSummary[]): boolean {
  return a.length === b.length && a.every((folder, index) => {
    const other = b[index]!;
    return folder.rootPath === other.rootPath
      && folder.displayName === other.displayName
      && folder.lastOpenedAt === other.lastOpenedAt
      && (folder.gitOriginUrl ?? null) === (other.gitOriginUrl ?? null);
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot(): readonly RecentProjectSummary[] {
  return folders;
}

/**
 * Reads the catalog again. One read at a time: a call during a read runs one
 * more read after it, so a forget or a remove made during a read is seen.
 * A failed read keeps the last catalog.
 */
export function readThisComputerCatalog(): void {
  const read = window.ade?.project?.listThisComputer;
  if (typeof read !== "function") return;
  if (reading) {
    readAgain = true;
    return;
  }
  reading = true;
  void Promise.resolve(read())
    .then((next) => {
      if (sameFolders(folders, next)) return;
      folders = next;
      for (const listener of listeners) listener();
    }, (error: unknown) => {
      captureError(error, { fingerprint: ["home-projects", "this-computer-folders-read"], level: "warning", handled: true });
    })
    .finally(() => {
      reading = false;
      if (!readAgain) return;
      readAgain = false;
      readThisComputerCatalog();
    });
}

/** The catalog as last read, without a read of its own. Empty when `desktop` is false. */
export function useThisComputerCatalog(desktop: boolean): readonly RecentProjectSummary[] {
  const current = useSyncExternalStore(subscribe, snapshot, snapshot);
  return desktop ? current : NO_FOLDERS;
}

/** The recents, then each catalog folder the recents do not have (the recents keep order and pins). */
export function withCatalogFolders(
  recents: readonly RecentProjectSummary[],
  catalog: readonly RecentProjectSummary[],
): readonly RecentProjectSummary[] {
  if (catalog.length === 0) return recents;
  // Windows and macOS paths differ in case between two writers; compare by the shared key.
  const listed = new Set(recents.filter((recent) => recent.kind !== "remote").map((recent) => normalizePathForComparison(recent.rootPath)));
  const extra = catalog.filter((folder) => !listed.has(normalizePathForComparison(folder.rootPath)));
  return extra.length > 0 ? [...recents, ...extra] : recents;
}
