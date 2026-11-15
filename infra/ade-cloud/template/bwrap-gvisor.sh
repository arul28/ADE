#!/bin/sh
# /usr/bin/bwrap on an ADE Cloud computer; the real bubblewrap is /usr/bin/bwrap.real.
#
# The computer runs under gVisor, which can't bring up loopback in a new
# network namespace, so `bwrap --unshare-net` always fails there
# ("loopback: Failed RTM_NEWADDR"). Codex runs every shell command through
# bubblewrap with a network namespace, so without this no Codex command ran
# in plan, default or edit mode. Codex also blocks the network with its own
# seccomp filter, so for Codex alone the namespace is dropped: writes outside
# the workspace and network stay blocked as Codex asked.
#
# Codex's call is bubblewrap's options, `--`, then Codex itself (`codex` or
# `codex-linux-sandbox`) with its seccomp stage `--apply-seccomp-then-exec`
# before the command's own `--`. Only that shape counts, and only
# bubblewrap's own options lose `--unshare-net`: text in the sandboxed
# command never does. Every other call passes through unchanged, and still
# fails where it asks for a network namespace.
real=/usr/bin/bwrap.real

phase=options
exe=
codex=no
for arg; do
  case $phase in
    options) [ "$arg" = "--" ] && phase=exe ;;
    exe) exe=$arg; phase=codex ;;
    codex)
      [ "$arg" = "--" ] && break
      [ "$arg" = "--apply-seccomp-then-exec" ] && codex=yes
      ;;
  esac
done
case ${exe##*/} in
  codex|codex-linux-sandbox) ;;
  *) codex=no ;;
esac

if [ "$codex" = yes ]; then
  phase=options
  for arg; do
    shift
    if [ "$phase" = options ]; then
      [ "$arg" = "--" ] && phase=rest
      [ "$arg" = "--unshare-net" ] && continue
    fi
    set -- "$@" "$arg"
  done
fi
exec "$real" "$@"
