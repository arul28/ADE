export function openExternalUrl(url: string | undefined | null): void {
  if (!url) return;
  const bridge =
    typeof window !== "undefined" ? window.ade?.app?.openExternal : undefined;
  if (bridge) {
    void bridge(url).catch(() => {});
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}
