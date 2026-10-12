// Retries a release step that fails for reasons outside the build.
//
// Apple's notary and ticket services drop connections, `hdiutil` sometimes
// finds its target busy for a moment after a large copy, and downloads fail on
// a runner's DNS. Each of these used to fail a 20-40 minute release job
// outright, so the job had to be rebuilt from scratch. `isTransient` decides
// what is retried; a real verdict (an invalid ticket, a rejected submission, an
// integrity mismatch) still fails on the first attempt. Its log lines use the
// plain "[release]" prefix because Windows steps call it too.

// Apple network failures. NSURLErrorDomain codes are matched as `Code=-10xx`
// only: a bare `-1005` also appears inside notarization submission UUIDs.
const APPLE_NETWORK_ERROR =
  /NSURLErrorDomain|network connection was lost|Code=-10\d\d\b|timed out|timeout|offline|No network route|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection (?:reset|refused)|temporarily unavailable|CloudKit's response is inconsistent|HTTP(?:Error)?.*(?:nil|5\d\d)/i;

// A notarization verdict is never a network error, whatever words its log
// happens to contain.
export function isAppleNetworkError(text) {
  return APPLE_NETWORK_ERROR.test(text) && !/"status"\s*:\s*"(?:Invalid|Rejected)"|status (?:Invalid|Rejected)\b/.test(text);
}

function describeError(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
}

// isTransient: a RegExp tested against the error text, or a predicate on it.
// delayMs: a number (multiplied by the attempt number) or a function of it.
export async function retryTransient(label, attemptFn, { attempts = 5, delayMs = 15_000, isTransient = () => true }) {
  const transient = typeof isTransient === "function" ? isTransient : (text) => isTransient.test(text);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptFn(attempt);
    } catch (error) {
      const output = describeError(error);
      if (attempt >= attempts || !transient(output)) throw error;
      const waitMs = typeof delayMs === "function" ? delayMs(attempt) : delayMs * attempt;
      console.warn(
        `[release] ${label} failed (attempt ${attempt}/${attempts}); retrying in ${Math.round(waitMs / 1000)}s.\n${output}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
