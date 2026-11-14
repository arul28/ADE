import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Hero } from "../../components/home/Hero";
import { AgentsSection } from "../../components/home/AgentsSection";
import { ToolsSection } from "../../components/home/ToolsSection";
import { FeatureWall } from "../../components/home/FeatureWall";
import { CloudSection } from "../../components/home/CloudSection";
import { DownloadSection } from "../../components/home/DownloadSection";

/**
 * The home page says two things. ADE runs every agent on your own machines,
 * with full control of them: the hero's live demo, every agent and model,
 * the tools agents check their work with, and everything else built in. And
 * ADE Cloud adds cloud computers for next to nothing. Then the download.
 */
export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      <div className="overflow-x-clip bg-[color:var(--color-bg)] text-white">
        <Hero />
        <AgentsSection />
        <ToolsSection />
        <FeatureWall />
        <CloudSection />
        <DownloadSection />
      </div>
    </Page>
  );
}
