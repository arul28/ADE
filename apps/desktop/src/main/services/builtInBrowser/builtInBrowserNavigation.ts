export function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) throw new Error("Browser URL is required.");
  // "C:\x", "C:/x" and "\\server\share" have no scheme, so they would parse as
  // https://c/x and https://server/share: a silent navigation to a made-up host.
  if (/^[a-zA-Z]:[\\/]/.test(trimmed) || /^\\\\/.test(trimmed) || /^file:\\/i.test(trimmed)) {
    throw new Error("Local file paths are not supported in the ADE browser. Use an http:// or https:// URL.");
  }

  const localhostLike = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])(?::|\/|$)/i.test(trimmed);
  const hasScheme = /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(trimmed) || /^about:/i.test(trimmed);
  let candidate: string;
  if (localhostLike) {
    candidate = `http://${trimmed}`;
  } else if (hasScheme) {
    candidate = trimmed;
  } else {
    candidate = `https://${trimmed}`;
  }

  const parsed = new URL(candidate);
  if (parsed.protocol === "about:") {
    if (parsed.href === "about:blank") return parsed.href;
    throw new Error("Only about:blank browser navigation is supported.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported browser URL protocol: ${parsed.protocol}`);
  }
  return parsed.href;
}

export function isAllowedNavigationUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "about:") return parsed.href.startsWith("about:blank");
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
