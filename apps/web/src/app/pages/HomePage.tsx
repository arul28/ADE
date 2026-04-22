import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Masthead } from "../../components/editorial/Masthead";
import { CompetitorEquation } from "../../components/editorial/CompetitorEquation";
import { Lede } from "../../components/editorial/Lede";
import { DeviceComposition } from "../../components/editorial/DeviceComposition";
import { FadeBand } from "../../components/editorial/FadeBand";
import {
  Chapter,
  ChapterBody,
  Byline,
} from "../../components/editorial/Chapter";
import { ChapterHeadline } from "../../components/editorial/ChapterHeadline";
import { Cutout } from "../../components/editorial/Cutout";
import { PullQuote } from "../../components/editorial/PullQuote";
import { IPhoneFrame } from "../../components/editorial/IPhoneFrame";
import { FeatureGrid } from "../../components/editorial/FeatureGrid";
import { IndexPage } from "../../components/editorial/IndexPage";
import { BackCover } from "../../components/editorial/BackCover";

const MOBILE_BYLINE_DATE = "April 2026 · iOS 17+";

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      {/* ═══════ DARK COVER ═══════ */}
      <section className="relative overflow-hidden bg-[color:var(--color-bg)] text-[color:var(--color-cream)]">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(ellipse 70% 50% at 70% 45%, rgba(124,58,237,0.3) 0%, transparent 70%)",
              "radial-gradient(ellipse 45% 55% at 10% 0%, rgba(167,139,250,0.08) 0%, transparent 70%)",
              "radial-gradient(ellipse 40% 30% at 40% 90%, rgba(124,58,237,0.08) 0%, transparent 70%)",
            ].join(", "),
          }}
        />
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 opacity-[0.035]"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.7) 1px, transparent 1px)",
            backgroundSize: "22px 22px",
          }}
        />

        <Masthead />

        <div className="relative mx-auto max-w-[1240px] px-[clamp(20px,3vw,40px)]">
          <div className="border-b border-[color:var(--color-hairline)]">
            <CompetitorEquation />
          </div>

          <div className="grid grid-cols-1 items-center gap-[clamp(24px,3vw,48px)] py-[clamp(20px,3vw,40px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
            <Lede />
            <DeviceComposition />
          </div>

          <div className="flex items-center justify-center gap-3 border-t border-[color:var(--color-hairline)] py-[clamp(18px,2vw,26px)] text-[11px] uppercase tracking-[0.34em] text-[color:var(--color-cream-faint)]">
            Turn the page
            <span
              className="ade-turn-page-arrow font-serif italic text-[color:var(--color-violet-bright)]"
              style={{
                fontSize: "15px",
                animation: "nudge 2.4s ease-in-out infinite",
              }}
            >
              ↓
            </span>
            Chapter I · Lanes
            <style>{`
              @keyframes nudge {
                0%, 100% { transform: translateY(0); }
                50% { transform: translateY(4px); }
              }
              @media (prefers-reduced-motion: reduce) {
                .ade-turn-page-arrow { animation: none !important; }
              }
            `}</style>
          </div>
        </div>
      </section>

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ CHAPTER I — LANES ═══════ */}
      <Chapter
        chapterNumber="Chapter I"
        chapterTitle="Lanes"
        pageNumber="04"
        id="chapter-lanes"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
          <Cutout
            src="/images/screenshots/lanes.png"
            alt="ADE lanes — three parallel git worktrees on macOS"
            figNumber="Fig. 2"
            caption="Three lanes in parallel — each is its own git worktree. Switch in a click."
            rotate={0.4}
            tone="ink"
          />

          <div>
            <ChapterHeadline
              line1="Parallel work."
              line2="Isolated git."
              deck="Every lane is its own worktree. Edit, run, commit — many tasks at once, no collisions."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                Each lane is a fresh branch you can flip between in a click.
                Running tests in one doesn&rsquo;t block code in another. When
                a lane ships, commit it and move on.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;Three tasks at once. One git history. Zero
                collisions.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CHAPTER II — WORK ═══════ */}
      <Chapter
        chapterNumber="Chapter II"
        chapterTitle="Work"
        pageNumber="10"
        id="chapter-work"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
          <div>
            <ChapterHeadline
              line1="Agents that code."
              line2="While you watch."
              deck="Attach a prompt to a lane. Pick a model. Step through every edit as it happens."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                Work is where agents execute. You see every file change, every
                test run, every tool call &mdash; live. Approve the diff before
                it commits, or step in and steer.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;The diff is yours before it commits.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>

          <Cutout
            src="/images/screenshots/run.png"
            alt="ADE run view — an agent executing a task live"
            figNumber="Fig. 3"
            caption="An agent executing — tool calls, test output, and a diff ready for review."
            rotate={-0.5}
            tone="ink"
          />
        </div>
      </Chapter>

      {/* ═══════ CHAPTER III — PULL REQUESTS ═══════ */}
      <Chapter
        chapterNumber="Chapter III"
        chapterTitle="Pull Requests"
        pageNumber="16"
        id="chapter-prs"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-start">
          <Cutout
            src="/images/screenshots/prs.png"
            alt="ADE pull request review"
            figNumber="Fig. 4"
            caption="Pull requests — diff, CI status, and review comments on the same page as the lane."
            rotate={0.5}
            tone="ink"
          />

          <div>
            <ChapterHeadline
              line1="Review."
              line2="Without leaving the app."
              deck="Every PR an agent opens lands here — diff, tests, comments — attached to the lane it came from."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                No tab-hopping to GitHub. Read the diff, check CI, comment,
                approve, merge &mdash; all inside ADE, connected to the lane,
                the branch, and the model that wrote the code.
              </ChapterBody>
              <Byline tone="ink" />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CHAPTER IV — CTO ═══════ */}
      <Chapter
        chapterNumber="Chapter IV"
        chapterTitle="CTO"
        pageNumber="22"
        id="chapter-cto"
      >
        <div className="grid grid-cols-1 gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-start">
          <div>
            <ChapterHeadline
              line1="Your team of agents."
              line2="Organized."
              deck="A persistent org chart of worker agents — each with their own memory, budget, and Linear-synced responsibilities."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                The CTO dispatches work to the right agent, tracks what&rsquo;s
                in flight, pulls issues from Linear, and posts results back.
                It&rsquo;s the conductor that turns a pile of prompts into a
                shipping team.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;A team of agents, on payroll, on call.&rdquo;
              </PullQuote>
              <Byline tone="ink" />
            </div>
          </div>

          <Cutout
            src="/images/screenshots/cto.png"
            alt="ADE CTO — org chart of worker agents"
            figNumber="Fig. 5"
            caption="The CTO — an org chart of worker agents, each with its own memory and budget."
            rotate={-0.4}
            tone="ink"
          />
        </div>
      </Chapter>

      {/* ═══════ CHAPTER V — IN YOUR POCKET ═══════ */}
      <Chapter
        chapterNumber="Chapter V"
        chapterTitle="In Your Pocket"
        pageNumber="28"
        id="chapter-mobile"
      >
        <div className="grid grid-cols-1 items-center gap-[clamp(32px,4vw,56px)] lg:grid-cols-[minmax(0,6fr)_minmax(0,6fr)]">
          <div>
            <ChapterHeadline
              line1="The first AI coding tool"
              line2="that lives in your pocket."
              deck="Resume a lane from the train. Approve a PR from a café. Chat with your agents from bed."
              tone="ink"
            />
            <div className="mt-8">
              <ChapterBody dropCap>
                The desktop is where code gets written. The pocket is where
                decisions get made. ADE syncs both over cr-sqlite so a lane
                you started on macOS continues on iOS without a refresh.
              </ChapterBody>
              <PullQuote tone="ink">
                &ldquo;None of the eleven apps we replace have a mobile client.
                We built the one that does.&rdquo;
              </PullQuote>
              <Byline tone="ink" date={MOBILE_BYLINE_DATE} />
            </div>
          </div>

          <div className="relative flex justify-center lg:justify-end">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 -m-10"
              style={{
                background:
                  "radial-gradient(ellipse 55% 55% at 50% 50%, rgba(124,58,237,0.35) 0%, rgba(124,58,237,0.08) 45%, transparent 75%)",
                filter: "blur(14px)",
              }}
            />
            <div className="relative">
              <IPhoneFrame
                src="/images/screenshots/agent-chat.png"
                alt="ADE on iPhone"
                rotate={-2}
                width="w-[240px] sm:w-[260px]"
                figCaption={{
                  figNumber: "Fig. 6",
                  caption:
                    "A lane, synced from desktop — edit, approve, comment from anywhere.",
                  tone: "ink",
                }}
              />
            </div>
          </div>
        </div>
      </Chapter>

      {/* ═══════ CATALOG — the rest of the IDE ═══════ */}
      <FeatureGrid />

      {/* ═══════ FADE cream → dark ═══════ */}
      <FadeBand direction="to-dark" />

      {/* ═══════ BACK COVER ═══════ */}
      <BackCover />

      {/* ═══════ FADE dark → cream ═══════ */}
      <FadeBand direction="to-cream" />

      {/* ═══════ INDEX ═══════ */}
      <IndexPage />
    </Page>
  );
}
