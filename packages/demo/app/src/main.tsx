import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./app.css";

const container = document.getElementById("root");
if (!container) throw new Error("DataDesk: #root is missing from index.html");
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
