import React from "react";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import copilotLogo from "@lobehub/icons-static-svg/icons/githubcopilot.svg";
import cursorLogo from "@lobehub/icons-static-svg/icons/cursor.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import greptileLogo from "@lobehub/icons-static-svg/icons/greptile-color.svg";
import awsLogo from "@lobehub/icons-static-svg/icons/aws-color.svg";
import windsurfLogo from "@lobehub/icons-static-svg/icons/windsurf.svg";
import vercelLogo from "@lobehub/icons-static-svg/icons/vercel.svg";
import cloudflareLogo from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import githubLogo from "@lobehub/icons-static-svg/icons/github.svg";
import opencodeLogo from "@lobehub/icons-static-svg/icons/opencode.svg";
import googleLogo from "@lobehub/icons-static-svg/icons/google-color.svg";

import { classifyPrAuthor, type PrAuthorIdentity } from "../../../../shared/prBotIdentity";
import { COLORS } from "../../lanes/laneDesignTokens";
import { PrUserAvatar } from "./PrUserAvatar";

/**
 * Bundled marks for the agents whose logo ships with ADE. `mono` marks are
 * single-color SVGs (`fill="currentColor"`): drawn as a mask so they take the
 * brand color in both themes instead of rendering black. Every other bot falls
 * back to its GitHub app avatar — which IS the app's real logo — and only then
 * to a brand-colored monogram.
 */
const BUNDLED_MARKS: Record<string, { src: string; mono?: boolean }> = {
  claude: { src: claudeLogo },
  codex: { src: codexLogo },
  copilot: { src: copilotLogo, mono: true },
  cursor: { src: cursorLogo, mono: true },
  gemini: { src: geminiLogo },
  greptile: { src: greptileLogo },
  amazonq: { src: awsLogo },
  windsurf: { src: windsurfLogo, mono: true },
  vercel: { src: vercelLogo, mono: true },
  cloudflare: { src: cloudflareLogo },
  "github-actions": { src: githubLogo, mono: true },
  opencode: { src: opencodeLogo, mono: true },
  jules: { src: googleLogo },
};

function Monogram({ identity, size }: { identity: PrAuthorIdentity; size: number }) {
  const color = identity.brandColor ?? COLORS.textMuted;
  const letter = (identity.displayName || identity.login || "?").replace(/[^A-Za-z0-9]/g, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(8, Math.round(size * 0.5)),
        color,
        background: `color-mix(in srgb, ${color} 20%, transparent)`,
      }}
    >
      {letter}
    </span>
  );
}

export const PrAgentAvatar = React.memo(function PrAgentAvatar({
  login,
  isBot,
  avatarUrl,
  size = 18,
}: {
  login: string | null | undefined;
  isBot?: boolean;
  avatarUrl?: string | null;
  size?: number;
}) {
  const identity = classifyPrAuthor(login, isBot);
  if (!identity.isBot) {
    return <PrUserAvatar user={{ login: identity.login, avatarUrl: avatarUrl ?? null }} size={size} />;
  }
  const mark = identity.kind ? BUNDLED_MARKS[identity.kind] : undefined;
  const title = identity.displayName;
  // Vite inlines small SVGs as `data:` URLs full of quotes and parens, which an
  // unquoted CSS `url()` cannot hold — the mask silently fails to a solid box.
  const maskUrl = mark ? `url("${mark.src.replace(/"/g, "%22")}")` : "";
  if (mark) {
    const inner = Math.round(size * 0.72);
    return (
      <span
        title={title}
        data-agent-kind={identity.kind}
        className="inline-flex shrink-0 items-center justify-center rounded-[5px]"
        style={{ width: size, height: size, background: "color-mix(in srgb, var(--color-fg) 7%, transparent)" }}
      >
        {mark.mono ? (
          <span
            aria-hidden
            style={{
              width: inner,
              height: inner,
              backgroundColor: identity.brandColor ?? "var(--color-fg)",
              WebkitMaskImage: maskUrl,
              maskImage: maskUrl,
              WebkitMaskSize: "contain",
              maskSize: "contain",
              WebkitMaskRepeat: "no-repeat",
              maskRepeat: "no-repeat",
              WebkitMaskPosition: "center",
              maskPosition: "center",
            }}
          />
        ) : (
          <img src={mark.src} alt="" width={inner} height={inner} draggable={false} className="object-contain" />
        )}
      </span>
    );
  }
  if (avatarUrl) {
    return (
      <span title={title} data-agent-kind={identity.kind ?? "bot"} className="inline-flex shrink-0">
        <PrUserAvatar user={{ login: identity.login, avatarUrl }} size={size} />
      </span>
    );
  }
  return (
    <span title={title} data-agent-kind={identity.kind ?? "bot"} className="inline-flex shrink-0">
      <Monogram identity={identity} size={size} />
    </span>
  );
});
