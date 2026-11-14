import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { Hero } from "../../components/home/Hero";
import { StorySection } from "../../components/home/StorySection";
import { CloudNight } from "../../components/home/CloudNight";
import { ToolsSection } from "../../components/home/ToolsSection";
import { FeatureWall } from "../../components/home/FeatureWall";
import { DownloadSection } from "../../components/home/DownloadSection";

/**
 * The home page, in the order a visitor needs it: one app for every agent,
 * the agents working together, ADE Cloud and its free hours, the tools agents
 * check their work with, the best of everything else, and the download.
 */
export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      <div className="overflow-x-clip bg-[color:var(--color-bg)] text-white">
        <Hero />
        <StorySection />
        <CloudNight />
        <ToolsSection />
        <FeatureWall />
        <DownloadSection />
      </div>
    </Page>
  );
}
