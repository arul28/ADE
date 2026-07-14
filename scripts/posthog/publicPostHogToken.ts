const PUBLIC_POSTHOG_TOKEN = /^phc_[A-Za-z0-9_-]{8,}$/;

export function assertPublicPostHogToken(token: string, environmentVariable: string): void {
  if (!token || PUBLIC_POSTHOG_TOKEN.test(token)) return;
  throw new Error(
    `${environmentVariable} must be a public phc_ project token; personal API keys must never be bundled.`,
  );
}
