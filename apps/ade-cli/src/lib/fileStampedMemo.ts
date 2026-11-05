import fs from "node:fs";

/** The file's text, or null when it does not exist. Any other failure throws. */
export async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * A file's identity for change detection: inode, mtime and size, or
 * `"missing"`. Every ADE writer of a small state file replaces it by rename or
 * rewrites it, and either changes at least one of the three.
 */
export async function fileStampAsync(filePath: string): Promise<string> {
  try {
    const stat = await fs.promises.stat(filePath);
    return `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return "missing";
    throw error;
  }
}

type Entry<T> = {
  value: T;
  /** Null until a check has seen the file; the first check then reloads it. */
  stamp: string | null;
  checking: boolean;
};

/**
 * Values read from small files that the brain needs on hot paths (the machine
 * identity, the relay identity and preference), kept in memory and re-checked
 * off the event loop.
 *
 * On Windows a synchronous read of a tiny file under `~/.ade/secrets` can wait
 * seconds while antivirus scans it; the brain's event loop waited with it, for
 * up to 22 s per read in the field. Here only the first read in a process is
 * synchronous. After that `read` answers from memory and starts one
 * asynchronous `stat` of the file (never two at once, so a stalled disk does
 * not fill the thread pool); a changed stamp reloads the value on the thread
 * pool. Writers in this process call `remember` with what they wrote, so
 * their own change is visible at once. A change by another process (the CLI,
 * the desktop) is visible from the read after that check lands.
 *
 * Process-wide by design: callers that build a fresh store per request share
 * one entry per key instead of reading the file again each time.
 */
export class FileStampedMemo<T> {
  private readonly entries = new Map<string, Entry<T>>();

  /**
   * The remembered value, or undefined when there is none yet. `reload`
   * returns the file's current value, or null to forget it (the next caller
   * then takes its synchronous path, which may need to write). A `stat` or
   * `reload` that throws (a file held by a scan, a permission error) keeps the
   * last good value and leaves the stamp unset, so the next read retries;
   * a reload must therefore throw, not guess, when it cannot read the file.
   */
  read(key: string, check: { filePath: string; reload: () => Promise<T | null> }): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.checkInBackground(key, entry, check);
    return entry.value;
  }

  /** The remembered value without starting a check. */
  peek(key: string): T | undefined {
    return this.entries.get(key)?.value;
  }

  remember(key: string, value: T): void {
    this.entries.set(key, { value, stamp: null, checking: false });
  }

  forget(key: string): void {
    this.entries.delete(key);
  }

  private checkInBackground(
    key: string,
    entry: Entry<T>,
    check: { filePath: string; reload: () => Promise<T | null> },
  ): void {
    if (entry.checking) return;
    entry.checking = true;
    // Each `remember` makes a new entry, so a write in this process while the
    // check runs wins over whatever the check read.
    const current = () => this.entries.get(key) === entry;
    void (async () => {
      const stamp = await fileStampAsync(check.filePath);
      if (!current() || stamp === entry.stamp) return;
      const value = await check.reload();
      if (!current()) return;
      if (value === null) {
        this.entries.delete(key);
        return;
      }
      // Stamped before the reload read the file, so a write in between shows
      // up as a changed stamp on the next check.
      this.entries.set(key, { value, stamp, checking: false });
    })()
      // A failure keeps the entry as it is: its stamp is unchanged, so the
      // next read checks again.
      .catch(() => undefined)
      .finally(() => {
        entry.checking = false;
      });
  }
}
