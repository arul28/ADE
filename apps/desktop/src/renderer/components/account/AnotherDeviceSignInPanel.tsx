import type { CSSProperties } from "react";
import { CircleNotch } from "@phosphor-icons/react";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import type { AccountDeviceLoginPrompt } from "../../lib/accountLogin";
import { MONO_FONT, SANS_FONT } from "../lanes/laneDesignTokens";
import { AdeQrCodeTile } from "../ui/AdeQrCode";

/**
 * "Sign in with another device", once it has a code to show: the link as a QR
 * code for a phone, and the same link and code as text for another computer.
 * Nothing opens on this computer, so the password is never typed here.
 *
 * Both sign-in cards draw it (the launch gate's glass card and the Account
 * page), so it takes its text color from the card and sets none of its own.
 */
export function AnotherDeviceSignInPanel({
  prompt,
  onCancel,
}: {
  prompt: AccountDeviceLoginPrompt;
  onCancel: () => void;
}) {
  const link = prompt.verificationUriComplete ?? prompt.verificationUri;
  const { copy, copied } = useCopyToClipboard({
    // Through the main process: `navigator.clipboard` is not reliable here.
    write: async (value) => {
      const writeClipboardText = window.ade?.app?.writeClipboardText;
      if (!writeClipboardText) return false;
      await writeClipboardText(value);
      return true;
    },
  });
  const quiet: CSSProperties = { opacity: 0.72 };
  const textButton: CSSProperties = {
    border: 0,
    padding: "4px 6px",
    borderRadius: 6,
    background: "transparent",
    color: "inherit",
    fontFamily: SANS_FONT,
    fontSize: 12,
    textDecoration: "underline",
    cursor: "pointer",
    WebkitAppRegion: "no-drag",
  } as CSSProperties;
  return (
    <div
      data-testid="another-device-sign-in"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 10,
        fontFamily: SANS_FONT,
        fontSize: 12.5,
        lineHeight: 1.5,
        textAlign: "center",
      }}
    >
      <AdeQrCodeTile value={link} title="Sign-in link for another device" size={156} style={{ lineHeight: 0 }} />
      <div style={{ fontSize: 14, fontWeight: 650 }}>Scan with your phone</div>
      <div style={quiet}>
        Sign in there and this computer signs in too. Your password is never typed on this computer.
      </div>
      <div style={quiet}>
        Or open <span style={{ fontFamily: MONO_FONT }}>{prompt.verificationUri.replace(/^https?:\/\//, "")}</span>{" "}
        on another device and enter this code:
      </div>
      <div
        data-testid="another-device-sign-in-code"
        style={{ fontFamily: MONO_FONT, fontSize: 20, fontWeight: 600, letterSpacing: "0.16em", userSelect: "text" }}
      >
        {prompt.userCode}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6, ...quiet }}>
          <CircleNotch size={13} weight="bold" className="animate-spin" />
          Waiting for you to sign in…
        </span>
        <button type="button" style={textButton} onClick={() => void copy(link)}>
          {copied ? "Link copied" : "Copy link"}
        </button>
        <button type="button" style={textButton} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
