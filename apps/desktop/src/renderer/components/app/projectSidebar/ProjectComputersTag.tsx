import { Desktop } from "@phosphor-icons/react";
import { computerCountLabel, copyComputers } from "../../../../shared/repositoryTab";
import { useActiveRepositoryTab } from "../../../state/repositoryScope";
import { useRepositoryCopies } from "../../../state/useRepositoryCopies";
import { requestCopiesMenu } from "../../projects/removeProjectRequest";

/**
 * The computers of the project in front, on the project page: how many have
 * a copy (the shared count, `copyComputers`, the same number as Home and
 * Settings › Location) and a dot that is green while one of them is
 * reachable. It opens the copies menu, which the top bar owns.
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
      className="ade-project-sidebar-footer-item ade-project-sidebar-computers"
      aria-haspopup="menu"
      aria-label={`On ${label}. Show copies`}
      title={`On ${label}${reachable ? "" : ", none reachable now"}. Show copies`}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        requestCopiesMenu({ x: rect.left, y: rect.top });
      }}
    >
      <span className="relative inline-flex shrink-0">
        <Desktop size={15} weight="regular" />
        <span className="kit-dot ade-project-sidebar-computers-dot" data-state={reachable ? "ok" : undefined} aria-hidden />
      </span>
      <span className="kit-num">{count}</span>
    </button>
  );
}
