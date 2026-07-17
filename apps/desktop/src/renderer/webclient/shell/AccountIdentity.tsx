import React, { useEffect, useState } from "react";
import type { BrowserAccountSnapshot } from "../account/client";
import { COLORS, SANS_FONT } from "./shellTokens";

export function accountIdentityLabel(account: BrowserAccountSnapshot): string {
  return account.email ?? account.name ?? "ADE account";
}

function accountIdentityInitials(account: BrowserAccountSnapshot): string {
  const name = account.name?.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    if (parts.length > 1) return `${parts[0]![0]}${parts.at(-1)![0]}`.toUpperCase();
    return parts[0]!.slice(0, 2).toUpperCase();
  }
  return account.email?.trim()[0]?.toUpperCase() ?? "A";
}

export function AccountIdentity({
  account,
  size = 24,
}: {
  account: BrowserAccountSnapshot;
  size?: number;
}) {
  const [imageFailed, setImageFailed] = useState(false);
  useEffect(() => setImageFailed(false), [account.imageUrl]);
  const showImage = Boolean(account.imageUrl) && !imageFailed;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          width: size,
          height: size,
          flex: `0 0 ${size}px`,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
          borderRadius: "50%",
          border: `1px solid ${COLORS.border}`,
          background: "color-mix(in srgb, var(--color-fg) 8%, transparent)",
          color: COLORS.textSecondary,
          fontFamily: SANS_FONT,
          fontSize: Math.max(9, Math.round(size * 0.42)),
          fontWeight: 600,
        }}
      >
        {showImage ? (
          <img
            src={account.imageUrl!}
            alt=""
            onError={() => setImageFailed(true)}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : accountIdentityInitials(account)}
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: COLORS.textMuted,
          fontFamily: SANS_FONT,
          fontSize: 12,
        }}
      >
        Signed in as {accountIdentityLabel(account)}
      </span>
    </div>
  );
}
