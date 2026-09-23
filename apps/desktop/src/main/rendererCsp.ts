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

/**
 * The non-http schemes `frame-src` allows in BOTH modes, as data rather than
 * as a string. `buildRendererCspPolicy` interpolates this list into
 * `frame-src`; `isRendererFrameNavigationAllowed` iterates it.
 *
 * `main.ts`'s `will-frame-navigate` handler is the SECOND door on this same
 * allowlist, and the two must not drift: a source the CSP names and the
 * handler does not is a frame the browser would render and the handler
 * cancels. One literal, two readers, so there is nothing to keep in sync.
 */
export const FRAME_SRC_EXTRA_SCHEMES = ["ade-scene:", "blob:", "about:"] as const;

/**
 * The schemes only a packaged build serves its own renderer over. A packaged
 * build serves renderer-framed local documents over these, so the navigation
 * door must name them even though the dev CSP does not.
 */
export const PACKAGED_FRAME_SCHEMES = ["file:", "app:"] as const;

/**
 * May a SUBFRAME navigate to this URL?
 *
 * Pure so it can be tested without a window. `rendererUrl` is ADE's own
 * document (`'self'`); `devServerUrl` is the Vite origin when there is one,
 * and its presence is also what makes this a dev build.
 */
export function isRendererFrameNavigationAllowed(
  url: string,
  options: { rendererUrl: string; devServerUrl?: string | null },
): boolean {
  if (!url) return false;
  if (url === options.rendererUrl) return true;
  if (FRAME_SRC_EXTRA_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  if (PACKAGED_FRAME_SCHEMES.some((scheme) => url.startsWith(scheme))) return true;
  if (!options.devServerUrl) return false;
  if (url.startsWith(options.devServerUrl)) return true;
  // Other local http ports, and ONLY while a dev server is configured. A
  // packaged renderer frames nothing over http, so leaving the door open there
  // would let a scene navigate itself at any local server the user is running.
  // http only, because the CSP names no https local source.
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:"
      && (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

export function buildRendererCspPolicy(isDevMode: boolean): string {
  const cspSources = isDevMode
    ? "'self' http://localhost:* http://127.0.0.1:*"
    : "'self' file: app:";
  const cspWsSources = isDevMode ? " ws://localhost:* ws://127.0.0.1:*" : "";
  // Local http carries the simulator stream helpers and the proof video media
  // server (`artifactMediaServer.ts`), which is why media-src names it.
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
  const cspImageSources = `${cspSources}${cspLocalSources} https://avatars.githubusercontent.com https://*.githubusercontent.com https://user-images.githubusercontent.com https://private-user-images.githubusercontent.com https://media.githubusercontent.com https://camo.githubusercontent.com https://objects.githubusercontent.com https://github.githubassets.com https://opengraph.githubassets.com https://github.com https://vercel.com https://*.vercel.com https://img.shields.io https://*.s3.amazonaws.com https://storage.googleapis.com/coderabbit_public_assets/ https://storage.googleapis.com/images.clerk.dev/ https://img.clerk.com https://images.clerk.dev https://dependabot-badges.githubapp.com/badges/ https://cursor.com/assets/images/ https://www.gravatar.com https://secure.gravatar.com https://ade-app.dev https://img.youtube.com`;
  // The welcome video used to be a YouTube iframe embed, which required
  // frame-src exceptions for youtube(-nocookie).com. It's now a thumbnail
  // button that hands off to the system browser (WelcomeVideoGate.tsx), so
  // no external frame-src is needed.
  // `ade-scene:` is framed and nothing else: a scene is agent-authored code, so
  // it is only ever loaded into a sandboxed iframe with its own origin. It is
  // deliberately absent from img-src/media-src/connect-src — there is no
  // legitimate reason for ADE's own document to fetch one.
  // `ade-scene:` serves generated views with their own policy and origin.
  //
  // `blob:` in frame-src is a DELIBERATE widening, recorded here rather than
  // only in the component that needs it. It is SceneFrame's fallback for when
  // `scene.prepare` is unavailable (the hosted web client, a browser preview,
  // a main process that answered null).
  // It is safe for one reason and only that reason: every scene frame carries
  // `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, so a blob frame gets
  // an opaque origin exactly as the custom scheme does, and a blob URL is only
  // ever minted by this renderer from a document it assembled itself — nothing
  // remote can put one here. `blob:` stays out of connect-src and script-src,
  // where it would mean something else entirely. Removing `allow-same-origin`
  // from that sandbox attribute is what would make this line dangerous, which
  // is why SceneFrame.test.tsx asserts the pair can never appear together.
  const cspFrameSources = `${cspSources}${cspLocalSources} ${FRAME_SRC_EXTRA_SCHEMES.join(" ")}`;
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
