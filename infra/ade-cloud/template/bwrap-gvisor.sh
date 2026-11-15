#!/bin/sh
# /usr/bin/bwrap on an ADE Cloud computer; the real bubblewrap is /usr/bin/bwrap.real.
#
# The computer runs under gVisor, which can't bring up loopback in a new
# network namespace, so `bwrap --unshare-net` always fails there
# ("loopback: Failed RTM_NEWADDR"). Codex runs every shell command through
# bubblewrap with a network namespace, so without this no Codex command ran
# in plan, default or edit mode. Codex also blocks the network with its own
# seccomp filter (the `--apply-seccomp-then-exec` stage it passes), so for
# Codex alone the namespace is dropped: writes outside the workspace and
# network stay blocked as Codex asked. Every other caller passes through
# unchanged, and still fails where it asks for a network namespace.
case " $* " in
  *" --apply-seccomp-then-exec "*)
    for arg; do
      shift
      [ "$arg" = "--unshare-net" ] && continue
      set -- "$@" "$arg"
    done
    ;;
esac
exec /usr/bin/bwrap.real "$@"
