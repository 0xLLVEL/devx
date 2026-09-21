import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProjectsPage } from "@/routes/projects";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  projectsList: vi.fn(),
  projectAdd: vi.fn(),
  projectRemove: vi.fn(),
  projectUpdate: vi.fn(),
  installedVersions: vi.fn(),
  openFolder: vi.fn(),
  openInBrowser: vi.fn(),
  pickDirectory: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

vi.mock("@/lib/open-folder", () => ({ openFolder: mocks.openFolder }));
vi.mock("@/lib/open-url", () => ({ openInBrowser: mocks.openInBrowser }));
vi.mock("@/lib/pick-directory", () => ({ pickDirectory: mocks.pickDirectory }));

/** One backend project as `projects_list` returns it. */
function project(overrides: Record<string, unknown> = {}) {
  return {
    name: "myapp",
    path: "C:\\dev\\myapp",
    sites: [
      {
        hostname: "myapp.test",
        docroot: "C:\\dev\\myapp\\public",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: false,
        web_server: "Nginx",
        env: {},
        aliases: [],
        auth: null,
        port: 80,
        https_port: 443,
      },
    ],
    workers: [
      {
        name: "queue",
        program: null,
        php_version: "8.4.25",
        args: [],
        working_dir: "C:\\dev\\myapp",
        instances: 2,
        live: [
          { id: "worker-queue-1", state: "running" },
          { id: "worker-queue-2", state: "stopped" },
        ],
      },
    ],
    cron: [
      {
        name: "schedule",
        program: null,
        php_version: "8.4.25",
        args: [],
        working_dir: "C:\\dev\\myapp",
        every_minutes: 60,
        registered: true,
        next_run: null,
      },
    ],
    php_versions: ["8.4.25"],
    default_php: null,
    default_node: null,
    default_python: null,
    managed: false,
    label: null,
    running_workers: 1,
    total_workers: 2,
    ...overrides,
  };
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.openFolder.mockResolvedValue(null);
    mocks.openInBrowser.mockResolvedValue(undefined);
    mocks.installedVersions.mockResolvedValue([
      { component_id: "php", version: "8.4.25", path: "C:\\devx\\runtimes\\php\\8.4.25" },
    ]);
  });

  it("lists projects with their aggregate status", async () => {
    mocks.projectsList.mockResolvedValue([project()]);

    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("1 project")).toBeInTheDocument();
    expect(screen.getAllByText("myapp").length).toBeGreaterThan(0);
    expect(screen.getAllByText("myapp.test").length).toBeGreaterThan(0);
    expect(screen.getByText("1 running")).toBeInTheDocument();
    expect(screen.getAllByText("PHP 8.4.25").length).toBeGreaterThan(0);
  });

  it("selects a project and shows its full detail panel", async () => {
    mocks.projectsList.mockResolvedValue([
      project(),
      project({ name: "other", path: "C:\\dev\\other", sites: [], running_workers: 0 }),
    ]);

    renderWithProviders(<ProjectsPage />);

    // Cards start inactive: no detail panel until a card is clicked.
    await screen.findByRole("button", { name: /^myapp/ });
    expect(screen.queryByLabelText("myapp details")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^myapp/ }));
    expect(screen.getByLabelText("myapp details")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /^other/ }));

    // The detail panel shows the selected project's sections.
    const detail = screen.getByLabelText("other details");
    expect(within(detail).getByText("Workers")).toBeInTheDocument();
    expect(within(detail).getByText("Scheduled tasks")).toBeInTheDocument();
    expect(within(detail).getByText("No sites in this project.")).toBeInTheDocument();
  });

  it("opens a site in the browser from the detail panel", async () => {
    mocks.projectsList.mockResolvedValue([project()]);

    renderWithProviders(<ProjectsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /^myapp/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Open myapp.test in browser" }),
    );

    await waitFor(() =>
      expect(mocks.openInBrowser).toHaveBeenCalledWith("http://myapp.test"),
    );
  });

  it("opens the project folder from the detail panel", async () => {
    mocks.projectsList.mockResolvedValue([project()]);

    renderWithProviders(<ProjectsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /^myapp/ }));
    const detail = screen.getByLabelText("myapp details");
    await userEvent.click(within(detail).getByRole("button", { name: /open folder/i }));

    await waitFor(() =>
      expect(mocks.openFolder).toHaveBeenCalledWith("C:\\dev\\myapp"),
    );
  });

  it("explains an empty project list instead of rendering a blank grid", async () => {
    mocks.projectsList.mockResolvedValue([]);

    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByText("No projects yet.")).toBeInTheDocument();
    expect(
      screen.getByText(/Add a project folder to pin it here/),
    ).toBeInTheDocument();
  });

  it("adds a project through the folder picker", async () => {
    mocks.projectsList.mockResolvedValue([]);
    mocks.pickDirectory.mockResolvedValue("C:\\dev\\newapp");
    mocks.projectAdd.mockImplementation(async () => {
      // The mutation result and the refetch that follows invalidation must
      // agree, or the UI flips back to the empty state.
      const added = project({
        name: "newapp",
        path: "C:\\dev\\newapp",
        sites: [],
        workers: [],
        cron: [],
        php_versions: [],
        managed: true,
        running_workers: 0,
        total_workers: 0,
      });
      mocks.projectsList.mockResolvedValue([added]);
      return [added];
    });

    renderWithProviders(<ProjectsPage />);

    await screen.findByText("No projects yet.");
    const addButtons = screen.getAllByRole("button", { name: /add project/i });
    await userEvent.click(addButtons[0] as HTMLElement);
    await userEvent.click(screen.getByRole("button", { name: /choose folder/i }));

    await waitFor(() =>
      expect(mocks.projectAdd).toHaveBeenCalledWith("C:\\dev\\newapp", null),
    );
    expect(await screen.findByText(/No sites, workers or tasks point here yet/)).toBeInTheDocument();
  });

  it("shows an empty managed project with its hint", async () => {
    mocks.projectsList.mockResolvedValue([
      project({
        name: "newapp",
        path: "C:\\dev\\newapp",
        sites: [],
        workers: [],
        cron: [],
        php_versions: [],
        managed: true,
        running_workers: 0,
        total_workers: 0,
      }),
    ]);

    renderWithProviders(<ProjectsPage />);

    expect(
      await screen.findByText(/No sites, workers or tasks point here yet/),
    ).toBeInTheDocument();
    expect(screen.getAllByText(/managed/).length).toBeGreaterThan(0);
  });

  it("saves per-project runtime defaults from the settings dialog", async () => {
    mocks.projectsList.mockResolvedValue([project({ managed: true })]);
    mocks.projectUpdate.mockResolvedValue([project({ managed: true, default_php: "8.4.25" })]);

    renderWithProviders(<ProjectsPage />);

    await userEvent.click(await screen.findByRole("button", { name: /^myapp/ }));
    await userEvent.click(
      screen.getByRole("button", { name: "Runtime settings for myapp" }),
    );

    const dialog = await screen.findByRole("dialog");
    await userEvent.selectOptions(within(dialog).getByLabelText("PHP version"), "8.4.25");
    await userEvent.click(within(dialog).getByRole("button", { name: /save/i }));

    await waitFor(() =>
      expect(mocks.projectUpdate).toHaveBeenCalledWith(
        "C:\\dev\\myapp",
        null,
        "8.4.25",
        null,
        null,
      ),
    );
  });

  it("reports an unreadable project list as a failure, not an empty one", async () => {
    const { IpcError } = await import("@/lib/ipc");
    mocks.projectsList.mockRejectedValue(
      new IpcError({ code: "internal", message: "grouping failed", hint: null }),
    );

    renderWithProviders(<ProjectsPage />);

    expect(await screen.findByRole("alert")).toHaveTextContent("grouping failed");
  });
});
