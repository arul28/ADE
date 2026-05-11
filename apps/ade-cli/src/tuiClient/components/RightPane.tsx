import React from "react";
import { Box, Text } from "ink";
import type { ProviderReadinessRow, RightPaneContent } from "../types";
import { theme } from "../theme";

const STATUS_DOT: Record<ProviderReadinessRow["status"], string> = {
  ready: "●",
  unknown: "◐",
  unavailable: "○",
};

export const LANE_DETAIL_ACTIONS: ReadonlyArray<{ label: string; slashCommand: string }> = [
  { label: "stage all", slashCommand: "/stage all" },
  { label: "commit", slashCommand: "/commit" },
  { label: "push", slashCommand: "/push" },
  { label: "pull", slashCommand: "/pull" },
];

function statusColor(status: ProviderReadinessRow["status"]): string {
  if (status === "ready") return theme.color.success;
  if (status === "unknown") return theme.color.warning;
  return theme.color.mutedFg;
}

function tailTruncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `…${value.slice(value.length - (max - 1))}`;
}

function HelpPane() {
  return (
    <Box flexDirection="column">
      <Text bold>Help</Text>
      <Text dimColor>ctrl-o opens or focuses lanes and chats</Text>
      <Text dimColor>ctrl-p opens or focuses setup</Text>
      <Text dimColor>shift-tab cycles pane focus</Text>
      <Text dimColor>esc closes the active side pane</Text>
      <Text dimColor>ctrl-c interrupts a running chat; press again to quit</Text>
      <Text dimColor>/ opens commands, @ opens references, tab inserts selected</Text>
      <Text dimColor>/ade status forces ADE's TUI command when a runtime owns /status</Text>
    </Box>
  );
}

export function RightPane({
  content,
  formValues = {},
  activeFormField = 0,
  selectedIndex = 0,
  focused = false,
}: {
  content: RightPaneContent;
  formValues?: Record<string, string>;
  activeFormField?: number;
  selectedIndex?: number;
  focused?: boolean;
}) {
  const paneTitle = content.kind === "lane-details" ? content.lane.name.toUpperCase() : "SETUP";
  return (
    <Box width={38} flexDirection="column" borderStyle="single" borderColor={focused ? "#A78BFA" : "gray"} paddingX={1}>
      <Text bold color={focused ? "#A78BFA" : undefined}>{paneTitle}{focused ? " · focused" : ""}</Text>
      {content.kind === "empty" ? (
        <Text dimColor>Run /status, /diff, /model, or /help.</Text>
      ) : null}
      {content.kind === "help" ? <HelpPane /> : null}
      {content.kind === "status" ? (
        <Box flexDirection="column">
          <Text bold>Status</Text>
          {content.rows.map(([key, value]) => (
            <Text key={key}><Text dimColor>{key.padEnd(10)}</Text> {value}</Text>
          ))}
        </Box>
      ) : null}
      {content.kind === "list" ? (
        <Box flexDirection="column">
          <Text bold>{content.title}</Text>
          {content.rows.length ? content.rows.map((row, index) => (
            <Text key={`${content.action?.ids[index] ?? row}:${index}`} color={content.action && index === selectedIndex ? "#A78BFA" : undefined}>
              {content.action ? `${index === selectedIndex ? "›" : " "} ${row}` : row}
            </Text>
          )) : <Text dimColor>{content.emptyText ?? "No data."}</Text>}
          {content.action && content.rows.length ? <Text dimColor>arrows move · enter opens</Text> : null}
        </Box>
      ) : null}
      {content.kind === "details" ? (
        <Box flexDirection="column">
          <Text bold>{content.title}</Text>
          <Text>{content.body}</Text>
        </Box>
      ) : null}
      {content.kind === "diff" ? (
        <Box flexDirection="column">
          <Text bold>{content.title}</Text>
          {content.files.length ? content.files.map((file) => (
            <Box key={file.path} flexDirection="column" marginBottom={1}>
              <Text color="cyan">{file.path} <Text dimColor>+{file.additions ?? 0} -{file.deletions ?? 0}</Text></Text>
              {file.body ? <Text dimColor>{file.body.split(/\r?\n/).slice(0, 8).join("\n")}</Text> : null}
            </Box>
          )) : <Text dimColor>No changes.</Text>}
        </Box>
      ) : null}
      {content.kind === "models" ? (
        <Box flexDirection="column">
          <Text bold>Model</Text>
          {content.models.map((model, index) => (
            <Text key={model.id} color={(model.modelId ?? model.id) === content.activeModelId ? "#A78BFA" : undefined}>
              {index === selectedIndex ? "›" : " "} {(model.modelId ?? model.id) === content.activeModelId ? "●" : "○"} {model.displayName}
            </Text>
          ))}
          <Text dimColor>arrows move · enter applies</Text>
        </Box>
      ) : null}
      {content.kind === "lane-details" ? (
        <Box flexDirection="column">
          <Text dimColor>{content.lane.branchRef}</Text>
          <Text>
            {content.git.staged + content.git.unstaged > 0 ? "DIRTY" : "CLEAN"}  ↑{content.git.ahead} ↓{content.git.behind}
          </Text>
          {content.git.remote ? <Text dimColor>{content.git.remote}</Text> : null}

          <Box marginTop={1} flexDirection="column">
            <Text>
              <Text bold>Changes</Text>
              <Text dimColor>  (t to toggle)</Text>
            </Text>
            {content.showFiles ? (
              content.files.length ? (
                content.files.slice(0, 8).map((file) => (
                  <Text key={file.path}>  {file.status} {file.path.slice(0, 26)}{file.staged ? " ●" : ""}</Text>
                ))
              ) : (
                <Text dimColor>  No changes.</Text>
              )
            ) : (
              <>
                <Text>  {content.git.staged} staged · {content.git.unstaged} unstaged</Text>
                <Text dimColor>  {content.git.total} files total</Text>
              </>
            )}
          </Box>

          <Box marginTop={1} flexDirection="column">
            <Text bold>Actions</Text>
            {LANE_DETAIL_ACTIONS.map((action, index) => (
              <Text key={action.label} color={index === content.selectedActionIndex ? "#A78BFA" : undefined}>
                {index === content.selectedActionIndex ? "›" : " "} {action.label}
              </Text>
            ))}
          </Box>

          {content.pr ? (
            <Box marginTop={1} flexDirection="column">
              <Text bold>Pull request</Text>
              <Text color={content.selectedActionIndex === LANE_DETAIL_ACTIONS.length ? "#A78BFA" : undefined}>
                {content.selectedActionIndex === LANE_DETAIL_ACTIONS.length ? "›" : " "} #{content.pr.number} {content.pr.state}  {content.pr.checksPassed}/{content.pr.checksTotal} ✓
              </Text>
            </Box>
          ) : null}
        </Box>
      ) : null}
      {content.kind === "effort" ? (
        <Box flexDirection="column">
          <Text bold>Effort</Text>
          {content.efforts.map((effort, index) => (
            <Text key={effort} color={effort === content.activeEffort ? "#A78BFA" : undefined}>
              {index === selectedIndex ? "›" : " "} {effort === content.activeEffort ? "●" : "○"} {effort}
            </Text>
          ))}
          <Text dimColor>arrows move · enter applies</Text>
        </Box>
      ) : null}
      {content.kind === "new-chat-setup" ? (
        <Box flexDirection="column">
          <Text bold>New chat</Text>
          <Text dimColor>Lane: {content.laneLabel}</Text>
          <Box flexDirection="column" marginTop={1}>
            {content.rows.map((row, index) => (
              <Box key={`${row.kind}:${row.label}`} flexDirection="column">
                <Text color={index === selectedIndex ? "#A78BFA" : row.disabled ? "gray" : undefined}>
                  {index === selectedIndex ? "›" : " "} {row.label}: {row.value}
                </Text>
                {index === selectedIndex && row.detail ? <Text dimColor>  {row.detail}</Text> : null}
              </Box>
            ))}
          </Box>
          <Text dimColor>up/down rows · left/right change · enter activates</Text>
        </Box>
      ) : null}
      {content.kind === "model-setup" ? (
        <Box flexDirection="column">
          <Box marginTop={1}>
            <Text bold color={theme.color.accent}>MODEL</Text>
          </Box>
          {content.rows.filter((row) => row.cyclable === true).map((row) => {
            const index = content.rows.indexOf(row);
            const selected = index === selectedIndex;
            const labelColor = selected ? theme.color.accent : row.disabled ? "gray" : undefined;
            const isProviderRow = row.kind === "provider";
            const valueColor = isProviderRow
              ? theme.provider(content.activeProvider).color
              : row.disabled
                ? "gray"
                : undefined;
            const rightHint = row.disabled ? null : "‹ ›";
            const cursorGlyph = selected ? "›" : " ";
            const paddedLabel = row.label.padEnd(12, " ");
            return (
              <Box key={`${row.kind}:${row.label}`} flexDirection="column">
                <Box justifyContent="space-between">
                  <Text>
                    <Text color={labelColor} bold={selected}>{cursorGlyph} {paddedLabel}</Text>
                    <Text color={valueColor} bold={isProviderRow}>
                      {isProviderRow ? `${theme.provider(content.activeProvider).glyph} ` : ""}{row.value}
                    </Text>
                  </Text>
                  {rightHint ? (
                    <Text color={selected ? theme.color.accent : theme.color.mutedFg} dimColor={!selected}>
                      {rightHint}
                    </Text>
                  ) : null}
                </Box>
                {selected && row.detail ? <Text dimColor>  {row.detail}</Text> : null}
              </Box>
            );
          })}
          <Box flexDirection="column" marginTop={1}>
            {content.rows.filter((row) => row.cyclable !== true).map((row) => {
              const index = content.rows.indexOf(row);
              const selected = index === selectedIndex;
              const glyph = row.kind === "refresh-status" ? "↻" : row.kind === "open-settings" ? "↗" : "→";
              const labelColor = selected ? theme.color.accent : row.disabled ? "gray" : undefined;
              const valueColor = row.disabled ? "gray" : theme.color.mutedFg;
              const cursorGlyph = selected ? "›" : " ";
              const showRunValue = row.kind !== "refresh-status";
              return (
                <Box key={`${row.kind}:${row.label}`} flexDirection="column">
                  <Box justifyContent="space-between">
                    <Text>
                      <Text color={labelColor} bold={selected}>{cursorGlyph} {glyph} {row.label}</Text>
                      {showRunValue ? <Text color={valueColor}>  {row.value}</Text> : null}
                    </Text>
                    {row.disabled ? null : (
                      <Text color={selected ? theme.color.accent : theme.color.mutedFg} dimColor={!selected}>↵</Text>
                    )}
                  </Box>
                  {selected && row.detail ? <Text dimColor>  {row.detail}</Text> : null}
                </Box>
              );
            })}
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text bold color={theme.color.accent}>PROVIDERS</Text>
            {content.providerRows.map((row, providerIdx) => {
              const absoluteIndex = content.rows.length + providerIdx;
              const providerSelected = absoluteIndex === selectedIndex;
              const brand = theme.provider(row.provider);
              const isActive = row.provider === content.activeProvider;
              const cursorGlyph = providerSelected ? "›" : " ";
              return (
                <Box key={row.provider} flexDirection="column">
                  <Box justifyContent="space-between">
                    <Text>
                      <Text color={providerSelected ? theme.color.accent : undefined} bold={providerSelected}>{cursorGlyph} </Text>
                      <Text color={brand.color} bold={isActive || providerSelected}>{brand.glyph} {row.label}</Text>
                      {isActive ? <Text dimColor>  active</Text> : null}
                    </Text>
                    <Text color={statusColor(row.status)}>{STATUS_DOT[row.status]}</Text>
                  </Box>
                  {providerSelected ? (
                    <Box flexDirection="column">
                      <Text dimColor>    {row.modelCount} models</Text>
                      <Text dimColor>    {row.status === "ready" ? tailTruncate(row.detail, 30) : row.detail}</Text>
                    </Box>
                  ) : null}
                </Box>
              );
            })}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>
              ↑↓ ←→ enter{content.checkedAt ? `  ·  ${content.checkedAt.slice(11, 19)}` : ""}
            </Text>
          </Box>
        </Box>
      ) : null}
      {content.kind === "form" ? (
        <Box flexDirection="column">
          <Text bold>{content.title}</Text>
          {content.fields.map((field, index) => {
            const value = formValues[field.name]?.trim();
            return (
              <Text key={field.name} color={index === activeFormField ? "#A78BFA" : undefined}>
                {index === activeFormField ? "›" : " "} {field.label}
                {field.required ? " *" : ""}: {value || field.placeholder || ""}
              </Text>
            );
          })}
          <Text dimColor>arrows move fields · enter submits · esc cancels</Text>
        </Box>
      ) : null}
    </Box>
  );
}
