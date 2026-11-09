/** What a terminal's shell is doing, read from `/proc` on a Linux computer. */

import fs from "node:fs";

export type ProcChildren = Map<number, Array<{ state: string; name: string }>>;

/** Every process's direct children, from one pass over `/proc` (a sandboxed computer doesn't report tty fields). */
export function readProcChildren(): ProcChildren {
  const children: ProcChildren = new Map();
  for (const name of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, "utf8");
      const open = stat.indexOf("(");
      const close = stat.lastIndexOf(")");
      const comm = stat.slice(open + 1, close);
      const fields = stat.slice(close + 2).split(" ");
      const ppid = Number(fields[1]);
      const list = children.get(ppid) ?? [];
      list.push({ state: fields[0] ?? "", name: comm });
      children.set(ppid, list);
    } catch {
      // The process just ended.
    }
  }
  return children;
}

/**
 * Who has the terminal's foreground, on a Linux computer: a shell at its prompt
 * owns it, and a running command takes it. Output can't tell the two apart: a
 * quiet `sleep 300` and an idle prompt both read `idle` 12.5 s after the last byte.
 * gVisor (a default computer) reports no tty fields in `/proc`, so there the
 * shell's own children answer. Null when `/proc` can't answer at all.
 */
export function readPtyForeground(pid: number, children: () => ProcChildren): { atPrompt: boolean; name: string | null } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // "pid (comm) state ppid pgrp session tty_nr tpgid …"; comm may hold spaces.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const pgrp = Number(fields[2]);
    const tpgid = Number(fields[5]);
    if (Number.isFinite(pgrp) && Number.isFinite(tpgid) && tpgid > 0) {
      if (tpgid === pgrp) return { atPrompt: true, name: null };
      return { atPrompt: false, name: fs.readFileSync(`/proc/${tpgid}/comm`, "utf8").trim() || null };
    }
    const running = (children().get(pid) ?? []).filter((child) => child.state !== "Z");
    return running.length === 0 ? { atPrompt: true, name: null } : { atPrompt: false, name: running[0]!.name };
  } catch {
    return null;
  }
}
