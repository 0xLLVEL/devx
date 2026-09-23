import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsPage } from "@/routes/diagnostics";
import { doctorFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  doctorRun: vi.fn(),
  doctorFix: vi.fn(),
  appInfo: vi.fn(),
  pathsGet: vi.fn(),
  revealManagedDir: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const { doctorRun, doctorFix } = mocks;

const APP_INFO = {
  name: "DevX",
  version: "0.1.0",
  target: "x86_64-pc-windows-msvc",
  debug: false,
};

const PATHS = {
  config_dir: "C:\\Users\\dev\\AppData\\Roaming\\DevX",
  data_dir: "C:\\Users\\dev\\AppData\\Local\\DevX",
};

/** The page plus a stub for the Logs route, so "Open logs" can be observed. */
function renderDiagnostics() {
  return renderWithProviders(
    <Routes>
      <Route path="/diagnostics" element={<DiagnosticsPage />} />
      <Route path="/logs" element={<p>logs page</p>} />
    </Routes>,
    { route: "/diagnostics" },
  );
}

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.appInfo.mockResolvedValue(APP_INFO);
    mocks.pathsGet.mockResolvedValue(PATHS);
    mocks.revealManagedDir.mockResolvedValue(undefined);
  });

  it("lists every check with its status", async () => {
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();

    expect(await screen.findByText("WebView2 runtime")).toBeInTheDocument();
    expect(screen.getByText("version 152.0.4191.66")).toBeInTheDocument();
    expect(screen.getByText("Writable config directory")).toBeInTheDocument();
    expect(screen.getAllByText("Pass")).toHaveLength(3); // overall + two checks
  });

  it("shows the remedy for a failing check", async () => {
    doctorRun.mockResolvedValue(
      doctorFixture({
        status: "fail",
        checks: [
          {
            id: "webview2",
            title: "WebView2 runtime",
            status: "fail",
            detail: "not detected",
            remedy: "Install the Microsoft Edge WebView2 Runtime.",
            fix: null,
          },
        ],
      }),
    );

    renderDiagnostics();

    expect(await screen.findByText("not detected")).toBeInTheDocument();
    expect(
      screen.getByText("Install the Microsoft Edge WebView2 Runtime."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });

  it("re-runs the checks on request", async () => {
    const user = userEvent.setup();
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();
    await screen.findByText("WebView2 runtime");

    await user.click(screen.getByRole("button", { name: /re-run checks/i }));

    await waitFor(() => expect(doctorRun).toHaveBeenCalledTimes(2));
  });

  it("repairs a fixable check once the consequence is confirmed", async () => {
    const user = userEvent.setup();

    doctorRun.mockResolvedValue(
      doctorFixture({
        status: "fail",
        checks: [
          {
            id: "config",
            title: "Configuration file",
            status: "fail",
            detail: "config.toml: unexpected key",
            remedy: "Fix the file, or delete it to regenerate defaults.",
            fix: "config",
          },
        ],
      }),
    );
    doctorFix.mockResolvedValue(doctorFixture());

    renderDiagnostics();

    await user.click(await screen.findByRole("button", { name: /fix automatically/i }));

    // §35: the dialog states what happens to the existing file, and nothing
    // is written until the user agrees.
    expect(screen.getByText(/config\.toml\.broken/)).toBeInTheDocument();
    expect(doctorFix).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    await waitFor(() => expect(doctorFix).toHaveBeenCalledWith("config"));
  });

  it("leaves the configuration alone when the repair is cancelled", async () => {
    const user = userEvent.setup();

    doctorRun.mockResolvedValue(
      doctorFixture({
        status: "fail",
        checks: [
          {
            id: "config",
            title: "Configuration file",
            status: "fail",
            detail: "config.toml: unexpected key",
            remedy: "Fix the file, or delete it to regenerate defaults.",
            fix: "config",
          },
        ],
      }),
    );

    renderDiagnostics();

    await user.click(await screen.findByRole("button", { name: /fix automatically/i }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(doctorFix).not.toHaveBeenCalled();
    expect(screen.queryByText(/config\.toml\.broken/)).not.toBeInTheDocument();
  });

  it("reports an empty report as nothing to show, not as a perfect score (§121)", async () => {
    doctorRun.mockResolvedValue(doctorFixture({ checks: [] }));

    renderDiagnostics();

    expect(await screen.findByText("No check was reported.")).toBeInTheDocument();
    expect(screen.queryByText("All checks passed.")).not.toBeInTheDocument();
    expect(screen.queryByText(/0 passed/)).not.toBeInTheDocument();
  });

  it("offers a retry when the checks themselves cannot run (§39)", async () => {
    const user = userEvent.setup();
    doctorRun.mockRejectedValue(new Error("doctor unavailable"));

    renderDiagnostics();

    expect(await screen.findByText("Could not run the checks.")).toBeInTheDocument();
    expect(screen.getByText("doctor unavailable")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /try again/i }));

    await waitFor(() => expect(doctorRun).toHaveBeenCalledTimes(2));
  });

  it("reports the build and the directories the backend hands over (§109)", async () => {
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();

    expect(await screen.findByText("DevX 0.1.0")).toBeInTheDocument();
    expect(screen.getByText("release · x86_64-pc-windows-msvc")).toBeInTheDocument();
    // Scoped by title: the config path also shows up as a check's detail.
    expect(screen.getByTitle(PATHS.config_dir)).toBeInTheDocument();
    expect(screen.getByTitle(PATHS.data_dir)).toBeInTheDocument();
    // §109 asks for OS, shell and PATH too. This build exposes none of them,
    // and a guess would be worse than the gap.
    expect(screen.getByText("Not reported by this build")).toBeInTheDocument();
  });

  it("says so when the system information cannot be read", async () => {
    doctorRun.mockResolvedValue(doctorFixture());
    mocks.appInfo.mockRejectedValue(new Error("no app info"));

    renderDiagnostics();

    expect(await screen.findByText("no app info")).toBeInTheDocument();
  });

  it("copies a diagnostics summary and leaves environment values out of it (§109)", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();
    await user.click(await screen.findByRole("button", { name: /copy diagnostics/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const payload = writeText.mock.calls[0]![0] as string;

    expect(payload).toContain("DevX 0.1.0");
    expect(payload).toContain("x86_64-pc-windows-msvc");
    expect(payload).toContain(PATHS.config_dir);
    expect(payload).toContain("[pass] WebView2 runtime: version 152.0.4191.66");
    expect(payload).toContain("2 passed, 0 warnings, 0 failing");

    // The hard §109 rule: nothing that came out of the environment.
    expect(payload).not.toContain("SECRET-PATH-VALUE");
    expect(payload).not.toMatch(/\bPATH=/);
  });

  it("opens the Logs page from the diagnostics actions", async () => {
    const user = userEvent.setup();
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();
    await screen.findByText("System");

    await user.click(screen.getByRole("button", { name: /open logs/i }));

    expect(await screen.findByText("logs page")).toBeInTheDocument();
  });

  it("opens the config folder through the backend", async () => {
    const user = userEvent.setup();
    doctorRun.mockResolvedValue(doctorFixture());

    renderDiagnostics();
    await screen.findByText("System");

    await user.click(screen.getByRole("button", { name: /open config folder/i }));

    await waitFor(() =>
      expect(mocks.revealManagedDir).toHaveBeenCalledWith(PATHS.config_dir),
    );
  });
});
