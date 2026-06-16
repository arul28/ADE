import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SiteFooter } from "../../components/SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // HomePage renders its own editorial Masthead, and /_og is a bare
  // 1200×630 card for screenshotting — both skip the global chrome.
  const isHome = pathname === "/" || pathname === "/_og";

  return (
    <div className="flex min-h-screen flex-col">
      {!isHome && <SiteHeader />}
      <main id="main" className="flex-1">
        {children}
      </main>
      {!isHome && <SiteFooter />}
    </div>
  );
}
