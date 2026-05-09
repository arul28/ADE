import React from "react";
import { Box, Text } from "ink";
import type { RightPaneContent } from "../types";

function HelpPane() {
  return (
    <Box flexDirection="column">
      <Text bold>Help</Text>
      <Text dimColor>ctrl-b toggles lanes and chats</Text>
      <Text dimColor>ctrl-j toggles this pane</Text>
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
}: {
  content: RightPaneContent;
  formValues?: Record<string, string>;
  activeFormField?: number;
  selectedIndex?: number;
}) {
  return (
    <Box width={38} flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
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
          <Text dimColor>tab moves fields · enter submits · / runs a command</Text>
        </Box>
      ) : null}
    </Box>
  );
}
