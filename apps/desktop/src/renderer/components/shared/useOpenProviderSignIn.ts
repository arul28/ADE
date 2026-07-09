import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { ProviderFamily } from "../../../shared/modelRegistry";
import { createClaudeLoginTerminalInWork } from "../work/ClaudeLoginPromptButton";

export function useOpenProviderSignIn(): (family?: ProviderFamily) => void {
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);

  return useCallback((family?: ProviderFamily) => {
    if (family !== "anthropic") {
      openAiProvidersSettings();
      return;
    }
    void createClaudeLoginTerminalInWork({ navigate })
      .catch(() => openAiProvidersSettings());
  }, [navigate, openAiProvidersSettings]);
}
