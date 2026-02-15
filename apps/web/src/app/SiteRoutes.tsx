import { useEffect } from "react";
import { Route, Routes, useLocation } from "react-router-dom";
import { AnimatePresence } from "framer-motion";
import { HomePage } from "./pages/HomePage";
import { DownloadPage } from "./pages/DownloadPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { TermsPage } from "./pages/TermsPage";
import { NotFoundPage } from "./pages/NotFoundPage";

function useScrollRestoration() {
  const location = useLocation();

  useEffect(() => {
    const { hash } = location;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ?? false;

    // Allow the new route to render first.
    requestAnimationFrame(() => {
      if (hash) {
        const id = decodeURIComponent(hash.replace(/^#/, ""));
        const el = document.getElementById(id);
        if (el) {
          el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
          return;
        }
      }

      window.scrollTo({ top: 0, left: 0, behavior: "auto" });
    });
  }, [location]);
}

export function SiteRoutes() {
  const location = useLocation();
  useScrollRestoration();

  return (
    <AnimatePresence mode="wait">
      <Routes location={location} key={location.pathname}>
        <Route path="/" element={<HomePage />} />
        <Route path="/download" element={<DownloadPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </AnimatePresence>
  );
}
