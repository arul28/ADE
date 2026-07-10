import { File, Globe, LinkSimple, Plugs, type Icon } from "@phosphor-icons/react";
import { useMemo } from "react";
import type { AgentChatEventEnvelope } from "../../../shared/types";
import { openUrlInAdeBrowser } from "../../lib/openExternal";
import { deriveChatSources, type ChatSource } from "./chatSources";

type SourceSection = {
  label: string;
  icon: Icon;
  items: ChatSource[];
};

function SourceRow({ source, Icon }: { source: ChatSource; Icon: SourceSection["icon"] }) {
  const body = (
    <>
      <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-white/[0.06] bg-white/[0.025] text-fg/45">
        <Icon size={13} weight="regular" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-sans text-[12px] font-medium text-fg/82">{source.title}</span>
        {source.detail ? (
          <span className="mt-0.5 block line-clamp-2 break-all font-sans text-[10px] leading-4 text-muted-fg/48">
            {source.detail}
          </span>
        ) : null}
      </span>
      {source.url ? <LinkSimple size={12} className="mt-1 shrink-0 text-fg/28" /> : null}
    </>
  );
  const className = "flex w-full min-w-0 gap-2.5 rounded-lg border border-white/[0.055] bg-white/[0.018] px-2.5 py-2 text-left";
  return source.url ? (
    <button
      type="button"
      className={`${className} transition-colors hover:border-cyan-300/20 hover:bg-cyan-400/[0.035]`}
      title={source.url}
      onClick={() => openUrlInAdeBrowser(source.url)}
    >
      {body}
    </button>
  ) : (
    <div className={className} title={source.path ?? source.detail}>
      {body}
    </div>
  );
}

export function ChatSourcesPanel({ events }: { events: AgentChatEventEnvelope[] }) {
  const sources = useMemo(() => deriveChatSources(events), [events]);
  const sections: SourceSection[] = [
    { label: "Files", icon: File, items: sources.files },
    { label: "Apps & tools", icon: Plugs, items: sources.tools },
    { label: "Web", icon: Globe, items: sources.web },
    { label: "External resources", icon: LinkSimple, items: sources.external },
  ].filter((section) => section.items.length > 0);

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="font-sans text-[13px] font-semibold text-fg/86">Sources</div>
          <p className="mt-1 font-sans text-[11px] leading-4 text-muted-fg/52">
            Files, searches, and connected apps used in this Codex chat.
          </p>
        </div>
        <span className="rounded-full border border-white/[0.07] bg-white/[0.025] px-2 py-0.5 font-mono text-[10px] text-fg/42">
          {sources.total}
        </span>
      </div>

      {sections.length ? (
        <div className="mt-5 space-y-5">
          {sections.map((section) => (
            <section key={section.label}>
              <div className="mb-2 flex items-center gap-2 font-sans text-[10px] font-semibold uppercase tracking-[0.08em] text-fg/38">
                <section.icon size={11} weight="bold" />
                <span>{section.label}</span>
                <span className="font-mono font-normal text-fg/25">{section.items.length}</span>
              </div>
              <div className="space-y-1.5">
                {section.items.map((source) => (
                  <SourceRow key={source.id} source={source} Icon={section.icon} />
                ))}
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex min-h-[220px] flex-col items-center justify-center px-3 text-center">
          <LinkSimple size={22} className="text-fg/20" />
          <div className="mt-3 font-sans text-[12px] font-medium text-fg/58">No sources yet</div>
          <p className="mt-1 max-w-[240px] font-sans text-[10px] leading-4 text-muted-fg/42">
            Sources appear here when Codex reads an attachment, searches the web, or uses a connected app.
          </p>
        </div>
      )}
    </div>
  );
}
