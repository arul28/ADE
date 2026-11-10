import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SiteFooter } from "../../components/SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // HomePage renders its own editorial Masthead, /_og is a bare 1200×630 card
  // for screenshotting, and /open is a hand-off screen that looks like the ADE
  // app's own start screens. All three skip the global chrome.
  const bare = pathname === "/" || pathname === "/_og" || pathname === "/open";

  return (
    <div className="flex min-h-screen flex-col">
      {!bare && <SiteHeader />}
      <main id="main" className="flex-1">
        {children}
      </main>
      {!bare && <SiteFooter />}
    </div>
  );
}
