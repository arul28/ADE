import React, { useCallback, useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import {
  ArrowSquareOut,
  GithubLogo,
  PlayCircle,
  X,
} from "@phosphor-icons/react";
import { docs } from "../../onboarding/docsLinks";
import { openExternalUrl } from "../../lib/openExternal";
import {
  ADE_GITHUB_URL,
  ADE_WELCOME_VIDEO_EMBED_URL,
  ADE_WELCOME_VIDEO_REPLAY_EVENT,
  ADE_WELCOME_VIDEO_WATCH_URL,
} from "../../../shared/welcomeVideo";

type WelcomeVideoGateProps = {
  onVisibilityChange?: (visible: boolean, checking: boolean) => void;
};

export function WelcomeVideoGate({ onVisibilityChange }: WelcomeVideoGateProps) {
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    onVisibilityChange?.(visible, checking);
  }, [checking, onVisibilityChange, visible]);

  useEffect(() => {
    let cancelled = false;
    void window.ade.app
      .getWelcomeVideoState()
      .then((state) => {
        if (cancelled) return;
        setVisible(!state.completedAt && !state.dismissedAt);
      })
      .catch(() => {
        if (!cancelled) setVisible(false);
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });

    const replay = () => {
      setChecking(false);
      setVisible(true);
    };
    window.addEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    return () => {
      cancelled = true;
      window.removeEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    };
  }, []);

  const close = useCallback((reason: "completed" | "dismissed") => {
    setVisible(false);
    void window.ade.app.markWelcomeVideoSeen(reason).catch(() => {});
  }, []);

  const openGitHub = useCallback(() => openExternalUrl(ADE_GITHUB_URL), []);
  const openDocs = useCallback(() => openExternalUrl(docs.home), []);
  const openVideo = useCallback(() => openExternalUrl(ADE_WELCOME_VIDEO_WATCH_URL), []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setVisible(true);
        return;
      }
      if (visible) close("dismissed");
    },
    [close, visible],
  );

  return (
    <Dialog.Root open={visible} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay
          className="ade-welcome-video"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 10020,
            background:
              "color-mix(in srgb, var(--color-bg, #0F0B1C) 72%, rgba(0,0,0,0.62))",
            backdropFilter: "blur(16px)",
          }}
        />
        <Dialog.Content
          style={{
            position: "fixed",
            left: "50%",
            top: "50%",
            zIndex: 10021,
            width: "min(920px, calc(100vw - 32px))",
            maxHeight: "min(92dvh, 820px)",
            overflow: "auto",
            transform: "translate(-50%, -50%)",
            borderRadius: 14,
            border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 22%, var(--color-border, rgba(255,255,255,0.14)))",
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-card, #171326) 95%, var(--color-accent, #A78BFA) 5%), var(--color-card, #12101D))",
            boxShadow:
              "0 24px 80px -24px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.04)",
            color: "var(--color-fg, #F5F3FF)",
            outline: "none",
          }}
        >
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: 16,
            padding: "22px 24px 16px",
            borderBottom: "1px solid color-mix(in srgb, var(--color-fg, #fff) 8%, transparent)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                borderRadius: 999,
                border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 32%, transparent)",
                background:
                  "color-mix(in srgb, var(--color-accent, #A78BFA) 14%, transparent)",
                color: "var(--color-accent, #A78BFA)",
                padding: "5px 9px",
                fontSize: 11,
                fontWeight: 700,
                textTransform: "uppercase",
              }}
            >
              <PlayCircle size={13} weight="fill" />
              Start here
            </div>
            <Dialog.Title
              style={{
                margin: "12px 0 0",
                fontSize: 30,
                lineHeight: 1.08,
                letterSpacing: 0,
              }}
            >
              Welcome to ADE
            </Dialog.Title>
            <Dialog.Description
              style={{
                margin: "8px 0 0",
                maxWidth: 640,
                color: "var(--color-muted-fg, #A8A4B8)",
                fontSize: 13.5,
                lineHeight: 1.55,
              }}
            >
              A quick orientation for lanes, Work sessions, PR flows, proof, and the local-first runtime.
            </Dialog.Description>
          </div>
          <button
            type="button"
            aria-label="Close welcome video"
            onClick={() => close("dismissed")}
            className="ade-shell-control"
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              borderRadius: 7,
              border: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(255,255,255,0.04)",
              color: "var(--color-muted-fg, #A8A4B8)",
              cursor: "pointer",
              flex: "0 0 auto",
            }}
          >
            <X size={14} weight="bold" />
          </button>
        </div>

        <div style={{ padding: "18px 24px 24px" }}>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 9,
              marginBottom: 16,
            }}
          >
            <WelcomeActionButton onClick={openGitHub} icon={<GithubLogo size={14} weight="fill" />}>
              GitHub
            </WelcomeActionButton>
            <WelcomeActionButton onClick={openDocs} icon={<ArrowSquareOut size={13} />}>
              Docs
            </WelcomeActionButton>
            <WelcomeActionButton onClick={openVideo} icon={<PlayCircle size={14} weight="fill" />}>
              Open video
            </WelcomeActionButton>
            <button
              type="button"
              onClick={() => close("completed")}
              style={{
                marginLeft: "auto",
                minHeight: 32,
                border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 44%, transparent)",
                borderRadius: 7,
                background: "var(--color-accent, #A78BFA)",
                color: "var(--color-accent-fg, #0B0A14)",
                padding: "0 13px",
                fontSize: 12,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              Continue
            </button>
          </div>

          <div
            style={{
              position: "relative",
              overflow: "hidden",
              borderRadius: 10,
              border: "1px solid color-mix(in srgb, var(--color-fg, #fff) 12%, transparent)",
              background: "#050507",
              aspectRatio: "16 / 9",
              boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
            }}
          >
            <iframe
              title="Welcome to ADE video"
              src={ADE_WELCOME_VIDEO_EMBED_URL}
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              style={{
                position: "absolute",
                inset: 0,
                width: "100%",
                height: "100%",
                border: 0,
              }}
            />
          </div>
        </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function WelcomeActionButton({
  children,
  icon,
  onClick,
}: {
  children: React.ReactNode;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 32,
        display: "inline-flex",
        alignItems: "center",
        gap: 7,
        border: "1px solid color-mix(in srgb, var(--color-fg, #fff) 12%, transparent)",
        borderRadius: 7,
        background: "color-mix(in srgb, var(--color-fg, #fff) 5%, transparent)",
        color: "var(--color-fg, #F5F3FF)",
        padding: "0 11px",
        fontSize: 12,
        fontWeight: 650,
        cursor: "pointer",
      }}
    >
      {icon}
      <span>{children}</span>
    </button>
  );
}
