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
export ADE_HOST_INSTANCE_ID="agent37:$(hostname)"
mkdir -p "$ADE_HOME/sock" "$ADE_HOME/logs"
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
