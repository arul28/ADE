import React from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./components/app/App";
import { RendererErrorBoundary } from "./components/app/RendererErrorBoundary";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RendererErrorBoundary>
      <App />
    </RendererErrorBoundary>
  </React.StrictMode>
);
