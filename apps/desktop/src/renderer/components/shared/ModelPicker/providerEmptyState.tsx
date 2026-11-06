import { PROVIDER_DISPLAY_NAME } from "../../../../shared/providers";

import type { AuthType, ProviderFamily } from "../../../../shared/modelRegistry";
import { PROVIDER_REMEDIATION } from "../../../../shared/providerRemediation";
import { openExternalUrl } from "../../../lib/openExternal";
import { cn } from "../../ui/cn";
import { Banner } from "../../ui/notice";
import { ProviderLogo } from "../ProviderLogos";

export type ProviderEmptyStateAction =
  | { kind: "open-settings" }
  | { kind: "open-external"; url: string };

type ProviderCopy = {
  title: string;
  body: string;
  primary?: { label: string; action: ProviderEmptyStateAction };
  secondary?: { label: string; action: ProviderEmptyStateAction };
};

// Curated, per-provider empty-state copy.
//
// Every shipped provider's docs URL comes from `shared/providerRemediation.ts`,
// the one table, so a user cannot be sent to one page from the picker and a
// different page from Settings. The four ACP rows (Qwen, Kimi, Grok, Copilot)
// and the two local-runtime rows are not shipped providers and name their own.
const PROVIDER_COPY: Partial<Record<ProviderFamily, ProviderCopy>> = {
  anthropic: {
    title: "Sign in to Claude",
    body: "Sign in with your Claude account to use Claude models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Claude Code docs",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.claude.docsUrl },
    },
  },
  openai: {
    title: "Sign in to Codex",
    body: "Sign in with ChatGPT to use OpenAI models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Codex CLI docs",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.codex.docsUrl },
    },
  },
  muse: {
    title: "Sign in to Muse Code",
    body: "Sign in with your Meta account to use Muse models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Muse Code docs",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.muse.docsUrl },
    },
  },
  cursor: {
    title: "Sign in to Cursor",
    body: "Sign in with your Cursor account to use Cursor models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Get Cursor API key",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.cursor.docsUrl },
    },
  },
  factory: {
    title: "Sign in to Droid",
    body: "Sign in with your Factory account to use Droid models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Droid quickstart",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.droid.docsUrl },
    },
  },
  opencode: {
    title: "Set up OpenCode",
    body: "Connect a model provider in OpenCode to use its models here.",
    primary: { label: "Set up", action: { kind: "open-settings" } },
    secondary: {
      label: "OpenCode site",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.opencode.docsUrl },
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
  qwen: {
    title: "Set up Qwen Code",
    body: "Add your Qwen key to use Qwen models here.",
    primary: { label: "Set up", action: { kind: "open-settings" } },
    secondary: {
      label: "Qwen Code docs",
      action: { kind: "open-external", url: "https://github.com/QwenLM/qwen-code" },
    },
  },
  moonshot: {
    title: "Sign in to Kimi",
    body: "Sign in with your Kimi account to use Kimi models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Kimi Code docs",
      action: { kind: "open-external", url: "https://github.com/MoonshotAI/kimi-code" },
    },
  },
  xai: {
    title: "Sign in to Grok",
    body: "Sign in with your xAI account to use Grok models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Grok CLI docs",
      action: { kind: "open-external", url: "https://docs.x.ai/docs/grok-cli" },
    },
  },
  "github-copilot": {
    title: "Sign in to GitHub Copilot",
    body: "Sign in with GitHub to use Copilot models here.",
    primary: { label: "Sign in", action: { kind: "open-settings" } },
    secondary: {
      label: "Copilot CLI docs",
      action: { kind: "open-external", url: "https://github.com/github/copilot-cli" },
    },
  },
  pi: {
    title: "Set up Pi",
    body: "Sign Pi in to a model provider to use its models here.",
    primary: { label: "Set up", action: { kind: "open-settings" } },
    secondary: {
      label: "Pi documentation",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.pi.docsUrl },
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
  muse: PROVIDER_DISPLAY_NAME.muse,
  cursor: "Cursor",
  factory: "Droid",
  pi: "Pi",
  qwen: "Qwen",
  moonshot: "Kimi",
  xai: "Grok",
  "github-copilot": "GitHub Copilot",
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
    title: "OpenCode needed",
    body: `${label} models run through OpenCode. ADE downloads its own pinned OpenCode for this machine.`,
    primary: { label: "Open Settings", action: { kind: "open-settings" } },
    secondary: {
      label: "OpenCode site",
      action: { kind: "open-external", url: PROVIDER_REMEDIATION.opencode.docsUrl },
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
        action: { kind: "open-external", url: PROVIDER_REMEDIATION.cursor.docsUrl },
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
  // The whole row is the click target (the picker's sticky "set up" row), so
  // the Banner sits inside one bare button rather than carrying its own action.
  return (
    <button
      type="button"
      data-model-picker-setup-banner="true"
      data-provider-family={family}
      onClick={() => onOpenSignIn(family)}
      className="sticky top-0 z-[6] mb-1 block w-full rounded-[10px] text-left backdrop-blur"
    >
      <Banner
        layout="inline"
        model={{
          id: `model-picker-setup:${family}`,
          tone: "info",
          icon: <ProviderLogo family={family} size={13} />,
          title: `Sign in to ${label}`,
        }}
        style={{ margin: "0 2px" }}
      />
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
              "inline-flex h-6 items-center rounded-md border border-fg/[0.08] bg-fg/[0.03] px-2.5",
              "text-[10px] font-semibold uppercase tracking-wide text-fg/75",
              "transition-colors hover:border-fg/[0.14] hover:bg-fg/[0.06] hover:text-fg/90",
            )}
          >
            {copy.secondary.label}
          </button>
        ) : null}
      </div>
    </div>
  );
}
