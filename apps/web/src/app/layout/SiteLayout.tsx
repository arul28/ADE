import type { ReactNode } from "react";
import { SiteHeader } from "../../components/SiteHeader";
import { SiteFooter } from "../../components/SiteFooter";

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <a
        className="focus-ring absolute left-3 top-3 z-50 rounded-md bg-card px-3 py-2 text-sm text-fg shadow-glass-sm opacity-0 transition-opacity focus:opacity-100"
        href="#main"
      >
        Skip to content
      </a>
      <SiteHeader />
      <main id="main" className="min-h-[calc(100vh-240px)]">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}

