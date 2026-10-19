// Windows runners do real file, SQLite and pipe work several times slower than
// macOS/Linux (laneStorageLifecycle.test.ts: ~70 s on windows-latest), so a
// timeout sized for a Mac flakes there on tests that pass. Assertion failures
// still fail; only the clock is loosened, and only on Windows.
export function windowsScaledTimeout(ms: number): number {
  return process.platform === "win32" ? ms * 2 : ms;
}
