import React from "react";
import { ArrowSquareOut } from "@phosphor-icons/react";

export function openLinearIssueExternalUrl(url: string | null | undefined): void {
  if (!url) return;
  void window.ade.app.openExternal(url);
}

export function LinearIssueOpenLink({
  url,
}: {
  url: string | null | undefined;
}) {
  if (!url) return null;
  return (
    <button
      type="button"
      className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-white/[0.07] px-2.5 py-1.5 text-[11px] font-medium text-muted-fg/70 transition-colors hover:border-white/[0.12] hover:bg-white/[0.03] hover:text-fg/85"
      onClick={() => openLinearIssueExternalUrl(url)}
    >
      <ArrowSquareOut size={13} />
      Open in Linear
    </button>
  );
}
