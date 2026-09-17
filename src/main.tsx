import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { getRouter } from "./router";
import "./styles.css";

const el = document.getElementById("app");
if (!el) throw new Error("Missing #app");

createRoot(el).render(
  <StrictMode>
    <RouterProvider router={getRouter()} />
  </StrictMode>,
);
