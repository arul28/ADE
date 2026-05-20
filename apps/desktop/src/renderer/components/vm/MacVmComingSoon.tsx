import { useNavigate } from "react-router-dom";
import type { Icon } from "@phosphor-icons/react";
import { ArrowRight, Cube, Lock, Terminal } from "@phosphor-icons/react";
import { MacMiniGlyph } from "./MacMiniGlyph";

const PREVIEW_ITEMS: ReadonlyArray<{
  icon: Icon;
  title: string;
  body: string;
}> = [
  {
    icon: Cube,
    title: "Singleton VM",
    body: "One Lume-backed macOS guest per host. Provision once, then attach any lane to it on demand.",
  },
  {
    icon: Terminal,
    title: "Per-lane SSH workflows",
    body: "Agents run shells and chats inside the VM, with the worktree mounted via a shared folder.",
  },
  {
    icon: Lock,
    title: "Embedded VNC + Setup Assistant",
    body: "The first-boot console renders in-page — no external Virtualization window, no extra installer.",
  },
];

export function ProductionMacVmComingSoon() {
  const navigate = useNavigate();

  return (
    <div
      className="flex h-full min-h-0 flex-col overflow-y-auto"
      style={{ background: "#0C0A10", color: "#FAFAFA" }}
    >
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-12">
        <div className="grid gap-10 md:grid-cols-[1.05fr_0.95fr] md:items-center">
          <section className="flex flex-col gap-6">
            <span
              className="inline-flex w-fit items-center gap-2 rounded-md px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[1px]"
              style={{
                background: "color-mix(in srgb, #A78BFA 12%, transparent)",
                border: "1px solid color-mix(in srgb, #A78BFA 36%, transparent)",
                color: "#FAFAFA",
              }}
            >
              <span
                className="inline-block h-1.5 w-1.5 rounded-full"
                style={{
                  background: "#A78BFA",
                  boxShadow: "0 0 8px 1px color-mix(in srgb, #A78BFA 50%, transparent)",
                }}
                aria-hidden
              />
              Coming soon
            </span>

            <div>
              <h1
                className="text-[28px] font-semibold leading-[1.15] tracking-tight"
                style={{ color: "#FAFAFA" }}
              >
                Lanes on a real Mac, without<br />a second laptop.
              </h1>
              <p
                className="mt-3 max-w-[52ch] text-[13px] leading-6"
                style={{ color: "#A1A1AA" }}
              >
                Run agents in an isolated macOS VM, share your worktree, and ship without
                polluting your host. We&rsquo;re still hardening the provisioning flow before
                shipping it in packaged builds.
              </p>
            </div>

            <div className="grid gap-2.5 sm:max-w-[520px]">
              {PREVIEW_ITEMS.map(({ icon: Icon, title, body }) => (
                <article
                  key={title}
                  className="flex items-start gap-3 rounded-lg p-3"
                  style={{
                    background: "#13101A",
                    border: "1px solid #1E1B26",
                  }}
                >
                  <span
                    className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
                    style={{
                      background: "color-mix(in srgb, #A78BFA 14%, transparent)",
                      border: "1px solid color-mix(in srgb, #A78BFA 30%, transparent)",
                    }}
                  >
                    <Icon size={14} weight="duotone" style={{ color: "#A78BFA" }} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-semibold" style={{ color: "#FAFAFA" }}>
                      {title}
                    </div>
                    <p className="mt-0.5 text-[12px] leading-5" style={{ color: "#A1A1AA" }}>
                      {body}
                    </p>
                  </div>
                </article>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => navigate("/lanes")}
                className="inline-flex h-9 items-center gap-2 rounded-md px-4 font-mono text-[10px] font-bold uppercase tracking-[1px] transition-all duration-100 active:scale-[0.97]"
                style={{ background: "#A78BFA", color: "#0F0D14" }}
              >
                Open Lanes
                <ArrowRight size={13} weight="bold" />
              </button>
              <span className="text-[11px]" style={{ color: "#71717A" }}>
                Lanes still run locally on your host while the VM path bakes.
              </span>
            </div>
          </section>

          <section className="flex flex-col items-center gap-5">
            <div
              className="relative flex w-full max-w-[360px] flex-col items-center gap-5 rounded-xl px-8 py-8"
              style={{
                background:
                  "radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, #A78BFA 8%, transparent) 0%, #13101A 60%)",
                border: "1px solid #1E1B26",
              }}
            >
              <div
                className="pointer-events-none absolute inset-x-8 top-0 h-px"
                style={{
                  background:
                    "linear-gradient(90deg, transparent 0%, color-mix(in srgb, #A78BFA 65%, transparent) 50%, transparent 100%)",
                }}
              />
              <MacMiniGlyph width={148} height={100} />
              <dl className="grid w-full grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-[11px]">
                <dt
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{ color: "#71717A" }}
                >
                  Host
                </dt>
                <dd className="text-right" style={{ color: "#D4D4D8" }}>
                  Apple silicon · Lume
                </dd>
                <dt
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{ color: "#71717A" }}
                >
                  Guest
                </dt>
                <dd className="text-right" style={{ color: "#D4D4D8" }}>
                  macOS Sequoia + agent runtime
                </dd>
                <dt
                  className="font-mono font-bold uppercase tracking-[1px]"
                  style={{ color: "#71717A" }}
                >
                  Status
                </dt>
                <dd className="text-right font-semibold" style={{ color: "#A78BFA" }}>
                  Staged for next release
                </dd>
              </dl>
            </div>
            <p
              className="max-w-[34ch] text-center text-[11px] leading-5"
              style={{ color: "#71717A" }}
            >
              Available in dev builds today. We&rsquo;ll flip this tab on for everyone once the
              setup flow survives a fresh-machine run end-to-end.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
