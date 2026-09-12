import { Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { ComponentsPage } from "@/routes/components";
import { DatabasesPage } from "@/routes/databases";
import { DashboardPage } from "@/routes/dashboard";
import { DiagnosticsPage } from "@/routes/diagnostics";
import { MailPage } from "@/routes/mail";
import { ServicesPage } from "@/routes/services";
import { SharePage } from "@/routes/share";
import { SitesPage } from "@/routes/sites";
import { SettingsPage } from "@/routes/settings";

/** Route table for the DevX window. */
export function App() {
  return (
    <AppShell>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/components" element={<ComponentsPage />} />
        <Route path="/services" element={<ServicesPage />} />
        <Route path="/sites" element={<SitesPage />} />
        <Route path="/share" element={<SharePage />} />
        <Route path="/databases" element={<DatabasesPage />} />
        <Route path="/mail" element={<MailPage />} />
        <Route path="/diagnostics" element={<DiagnosticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
    </AppShell>
  );
}
