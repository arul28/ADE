import React, { useEffect, useState } from "react";
import { CheckCircle, XCircle, Key, Globe, Cpu } from "@phosphor-icons/react";
import { Button } from "../ui/Button";
import { cn } from "../ui/cn";

type DetectedCli = {
  name: string;
  detected: boolean;
};

const CLI_TOOLS: Array<{ name: string; label: string; description: string }> = [
  { name: "claude", label: "Claude Code CLI", description: "Anthropic's coding agent" },
  { name: "codex", label: "Codex CLI", description: "OpenAI's coding agent" },
  { name: "gemini", label: "Gemini CLI", description: "Google's coding agent" },
];

const API_KEY_PROVIDERS: Array<{ provider: string; label: string; envVar: string; placeholder: string }> = [
  { provider: "anthropic", label: "Anthropic", envVar: "ANTHROPIC_API_KEY", placeholder: "sk-ant-..." },
  { provider: "openai", label: "OpenAI", envVar: "OPENAI_API_KEY", placeholder: "sk-..." },
  { provider: "google", label: "Google AI", envVar: "GOOGLE_API_KEY", placeholder: "AIza..." },
  { provider: "mistral", label: "Mistral", envVar: "MISTRAL_API_KEY", placeholder: "" },
  { provider: "deepseek", label: "DeepSeek", envVar: "DEEPSEEK_API_KEY", placeholder: "" },
  { provider: "xai", label: "xAI (Grok)", envVar: "XAI_API_KEY", placeholder: "" },
  { provider: "groq", label: "Groq", envVar: "GROQ_API_KEY", placeholder: "" },
  { provider: "together", label: "Together AI", envVar: "TOGETHER_API_KEY", placeholder: "" },
  { provider: "openrouter", label: "OpenRouter", envVar: "OPENROUTER_API_KEY", placeholder: "sk-or-..." },
];

const LOCAL_PROVIDERS: Array<{ provider: string; label: string; defaultEndpoint: string }> = [
  { provider: "ollama", label: "Ollama", defaultEndpoint: "http://localhost:11434" },
  { provider: "lmstudio", label: "LM Studio", defaultEndpoint: "http://localhost:1234" },
];

const cardStyle = cn(
  "rounded-lg border border-border/20 bg-card/60 p-4"
);

const sectionHeading = cn("text-sm font-medium text-fg mb-3");

function StatusDot({ ok }: { ok: boolean }) {
  return ok
    ? <CheckCircle size={16} weight="fill" className="text-emerald-400" />
    : <XCircle size={16} weight="regular" className="text-zinc-500" />;
}

export function ProvidersSection() {
  const [cliStatus, setCliStatus] = useState<DetectedCli[]>([]);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [editingProvider, setEditingProvider] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    detectProviders();
  }, []);

  const detectProviders = async () => {
    setLoading(true);
    try {
      const status = await window.ade.ai?.getStatus?.();
      if (status) {
        setCliStatus(CLI_TOOLS.map(t => ({
          name: t.name,
          detected: status.availableProviders?.[t.name as keyof typeof status.availableProviders] ?? false
        })));
      }
    } catch {
      setCliStatus(CLI_TOOLS.map(t => ({ name: t.name, detected: false })));
    }
    setLoading(false);
  };

  const handleSaveKey = async (provider: string) => {
    if (!editValue.trim()) return;
    try {
      await window.ade.ai?.storeApiKey?.(provider, editValue.trim());
      setApiKeys(prev => ({ ...prev, [provider]: editValue.trim() }));
    } catch {
      // Fallback: store locally in component state
      setApiKeys(prev => ({ ...prev, [provider]: editValue.trim() }));
    }
    setEditingProvider(null);
    setEditValue("");
  };

  const handleDeleteKey = async (provider: string) => {
    try {
      await window.ade.ai?.deleteApiKey?.(provider);
    } catch { /* ignore */ }
    setApiKeys(prev => {
      const next = { ...prev };
      delete next[provider];
      return next;
    });
  };

  const maskKey = (key: string): string => {
    if (key.length <= 8) return "****";
    return key.slice(0, 4) + "..." + key.slice(-4);
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-fg mb-1">AI Providers</h2>
        <p className="text-xs text-muted-fg">
          Configure AI model providers. ADE auto-detects CLI subscriptions and supports API keys for direct access.
        </p>
      </div>

      {/* CLI Subscriptions Card */}
      <div className={cardStyle}>
        <h3 className={sectionHeading}>
          <Globe size={14} weight="regular" className="inline mr-1.5 -mt-0.5" />
          CLI Subscriptions
        </h3>
        <div className="space-y-2">
          {CLI_TOOLS.map(tool => {
            const status = cliStatus.find(c => c.name === tool.name);
            return (
              <div key={tool.name} className="flex items-center justify-between py-1.5">
                <div>
                  <span className="text-sm text-fg">{tool.label}</span>
                  <span className="text-xs text-muted-fg ml-2">{tool.description}</span>
                </div>
                <div className="flex items-center gap-2">
                  {loading ? (
                    <span className="text-xs text-muted-fg">Detecting...</span>
                  ) : (
                    <>
                      <StatusDot ok={status?.detected ?? false} />
                      <span className="text-xs text-muted-fg">
                        {status?.detected ? "Detected" : "Not found"}
                      </span>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* API Keys Card */}
      <div className={cardStyle}>
        <h3 className={sectionHeading}>
          <Key size={14} weight="regular" className="inline mr-1.5 -mt-0.5" />
          API Keys
        </h3>
        <p className="text-xs text-muted-fg mb-3">
          Add API keys to access models directly. Keys are stored locally.
        </p>
        <div className="space-y-2">
          {API_KEY_PROVIDERS.map(p => {
            const stored = apiKeys[p.provider];
            const isEditing = editingProvider === p.provider;

            return (
              <div key={p.provider} className="flex items-center justify-between py-1.5 gap-3">
                <div className="min-w-[100px]">
                  <span className="text-sm text-fg">{p.label}</span>
                </div>
                <div className="flex-1 flex items-center gap-2">
                  {isEditing ? (
                    <>
                      <input
                        type="password"
                        value={editValue}
                        onChange={e => setEditValue(e.target.value)}
                        placeholder={p.placeholder || `Enter ${p.label} API key`}
                        className="flex-1 h-7 rounded-md border border-border/30 bg-background/60 px-2 text-xs text-fg placeholder:text-muted-fg focus:outline-none focus:ring-1 focus:ring-accent/40"
                        autoFocus
                        onKeyDown={e => {
                          if (e.key === "Enter") void handleSaveKey(p.provider);
                          if (e.key === "Escape") { setEditingProvider(null); setEditValue(""); }
                        }}
                      />
                      <Button size="sm" variant="primary" onClick={() => void handleSaveKey(p.provider)}>Save</Button>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingProvider(null); setEditValue(""); }}>Cancel</Button>
                    </>
                  ) : stored ? (
                    <>
                      <code className="text-xs text-muted-fg font-mono">{maskKey(stored)}</code>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingProvider(p.provider); setEditValue(""); }}>Edit</Button>
                      <Button size="sm" variant="ghost" className="text-red-400 hover:text-red-300" onClick={() => void handleDeleteKey(p.provider)}>Delete</Button>
                    </>
                  ) : (
                    <>
                      <span className="text-xs text-muted-fg flex-1">Not configured</span>
                      <Button size="sm" variant="ghost" onClick={() => { setEditingProvider(p.provider); setEditValue(""); }}>Add Key</Button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Local Models Card */}
      <div className={cardStyle}>
        <h3 className={sectionHeading}>
          <Cpu size={14} weight="regular" className="inline mr-1.5 -mt-0.5" />
          Local Models
        </h3>
        <p className="text-xs text-muted-fg mb-3">
          Connect to locally-running model servers.
        </p>
        <div className="space-y-2">
          {LOCAL_PROVIDERS.map(lp => (
            <div key={lp.provider} className="flex items-center justify-between py-1.5">
              <div>
                <span className="text-sm text-fg">{lp.label}</span>
                <span className="text-xs text-muted-fg ml-2">{lp.defaultEndpoint}</span>
              </div>
              <span className="text-xs text-muted-fg">Auto-detect</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
