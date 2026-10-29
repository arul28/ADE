import type { CSSProperties, ReactNode } from "react";
import { ArrowRight, ArrowSquareOut, CheckCircle, CloudArrowUp, Desktop } from "@phosphor-icons/react";
import type { AdeAccountStatus, MachineConnectionRoutes } from "../../../shared/types";
import { accountInitials } from "../../lib/account";
import { openExternalUrl } from "../../lib/openExternal";
import { openConnectionsPanel } from "../../lib/connectionsPanel";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { TailscaleMark } from "./MachineRoutes";
import { PRIVATE_NETWORK_SETTINGS_ANCHOR, setupSteps } from "./PrivateNetworkSection";
import { rgbCss, useProfilePalette } from "./useProfilePalette";

/** What the banner says about the account's computers. Null until the list loads. */
export type AccountNetworkSummary = {
  total: number;
  online: number;
  relayOn: number;
  /** This computer's own reading of its routes. */
  localRoutes: MachineConnectionRoutes | null;
};

type NextStep = {
  title: string;
  detail: string;
  action?: { label: string; run: () => void; external?: boolean };
};

function scrollToSection(anchor: string): void {
  document.getElementById(anchor)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/**
 * The one thing worth doing next, so a new owner isn't left to work out the
 * page. In order: get a second computer on the account, then Tailscale.
 */
function nextStep(summary: AccountNetworkSummary | null): NextStep | null {
  if (!summary) return null;
  if (summary.total <= 1) {
    return {
      title: "Add your other computers",
      detail: "Install ADE on them and sign in with this account. They show up here and can reach each other.",
      action: { label: "Connections", run: () => openConnectionsPanel("machines") },
    };
  }
  const routes = summary.localRoutes;
  if (!routes) return null;
  if (routes.tailscale.state !== "running") {
    return {
      title: "Connect them privately with Tailscale",
      detail: "Free for personal use. Your computers then talk directly instead of through ADE's servers.",
      action: { label: "Set up", run: () => scrollToSection(PRIVATE_NETWORK_SETTINGS_ANCHOR) },
    };
  }
  const todo = setupSteps(routes).find((step) => step.state === "todo" && step.action);
  if (todo?.action) {
    const href = todo.action.href;
    return {
      title: `Turn on ${todo.title} in Tailscale`,
      detail: "One switch on Tailscale's website lets the ADE web app reach your computers over Tailscale too.",
      action: { label: todo.action.label, run: () => openExternalUrl(href), external: true },
    };
  }
  return {
    title: "Everything is set up",
    detail: "Your computers reach each other directly. ADE Relay only steps in when nothing else answers.",
  };
}

function Figure({ icon, value, label }: { icon: ReactNode; value: string; label: string }) {
  return (
    <div className="ade-ah-figure">
      <span className="ade-ah-figure-icon">{icon}</span>
      <b className="kit-num">{value}</b>
      <span>{label}</span>
    </div>
  );
}

/** The avatar as a floating coin: face, a stacked edge in the picture's own dark tone, a gloss and a floor shadow. */
function FloatingAvatar({
  status,
  image,
  broken,
  onError,
  edge,
}: {
  status: AdeAccountStatus;
  image: string | null;
  broken: boolean;
  onError: () => void;
  edge: string;
}) {
  const depth = Array.from({ length: 12 }, (_, index) => 12 - index);
  return (
    <div className="ade-ah-avatar" aria-hidden style={{ "--ah-edge": edge } as CSSProperties}>
      <div className="ade-ah-avatar-halo" />
      <div className="ade-ah-avatar-floor" />
      <div className="ade-ah-avatar-body">
        {depth.map((step) => (
          <span
            key={step}
            className="ade-ah-avatar-edge"
            // The far layers are darker, so the side reads as lit from the front.
            style={{ transform: `translate3d(${step * 0.85}px, ${step * 1.25}px, 0)`, filter: `brightness(${1.15 - step * 0.06})` }}
          />
        ))}
        <span className="ade-ah-avatar-face">
          {image && !broken ? (
            <img src={image} alt="" width={104} height={104} draggable={false} onError={onError} />
          ) : (
            <span className="ade-ah-avatar-monogram">{accountInitials(status)}</span>
          )}
        </span>
        <span className="ade-ah-avatar-gloss" />
      </div>
    </div>
  );
}

/**
 * The top of the Account page: who is signed in, on a mesh painted from their
 * own profile picture, and how their computers are doing at a glance, with
 * the next thing worth doing.
 */
export function AccountHero({
  status,
  avatarImage,
  avatarBroken,
  onAvatarError,
  tint,
  providerCaption,
  summary,
}: {
  status: AdeAccountStatus;
  avatarImage: string | null;
  avatarBroken: boolean;
  onAvatarError: () => void;
  tint: string;
  providerCaption: string | null;
  summary: AccountNetworkSummary | null;
}) {
  const palette = useProfilePalette(avatarBroken ? null : avatarImage, tint);
  const [base, deep, mid, bright, light] = palette.ramp;
  const step = nextStep(summary);
  const routes = summary?.localRoutes ?? null;
  const steps = routes ? setupSteps(routes) : [];
  const done = steps.filter((entry) => entry.state === "done").length;
  const tailscaleValue = !routes
    ? "…"
    : routes.tailscale.state !== "running"
      ? "Off"
      : done === steps.length ? "Ready" : `${done}/${steps.length}`;

  return (
    <section
      className="ade-ah"
      style={{
        "--ah-base": rgbCss(base!),
        "--ah-deep": rgbCss(deep!),
        "--ah-mid": rgbCss(mid!),
        "--ah-bright": rgbCss(bright!),
        "--ah-light": rgbCss(light!),
      } as CSSProperties}
    >
      {/* CSS paints first; the mesh covers it once WebGL has drawn. */}
      <div className="ade-ah-wash" />
      {/* Always the dark mesh: the banner is a coloured surface with white text in either theme. */}
      <WorkToolPickerBackdrop theme="dark" colors={palette} />
      <div className="ade-ah-shade" />
      <div className="ade-ah-row">
        <FloatingAvatar status={status} image={avatarImage} broken={avatarBroken} onError={onAvatarError} edge={rgbCss(deep!)} />
        <div className="ade-ah-id">
          <div className="ade-ah-eyebrow">Your ADE account</div>
          <div className="ade-ah-name">{status.name || status.email || "Your account"}</div>
          {status.name && status.email ? <div className="ade-ah-email">{status.email}</div> : null}
          <div className="ade-ah-chips">
            <span className="ade-ah-chip"><i data-tone="ok" />Active on this computer</span>
            {providerCaption ? <span className="ade-ah-chip">{providerCaption}</span> : null}
          </div>
        </div>
        <div className="ade-ah-panel">
          <div className="ade-ah-figures">
            <Figure
              icon={<Desktop size={14} weight="bold" />}
              value={summary ? `${summary.online}/${summary.total}` : "…"}
              label="computers online"
            />
            <Figure
              icon={<TailscaleMark size={14} />}
              value={tailscaleValue}
              label={tailscaleValue.includes("/") ? "Tailscale set up" : "Tailscale"}
            />
            <Figure
              icon={<CloudArrowUp size={14} weight="bold" />}
              value={summary ? `${summary.relayOn}/${summary.total}` : "…"}
              label="use ADE Relay"
            />
          </div>
          {step ? (
            <div className="ade-ah-next">
              <div className="ade-ah-next-copy">
                <div className="ade-ah-next-title">
                  {step.action ? null : <CheckCircle size={14} weight="fill" />}
                  {step.title}
                </div>
                <div className="ade-ah-next-detail">{step.detail}</div>
              </div>
              {step.action ? (
                <button type="button" className="ade-ah-next-btn" onClick={step.action.run}>
                  {step.action.label}
                  {step.action.external ? <ArrowSquareOut size={12} weight="bold" /> : <ArrowRight size={12} weight="bold" />}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
