# Simulator push fixtures

Used with `xcrun simctl push <device> com.ade.ios <fixture>.json` to drive the notification
code paths without hitting APNs. `<device>` can be `booted` to target whichever simulator is
currently running.

Covers: CHAT_AWAITING_INPUT (tests Approve/Deny/Reply), CHAT_FAILED (tests RESTART), PR_CI_FAILING
(tests Retry), PR_REVIEW_REQUESTED, PR_MERGE_READY.

Sequence that exercises the full surface:
  xcrun simctl push booted com.ade.ios chat-awaiting-input.json
  xcrun simctl push booted com.ade.ios pr-ci-failing.json
  xcrun simctl push booted com.ade.ios chat-failed.json

Real device testing requires a configured APNs .p8 in ADE desktop → Settings → Mobile Push.
