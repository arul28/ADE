// Retries a macOS release step that fails for reasons outside the build.
//
// Apple's notary and ticket services drop connections, and `hdiutil` sometimes
// finds its target busy for a moment after a large copy. Each of these used to
// fail a 20-40 minute release job outright, so the job had to be rebuilt from
// scratch. Only failures that match `isTransient` are retried; a real verdict
// (an invalid ticket, a rejected submission) still fails on the first attempt.

export const APPLE_NETWORK_ERROR =
  /NSURLErrorDomain|network connection was lost|-100[0-9]\b|timed out|timeout|offline|No network route|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection (?:reset|refused)|temporarily unavailable|CloudKit's response is inconsistent|HTTP(?:Error)?.*(?:nil|5\d\d)/i;

function describe(error) {
  return [error?.message, error?.stdout, error?.stderr]
    .filter((part) => typeof part === "string" && part.trim())
    .join("\n");
}

export async function retryTransient(label, attemptFn, { attempts = 5, delayMs = 15_000, isTransient }) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await attemptFn(attempt);
    } catch (error) {
      const output = describe(error);
      if (attempt >= attempts || !isTransient.test(output)) throw error;
      const waitMs = delayMs * attempt;
      console.warn(
        `[release:mac] ${label} failed with a transient error (attempt ${attempt}/${attempts}); ` +
          `retrying in ${Math.round(waitMs / 1000)}s.\n${output}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}
