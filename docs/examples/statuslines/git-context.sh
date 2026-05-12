#!/usr/bin/env sh
set -eu

payload="$(cat)"
branch="$(git branch --show-current 2>/dev/null || true)"
model="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s||"{}");process.stdout.write(p.model?.displayName||p.model?.display_name||p.model?.id||"model")})')"
context="$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{const p=JSON.parse(s||"{}");const v=p.context_window?.used_percentage ?? p.context?.percent;process.stdout.write(v == null ? "context n/a" : `${v}% context`)})')"

printf '%s | %s | %s\n' "$model" "${branch:-detached}" "$context"
