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

# Run as root through sudo (the only command `node` may sudo): start Docker
# when this machine's kernel can run it. A VM has its own kernel; a sandboxed
# box (gVisor, which reports kernel 4.4.0) does not, so it is skipped there.
if [ "${1:-}" = "--start-dockerd" ]; then
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
  # Images and volumes on the persistent disk, so a restart keeps them. The
  # socket's group is `node`, so the brain needs no extra group to use it.
  mkdir -p /home/node/.docker-data /home/node/.ade/logs
  nohup dockerd --data-root /home/node/.docker-data --group node \
    >> /home/node/.ade/logs/dockerd.log 2>&1 < /dev/null &
  exit 0
fi

export ADE_HOST_INSTANCE_ID="agent37:$(hostname)"
# An Agent37 machine is a sandbox. Claude Code refuses full-auto permissions
# to root unless told so; the brain here runs as `node`, but anything that runs
# an agent as root on the machine (sudo, a root exec) gets the same answer.
export IS_SANDBOX=1
# Check for a resume (a wake from sleep) every second instead of every 15, so
# the brain reconnects to the relay right after Agent37 wakes the machine.
export ADE_SUSPEND_GAP_TICK_MS=1000
mkdir -p "$ADE_HOME/sock" "$ADE_HOME/logs" "$ADE_HOME/ready"
sudo -n /usr/local/bin/ade-entrypoint.sh --start-dockerd 2>/dev/null || true

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
