import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DiagnosticsPage } from "@/routes/diagnostics";
import { doctorFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const doctorRun = vi.hoisted(() => vi.fn());
const doctorFix = vi.hoisted(() => vi.fn());

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: { doctorRun, doctorFix } };
});

describe("DiagnosticsPage", () => {
  beforeEach(() => {
    doctorRun.mockReset();
    doctorFix.mockReset();
  });

  it("lists every check with its status", async () => {
    doctorRun.mockResolvedValue(doctorFixture());

    renderWithProviders(<DiagnosticsPage />);

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

    renderWithProviders(<DiagnosticsPage />);

    expect(await screen.findByText("not detected")).toBeInTheDocument();
    expect(
      screen.getByText("Install the Microsoft Edge WebView2 Runtime."),
    ).toBeInTheDocument();
    expect(screen.getAllByText("Failed")).toHaveLength(2);
  });

  it("re-runs the checks on request", async () => {
    const user = userEvent.setup();
    doctorRun.mockResolvedValue(doctorFixture());

    renderWithProviders(<DiagnosticsPage />);
    await screen.findByText("WebView2 runtime");

    await user.click(screen.getByRole("button", { name: /re-run checks/i }));

    await waitFor(() => expect(doctorRun).toHaveBeenCalledTimes(2));
  });

  it("repairs a fixable check and refreshes the report", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);

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

    renderWithProviders(<DiagnosticsPage />);

    await user.click(await screen.findByRole("button", { name: /fix automatically/i }));

    await waitFor(() => expect(doctorFix).toHaveBeenCalledWith("config"));
    expect(confirm).toHaveBeenCalled();
    confirm.mockRestore();
  });
});
