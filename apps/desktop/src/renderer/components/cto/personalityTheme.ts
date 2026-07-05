import type { Icon } from "@phosphor-icons/react";
import { Briefcase, Handshake, Lightning, Sparkle, Strategy, Wrench } from "@phosphor-icons/react";
import type { CtoCommunicationStyle, CtoPersonalityPreset } from "../../../shared/types";

/**
 * Each personality owns a hue. It tints the avatar ring, the personality chip,
 * the selected preset tile, and the waking indicator — so the CTO surface reads
 * as the personality the user chose (a green hands-on lead, a purple executive)
 * instead of a single fixed accent. The hue encodes real state; it is not decoration.
 */
export type PersonalityTheme = {
  /** "r, g, b" triplet for rgba() composition. */
  rgb: string;
  hex: string;
  icon: Icon;
};

export const PERSONALITY_THEME: Record<CtoPersonalityPreset, PersonalityTheme> = {
  strategic: { rgb: "96, 165, 250", hex: "#60A5FA", icon: Strategy },
  professional: { rgb: "167, 139, 250", hex: "#A78BFA", icon: Briefcase },
  hands_on: { rgb: "52, 211, 153", hex: "#34D399", icon: Wrench },
  casual: { rgb: "251, 191, 36", hex: "#FBBF24", icon: Handshake },
  minimal: { rgb: "34, 211, 238", hex: "#22D3EE", icon: Lightning },
  custom: { rgb: "244, 114, 182", hex: "#F472B6", icon: Sparkle },
};

export function getPersonalityTheme(preset: CtoPersonalityPreset | null | undefined): PersonalityTheme {
  return PERSONALITY_THEME[preset ?? "strategic"] ?? PERSONALITY_THEME.strategic;
}

/* ── Work style ── */

export const DEFAULT_COMMUNICATION_STYLE: CtoCommunicationStyle = {
  verbosity: "adaptive",
  proactivity: "balanced",
  escalationThreshold: "medium",
};

type WorkStyleRow = {
  key: keyof CtoCommunicationStyle;
  label: string;
  hint: string;
  options: { value: string; label: string }[];
};

export const WORK_STYLE_ROWS: WorkStyleRow[] = [
  {
    key: "verbosity",
    label: "Detail",
    hint: "How much the CTO explains.",
    options: [
      { value: "concise", label: "Concise" },
      { value: "adaptive", label: "Adaptive" },
      { value: "detailed", label: "Detailed" },
    ],
  },
  {
    key: "proactivity",
    label: "Initiative",
    hint: "How often it raises things unprompted.",
    options: [
      { value: "reactive", label: "Reactive" },
      { value: "balanced", label: "Balanced" },
      { value: "proactive", label: "Proactive" },
    ],
  },
  {
    key: "escalationThreshold",
    label: "Escalation",
    hint: "When it flags risk to you.",
    options: [
      { value: "low", label: "Early" },
      { value: "medium", label: "Balanced" },
      { value: "high", label: "Late" },
    ],
  },
];

export function normalizeCommunicationStyle(
  style: CtoCommunicationStyle | null | undefined,
): CtoCommunicationStyle {
  return { ...DEFAULT_COMMUNICATION_STYLE, ...(style ?? {}) };
}
