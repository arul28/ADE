import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { AuthType, ProviderFamily } from "../../../shared/modelRegistry";
import { createClaudeLoginTerminalInWork } from "../work/ClaudeLoginPromptButton";

export function useOpenProviderSignIn(): (family?: ProviderFamily, authTypes?: readonly AuthType[]) => void {
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);

  return useCallback((family?: ProviderFamily, authTypes?: readonly AuthType[]) => {
    const shouldOpenClaudeLogin = family === "anthropic"
      && (authTypes == null || authTypes.includes("cli-subscription"));
    if (!shouldOpenClaudeLogin) {
      openAiProvidersSettings();
      return;
    }
    void createClaudeLoginTerminalInWork({ navigate })
      .catch(() => openAiProvidersSettings());
  }, [navigate, openAiProvidersSettings]);
}
