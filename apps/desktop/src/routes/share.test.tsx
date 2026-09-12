import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SharePage } from "@/routes/share";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  tunnelStatus: vi.fn(),
  tunnelStart: vi.fn(),
  tunnelStop: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const site = (hostname: string) => ({
  hostname,
  docroot: `C:\\dev\\${hostname}`,
  php_version: "",
  php_endpoint: null,
  https: false,
});

describe("SharePage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.siteList.mockResolvedValue([
      site("myapp.test"),
      site("api.test"),
    ]);
    mocks.tunnelStatus.mockImplementation((hostname: string) =>
      Promise.resolve({
        hostname,
        running: false,
        url: null,
      }),
    );
    mocks.tunnelStart.mockImplementation((hostname: string) =>
      Promise.resolve({
        hostname,
        running: true,
        url: null,
      }),
    );
    mocks.tunnelStop.mockImplementation((hostname: string) =>
      Promise.resolve({ hostname, running: false, url: null }),
    );
  });

  it("shows an empty state without sites", async () => {
    mocks.siteList.mockResolvedValue([]);

    renderWithProviders(<SharePage />);

    expect(
      await screen.findByText(/no sites to share yet/i),
    ).toBeInTheDocument();
  });

  it("lists every site as local only when nothing is shared", async () => {
    renderWithProviders(<SharePage />);

    expect(await screen.findByText("myapp.test")).toBeInTheDocument();
    expect(screen.getByText("api.test")).toBeInTheDocument();
    expect(screen.getAllByText(/local only/i).length).toBe(2);
  });

  it("starts a tunnel and shows the assigned URL once it appears", async () => {
    renderWithProviders(<SharePage />);

    // Both rows render a "Share" button; scope to the first row (myapp.test).
    const shareButtons = await screen.findAllByRole("button", {
      name: /^share$/i,
    });
    await userEvent.click(shareButtons[0]!);

    await waitFor(() => {
      expect(mocks.tunnelStart).toHaveBeenCalledWith("myapp.test");
    });
    expect(mocks.tunnelStart).toHaveBeenCalledTimes(1);
  });

  it("links the public URL of a running tunnel", async () => {
    mocks.tunnelStatus.mockImplementation((hostname: string) =>
      hostname === "myapp.test"
        ? Promise.resolve({
            hostname,
            running: true,
            url: "https://quiet-words-1234.trycloudflare.com",
          })
        : Promise.resolve({ hostname, running: false, url: null }),
    );

    renderWithProviders(<SharePage />);

    const link = await screen.findByRole("link", {
      name: /quiet-words-1234\.trycloudflare\.com/i,
    });
    expect(link).toHaveAttribute(
      "href",
      "https://quiet-words-1234.trycloudflare.com",
    );
    expect(screen.getAllByText(/local only/i).length).toBe(1);
  });

  it("shows the assigning placeholder while the URL is pending", async () => {
    mocks.tunnelStatus.mockImplementation((hostname: string) =>
      hostname === "myapp.test"
        ? Promise.resolve({ hostname, running: true, url: null })
        : Promise.resolve({ hostname, running: false, url: null }),
    );

    renderWithProviders(<SharePage />);

    expect(
      await screen.findByText(/assigning a public url/i),
    ).toBeInTheDocument();
  });

  it("stops a running share", async () => {
    mocks.tunnelStatus.mockImplementation((hostname: string) =>
      hostname === "myapp.test"
        ? Promise.resolve({
            hostname,
            running: true,
            url: "https://quiet-words-1234.trycloudflare.com",
          })
        : Promise.resolve({ hostname, running: false, url: null }),
    );

    renderWithProviders(<SharePage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /stop sharing/i }),
    );

    await waitFor(() => {
      expect(mocks.tunnelStop).toHaveBeenCalledWith("myapp.test");
    });
  });
});
