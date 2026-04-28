# Missions Stabilization Review Scope

This repo currently has broad branch churn across Linear, preview, graph, automations, and docs work. The mission hotfixes for `ADE-5`, `ADE-15`, `ADE-17`, `ADE-18`, `ADE-20`, `ADE-21`, and `ADE-22` should be reviewed as a focused slice instead of as part of the whole dirty tree.

## Hotfix scope

The isolated scope lives in `infra/scripts/review-missions-stabilization.sh` and is intentionally limited to the files changed for mission stabilization:

- Orchestrator failure handling and intervention behavior:
  `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.ts`,
  `apps/desktop/src/main/services/orchestrator/baseOrchestratorAdapter.ts`,
  `apps/desktop/src/main/services/orchestrator/orchestratorService.ts`,
  `apps/desktop/src/main/services/orchestrator/workerDeliveryService.ts`,
  `apps/desktop/src/main/services/orchestrator/workerTracking.ts`,
  `apps/desktop/src/shared/chatTranscript.ts`,
  `apps/desktop/src/shared/types/orchestrator.ts`
- Mission chat and intervention UX:
  `apps/desktop/src/renderer/components/missions/ChatMessageArea.tsx`,
  `apps/desktop/src/renderer/components/missions/InterventionPanel.tsx`,
  `apps/desktop/src/renderer/components/missions/MissionChatV2.tsx`,
  `apps/desktop/src/renderer/components/missions/MissionLogsTab.tsx`,
  `apps/desktop/src/renderer/components/missions/MissionTabContainer.tsx`,
  `apps/desktop/src/renderer/components/missions/missionInterventionRouting.ts`,
  `apps/desktop/src/renderer/components/missions/missionThreadEventAdapter.ts`,
  `apps/desktop/src/renderer/components/chat/AgentChatMessageList.tsx`,
  `apps/desktop/src/shared/types/chat.ts`
- Focused regression coverage:
  `apps/desktop/src/main/services/orchestrator/aiOrchestratorService.test.ts`,
  `apps/desktop/src/main/services/orchestrator/baseOrchestratorAdapter.test.ts`,
  `apps/desktop/src/main/services/orchestrator/orchestratorService.test.ts`,
  `apps/desktop/src/main/services/orchestrator/planningGapsFixes.test.ts`,
  `apps/desktop/src/main/services/orchestrator/workerDeliveryService.test.ts`,
  `apps/desktop/src/renderer/components/missions/MissionLogsTab.test.tsx`,
  `apps/desktop/src/renderer/components/missions/MissionRunPanel.test.ts`,
  `apps/desktop/src/renderer/components/missions/missionThreadEventAdapter.reliability.test.ts`,
  `apps/desktop/src/renderer/components/chat/AgentChatMessageList.test.tsx`

## Review commands

- Show only the mission hotfix file set:
  `infra/scripts/review-missions-stabilization.sh paths`
- Show status and diffstat for only the hotfix:
  `infra/scripts/review-missions-stabilization.sh summary`
- Show the exact patch for only the hotfix:
  `infra/scripts/review-missions-stabilization.sh diff`
- Show the currently dirty files outside the hotfix scope:
  `infra/scripts/review-missions-stabilization.sh out-of-scope`
- Run the focused regression suite that is intended to stay green regardless of unrelated branch churn:
  `infra/scripts/review-missions-stabilization.sh verify`

## Known unrelated blockers

`npm run typecheck` from `apps/desktop` is still blocked by pre-existing changes outside the hotfix scope:

- `apps/desktop/src/renderer/components/graph/WorkspaceGraphPage.test.tsx`
- `apps/desktop/src/renderer/components/run/RunPage.test.tsx`
- `apps/ade-cli/src/adeRpcServer.ts`

Those failures are intentionally documented here so mission stabilization verification can proceed without trying to rewrite or discard unrelated work already present in the tree.
