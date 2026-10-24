/**
 * What macOS prints when `git` is Apple's stub and the Command Line Tools are
 * missing, point nowhere, or wait on the Xcode license. The Mac is not set up
 * for git; ADE is not broken, so callers mark the failure expected
 * (`shared/expectedError.ts`).
 *
 * Matched on text because it is the only signal: these lines come from Apple's
 * `xcode-select` and `xcrun`, which are not localized. Git's own messages are
 * (a Portuguese "não é um repositório git"), so they are never matched; callers
 * classify those by exit code instead.
 */
const GIT_TOOLCHAIN_MISSING =
  /xcode-select: note: No developer tools were found|xcrun: error: invalid active developer path|not agreed to the Xcode license agreements/i;

export function isGitToolchainMissing(output: string): boolean {
  return GIT_TOOLCHAIN_MISSING.test(output);
}
