import { useEffect, useState } from "react";
import type { AutomationTrigger } from "../../../shared/types";
import { cn } from "../ui/cn";
import { INPUT_CLS, INPUT_STYLE } from "./shared";

type GitHubApi = {
  listRepoLabels?: (args: { owner: string; name: string }) => Promise<Array<{ name: string; color?: string }>>;
  listRepoCollaborators?: (args: { owner: string; name: string }) => Promise<Array<{ login: string; avatarUrl?: string }>>;
  detectRepo?: () => Promise<{ owner: string; name: string } | null>;
};

function getGithubApi(): GitHubApi {
  // window.ade.github may not yet expose these methods until gh-backend wires
  // the preload bridge; treat them as optional and fall back to empty.
  return (window as unknown as { ade: { github?: GitHubApi } }).ade.github ?? {};
}

export function GitHubTriggerFilters({
  trigger,
  onPatch,
}: {
  trigger: AutomationTrigger;
  onPatch: (patch: Partial<AutomationTrigger>) => void;
}) {
  const isPr = trigger.type.startsWith("github.pr_") || trigger.type.startsWith("git.pr_");
  const isIssue = trigger.type.startsWith("github.issue_");
  const isPush = trigger.type === "git.push" || trigger.type === "git.commit";

  const [labels, setLabels] = useState<string[]>([]);
  const [collaborators, setCollaborators] = useState<string[]>([]);
  const [repoInfo, setRepoInfo] = useState<{ owner: string; name: string } | null>(null);
  const [loadingPickers, setLoadingPickers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const api = getGithubApi();
      if (!api.detectRepo) return;
      setLoadingPickers(true);
      try {
        const repo = await api.detectRepo();
        if (!repo || cancelled) {
          if (!cancelled) setLoadingPickers(false);
          return;
        }
        setRepoInfo(repo);
        const [nextLabels, nextCollabs] = await Promise.all([
          api.listRepoLabels?.({ owner: repo.owner, name: repo.name }).catch(() => []),
          api.listRepoCollaborators?.({ owner: repo.owner, name: repo.name }).catch(() => []),
        ]);
        if (cancelled) return;
        setLabels((nextLabels ?? []).map((l) => l.name));
        setCollaborators((nextCollabs ?? []).map((u) => u.login));
      } catch {
        // Swallow — pickers fall back to free-text input.
      } finally {
        if (!cancelled) setLoadingPickers(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="space-y-3">
      {isPr ? (
        <div className="grid gap-2 md:grid-cols-2">
          <LabeledInput
            label={trigger.type === "git.pr_merged" || trigger.type === "github.pr_merged" ? "Target branch" : "Branch"}
            value={
              trigger.type === "git.pr_merged" || trigger.type === "github.pr_merged"
                ? trigger.targetBranch ?? ""
                : trigger.branch ?? ""
            }
            placeholder="e.g. main"
            onChange={(value) =>
              onPatch(
                trigger.type === "git.pr_merged" || trigger.type === "github.pr_merged"
                  ? { targetBranch: value }
                  : { branch: value },
              )
            }
          />
          <AuthorPicker
            value={trigger.authors ?? (trigger.author ? [trigger.author] : [])}
            collaborators={collaborators}
            loading={loadingPickers}
            onChange={(authors) => onPatch({ authors, author: undefined })}
          />
        </div>
      ) : null}

      {isIssue ? (
        <div className="grid gap-2 md:grid-cols-2">
          <AuthorPicker
            value={trigger.authors ?? (trigger.author ? [trigger.author] : [])}
            collaborators={collaborators}
            loading={loadingPickers}
            onChange={(authors) => onPatch({ authors, author: undefined })}
          />
          <LabelPicker
            value={trigger.labels ?? []}
            options={labels}
            loading={loadingPickers}
            onChange={(next) => onPatch({ labels: next })}
          />
        </div>
      ) : null}

      {isPush ? (
        <div className="grid gap-2 md:grid-cols-2">
          <LabeledInput
            label="Branch"
            value={trigger.branch ?? ""}
            placeholder="e.g. main"
            onChange={(value) => onPatch({ branch: value })}
          />
          <LabeledInput
            label="Paths"
            value={(trigger.paths ?? []).join(", ")}
            placeholder="src/**, apps/**"
            onChange={(value) =>
              onPatch({
                paths: value
                  .split(",")
                  .map((p) => p.trim())
                  .filter(Boolean),
              })
            }
          />
        </div>
      ) : null}

      {isPr || isIssue ? (
        <div className="grid gap-2 md:grid-cols-2">
          {isPr ? (
            <LabelPicker
              label="Labels"
              value={trigger.labels ?? []}
              options={labels}
              loading={loadingPickers}
              onChange={(next) => onPatch({ labels: next })}
            />
          ) : null}
          <LabeledInput
            label="Title regex"
            value={trigger.titleRegex ?? ""}
            placeholder="^\\[release\\]"
            onChange={(value) => onPatch({ titleRegex: value })}
          />
          <LabeledInput
            label="Body regex"
            value={trigger.bodyRegex ?? ""}
            placeholder="needs reproduction|security"
            onChange={(value) => onPatch({ bodyRegex: value })}
          />
        </div>
      ) : null}

      {repoInfo ? (
        <div className="text-[10px] text-[#7E8A9A]">
          Filters scoped to {repoInfo.owner}/{repoInfo.name}.
        </div>
      ) : null}
    </div>
  );
}

function LabeledInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
      <input
        className={INPUT_CLS}
        style={INPUT_STYLE}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </label>
  );
}

function ChipRow({
  items,
  onRemove,
}: {
  items: string[];
  onRemove: (item: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <span
          key={item}
          className="inline-flex items-center gap-1 rounded-md border border-[#3B5673] bg-[#122234] px-2 py-0.5 text-[11px] text-[#D8E3F2]"
        >
          {item}
          <button
            type="button"
            onClick={() => onRemove(item)}
            className="text-[#7E8A9A] hover:text-[#F5FAFF]"
            aria-label={`Remove ${item}`}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}

function LabelPicker({
  label = "Labels",
  value,
  options,
  loading,
  onChange,
}: {
  label?: string;
  value: string[];
  options: string[];
  loading: boolean;
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const available = options.filter((opt) => !value.includes(opt));

  const commit = (candidate: string) => {
    const trimmed = candidate.trim();
    if (!trimmed) return;
    if (value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setInput("");
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">{label}</span>
        {loading ? <span className="text-[10px] text-[#7E8A9A]">loading…</span> : null}
      </div>
      <div className="flex gap-2">
        <input
          list={`label-options-${label}`}
          className={cn(INPUT_CLS, "flex-1")}
          style={INPUT_STYLE}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && input.trim()) {
              event.preventDefault();
              commit(input);
            }
          }}
          placeholder="Type or pick a label"
        />
        <datalist id={`label-options-${label}`}>
          {available.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
      </div>
      <ChipRow items={value} onRemove={(item) => onChange(value.filter((entry) => entry !== item))} />
    </div>
  );
}

function AuthorPicker({
  value,
  collaborators,
  loading,
  onChange,
}: {
  value: string[];
  collaborators: string[];
  loading: boolean;
  onChange: (next: string[]) => void;
}) {
  const [input, setInput] = useState("");
  const available = collaborators.filter((login) => !value.includes(login));

  const commit = (candidate: string) => {
    const trimmed = candidate.trim().replace(/^@/, "");
    if (!trimmed) return;
    if (value.includes(trimmed)) return;
    onChange([...value, trimmed]);
    setInput("");
  };

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-[1px] text-[#8FA1B8]">Authors</span>
        {loading ? <span className="text-[10px] text-[#7E8A9A]">loading…</span> : null}
      </div>
      <div className="flex gap-2">
        <input
          list="author-options"
          className={cn(INPUT_CLS, "flex-1")}
          style={INPUT_STYLE}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && input.trim()) {
              event.preventDefault();
              commit(input);
            }
          }}
          placeholder="@login or external username"
        />
        <datalist id="author-options">
          {available.map((login) => (
            <option key={login} value={login} />
          ))}
        </datalist>
      </div>
      <ChipRow items={value} onRemove={(item) => onChange(value.filter((entry) => entry !== item))} />
    </div>
  );
}
