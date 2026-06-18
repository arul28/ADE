import { memo, useEffect, useState } from "react";
import { UserCircle } from "@phosphor-icons/react";

import type { PrUser } from "../../../../shared/types/prs";
import { COLORS } from "../../lanes/laneDesignTokens";

export const PrUserAvatar = memo(function PrUserAvatar({
  user,
  size = 20,
}: {
  user: Pick<PrUser, "login" | "avatarUrl">;
  size?: number;
}) {
  // When an avatar URL is blocked (CSP) or 404s, a bare <img> would render its
  // alt text inside the box — a broken, oversized blob. Track load failure and
  // fall back to a clean icon instead. Reset whenever the URL changes.
  const [errored, setErrored] = useState(false);
  useEffect(() => setErrored(false), [user.avatarUrl]);

  if (user.avatarUrl && !errored) {
    return (
      <img
        src={user.avatarUrl}
        alt=""
        onError={() => setErrored(true)}
        className="shrink-0 rounded-full"
        style={{
          width: size,
          height: size,
          objectFit: "cover",
          flex: `0 0 ${size}px`,
          border: `1px solid color-mix(in srgb, var(--color-fg) 12%, transparent)`,
          boxShadow: `0 0 0 1px ${COLORS.prSurface}`,
        }}
      />
    );
  }
  return (
    <UserCircle
      size={size}
      weight="fill"
      style={{ color: COLORS.accent, opacity: 0.7, flex: `0 0 ${size}px` }}
    />
  );
});
