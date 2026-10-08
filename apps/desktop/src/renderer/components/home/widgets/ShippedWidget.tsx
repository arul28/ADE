import { useMemo, useState } from "react";
import { Copy, DownloadSimple, GitMerge, RocketLaunch, ShareNetwork } from "@phosphor-icons/react";
import { WelcomeCardHead } from "../../projects/ProjectWelcomeSidePanels";
import { formatCompact } from "../../../lib/format";
import { useAccountStatus } from "../../../lib/account";
import { localDayKey } from "../../usage/ActivityHeatmap";
import { useActivityStore } from "../../../state/activityStore";
import { Dialog } from "../../ui/dialog";
import { showToast } from "../../app/toast/toastStore";
import { useHomeData } from "../homeData";
import { useWidgetPreview, useWidgetSpan } from "../HomeWidgetGrid";
import type { HomeWidgetProps } from "../homeWidgetRegistry";
import { FitList } from "../HomeFitList";
import { drawShippedShareCard, type ShippedShareData } from "./shippedShareCard";
import "../homeWidgets.css";

/**
 * What you shipped since Monday: PRs merged across projects (the open
 * project's PR snapshot plus merges the Activity stream reported from every
 * project and machine), and chats, commits and lines changed on this machine
 * (the usage stats). A merges-per-day strip and the repos you merged into.
 * Share renders the same numbers to a PNG to copy or save. No reads of its own.
 */

function startOfWeek(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  // Monday-start week: Sunday counts as the end of the previous week.
  const offset = (start.getDay() + 6) % 7;
  start.setDate(start.getDate() - offset);
  return start;
}

type Merge = { key: string; title: string; number: number | null; repo: string; at: number; open?: () => void };

export default function ShippedWidget({ item }: HomeWidgetProps) {
  const { stats, prs, openPrs } = useHomeData();
  const preview = useWidgetPreview();
  const span = useWidgetSpan(item);
  const itemsById = useActivityStore((state) => state.itemsById);
  const { status } = useAccountStatus();
  const weekStart = useMemo(() => startOfWeek(new Date()), []);
  const weekKey = localDayKey(weekStart);
  const [share, setShare] = useState<{ url: string; data: ShippedShareData } | null>(null);
  const [drawing, setDrawing] = useState(false);

  // Every merge this week, once: the snapshot's copy and Activity's copy of
  // the same PR share a repo#number key.
  const merges = useMemo((): Merge[] => {
    const byKey = new Map<string, Merge>();
    const since = weekStart.getTime();
    for (const pr of prs.recent) {
      const at = Date.parse(pr.mergedAt ?? "");
      if (!Number.isFinite(at) || at < since) continue;
      const repo = pr.repo.split("/").at(-1) ?? pr.repo;
      byKey.set(`${repo.toLowerCase()}#${pr.number}`, { key: pr.id, title: pr.title, number: pr.number, repo, at, open: openPrs });
    }
    for (const entry of Object.values(itemsById)) {
      if (entry.kind !== "pull_request" || entry.phase !== "merged" || entry.dismissedAt) continue;
      const at = Date.parse(entry.statusSince ?? entry.updatedAt);
      if (!Number.isFinite(at) || at < since) continue;
      const destination = entry.destination.kind === "pull_request" ? entry.destination : null;
      const repo = destination?.repoName ?? entry.project.name;
      const key = `${repo.toLowerCase()}#${destination?.number ?? entry.id}`;
      if (!byKey.has(key)) byKey.set(key, { key: entry.id, title: entry.preview?.trim() || entry.title, number: destination?.number ?? null, repo, at });
    }
    return [...byKey.values()].sort((a, b) => b.at - a.at);
  }, [itemsById, openPrs, prs.recent, weekStart]);

  const local = useMemo(() => {
    if (!stats || stats === "unavailable") return null;
    const week = stats.daily.filter((point) => point.date >= weekKey);
    return {
      chats: week.reduce((sum, point) => sum + point.sessions, 0),
      commits: week.reduce((sum, point) => sum + point.commits, 0),
      insertions: week.reduce((sum, point) => sum + point.insertions, 0),
      deletions: week.reduce((sum, point) => sum + point.deletions, 0),
    };
  }, [stats, weekKey]);

  const perDay = useMemo(() => {
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (const merge of merges) counts[(new Date(merge.at).getDay() + 6) % 7]! += 1;
    return counts;
  }, [merges]);
  const todayIndex = (new Date().getDay() + 6) % 7;
  const topRepos = useMemo(() => {
    const counts = new Map<string, number>();
    for (const merge of merges) counts.set(merge.repo, (counts.get(merge.repo) ?? 0) + 1);
    return [...counts.entries()].map(([name, merged]) => ({ name, merged })).sort((a, b) => b.merged - a.merged);
  }, [merges]);
  const weekLabel = `${weekStart.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${new Date(weekStart.getTime() + 6 * 86_400_000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
  const roomy = span.w >= 2 || span.h >= 2;
  const max = Math.max(1, ...perDay);

  const openShare = async () => {
    const data: ShippedShareData = {
      weekLabel,
      merged: merges.length,
      commits: local?.commits ?? null,
      chats: local?.chats ?? null,
      insertions: local?.insertions ?? null,
      deletions: local?.deletions ?? null,
      perDay,
      topRepos,
      userName: status.signedIn ? status.name?.trim() || null : null,
    };
    setDrawing(true);
    try {
      setShare({ url: await drawShippedShareCard(data), data });
    } catch (error) {
      showToast({ tone: "error", title: "Couldn't draw the card", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setDrawing(false);
    }
  };
  const renderMerge = (merge: Merge) => (
    <button key={merge.key} type="button" role="listitem" className="kit-row ade-shipped-row" onClick={merge.open ?? openPrs} title={merge.title}>
      <GitMerge size={13} weight="bold" className="ade-shipped-icon" aria-hidden />
      <span className="ade-shipped-title">{merge.title}</span>
      <span className="kit-num ade-shipped-num">{merge.repo}{merge.number != null ? ` #${merge.number}` : ""}</span>
    </button>
  );
  const shareBridge = window.ade?.home?.share;
  const fileName = `ade-shipped-${localDayKey(weekStart)}.png`;

  return (
    <section className="kit-card ade-home-card ade-shipped" aria-label="Shipped this week" data-size={item.size} data-roomy={roomy || undefined}>
      <WelcomeCardHead icon={RocketLaunch} title="Shipped this week" action={openPrs ? { label: "PRs", onClick: openPrs } : null}>
        <span className="ade-home-card-scope">{weekLabel}</span>
        {!preview ? (
          <button type="button" className="kit-icon-btn ade-shipped-share" title="Share as an image" aria-label="Share Shipped this week as an image" disabled={drawing} onClick={() => void openShare()}>
            <ShareNetwork size={13} />
          </button>
        ) : null}
      </WelcomeCardHead>
      <div className="kit-card-body ade-shipped-body">
        <dl className="ade-shipped-stats">
          <div>
            <dd className="kit-num">{merges.length}</dd>
            <dt>PRs merged</dt>
          </div>
          <div><dd className="kit-num">{local ? formatCompact(local.commits) : "—"}</dd><dt>commits</dt></div>
          <div><dd className="kit-num">{local ? formatCompact(local.chats) : "—"}</dd><dt>chats</dt></div>
          {span.w >= 2 ? (
            <div>
              <dd className="kit-num ade-shipped-lines">
                {local ? <><i>+{formatCompact(local.insertions)}</i> <b>−{formatCompact(local.deletions)}</b></> : "—"}
              </dd>
              <dt>lines</dt>
            </div>
          ) : null}
        </dl>
        <div className="ade-shipped-week" role="img" aria-label={`Merges per day: ${perDay.join(", ")}`}>
          {perDay.map((count, index) => (
            <div key={index} className="ade-shipped-day" data-today={index === todayIndex || undefined} data-future={index > todayIndex || undefined}>
              <div className="ade-shipped-day-track">
                <i style={{ height: `${count === 0 ? 0 : Math.max(10, (count / max) * 100)}%` }} />
              </div>
              <span className="kit-num">{count > 0 ? count : ""}</span>
              <span>{"MTWTFSS"[index]}</span>
            </div>
          ))}
        </div>
        {topRepos.length > 0 ? (
          <div className="ade-shipped-repos" aria-label="Repos merged into">
            {topRepos.slice(0, roomy ? 6 : 3).map((repo) => (
              <span key={repo.name} className="ade-shipped-repo"><GitMerge size={11} weight="bold" aria-hidden />{repo.name}<b className="kit-num">{repo.merged}</b></span>
            ))}
          </div>
        ) : (
          <div className="ade-shipped-none">{prs.loaded ? "No merges yet this week." : "Reading pull requests…"}</div>
        )}
        {roomy && span.h >= 2 && merges.length > 0 ? (
          <FitList
            className="ade-shipped-list"
            more={openPrs ? { onMore: openPrs } : { dialog: { title: "Merged this week", render: () => merges.map(renderMerge) } }}
          >
            {merges.map(renderMerge)}
          </FitList>
        ) : null}
      </div>
      {share ? (
        <Dialog
          open
          onOpenChange={(open) => (open ? null : setShare(null))}
          title="Share Shipped this week"
          description="An image of this week's numbers. Nothing is uploaded."
          width={720}
          footer={(
            <div className="ade-shipped-share-actions">
              <button
                type="button"
                className="kit-btn"
                disabled={!shareBridge}
                onClick={() => {
                  void shareBridge?.saveImage({ pngDataUrl: share.url, fileName }).then((result) => {
                    if (result.ok) showToast({ tone: "success", title: "Image saved", message: result.path, durationMs: 3000 });
                    else if (!result.canceled) showToast({ tone: "error", title: "Couldn't save the image", message: result.error });
                  });
                }}
              >
                <DownloadSimple size={13} aria-hidden /> Save as…
              </button>
              <button
                type="button"
                className="kit-btn kit-btn-primary"
                onClick={() => {
                  const copy = shareBridge
                    ? shareBridge.copyImage(share.url)
                    : fetch(share.url).then((response) => response.blob()).then((blob) => navigator.clipboard.write([new ClipboardItem({ "image/png": blob })])).then(() => ({ ok: true as const }));
                  void copy.then((result) => {
                    if (result.ok) showToast({ id: "home-shipped-copied", tone: "success", title: "Image copied", durationMs: 1800 });
                    else showToast({ tone: "error", title: "Couldn't copy the image" });
                  }).catch(() => showToast({ tone: "error", title: "Couldn't copy the image" }));
                }}
              >
                <Copy size={13} aria-hidden /> Copy image
              </button>
            </div>
          )}
        >
          <img className="ade-shipped-share-preview" src={share.url} alt={`Shipped this week: ${share.data.merged} PRs merged`} />
        </Dialog>
      ) : null}
    </section>
  );
}
