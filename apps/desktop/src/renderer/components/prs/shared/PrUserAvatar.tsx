import { memo } from "react";
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
  if (user.avatarUrl) {
    return (
      <img
        src={user.avatarUrl}
        alt={user.login}
        width={size}
        height={size}
        className="shrink-0 rounded-full"
        style={{
          border: `1.5px solid ${COLORS.accentBorder}`,
          boxShadow: `0 0 0 1px ${COLORS.pageBg}`,
        }}
      />
    );
  }
  return <UserCircle size={size} weight="fill" style={{ color: COLORS.accent, opacity: 0.7 }} />;
});
