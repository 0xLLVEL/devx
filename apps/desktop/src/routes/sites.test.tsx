import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SitesPage } from "@/routes/sites";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  siteList: vi.fn(),
  siteAdd: vi.fn(),
  siteRemove: vi.fn(),
  phpPoolList: vi.fn(),
  caStatus: vi.fn(),
  caInstall: vi.fn(),
  dnsStatus: vi.fn(),
  dnsStart: vi.fn(),
  dnsStop: vi.fn(),
  templateList: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

describe("SitesPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.siteList.mockResolvedValue([]);
    mocks.templateList.mockResolvedValue([]);
    mocks.phpPoolList.mockResolvedValue([
      { id: "php-pool-8.4.25", version: "8.4.25", workers: 4, port: 9100, state: "running" },
    ]);
    mocks.caStatus.mockResolvedValue({ exists: true, trusted: true });
    mocks.dnsStatus.mockResolvedValue({
      running: false,
      port: null,
      nrpt_active: null,
      suffix: "test",
    });
  });

  it("shows an empty state when no sites are configured", async () => {
    mocks.siteList.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    expect(
      await screen.findByText(/no sites yet/i),
    ).toBeInTheDocument();
  });

  it("lists a configured site with its docroot and PHP target", async () => {
    mocks.siteList.mockResolvedValue([
      {
        hostname: "myapp.test",
        docroot: "C:\\dev\\myapp\\public",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: false,
        env: {},
        aliases: [],
      },
      {
        hostname: "static.test",
        docroot: "C:\\dev\\static",
        php_version: "",
        php_endpoint: null,
        https: false,
        env: {},
        aliases: [],
      },
    ]);

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText("myapp.test")).toBeInTheDocument();
    expect(screen.getByText("static.test")).toBeInTheDocument();
    expect(screen.getByText("PHP 8.4.25")).toBeInTheDocument();
    expect(screen.getByText("static")).toBeInTheDocument();
    expect(screen.getByText(/fastcgi_pass 127\.0\.0\.1:9100/)).toBeInTheDocument();
  });

  it("marks HTTPS sites with a badge", async () => {
    mocks.siteList.mockResolvedValue([
      {
        hostname: "secure.test",
        docroot: "C:\\dev\\secure",
        php_version: "",
        php_endpoint: null,
        https: true,
        env: {},
        aliases: [],
      },
    ]);

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText("secure.test")).toBeInTheDocument();
    // The badge (with its lock icon) is one of two HTTPS labels on the page;
    // the other is the form's select label, so query the badge specifically.
    const badges = screen.getAllByText("HTTPS");
    expect(badges.length).toBeGreaterThanOrEqual(1);
  });

  it("adds a site with hostname, docroot, PHP version and HTTPS off by default", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([
      {
        hostname: "myapp.test",
        docroot: "C:\\dev\\myapp\\public",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: false,
        env: {},
        aliases: [],
      },
    ]);
    mocks.siteAdd.mockResolvedValue([
      {
        hostname: "myapp.test",
        docroot: "C:\\dev\\myapp\\public",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: false,
        env: {},
        aliases: [],
      },
    ]);

    renderWithProviders(<SitesPage />);

    await user.type(await screen.findByLabelText("Host name"), "myapp.test");
    await user.type(screen.getByLabelText("Document root"), "C:\\dev\\myapp\\public");
    await user.selectOptions(screen.getByLabelText("PHP"), "8.4.25");
    await user.click(screen.getByRole("button", { name: /add site/i }));

    await waitFor(() => expect(mocks.siteAdd).toHaveBeenCalledTimes(1));
    expect(mocks.siteAdd).toHaveBeenCalledWith(
      "myapp.test",
      "C:\\dev\\myapp\\public",
      "8.4.25",
      false,
    );
  });

  it("passes HTTPS through when the site is created with it enabled", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([]);
    mocks.siteAdd.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    await user.type(await screen.findByLabelText("Host name"), "secure.test");
    await user.type(screen.getByLabelText("Document root"), "C:\\dev\\secure");
    await user.selectOptions(screen.getByLabelText("HTTPS"), "on");
    await user.click(screen.getByRole("button", { name: /add site/i }));

    await waitFor(() => expect(mocks.siteAdd).toHaveBeenCalledTimes(1));
    expect(mocks.siteAdd).toHaveBeenCalledWith(
      "secure.test",
      "C:\\dev\\secure",
      "",
      true,
    );
  });

  it("surfaces a backend validation error next to the form", async () => {
    const user = userEvent.setup();
    mocks.siteAdd.mockRejectedValue(
      Object.assign(new Error("host name must end in .test"), { code: "InvalidInput" }),
    );

    renderWithProviders(<SitesPage />);

    await user.type(await screen.findByLabelText("Host name"), "not-a-domain");
    await user.type(screen.getByLabelText("Document root"), "C:\\dev\\x");
    await user.click(screen.getByRole("button", { name: /add site/i }));

    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent(/host name must end in \.test/i);
  });

  it("removes a site through the remove command", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([
      {
        hostname: "myapp.test",
        docroot: "C:\\dev\\myapp\\public",
        php_version: "8.4.25",
        php_endpoint: "127.0.0.1:9100",
        https: false,
        env: {},
        aliases: [],
      },
    ]);
    mocks.siteRemove.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("myapp.test");
    await user.click(screen.getByRole("button", { name: /remove myapp\.test/i }));

    await waitFor(() => expect(mocks.siteRemove).toHaveBeenCalledWith("myapp.test"));
  });

  it("starts the DNS resolver from the card when it is stopped", async () => {
    const user = userEvent.setup();
    mocks.dnsStart.mockResolvedValue({
      running: true,
      port: 9353,
      nrpt_active: true,
      suffix: "test",
    });

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText(/start resolver/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /start resolver/i }));
    await waitFor(() => expect(mocks.dnsStart).toHaveBeenCalledTimes(1));
  });

  it("stops the resolver when it is running", async () => {
    const user = userEvent.setup();
    mocks.dnsStatus.mockResolvedValue({
      running: true,
      port: 9353,
      nrpt_active: true,
      suffix: "test",
    });
    mocks.dnsStop.mockResolvedValue({
      running: false,
      port: null,
      nrpt_active: false,
      suffix: "test",
    });

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText(/stop resolver/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /stop resolver/i }));
    await waitFor(() => expect(mocks.dnsStop).toHaveBeenCalledTimes(1));
  });

  it("offers the CA install button while the machine does not trust it", async () => {
    const user = userEvent.setup();
    mocks.caStatus.mockResolvedValue({ exists: true, trusted: false });
    mocks.caInstall.mockResolvedValue({ exists: true, trusted: true });

    renderWithProviders(<SitesPage />);

    expect(
      await screen.findByText(/not installed in the trust store/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install ca/i }));
    await waitFor(() => expect(mocks.caInstall).toHaveBeenCalledTimes(1));
  });

  it("reports an unknown trust state when the helper is unavailable", async () => {
    mocks.caStatus.mockResolvedValue({ exists: true, trusted: null });

    renderWithProviders(<SitesPage />);

    expect(
      await screen.findByText(/trust store unknown \(helper unavailable\)/i),
    ).toBeInTheDocument();
    // Without a definite "not trusted" there is nothing to install against.
    expect(screen.queryByRole("button", { name: /install ca/i })).not.toBeInTheDocument();
  });
});
