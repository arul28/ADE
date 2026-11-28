import { useState, type CSSProperties } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import type { AdeAccountStatus } from "../../../shared/types";
import { accountInitials } from "../../lib/account";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { rgbCss, useProfilePalette } from "./useProfilePalette";

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
  const depth = Array.from({ length: 9 }, (_, index) => 9 - index);
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
            style={{ transform: `translate3d(${step * 0.7}px, ${step * 1.05}px, 0)`, filter: `brightness(${1.15 - step * 0.07})` }}
          />
        ))}
        <span className="ade-ah-avatar-face">
          {image && !broken ? (
            <img src={image} alt="" width={72} height={72} draggable={false} onError={onError} />
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
 * own profile picture. This computer's facts live on its row in Your
 * computers (tagged "This computer").
 */
export function AccountHero({
  status,
  avatarImage,
  avatarBroken,
  onAvatarError,
  tint,
  providerCaption,
}: {
  status: AdeAccountStatus;
  avatarImage: string | null;
  avatarBroken: boolean;
  onAvatarError: () => void;
  tint: string;
  providerCaption: string | null;
}) {
  const palette = useProfilePalette(avatarBroken ? null : avatarImage, tint);
  const [base, deep, mid, bright, light] = palette.ramp;

  return (
    <section
      className="ade-ah kit-hero"
      style={{
        "--ah-base": rgbCss(base!),
        "--ah-deep": rgbCss(deep!),
        "--ah-mid": rgbCss(mid!),
        "--ah-bright": rgbCss(bright!),
        "--ah-light": rgbCss(light!),
      } as CSSProperties}
    >
      {/* CSS paints first; the mesh covers it once WebGL has drawn. */}
      <div className="kit-hero-wash" />
      {/* Always the dark mesh: the banner is a coloured surface with white text in either theme. */}
      <WorkToolPickerBackdrop theme="dark" colors={palette} />
      <div className="kit-hero-shade" />
      <div className="kit-hero-row">
        <FloatingAvatar status={status} image={avatarImage} broken={avatarBroken} onError={onAvatarError} edge={rgbCss(deep!)} />
        <div className="ade-ah-id">
          <div className="ade-ah-name">{status.name || status.email || "Your account"}</div>
          {status.name && status.email ? <div className="ade-ah-email">{status.email}</div> : null}
          {providerCaption ? <div className="ade-ah-caption">{providerCaption}</div> : null}
          {status.userId ? (
            <div className="ade-ah-caption ade-ah-account-id">
              <span>Account ID</span>
              <span className="ade-net-mono" title={status.userId}>{status.userId}</span>
              <CopyIdButton value={status.userId} />
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Copies the account ID, the one place it shows (the banner). */
function CopyIdButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  const write = window.ade?.app?.writeClipboardText;
  if (!write) return null;
  return (
    <button
      type="button"
      className="ade-acct-btn ade-acct-icon-btn"
      data-variant="ghost"
      aria-label={copied ? "Copied" : "Copy account ID"}
      title={copied ? "Copied" : "Copy account ID"}
      onClick={() => {
        void write(value).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1_500);
        }).catch(() => {});
      }}
    >
      {copied ? <Check size={13} weight="bold" /> : <Copy size={13} weight="bold" />}
    </button>
  );
}
