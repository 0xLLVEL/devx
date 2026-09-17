import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabasesPage } from "@/routes/databases";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  dbListServers: vi.fn(),
  dbListDatabases: vi.fn(),
  dbListTables: vi.fn(),
  dbQuery: vi.fn(),
  backupList: vi.fn(),
  installedVersions: vi.fn(),
  serviceMetrics: vi.fn(),
  serviceLogs: vi.fn(),
  serviceStart: vi.fn(),
  serviceStop: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

/** A one-column result grid with text cells for each value. */
function singleColumn(name: string, values: string[]) {
  return {
    columns: [{ name }],
    rows: values.map((value) => [{ text: value }]),
  };
}

/** The detail panel, which the cards select into. */
function detail() {
  return screen.getByRole("region", { name: "Database detail" });
}

describe("DatabasesPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.dbListServers.mockResolvedValue([
      {
        engine: "maria_db",
        service_id: "mariadb",
        host: "127.0.0.1",
        port: 3306,
        reachable: true,
      },
      {
        engine: "postgre_sql",
        service_id: "postgresql",
        host: "127.0.0.1",
        port: 5432,
        reachable: false,
      },
    ]);
    mocks.installedVersions.mockResolvedValue([
      { component_id: "mariadb", version: "11.4.5", path: "C:\\devx\\mariadb" },
      { component_id: "postgresql", version: "16.3", path: "C:\\devx\\pgsql" },
    ]);
    mocks.serviceMetrics.mockResolvedValue([
      { id: "mariadb", state: "running", cpu_percent: 1, memory_bytes: 42_000_000, processes: 3 },
      { id: "postgresql", state: "stopped", cpu_percent: null, memory_bytes: 0, processes: 0 },
    ]);
    mocks.dbListDatabases.mockResolvedValue(
      singleColumn("Database", ["shop", "legacy"]),
    );
    mocks.dbListTables.mockResolvedValue(
      singleColumn("Tables_in_shop", ["users", "orders"]),
    );
    mocks.dbQuery.mockResolvedValue({
      columns: [{ name: "version()" }],
      rows: [[{ text: "11.4.5-MariaDB" }]],
    });
    mocks.backupList.mockResolvedValue([]);
    mocks.serviceLogs.mockResolvedValue([]);
  });

  it("shows an empty state when no database servers exist", async () => {
    mocks.dbListServers.mockResolvedValue([]);

    renderWithProviders(<DatabasesPage />);

    expect(
      await screen.findByText(/no database servers registered yet/i),
    ).toBeInTheDocument();
  });

  it("describes each engine on its card with the real version, endpoint and count (§25)", async () => {
    renderWithProviders(<DatabasesPage />);

    const mariadb = await screen.findByRole("button", {
      name: /select mariadb on 127\.0\.0\.1:3306/i,
    });
    expect(mariadb).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByRole("button", { name: /select postgresql on 127\.0\.0\.1:5432/i }),
    ).toHaveAttribute("aria-pressed", "false");

    // Version comes from the installed component, the count from the engine,
    // the state from the supervisor and reachability from the socket: four
    // separate facts, none of them invented.
    const mariadbCard = within(screen.getByRole("group", { name: "MariaDB engine" }));
    expect(mariadbCard.getByText("v11.4.5")).toBeInTheDocument();
    expect(mariadbCard.getByText("2 databases")).toBeInTheDocument();
    expect(mariadbCard.getByText("accepting connections on :3306")).toBeInTheDocument();
    expect(mariadbCard.getByText("running")).toBeInTheDocument();

    const postgresCard = within(screen.getByRole("group", { name: "PostgreSQL engine" }));
    expect(postgresCard.getByText("v16.3")).toBeInTheDocument();
    expect(postgresCard.getByText("nothing listening on :5432")).toBeInTheDocument();
    // The unreachable engine is never asked for a listing.
    expect(postgresCard.getByText("database count unknown")).toBeInTheDocument();
    expect(postgresCard.getByText("stopped")).toBeInTheDocument();

    // Selecting the other card moves the detail onto it.
    await userEvent.click(
      screen.getByRole("button", { name: /select postgresql on 127\.0\.0\.1:5432/i }),
    );
    expect(within(detail()).getByText("127.0.0.1:5432")).toBeInTheDocument();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: /select postgresql on 127\.0\.0\.1:5432/i }),
      ).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("does not activate the card's active state until Open client is clicked", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    const mariadbCard = await screen.findByRole("group", { name: "MariaDB engine" });
    // Initially the card is not active
    expect(mariadbCard.className).not.toContain("bg-primary-soft");

    // Clicking Open client activates the card
    const openClientBtn = within(mariadbCard).getByRole("button", { name: /open client/i });
    await user.click(openClientBtn);

    expect(mariadbCard.className).toContain("bg-primary-soft");
  });

  it("offers tabs only for surfaces with data behind them (§26)", async () => {
    renderWithProviders(<DatabasesPage />);

    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Overview",
      "Databases (2)",
      "Query",
      "Backups",
      "Logs",
    ]);
    // §26 lists Users and Connections; nothing in the IPC surface backs them.
    expect(screen.queryByRole("tab", { name: /users/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /connections/i })).not.toBeInTheDocument();
  });

  it("keeps the Redis statement console away, since the backend refuses one", async () => {
    mocks.dbListServers.mockResolvedValue([
      {
        engine: "redis",
        service_id: "redis",
        host: "127.0.0.1",
        port: 6379,
        reachable: true,
      },
    ]);
    mocks.installedVersions.mockResolvedValue([
      { component_id: "redis", version: "7.2.5", path: "C:\\devx\\redis" },
    ]);
    mocks.dbListDatabases.mockResolvedValue(
      {
        columns: [{ name: "index" }],
        rows: Array.from({ length: 16 }, (_value, index) => [{ int: index }]),
      },
    );

    renderWithProviders(<DatabasesPage />);

    expect(await screen.findByRole("tab", { name: /databases/i })).toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /query/i })).not.toBeInTheDocument();
  });

  it("lists databases and their tables for the selected server", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: /databases/i }));

    // Tables stay empty until a database is picked.
    expect(
      await screen.findByText(/pick a database to list its tables\./i),
    ).toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText("Database"), "shop");

    await waitFor(() => {
      expect(mocks.dbListTables).toHaveBeenCalled();
    });
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("passes the statement through and renders the result grid", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: "Query" }));
    await user.type(await screen.findByLabelText(/statement/i), "SELECT version()");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() => {
      expect(mocks.dbQuery).toHaveBeenCalledWith(
        expect.objectContaining({ engine: "maria_db", port: 3306 }),
        "SELECT version()",
      );
    });
    expect(await screen.findByText("11.4.5-MariaDB")).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: "version()" }),
    ).toBeInTheDocument();
  });

  it("shows server errors from failed statements", async () => {
    const user = userEvent.setup();
    mocks.dbQuery.mockRejectedValue(
      new Error("Unknown column 'nope' in 'field list'"),
    );

    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: "Query" }));
    await user.type(await screen.findByLabelText(/statement/i), "SELECT nope");
    await user.click(screen.getByRole("button", { name: /run/i }));

    expect(
      await screen.findByText(/unknown column 'nope'/i),
    ).toBeInTheDocument();
  });

  it("disables Run while the statement is blank", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: "Query" }));

    expect(await screen.findByRole("button", { name: /run/i })).toBeDisabled();
  });

  it("hides the password until Show is pressed (§26)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    const field = await screen.findByLabelText("Password");
    expect(field).toHaveAttribute("type", "password");

    const toggle = screen.getByRole("button", { name: /show password/i });
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.type(field, "s3cret");
    expect(field).toHaveValue("s3cret");

    await user.click(toggle);
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "text");
    expect(screen.getByRole("button", { name: /hide password/i })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByRole("button", { name: /hide password/i }));
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
  });

  it("sends the credentials the user typed with the next statement", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    await user.type(await screen.findByLabelText("User"), "admin");
    await user.type(screen.getByLabelText("Password"), "hunter2");

    await user.click(screen.getByRole("tab", { name: "Query" }));
    await user.type(await screen.findByLabelText(/statement/i), "SELECT 1");
    await user.click(screen.getByRole("button", { name: /run/i }));

    await waitFor(() =>
      expect(mocks.dbQuery).toHaveBeenCalledWith(
        expect.objectContaining({ username: "admin", password: "hunter2" }),
        "SELECT 1",
      ),
    );
  });

  it("starts and stops the engine from the card's own actions (§91)", async () => {
    const user = userEvent.setup();
    mocks.serviceStart.mockResolvedValue({ id: "postgresql", state: "running" });
    mocks.serviceStop.mockResolvedValue({ id: "mariadb", state: "stopped" });

    renderWithProviders(<DatabasesPage />);

    await screen.findByRole("button", { name: /select mariadb/i });
    await user.click(screen.getByRole("button", { name: /actions for mariadb/i }));
    await user.click(await screen.findByRole("menuitem", { name: /stop mariadb/i }));

    await waitFor(() => expect(mocks.serviceStop).toHaveBeenCalledWith("mariadb"));

    await user.click(screen.getByRole("button", { name: /actions for postgresql/i }));
    await user.click(await screen.findByRole("menuitem", { name: /start postgresql/i }));

    // Starting needs the installed version, not a guess.
    await waitFor(() =>
      expect(mocks.serviceStart).toHaveBeenCalledWith("postgresql", "16.3"),
    );
  });

  it("opens the same actions by right-clicking the engine card (§47)", async () => {
    const user = userEvent.setup();
    mocks.serviceStop.mockResolvedValue({ id: "mariadb", state: "stopped" });

    renderWithProviders(<DatabasesPage />);

    const card = await screen.findByRole("group", { name: "MariaDB engine" });
    fireEvent.contextMenu(card, { clientX: 30, clientY: 80 });

    const menu = await screen.findByRole("menu", { name: "Actions for MariaDB" });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Start MariaDB", "Stop MariaDB", "Browse data", "Backups", "Logs"]);

    // It runs the card's real action, not a copy of it.
    await user.click(within(menu).getByRole("menuitem", { name: /stop mariadb/i }));
    await waitFor(() => expect(mocks.serviceStop).toHaveBeenCalledWith("mariadb"));
  });

  it("filters the cards by engine and state, with Clear filters for two (§61)", async () => {
    const user = userEvent.setup();
    renderWithProviders(<DatabasesPage />);

    await screen.findByRole("button", { name: /select mariadb/i });

    await user.selectOptions(screen.getByLabelText("Engine"), "maria_db");
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: /select postgresql/i }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: /select mariadb/i })).toBeInTheDocument();

    // Nothing is listening on Postgres, so this narrows nothing further, but
    // the second active filter is what brings the bulk reset in.
    await user.selectOptions(screen.getByLabelText("State"), "stopped");
    expect(await screen.findByText(/no engine matches these filters/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /clear filters/i }));
    expect(
      await screen.findByRole("button", { name: /select postgresql/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /select mariadb/i })).toBeInTheDocument();
  });

  it("does not carry the chosen schema over to another engine", async () => {
    const user = userEvent.setup();
    mocks.dbListServers.mockResolvedValue([
      {
        engine: "maria_db",
        service_id: "mariadb",
        host: "127.0.0.1",
        port: 3306,
        reachable: true,
      },
      {
        engine: "postgre_sql",
        service_id: "postgresql",
        host: "127.0.0.1",
        port: 5432,
        reachable: true,
      },
    ]);

    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: /databases/i }));
    await user.selectOptions(await screen.findByLabelText("Database"), "shop");
    await waitFor(() => expect(screen.getByLabelText("Database")).toHaveValue("shop"));

    await user.click(
      screen.getByRole("button", { name: /select postgresql on 127\.0\.0\.1:5432/i }),
    );

    // `shop` belongs to MariaDB; the next engine starts with no schema picked
    // rather than querying a database that may not exist there.
    await waitFor(() => expect(screen.getByLabelText("Database")).toHaveValue(""));
  });

  it("shows the service output on the Logs tab", async () => {
    const user = userEvent.setup();
    mocks.serviceLogs.mockResolvedValue([
      { seq: 1, stream: "stdout", text: "InnoDB initialised" },
    ]);

    renderWithProviders(<DatabasesPage />);

    await user.click(await screen.findByRole("tab", { name: "Logs" }));

    expect(await screen.findByText(/InnoDB initialised/)).toBeInTheDocument();
    expect(mocks.serviceLogs).toHaveBeenCalledWith("mariadb", 0);
  });

  it("points at the install path when no engine is registered (§38)", async () => {
    mocks.dbListServers.mockResolvedValue([]);

    renderWithProviders(<DatabasesPage />);

    expect(
      await screen.findByText("No database servers registered yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Components" })).toHaveAttribute(
      "href",
      "/components",
    );
  });

  it("explains an empty table list and an empty result grid (§38)", async () => {
    const user = userEvent.setup();
    mocks.dbListTables.mockResolvedValue(singleColumn("Table", []));
    mocks.dbQuery.mockResolvedValue({ columns: [], rows: [] });

    renderWithProviders(<DatabasesPage />);

    // Before a schema is picked the panel says what picking one does.
    await user.click(await screen.findByRole("tab", { name: /databases/i }));
    expect(
      await screen.findByText("Pick a database to list its tables."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Choose one from the list above and its tables appear here."),
    ).toBeInTheDocument();

    await user.selectOptions(await screen.findByLabelText("Database"), "shop");

    expect(await screen.findByText("No tables found.")).toBeInTheDocument();
    expect(
      screen.getByText("This database exists but holds no tables yet."),
    ).toBeInTheDocument();

    await user.click(await screen.findByRole("tab", { name: "Query" }));
    await user.type(await screen.findByLabelText(/statement/i), "ANALYZE TABLE t");
    await user.click(screen.getByRole("button", { name: /run/i }));

    expect(
      await screen.findByText("Statement executed; it returned no rows."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("The statement ran without error — it just produced no result set."),
    ).toBeInTheDocument();
  });
});
