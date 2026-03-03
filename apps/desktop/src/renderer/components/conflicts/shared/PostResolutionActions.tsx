import { CheckCircle, XCircle, Warning, FileText } from "@phosphor-icons/react";
import { Button } from "../../ui/Button";
import { cn } from "../../ui/cn";

type PostResolutionActionsProps = {
  modifiedFiles?: string[];
  laneId: string | null;
  onRoutToLane?: () => void;
  onCommitAndOpenPr?: () => void;
  status?: "completed" | "failed" | "cancelled";
};

function StatusBadge({ status }: { status: PostResolutionActionsProps["status"] }) {
  if (!status) return null;

  const config = {
    completed: {
      icon: CheckCircle,
      label: "Completed",
      className: "bg-green-500/10 text-green-600 border-green-500/30"
    },
    failed: {
      icon: XCircle,
      label: "Failed",
      className: "bg-red-500/10 text-red-600 border-red-500/30"
    },
    cancelled: {
      icon: Warning,
      label: "Cancelled",
      className: "bg-amber-500/10 text-amber-600 border-amber-500/30"
    }
  }[status];

  const Icon = config.icon;

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-xs font-medium",
        config.className
      )}
    >
      <Icon size={14} />
      {config.label}
    </span>
  );
}

export function PostResolutionActions({
  modifiedFiles,
  laneId,
  onRoutToLane,
  onCommitAndOpenPr,
  status
}: PostResolutionActionsProps) {
  return (
    <div className="space-y-3">
      {/* Status badge */}
      <StatusBadge status={status} />

      {/* Modified files list */}
      {modifiedFiles && modifiedFiles.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium text-fg">
            Modified files ({modifiedFiles.length})
          </div>
          <div className="max-h-40 overflow-y-auto rounded-lg border border-border bg-card/60 p-2">
            <ul className="space-y-0.5">
              {modifiedFiles.map((file) => (
                <li
                  key={file}
                  className="flex items-center gap-1.5 text-xs text-muted-fg"
                >
                  <FileText size={12} className="shrink-0" />
                  <span className="truncate font-mono">{file}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {onRoutToLane && laneId && (
          <Button size="sm" variant="outline" onClick={onRoutToLane}>
            Route to Lane
          </Button>
        )}
        {onCommitAndOpenPr && (
          <Button size="sm" variant="primary" onClick={onCommitAndOpenPr}>
            Commit All + Open PR
          </Button>
        )}
      </div>
    </div>
  );
}
