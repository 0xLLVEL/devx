import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TrayPopup } from "@/components/tray-popup";
import { configFixture } from "@/test/fixtures";
import { renderWithProviders } from "@/test/render";

const hide = vi.fn();

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  configGet: vi.fn(),
  configSet: vi.fn(),
  trayShowMain: vi.fn(),
  trayQuit: vi.fn(),
  openInBrowser: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

vi.mock("@/lib/open-url", () => ({ openInBrowser: mocks.openInBrowser }));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ hide }),
}));

function site(overrides: Record<string, unknown> = {}) {
  return {
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
    url: "http://myapp.test",
    ...overrides,
  };
}

describe("TrayPopup", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    hide.mockReset();
    mocks.siteList.mockResolvedValue([site()]);
    mocks.configGet.mockResolvedValue(configFixture());
    mocks.configSet.mockImplementation((config: unknown) => Promise.resolve(config));
    mocks.trayShowMain.mockResolvedValue(null);
    mocks.trayQuit.mockResolvedValue(null);
  });

  it("lists sites and opens one in the browser, then hides", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrayPopup />);

    await user.click(await screen.findByRole("menuitem", { name: /open myapp\.test in browser/i }));

    expect(mocks.openInBrowser).toHaveBeenCalledWith("http://myapp.test");
    await waitFor(() => expect(hide).toHaveBeenCalledTimes(1));
  });

  it("shows the main window and quits from the footer", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrayPopup />);
    await screen.findByRole("menuitem", { name: /open myapp\.test in browser/i });

    await user.click(screen.getByRole("button", { name: "Show DevX" }));
    expect(mocks.trayShowMain).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Quit DevX" }));
    expect(mocks.trayQuit).toHaveBeenCalledTimes(1);
    expect(hide).toHaveBeenCalled();
  });

  it("hides on Escape", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrayPopup />);
    await screen.findByRole("menuitem", { name: /open myapp\.test in browser/i });

    await user.keyboard("{Escape}");
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it("toggles close-to-tray through the same config command as Settings", async () => {
    const user = userEvent.setup();
    renderWithProviders(<TrayPopup />);

    const toggle = await screen.findByRole("switch", { name: /close to tray/i });
    expect(toggle).toHaveAttribute("aria-checked", "true");
    await user.click(toggle);

    await waitFor(() => expect(mocks.configSet).toHaveBeenCalledTimes(1));
    const saved = mocks.configSet.mock.calls[0]?.[0] as { general: { close_to_tray: boolean } };
    expect(saved.general.close_to_tray).toBe(false);
  });

  it("says when there are no sites and when the list fails", async () => {
    mocks.siteList.mockResolvedValue([]);
    const { unmount } = renderWithProviders(<TrayPopup />);
    expect(await screen.findByText("No sites yet.")).toBeInTheDocument();
    unmount();

    mocks.siteList.mockRejectedValue(new Error("helper is down"));
    renderWithProviders(<TrayPopup />);
    expect(await screen.findByText("Could not read the site list.")).toBeInTheDocument();
  });
});
