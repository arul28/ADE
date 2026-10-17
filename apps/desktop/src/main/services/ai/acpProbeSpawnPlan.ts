import type { AcpChatProvider } from "../../../shared/types/chat";
import type { AcpSpawnPlan } from "../chat/acpHost/acpHostTypes";

/** ACP probes only run ACP providers. Copilot SDK discovery creates no session. */
export async function prepareAcpProbeSpawnPlan(
  _provider: AcpChatProvider,
  plan: AcpSpawnPlan,
): Promise<AcpSpawnPlan> {
  return plan;
}
