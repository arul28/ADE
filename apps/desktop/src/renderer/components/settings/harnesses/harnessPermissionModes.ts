/**
 * The permission vocabulary a preset saves, per harness.
 *
 * Each harness has its own words for "how much can this agent do without
 * asking": Claude has five modes, Codex four presets, OpenCode four, Droid five,
 * Cursor a machine-reported list, and the ACP CLIs share the runtime's own
 * six-value union. The option data comes from the tables the composer already
 * uses (`renderer/lib/nativeLaunchControls.ts` and `shared/types/chat.ts`) —
 * this module only puts a tone and a glyph on each row so the shared
 * `PermissionModePicker` can render them, and picks the default the harness
 * starts on.
 *
 * Nothing here invents a mode. A harness ADE does not have a table for falls
 * back to the runtime union, which is exactly what its chat launch path already
 * accepts.
 */

import {
  AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS,
} from "../../../../shared/types/chat";
import {
  CLAUDE_PERMISSION_OPTIONS,
  CODEX_PERMISSION_PRESETS,
  OPENCODE_PERMISSION_OPTIONS,
  cursorModeChoices,
  cursorModeLabel,
} from "../../../lib/nativeLaunchControls";
import type { PermissionModePickerOption } from "../../shared/PermissionModePicker";
import type { HarnessPresetBody } from "../../../../shared/harnessPresets";

type Option = PermissionModePickerOption<string>;

function tonedOption(
  value: string,
  label: string,
  detail: string,
  presentation: Pick<Option, "tone" | "icon"> & { triggerLabel?: string },
): Option {
  return { value, label, detail, ...presentation };
}

const CLAUDE_PRESENTATION: Record<string, Pick<Option, "tone" | "icon">> = {
  default: { tone: "green", icon: "manual" },
  auto: { tone: "amber", icon: "auto" },
  acceptEdits: { tone: "amber", icon: "edit" },
  plan: { tone: "purple", icon: "plan" },
  bypassPermissions: { tone: "red", icon: "full" },
};

const CODEX_PRESENTATION: Record<string, Pick<Option, "tone" | "icon">> = {
  default: { tone: "green", icon: "manual" },
  edit: { tone: "amber", icon: "edit" },
  plan: { tone: "purple", icon: "plan" },
  "full-auto": { tone: "red", icon: "full" },
  "config-toml": { tone: "slate", icon: "config" },
};

const OPENCODE_PRESENTATION = CODEX_PRESENTATION;

const DROID_PRESENTATION: Record<string, Pick<Option, "tone" | "icon">> = {
  "read-only": { tone: "green", icon: "manual" },
  "auto-low": { tone: "green", icon: "edit" },
  "auto-medium": { tone: "amber", icon: "auto" },
  "auto-high": { tone: "red", icon: "full" },
  agi: { tone: "purple", icon: "agi" },
};

const RUNTIME_OPTIONS: Option[] = [
  tonedOption("default", "Default", "The harness asks before edits and other sensitive tools.", { tone: "green", icon: "manual" }),
  tonedOption("auto", "Auto", "The harness judges each tool call instead of asking.", { tone: "amber", icon: "auto" }),
  tonedOption("plan", "Plan", "Read-only turns, for analysis and planning.", { tone: "purple", icon: "plan" }),
  tonedOption("edit", "Edit", "File edits are approved; higher-risk actions still prompt.", { tone: "amber", icon: "edit" }),
  tonedOption("full-auto", "Full auto", "No approval prompts at all.", { tone: "red", icon: "full" }),
];

/** Every mode the given harness understands, in the order the picker shows. */
export function harnessPermissionOptions(harness: HarnessPresetBody): Option[] {
  if (harness === "claude") {
    return CLAUDE_PERMISSION_OPTIONS.map((option) =>
      tonedOption(option.value, option.label, option.detail, CLAUDE_PRESENTATION[option.value] ?? { tone: "slate", icon: "manual" }),
    );
  }
  if (harness === "codex") {
    return CODEX_PERMISSION_PRESETS.map((option) =>
      tonedOption(option.value, option.label, option.detail, CODEX_PRESENTATION[option.value] ?? { tone: "slate", icon: "manual" }),
    );
  }
  if (harness === "opencode") {
    return OPENCODE_PERMISSION_OPTIONS.map((option) =>
      tonedOption(
        option.value,
        option.label,
        `OpenCode runs in its ${option.label.toLowerCase()} permission mode.`,
        OPENCODE_PRESENTATION[option.value] ?? { tone: "slate", icon: "manual" },
      ),
    );
  }
  if (harness === "droid") {
    return AGENT_CHAT_DROID_PERMISSION_MODE_OPTIONS.map((option) =>
      tonedOption(option.value, option.label, option.detail, DROID_PRESENTATION[option.value] ?? { tone: "slate", icon: "manual" }),
    );
  }
  if (harness === "cursor") {
    const choices = cursorModeChoices();
    if (choices.length > 0) {
      return choices.map((value) => {
        const normalized = value.trim().toLowerCase();
        const presentation: Pick<Option, "tone" | "icon"> =
          normalized.includes("plan")
            ? { tone: "purple", icon: "plan" }
            : normalized.includes("full") || normalized.includes("yolo") || normalized.includes("force")
              ? { tone: "red", icon: "full" }
              : normalized.includes("ask")
                ? { tone: "green", icon: "manual" }
                : { tone: "green", icon: "agent" };
        return tonedOption(value, cursorModeLabel(value), `Cursor Agent's ${cursorModeLabel(value).toLowerCase()} mode.`, presentation);
      });
    }
  }
  return RUNTIME_OPTIONS;
}

/** The mode a new preset for this harness starts on. */
export function defaultHarnessPermissionMode(harness: HarnessPresetBody): string {
  if (harness === "droid") return "auto-low";
  if (harness === "opencode") return "edit";
  if (harness === "cursor") return harnessPermissionOptions("cursor")[0]?.value ?? "default";
  return "default";
}

/** Keep a stored mode only when the harness still understands it. */
export function coerceHarnessPermissionMode(harness: HarnessPresetBody, mode: string | undefined): string {
  const options = harnessPermissionOptions(harness);
  if (mode && options.some((option) => option.value === mode)) return mode;
  return defaultHarnessPermissionMode(harness);
}

/** The label the list page and the picker's expanded row show. */
export function harnessPermissionLabel(harness: HarnessPresetBody, mode: string): string {
  return harnessPermissionOptions(harness).find((option) => option.value === mode)?.label ?? mode;
}
