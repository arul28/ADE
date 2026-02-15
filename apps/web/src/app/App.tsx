import { BrowserRouter } from "react-router-dom";
import { MotionConfig } from "framer-motion";
import { SiteLayout } from "./layout/SiteLayout";
import { SiteRoutes } from "./SiteRoutes";
import { pageTransition } from "../lib/motion";

export function App() {
  return (
    <MotionConfig reducedMotion="user" transition={pageTransition}>
      <BrowserRouter>
        <SiteLayout>
          <SiteRoutes />
        </SiteLayout>
      </BrowserRouter>
    </MotionConfig>
  );
}
