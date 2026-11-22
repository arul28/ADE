import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Hero } from "../../components/home/Hero";
import { CloudSection } from "../../components/home/CloudSection";
import { ToolsSection } from "../../components/home/ToolsSection";
import { AgentsSection } from "../../components/home/AgentsSection";
import { FeatureWall } from "../../components/home/FeatureWall";
import { DownloadSection } from "../../components/home/DownloadSection";

/**
 * The home page leads with ADE Cloud and what it costs next to everyone
 * else's cloud, then everything agents can reach on any computer, yours or
 * a cloud one (phones, desktops, browsers, apps, PRs, agent teams), every
 * agent and model, and everything else built in. Then the download.
 */
export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      <div className="overflow-x-clip bg-[color:var(--color-bg)] text-white">
        <Hero />
        <CloudSection />
        <ToolsSection />
        <AgentsSection />
        <FeatureWall />
        <DownloadSection />
      </div>
    </Page>
  );
}
