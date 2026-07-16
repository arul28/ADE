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
  // we list the common ones explicitly for clarity/self-documentation. Review
  // comments also embed known bot/badge assets from CodeRabbit, Dependabot,
  // and Cursor. Account avatars come from Clerk (`img.clerk.com`,
  // `images.clerk.dev`, and Clerk-hosted uploads under the
  // `images.clerk.dev/` prefix on Google Cloud Storage).
  // We keep the allowlist scoped: no blanket `https:`, and Google Cloud Storage
  // is only ever allowed under specific path prefixes, never the bare host.
  const cspImageSources = `${cspSources}${cspLocalSources} https://avatars.githubusercontent.com https://*.githubusercontent.com https://user-images.githubusercontent.com https://private-user-images.githubusercontent.com https://media.githubusercontent.com https://camo.githubusercontent.com https://objects.githubusercontent.com https://github.githubassets.com https://opengraph.githubassets.com https://github.com https://vercel.com https://*.vercel.com https://img.shields.io https://*.s3.amazonaws.com https://storage.googleapis.com/coderabbit_public_assets/ https://storage.googleapis.com/images.clerk.dev/ https://img.clerk.com https://images.clerk.dev https://dependabot-badges.githubapp.com/badges/ https://cursor.com/assets/images/ https://www.gravatar.com https://secure.gravatar.com https://ade-app.dev`;
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
