#!/bin/sh
# The box's main process: keep ADE's brain running.
#
# Being the entrypoint is what lets the brain survive an Agent37 sleep (the
# entrypoint's process tree is checkpointed and restored; anything started
# later through Agent37's exec API is not). A resize or restart starts this
# script again, and the loop brings the brain back.
#
# Agent37's hostname is the instance id, which changes on a fork. ADE records
# it and, when it changes, starts signed out as a new machine instead of
# reusing the copied identity (see hostInstanceGuard.ts).

# Run as root through sudo (the only command `node` may sudo): what a VM's
# own kernel offers the brain. A sandboxed box (gVisor, which reports kernel
# 4.4.0) has no /dev/kvm and runs no Docker, so it skips all of it.
if [ "${1:-}" = "--root-setup" ]; then
  # The Android emulator needs hardware virtualization; the brain runs as
  # `node`, so it gets the device through its group.
  if [ -c /dev/kvm ]; then
    chgrp node /dev/kvm 2>/dev/null && chmod g+rw /dev/kvm 2>/dev/null || true
  fi
  command -v dockerd >/dev/null 2>&1 || exit 0
  [ "$(uname -r)" = "4.4.0" ] && exit 0
  dmesg 2>/dev/null | grep -qi gvisor && exit 0
  # A socket can outlive a daemon that died; only a live one counts.
  pgrep -x dockerd >/dev/null 2>&1 && exit 0
  # Agent37's VM kernel ships netfilter as modules, unloaded: without them
  # dockerd can't make its NAT chain and exits.
  for module in nf_tables nft_chain_nat nft_compat nf_nat xt_MASQUERADE xt_conntrack xt_addrtype \
    iptable_nat iptable_filter br_netfilter bridge veth overlay; do
    modprobe "$module" 2>/dev/null || true
  done
  # Keep common dev-stack ports out of the kernel's range for outgoing
  # connections (32768-60999 by default). Supabase listens on 54320-54329,
  # inside it, so a busy setup (npm, image pulls) sometimes took one as an
  # outgoing port right before Docker bound it: "failed to bind host port".
  sysctl -q -w net.ipv4.ip_local_reserved_ports=54320-54329 2>/dev/null || true
  # Images and volumes on the persistent disk, so a restart keeps them. The
  # socket's group is `node`, so the brain needs no extra group to use it.
  mkdir -p /home/node/.docker-data /home/node/.ade/logs
  nohup dockerd --data-root /home/node/.docker-data --group node \
    >> /home/node/.ade/logs/dockerd.log 2>&1 < /dev/null &
  exit 0
fi

export ADE_HOST_INSTANCE_ID="agent37:$(hostname)"
# A boot starts with no ADE running, so a sync-host lock left in /tmp is
# stale: a fork copies its source's, naming a process that isn't there.
rm -f /tmp/ade-sync-host-*.json
# An Agent37 machine is a sandbox. Claude Code refuses full-auto permissions
# to root unless told so; the brain here runs as `node`, but anything that runs
# an agent as root on the machine (sudo, a root exec) gets the same answer.
export IS_SANDBOX=1
# Check for a resume (a wake from sleep) every second instead of every 15, so
# the brain reconnects to the relay right after Agent37 wakes the machine.
export ADE_SUSPEND_GAP_TICK_MS=1000
mkdir -p "$ADE_HOME/sock" "$ADE_HOME/logs" "$ADE_HOME/ready"
sudo -n /usr/local/bin/ade-entrypoint.sh --root-setup 2>/dev/null || true
# The Android SDK the image ships (used on a VM; a box has no /dev/kvm). Set
# here, in the brain's own environment, so the Android tool finds it.
if [ -d /opt/android-sdk/platform-tools ]; then
  export ANDROID_HOME=/opt/android-sdk ANDROID_SDK_ROOT=/opt/android-sdk
  export PATH="$PATH:/opt/android-sdk/platform-tools:/opt/android-sdk/emulator"
fi

# A ready machine's setup (clone, install, start the project's services) runs
# here rather than over exec, so what it starts is part of this process tree
# and survives a sleep. ADE writes `job.sh`; this runs it once and records the
# exit code. See agent37ReadyMachines.ts.
jobs="$ADE_HOME/ready"
(
  while true; do
    if [ -f "$jobs/job.sh" ] && [ ! -f "$jobs/job.started" ]; then
      date +%s > "$jobs/job.started"
      ( cd "$HOME" && sh "$jobs/job.sh" ) > "$jobs/job.log" 2>&1 < /dev/null
      echo $? > "$jobs/job.exit"
    fi
    sleep 1
  done
) &

log="$ADE_HOME/logs/brain-entrypoint.log"
delay=2
while true; do
  # A move to another machine holds the brain while its files are copied, so
  # every database is copied whole (agent37MachineCopy.ts). A move ends within
  # its hour-long download link; a pause older than two hours is one whose
  # desktop quit mid-move, so the brain comes back.
  while [ -f "$ADE_HOME/brain.paused" ]; do
    find "$ADE_HOME/brain.paused" -mmin +120 -delete 2>/dev/null
    sleep 5
  done
  start=$(date +%s)
  ade --role cto serve --socket "$ADE_HOME/sock/ade.sock" >> "$log" 2>&1
  # A brain that ran for a minute crashed for a new reason; start over at 2 s.
  if [ $(( $(date +%s) - start )) -gt 60 ]; then
    delay=2
  else
    delay=$(( delay < 60 ? delay * 2 : 60 ))
  fi
  echo "$(date -u +%FT%TZ) brain exited; restarting in ${delay}s" >> "$log"
  sleep "$delay"
done
