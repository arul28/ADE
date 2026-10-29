import type { CSSProperties } from "react";
import type { AdeAccountStatus } from "../../../shared/types";
import { accountInitials } from "../../lib/account";
import { WorkToolPickerBackdrop } from "../terminals/WorkToolPickerBackdrop";
import { RouteIcon } from "./MachineRoutes";
import type { MachineRouteItem } from "./machineRouteModel";
import { rgbCss, useProfilePalette } from "./useProfilePalette";

/** What the banner says about the computer this window runs on. */
export type AccountThisComputer = {
  name: string;
  /** "ADE 1.4.2", or both versions when the app and the brain differ. */
  version: string | null;
  /** False when the account directory has no row for this computer. */
  listed: boolean;
  routes: MachineRouteItem[];
};

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

/** The headline for this computer's connections: how many ways in work right now. */
function reachHeadline(routes: MachineRouteItem[]): string {
  const on = routes.filter((route) => route.tone === "on").length;
  if (routes.length === 0) return "Checking connections…";
  if (on === 0) return "Not reachable from your other devices";
  return `Reachable ${on} of ${routes.length} ways`;
}

function ThisComputerCard({ computer }: { computer: AccountThisComputer | null }) {
  if (!computer) {
    return (
      <div className="ade-ah-panel" aria-busy>
        <div className="ade-ah-panel-eyebrow">This computer</div>
        <div className="ade-ah-panel-empty">Checking this computer…</div>
      </div>
    );
  }
  return (
    <div className="ade-ah-panel">
      <div className="ade-ah-panel-head">
        <div className="ade-ah-panel-id">
          <div className="ade-ah-panel-eyebrow">This computer</div>
          <div className="ade-ah-panel-name" title={computer.name}>{computer.name}</div>
        </div>
        <span className="ade-ah-status" data-tone={computer.listed ? "on" : "warn"}>
          <i />
          {computer.listed ? "Online" : "Not on your account"}
        </span>
      </div>
      <div className="ade-ah-panel-meta">
        {[computer.version, reachHeadline(computer.routes)].filter(Boolean).join(" · ")}
      </div>
      <ul className="ade-ah-routes" aria-label="How other devices reach this computer">
        {computer.routes.map((route) => (
          <li key={route.kind} className="ade-ah-route" data-tone={route.tone} title={route.detail ?? undefined}>
            <span className="ade-ah-route-icon"><RouteIcon kind={route.kind} size={13} /></span>
            <span className="ade-ah-route-name">{route.label}</span>
            {route.detail ? <span className="ade-ah-route-detail">{route.detail}</span> : <span className="ade-ah-route-gap" />}
            <span className="ade-ah-route-word"><i />{route.word}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The top of the Account page: who is signed in, on a mesh painted from their
 * own profile picture, and the computer this window runs on with each way
 * other devices reach it.
 */
export function AccountHero({
  status,
  avatarImage,
  avatarBroken,
  onAvatarError,
  tint,
  providerCaption,
  thisComputer,
}: {
  status: AdeAccountStatus;
  avatarImage: string | null;
  avatarBroken: boolean;
  onAvatarError: () => void;
  tint: string;
  providerCaption: string | null;
  thisComputer: AccountThisComputer | null;
}) {
  const palette = useProfilePalette(avatarBroken ? null : avatarImage, tint);
  const [base, deep, mid, bright, light] = palette.ramp;

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
          <div className="ade-ah-name">{status.name || status.email || "Your account"}</div>
          {status.name && status.email ? <div className="ade-ah-email">{status.email}</div> : null}
          {providerCaption ? <div className="ade-ah-caption">{providerCaption}</div> : null}
        </div>
        <ThisComputerCard computer={thisComputer} />
      </div>
    </section>
  );
}
