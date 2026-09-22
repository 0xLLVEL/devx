import { Suspense, lazy } from "react";
import { Route, Routes, useLocation } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { useServiceEvents } from "@/lib/use-service-events";
import { DashboardPage } from "@/routes/dashboard";

/**
 * §102: the dashboard core loads with the shell; every management page is a
 * chunk of its own, fetched the first time it is opened. The shell renders
 * immediately (§101) and the page arrives behind §37's skeleton, so a cold
 * start never waits on the heaviest page in the app.
 *
 * Each import is wrapped because `React.lazy` reads `default` and the routes
 * export named components. The paths are written out rather than built from a
 * string: a computed specifier is exactly what stops a bundler splitting the
 * chunk, and the dashboard is left as a static import on purpose, since it is
 * the route the window opens on.
 */
const ProjectsPage = lazy(() =>
  import("@/routes/projects").then((module) => ({ default: module.ProjectsPage })),
);
const ComponentsPage = lazy(() =>
  import("@/routes/components").then((module) => ({ default: module.ComponentsPage })),
);
const ServicesPage = lazy(() =>
  import("@/routes/services").then((module) => ({ default: module.ServicesPage })),
);
const SitesPage = lazy(() =>
  import("@/routes/sites").then((module) => ({ default: module.SitesPage })),
);
const LogsPage = lazy(() =>
  import("@/routes/logs").then((module) => ({ default: module.LogsPage })),
);
const TerminalPage = lazy(() =>
  import("@/routes/terminal").then((module) => ({ default: module.TerminalPage })),
);
const SharePage = lazy(() =>
  import("@/routes/share").then((module) => ({ default: module.SharePage })),
);
const DatabasesPage = lazy(() =>
  import("@/routes/databases").then((module) => ({ default: module.DatabasesPage })),
);
const MailPage = lazy(() =>
  import("@/routes/mail").then((module) => ({ default: module.MailPage })),
);
const DiagnosticsPage = lazy(() =>
  import("@/routes/diagnostics").then((module) => ({ default: module.DiagnosticsPage })),
);
const SettingsPage = lazy(() =>
  import("@/routes/settings").then((module) => ({ default: module.SettingsPage })),
);
const TrayPopup = lazy(() =>
  import("@/components/tray-popup").then((module) => ({ default: module.TrayPopup })),
);

/** Route table for the DevX window. */
export function App() {
  // One app-wide subscription: service state changes refresh queries wherever
  // a page is looking at them.
  useServiceEvents();

  // The tray popup is a different window on route `/tray`: no shell, no
  // dashboard, just the compact menu. The subscription above stays mounted
  // and is harmless there.
  const location = useLocation();
  if (location.pathname === "/tray") {
    return (
      <Suspense fallback={null}>
        <TrayPopup />
      </Suspense>
    );
  }

  return (
    <AppShell>
      <Suspense fallback={<RouteSkeleton />}>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/components" element={<ComponentsPage />} />
          <Route path="/services" element={<ServicesPage />} />
          <Route path="/sites" element={<SitesPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/terminal" element={<TerminalPage />} />
          <Route path="/share" element={<SharePage />} />
          <Route path="/databases" element={<DatabasesPage />} />
          <Route path="/mail" element={<MailPage />} />
          <Route path="/diagnostics" element={<DiagnosticsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </Suspense>
    </AppShell>
  );
}

/** §101/§37: a page-shaped skeleton, not a spinner, while a chunk arrives. */
function RouteSkeleton() {
  return (
    <div className="space-y-4 p-5" role="status">
      <span className="sr-only">Loading this page…</span>
      <div className="h-6 w-56 animate-pulse rounded-sm bg-secondary" />
      <div className="h-4 w-80 animate-pulse rounded-sm bg-secondary" />
      <div className="h-48 animate-pulse rounded-md bg-secondary" />
    </div>
  );
}
