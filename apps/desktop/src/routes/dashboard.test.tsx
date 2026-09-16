import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { countPortConflicts, DashboardPage } from "@/routes/dashboard";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  serviceMetrics: vi.fn(),
  installedVersions: vi.fn(),
  catalogList: vi.fn(),
  dbListServers: vi.fn(),
  diskUsage: vi.fn(),
  portMap: vi.fn(),
  eventsRecent: vi.fn(),
  servicesStartAll: vi.fn(),
  servicesStopAll: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const { serviceMetrics, siteList } = mocks;

/** The dashboard with stub destinations, so a card's click can be observed. */
function renderDashboard() {
  return renderWithProviders(
    <Routes>
      <Route path="/" element={<DashboardPage />} />
      <Route path="/sites" element={<p>sites page</p>} />
      <Route path="/components" element={<p>components page</p>} />
    </Routes>,
  );
}

const mariadb = {
  id: "mariadb",
  state: "running",
  cpu_percent: 5,
  memory_bytes: 256 * 1024 * 1024,
  processes: 1,
};

const nginx = {
  id: "nginx",
  state: "running",
  cpu_percent: 1,
  memory_bytes: 8 * 1024 * 1024,
  processes: 1,
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.siteList.mockResolvedValue([]);
  mocks.serviceMetrics.mockResolvedValue([]);
  mocks.installedVersions.mockResolvedValue([]);
  mocks.catalogList.mockResolvedValue([]);
  mocks.dbListServers.mockResolvedValue([]);
  mocks.diskUsage.mockResolvedValue([]);
  mocks.portMap.mockResolvedValue([]);
  mocks.eventsRecent.mockResolvedValue([]);
});

describe("DashboardPage", () => {
  it("shows the waiting verdict when nothing is supervised yet", async () => {
    renderDashboard();

    expect(
      await screen.findByText("Your environment is waiting."),
    ).toBeInTheDocument();
  });

  it("announces the state read while the header is a bare skeleton (§121)", async () => {
    // Held open so the placeholder is the only thing in the header.
    mocks.serviceMetrics.mockReturnValue(new Promise(() => {}));

    renderDashboard();

    expect(await screen.findByText("Reading service state…")).toBeInTheDocument();
  });

  it("lists supervised services with their live resource use", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 12,
        memory_bytes: 512 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "php-pool-8.4.25",
        state: "stopped",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderDashboard();

    expect(await screen.findByText("mariadb")).toBeInTheDocument();
    expect(screen.getAllByText("12%").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/512 MB/).length).toBeGreaterThan(0);
    expect(screen.getByText("php-pool-8.4.25")).toBeInTheDocument();
    expect(screen.getByText("1/2")).toBeInTheDocument();
  });

  it("celebrates when every supervised service is running", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 5,
        memory_bytes: 256 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "nginx",
        state: "running",
        cpu_percent: 1,
        memory_bytes: 8 * 1024 * 1024,
        processes: 1,
      },
    ]);

    renderDashboard();

    expect(await screen.findByText("Everything is running.")).toBeInTheDocument();
    expect(screen.getByText("2/2")).toBeInTheDocument();
  });

  it("leads with the failed verdict when a service is down", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 5,
        memory_bytes: 256 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "nginx",
        state: "failed",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderDashboard();

    expect(await screen.findByText("1 service failed.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "nginx is failing. Check its log on the Services page and restart it.",
    );
  });

  it("sorts failed services above running ones in the service board", async () => {
    serviceMetrics.mockResolvedValue([
      {
        id: "mariadb",
        state: "running",
        cpu_percent: 5,
        memory_bytes: 256 * 1024 * 1024,
        processes: 1,
      },
      {
        id: "nginx",
        state: "failed",
        cpu_percent: 0,
        memory_bytes: 0,
        processes: 0,
      },
    ]);

    renderDashboard();

    const mariadbCell = await screen.findByText("mariadb");
    const nginxCell = screen.getByText("nginx");
    expect(
      nginxCell.compareDocumentPosition(mariadbCell) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("greets the user and summarizes the real system state (§17)", async () => {
    serviceMetrics.mockResolvedValue([mariadb, nginx]);
    siteList.mockResolvedValue([
      { hostname: "app.test", https: true },
      { hostname: "api.test", https: false },
    ]);
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:/php" },
      { component_id: "node", version: "22.11.0", path: "C:/node" },
    ]);
    mocks.catalogList.mockResolvedValue([
      { id: "php", kind: "runtime" },
      { id: "node", kind: "runtime" },
      { id: "composer", kind: "tool" },
    ]);

    renderDashboard();

    expect(
      screen.getByText(/^Good (morning|afternoon|evening|night), Developer$/),
    ).toBeInTheDocument();
    // §118's verdict, shared with the sidebar and the topbar.
    expect(await screen.findByText("System Ready")).toBeInTheDocument();
    expect(screen.getByText("2 runtimes · 2 servers · 2 sites")).toBeInTheDocument();
    // §18: only real counts — two runtime versions, not three installed components.
    expect(screen.getByText("Runtimes")).toBeInTheDocument();
    expect(screen.getByText("Installed")).toBeInTheDocument();
  });

  it("reports a port claimed by two owners as a conflict, and nothing when there is none", async () => {
    mocks.portMap.mockResolvedValue([
      { owner: "Web (HTTP)", port: 80, active: true },
      { owner: "nginx", port: 80, active: true },
      { owner: "mariadb", port: 3306, active: false },
    ]);

    renderDashboard();

    expect(await screen.findByText("1 port conflict")).toBeInTheDocument();
  });

  it("stays quiet about port conflicts when every port has one owner", async () => {
    mocks.portMap.mockResolvedValue([
      { owner: "Web (HTTP)", port: 80, active: true },
      { owner: "mariadb", port: 3306, active: false },
    ]);

    renderDashboard();

    await screen.findByText("0 runtimes · 0 servers · 0 sites");
    expect(screen.queryByText(/port conflict/i)).not.toBeInTheDocument();
  });

  it("navigates from a summary card (§18 click interaction)", async () => {
    const user = userEvent.setup();
    renderDashboard();

    await user.click(await screen.findByRole("link", { name: /^Sites/ }));

    expect(screen.getByText("sites page")).toBeInTheDocument();
  });

  it("shows the sizes the backend measured, per managed directory (§40)", async () => {
    mocks.diskUsage.mockResolvedValue([
      { label: "runtimes", size_bytes: 2 * 1024 ** 3 },
      { label: "logs", size_bytes: 64 * 1024 ** 2 },
    ]);

    renderDashboard();

    expect(await screen.findByText("runtimes")).toBeInTheDocument();
    expect(screen.getByText("2.0 GB")).toBeInTheDocument();
    expect(screen.getByText("64 MB")).toBeInTheDocument();
  });

  it("builds the activity timeline from the recorded service events (§42)", async () => {
    const now = Math.floor(Date.now() / 1000);
    mocks.eventsRecent.mockResolvedValue([
      { at_unix: now - 120, id: "nginx", state: "running", exit: null },
      { at_unix: now - 300, id: "mariadb", state: "failed", exit: "crashed" },
    ]);

    renderDashboard();

    expect(await screen.findByText("Started nginx")).toBeInTheDocument();
    expect(screen.getByText("2 min ago")).toBeInTheDocument();
    expect(screen.getByText("mariadb failed")).toBeInTheDocument();
    expect(screen.getByText(/exited unexpectedly/)).toBeInTheDocument();
    expect(mocks.eventsRecent).toHaveBeenCalledWith(6);
  });

  it("shows an honest empty activity state instead of sample events (§38)", async () => {
    renderDashboard();

    expect(await screen.findByText("No service events yet.")).toBeInTheDocument();
  });

  it("shows an unknown count, not a zero, when a query fails (§131 Rule 17)", async () => {
    mocks.dbListServers.mockRejectedValue(new Error("backend unavailable"));

    renderDashboard();

    // The panel behind the card says what happened…
    expect(
      await screen.findByText("Could not read the database servers."),
    ).toBeInTheDocument();
    // …and the card must not claim there are none when it could not ask.
    const card = screen.getByRole("link", { name: /^Databases/ });
    expect(within(card).getByText("—")).toBeInTheDocument();
    expect(within(card).getByText("Unavailable")).toBeInTheDocument();
    expect(within(card).queryByText("0")).not.toBeInTheDocument();
  });

  it("says the read failed instead of calling the environment empty (§131 Rule 17)", async () => {
    serviceMetrics.mockRejectedValue(new Error("sampler unavailable"));

    renderDashboard();

    // The headline is a fact about DevX, not a verdict about the machine…
    expect(await screen.findByText("Could not read the service state.")).toBeInTheDocument();
    // …and the panel reports the failure the §39 way: one alert carrying what
    // failed, the backend's own cause, and a way back. The resource card below
    // reports the same failed read against its own dashes, so the assertions
    // are scoped to the panel's alert rather than the whole page.
    const panel = screen.getByText("sampler unavailable").closest('[role="alert"]');
    expect(panel).not.toBeNull();
    expect(
      within(panel as HTMLElement).getByText("Could not read the service metrics."),
    ).toBeInTheDocument();
    expect(
      within(panel as HTMLElement).getByRole("button", { name: "Try again" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Nothing is supervised yet.")).not.toBeInTheDocument();
  });

  it("reports a batch start that only partly worked (§54)", async () => {
    const user = userEvent.setup();
    serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "stopped", cpu_percent: 0, memory_bytes: 0, processes: 0 },
    ]);
    mocks.servicesStartAll.mockResolvedValue([
      { id: "nginx", error: "port 80 is already in use" },
    ]);

    renderDashboard();
    await user.click(await screen.findByRole("button", { name: /start all/i }));

    expect(await screen.findByText("1 service did not start")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /view details/i }));
    // The backend's own message per service, not a generic failure.
    expect(screen.getByText(/nginx: port 80 is already in use/)).toBeInTheDocument();
  });

  it("offers only actions and shortcuts that really exist (§117)", async () => {
    renderDashboard();

    const quickActions = screen.getByText("Quick actions").closest("div")!;
    const links = within(quickActions.parentElement!).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/components",
      "/sites",
      "/terminal",
      "/logs",
    ]);
    // Alt+2 and Alt+4 are installed by the shell; Terminal and Logs have none,
    // so no shortcut is advertised for them.
    expect(screen.getByText("Alt 2")).toBeInTheDocument();
    expect(screen.getByText("Alt 4")).toBeInTheDocument();
    expect(screen.queryByText(/Ctrl/)).not.toBeInTheDocument();
  });
});

describe("countPortConflicts", () => {
  it("counts a port two owners claim, and ignores the ones a single owner holds", () => {
    expect(
      countPortConflicts([
        { owner: "Web (HTTP)", port: 80, active: true },
        { owner: "nginx", port: 80, active: false },
        { owner: "mariadb", port: 3306, active: true },
      ]),
    ).toBe(1);
  });

  it("does not call the same owner twice on one port a conflict", () => {
    expect(
      countPortConflicts([{ owner: "nginx", port: 8080, active: true }]),
    ).toBe(0);
  });

  it("reports nothing for an empty map", () => {
    expect(countPortConflicts([])).toBe(0);
  });
});
