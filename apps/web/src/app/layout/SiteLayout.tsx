import type { ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { SiteHeader } from "../../components/SiteHeader";
import { SiteFooter } from "../../components/SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  // HomePage renders its own editorial Masthead + BackCover, so skip the
  // global chrome there.
  const isHome = pathname === "/";

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
