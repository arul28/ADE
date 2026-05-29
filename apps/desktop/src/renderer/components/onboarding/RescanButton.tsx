import React from "react";
import { ArrowsClockwise } from "@phosphor-icons/react";
import { Button } from "../ui/Button";

export function RescanButton({
  loading = false,
  onClick,
  iconOnly = false,
}: {
  loading?: boolean;
  onClick: () => void;
  iconOnly?: boolean;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={loading}
      onClick={onClick}
      aria-label={iconOnly ? "Rescan" : undefined}
      title={iconOnly ? "Rescan" : undefined}
    >
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <ArrowsClockwise size={12} weight="bold" style={{ opacity: loading ? 0.4 : 1 }} />
        {iconOnly ? null : "Rescan"}
      </span>
    </Button>
  );
}
