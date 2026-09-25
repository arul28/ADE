import { useEffect, useState } from "react";
import { UserCircle } from "@phosphor-icons/react";
import { accountAvatarImage, accountInitials, providerTint } from "../../lib/account";
import type { AdeAccountStatus } from "../../../shared/types";

/**
 * The account avatar: the account image, else a monogram, else a person glyph
 * when signed out. The ring takes the sign-in provider's tint. A broken image
 * falls back to the monogram, and a new image URL gets a fresh try.
 */
export function AccountAvatar({
  status,
  githubLogin,
  githubConnected,
  size,
}: {
  status: AdeAccountStatus;
  githubLogin: string | null;
  githubConnected: boolean;
  size: number;
}) {
  const image = accountAvatarImage(status, githubLogin);
  const tint = providerTint(status, githubConnected);
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [image]);
  const ring = `0 0 0 1.5px color-mix(in srgb, ${tint} 55%, transparent)`;

  if (image && !broken) {
    return (
      <img
        src={image}
        alt=""
        onError={() => setBroken(true)}
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: ring }}
        draggable={false}
      />
    );
  }
  if (status.signedIn) {
    return (
      <span
        className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold uppercase tracking-tight text-fg/90"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.4),
          background: `color-mix(in srgb, ${tint} 22%, transparent)`,
          boxShadow: ring,
        }}
        aria-hidden
      >
        {accountInitials(status)}
      </span>
    );
  }
  return <UserCircle size={size + 2} weight="regular" className="shrink-0" />;
}
