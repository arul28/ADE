/**
 * What `xcrun` prints on a Mac that has the Command Line Tools but not Xcode,
 * when asked for `simctl`. Such a Mac has no simulators: the simulator service
 * answers with an empty list, and Sentry treats the message as a state.
 */
export const SIMCTL_MISSING = /unable to find utility "simctl", not a developer tool or in PATH/;

/** What Apple's tools print while the Xcode license waits to be accepted. */
export const XCODE_LICENSE_NOT_AGREED = /not agreed to the Xcode license agreements/i;

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
export const GIT_TOOLCHAIN_MISSING = new RegExp(
  `xcode-select: note: No developer tools were found|xcrun: error: invalid active developer path|${XCODE_LICENSE_NOT_AGREED.source}`,
  "i",
);
