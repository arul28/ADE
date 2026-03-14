import type { ReactNode } from "react";

export function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen">
      <main id="main" className="min-h-[100vh]">
        {children}
      </main>
    </div>
  );
}

