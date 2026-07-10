/**
 * The step catalog drives the "+ add step" menu and step-card chrome. A step is
 * one entry in a rule's workflow: an agent session, an ADE action, a test run,
 * a shell command, a conflict prediction, or a lane cleanup.
 */

import {
  Code,
  Lightning,
  TerminalWindow,
  TestTube,
  Trash,
  Warning,
} from "@phosphor-icons/react";
import type { ElementType } from "react";
import { DELETE_LANE_ACTION_TYPE } from "./localAutomationConfig";

export type StepKind =
  | "agent-session"
  | "ade-action"
  | "run-tests"
  | "run-command"
  | "predict-conflicts"
  | "delete-lane";

export type StepDef = {
  kind: StepKind;
  label: string;
  icon: ElementType;
  accent: string;
  description: string;
};

export const STEP_DEFS: Record<StepKind, StepDef> = {
  "agent-session": {
    kind: "agent-session",
    label: "Run an agent",
    icon: Lightning,
    accent: "#B48EF0",
    description: "Send a prompt to an agent and let it work in a chat thread.",
  },
  "ade-action": {
    kind: "ade-action",
    label: "ADE action",
    icon: Code,
    accent: "#58A6FF",
    description: "Call any ADE domain — git, lane, PR, issue, tests, and more.",
  },
  "run-tests": {
    kind: "run-tests",
    label: "Run tests",
    icon: TestTube,
    accent: "#45C4A0",
    description: "Run a configured test suite and report the result.",
  },
  "run-command": {
    kind: "run-command",
    label: "Run a command",
    icon: TerminalWindow,
    accent: "#7EC9A3",
    description: "Execute a shell command in the lane workspace.",
  },
  "predict-conflicts": {
    kind: "predict-conflicts",
    label: "Predict conflicts",
    icon: Warning,
    accent: "#E8B45A",
    description: "Run the conflict-prediction pass against recent lanes.",
  },
  "delete-lane": {
    kind: "delete-lane",
    label: "Delete the lane",
    icon: Trash,
    accent: "#E06C75",
    description: "Clean up the run's lane, optionally after a delay.",
  },
};

/** The steps offered in the "+ add step" menu, in order. */
export const ADD_STEP_ORDER: readonly StepKind[] = [
  "agent-session",
  "ade-action",
  "run-tests",
  "run-command",
  "predict-conflicts",
  "delete-lane",
];

export function stepDef(kind: StepKind): StepDef {
  return STEP_DEFS[kind] ?? STEP_DEFS["ade-action"];
}

export function isCleanupKind(kind: string): boolean {
  return kind === DELETE_LANE_ACTION_TYPE;
}
