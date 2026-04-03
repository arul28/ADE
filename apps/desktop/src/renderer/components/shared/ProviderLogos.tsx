import React from "react";
import {
  Anthropic,
  Claude,
  Codex,
  Cursor,
  Gemini,
  Google,
  Grok,
  Groq,
  Kimi,
  OpenAI,
  OpenCode,
  OpenRouter,
  XAI,
} from "@lobehub/icons";
import { parseDynamicCursorModelRef, type ProviderFamily } from "../../../shared/modelRegistry";
import { lobeProviderIconSrc } from "../../lib/lobeProviderIconSrc";
import { cn } from "../ui/cn";

type LogoProps = { size?: number; className?: string };

function lobeMarkClass(className?: string) {
  return cn("shrink-0 inline-flex [&_svg]:max-h-none [&_svg]:max-w-none", className);
}

const FALLBACK_COLORS: Record<string, string> = {
  groq: "#06B6D4",
  together: "#22C55E",
  meta: "#3B82F6",
};

function FallbackInitialLogo({ family, size = 16, className }: { family: string; size?: number; className?: string }) {
  const ch = (family.trim().charAt(0) || "?").toUpperCase();
  const bg = FALLBACK_COLORS[family.toLowerCase()] ?? "#6B7280";
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center rounded-md font-sans font-bold text-white", className)}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.45),
        backgroundColor: `${bg}cc`,
      }}
    >
      {ch}
    </span>
  );
}

function LobeStaticMark({ src, size, className }: { src: string; size: number; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      draggable={false}
      className={cn("shrink-0 object-contain", className)}
    />
  );
}

function CursorSubscriptionModelMark({ providerModelId, size, className }: { providerModelId: string; size: number; className?: string }) {
  const s = providerModelId.trim().toLowerCase();
  const c = lobeMarkClass(className);
  if (s === "auto" || s.includes("composer")) {
    return <Cursor.Avatar size={size} className={c} />;
  }
  if (/gemini/.test(s)) {
    return <Gemini.Color size={size} className={c} />;
  }
  if (/grok/.test(s)) {
    return <Grok.Avatar size={size} className={c} />;
  }
  if (/kimi/.test(s)) {
    return <Kimi.Color size={size} className={c} />;
  }
  if (/claude|sonnet|opus|haiku/.test(s)) {
    return <Claude.Avatar size={size} className={c} />;
  }
  if (/^gpt|^o\d|codex/.test(s)) {
    return <OpenAI size={size} className={c} />;
  }
  return <Cursor.Avatar size={size} className={c} />;
}

function resolveCursorProviderModelId(modelId: string | undefined, providerModelId: string | undefined): string {
  const fromField = (providerModelId ?? "").trim();
  if (fromField.length) return fromField;
  const parsed = modelId ? parseDynamicCursorModelRef(modelId) : null;
  return parsed?.providerModelId?.trim() ?? "";
}

/**
 * Provider / nav marks — company (or router) branding.
 * @see https://lobehub.com/icons/skill.md
 */
export function ProviderLogo({
  family,
  size = 16,
  className,
}: {
  family: ProviderFamily | string;
  size?: number;
  className?: string;
}) {
  const raw = String(family ?? "").toLowerCase();
  const c = lobeMarkClass(className);
  switch (raw) {
    case "anthropic":
      return <Anthropic.Avatar size={size} className={c} />;
    case "openai":
      return <OpenAI size={size} className={c} />;
    case "cursor":
      return <Cursor.Avatar size={size} className={c} />;
    case "factory":
      return <FallbackInitialLogo family="droid" size={size} className={className} />;
    case "opencode":
      return <OpenCode.Avatar size={size} className={c} />;
    case "xai":
      return <XAI.Avatar size={size} className={c} />;
    case "groq":
      return <Groq.Avatar size={size} className={c} />;
    case "openrouter":
      return <OpenRouter.Avatar size={size} className={c} />;
    case "google":
      return <Google.Avatar size={size} className={c} />;
    default: {
      const lobeSrc = lobeProviderIconSrc(raw);
      if (lobeSrc) {
        return <LobeStaticMark src={lobeSrc} size={size} className={className} />;
      }
      return <FallbackInitialLogo family={raw} size={size} className={className} />;
    }
  }
}

/** Per-model row: product marks (Claude, Codex, Cursor lines, etc.). */
export function ModelRowLogo({
  modelFamily,
  cliCommand,
  modelId,
  providerModelId,
  size = 13,
  className,
}: {
  modelFamily: string;
  cliCommand?: string;
  modelId?: string;
  providerModelId?: string;
  size?: number;
  className?: string;
}) {
  const fam = String(modelFamily ?? "").toLowerCase();
  const cli = String(cliCommand ?? "").toLowerCase();
  const c = lobeMarkClass(className);

  if (fam === "cursor" || cli === "cursor") {
    const providerModel = resolveCursorProviderModelId(modelId, providerModelId);
    if (!providerModel.length) {
      return <Cursor.Avatar size={size} className={c} />;
    }
    return <CursorSubscriptionModelMark providerModelId={providerModel} size={size} className={className} />;
  }

  if (fam === "anthropic" || cli === "claude") {
    return <Claude.Avatar size={size} className={c} />;
  }

  if (cli === "codex") {
    return <Codex.Avatar size={size} className={lobeMarkClass(cn("opacity-95", className))} />;
  }

  if (fam === "openai") {
    return <OpenAI size={size} className={lobeMarkClass(cn("opacity-95", className))} />;
  }

  if (fam === "opencode") {
    return <OpenCode.Avatar size={size} className={c} />;
  }

  if (fam === "google") {
    return <Gemini.Color size={size} className={c} />;
  }

  if (fam === "xai") {
    const hint = `${providerModelId ?? ""} ${modelId ?? ""}`.toLowerCase();
    if (/grok/.test(hint)) {
      return <Grok.Avatar size={size} className={c} />;
    }
    return <XAI.Avatar size={size} className={c} />;
  }

  return <ProviderLogo family={fam} size={size} className={className} />;
}
