## Log viewer

Opens `.log` and `.ndjson` files in the Files tab as lines rather than as a wall
of text: levels are picked out, errors and warnings are counted, and you can
filter to one level without leaving the file.

### What it adds

- A viewer in **Files** for `.log` and `.ndjson`.

### How it reads

Logs get large, so it reads the **last 128 KiB** of a file rather than the whole
thing, and only when you press Load. The panel says which part it read and how
big the file actually is, so a truncated view never looks like a complete one.

Reading goes through ADE's own file action on the machine that holds the file —
the same path, and the same workspace boundary, as the editor. Parsing happens
there too; what reaches your screen (or your phone) is the parsed rows.

NDJSON lines are read as structured records: `level`, `msg`/`message`, and a
timestamp field are used when present, including pino and bunyan numeric levels.
Plain text lines fall back to a leading timestamp and a level word.

### Settings

- **Lines to show** — how many of the most recent lines the panel lists, up to
  100.

### Limits worth knowing

- One panel per plugin, so two log files open at once share the view and the
  most recent Load wins. The panel names the file it read.
- It does not follow a file as it grows. Press Reload.
