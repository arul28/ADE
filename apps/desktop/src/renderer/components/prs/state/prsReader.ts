import { useMemo } from "react";
import type { MachineAddress, RepositoryTab } from "../../../../shared/repositoryTab";
import { useActiveRepositoryReader, useActiveRepositoryTab } from "../../../state/repositoryScope";

/** `owner/name` of a GitHub repository. */
export type PrsRepoRef = { owner: string; name: string };

/**
 * Where the PRs tab and the issue panes read the repository from.
 *
 * - `machine`: an online copy's machine. It holds the PR rows (lane links,
 *   snapshots) and reads GitHub with its own sign-in. While the tab has a
 *   copy it is the tab's copy, so every read goes where it went before.
 * - `none`: no machine is online. The surface shows its empty state and makes
 *   no call.
 *
 * The direct GitHub reader (the account's own GitHub sign-in, no machine) adds
 * a third kind here, `direct`, for the zero-machine case. Callers already
 * switch on `kind`, so it plugs in without touching them.
 */
export type PrsReader =
  | { kind: "machine"; pin: MachineAddress; repo: PrsRepoRef | null }
  | { kind: "none"; repo: PrsRepoRef | null };

/** The GitHub `owner/name` of a repository tab, from its current address. Null for a folder, or a repository not on github.com. */
export function repoRefForTab(tab: RepositoryTab | null): PrsRepoRef | null {
  if (!tab || tab.kind !== "account") return null;
  const address = tab.repoKeys[0]?.slice("repo:".length) ?? "";
  const [host, owner, name] = address.split("/");
  return host?.toLowerCase() === "github.com" && owner && name ? { owner, name } : null;
}

/** The reader of the open repository; held by `pin.key` and the repository, so effects keyed on it do not restart. */
export function usePrsReader(active = true): PrsReader {
  const pin = useActiveRepositoryReader(active);
  const tab = useActiveRepositoryTab();
  const repo = repoRefForTab(tab);
  const repoKey = repo ? `${repo.owner}/${repo.name}` : "";
  return useMemo<PrsReader>(
    () => (pin ? { kind: "machine", pin, repo } : { kind: "none", repo }),
    // `pin` is held by key (`useStableBinding`), and `repo` is rebuilt from the same text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pin, repoKey],
  );
}

/** The pin of a reader, or null when no machine reads for it. */
export function readerPin(reader: PrsReader): MachineAddress | null {
  return reader.kind === "machine" ? reader.pin : null;
}
