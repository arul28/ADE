import { computerReachLabel, copyComputers } from "../../../../shared/repositoryTab";
import { useActiveRepositoryTab } from "../../../state/repositoryScope";
import { useRepositoryCopies } from "../../../state/useRepositoryCopies";
import { requestCopiesMenu } from "../../projects/removeProjectRequest";

/**
 * The computers of the project in front, at the top of the project sidebar:
 * the Home row's chip (same style, same count, `copyComputers`), with a dot
 * that is green while one of them is reachable. It opens the read-only
 * "Computers with a copy" list, which the top bar owns. Nothing here moves the
 * tab: the tab already shows the work of every one of them.
 */
export function ProjectComputersTag() {
  const tab = useActiveRepositoryTab();
  const copies = useRepositoryCopies(tab);
  if (!tab) return null;
  const computers = copyComputers(copies);
  const { count, reachable } = computers;
  if (count === 0) return null;
  const label = computerReachLabel(computers);
  return (
    <button
      type="button"
      className="ade-welcome-machines-chip"
      aria-haspopup="menu"
      aria-label={`${label}. Show computers with a copy`}
      title={`${label}. Show computers with a copy`}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        requestCopiesMenu({ x: rect.left, y: rect.bottom + 4 });
      }}
    >
      <span className="kit-dot" data-state={reachable ? "ok" : undefined} aria-hidden />
      {count}
    </button>
  );
}
