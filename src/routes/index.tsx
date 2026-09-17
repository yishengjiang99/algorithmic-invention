import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { CoreApp } from "@/components/core/core-app";
import { InventionApp } from "@/components/invention/invention-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  const [view, setView] = useState<"invention" | "lab">("invention");
  if (view === "lab") return <CoreApp onBack={() => setView("invention")} />;
  return <InventionApp onLab={() => setView("lab")} />;
}
