import React, { useState } from "react";
import { GitCommit } from "@phosphor-icons/react";
import type { GitCommitSummary, PrFile } from "../../../../shared/types";
import { relativeTimeCompact } from "../../../lib/format";
import { ProviderLogo } from "../../shared/ProviderLogos";
import { cn } from "../../ui/cn";
import { COLORS, MONO_FONT } from "../laneDesignTokens";
import { providerFromAuthorName } from "./laneHistoryModel";
import { capRows } from "./laneOverviewModel";
import { OVERVIEW_ROW, OVERVIEW_ROW_HOVER, OVERVIEW_TIME, OverviewSection, RENAMED_COLOR, ShowAllButton } from "./sectionUi";

/** Rows shown before "Show all". */
export const LANE_CHANGES_CAP = 10;

const FILE_STATUS: Record<PrFile["status"], { letter: string; color: string; label: string }> = {
  added: { letter: "A", color: COLORS.success, label: "Added" },
  removed: { letter: "D", color: COLORS.danger, label: "Deleted" },
  modified: { letter: "M", color: COLORS.warning, label: "Modified" },
  renamed: { letter: "R", color: RENAMED_COLOR, label: "Renamed" },
  copied: { letter: "C", color: RENAMED_COLOR, label: "Copied" },
};

function splitPath(path: string): { dir: string; name: string } {
  const index = path.lastIndexOf("/");
  return index < 0 ? { dir: "", name: path } : { dir: path.slice(0, index + 1), name: path.slice(index + 1) };
}

function FileRow({ file, onOpen }: { file: PrFile; onOpen: (path: string) => void }) {
  const status = FILE_STATUS[file.status] ?? FILE_STATUS.modified;
  const { dir, name } = splitPath(file.filename);
  const removed = file.status === "removed";
  return (
    <button
      type="button"
      className={cn(OVERVIEW_ROW, removed ? "cursor-default" : OVERVIEW_ROW_HOVER, "h-8 text-[12.5px]")}
      onClick={removed ? undefined : () => onOpen(file.filename)}
      title={removed ? `${file.filename} (deleted)` : `Open ${file.filename} in Files`}
      data-testid="lane-change-file"
    >
      <span className="w-4 shrink-0 text-center text-[11px] font-semibold" style={{ color: status.color, fontFamily: MONO_FONT }} title={status.label}>
        {status.letter}
      </span>
      <span className="flex min-w-0 flex-1 items-baseline">
        <span className="min-w-0 truncate text-muted-fg/60" style={{ direction: "rtl", textAlign: "left" }}>
          <bdi>{dir}</bdi>
        </span>
        <span className={cn("shrink-0 text-fg/90", removed && "text-fg/55 line-through")}>{name}</span>
      </span>
      {/* Two fixed columns, so + and − line up down the list. */}
      <span className="flex shrink-0 text-[11.5px] tabular-nums" style={{ fontFamily: MONO_FONT }}>
        <span className="w-12 text-right" style={{ color: COLORS.success }}>{file.additions > 0 ? `+${file.additions}` : ""}</span>
        <span className="w-12 text-right" style={{ color: COLORS.danger }}>{file.deletions > 0 ? `−${file.deletions}` : ""}</span>
      </span>
    </button>
  );
}

function CommitRow({
  commit,
  provider,
  onSelect,
}: {
  commit: GitCommitSummary;
  provider: string | null;
  onSelect: (commit: GitCommitSummary) => void;
}) {
  return (
    <button
      type="button"
      className={cn(OVERVIEW_ROW, OVERVIEW_ROW_HOVER, "h-8 text-[12.5px]")}
      onClick={() => onSelect(commit)}
      title={`${commit.shortSha} · ${commit.subject}`}
      data-testid="lane-change-commit"
    >
      <span className="flex w-4 shrink-0 justify-center">
        <GitCommit size={14} weight="bold" style={{ color: commit.pushed ? COLORS.textMuted : COLORS.warning }} aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate text-fg/90">{commit.subject}</span>
      <span className="shrink-0 text-[11.5px] tabular-nums text-muted-fg/60" style={{ fontFamily: MONO_FONT }}>{commit.shortSha}</span>
      <span className="inline-flex max-w-[140px] shrink-0 items-center gap-1.5 text-[11.5px] text-muted-fg/70">
        {provider ? <ProviderLogo family={provider} size={12} /> : null}
        <span className="truncate">{commit.authorName}</span>
      </span>
      <span className={OVERVIEW_TIME}>{relativeTimeCompact(commit.authoredAt)}</span>
    </button>
  );
}

/**
 * What the lane changes. With an open PR, the PR's files (clicking one opens
 * it in the Files tab); otherwise the commits ahead of the base (clicking one
 * shows it in the Git pane).
 */
export function LaneChangesSection(
  props:
    | { kind: "pr-files"; files: PrFile[]; onOpenFile: (path: string) => void }
    | {
      kind: "commits";
      commits: GitCommitSummary[];
      baseLabel: string;
      trailerProviderBySha: ReadonlyMap<string, string | null>;
      onSelectCommit: (commit: GitCommitSummary) => void;
    },
) {
  const [expanded, setExpanded] = useState(false);
  if (props.kind === "pr-files") {
    const { visible, hidden } = capRows(props.files, expanded, LANE_CHANGES_CAP);
    return (
      <OverviewSection title="Files changed" count={props.files.length} testId="lane-changes-section" collapseKey="changes">
        {visible.map((file) => <FileRow key={file.filename} file={file} onOpen={props.onOpenFile} />)}
        <ShowAllButton hidden={hidden} onClick={() => setExpanded(true)} label={`Show all ${props.files.length}`} testId="lane-changes-show-all" />
      </OverviewSection>
    );
  }
  const { visible, hidden } = capRows(props.commits, expanded, LANE_CHANGES_CAP);
  return (
    <OverviewSection
      title={`Commits ahead of ${props.baseLabel}`}
      count={props.commits.length}
      testId="lane-changes-section"
      collapseKey="changes"
    >
      {visible.map((commit) => (
        <CommitRow
          key={commit.sha}
          commit={commit}
          provider={props.trailerProviderBySha.get(commit.sha) ?? providerFromAuthorName(commit.authorName)}
          onSelect={props.onSelectCommit}
        />
      ))}
      <ShowAllButton hidden={hidden} onClick={() => setExpanded(true)} label={`Show all ${props.commits.length}`} testId="lane-changes-show-all" />
    </OverviewSection>
  );
}
