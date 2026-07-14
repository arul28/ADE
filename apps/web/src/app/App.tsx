import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { SiteLayout } from "./layout/SiteLayout";
import { SiteRoutes } from "./SiteRoutes";
import { pageTransition } from "../lib/motion";
import { MarketingAnalyticsBridge } from "../components/MarketingAnalyticsBridge";

export function App() {
  return (
    <MotionConfig reducedMotion="user" transition={pageTransition}>
      <BrowserRouter>
        <MarketingAnalyticsBridge />
        <SiteLayout>
          <SiteRoutes />
        </SiteLayout>
      </BrowserRouter>
    </MotionConfig>
  );
}
