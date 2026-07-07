import React, { useCallback, useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { QRCodeSVG } from "qrcode.react";
import {
  ArrowSquareOut,
  Check,
  Copy,
  GithubLogo,
  Play,
  X,
} from "@phosphor-icons/react";
import { docs } from "../../onboarding/docsLinks";
import { openExternalUrl } from "../../lib/openExternal";
import {
  ADE_WELCOME_VIDEO_EMBED_URL,
  ADE_WELCOME_VIDEO_REPLAY_EVENT,
} from "../../../shared/welcomeVideo";
import {
  ADE_GITHUB_URL,
  ADE_MOBILE_TESTFLIGHT_URL,
} from "../../../shared/productLinks";

type WelcomeVideoGateProps = {
  onVisibilityChange?: (visible: boolean, checking: boolean) => void;
};

type DeviceKind = "macbook" | "phone" | "terminal";
type CopyState = "idle" | "copied" | "failed";

type Surface = {
  key: string;
  label: string;
  blurb: string;
  img: string;
  url: string;
  device: DeviceKind;
};

export function publicAssetUrl(path: string): string {
  const normalized = path.replace(/^\/+/, "");
  if (typeof window !== "undefined" && /^https?:$/.test(window.location.protocol)) {
    return `/${normalized}`;
  }
  return `./${normalized}`;
}

// The three surfaces ADE runs on. Each tile frames a real screenshot in its
// device chrome and doubles as navigation into the matching docs section.
const SURFACES: ReadonlyArray<Surface> = [
  {
    key: "desktop",
    label: "Desktop",
    blurb: "The full lane workspace",
    img: publicAssetUrl("welcome/desktop.webp"),
    url: docs.home,
    device: "macbook",
  },
  {
    key: "mobile",
    label: "Mobile",
    blurb: "Review & approve on the go",
    img: publicAssetUrl("welcome/mobile.webp"),
    url: docs.syncMultiDevice,
    device: "phone",
  },
  {
    key: "tui",
    label: "Terminal",
    blurb: "ADE Code in your shell",
    img: publicAssetUrl("welcome/tui.webp"),
    url: docs.terminals,
    device: "terminal",
  },
];

export function WelcomeVideoGate({ onVisibilityChange }: WelcomeVideoGateProps) {
  const [visible, setVisible] = useState(false);
  const [checking, setChecking] = useState(true);
  const [playing, setPlaying] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      setPlaying(false);
      setCopyState("idle");
      setVisible(true);
    };
    window.addEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
    return () => {
      cancelled = true;
      window.removeEventListener(ADE_WELCOME_VIDEO_REPLAY_EVENT, replay);
      if (copyTimer.current) clearTimeout(copyTimer.current);
    };
  }, []);

  const dismissWelcome = useCallback(() => {
    setVisible(false);
    setPlaying(false);
    setCopyState("idle");
    void window.ade.app.markWelcomeVideoSeen("dismissed").catch(() => {});
  }, []);

  const openGitHub = useCallback(() => openExternalUrl(ADE_GITHUB_URL), []);
  const openDocs = useCallback(() => openExternalUrl(docs.home), []);
  const openMobileApp = useCallback(
    () => openExternalUrl(ADE_MOBILE_TESTFLIGHT_URL),
    [],
  );

  const copyMobileLink = useCallback(() => {
    const finish = (state: CopyState) => {
      setCopyState(state);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyState("idle"), 1800);
    };

    const copyWithNavigator = () => {
      try {
        const write = navigator.clipboard?.writeText;
        if (!write) {
          finish("failed");
          return;
        }
        void write
          .call(navigator.clipboard, ADE_MOBILE_TESTFLIGHT_URL)
          .then(() => finish("copied"), () => finish("failed"));
      } catch {
        finish("failed");
      }
    };

    const appBridge = window.ade?.app;
    const writeClipboardText = appBridge?.writeClipboardText;
    if (typeof writeClipboardText === "function") {
      void writeClipboardText
        .call(appBridge, ADE_MOBILE_TESTFLIGHT_URL)
        .then(() => finish("copied"), copyWithNavigator);
      return;
    }

    copyWithNavigator();
  }, []);

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) {
        setVisible(true);
        return;
      }
      if (visible) dismissWelcome();
    },
    [dismissWelcome, visible],
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
          aria-describedby={undefined}
          className="ade-welcome-card"
          style={{
            position: "fixed",
            left: "50%",
            top: "50%",
            zIndex: 10021,
            width: "min(1080px, calc(100vw - 32px))",
            maxHeight: "min(94dvh, 920px)",
            overflow: "auto",
            transform: "translate(-50%, -50%)",
            borderRadius: 16,
            border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 22%, var(--color-border, rgba(255,255,255,0.14)))",
            background:
              "linear-gradient(180deg, color-mix(in srgb, var(--color-card, #171326) 95%, var(--color-accent, #A78BFA) 5%), var(--color-card, #12101D))",
            boxShadow:
              "0 24px 80px -24px rgba(0,0,0,0.78), 0 0 0 1px rgba(255,255,255,0.04)",
            color: "var(--color-fg, #F5F3FF)",
            outline: "none",
          }}
        >
          {/* Ambient brand glow behind the header (static) */}
          <div className="ade-welcome-card__glow" aria-hidden="true" />

          <div style={{ position: "relative", zIndex: 1 }}>
            {/* Header: ADE logo, with GitHub/Docs/close */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                flexWrap: "wrap",
                gap: 16,
                padding: "18px 24px 16px",
                borderBottom:
                  "1px solid color-mix(in srgb, var(--color-fg, #fff) 8%, transparent)",
              }}
            >
              <Dialog.Title style={{ margin: 0, display: "flex", alignItems: "center", minWidth: 0 }}>
                <img
                  src={publicAssetUrl("logo.png")}
                  alt=""
                  aria-hidden="true"
                  draggable={false}
                  style={{
                    height: 40,
                    width: "auto",
                    maxWidth: "min(140px, 45vw)",
                    objectFit: "contain",
                    display: "block",
                  }}
                />
                <span
                  style={{
                    position: "absolute",
                    width: 1,
                    height: 1,
                    padding: 0,
                    margin: -1,
                    overflow: "hidden",
                    clip: "rect(0, 0, 0, 0)",
                    whiteSpace: "nowrap",
                    border: 0,
                  }}
                >
                  Welcome to ADE
                </span>
              </Dialog.Title>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  flexWrap: "wrap",
                  justifyContent: "flex-end",
                  gap: 8,
                  flex: "0 0 auto",
                }}
              >
                <WelcomeActionButton
                  onClick={openGitHub}
                  icon={<GithubLogo size={14} weight="fill" />}
                >
                  GitHub
                </WelcomeActionButton>
                <WelcomeActionButton
                  onClick={openDocs}
                  icon={<ArrowSquareOut size={13} />}
                >
                  Docs
                </WelcomeActionButton>
                <button
                  type="button"
                  aria-label="Close welcome"
                  onClick={dismissWelcome}
                  className="ade-shell-control"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 30,
                    height: 30,
                    borderRadius: 8,
                    border: "1px solid rgba(255,255,255,0.08)",
                    background: "rgba(255,255,255,0.04)",
                    color: "var(--color-muted-fg, #A8A4B8)",
                    cursor: "pointer",
                  }}
                >
                  <X size={14} weight="bold" />
                </button>
              </div>
            </div>

            <div style={{ padding: "18px 24px 24px" }}>
              {/* Body: video (left) + iOS QR panel (right) */}
              <div className="ade-welcome-card__body">
                <VideoPanel
                  playing={playing}
                  onPlay={() => setPlaying(true)}
                />
                <PhonePanel
                  copyState={copyState}
                  onDownload={openMobileApp}
                  onCopy={copyMobileLink}
                />
              </div>

              {/* Surfaces strip: one app, every surface */}
              <div style={{ marginTop: 22 }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    marginBottom: 6,
                    fontSize: 11.5,
                    fontWeight: 650,
                    letterSpacing: 0,
                    textTransform: "uppercase",
                    color: "var(--color-muted-fg, #A8A4B8)",
                  }}
                >
                  One app, every surface
                </div>
                <div className="ade-welcome-card__surfaces">
                  {SURFACES.map((surface, index) => (
                    <SurfaceTile key={surface.key} surface={surface} index={index} />
                  ))}
                </div>
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function VideoPanel({
  playing,
  onPlay,
}: {
  playing: boolean;
  onPlay: () => void;
}) {
  return (
    <div
      style={{
        position: "relative",
        overflow: "hidden",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--color-fg, #fff) 12%, transparent)",
        background: "#050507",
        aspectRatio: "16 / 9",
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04)",
      }}
    >
      {playing ? (
        <iframe
          title="Welcome to ADE video"
          src={`${ADE_WELCOME_VIDEO_EMBED_URL}&autoplay=1`}
          sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"
          allow="autoplay; encrypted-media; picture-in-picture"
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
      ) : (
        <button
          type="button"
          onClick={onPlay}
          aria-label="Play the ADE intro video"
          className="ade-welcome-card__poster"
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            border: 0,
            padding: 0,
            cursor: "pointer",
            backgroundImage: [
              // Soft radial vignette centered behind the play button so it pops
              // cleanly off a busy poster instead of reading as clutter.
              "radial-gradient(circle at 50% 47%, rgba(6,5,16,0.66) 0%, rgba(6,5,16,0.34) 22%, rgba(6,5,16,0) 52%)",
              // Top/bottom darkening keeps the caption legible and frames the video.
              "linear-gradient(180deg, rgba(8,6,18,0.30) 0%, rgba(8,6,18,0) 34%, rgba(8,6,18,0.12) 64%, rgba(8,6,18,0.68) 100%)",
              `url("${publicAssetUrl("welcome/video-poster.jpg")}")`,
            ].join(", "),
            backgroundSize: "cover",
            backgroundPosition: "center",
          }}
        >
          <span
            className="ade-welcome-card__play"
            style={{
              position: "absolute",
              left: "50%",
              top: "50%",
              transform: "translate(-50%, -50%)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 68,
              height: 68,
              borderRadius: "999px",
              background: "var(--color-accent, #A78BFA)",
              color: "var(--color-accent-fg, #0B0A14)",
              boxShadow:
                "0 14px 34px -10px rgba(124,58,237,0.78), 0 0 0 6px rgba(255,255,255,0.10)",
            }}
          >
            <Play size={28} weight="fill" />
          </span>
          <span
            style={{
              position: "absolute",
              left: 14,
              bottom: 12,
              fontSize: 12.5,
              fontWeight: 600,
              color: "#fff",
              textShadow: "0 1px 6px rgba(0,0,0,0.6)",
            }}
          >
            Watch the intro guide
          </span>
        </button>
      )}
    </div>
  );
}

function PhonePanel({
  copyState,
  onDownload,
  onCopy,
}: {
  copyState: CopyState;
  onDownload: () => void;
  onCopy: () => void;
}) {
  const copied = copyState === "copied";
  const copyFailed = copyState === "failed";
  let copyLabel = "Copy install link";
  let copyColor = "var(--color-fg, #F5F3FF)";
  if (copied) {
    copyLabel = "Link copied";
    copyColor = "var(--color-accent-bright, #C4B5FD)";
  } else if (copyFailed) {
    copyLabel = "Copy failed";
    copyColor = "#FCA5A5";
  }

  return (
    <aside
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: "18px 18px",
        borderRadius: 12,
        border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 24%, transparent)",
        background:
          "linear-gradient(180deg, color-mix(in srgb, var(--color-accent, #A78BFA) 8%, transparent), color-mix(in srgb, var(--color-accent, #A78BFA) 2%, transparent))",
      }}
    >
      <div style={{ fontSize: 15, fontWeight: 650, textAlign: "center" }}>
        Get it on your phone
      </div>

      <div
        className="ade-welcome-card__qr"
        style={{
          display: "inline-flex",
          padding: 14,
          borderRadius: 14,
          background: "#FFFFFF",
          border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
        }}
      >
        <QRCodeSVG
          value={ADE_MOBILE_TESTFLIGHT_URL}
          size={176}
          level="H"
          marginSize={1}
          bgColor="#FFFFFF"
          fgColor="#111827"
          title="QR code to install ADE Mobile via TestFlight"
          imageSettings={{
            src: publicAssetUrl("welcome/ade-icon.webp"),
            height: 38,
            width: 38,
            excavate: true,
          }}
        />
      </div>

      <div style={{ display: "flex", gap: 8, width: "100%" }}>
        <button
          type="button"
          onClick={onDownload}
          style={{
            flex: 1,
            minHeight: 36,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 7,
            border:
              "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 44%, transparent)",
            borderRadius: 9,
            background: "var(--color-accent, #A78BFA)",
            color: "var(--color-accent-fg, #0B0A14)",
            fontSize: 12.5,
            fontWeight: 700,
            cursor: "pointer",
          }}
        >
          Download for iOS
        </button>
        <button
          type="button"
          onClick={onCopy}
          aria-label={copyLabel}
          title={copyLabel}
          style={{
            width: 40,
            minHeight: 36,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border:
              "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 40%, transparent)",
            borderRadius: 9,
            background: "color-mix(in srgb, var(--color-accent, #A78BFA) 12%, transparent)",
            color: copyColor,
            cursor: "pointer",
          }}
        >
          {copied ? <Check size={15} weight="bold" /> : <Copy size={15} />}
        </button>
      </div>
    </aside>
  );
}

function SurfaceTile({
  index,
  surface,
}: {
  index: number;
  surface: Surface;
}) {
  return (
    <button
      type="button"
      onClick={() => openExternalUrl(surface.url)}
      className="ade-welcome-card__tile"
      aria-label={`${surface.label}: ${surface.blurb}`}
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: 0,
        border: "none",
        background: "transparent",
        color: "var(--color-fg, #F5F3FF)",
        cursor: "pointer",
        animationDelay: `${(index + 1) * 60}ms`,
      }}
    >
      <div
        style={{
          width: "100%",
          height: 250,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {surface.device === "macbook" && <MacBookFrame src={surface.img} />}
        {surface.device === "phone" && <PhoneFrame src={surface.img} />}
        {surface.device === "terminal" && <TerminalFrame src={surface.img} />}
      </div>
      <div style={{ textAlign: "center", paddingTop: 12 }}>
        <div style={{ fontSize: 13, fontWeight: 650 }}>{surface.label}</div>
        <div
          style={{
            marginTop: 2,
            fontSize: 11,
            color: "var(--color-muted-fg, #A8A4B8)",
          }}
        >
          {surface.blurb}
        </div>
      </div>
    </button>
  );
}

function MacBookFrame({ src }: { src: string }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 300,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <div
        style={{
          width: "90%",
          background: "#0a0a10",
          border: "3px solid #3a3a45",
          borderRadius: "10px 10px 4px 4px",
          padding: 3,
          boxShadow: "0 8px 18px -10px rgba(0,0,0,0.7)",
        }}
      >
        <div
          style={{
            aspectRatio: "16 / 10",
            borderRadius: 4,
            overflow: "hidden",
            background: "#000",
          }}
        >
          <img
            src={src}
            alt=""
            draggable={false}
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              objectPosition: "top center",
              display: "block",
            }}
          />
        </div>
      </div>
      {/* Base and hinge, wider than the screen for the laptop silhouette. */}
      <div
        style={{
          width: "112%",
          height: 9,
          background: "linear-gradient(180deg, #51515d, #26262e)",
          borderRadius: "1px 1px 8px 8px",
          position: "relative",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.2)",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 0,
            left: "50%",
            transform: "translateX(-50%)",
            width: "22%",
            height: 4,
            background: "#15151b",
            borderRadius: "0 0 5px 5px",
          }}
        />
      </div>
    </div>
  );
}

function PhoneFrame({ src }: { src: string }) {
  return (
    <div
      style={{
        width: 110,
        margin: "0 auto",
        background: "#0a0a10",
        border: "3px solid #3a3a45",
        borderRadius: 22,
        padding: 3,
        position: "relative",
        boxShadow: "0 10px 24px -10px rgba(0,0,0,0.75)",
      }}
    >
      {/* dynamic island */}
      <div
        style={{
          position: "absolute",
          top: 10,
          left: "50%",
          transform: "translateX(-50%)",
          width: 34,
          height: 8,
          background: "#000",
          borderRadius: 6,
          zIndex: 2,
        }}
      />
      <div style={{ borderRadius: 18, overflow: "hidden", background: "#000" }}>
        <img
          src={src}
          alt=""
          draggable={false}
          style={{ width: "100%", display: "block" }}
        />
      </div>
    </div>
  );
}

function TerminalFrame({ src }: { src: string }) {
  return (
    <div
      style={{
        width: "100%",
        maxWidth: 300,
        borderRadius: 9,
        overflow: "hidden",
        border: "1px solid #2c2c36",
        background: "#0a0a0f",
        boxShadow: "0 8px 18px -10px rgba(0,0,0,0.7)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 5,
          padding: "7px 9px",
          background: "#17171f",
          borderBottom: "1px solid #2a2a33",
        }}
      >
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#ff5f57" }} />
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#febc2e" }} />
        <span style={{ width: 9, height: 9, borderRadius: "50%", background: "#28c840" }} />
        <span
          style={{
            marginLeft: 6,
            fontSize: 9.5,
            letterSpacing: 0,
            color: "var(--color-muted-fg, #A8A4B8)",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          }}
        >
          ade - zsh
        </span>
      </div>
      <div style={{ aspectRatio: "16 / 9", overflow: "hidden", background: "#000" }}>
        <img
          src={src}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "top center",
            display: "block",
          }}
        />
      </div>
    </div>
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
        borderRadius: 8,
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
