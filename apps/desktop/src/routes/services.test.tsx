import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ServicesPage } from "@/routes/services";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  installedVersions: vi.fn(),
  serviceComponentIds: vi.fn(),
  serviceStart: vi.fn(),
  serviceStop: vi.fn(),
  serviceLogs: vi.fn(),
  serviceMetrics: vi.fn(),
  phpPoolList: vi.fn(),
  phpPoolStart: vi.fn(),
  phpPoolStop: vi.fn(),
  phpPoolStatus: vi.fn(),
  phpPoolLogs: vi.fn(),
  phpLimitsGet: vi.fn(),
  phpExtList: vi.fn(),
  phpXdebugGet: vi.fn(),
  phpExtSet: vi.fn(),
  pathsGet: vi.fn(),
  portMap: vi.fn(),
  siteList: vi.fn(),
  workerList: vi.fn(),
  workerStart: vi.fn(),
  workerStop: vi.fn(),
  workerRemove: vi.fn(),
  cronList: vi.fn(),
  cronDelete: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const MAILPIT = { component_id: "mailpit", version: "1.31.1", path: "C:\\devx\\mailpit" };
const POOL = {
  id: "php-pool-8.4.25",
  version: "8.4.25",
  workers: 4,
  port: 9100,
  state: "stopped" as const,
};

/** The expanded detail panel of one server, scoped by its own tab list. */
function detail(name: string): HTMLElement {
  const tabs = screen.getByRole("tablist", { name: `${name} sections` });
  return tabs.parentElement as HTMLElement;
}

/**
 * The value of one Overview fact.
 *
 * Found through its `<dt>`, because the table above the detail uses the same
 * words as column headings.
 */
function overviewValue(label: string): HTMLElement {
  const term = Array.from(document.querySelectorAll("dt")).find(
    (node) => node.textContent === label,
  );
  if (!term?.nextElementSibling) {
    throw new Error(`no Overview fact labelled ${label}`);
  }
  return term.nextElementSibling as HTMLElement;
}

describe("ServicesPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.installedVersions.mockResolvedValue([]);
    mocks.serviceLogs.mockResolvedValue([]);
    // The row's state comes from the metrics sample, which lists every
    // registered service; an empty sample is "nothing is registered".
    mocks.serviceMetrics.mockResolvedValue([]);
    mocks.phpPoolList.mockResolvedValue([]);
    mocks.phpPoolLogs.mockResolvedValue([]);
    mocks.phpLimitsGet.mockResolvedValue({
      memory_limit: "256M",
      upload_max_filesize: "64M",
      max_execution_time: 60,
      opcache_enabled: true,
    });
    mocks.phpExtList.mockResolvedValue({
      version: "8.4.25",
      installed: ["curl", "mbstring"],
      enabled: ["curl"],
    });
    mocks.phpXdebugGet.mockResolvedValue({
      version: "8.4.25",
      enabled: false,
      mode: "",
      client_port: 0,
    });
    mocks.pathsGet.mockResolvedValue({
      config_dir: "C:\\devx\\config",
      data_dir: "C:\\devx\\data",
    });
    mocks.portMap.mockResolvedValue([]);
    mocks.siteList.mockResolvedValue([]);
    mocks.workerList.mockResolvedValue([]);
    mocks.cronList.mockResolvedValue([]);
    mocks.serviceComponentIds.mockResolvedValue([
      "nginx",
      "mariadb",
      "postgresql",
      "redis",
      "mailpit",
      "minio",
      "meilisearch",
    ]);
  });

  it("prompts to install when nothing supervisable is present", async () => {
    mocks.installedVersions.mockResolvedValue([]);

    renderWithProviders(<ServicesPage />);

    expect(
      await screen.findByText(/no supervisable service is installed/i),
    ).toBeInTheDocument();
    // §38: the empty state carries the action that fills it.
    expect(screen.getByRole("link", { name: "Open Components" })).toHaveAttribute(
      "href",
      "/components",
    );
  });

  it("shows a start control for an installed supervisable service", async () => {
    mocks.installedVersions.mockResolvedValue([MAILPIT]);

    renderWithProviders(<ServicesPage />);

    expect(await screen.findByText("mailpit")).toBeInTheDocument();
    expect(screen.getByText(/stopped/i, { selector: "span" })).toBeInTheDocument();
    // The exact name, because the header's own "Start all" also matches a
    // looser /start/i query.
    expect(screen.getByRole("button", { name: /^start$/i })).toBeInTheDocument();
  });

  it("starts the service through the start command", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.serviceStart.mockResolvedValue({ id: "mailpit", state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /^start$/i }));

    await waitFor(() =>
      expect(mocks.serviceStart).toHaveBeenCalledTimes(1),
    );
    expect(mocks.serviceStart.mock.calls[0]?.slice(0, 2)).toEqual([
      "mailpit",
      "1.31.1",
    ]);
  });

  it("does not list components that cannot be supervised yet", async () => {
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\php" },
    ]);

    renderWithProviders(<ServicesPage />);

    expect(
      await screen.findByText(/no supervisable service is installed/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("php")).not.toBeInTheDocument();
  });

  it("shows a startable row for each installed PHP pool", async () => {
    mocks.phpPoolList.mockResolvedValue([POOL]);

    renderWithProviders(<ServicesPage />);

    expect(await screen.findByText("PHP 8.4.25")).toBeInTheDocument();
    expect(screen.getByText(/fastcgi · 4 workers/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^start$/i })).toBeInTheDocument();
  });

  it("starts a PHP pool with its configured worker count", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.phpPoolStart.mockResolvedValue({ ...POOL, state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /^start$/i }));

    await waitFor(() => expect(mocks.phpPoolStart).toHaveBeenCalledTimes(1));
    expect(mocks.phpPoolStart).toHaveBeenCalledWith("8.4.25", 4);
  });

  // --- §54 command feedback ------------------------------------------------

  it("confirms a start with a toast, naming the service", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.serviceStart.mockResolvedValue({ id: "mailpit", state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /^start$/i }));

    expect(await screen.findByText("mailpit started")).toBeInTheDocument();
  });

  it("reports a failed start instead of failing silently", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.serviceStart.mockRejectedValue(new Error("port 8025 is held by mailpit.exe"));

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /^start$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /mailpit did not start/i,
    );
    expect(screen.getByRole("button", { name: /view details/i })).toBeInTheDocument();
  });

  it("restarts a running service by stopping it and starting it again", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.serviceMetrics.mockResolvedValue([
      { id: "mailpit", state: "running", cpu_percent: 0.4, memory_bytes: 4096, processes: 2 },
    ]);
    mocks.serviceStop.mockResolvedValue({ id: "mailpit", state: "stopped" });
    mocks.serviceStart.mockResolvedValue({ id: "mailpit", state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(await screen.findByRole("button", { name: /^restart$/i }));

    await waitFor(() => expect(mocks.serviceStart).toHaveBeenCalledTimes(1));
    expect(mocks.serviceStop).toHaveBeenCalledWith("mailpit");
    expect(mocks.serviceStop.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.serviceStart.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(await screen.findByText("mailpit restarted")).toBeInTheDocument();
  });

  it("says a failed restart left the service down", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.serviceMetrics.mockResolvedValue([
      { id: "mailpit", state: "running", cpu_percent: 0, memory_bytes: 0, processes: 1 },
    ]);
    mocks.serviceStop.mockResolvedValue({ id: "mailpit", state: "stopped" });
    mocks.serviceStart.mockRejectedValue(new Error("health check never passed"));

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(await screen.findByRole("button", { name: /^restart$/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /mailpit stopped but did not come back up/i,
    );
  });

  it("starts every startable server from the header, pools included", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.serviceStart.mockResolvedValue({ id: "mailpit", state: "running" });
    mocks.phpPoolStart.mockResolvedValue({ ...POOL, state: "running" });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /start all/i }));

    await waitFor(() => expect(mocks.phpPoolStart).toHaveBeenCalledTimes(1));
    expect(mocks.serviceStart).toHaveBeenCalledTimes(1);
    expect(mocks.phpPoolStart).toHaveBeenCalledWith("8.4.25", 4);
    expect(mocks.serviceStart).toHaveBeenCalledWith("mailpit", "1.31.1");
  });

  // --- §21 list ------------------------------------------------------------

  it("narrows the list with the search filter", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.phpPoolList.mockResolvedValue([POOL]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.type(screen.getByLabelText(/search services/i), "mail");

    expect(screen.getByText("mailpit")).toBeInTheDocument();
    expect(screen.queryByText("PHP 8.4.25")).not.toBeInTheDocument();
    // §61: the active filter is removable from its own chip.
    await user.click(screen.getByRole("button", { name: /clear search filter/i }));
    expect(screen.getByText("PHP 8.4.25")).toBeInTheDocument();
  });

  it("filters by state and clears it again", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.serviceMetrics.mockResolvedValue([
      { id: "mailpit", state: "failed", cpu_percent: null, memory_bytes: 0, processes: 0 },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.selectOptions(screen.getByLabelText("State"), "failed");

    expect(screen.getByText("mailpit")).toBeInTheDocument();
    expect(screen.queryByText("PHP 8.4.25")).not.toBeInTheDocument();
  });

  it("names the filter-miss state without a second reset control (§38/§61)", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    // The filter row only appears once there is more than one server to narrow.
    mocks.phpPoolList.mockResolvedValue([POOL]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.type(screen.getByLabelText(/search services/i), "nothing-matches");

    expect(await screen.findByText("No service matches these filters.")).toBeInTheDocument();
    // The chip above the empty state is the reset path; adding a button to the
    // empty state would put the same control on screen twice.
    expect(screen.queryByRole("button", { name: "Clear filters" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /clear search filter/i }));
    expect(await screen.findByText("mailpit")).toBeInTheDocument();
  });

  // --- §21 detail: Overview, Logs, Ports, Sites, Configuration --------------

  it("shows a pool's endpoint, config location and live use in its Overview", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.serviceMetrics.mockResolvedValue([
      {
        id: "php-pool-8.4.25",
        state: "running",
        cpu_percent: 12.4,
        memory_bytes: 64 * 1024 * 1024,
        processes: 9,
      },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));

    expect(within(overviewValue("FastCGI endpoint")).getByText("127.0.0.1:9100")).toBeInTheDocument();
    expect(within(overviewValue("Workers")).getByText("4")).toBeInTheDocument();
    expect(within(overviewValue("CPU")).getByText("12%")).toBeInTheDocument();
    expect(within(overviewValue("Memory")).getByText("64 MB")).toBeInTheDocument();
    expect(
      within(overviewValue("Configuration")).getByText(
        "C:\\devx\\data\\service-config\\php-pool-8.4.25",
      ),
    ).toBeInTheDocument();
  });

  it("only offers the tabs a server has data for", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("button", { name: /show details for mailpit/i }));

    const tabs = within(detail("mailpit"))
      .getAllByRole("tab")
      .map((tab) => tab.textContent);
    expect(tabs).toEqual(["Overview", "Logs"]);
    // Mailpit has no web server, no pool and no configuration commands, so
    // neither Sites, Ports nor Configuration is offered.
    expect(screen.queryByRole("tab", { name: "Sites" })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: "Configuration" })).not.toBeInTheDocument();
  });

  it("gives a web server its Sites and Ports tabs once the port map knows it", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([
      { component_id: "nginx", version: "1.31.5", path: "C:\\devx\\nginx" },
    ]);
    mocks.portMap.mockResolvedValue([{ owner: "nginx", port: 8080, active: false }]);
    mocks.serviceMetrics.mockResolvedValue([
      { id: "nginx", state: "stopped", cpu_percent: null, memory_bytes: 0, processes: 0 },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("nginx");
    await user.click(screen.getByRole("button", { name: /show details for nginx/i }));

    expect(screen.getByRole("tab", { name: "Ports" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Sites" })).toBeInTheDocument();
    // Configuration stays PHP-only: nothing reads or writes nginx.conf.
    expect(screen.queryByRole("tab", { name: "Configuration" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Ports" }));
    expect(within(detail("nginx")).getByText("8080")).toBeInTheDocument();
    expect(within(detail("nginx")).getByText("claimed")).toBeInTheDocument();
  });

  it("says the port map could not be read instead of showing an empty tab (§131 Rule 18)", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.portMap.mockRejectedValue(new Error("port map unavailable"));

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));
    await user.click(screen.getByRole("tab", { name: "Ports" }));

    expect(
      within(detail("PHP 8.4.25")).getByText("Could not read the port map."),
    ).toBeInTheDocument();
    expect(within(detail("PHP 8.4.25")).getByText("port map unavailable")).toBeInTheDocument();

    // §39: the failure is actionable from the panel that would have shown it.
    mocks.portMap.mockResolvedValue([{ owner: "php-pool-8.4.25", port: 9100, active: false }]);
    await user.click(
      within(detail("PHP 8.4.25")).getByRole("button", { name: "Try again" }),
    );

    expect(await within(detail("PHP 8.4.25")).findByText("9100")).toBeInTheDocument();
  });

  it("streams a pool's log lines into the Logs tab", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.phpPoolLogs.mockResolvedValue([
      { seq: 1, stream: "stdout", text: "21:44:01 INFO  Pool ready" },
      { seq: 2, stream: "stderr", text: "21:44:05 WARN  Port 3306 already in use" },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));
    await user.click(screen.getByRole("tab", { name: "Logs" }));

    expect(await screen.findByText("Pool ready")).toBeInTheDocument();
    // The severity is a written label in the log itself, not just a colour;
    // scoped to the log because the level filter lists the same names.
    expect(within(screen.getByRole("log")).getByText("WARN")).toBeInTheDocument();
    expect(mocks.phpPoolLogs).toHaveBeenCalledWith("8.4.25", 0);
  });

  it("lists the sites a pool serves, and none is not a dead end", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.siteList.mockResolvedValue([
      {
        hostname: "laravel.test",
        docroot: "C:\\src\\laravel",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: true,
        web_server: "Nginx",
        env: {},
        aliases: [],
        auth: null,
      },
      {
        hostname: "nextjs.local",
        docroot: "C:\\src\\next",
        php_version: "",
        php_endpoint: null,
        https: false,
        web_server: "Caddy",
        env: {},
        aliases: [],
        auth: null,
      },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));
    await user.click(screen.getByRole("tab", { name: "Sites" }));

    expect(await screen.findByText("laravel.test")).toBeInTheDocument();
    // The static site is served by Caddy, not by this PHP pool.
    expect(screen.queryByText("nextjs.local")).not.toBeInTheDocument();
  });

  it("opens the pool's configuration tools in the Configuration tab", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));

    expect(screen.getByRole("tab", { name: "Configuration" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Configuration" }));

    expect(await screen.findByText("Resource limits")).toBeInTheDocument();
    expect(screen.getByText("Extensions")).toBeInTheDocument();
    expect(screen.getByText("Xdebug")).toBeInTheDocument();
    // The real controls, not placeholders: the limits form reads the pool's
    // current ini values and the extension switches come from the build.
    expect(await screen.findByDisplayValue("256M")).toBeInTheDocument();
    expect(screen.getByLabelText("Disable curl")).toBeInTheDocument();
    expect(screen.getByLabelText("Enable mbstring")).toBeInTheDocument();
  });

  it("writes an extension change through phpExtSet", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockResolvedValue([POOL]);
    mocks.phpExtSet.mockResolvedValue({
      version: "8.4.25",
      installed: ["curl", "mbstring"],
      enabled: ["curl", "mbstring"],
    });

    renderWithProviders(<ServicesPage />);

    await screen.findByText("PHP 8.4.25");
    await user.click(screen.getByRole("button", { name: /show details for PHP 8\.4\.25/i }));
    await user.click(screen.getByRole("tab", { name: "Configuration" }));

    await user.click(await screen.findByLabelText("Enable mbstring"));

    await waitFor(() =>
      expect(mocks.phpExtSet).toHaveBeenCalledWith("8.4.25", "mbstring", true),
    );
  });

  // --- the sections that were already here --------------------------------

  it("keeps the workers tab working", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    const worker = {
      name: "myapp-queue",
      program: null,
      php_version: "8.4.25",
      args: ["queue:work"],
      working_dir: "C:\\src\\myapp",
      instances: 2,
      live: [{ id: "worker-myapp-queue-1", state: "stopped" }],
    };
    mocks.workerList.mockResolvedValue([worker]);
    mocks.workerStart.mockResolvedValue([
      { ...worker, live: [{ id: "worker-myapp-queue-1", state: "running" }] },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("tab", { name: "Workers" }));

    expect(await screen.findByText("myapp-queue")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^start$/i }));

    await waitFor(() => expect(mocks.workerStart).toHaveBeenCalledWith("myapp-queue"));
    expect(await screen.findByText("Worker myapp-queue started")).toBeInTheDocument();
  });

  it("keeps the scheduled tasks tab working", async () => {
    const user = userEvent.setup();
    mocks.installedVersions.mockResolvedValue([MAILPIT]);
    mocks.cronList.mockResolvedValue([
      {
        name: "myapp-schedule",
        program: null,
        php_version: "8.4.25",
        args: ["artisan", "schedule:run"],
        working_dir: "C:\\src\\myapp",
        every_minutes: 1,
        registered: true,
        next_run: "2026-09-16 22:00",
      },
    ]);

    renderWithProviders(<ServicesPage />);

    await screen.findByText("mailpit");
    await user.click(screen.getByRole("tab", { name: "Scheduled tasks" }));

    expect(await screen.findByText("myapp-schedule")).toBeInTheDocument();
    expect(screen.getByText(/every 1 min/i)).toBeInTheDocument();
    expect(screen.getByText("2026-09-16 22:00")).toBeInTheDocument();
  });
});
