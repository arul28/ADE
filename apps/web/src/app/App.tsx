import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { SiteLayout } from "./layout/SiteLayout";
import { SiteRoutes } from "./SiteRoutes";
import { pageTransition } from "../lib/motion";
import { MarketingAnalyticsBridge } from "../components/MarketingAnalyticsBridge";
import { InstallDialogProvider } from "../components/install/InstallDialogProvider";

export function App() {
  return (
    <MotionConfig reducedMotion="user" transition={pageTransition}>
      <BrowserRouter>
        <MarketingAnalyticsBridge />
        <InstallDialogProvider>
          <SiteLayout>
            <SiteRoutes />
          </SiteLayout>
        </InstallDialogProvider>
      </BrowserRouter>
    </MotionConfig>
  );
}
