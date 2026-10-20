import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { Page } from "../../components/Page";

import { SiteNav } from "../../components/home/SiteNav";
import { Hero } from "../../components/home/Hero";
import { StorySection } from "../../components/home/StorySection";
import { ToolsSection } from "../../components/home/ToolsSection";
import { FeatureWall } from "../../components/home/FeatureWall";
import { DownloadSection } from "../../components/home/DownloadSection";

export function HomePage() {
  useDocumentTitle("ADE — Agentic Development Environment");

  return (
    <Page>
      <div className="overflow-x-clip bg-[color:var(--color-bg)] text-white">
        <SiteNav />
        <Hero />
        <StorySection />
        <ToolsSection />
        <FeatureWall />
        <DownloadSection />
      </div>
    </Page>
  );
}
