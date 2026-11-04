// Shared helpers for the release-time PostHog scripts (annotate-release.mjs,
// upload-sourcemaps.mjs). Both report through GitHub Actions annotations in CI
// and never fail the job.

export const DEFAULT_POSTHOG_HOST = "https://us.posthog.com";

export function notice(message) {
  console.log(`${process.env.GITHUB_ACTIONS === "true" ? "::notice::" : "[posthog] "}${message}`);
}

export function warn(message) {
  console.log(`${process.env.GITHUB_ACTIONS === "true" ? "::warning::" : "[posthog] warning: "}${message}`);
}

/** `--key value`, `--key=value`, and bare `--flag` (true). A value never starts with `--`. */
export function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const body = arg.slice(2);
    const equals = body.indexOf("=");
    const key = equals === -1 ? body : body.slice(0, equals);
    const inline = equals === -1 ? undefined : body.slice(equals + 1);
    const next = argv[index + 1];
    if (inline !== undefined) {
      options[key] = inline;
    } else if (next === undefined || next.startsWith("--")) {
      options[key] = true;
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}
