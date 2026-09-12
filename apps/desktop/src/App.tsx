import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { useServiceEvents } from "@/lib/use-service-events";
import { ComponentsPage } from "@/routes/components";
import { DatabasesPage } from "@/routes/databases";
import { DashboardPage } from "@/routes/dashboard";
import { DiagnosticsPage } from "@/routes/diagnostics";
import { MailPage } from "@/routes/mail";
import { LogsPage } from "@/routes/logs";
import { ServicesPage } from "@/routes/services";
import { SharePage } from "@/routes/share";
import { SitesPage } from "@/routes/sites";
import { SettingsPage } from "@/routes/settings";
import { TerminalPage } from "@/routes/terminal";

/** Route table for the DevX window. */
export function App() {
  // One app-wide subscription: service state changes refresh queries wherever
  // a page is looking at them.
  useServiceEvents();

  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
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
    </AppShell>
  );
}
