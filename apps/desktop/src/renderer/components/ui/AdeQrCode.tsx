import type { CSSProperties } from "react";
import { QRCodeSVG } from "qrcode.react";
import { publicAssetUrl } from "../../lib/publicAssetUrl";

/**
 * ADE's QR code: dark on white, with the ADE mark cut into the middle (hence
 * error-correction level H). Draw it on a white surface; `AdeQrCodeTile` is
 * that surface for a code that sits in a card.
 *
 * First-run setup draws it inline, on its own white inset.
 */
export function AdeQrCode({ value, title, size }: { value: string; title: string; size: number }) {
  const markSize = Math.round(size * (32 / 148));
  return (
    <QRCodeSVG
      value={value}
      size={size}
      level="H"
      marginSize={1}
      bgColor="#FFFFFF"
      fgColor="#111827"
      title={title}
      imageSettings={{
        src: publicAssetUrl("welcome/ade-icon.webp"),
        height: markSize,
        width: markSize,
        excavate: true,
      }}
    />
  );
}

/** `AdeQrCode` on its white tile with the accent-tinted border. */
export function AdeQrCodeTile({
  value,
  title,
  size,
  className,
  style,
}: {
  value: string;
  title: string;
  size: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        display: "inline-flex",
        padding: 14,
        borderRadius: 14,
        background: "#FFFFFF",
        border: "1px solid color-mix(in srgb, var(--color-accent, #A78BFA) 30%, transparent)",
        ...style,
      }}
    >
      <AdeQrCode value={value} title={title} size={size} />
    </div>
  );
}
