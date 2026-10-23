/**
 * What `xcrun` prints on a Mac that has the Command Line Tools but not Xcode,
 * when asked for `simctl`. Such a Mac has no simulators: the simulator service
 * answers with an empty list, and Sentry treats the message as a state.
 */
export const SIMCTL_MISSING = /unable to find utility "simctl", not a developer tool or in PATH/;
