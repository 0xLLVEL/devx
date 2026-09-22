import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";

import { AppShell } from "@/components/app-shell";
import { ThemeProvider } from "@/components/theme-provider";
import { ToastProvider } from "@/components/ui/toast";
import { TerminalPage } from "@/routes/terminal";
import { configFixture } from "@/test/fixtures";

/**
 * The shell (§4, §5, §6) as an integration surface: the chrome, the keyboard
 * entry points, the layout state and the terminal's two homes are only
 * meaningful together, so they are tested here rather than one component at a
 * time.
 */

const mocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  pathsGet: vi.fn(),
  serviceMetrics: vi.fn(),
  siteList: vi.fn(),
  installedVersions: vi.fn(),
  dbListServers: vi.fn(),
  mailStatus: vi.fn(),
  appInfo: vi.fn(),
  eventsRecent: vi.fn(),
  notificationsList: vi.fn(),
  notificationsMarkAllRead: vi.fn(),
  notificationsClear: vi.fn(),
  servicesStartAll: vi.fn(),
  terminalPath: vi.fn(),
  terminalRun: vi.fn(),
  terminalUseVersion: vi.fn(),
  terminalUnsetVersion: vi.fn(),
  /** Listeners registered on the terminal's output stream. */
  terminalListeners: [] as ((event: { payload: unknown }) => void)[],
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return {
    ...actual,
    ipc: mocks,
    ipcEvents: {
      terminalOutput: {
        listen: (listener: { payload: unknown } & ((event: unknown) => void)) => {
          mocks.terminalListeners.push(
            listener as unknown as (event: { payload: unknown }) => void,
          );
          return Promise.resolve(() => {});
        },
      },
    },
  };
});

/** §98: an empty notification center, the shape every command returns. */
const EMPTY_NOTIFICATIONS = { entries: [], unread_count: 0, recorded: 0 };

function renderShell(route = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[route]}>
        <ThemeProvider>
          <ToastProvider>
            <AppShell>
              <Routes>
                <Route
                  path="/"
                  element={
                    <>
                      <p>dashboard page</p>
                      {/* Stands in for the terminal's command field. */}
                      <input aria-label="Terminal command" />
                    </>
                  }
                />
                <Route path="/sites" element={<p>sites page</p>} />
                <Route path="/services" element={<p>services page</p>} />
                <Route path="/terminal" element={<TerminalPage />} />
              </Routes>
            </AppShell>
          </ToastProvider>
        </ThemeProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("AppShell", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function") {
        mock.mockReset();
      }
    }
    mocks.terminalListeners.length = 0;
    mocks.configGet.mockResolvedValue(configFixture());
    mocks.pathsGet.mockResolvedValue({
      config_dir: "C:/config",
      data_dir: "C:/data",
    });
    mocks.serviceMetrics.mockResolvedValue([]);
    mocks.siteList.mockResolvedValue([]);
    mocks.installedVersions.mockResolvedValue([]);
    mocks.dbListServers.mockResolvedValue([]);
    mocks.mailStatus.mockResolvedValue({
      running: false,
      port: null,
      smtp_port: 1025,
      total: null,
      unread: null,
    });
    mocks.appInfo.mockResolvedValue({
      name: "DevX",
      version: "0.1.0",
      target: "x86_64-pc-windows-msvc",
      debug: false,
    });
    mocks.eventsRecent.mockResolvedValue([]);
    // §98: the bell reads its own count. Nothing recorded yet means no badge.
    mocks.notificationsList.mockResolvedValue(EMPTY_NOTIFICATIONS);
    mocks.servicesStartAll.mockResolvedValue([]);
    mocks.terminalPath.mockResolvedValue("C:\\devx\\bin");
    mocks.terminalRun.mockResolvedValue({ run_id: 1, code: 0 });
  });

  it("shows the page context, the search trigger and every existing route", async () => {
    renderShell();

    // §6: the topbar carries the DevX brand and version on every page,
    // plus the search trigger and its shortcut. The brand mark is static;
    // the version arrives with app-info, so it is awaited last — awaiting
    // first would let the metrics footer render and double the "Services"
    // link match below.
    const topbar = screen.getByRole("banner");
    expect(within(topbar).getByLabelText("DEVX")).toBeInTheDocument();
    expect(within(topbar).getByRole("button", { name: /search anything/i })).toHaveTextContent(
      "Ctrl K",
    );

    // §5: the sidebar only offers routes that exist.
    const sidebar = screen.getByRole("navigation");
    for (const label of [
      "Components",
      "Services",
      "Sites",
      "Databases",
      "Terminal",
      "Logs",
      "Share",
      "Mail",
      "Diagnostics",
      "Settings",
    ]) {
      expect(
        within(sidebar).getByRole("link", { name: new RegExp(label) }),
      ).toBeInTheDocument();
    }

    // The version rides the app-info query, so it lands after the static
    // brand mark above.
    expect(await within(topbar).findByText("v0.1.0")).toBeInTheDocument();
  });

  it("opens the command palette with Ctrl+K", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Control>}k{/Control}");

    expect(screen.getByRole("dialog", { name: /command palette/i })).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/type a command/i)).toHaveFocus();
  });

  it("leaves the shortcut alone while the user is typing", async () => {
    const user = userEvent.setup();
    renderShell();

    // §56: a shortcut must never fight a text field or the terminal.
    const field = screen.getByLabelText("Terminal command");
    await user.click(field);
    await user.type(field, "php artisan");
    await user.keyboard("{Control>}k{/Control}{Alt>}3{/Alt}");

    // Nothing was stolen: same focus, same page, and the keystrokes are text.
    expect(field).toHaveFocus();
    expect(field).toHaveValue("php artisan");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("dashboard page")).toBeInTheDocument();
  });

  it("navigates from the palette", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText(/type a command/i), "sites");
    await user.keyboard("{Enter}");

    expect(await screen.findByText("sites page")).toBeInTheDocument();
  });

  it("navigates with the §56 number shortcuts", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Alt>}3{/Alt}");

    expect(await screen.findByText("services page")).toBeInTheDocument();
  });

  it("starts every stopped service with Ctrl+Shift+S", async () => {
    const user = userEvent.setup();
    mocks.serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "stopped", cpu_percent: 0, memory_bytes: 0, processes: 0 },
      { id: "mariadb", state: "running", cpu_percent: 1, memory_bytes: 1024, processes: 1 },
    ]);
    renderShell();

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    expect(mocks.servicesStartAll).toHaveBeenCalledTimes(1);
  });

  it("says why Ctrl+Shift+S did nothing instead of looking broken", async () => {
    const user = userEvent.setup();
    mocks.serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "running", cpu_percent: 1, memory_bytes: 1024, processes: 1 },
    ]);
    renderShell();

    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    // §54: the key is always bound, so it reports rather than doing nothing.
    expect(mocks.servicesStartAll).not.toHaveBeenCalled();
    expect(await screen.findByText("Nothing to start")).toBeInTheDocument();
  });

  it("leaves Ctrl+Shift+S alone while the user is typing in the terminal", async () => {
    const user = userEvent.setup();
    mocks.serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "stopped", cpu_percent: 0, memory_bytes: 0, processes: 0 },
    ]);
    renderShell("/terminal");

    // §56: the terminal's command field is a text target, so no global key may
    // reach it. Ctrl+Shift+S is the newer binding, so it is checked here too.
    const command = await screen.findByLabelText("Command");
    await user.click(command);
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    expect(command).toHaveFocus();
    expect(mocks.servicesStartAll).not.toHaveBeenCalled();
  });

  it("leaves Ctrl+Shift+S alone while the working directory is focused", async () => {
    const user = userEvent.setup();
    mocks.serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "stopped", cpu_percent: 0, memory_bytes: 0, processes: 0 },
    ]);
    renderShell("/terminal");

    const cwd = await screen.findByLabelText("Working directory");
    await user.click(cwd);
    await user.keyboard("{Control>}{Shift>}s{/Shift}{/Control}");

    expect(cwd).toHaveFocus();
    expect(mocks.servicesStartAll).not.toHaveBeenCalled();
  });

  it("collapses the sidebar to icon width and remembers it", async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByRole("navigation")).toHaveStyle({ width: "200px" });
    expect(within(screen.getByRole("navigation")).getByText("Environment")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /collapse sidebar/i }));

    expect(screen.getByRole("navigation")).toHaveStyle({ width: "56px" });
    // §5: the collapsed rail keeps the routes, drops the section labels.
    expect(
      within(screen.getByRole("navigation")).queryByText("Environment"),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation")).getByRole("link", { name: "Diagnostics" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /expand sidebar/i })).toBeInTheDocument();
    expect(window.localStorage.getItem("devx.sidebar-collapsed")).toBe("1");
  });

  it("reads the system status and the notification badge from live metrics", async () => {
    mocks.serviceMetrics.mockResolvedValue([
      { id: "mariadb", state: "running", cpu_percent: 1, memory_bytes: 1024, processes: 1 },
      { id: "redis", state: "failed", cpu_percent: 0, memory_bytes: 0, processes: 0 },
    ]);
    renderShell();

    expect(await screen.findByText("System Error")).toBeInTheDocument();
    expect(screen.getByText("1 service failed.")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Notifications: 1 service failed/i }),
    ).toBeInTheDocument();
  });

  it("shows no count before the backend has answered", async () => {
    // Queries that never settle: the sidebar must not fill the gap with zeros.
    mocks.installedVersions.mockReturnValue(new Promise(() => {}));
    mocks.dbListServers.mockReturnValue(new Promise(() => {}));
    renderShell();

    await screen.findByText("dashboard page");
    expect(screen.queryByText("0")).not.toBeInTheDocument();
  });

  it("says the system status is unavailable instead of hiding it (§120 #10)", async () => {
    mocks.serviceMetrics.mockRejectedValue(new Error("metrics pipe closed"));
    renderShell();

    // A failed read must not look like a quiet machine: the footer stays, and
    // it says what happened and where to look.
    expect(await screen.findByText("Status unavailable")).toBeInTheDocument();
    expect(
      screen.getByText("The service metrics could not be read."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Status unavailable/i }),
    ).toHaveAttribute("href", "/diagnostics");
  });

  it("keeps the status footer absent while the first read is still in flight", async () => {
    mocks.serviceMetrics.mockReturnValue(new Promise(() => {}));
    renderShell();

    await screen.findByText("dashboard page");
    // Nothing to report yet is not the same as nothing could be read, and
    // neither one may be invented (§131 Rule 17).
    expect(screen.queryByText("Status unavailable")).not.toBeInTheDocument();
  });

  it("opens and closes the bottom terminal drawer from the topbar (§31)", async () => {
    const user = userEvent.setup();
    renderShell();

    const toggle = screen.getByRole("button", { name: "Terminal drawer" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(
      screen.queryByRole("region", { name: "Terminal" }),
    ).not.toBeInTheDocument();

    await user.click(toggle);

    const drawer = screen.getByRole("region", { name: "Terminal" });
    expect(drawer).toHaveStyle({ height: "280px" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    await user.click(screen.getByRole("button", { name: "Close the terminal" }));

    expect(
      screen.queryByRole("region", { name: "Terminal" }),
    ).not.toBeInTheDocument();
  });

  it("toggles the drawer with §56's Ctrl+T", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Control>}t{/Control}");
    expect(screen.getByRole("region", { name: "Terminal" })).toBeInTheDocument();

    await user.keyboard("{Control>}t{/Control}");
    expect(
      screen.queryByRole("region", { name: "Terminal" }),
    ).not.toBeInTheDocument();
  });

  it("offers no drawer on the Terminal page, where the console already is", async () => {
    const user = userEvent.setup();
    renderShell("/terminal");

    await screen.findByText("Run anything.");
    // §56: the shortcut is not offered where it would do nothing.
    expect(
      screen.queryByRole("button", { name: "Terminal drawer" }),
    ).not.toBeInTheDocument();

    await user.keyboard("{Control>}t{/Control}");

    expect(
      screen.queryByRole("region", { name: "Terminal" }),
    ).not.toBeInTheDocument();
  });

  it("keeps one terminal session across the drawer and the Terminal page (§31)", async () => {
    const user = userEvent.setup();
    renderShell();

    await user.keyboard("{Control>}t{/Control}");

    await user.type(screen.getByLabelText("Command"), "php -v");
    await user.click(screen.getByRole("button", { name: /^run$/i }));
    expect(await screen.findByText("> php -v")).toBeInTheDocument();

    // Walk to the Terminal page: the drawer stands down, the page takes over
    // the transcript, and there is still exactly one console on screen.
    await user.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: /terminal/i }),
    );

    expect(await screen.findByText("Run anything.")).toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Terminal" }),
    ).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("Command")).toHaveLength(1);
    expect(screen.getByText("> php -v")).toBeInTheDocument();

    // And back: the drawer returns to the same session, not a fresh one.
    await user.click(
      within(screen.getByRole("navigation")).getByRole("link", { name: /dashboard/i }),
    );

    expect(await screen.findByText("dashboard page")).toBeInTheDocument();
    expect(screen.getByText("> php -v")).toBeInTheDocument();
  });
});
