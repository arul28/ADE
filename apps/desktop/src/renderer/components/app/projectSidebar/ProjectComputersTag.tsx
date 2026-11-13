import { computerCountLabel, copyComputers } from "../../../../shared/repositoryTab";
import { useActiveRepositoryTab } from "../../../state/repositoryScope";
import { useRepositoryCopies } from "../../../state/useRepositoryCopies";
import { requestCopiesMenu } from "../../projects/removeProjectRequest";

/**
 * The computers of the project in front, at the top of the project sidebar:
 * the Home row's chip (same style, same count, `copyComputers`), with a dot
 * that is green while one of them is reachable. It opens the copies menu,
 * which the top bar owns. With the tab's own chip gone, this is the visible
 * way to the copies besides the tab's right-click menu.
 */
export function ProjectComputersTag() {
  const tab = useActiveRepositoryTab();
  const copies = useRepositoryCopies(tab);
  if (!tab) return null;
  const { count, reachable } = copyComputers(copies);
  if (count === 0) return null;
  const label = computerCountLabel(count);
  return (
    <button
      type="button"
      className="ade-welcome-machines-chip"
      aria-haspopup="menu"
      aria-label={`On ${label}${reachable ? ", reachable now" : ", none reachable now"}. Show copies`}
      title={`On ${label}${reachable ? "" : ", none reachable now"}. Show copies`}
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
