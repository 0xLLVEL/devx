import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DatabasesPage } from "@/routes/databases";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  dbListServers: vi.fn(),
  dbListDatabases: vi.fn(),
  dbListTables: vi.fn(),
  dbQuery: vi.fn(),
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
  });

  it("shows an empty state when no database servers exist", async () => {
    mocks.dbListServers.mockResolvedValue([]);

    renderWithProviders(<DatabasesPage />);

    expect(
      await screen.findByText(/no database servers registered yet/i),
    ).toBeInTheDocument();
  });

  it("lists servers with engine label and port", async () => {
    renderWithProviders(<DatabasesPage />);

    const select = await screen.findByLabelText(/engine/i);
    expect(
      await screen.findByRole("option", {
        name: /mariadb — 127\.0\.0\.1:3306/i,
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("option", { name: /postgresql.*5432/i }),
    ).toBeInTheDocument();
    expect(select).toHaveValue("mariadb");
  });

  it("lists databases and their tables for the selected server", async () => {
    renderWithProviders(<DatabasesPage />);

    // Tables stay empty until a database is picked.
    expect(
      await screen.findByText(/pick a database to list its tables\./i),
    ).toBeInTheDocument();

    await screen.findByRole("option", { name: "shop" });
    await userEvent.selectOptions(screen.getByLabelText(/database/i), "shop");

    await waitFor(() => {
      expect(mocks.dbListTables).toHaveBeenCalled();
    });
    expect(await screen.findByText("users")).toBeInTheDocument();
    expect(screen.getByText("orders")).toBeInTheDocument();
  });

  it("passes the statement through and renders the result grid", async () => {
    renderWithProviders(<DatabasesPage />);

    await userEvent.type(
      await screen.findByLabelText(/statement/i),
      "SELECT version()",
    );
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

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
    mocks.dbQuery.mockRejectedValue(
      new Error("Unknown column 'nope' in 'field list'"),
    );

    renderWithProviders(<DatabasesPage />);

    await userEvent.type(await screen.findByLabelText(/statement/i), "SELECT nope");
    await userEvent.click(screen.getByRole("button", { name: /run/i }));

    expect(
      await screen.findByText(/unknown column 'nope'/i),
    ).toBeInTheDocument();
  });

  it("disables Run while the statement is blank", async () => {
    renderWithProviders(<DatabasesPage />);

    expect(
      await screen.findByRole("button", { name: /run/i }),
    ).toBeDisabled();
  });
});
