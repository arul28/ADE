import React from "react";
import { ArrowSquareOut, PuzzlePiece } from "@phosphor-icons/react";

import { cn } from "../ui/cn";
import {
  CHAT_CARD_MICRO_TEXT,
  ChatCard,
  ChatCardButton,
  ChatCardChip,
  ChatCardRow,
  ChatCardSub,
  ChatCardTitle,
} from "./chatCardPrimitives";
import { navigateToAppTarget, openUrlInAdeBrowser } from "../../lib/openExternal";
import { installPlugin, pluginMarketplaceCapabilities } from "../../lib/pluginRuntimeBridge";
import { rootAppStoreApi } from "../../state/appStore";
import type { AdeCardPluginInstall } from "../../../shared/adeCard";

/**
 * The in-chat install card.
 *
 * An agent that just built or found a plugin can offer it here rather than
 * sending the reader to the Marketplace to hunt for it. That makes the
 * transcript an install surface, so the card carries the same disclosure the
 * modal does — one sentence, the source, and what the plugin adds — and never
 * installs without a press.
 *
 * It installs through the same bridge call the Marketplace uses instead of
 * broadcasting a `ade:chat:card-action` event for a host to interpret. The
 * event route exists for actions only the chat host can service; this one is
 * self-contained, and routing it through a listener would put the consent
 * surface and the thing it consents to in different files.
 */

type Phase = "idle" | "installing" | "installed" | "error";

export function PluginInstallChatCard({
  install,
  subtitle,
}: {
  install: AdeCardPluginInstall;
  subtitle?: string | null;
}) {
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  const capabilities = React.useMemo(() => pluginMarketplaceCapabilities(), []);

  const openInMarketplace = () => {
    navigateToAppTarget({ kind: "route", route: `/marketplace/${install.pluginId}` });
  };

  const run = () => {
    setPhase("installing");
    setError(null);
    void installPlugin({
      source: install.source,
      pluginId: install.pluginId,
      ...(install.version ? { version: install.version } : {}),
    })
      .then(async () => {
        await rootAppStoreApi.getState().refreshInstalledPlugins();
        setPhase("installed");
      })
      .catch((cause: unknown) => {
        setPhase("error");
        setError(cause instanceof Error ? cause.message : "The install did not finish.");
      });
  };

  const adds = install.adds ?? [];

  return (
    <ChatCard skin="inset" tone={phase === "error" ? "warn" : "neutral"}>
      <ChatCardRow tone="neutral" icon={PuzzlePiece} align="top">
        <div className="flex min-w-0 items-baseline gap-1.5">
          <ChatCardTitle className="shrink">{install.displayName}</ChatCardTitle>
          {install.version ? <ChatCardChip tone="idle">{install.version}</ChatCardChip> : null}
          {phase === "installed" ? <ChatCardChip tone="ok">installed</ChatCardChip> : null}
        </div>
        {subtitle?.trim() ? <ChatCardSub className="mt-0.5">{subtitle.trim()}</ChatCardSub> : null}
      </ChatCardRow>

      {adds.length > 0 ? (
        <ul className="ml-[26px] mt-2 flex flex-col gap-1">
          {adds.slice(0, 5).map((line) => (
            <li key={line} className={cn("flex gap-2 text-fg/60", CHAT_CARD_MICRO_TEXT)}>
              <span aria-hidden className="text-fg/30">—</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className={cn("ml-[26px] mt-2 text-fg/45", CHAT_CARD_MICRO_TEXT)}>
        Runs with the same access as tools you install yourself.
      </div>

      {error ? (
        <div className={cn("ml-[26px] mt-1.5 text-amber-200/70", CHAT_CARD_MICRO_TEXT)}>{error}</div>
      ) : null}

      <div className="ml-[26px] mt-2 flex flex-wrap items-center gap-1.5">
        {phase === "installed" ? (
          <ChatCardButton primary onClick={openInMarketplace}>Open it</ChatCardButton>
        ) : (
          <ChatCardButton
            primary
            onClick={() => { if (phase !== "installing" && capabilities.install) run(); }}
          >
            {phase === "installing" ? "Installing…" : "Install"}
          </ChatCardButton>
        )}
        <ChatCardButton onClick={() => openUrlInAdeBrowser(install.source)}>
          <ArrowSquareOut size={10} weight="regular" aria-hidden />
          View source
        </ChatCardButton>
      </div>

      {!capabilities.install ? (
        <div className={cn("ml-[26px] mt-1.5 text-fg/40", CHAT_CARD_MICRO_TEXT)}>
          This build can’t install plugins.
        </div>
      ) : null}
    </ChatCard>
  );
}
