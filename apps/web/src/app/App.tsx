import { BrowserRouter } from "react-router-dom";
import { SiteLayout } from "./layout/SiteLayout";
import { SiteRoutes } from "./SiteRoutes";

export function App() {
  return (
    <BrowserRouter>
      <SiteLayout>
        <SiteRoutes />
      </SiteLayout>
    </BrowserRouter>
  );
}
