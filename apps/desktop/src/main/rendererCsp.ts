type RendererCspResponseDetails = {
  url: string;
  resourceType?: string;
};

type RendererCspMatchOptions = {
  isDevMode: boolean;
  devServerUrl?: string | null;
};

export function shouldApplyRendererCsp(
  details: RendererCspResponseDetails,
  options: RendererCspMatchOptions,
): boolean {
  if (details.resourceType !== "mainFrame") return false;

  let url: URL;
  try {
    url = new URL(details.url);
  } catch {
    return false;
  }

  if (!options.isDevMode) {
    return url.protocol === "file:" || url.protocol === "app:";
  }

  if (options.devServerUrl) {
    try {
      const devUrl = new URL(options.devServerUrl);
      return url.origin === devUrl.origin;
    } catch {
      // Fall through to the local renderer host check below.
    }
  }

  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "::1")
  );
}

export function buildRendererCspPolicy(isDevMode: boolean): string {
  const cspSources = isDevMode
    ? "'self' http://localhost:* http://127.0.0.1:*"
    : "'self' file: app:";
  const cspWsSources = isDevMode ? " ws://localhost:* ws://127.0.0.1:*" : "";
  const cspLocalSources = " http://localhost:* http://127.0.0.1:*";
  const cspConnectLocalSources = isDevMode ? "" : cspLocalSources;
  // GitHub serves comment-body images from a spread of hosts: avatars and the
  // `*.githubusercontent.com` family (user-images, private-user-images, media,
  // camo, objects), plus `github.com/user-attachments/...` (served under
  // github.com, which then 302s to private-user-images.githubusercontent.com).
  // The `*.githubusercontent.com` wildcard already covers the subdomain family;
  // we list the common ones explicitly for clarity/self-documentation. We keep
  // the allowlist host-scoped (no blanket `https:`) to preserve the existing
  // posture of not allowing arbitrary public image beacons.
  const cspImageSources = `${cspSources}${cspLocalSources} https://avatars.githubusercontent.com https://*.githubusercontent.com https://user-images.githubusercontent.com https://private-user-images.githubusercontent.com https://media.githubusercontent.com https://camo.githubusercontent.com https://objects.githubusercontent.com https://github.githubassets.com https://opengraph.githubassets.com https://github.com https://vercel.com https://*.vercel.com https://img.shields.io https://*.s3.amazonaws.com https://www.gravatar.com https://secure.gravatar.com https://ade-app.dev`;
  const cspFrameSources = `${cspSources}${cspLocalSources} about: https://www.youtube-nocookie.com https://www.youtube.com`;
  const cspScriptSources = isDevMode ? `${cspSources} 'unsafe-inline'` : cspSources;
  return [
    `default-src ${cspSources}`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
    `frame-src ${cspFrameSources}`,
    `script-src ${cspScriptSources}`,
    `style-src ${cspSources} 'unsafe-inline'`,
    `img-src ${cspImageSources} ade-artifact: data: blob:`,
    `media-src ${cspSources}${cspLocalSources} ade-artifact: blob: data:`,
    `font-src ${cspSources} data:`,
    `connect-src ${cspSources}${cspConnectLocalSources}${cspWsSources}`,
    `worker-src 'self' blob:`,
  ].join("; ");
}
