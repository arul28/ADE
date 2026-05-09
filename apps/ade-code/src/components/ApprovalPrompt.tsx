import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "../types";

export function ApprovalPrompt({
  approval,
  modal = false,
}: {
  approval: PendingApproval | null;
  modal?: boolean;
}) {
  if (!approval) return null;
  const question = approval.request?.questions[0] ?? null;
  const card = (
    <Box
      borderStyle="single"
      borderColor={approval.highStakes ? "red" : "yellow"}
      paddingX={1}
      paddingY={modal ? 1 : 0}
      flexDirection="column"
      width={modal ? 60 : undefined}
    >
      <Text color={approval.highStakes ? "red" : "yellow"}>
        {approval.mode === "question"
          ? "Input requested"
          : approval.highStakes
            ? "High-stakes approval required"
            : "Approval required"}
      </Text>
      <Text>{question?.question ?? approval.description}</Text>
      {question?.options?.length ? (
        <Box flexDirection="column">
          {question.options.slice(0, 6).map((option, index) => (
            <Text key={option.value} dimColor>
              {index + 1}. {option.label}{option.description ? ` - ${option.description}` : ""}
            </Text>
          ))}
        </Box>
      ) : null}
      {approval.mode === "question" ? (
        <Text dimColor>Type an answer, option number/value, deny, or cancel.</Text>
      ) : approval.highStakes ? (
        <Text dimColor>Type approve or deny, then press enter.</Text>
      ) : (
        <Text dimColor>Press a to approve, d to deny.</Text>
      )}
    </Box>
  );
  if (!modal) return card;
  return (
    <Box flexGrow={1} alignItems="center" justifyContent="center">
      {card}
    </Box>
  );
}
