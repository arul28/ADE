import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SiteNav } from "../../components/home/SiteNav";
import { SiteFooter } from "../../components/SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // /_og is a bare 1200×630 card for screenshotting, and /open is a hand-off
  // screen that looks like the ADE app's own start screens. Both skip the
  // header and footer every other page shares.
  const bare = pathname === "/_og" || pathname === "/open";

  return (
    <div className="flex min-h-screen flex-col">
      {!bare && <SiteNav />}
      <main id="main" className="flex-1">
        {children}
      </main>
      {!bare && <SiteFooter />}
    </div>
  );
}
