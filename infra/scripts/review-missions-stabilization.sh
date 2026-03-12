#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

MODE="${1:-summary}"

SCOPE_PATHS=(
  "apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts"
  "apps/desktop/src/main/services/orchestrator/aiOrchestratorService.test.ts"
  "apps/desktop/src/main/services/orchestrator/baseOrchestratorAdapter.ts"
  "apps/desktop/src/main/services/orchestrator/baseOrchestratorAdapter.test.ts"
  "apps/desktop/src/main/services/orchestrator/orchestratorService.ts"
  "apps/desktop/src/main/services/orchestrator/orchestratorService.test.ts"
  "apps/desktop/src/main/services/orchestrator/planningGapsFixes.test.ts"
  "apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts"
  "apps/desktop/src/main/services/orchestrator/workerDeliveryService.test.ts"
  "apps/desktop/src/main/services/orchestrator/workerTracking.ts"
  "apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx"
  "apps/desktop/src/renderer/components/chat/AgentChatMessageList.test.tsx"
  "apps/desktop/src/renderer/components/missions/ChatMessageArea.tsx"
  "apps/desktop/src/renderer/components/missions/InterventionPanel.tsx"
  "apps/desktop/src/renderer/components/missions/MissionChatV2.tsx"
  "apps/desktop/src/renderer/components/missions/MissionLogsTab.tsx"
  "apps/desktop/src/renderer/components/missions/MissionLogsTab.test.tsx"
  "apps/desktop/src/renderer/components/missions/MissionRunPanel.test.ts"
  "apps/desktop/src/renderer/components/missions/MissionTabContainer.tsx"
  "apps/desktop/src/renderer/components/missions/missionInterventionRouting.ts"
  "apps/desktop/src/renderer/components/missions/missionThreadEventAdapter.ts"
  "apps/desktop/src/renderer/components/missions/missionThreadEventAdapter.reliability.test.ts"
  "apps/desktop/src/shared/chatTranscript.ts"
  "apps/desktop/src/shared/types/chat.ts"
  "apps/desktop/src/shared/types/orchestrator.ts"
)

print_usage() {
  cat <<'EOF'
usage: infra/scripts/review-missions-stabilization.sh [summary|paths|status|stat|diff|out-of-scope|verify]

summary       Show the hotfix scope, in-scope status, and the first out-of-scope files.
paths         Print the exact file list for the Missions stabilization hotfix.
status        Show git status for the hotfix scope only.
stat          Show git diff --stat for the hotfix scope only.
diff          Show git diff for the hotfix scope only.
out-of-scope  Show changed files outside the hotfix scope.
verify        Run the focused regression suite for the hotfix scope.
EOF
}

print_paths() {
  printf '%s\n' "${SCOPE_PATHS[@]}"
}

run_git_status() {
  git status --short -- "${SCOPE_PATHS[@]}"
}

run_git_stat() {
  git diff --stat -- "${SCOPE_PATHS[@]}"
}

run_git_diff() {
  git diff -- "${SCOPE_PATHS[@]}"
}

run_out_of_scope() {
  local exclude_args=()
  local scope_path
  for scope_path in "${SCOPE_PATHS[@]}"; do
    exclude_args+=(":(exclude)${scope_path}")
  done
  git status --short -- . "${exclude_args[@]}"
}

run_verify() {
  (
    cd apps/desktop
    npm test -- \
      src/main/services/orchestrator/baseOrchestratorAdapter.test.ts \
      src/main/services/orchestrator/planningGapsFixes.test.ts \
      src/main/services/orchestrator/aiOrchestratorService.test.ts \
      src/main/services/orchestrator/workerDeliveryService.test.ts \
      src/renderer/components/missions/MissionRunPanel.test.ts \
      src/renderer/components/missions/MissionLogsTab.test.tsx \
      src/renderer/components/missions/missionThreadEventAdapter.reliability.test.ts \
      src/renderer/components/chat/AgentChatMessageList.test.tsx
    npm test -- src/main/services/orchestrator/orchestratorService.test.ts -t "classifies planning workers with lifecycle-only chat transcripts as interrupted"
  )
}

run_summary() {
  echo "== Missions stabilization scope =="
  print_paths
  echo
  echo "== In-scope status =="
  run_git_status
  echo
  echo "== In-scope diffstat =="
  run_git_stat
  echo
  echo "== Out-of-scope churn (first 40 lines) =="
  run_out_of_scope | sed -n '1,40p'
  echo
  echo "Use 'infra/scripts/review-missions-stabilization.sh verify' for the focused regression suite."
}

case "$MODE" in
  summary)
    run_summary
    ;;
  paths)
    print_paths
    ;;
  status)
    run_git_status
    ;;
  stat)
    run_git_stat
    ;;
  diff)
    run_git_diff
    ;;
  out-of-scope)
    run_out_of_scope
    ;;
  verify)
    run_verify
    ;;
  -h|--help|help)
    print_usage
    ;;
  *)
    print_usage
    exit 1
    ;;
esac
