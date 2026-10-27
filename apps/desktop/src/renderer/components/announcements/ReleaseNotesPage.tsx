import { Fragment, type ReactNode } from "react";
import {
  AppleLogo,
  ArrowSquareOut,
  ArrowsClockwise,
  Bug,
  Circle,
  DeviceMobile,
  Lightning,
  Sparkle,
  TrendUp,
  WindowsLogo,
} from "@phosphor-icons/react";
import type { UpdateInterruptedChat } from "../../../shared/types";
import { ADE_GITHUB_URL } from "../../../shared/productLinks";
import type { ReleaseNotesDigest } from "./releaseNotesDigest";
import "./releaseNotesPage.css";

/**
 * "And more": the last page after an update. The release notes for every
 * version since the one the user came from, one list per section, plus the
 * chats the update set to continue. The notes are written by the release
 * skill; any `## Section` shows, and the common ones get their own mark.
 */

type Tone = "new" | "improved" | "fixed" | "plain";

function sectionLook(title: string): { icon: ReactNode; tone: Tone } {
  const key = title.toLowerCase();
  if (key === "new") return { icon: <Sparkle size={13} weight="fill" />, tone: "new" };
  if (key === "improved") return { icon: <TrendUp size={13} weight="bold" />, tone: "improved" };
  if (key === "fixed") return { icon: <Bug size={13} weight="fill" />, tone: "fixed" };
  if (/^(ios|iphone|ipad)$/.test(key)) return { icon: <DeviceMobile size={13} weight="fill" />, tone: "plain" };
  if (key === "windows") return { icon: <WindowsLogo size={13} weight="fill" />, tone: "plain" };
  if (/^(macos|mac)$/.test(key)) return { icon: <AppleLogo size={13} weight="fill" />, tone: "plain" };
  if (/speed|performance|faster/.test(key)) return { icon: <Lightning size={13} weight="fill" />, tone: "plain" };
  return { icon: <Circle size={7} weight="fill" />, tone: "plain" };
}

function openLink(url: string): void {
  void window.ade.app.openExternal(url);
}

const PR_GROUP = /\s*\(#\d+(?:\s*,\s*#\d+)*\)/g;

/** A bullet's text with its "(#123)" references taken out, and the PR numbers in order. */
function splitPrs(text: string): { text: string; prs: string[] } {
  const prs: string[] = [];
  const stripped = text.replace(PR_GROUP, (group) => {
    for (const number of group.match(/\d+/g) ?? []) if (!prs.includes(number)) prs.push(number);
    return "";
  });
  return { text: stripped.replace(/\s+([.,;:])/g, "$1").trim(), prs };
}

/** A bullet's inline markdown: `code`, **bold** and [links](…). */
function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const pattern = /`([^`]+)`|\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > last) out.push(text.slice(last, match.index));
    const key = `${match.index}`;
    if (match[1] != null) {
      out.push(<code key={key}>{match[1]}</code>);
    } else if (match[2] != null) {
      out.push(<strong key={key}>{match[2]}</strong>);
    } else {
      const href = match[4]!;
      out.push(/^https?:/.test(href)
        ? <a key={key} href={href} onClick={(event) => { event.preventDefault(); openLink(href); }}>{match[3]}</a>
        : <Fragment key={key}>{match[3]}</Fragment>);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One release-note bullet: its sentence, then its PRs as quiet chips. */
function NoteItem({ item }: { item: string }) {
  const { text, prs } = splitPrs(item);
  return (
    <li>
      {renderInline(text)}
      {prs.length > 0 ? (
        <span className="ade-rn-prs">
          {prs.map((number) => (
            <a
              key={number}
              className="ade-rn-pr"
              href={`${ADE_GITHUB_URL}/pull/${number}`}
              onClick={(event) => { event.preventDefault(); openLink(`${ADE_GITHUB_URL}/pull/${number}`); }}
            >
              #{number}
            </a>
          ))}
        </span>
      ) : null}
    </li>
  );
}

export function ReleaseNotesPage({
  notes,
  resumedChats = [],
  changelogUrl,
  githubReleaseUrl,
}: {
  notes: ReleaseNotesDigest | null;
  resumedChats?: readonly UpdateInterruptedChat[];
  changelogUrl?: string | null;
  githubReleaseUrl?: string | null;
}) {
  const many = Boolean(notes && notes.versionCount > 1 && notes.fromVersion);
  const headline = !notes
    ? "ADE is up to date."
    : many
      ? `And more since ${notes.fromVersion}.`
      : `And more in ${notes.version}.`;
  const lead = !notes
    ? "The release notes for this version are on the changelog."
    : many
      ? `Everything from the last ${notes.versionCount} updates, in one list.`
      : notes.summary;

  return (
    <article className="ade-rn">
      <header className="ade-rn-head">
        <h2 className="ade-rn-headline">{headline}</h2>
        {lead ? <p className="ade-rn-lead">{lead}</p> : null}
      </header>

      <div className="ade-rn-scroll">
        {resumedChats.length > 0 ? (
          <section className="ade-rn-resumed" aria-label="Chats that continue">
            <ArrowsClockwise size={14} weight="bold" aria-hidden />
            <div>
              <p className="ade-rn-resumed-title">
                {resumedChats.length === 1 ? "1 chat picks up where it stopped" : `${resumedChats.length} chats pick up where they stopped`}
              </p>
              <p className="ade-rn-resumed-names">{resumedChats.map((chat) => chat.title).join(" · ")}</p>
            </div>
          </section>
        ) : null}

        {notes ? (
          <div className="ade-rn-sections">
            {notes.sections.map((section) => {
              const look = sectionLook(section.title);
              return (
                <section key={section.title} className="ade-rn-section" data-tone={look.tone}>
                  <h3 className="ade-rn-section-head">
                    <span className="ade-rn-section-mark" aria-hidden>{look.icon}</span>
                    {section.title}
                    <span className="ade-rn-section-count">{section.items.length}</span>
                  </h3>
                  <ul className="ade-rn-items">
                    {section.items.map((item, index) => (
                      <NoteItem key={`${index}:${item.slice(0, 40)}`} item={item} />
                    ))}
                  </ul>
                </section>
              );
            })}
          </div>
        ) : null}

        {notes?.truncated ? (
          <p className="ade-rn-more">Older updates you skipped are in the full changelog.</p>
        ) : null}
      </div>

      {changelogUrl || githubReleaseUrl ? (
        <div className="ade-rn-links">
          {changelogUrl ? (
            <button type="button" className="kit-btn kit-btn-ghost" onClick={() => openLink(changelogUrl)}>
              Full changelog
              <ArrowSquareOut size={12} weight="bold" aria-hidden />
            </button>
          ) : null}
          {githubReleaseUrl ? (
            <button type="button" className="kit-btn kit-btn-ghost" onClick={() => openLink(githubReleaseUrl)}>
              GitHub release
              <ArrowSquareOut size={12} weight="bold" aria-hidden />
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}
