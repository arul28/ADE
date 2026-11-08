# Linux desktop review quirks

Read with `docs/development/linux-support.md` when changing packaging, native
code, processes, credentials, networking, runtime ownership or platform gates.
Use focused existing tests and the existing CI matrix first; do not duplicate
full suites. Real Linux is required to prove kernel, display, desktop-session,
firewall, package and updater behavior.

- A Linux machine can run a desktop or be headless. Platform alone does not
  establish whether a desktop bridge is attached; probe the capability and keep
  the existing brain and pairing identity when attaching.
- Route lane and session actions to their owning machine's pin. A local Linux
  window must not hide an iOS simulator on a paired Mac just because Linux
  cannot run one locally.
- Linux desktop sessions can be X11 or Wayland. Lane screens use Xvfb/X11;
  successful Xvfb capture does not prove a Wayland desktop window.
- Preserve Chromium sandboxing. AppArmor/user namespace restrictions and
  AppImage FUSE are host-specific; do not silently disable the sandbox for all.
- AppImage and deb have different update semantics: in-place update only for
  AppImage; offer a deb download. Check metadata and artifacts per architecture.
- Load the target architecture's CR-SQLite and native modules. A missing library
  or executable bit must be a visible failure, not an empty or unsynced state.
- mDNS uses UDP multicast; sync uses the actual chosen TCP port in 8787–8999.
  Firewall, multicast isolation and headless hosts can defeat discovery even
  when a direct or relay path works. Never expose the PIN in discovery TXT.
- Linux keyring availability, service manager, user session and desktop portal
  vary. Do not assume systemd, an unlocked keyring, a graphical session, or a
  particular desktop environment. Check failed and unavailable paths explicitly.
- Preserve Unix process-group cleanup, socket/home isolation and permissions;
  a PID alone is not process identity. Do not use shell quoting in place of
  structured argv, especially for paths containing spaces or Unicode.
