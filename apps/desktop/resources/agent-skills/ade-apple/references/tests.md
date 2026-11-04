# Tests on the lane's device

`apple test` runs `xcodebuild test` on this lane's device, with parallel
testing off and DerivedData in the lane's cache
(`.ade/cache/ios-simulator/DerivedData`), which ADE deletes with the lane. One
test run goes at a time on the Mac (`APPLE_TEST_RUN_BUSY`: wait, then run
again). A failing test comes back as `passed: false` with the failures and the
log path; it is not an error. `--text` prints the counts (XCTest and Swift
Testing together), each failing test with its file, line and message, then
xcodebuild's own failure lines, the log and the result bundle; `--json` has
the same as `failures: [{test, file, line, message}]`. An XCTest name there
(`ADETests/SyncTests/testX`) is what `--only` takes.
