import React from "react";
import { createRoot } from "react-dom/client";
import { LiveApp } from "./LiveApp.jsx";
import "./live.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <LiveApp />
  </React.StrictMode>,
);
