import React from "react";
import { Box, Text } from "ink";
import type {
  AdeCodeProvider,
  ProviderReadinessRow,
  RightPaneContent,
  SetupPaneRow,
  SubagentSnapshot,
} from "../types";
import { theme } from "../theme";
import { useSpinFrame } from "../spinTick";
import { buildSubagentPaneRows, type SubagentPaneRow, type SubagentPaneSection } from "../subagentPane";

// ---------------------------------------------------------------------------
// Right-pane width / focus chrome
// ---------------------------------------------------------------------------

const DEFAULT_PANE_WIDTH = 38;
const LANE_LABEL_WIDTH = 10;
const LANE_FILE_PREVIEW_ROWS = 5;
const MODEL_LABEL_WIDTH = 14;
const PROVIDER_ORDER: AdeCodeProvider[] = ["claude", "codex", "cursor", "droid", "opencode"];

// ---------------------------------------------------------------------------
// Actions for the lane-details pane (5 rows · wireframe)
// ---------------------------------------------------------------------------

export const LANE_DETAIL_ACTIONS: ReadonlyArray<{
  k: string;
  label: string;
  slashCommand: string;
  detail?: string;
}> = [
  { k: "a", label: "stage all", slashCommand: "/stage all" },
  { k: "c", label: "commit", slashCommand: "/commit", detail: "claude will draft message" },
  { k: "p", label: "push", slashCommand: "/push" },
  { k: "d", label: "diff", slashCommand: "/diff" },
  { k: "r", label: "rebase onto main", slashCommand: "/rebase" },
];

// ---------------------------------------------------------------------------
// Tiny atom helpers (inline replacements for Chip / Rail / SectionLG / Kbd /
// ActionRow / Exec / ModelRow / ProvTab from the wireframe primitives)
// ---------------------------------------------------------------------------

function Chip({
  status,
  children,
}: {
  status: "running" | "attention" | "error" | "info" | "idle" | "done";
  children: React.ReactNode;
}) {
  const colorMap: Record<typeof status, string> = {
    running: theme.color.running,
    attention: theme.color.attention,
    error: theme.color.error,
    info: theme.color.info,
    idle: theme.color.t4,
    done: theme.color.done,
  } as const;
  const color = colorMap[status];
  return (
    <Text color={color}>
      [<Text bold>●</Text> {children}]
    </Text>
  );
}

function SectionHead({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box flexDirection="row" justifyContent="space-between" marginTop={1}>
      <Text bold color={theme.color.t3}>{title}</Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

function ModelSectionHead({
  title,
  hint,
  width,
  marginTop = 1,
}: {
  title: string;
  hint?: string;
  width: number;
  marginTop?: number;
}) {
  const hintWidth = hint ? hint.length + 1 : 0;
  const lineWidth = Math.max(2, width - title.length - hintWidth - 3);
  return (
    <Box flexDirection="row" marginTop={marginTop}>
      <Text bold color={theme.color.violet}>{title}</Text>
      <Text color={theme.color.borderSoft}> {"─".repeat(lineWidth)} </Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

function ActionRow({
  k,
  label,
  detail,
  selected,
}: {
  k: string;
  label: string;
  detail?: string;
  selected?: boolean;
}) {
  return (
    <Box flexDirection="row">
      <Text color={selected ? theme.color.violet : theme.color.t4}>
        {selected ? theme.rail : " "}
      </Text>
      <Text color={selected ? theme.color.violet : theme.color.t2} bold={selected}>
        {" "}[<Text color={selected ? theme.color.violet : theme.color.t3}>{k}</Text>] {label}
      </Text>
      {detail ? <Text color={theme.color.t4} dimColor>  {detail}</Text> : null}
    </Box>
  );
}

function ExecGlyph({ provider }: { provider: AdeCodeProvider | "shell" | "copilot" | null | undefined }) {
  if (!provider) return <Text color={theme.color.t4}>·</Text>;
  if (provider === "shell") return <Text color={theme.color.shell}>$</Text>;
  if (provider === "copilot") return <Text color={theme.color.copilot}>◉</Text>;
  const brand = theme.provider(provider as AdeCodeProvider);
  return <Text color={brand.color}>{brand.glyph}</Text>;
}

function tailTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

function endTruncate(value: string, max: number): string {
  if (max <= 1) return value.length ? "…" : "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function compactPath(value: string, max: number): string {
  if (value.length <= max) return value;
  const parts = value.split("/").filter(Boolean);
  for (let count = Math.min(4, parts.length); count >= 1; count -= 1) {
    const candidate = `…/${parts.slice(-count).join("/")}`;
    if (candidate.length <= max) return candidate;
  }
  return tailTruncate(value, max);
}

function formatTokens(tok: number | null | undefined): string {
  if (tok == null) return "—";
  if (tok >= 1000) return `${(tok / 1000).toFixed(1)}k`;
  return `${tok}`;
}

function formatElapsed(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const s = Math.max(1, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h`;
}

// ---------------------------------------------------------------------------
// Lane-details renderer (wireframe MainChatFinal · right column)
// ---------------------------------------------------------------------------

function LaneSectionHead({ title, hint, width }: { title: string; hint?: string; width: number }) {
  const hintWidth = hint ? hint.length + 1 : 0;
  const lineWidth = Math.max(2, width - title.length - hintWidth - 6);
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold color={theme.color.violet}>{title}</Text>
      <Text color={theme.color.borderSoft}> {"─".repeat(lineWidth)} </Text>
      {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
    </Box>
  );
}

function LaneMetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="row">
      <Text color={theme.color.t3}>{label.padEnd(LANE_LABEL_WIDTH)}</Text>
      {children}
    </Box>
  );
}

function LaneFileRow({
  file,
  width,
}: {
  file: { path: string; status: "M" | "A" | "D" | "?"; staged: boolean };
  width: number;
}) {
  const statusColor = file.status === "D"
    ? theme.color.error
    : file.status === "A" || file.status === "?"
      ? theme.color.running
      : theme.color.attention;
  const pathWidth = Math.max(10, width - 8);
  return (
    <Box flexDirection="row">
      <Text color={file.staged ? theme.color.running : theme.color.t5}>{file.staged ? "●" : "○"} </Text>
      <Text color={statusColor}>{file.status}</Text>
      <Text color={theme.color.t1}> {compactPath(file.path, pathWidth)}</Text>
    </Box>
  );
}

function LaneRunSummary({
  run,
  width,
}: {
  run: NonNullable<Extract<RightPaneContent, { kind: "lane-details" }>["run"]>;
  width: number;
}) {
  const brand = theme.provider(run.provider);
  const running = run.status === "running";
  const parts = [
    formatElapsed(run.elapsedMs),
    run.tokenSummary,
  ].filter((part): part is string => Boolean(part && part !== "—"));
  const summary = parts.join(" · ");
  const toolSummary = run.toolSummary ? tailTruncate(run.toolSummary, Math.max(8, width - 18)) : null;
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <ExecGlyph provider={run.provider} />
        <Text color={running ? theme.color.running : theme.color.t4} bold={running}>
          {` ${running ? "running" : "idle"}`}
        </Text>
        {summary ? <Text color={theme.color.t3}>{` ${summary}`}</Text> : null}
      </Box>
      <Text color={theme.color.t4} dimColor>
        {brand.label}{toolSummary ? ` · ${toolSummary}` : ""}
      </Text>
    </Box>
  );
}

function LaneDetailsPane({
  content,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "lane-details" }>;
  width: number;
}) {
  const lane = content.lane;
  const worktreeMissing = content.worktreeAvailable === false;
  const status = lane.status;
  const activeRun = content.run?.status === "running";
  const laneKind: "running" | "attention" | "idle" | "failed" | "primary" = ((): "running" | "attention" | "idle" | "failed" | "primary" => {
    if (worktreeMissing) return "failed";
    if (lane.laneType === "primary") return "primary";
    if (status.rebaseInProgress) return "attention";
    if (status.dirty || status.ahead > 0 || status.behind > 0) return "attention";
    return "idle";
  })();
  const railColor = activeRun ? theme.color.running : theme.laneStatusColor(laneKind);
  const chipStatus: "running" | "attention" | "idle" = ((): "running" | "attention" | "idle" => {
    if (activeRun) return "running";
    if (laneKind === "attention" || laneKind === "failed") return "attention";
    return "idle";
  })();
  const runElapsed = activeRun && content.run?.elapsedMs != null ? formatElapsed(content.run.elapsedMs) : null;
  const chipLabel = ((): string => {
    if (activeRun) return `running${runElapsed ? ` · ${runElapsed}` : ""}`;
    if (worktreeMissing) return "missing";
    if (laneKind === "primary") return "primary";
    if (laneKind === "attention") return status.dirty ? "dirty" : "sync";
    return "idle";
  })();

  const git = content.git;
  const workingClean = git.staged + git.unstaged === 0;
  const filesCount = Math.max(git.total, content.files.length);
  const contentWidth = Math.max(18, width - 4);
  const remoteLabel = git.remote && git.remote !== lane.branchRef ? git.remote : null;
  const changedRows = content.files.slice(0, content.showFiles ? 9 : LANE_FILE_PREVIEW_ROWS);
  const remainingFiles = Math.max(0, filesCount - changedRows.length);

  return (
    <Box flexDirection="column">
      <Box marginTop={1} flexDirection="row">
        <Text color={railColor}>{theme.rail} </Text>
        <Text color={railColor} bold>{endTruncate(lane.name, Math.max(10, contentWidth - 16))}</Text>
        <Text> </Text>
        <Chip status={chipStatus}>{chipLabel}</Chip>
      </Box>
      <Text color={theme.color.t3}>⎇ {tailTruncate(lane.branchRef, contentWidth - 2)}</Text>
      {remoteLabel ? <Text color={theme.color.t4}>{tailTruncate(remoteLabel, contentWidth)}</Text> : null}
      {worktreeMissing ? (
        <Text color={theme.color.error}>{tailTruncate(lane.worktreePath, contentWidth)}</Text>
      ) : null}

      <LaneSectionHead title="STATUS" hint="g · git tab" width={contentWidth} />
      <LaneMetaRow label="working">
        <Text color={worktreeMissing ? theme.color.error : workingClean ? theme.color.running : theme.color.attention}>
          ● {worktreeMissing ? "worktree missing" : workingClean ? "clean" : "dirty"}
        </Text>
      </LaneMetaRow>
      <LaneMetaRow label="remote">
        <Text color={git.ahead > 0 ? theme.color.running : theme.color.t4}>↑{git.ahead} </Text>
        <Text color={theme.color.t4}>↓{git.behind}</Text>
        {remoteLabel ? <Text color={theme.color.t4}> {tailTruncate(remoteLabel, Math.max(5, contentWidth - LANE_LABEL_WIDTH - 8))}</Text> : null}
      </LaneMetaRow>
      <LaneMetaRow label="conflicts">
        <Text color={theme.color.running}>none predicted</Text>
      </LaneMetaRow>
      {worktreeMissing ? (
        <>
          <LaneSectionHead title="UNAVAILABLE" width={contentWidth} />
          <Text color={theme.color.error}>Restore this lane worktree before starting chats or running git actions.</Text>
        </>
      ) : null}

      <LaneSectionHead title={`CHANGES · ${filesCount}`} hint="t · files" width={contentWidth} />
      <Box flexDirection="column">
        {changedRows.length ? changedRows.map((file) => (
          <LaneFileRow key={`${file.staged ? "s" : "u"}:${file.path}`} file={file} width={contentWidth} />
        )) : (
          <Text color={theme.color.t4} dimColor>No changed files.</Text>
        )}
        {remainingFiles > 0 ? (
          <Text color={theme.color.t4} dimColor>{`… ${remainingFiles} more`}</Text>
        ) : null}
        <Box flexDirection="row" marginTop={changedRows.length ? 1 : 0}>
          <Text color={theme.color.running}>{git.staged} staged</Text>
          <Text color={theme.color.t4}>  {git.unstaged} unstaged</Text>
          {git.additions || git.deletions ? (
            <>
              <Text color={theme.color.running}>  +{git.additions}</Text>
              <Text color={theme.color.error}> −{git.deletions}</Text>
            </>
          ) : null}
        </Box>
      </Box>

      {!worktreeMissing ? (
        <>
          <LaneSectionHead title="ACTIONS" hint="↵ run" width={contentWidth} />
          <Box flexDirection="column">
            {LANE_DETAIL_ACTIONS.map((action, idx) => (
              <ActionRow
                key={action.label}
                k={action.k}
                label={action.label}
                detail={action.detail}
                selected={idx === content.selectedActionIndex}
              />
            ))}
          </Box>
        </>
      ) : null}

      {/* PR */}
      {content.pr ? (
        <>
          <LaneSectionHead title={`PR #${content.pr.number}`} hint="o · open" width={contentWidth} />
          <Box flexDirection="row">
            <Chip status={content.pr.state === "open" ? "info" : content.pr.state === "merged" ? "done" : "idle"}>
              {content.pr.state}
            </Chip>
            <Text color={theme.color.t1}>  #{content.pr.number}</Text>
          </Box>
          <Box flexDirection="row">
            <Text color={theme.color.running}>{content.pr.checksPassed}/{content.pr.checksTotal} ✓</Text>
            <Text color={theme.color.t4}>  </Text>
            <Text color={theme.color.t4} dimColor>{content.pr.url ? tailTruncate(content.pr.url, 20) : ""}</Text>
          </Box>
        </>
      ) : null}

      <LaneSectionHead title="RUN" hint="s · subagents" width={contentWidth} />
      {content.run ? (
        <LaneRunSummary run={content.run} width={contentWidth} />
      ) : (
        <Text color={theme.color.t4} dimColor>no active chat for this lane</Text>
      )}

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>{worktreeMissing ? "t files" : "↑↓ move · ↵ run · tab next section · esc close"}</Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Model-setup renderer (wireframe ModelFinal)
// ---------------------------------------------------------------------------

function ProviderTabStrip({
  providerRows,
  activeProvider,
  width,
}: {
  providerRows: ProviderReadinessRow[];
  activeProvider: AdeCodeProvider;
  width: number;
}) {
  const rowsByProvider = new Map(providerRows.map((row) => [row.provider, row]));
  const orderedRows = [
    rowsByProvider.get(activeProvider),
    ...PROVIDER_ORDER.filter((provider) => provider !== activeProvider).map((provider) => rowsByProvider.get(provider)),
    ...providerRows.filter((row) => !PROVIDER_ORDER.includes(row.provider) && row.provider !== activeProvider),
  ].filter((row): row is ProviderReadinessRow => Boolean(row));

  return (
    <Box flexDirection="column">
      <ModelSectionHead title="PROVIDER" hint="← →" width={width} marginTop={0} />
      <Box flexDirection="row" flexWrap="wrap">
        {orderedRows.map((row) => {
          const brand = theme.provider(row.provider);
          const isActive = row.provider === activeProvider;
          const statusColor = row.status === "ready"
            ? theme.color.running
            : row.status === "unknown"
              ? theme.color.attention
              : theme.color.t4;
          return (
            <Box key={row.provider} marginRight={1}>
              <Text color={isActive ? theme.color.violet : theme.color.borderSoft}>[</Text>
              <Text color={statusColor}>●</Text>
              <Text color={isActive ? theme.color.violet : theme.color.t2} bold={isActive}>
                {" "}{brand.wordmark}
              </Text>
              <Text color={isActive ? theme.color.violet : theme.color.borderSoft}>]</Text>
            </Box>
          );
        })}
      </Box>
      <Box flexDirection="row">
        <Text color={theme.color.running}>● </Text>
        <Text color={theme.color.t3}>ready · </Text>
        <Text color={theme.color.violet}>● </Text>
        <Text color={theme.color.t3}>active · </Text>
        <Text color={theme.color.attention}>● </Text>
        <Text color={theme.color.t3}>needs login</Text>
      </Box>
    </Box>
  );
}

function ModelRow({
  row,
  selected,
  width,
}: {
  row: SetupPaneRow;
  selected: boolean;
  width: number;
}) {
  const rail = selected ? <Text color={theme.color.violet}>{theme.rail}</Text> : <Text> </Text>;
  const detail = row.detail?.replace(/,\s*/g, " · ") ?? "";
  const valueWidth = Math.max(8, width - MODEL_LABEL_WIDTH - detail.length - 6);
  return (
    <Box flexDirection="row" justifyContent="space-between">
      <Box flexDirection="row">
        {rail}
        <Text color={selected ? theme.color.violet : theme.color.t3}>
          {" "}{row.label.padEnd(MODEL_LABEL_WIDTH)}
        </Text>
        <Text
          color={!selected && row.disabled ? theme.color.t4 : theme.color.t1}
          bold={selected}
        >
          {endTruncate(row.value, valueWidth)}
        </Text>
      </Box>
      {detail ? (
        <Text color={selected ? theme.color.t3 : theme.color.t4} dimColor={!selected}>
          {endTruncate(detail, Math.max(6, width - MODEL_LABEL_WIDTH - valueWidth - 4))}
        </Text>
      ) : null}
    </Box>
  );
}

function ActiveProviderStatus({ row }: { row: ProviderReadinessRow }) {
  const modelCount = row.modelCount > 0 ? `${row.modelCount} available` : "none discovered";
  const statusLabel = ((): string => {
    if (row.status === "ready") return "ready";
    if (row.status === "unknown") return "needs attention";
    return "needs login";
  })();
  const statusColor = ((): string => {
    if (row.status === "ready") return theme.color.running;
    if (row.status === "unknown") return theme.color.attention;
    return theme.color.error;
  })();
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={statusColor}>● </Text>
        <Text color={theme.color.t2}>auth</Text>
        <Text color={theme.color.t4}> · </Text>
        <Text color={theme.color.t2}>{statusLabel}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={theme.color.running}>● </Text>
        <Text color={theme.color.t2}>models</Text>
        <Text color={theme.color.t4}> · </Text>
        <Text color={theme.color.t2}>{modelCount}</Text>
      </Box>
      <Box flexDirection="row">
        <Text color={statusColor}>● </Text>
        <Text color={theme.color.t2}>runtime</Text>
        <Text color={theme.color.t4}> · </Text>
        <Text color={theme.color.t3}>{tailTruncate(row.detail, 48)}</Text>
      </Box>
    </Box>
  );
}

function ModelSetupPane({
  content,
  selectedIndex,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "model-setup" }>;
  selectedIndex: number;
  width: number;
}) {
  const contentWidth = Math.max(30, width - 2);
  const cyclableRows = content.rows.filter((row) => row.cyclable === true);
  const actionRows = content.rows.filter((row) => row.cyclable !== true);
  const activeProviderRow =
    content.providerRows.find((row) => row.provider === content.activeProvider) ?? null;

  return (
    <Box flexDirection="column">
      {/* Provider tab strip */}
      <ProviderTabStrip
        providerRows={content.providerRows}
        activeProvider={content.activeProvider}
        width={contentWidth}
      />

      {/* MODEL section */}
      <ModelSectionHead title="MODEL" hint="↑↓ · ← → · ↵" width={contentWidth} />
      {cyclableRows.map((row) => {
        const absoluteIndex = content.rows.indexOf(row);
        return (
          <ModelRow
            key={`${row.kind}:${row.label}`}
            row={row}
            selected={absoluteIndex === selectedIndex}
            width={contentWidth}
          />
        );
      })}

      {/* RUN section (actions like Refresh / Open settings / Login) */}
      {actionRows.length ? (
        <>
          <ModelSectionHead title="RUN" width={contentWidth} />
          {actionRows.map((row) => {
            const absoluteIndex = content.rows.indexOf(row);
            const selected = absoluteIndex === selectedIndex;
            const glyph = ((): string => {
              if (row.kind === "refresh-status") return "↻";
              if (row.kind === "open-settings") return "↗";
              return "→";
            })();
            return (
              <ActionRow
                key={`${row.kind}:${row.label}`}
                k={glyph}
                label={row.label}
                detail={row.detail}
                selected={selected}
              />
            );
          })}
        </>
      ) : null}

      {/* STATUS · <PROVIDER> */}
      <ModelSectionHead title={`STATUS · ${theme.provider(content.activeProvider).label.toUpperCase()}`} width={contentWidth} />
      {activeProviderRow ? (
        <ActiveProviderStatus row={activeProviderRow} />
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
          ← → provider · ↑↓ field · ↵ apply · l login
          {content.checkedAt ? `  · ${content.checkedAt.slice(11, 19)}` : ""}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Agents pane (Subagents · Teammates) — htop process table, runtime-adaptive
// ---------------------------------------------------------------------------

function subagentExec(snapshot: SubagentSnapshot, provider: AdeCodeProvider): AdeCodeProvider | "copilot" {
  if (snapshot.kind === "teammate") return "copilot";
  return provider;
}

function subagentAgentKind(status: SubagentSnapshot["status"]): "running" | "ok" | "waiting" | "error" {
  if (status === "running") return "running";
  if (status === "completed") return "ok";
  if (status === "stopped") return "waiting";
  return "error";
}

function SpinningAgentGlyph({ color }: { color: string }) {
  const frame = useSpinFrame();
  return <Text color={color}>{frame}</Text>;
}

function subagentSectionTitle(section: SubagentPaneSection): string {
  if (section === "main") return "MAIN";
  if (section === "teammates") return "TEAMMATES";
  if (section === "background") return "BACKGROUND";
  if (section === "recent") return "RECENT · DONE";
  return "SUBAGENTS";
}

function subagentSectionCount(rows: SubagentPaneRow[], section: SubagentPaneSection): number {
  return rows.filter((row) => row.section === section).length;
}

function SubagentMainRow({
  selected,
  provider,
  nameWidth,
}: {
  selected: boolean;
  provider: AdeCodeProvider;
  nameWidth: number;
}) {
  const brand = theme.provider(provider);
  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text color={selected ? theme.color.violet : theme.color.t5}>{selected ? theme.rail : " "}</Text>
        <Text> </Text>
        <Text color={theme.color.running}>●</Text>
        <Text color={theme.color.t4}> 00 </Text>
        <ExecGlyph provider={provider} />
        <Text color={selected ? theme.color.violet : theme.color.t1} bold={selected}>
          {` ${endTruncate("main", nameWidth).padEnd(nameWidth)}`}
        </Text>
        <Text color={theme.color.t3}>{"   —      —    —"}</Text>
      </Box>
      <Text color={theme.color.t4} dimColor>{`      ${brand.label} · main chat`}</Text>
    </Box>
  );
}

function SubagentRow({
  snapshot,
  displayIndex,
  selected,
  provider,
  animateRunningGlyph,
  nameWidth,
}: {
  snapshot: SubagentSnapshot;
  displayIndex: number;
  selected: boolean;
  provider: AdeCodeProvider;
  animateRunningGlyph: boolean;
  nameWidth: number;
}) {
  const kind = subagentAgentKind(snapshot.status);
  const glyph = theme.agentStatusGlyph(kind);
  const glyphColor = theme.agentStatusColor(kind);
  const tok = formatTokens(snapshot.tokens ?? null);
  const elapsed = formatElapsed(snapshot.durationMs ?? null);
  const cost = "—";
  const id = String(displayIndex).padStart(2, "0");
  const exec = subagentExec(snapshot, provider);
  const faded = snapshot.status === "stopped" || snapshot.status === "failed";
  const nameColor = selected ? theme.color.violet : faded ? theme.color.t4 : theme.color.t1;
  const detail = snapshot.lastToolName || snapshot.summary;

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        {/* rail/select */}
        <Text color={selected ? theme.color.violet : theme.color.t5}>
          {selected ? theme.rail : " "}
        </Text>
        <Text> </Text>
        {/* status glyph */}
        {kind === "running" && animateRunningGlyph ? (
          <SpinningAgentGlyph color={glyphColor} />
        ) : (
          <Text color={glyphColor}>{glyph}</Text>
        )}
        <Text> </Text>
        {/* id */}
        <Text color={theme.color.t4}>{id}</Text>
        <Text> </Text>
        {/* exec glyph + name */}
        <ExecGlyph provider={exec} />
        <Text color={nameColor} bold={selected}>{` ${endTruncate(snapshot.name, nameWidth).padEnd(nameWidth)}`}</Text>
        {/* tok / elapsed / cost (right side; not literally right-aligned in Ink) */}
        <Text color={theme.color.t3}>{`  ${tok.padStart(5)}`}</Text>
        <Text color={theme.color.t3}>{`  ${elapsed.padStart(4)}`}</Text>
        <Text color={theme.color.t3}>{`  ${cost.padStart(3)}`}</Text>
      </Box>
      {detail ? (
        <Text color={theme.color.t4} dimColor>      {endTruncate(detail, Math.max(12, nameWidth + 16))}</Text>
      ) : null}
    </Box>
  );
}

function SubagentsPane({
  content,
  selectedIndex,
  width,
}: {
  content: Extract<RightPaneContent, { kind: "subagents" }>;
  selectedIndex: number;
  width: number;
}) {
  const provider = content.provider;
  const isDroid = provider === "droid";

  if (isDroid && content.snapshots.length === 0) {
    return (
      <Box flexDirection="column">
        <Box marginTop={1}>
          <Text color={theme.color.t3} dimColor>
            Droid runs over ACP, which doesn't model
          </Text>
        </Box>
        <Text color={theme.color.t3} dimColor>
          subagents yet — see agentclientprotocol.com.
        </Text>
        <Box marginTop={1}>
          <Text color={theme.color.t4} dimColor>See /status for session state.</Text>
        </Box>
      </Box>
    );
  }

  const rows = buildSubagentPaneRows(content);
  const snapshots = rows.filter((row): row is Extract<SubagentPaneRow, { kind: "snapshot" }> => row.kind === "snapshot");
  const subagentsCount = subagentSectionCount(rows, "subagents") + subagentSectionCount(rows, "recent");
  const teammatesCount = subagentSectionCount(rows, "teammates");
  const backgroundCount = subagentSectionCount(rows, "background");
  const selected = Math.max(0, Math.min(selectedIndex, Math.max(0, rows.length - 1)));
  const nameWidth = Math.max(4, Math.min(22, width - 27));
  let runCount = 0;
  let doneCount = 0;
  let waitCount = 0;
  let totalTok = 0;
  let totalMs = 0;
  for (const { snapshot: s } of snapshots) {
    const k = subagentAgentKind(s.status);
    if (k === "running") runCount++;
    else if (k === "ok") doneCount++;
    else if (k === "waiting") waitCount++;
    if (s.tokens) totalTok += s.tokens;
    if (s.durationMs) totalMs += s.durationMs;
  }

  return (
    <Box flexDirection="column">
      {/* Tab strip */}
      <Box flexDirection="column">
        <Text>
          <Text color={theme.color.violet} bold underline>Subagents · {subagentsCount}</Text>
          <Text color={theme.color.t3}>   Teammates · {teammatesCount}</Text>
        </Text>
        <Text color={theme.color.t3}>Background · {backgroundCount}</Text>
      </Box>

      {/* Column header */}
      <Box flexDirection="row" marginTop={1}>
        <Text color={theme.color.t4} bold>{`    ID  ${"NAME".padEnd(nameWidth + 2)} TOK  ELAPSED   $`}</Text>
      </Box>

      {/* Rows */}
      {rows.map((row, i) => {
        const previous = rows[i - 1];
        const showSection = row.section !== "main" && previous?.section !== row.section;
        const displayIndex = i;
        return (
          <Box key={row.key} flexDirection="column" marginTop={showSection ? 1 : 0}>
            {showSection ? (
              <Box flexDirection="row">
                <Text color={theme.color.t4} bold>{subagentSectionTitle(row.section)}</Text>
                <Text color={theme.color.borderSoft}> {"─".repeat(Math.max(3, width - subagentSectionTitle(row.section).length - 6))}</Text>
              </Box>
            ) : null}
            {row.kind === "main" ? (
              <SubagentMainRow
                selected={i === selected}
                provider={provider}
                nameWidth={nameWidth}
              />
            ) : (
              <SubagentRow
                snapshot={row.snapshot}
                displayIndex={displayIndex}
                selected={i === selected}
                provider={provider}
                animateRunningGlyph={runCount <= 12}
                nameWidth={nameWidth}
              />
            )}
          </Box>
        );
      })}

      {/* Footer summary */}
      {snapshots.length ? (
        <Box marginTop={1} flexDirection="row">
          <Text color={theme.color.running}>●</Text>
          <Text color={theme.color.t3}>{` ${runCount} run · `}</Text>
          <Text color={theme.color.done}>●</Text>
          <Text color={theme.color.t3}>{` ${doneCount} done · `}</Text>
          <Text color={theme.color.attention}>●</Text>
          <Text color={theme.color.t3}>{` ${waitCount} wait`}</Text>
        </Box>
      ) : null}
      {snapshots.length ? (
        <Text color={theme.color.t4} dimColor>
          {formatTokens(totalTok)} tok · {formatElapsed(totalMs)}
        </Text>
      ) : null}

      <Box marginTop={1}>
        <Text color={theme.color.t4} dimColor>
          ↑↓ select · transcript follows · tab returns main
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Other content modes (status, list, details, diff, models, effort, form,
// new-chat-setup, help, empty) — kept compact, refreshed to use theme tokens.
// ---------------------------------------------------------------------------

function HelpPane() {
  return (
    <Box flexDirection="column">
      <Text color={theme.color.t3} dimColor>ctrl-o opens or focuses lanes and chats</Text>
      <Text color={theme.color.t3} dimColor>ctrl-p opens or focuses info</Text>
      <Text color={theme.color.t3} dimColor>shift-tab cycles pane focus</Text>
      <Text color={theme.color.t3} dimColor>esc closes the active side pane</Text>
      <Text color={theme.color.t3} dimColor>ctrl-c interrupts a running chat; press again to quit</Text>
      <Text color={theme.color.t3} dimColor>/ opens commands, @ opens references, tab inserts selected</Text>
      <Text color={theme.color.t3} dimColor>/ade status forces ADE's TUI command when a runtime owns /status</Text>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Pane title resolution
// ---------------------------------------------------------------------------

function paneTitle(content: RightPaneContent): { title: string; hint?: string } {
  switch (content.kind) {
    case "lane-details":
      return {
        title: `${endTruncate(content.lane.name.toUpperCase(), 22)} · ${content.worktreeAvailable === false ? "MISSING" : "FOCUSED"}`,
      };
    case "model-setup":
      return { title: "SETUP · MODEL", hint: new Date().toISOString().slice(11, 19) };
    case "new-chat-setup":
      return { title: "NEW CHAT" };
    case "subagents":
      return { title: `AGENTS · ${theme.provider(content.provider).label.toUpperCase()}`, hint: "tab · cycle" };
    case "help":
      return { title: "HELP" };
    case "status":
      return { title: "STATUS" };
    case "diff":
      return { title: content.title.toUpperCase() };
    case "list":
      return { title: content.title.toUpperCase() };
    case "details":
      return { title: content.title.toUpperCase() };
    case "models":
      return { title: "MODEL" };
    case "effort":
      return { title: "EFFORT" };
    case "form":
      return { title: content.title.toUpperCase() };
    default:
      return { title: "PANE" };
  }
}

// ---------------------------------------------------------------------------
// Main right pane component
// ---------------------------------------------------------------------------

export function RightPane({
  content,
  formValues = {},
  activeFormField = 0,
  selectedIndex = 0,
  focused = false,
  width = DEFAULT_PANE_WIDTH,
}: {
  content: RightPaneContent;
  formValues?: Record<string, string>;
  activeFormField?: number;
  selectedIndex?: number;
  focused?: boolean;
  activeProvider?: AdeCodeProvider | null;
  width?: number;
}) {
  const { title, hint } = paneTitle(content);
  const paneWidth = Math.max(30, width);

  return (
    <Box
      width={paneWidth}
      flexDirection="column"
      borderStyle="single"
      borderColor={focused ? theme.color.borderFocused : theme.color.border}
      paddingX={content.kind === "model-setup" ? 0 : 1}
    >
      {/* Pane header */}
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={focused ? theme.color.violet : theme.color.t2}>
          {title}
        </Text>
        {hint ? <Text color={theme.color.t4} dimColor>{hint}</Text> : null}
      </Box>

      {content.kind === "empty" ? (
        <Text color={theme.color.t4} dimColor>Run /status, /diff, /model, or /help.</Text>
      ) : null}

      {content.kind === "help" ? <HelpPane /> : null}

      {content.kind === "status" ? (
        <Box flexDirection="column">
          {content.rows.map(([key, value]) => (
            <Text key={key}>
              <Text color={theme.color.t4}>{key.padEnd(10)}</Text> {value}
            </Text>
          ))}
        </Box>
      ) : null}

      {content.kind === "list" ? (
        <Box flexDirection="column">
          {content.rows.length ? content.rows.map((row, index) => (
            <Text
              key={`${content.action?.ids[index] ?? row}:${index}`}
              color={content.action && index === selectedIndex ? theme.color.violet : undefined}
            >
              {content.action ? `${index === selectedIndex ? theme.rail : " "} ${row}` : row}
            </Text>
          )) : <Text color={theme.color.t4} dimColor>{content.emptyText ?? "No data."}</Text>}
          {content.action && content.rows.length ? (
            <Text color={theme.color.t4} dimColor>arrows move · enter opens</Text>
          ) : null}
        </Box>
      ) : null}

      {content.kind === "details" ? (
        <Text color={theme.color.t2}>{content.body}</Text>
      ) : null}

      {content.kind === "diff" ? (
        <Box flexDirection="column">
          {content.files.length ? content.files.map((file) => (
            <Box key={file.path} flexDirection="column" marginBottom={1}>
              <Text color={theme.color.info}>
                {file.path}{" "}
                <Text color={theme.color.t4} dimColor>
                  +{file.additions ?? 0} -{file.deletions ?? 0}
                </Text>
              </Text>
              {file.body ? (
                <Text color={theme.color.t3} dimColor>
                  {file.body.split(/\r?\n/).slice(0, 8).join("\n")}
                </Text>
              ) : null}
            </Box>
          )) : <Text color={theme.color.t4} dimColor>No changes.</Text>}
        </Box>
      ) : null}

      {content.kind === "models" ? (
        <Box flexDirection="column">
          {content.models.map((model, index) => (
            <Text
              key={model.id}
              color={(model.modelId ?? model.id) === content.activeModelId ? theme.color.violet : undefined}
            >
              {index === selectedIndex ? theme.rail : " "}{" "}
              {(model.modelId ?? model.id) === content.activeModelId ? "●" : "○"} {model.displayName}
            </Text>
          ))}
          <Text color={theme.color.t4} dimColor>arrows move · enter applies</Text>
        </Box>
      ) : null}

      {content.kind === "effort" ? (
        <Box flexDirection="column">
          {content.efforts.map((effort, index) => (
            <Text
              key={effort}
              color={effort === content.activeEffort ? theme.color.violet : undefined}
            >
              {index === selectedIndex ? theme.rail : " "} {effort === content.activeEffort ? "●" : "○"} {effort}
            </Text>
          ))}
          <Text color={theme.color.t4} dimColor>arrows move · enter applies</Text>
        </Box>
      ) : null}

      {content.kind === "lane-details" ? (
        <LaneDetailsPane content={content} width={paneWidth} />
      ) : null}

      {content.kind === "subagents" ? (
        <SubagentsPane content={content} selectedIndex={selectedIndex} width={paneWidth} />
      ) : null}

      {content.kind === "model-setup" ? (
        <ModelSetupPane content={content} selectedIndex={selectedIndex} width={paneWidth} />
      ) : null}

      {content.kind === "new-chat-setup" ? (
        <Box flexDirection="column">
          <Text color={theme.color.t4} dimColor>Lane: {content.laneLabel}</Text>
          <Box flexDirection="column" marginTop={1}>
            {content.rows.map((row, index) => {
              const selected = index === selectedIndex;
              return (
                <Box key={`${row.kind}:${row.label}`} flexDirection="column">
                  <Text
                    color={selected ? theme.color.violet : row.disabled ? theme.color.t4 : theme.color.t2}
                    bold={selected}
                  >
                    {selected ? theme.rail : " "} {row.label}: {row.value}
                  </Text>
                  {selected && row.detail ? (
                    <Text color={theme.color.t4} dimColor>    {row.detail}</Text>
                  ) : null}
                </Box>
              );
            })}
          </Box>
          <Text color={theme.color.t4} dimColor>↑↓ rows · ←→ change · ↵ prompt</Text>
        </Box>
      ) : null}

      {content.kind === "form" ? (
        <Box flexDirection="column">
          {content.fields.map((field, index) => {
            const value = formValues[field.name]?.trim();
            return (
              <Text
                key={field.name}
                color={index === activeFormField ? theme.color.violet : undefined}
              >
                {index === activeFormField ? theme.rail : " "} {field.label}
                {field.required ? " *" : ""}: {value || field.placeholder || ""}
              </Text>
            );
          })}
          <Text color={theme.color.t4} dimColor>arrows move · enter submits · esc cancels</Text>
        </Box>
      ) : null}
    </Box>
  );
}
