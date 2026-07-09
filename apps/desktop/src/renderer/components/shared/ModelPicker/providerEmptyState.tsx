import { Gear, ArrowSquareOut, Terminal } from "@phosphor-icons/react";
import type { AuthType, ProviderFamily } from "../../../../shared/modelRegistry";
import { openExternalUrl } from "../../../lib/openExternal";
import { cn } from "../../ui/cn";

export type ProviderEmptyStateAction =
  | { kind: "open-settings" }
  | { kind: "open-external"; url: string };

type ProviderCopy = {
  title: string;
  body: string;
  primary?: { label: string; action: ProviderEmptyStateAction };
  secondary?: { label: string; action: ProviderEmptyStateAction };
};

// Curated, per-provider empty-state copy. Mirrors the install hints from
// settings/ProvidersSection.tsx so a user landing here from the picker gets
// the same official URLs.
const PROVIDER_COPY: Partial<Record<ProviderFamily, ProviderCopy>> = {
  anthropic: {
    title: "Sign in to Claude",
    body: "Open a Claude login terminal on the primary lane, then complete the browser sign-in.",
    primary: { label: "Login to Claude", action: { kind: "open-settings" } },
    secondary: {
      label: "Claude Code docs",
      action: { kind: "open-external", url: "https://docs.claude.com/en/docs/agents-and-tools/claude-code/setup" },
    },
  },
  openai: {
    title: "Sign in to OpenAI Codex",
    body: "Install the Codex CLI and sign in to use OpenAI GPT models.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "Codex CLI install",
      action: { kind: "open-external", url: "https://github.com/openai/codex" },
    },
  },
  cursor: {
    title: "Connect Cursor",
    body: "Add a Cursor API key in Settings to discover Cursor SDK models.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "Get Cursor API key",
      action: { kind: "open-external", url: "https://cursor.com/dashboard/api" },
    },
  },
  factory: {
    title: "Install Droid CLI",
    body: "Install Factory's `droid` CLI and ensure it's on PATH to discover Droid models.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "Droid quickstart",
      action: { kind: "open-external", url: "https://docs.factory.ai/cli/getting-started/quickstart" },
    },
  },
  opencode: {
    title: "Install OpenCode",
    body: "Install the OpenCode CLI to surface 75+ models from Anthropic, Google, Mistral, DeepSeek, and more.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "OpenCode site",
      action: { kind: "open-external", url: "https://opencode.ai/" },
    },
  },
  lmstudio: {
    title: "Start LM Studio",
    body: "Launch the LM Studio app and load a model — ADE will pick it up automatically.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "Download LM Studio",
      action: { kind: "open-external", url: "https://lmstudio.ai/" },
    },
  },
  ollama: {
    title: "Start Ollama",
    body: "Run the Ollama daemon and pull a model — ADE auto-discovers local models.",
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "Get Ollama",
      action: { kind: "open-external", url: "https://ollama.com/download" },
    },
  },
};

function dispatchAction(action: ProviderEmptyStateAction, onOpenSignIn?: () => void): void {
  if (action.kind === "open-settings") {
    onOpenSignIn?.();
    return;
  }
  openExternalUrl(action.url);
}

export type ProviderEmptyStateProps =
  | {
      family: ProviderFamily;
      mode?: "default" | "discovery-empty";
      onOpenSignIn?: (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void;
    }
  | {
      mode: "opencode-required";
      family: "opencode" | "ollama" | "lmstudio";
      onOpenSignIn?: (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void;
    };

const PROVIDER_DISPLAY_LABELS: Partial<Record<ProviderFamily, string>> = {
  anthropic: "Claude",
  openai: "OpenAI Codex",
  cursor: "Cursor",
  factory: "Droid",
  opencode: "OpenCode",
  lmstudio: "LM Studio",
  ollama: "Ollama",
};

const OPENCODE_REQUIRED_PROVIDER_LABELS: Record<"opencode" | "ollama" | "lmstudio", string> = {
  opencode: "OpenCode",
  ollama: "Ollama",
  lmstudio: "LM Studio",
};

function opencodeRequiredCopy(forProvider: "opencode" | "ollama" | "lmstudio"): ProviderCopy {
  const label = OPENCODE_REQUIRED_PROVIDER_LABELS[forProvider];
  return {
    title: "Install OpenCode",
    body: `Install OpenCode to use ${label} models.`,
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "OpenCode site",
      action: { kind: "open-external", url: "https://opencode.ai/" },
    },
  };
}

function discoveryEmptyCopy(family: ProviderFamily): ProviderCopy {
  const label = PROVIDER_DISPLAY_LABELS[family] ?? family;
  if (family === "cursor") {
    return {
      title: "No Cursor models found",
      body: "Cursor is connected, but ADE did not receive any Cursor SDK models yet.",
      primary: { label: "Open Settings", action: { kind: "open-settings" } },
      secondary: {
        label: "Get Cursor API key",
        action: { kind: "open-external", url: "https://cursor.com/dashboard/api" },
      },
    };
  }
  return {
    title: `No ${label} models found`,
    body: `${label} is connected, but ADE did not receive any models yet.`,
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
  };
}

export type ProviderSetupBannerProps = {
  family: ProviderFamily;
  onOpenSignIn?: (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void;
};

/**
 * Small inline "Set up {Provider}" banner. Rendered above the model list when
 * the user is browsing a provider rail they haven't authed yet, so the
 * affordance is visible alongside the dimmed canonical rows.
 *
 * Falls back to a generic "Set up provider" label for unmapped families. When
 * no `onOpenSignIn` handler is provided the banner is hidden (no dead button).
 */
export function ProviderSetupBanner({ family, onOpenSignIn }: ProviderSetupBannerProps) {
  if (!onOpenSignIn) return null;
  const label = PROVIDER_DISPLAY_LABELS[family] ?? family;
  const claude = family === "anthropic";
  return (
    <button
      type="button"
      data-model-picker-setup-banner="true"
      data-provider-family={family}
      onClick={() => onOpenSignIn(family)}
      className={cn(
        "group sticky top-0 z-[6] mx-0.5 mb-1 flex items-center justify-between gap-2 rounded-md px-2 py-1.5",
        "border border-white/[0.06] bg-white/[0.025] backdrop-blur",
        "text-[10px] font-medium text-muted-fg/65 transition-colors",
        "hover:border-violet-400/25 hover:bg-violet-500/[0.06] hover:text-fg/85",
      )}
    >
      <span className="inline-flex items-center gap-1.5">
        {claude ? (
          <Terminal size={11} weight="bold" className="opacity-70 group-hover:opacity-100" />
        ) : (
          <Gear size={11} weight="bold" className="opacity-70 group-hover:opacity-100" />
        )}
        <span>{claude ? "Login to Claude" : `Set up ${label}`}</span>
      </span>
      <ArrowSquareOut size={10} weight="bold" className="opacity-60 group-hover:opacity-100" />
    </button>
  );
}

export function ProviderEmptyState(props: ProviderEmptyStateProps) {
  const { family, onOpenSignIn } = props;
  const mode = props.mode ?? "default";
  const copy = mode === "opencode-required"
    ? opencodeRequiredCopy(family as "opencode" | "ollama" | "lmstudio")
    : mode === "discovery-empty"
      ? discoveryEmptyCopy(family)
      : PROVIDER_COPY[family];
  if (!copy) {
    return (
      <div className="flex h-full min-h-[200px] flex-col items-center justify-center gap-1 px-4 py-6 text-center">
        <span className="text-[11px] font-medium text-muted-fg/65">
          No models discovered for this provider yet.
        </span>
      </div>
    );
  }
  return (
    <div
      data-model-picker-empty-state="provider"
      data-provider-family={family}
      data-empty-state-mode={mode}
      className="flex h-full min-h-[200px] flex-col items-center justify-center gap-2 px-6 py-6 text-center"
    >
      <span className="text-[12px] font-semibold text-fg/90">{copy.title}</span>
      <span className="max-w-[280px] text-[11px] leading-relaxed text-muted-fg/65">{copy.body}</span>
      <div className="mt-2 flex items-center gap-1.5">
        {copy.primary ? (
          <button
            type="button"
            onClick={() => dispatchAction(copy.primary!.action, () => onOpenSignIn?.(family))}
            className={cn(
              "inline-flex h-6 items-center rounded-md border border-violet-400/30 bg-violet-500/[0.12] px-2.5",
              "text-[10px] font-semibold uppercase tracking-wide text-violet-100",
              "transition-colors hover:border-violet-400/45 hover:bg-violet-500/[0.18]",
            )}
          >
            {copy.primary.label}
          </button>
        ) : null}
        {copy.secondary ? (
          <button
            type="button"
            onClick={() => dispatchAction(copy.secondary!.action, onOpenSignIn)}
            className={cn(
              "inline-flex h-6 items-center rounded-md border border-white/[0.08] bg-white/[0.03] px-2.5",
              "text-[10px] font-semibold uppercase tracking-wide text-fg/75",
              "transition-colors hover:border-white/[0.14] hover:bg-white/[0.06] hover:text-fg/90",
            )}
          >
            {copy.secondary.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
