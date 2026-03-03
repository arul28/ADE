import { Folder } from "@phosphor-icons/react";
import { useAppStore } from "../../state/appStore";
import { Button } from "../ui/Button";

export function ProjectSelector() {
  const project = useAppStore((s) => s.project);
  const openRepo = useAppStore((s) => s.openRepo);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Folder size={16} weight="regular" className="text-muted-fg" />
      <div className="min-w-0">
        <div className="truncate text-sm font-medium">{project?.displayName ?? "No project"}</div>
        <div className="truncate text-xs text-muted-fg">{project?.rootPath ?? "Select a repo in Phase 1 onboarding"}</div>
      </div>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          openRepo().catch(() => {
            // Non-fatal; the dialog may be canceled or repo selection may fail.
          });
        }}
        title="Open or change repo"
      >
        Change
      </Button>
    </div>
  );
}
