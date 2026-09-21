import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "@/routes/settings";
import { configFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  configGet: vi.fn(),
  configSet: vi.fn(),
  configReset: vi.fn(),
  pathsGet: vi.fn(),
  revealManagedDir: vi.fn(),
  appInfo: vi.fn(),
  updateCheck: vi.fn(),
  profileList: vi.fn(),
  profileDelete: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

describe("SettingsPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.configGet.mockResolvedValue(configFixture());
    mocks.pathsGet.mockResolvedValue({
      config_dir: "C:\\Users\\dev\\AppData\\Roaming\\DevX",
      data_dir: "C:\\Users\\dev\\AppData\\Local\\DevX",
    });
    mocks.appInfo.mockResolvedValue({
      name: "DevX",
      version: "0.1.0",
      target: "x86_64-pc-windows-msvc",
      debug: true,
    });
    mocks.updateCheck.mockResolvedValue({
      current: "0.1.0",
      latest: null,
      update_available: false,
      url: null,
    });
    mocks.profileList.mockResolvedValue([]);
    mocks.profileDelete.mockResolvedValue([]);
  });

  it("renders the loaded configuration", async () => {
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByLabelText("Domain suffix")).toHaveValue("test");
    expect(screen.getByLabelText("HTTP port")).toHaveValue(80);
    expect(screen.getByLabelText("Resolution strategy")).toHaveValue("hosts_file");
    expect(
      screen.getByText("C:\\Users\\dev\\AppData\\Local\\DevX"),
    ).toBeInTheDocument();
  });

  it("keeps save disabled until something changes", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    const save = await screen.findByRole("button", { name: /save changes/i });
    expect(save).toBeDisabled();

    await user.clear(screen.getByLabelText("Domain suffix"));
    await user.type(screen.getByLabelText("Domain suffix"), "local");

    expect(save).toBeEnabled();
  });

  it("sends the edited configuration to the backend", async () => {
    const user = userEvent.setup();
    const saved = configFixture();
    saved.network.domain_suffix = "local";
    mocks.configSet.mockResolvedValue(saved);

    renderWithProviders(<SettingsPage />);

    const suffix = await screen.findByLabelText("Domain suffix");
    await user.clear(suffix);
    await user.type(suffix, "local");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mocks.configSet).toHaveBeenCalledTimes(1));
    expect(mocks.configSet.mock.calls[0]?.[0]).toMatchObject({
      network: { domain_suffix: "local" },
    });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Configuration saved.",
    );
  });

  it("saves the Apache HTTPS port override", async () => {
    const user = userEvent.setup();
    mocks.configSet.mockResolvedValue(configFixture());

    renderWithProviders(<SettingsPage />);

    const input = await screen.findByLabelText("Apache HTTPS port");
    await user.clear(input);
    await user.type(input, "443");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(mocks.configSet).toHaveBeenCalledTimes(1));
    expect(mocks.configSet.mock.calls[0]?.[0]).toMatchObject({
      service_ports: { "apache-https": 443 },
    });
  });

  it("shows the validation error and hint when the backend rejects a value", async () => {
    const user = userEvent.setup();
    const { IpcError } = await import("@/lib/ipc");
    mocks.configSet.mockRejectedValue(
      new IpcError({
        code: "invalid_input",
        message: "network.domain_suffix must be a single label without dots",
        hint: "use `test`, not `.test` or `dev.local`",
      }),
    );

    renderWithProviders(<SettingsPage />);

    const suffix = await screen.findByLabelText("Domain suffix");
    await user.clear(suffix);
    await user.type(suffix, "dev.local");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("must be a single label without dots");
    expect(alert).toHaveTextContent("use `test`, not `.test` or `dev.local`");
    // The rejected value stays in the form so the user can correct it.
    expect(screen.getByLabelText("Domain suffix")).toHaveValue("dev.local");
  });

  it("toggles a boolean setting through the switch control", async () => {
    const user = userEvent.setup();
    renderWithProviders(<SettingsPage />);

    const toggle = await screen.findByRole("switch", {
      name: /start devx when i sign in/i,
    });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("button", { name: /save changes/i })).toBeEnabled();
  });

  it("reveals a managed directory on request", async () => {
    const user = userEvent.setup();
    mocks.revealManagedDir.mockResolvedValue(null);

    renderWithProviders(<SettingsPage />);

    const buttons = await screen.findAllByRole("button", { name: /open/i });
    await user.click(buttons[0]!);

    // TanStack Query passes a context object as a second argument, so assert on
    // the first one rather than the whole call signature.
    await waitFor(() => expect(mocks.revealManagedDir).toHaveBeenCalled());
    expect(mocks.revealManagedDir.mock.calls[0]?.[0]).toBe(
      "C:\\Users\\dev\\AppData\\Roaming\\DevX",
    );
  });

  it("shows an up-to-date release status", async () => {
    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("DevX is up to date")).toBeInTheDocument();
  });

  it("offers the release page when an update is available", async () => {
    mocks.updateCheck.mockResolvedValue({
      current: "0.1.0",
      latest: "0.2.0",
      update_available: true,
      url: "https://github.com/devx/devx/releases/latest",
    });

    renderWithProviders(<SettingsPage />);

    expect(
      await screen.findByText("DevX 0.2.0 is available"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /get the update/i });
    expect(link).toHaveAttribute(
      "href",
      "https://github.com/devx/devx/releases/latest",
    );
  });

  it("treats an unknown latest release as up to date", async () => {
    mocks.updateCheck.mockResolvedValue({
      current: "0.1.0",
      latest: null,
      update_available: false,
      url: null,
    });

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("DevX is up to date")).toBeInTheDocument();
    expect(screen.getByText(/running 0\.1\.0/i)).toBeInTheDocument();
  });

  it("keeps the application update apart from runtime versions (§108)", async () => {
    mocks.updateCheck.mockResolvedValue({
      current: "0.1.0",
      latest: "0.2.0",
      update_available: true,
      url: "https://github.com/devx/devx/releases/latest",
    });

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText(/DevX build only/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /components/i })).toHaveAttribute(
      "href",
      "/components",
    );
    // No install IPC exists, so there is no button that claims to install one.
    expect(
      screen.queryByRole("button", { name: /^update$/i }),
    ).not.toBeInTheDocument();
  });

  it("names the failure when the saved profiles cannot be read", async () => {
    mocks.profileList.mockRejectedValue(new Error("failed to read the profiles folder"));

    renderWithProviders(<SettingsPage />);

    // §39: a read that failed must not read as "you never saved one".
    expect(
      await screen.findByText("Could not read the saved profiles."),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "failed to read the profiles folder",
    );
  });

  it("replaces the update check with the failure when app-info cannot be read", async () => {
    mocks.appInfo.mockRejectedValue(new Error("could not read the build metadata"));

    renderWithProviders(<SettingsPage />);

    // The update check stays disabled without a running version, so the card
    // must not sit on "Checking for updates…" forever (§121).
    expect(
      await screen.findByText("Could not read this build's version."),
    ).toBeInTheDocument();
    expect(screen.queryByText(/checking for updates/i)).not.toBeInTheDocument();
  });

  it("confirms before deleting a saved profile", async () => {
    const user = userEvent.setup();
    mocks.profileList.mockResolvedValue([{ name: "staging", modified_unix: null }]);

    renderWithProviders(<SettingsPage />);

    await user.click(
      await screen.findByRole("button", { name: "Delete profile staging" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText('Delete the profile "staging"?')).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Delete profile" }));

    await waitFor(() => expect(mocks.profileDelete).toHaveBeenCalledTimes(1));
    expect(mocks.profileDelete.mock.calls[0]?.[0]).toBe("staging");
  });

  it("confirms before restoring the default configuration", async () => {
    const user = userEvent.setup();
    mocks.configReset.mockResolvedValue(configFixture());

    renderWithProviders(<SettingsPage />);

    await user.click(await screen.findByRole("button", { name: "Restore defaults" }));

    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByText("Restore the default configuration?"),
    ).toBeInTheDocument();

    await user.click(
      within(dialog).getByRole("button", { name: "Restore defaults" }),
    );

    await waitFor(() => expect(mocks.configReset).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText("Configuration restored to its defaults."),
    ).toBeInTheDocument();
  });

  it("reports a save that failed for a reason the IPC layer did not label", async () => {
    const user = userEvent.setup();
    // §131 Rule 18: not every rejection is an `IpcError`, and an unlabelled one
    // must not leave the page looking as if the save never happened.
    mocks.configSet.mockRejectedValue(new Error("the write lock was never released"));

    renderWithProviders(<SettingsPage />);

    const suffix = await screen.findByLabelText("Domain suffix");
    await user.clear(suffix);
    await user.type(suffix, "local");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Could not save the configuration.");
    expect(alert).toHaveTextContent("the write lock was never released");
  });

  it("shows the empty state, not a paragraph, when no profile is saved (§38)", async () => {
    mocks.profileList.mockResolvedValue([]);

    renderWithProviders(<SettingsPage />);

    expect(await screen.findByText("No saved profiles yet.")).toBeInTheDocument();
    expect(
      screen.getByText(
        "Set everything up the way you like it, then save it under a name below.",
      ),
    ).toBeInTheDocument();
  });
});
