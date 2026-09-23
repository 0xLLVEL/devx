import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SitesPage } from "@/routes/sites";
import { renderWithProviders } from "@/test/render";
import { configFixture } from "@/test/fixtures";

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
  configGet: vi.fn(),
  templateList: vi.fn(),
  installedVersions: vi.fn(),
  pickDirectory: vi.fn(),
  openInBrowser: vi.fn(),
  openFolder: vi.fn(),
  hostsList: vi.fn(),
  hostsAdd: vi.fn(),
  hostsRemove: vi.fn(),
  hostsFlushDns: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

vi.mock("@/lib/pick-directory", () => ({ pickDirectory: mocks.pickDirectory }));
vi.mock("@/lib/open-url", () => ({ openInBrowser: mocks.openInBrowser }));
vi.mock("@/lib/open-folder", () => ({ openFolder: mocks.openFolder }));

/** One site as `site_list` reports it. */
function site(overrides: Partial<Record<string, unknown>> = {}) {
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

describe("SitesPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    // The docroot comes from the native folder dialog; each test sets the
    // path it "picked", or leaves the mock returning nothing (a cancel).
    mocks.pickDirectory.mockResolvedValue(undefined);
    mocks.openFolder.mockResolvedValue(null);
    mocks.siteList.mockResolvedValue([]);
    mocks.configGet.mockResolvedValue(configFixture());
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
    mocks.installedVersions.mockResolvedValue([]);
    mocks.hostsList.mockResolvedValue([]);
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
      site(),
      site({
        hostname: "static.test",
        docroot: "C:\\dev\\static",
        php_version: "",
        php_endpoint: null,
      }),
    ]);

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText("myapp.test")).toBeInTheDocument();
    expect(screen.getByText("static.test")).toBeInTheDocument();
    expect(screen.getByText("PHP 8.4.25")).toBeInTheDocument();
    expect(screen.getByText("static")).toBeInTheDocument();

    // The FastCGI endpoint is detail-pane data (route hop + Runtime kv).
    await userEvent.click(screen.getByRole("button", { name: /edit myapp\.test/i }));
    expect(await screen.findByText(/127\.0\.0\.1:9100/)).toBeInTheDocument();
  });

  it("shows each site's URL with the scheme it is served on (§23)", async () => {
    mocks.siteList.mockResolvedValue([
      site(),
      site({ hostname: "secure.test", https: true, php_version: "", php_endpoint: null, url: "https://secure.test" }),
    ]);

    renderWithProviders(<SitesPage />);

    await userEvent.click(await screen.findByRole("button", { name: /edit myapp\.test/i }));
    expect((await screen.findAllByText("http://myapp.test")).length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: /edit secure\.test/i }));
    expect((await screen.findAllByText("https://secure.test")).length).toBeGreaterThan(0);
  });

  it("marks HTTPS sites with a badge", async () => {
    mocks.siteList.mockResolvedValue([site({ hostname: "secure.test", https: true })]);

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText("secure.test")).toBeInTheDocument();
    // The badge in the "Serves" column carries the lock icon; no form is on
    // screen while the create dialog is closed, so nothing else says HTTPS.
    expect(screen.getByText("HTTPS")).toBeInTheDocument();
  });

  it("adds a site with hostname, docroot, PHP version and HTTPS off by default", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site()]);
    mocks.siteAdd.mockResolvedValue([site()]);

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    await user.type(await screen.findByLabelText("Host name"), "myapp.test");
    mocks.pickDirectory.mockResolvedValue("C:\\dev\\myapp\\public");
    await user.click(screen.getByRole("button", { name: /^browse/i }));
    await user.selectOptions(screen.getByLabelText("PHP"), "8.4.25");
    await user.click(screen.getByRole("button", { name: /^create site$/i }));

    await waitFor(() => expect(mocks.siteAdd).toHaveBeenCalledTimes(1));
    expect(mocks.siteAdd).toHaveBeenCalledWith(
      "myapp.test",
      "C:\\dev\\myapp\\public",
      "8.4.25",
      false,
      "Nginx",
    );
  });

  it("passes HTTPS through when the site is created with it enabled", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([]);
    mocks.siteAdd.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    await user.type(await screen.findByLabelText("Host name"), "secure.test");
    mocks.pickDirectory.mockResolvedValue("C:\\dev\\secure");
    await user.click(screen.getByRole("button", { name: /^browse/i }));
    // §24 asks for a toggle, so HTTPS is the §51 switch rather than a select.
    await user.click(screen.getByRole("switch", { name: "HTTPS" }));
    await user.click(screen.getByRole("button", { name: /^create site$/i }));

    await waitFor(() => expect(mocks.siteAdd).toHaveBeenCalledTimes(1));
    expect(mocks.siteAdd).toHaveBeenCalledWith(
      "secure.test",
      "C:\\dev\\secure",
      "",
      true,
      "Nginx",
    );
  });

  it("surfaces a backend validation error inside the dialog", async () => {
    const user = userEvent.setup();
    mocks.siteAdd.mockRejectedValue(
      Object.assign(new Error("host name must end in .test"), { code: "InvalidInput" }),
    );

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Host name"), "not-a-domain");
    mocks.pickDirectory.mockResolvedValue("C:\\dev\\x");
    await user.click(within(dialog).getByRole("button", { name: /^browse/i }));
    await user.click(within(dialog).getByRole("button", { name: /^create site$/i }));

    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      /host name must end in \.test/i,
    );
    // §36/§77: the failure also reaches the notification stack with the
    // backend's own message behind "View Details".
    expect(await screen.findByText(/could not add the site/i)).toBeInTheDocument();
  });

  it("offers the retry for the PHP list inside the dialog that needs it (§39)", async () => {
    const user = userEvent.setup();
    mocks.phpPoolList.mockRejectedValueOnce(new Error("pool list unavailable"));

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");

    expect(
      await within(dialog).findByText("Could not read the PHP versions."),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("pool list unavailable")).toBeInTheDocument();

    mocks.phpPoolList.mockResolvedValue([
      { id: "php-pool-8.4.25", version: "8.4.25", workers: 4, port: 9100, state: "running" },
    ]);
    await user.click(within(dialog).getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(
        within(dialog).queryByText("Could not read the PHP versions."),
      ).not.toBeInTheDocument(),
    );
    expect(within(dialog).getByRole("option", { name: "8.4.25" })).toBeInTheDocument();
  });

  it("closes the create dialog with Cancel and leaves no fields behind", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^cancel$/i }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(screen.queryByLabelText("Host name")).not.toBeInTheDocument();
    expect(mocks.siteAdd).not.toHaveBeenCalled();
  });

  it("closes the create dialog when the platform reports it cancelled", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");

    // jsdom never emits `cancel` for the Escape key, so the browser's own
    // dismissal path is fired directly here; the key itself is verified by
    // hand in the WebView2 (see the report).
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("closes the create dialog from its own close button", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("will not submit a site without a host name and a document root", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: /^create site$/i });

    expect(submit).toBeDisabled();

    await user.type(within(dialog).getByLabelText("Host name"), "myapp.test");
    expect(submit).toBeDisabled();

    mocks.pickDirectory.mockResolvedValue("C:\\dev\\myapp\\public");
    await user.click(within(dialog).getByRole("button", { name: /^browse/i }));
    await waitFor(() => expect(submit).toBeEnabled());
  });

  it("keeps the web server choice collapsed under Advanced (§90)", async () => {
    const user = userEvent.setup();

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /add site/i }));
    const dialog = await screen.findByRole("dialog");

    // The five fields `site_add` accepts are the five fields on show; the one
    // supported choice outside the common path is disclosed, not deleted.
    expect(within(dialog).getByLabelText("Host name")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("PHP")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("HTTPS")).toBeInTheDocument();

    const advanced = within(dialog).getByText("Advanced").closest("details");
    expect(advanced).not.toBeNull();
    expect(advanced).not.toHaveAttribute("open");

    await user.click(within(dialog).getByText("Advanced"));
    expect(within(dialog).getByLabelText("Web server")).toBeInTheDocument();
    await user.selectOptions(within(dialog).getByLabelText("Web server"), "Caddy");

    await user.type(within(dialog).getByLabelText("Host name"), "caddy.test");
    mocks.pickDirectory.mockResolvedValue("C:\\dev\\caddy");
    await user.click(within(dialog).getByRole("button", { name: /^browse/i }));
    mocks.siteAdd.mockResolvedValue([]);
    await user.click(within(dialog).getByRole("button", { name: /^create site$/i }));

    await waitFor(() =>
      expect(mocks.siteAdd).toHaveBeenCalledWith(
        "caddy.test",
        "C:\\dev\\caddy",
        "",
        false,
        "Caddy",
      ),
    );
  });

  it("filters the table by runtime and clears the filters again (§61)", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([
      site(),
      site({
        hostname: "static.test",
        docroot: "C:\\dev\\static",
        php_version: "",
        php_endpoint: null,
      }),
      site({ hostname: "legacy.test", php_version: "8.1.0", web_server: "Caddy" }),
    ]);

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText("legacy.test")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Runtime"), "8.4.25");
    await waitFor(() => expect(screen.queryByText("static.test")).not.toBeInTheDocument());
    expect(screen.getByText("myapp.test")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("Server"), "Caddy");
    // Two filters are active now, so the single Clear filters control appears.
    await user.click(screen.getByRole("button", { name: /clear filters/i }));

    await waitFor(() => expect(screen.getByText("static.test")).toBeInTheDocument());
    expect(screen.getByText("legacy.test")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear filters/i })).not.toBeInTheDocument();
  });

  it("narrows the table with the search box and says so when nothing matches", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site(), site({ hostname: "other.test" })]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("other.test");
    await user.type(screen.getByLabelText("Search sites"), "nomatch");

    expect(await screen.findByText(/no site matches these filters/i)).toBeInTheDocument();
    expect(screen.queryByText("other.test")).not.toBeInTheDocument();
  });

  it("removes a site only after the confirmation names what stays on disk", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site()]);
    mocks.siteRemove.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("myapp.test");
    await user.click(screen.getByRole("button", { name: /edit myapp\.test/i }));
    await user.click(screen.getByRole("button", { name: /more actions for myapp\.test/i }));
    await user.click(await screen.findByRole("menuitem", { name: /remove site/i }));

    const dialog = await screen.findByRole("dialog");
    // §35/§78: the confirmation states the consequence and the path that is
    // not touched, never "are you sure?".
    expect(within(dialog).getByText(/stays on disk, untouched/i)).toBeInTheDocument();
    expect(within(dialog).getByText("C:\\dev\\myapp\\public")).toBeInTheDocument();

    expect(mocks.siteRemove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: /^remove site$/i }));

    await waitFor(() => expect(mocks.siteRemove).toHaveBeenCalledWith("myapp.test"));
  });

  it("opens a site in the browser and its folder from the detail actions (§91)", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site({ https: true, url: "https://myapp.test" })]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("myapp.test");
    await user.click(screen.getByRole("button", { name: /edit myapp\.test/i }));
    await user.click(screen.getByRole("button", { name: /open myapp\.test in browser/i }));
    expect(mocks.openInBrowser).toHaveBeenCalledWith("https://myapp.test");

    await user.click(screen.getByRole("button", { name: /more actions for myapp\.test/i }));
    await user.click(await screen.findByRole("menuitem", { name: /open folder/i }));
    expect(mocks.openFolder).toHaveBeenCalledWith("C:\\dev\\myapp\\public");
  });

  it("copies the URL from the detail headrow", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site()]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("myapp.test");
    await user.click(screen.getByRole("button", { name: /edit myapp\.test/i }));
    await user.click(screen.getByRole("button", { name: /copy url for myapp\.test/i }));
    await waitFor(() => expect(mocks.openInBrowser).not.toHaveBeenCalled());
    expect(await screen.findByText("URL copied")).toBeInTheDocument();
  });

  it("opens whatever URL the backend resolved (bare on owner loopback)", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([
      site({ hostname: "mtdb.test", web_server: "Apache", port: 8085, url: "http://mtdb.test" }),
    ]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("mtdb.test");
    await user.click(screen.getByRole("button", { name: /edit mtdb\.test/i }));
    await user.click(screen.getByRole("button", { name: /open mtdb\.test in browser/i }));
    expect(mocks.openInBrowser).toHaveBeenCalledWith("http://mtdb.test");
  });

  it("opens the direct :port URL when the backend says so (custom port)", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([
      site({ hostname: "mtdb.test", web_server: "Apache", port: 8085, url: "http://mtdb.test:8085" }),
    ]);

    renderWithProviders(<SitesPage />);

    await screen.findByText("mtdb.test");
    await user.click(screen.getByRole("button", { name: /edit mtdb\.test/i }));
    await user.click(screen.getByRole("button", { name: /open mtdb\.test in browser/i }));
    expect(mocks.openInBrowser).toHaveBeenCalledWith("http://mtdb.test:8085");
  });

  it("opens the row's own actions by right-clicking it (§47)", async () => {
    const user = userEvent.setup();
    mocks.siteList.mockResolvedValue([site()]);
    mocks.siteRemove.mockResolvedValue([]);

    renderWithProviders(<SitesPage />);

    const row = (await screen.findByText("myapp.test")).closest(".group");
    expect(row).not.toBeNull();
    fireEvent.contextMenu(row!, { clientX: 44, clientY: 70 });

    // The same list the row's overflow menu shows — nothing invented — and the
    // destructive entry stays last.
    const menu = await screen.findByRole("menu", {
      name: "Actions for myapp.test",
    });
    expect(
      within(menu)
        .getAllByRole("menuitem")
        .map((item) => item.textContent),
    ).toEqual(["Open folder", "Copy URL", "Remove site"]);

    await user.click(within(menu).getByRole("menuitem", { name: /remove site/i }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("opens the behavior editor on click and saves through site_add", async () => {
    const user = userEvent.setup();
    mocks.siteAdd.mockResolvedValue([]);
    mocks.siteList.mockResolvedValue([site()]);

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /edit myapp.test/i }));

    expect(await screen.findByText("Behavior")).toBeInTheDocument();
    expect(
      document.getElementById("edit-docroot-myapp.test")?.textContent,
    ).toBe("C:\\dev\\myapp\\public");

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(mocks.siteAdd).toHaveBeenCalledWith(
        "myapp.test",
        "C:\\dev\\myapp\\public",
        "8.4.25",
        false,
        "Nginx",
      );
    });
  });

  it("starts the DNS resolver from the status strip when it is stopped", async () => {
    const user = userEvent.setup();
    mocks.configGet.mockResolvedValue({
      ...configFixture(),
      network: { ...configFixture().network, dns_mode: "resolver" },
    });
    mocks.dnsStart.mockResolvedValue({
      running: true,
      port: 9353,
      nrpt_active: true,
      suffix: "test",
    });

    renderWithProviders(<SitesPage />);

    expect(await screen.findByText(/resolver off/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /start/i }));
    await waitFor(() => expect(mocks.dnsStart).toHaveBeenCalledTimes(1));
  });

  it("stops the resolver when it is running", async () => {
    const user = userEvent.setup();
    mocks.configGet.mockResolvedValue({
      ...configFixture(),
      network: { ...configFixture().network, dns_mode: "resolver" },
    });
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

    expect(await screen.findByText(/resolver on/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /stop/i }));
    await waitFor(() => expect(mocks.dnsStop).toHaveBeenCalledTimes(1));
  });

  it("offers the CA install action while the machine does not trust it", async () => {
    const user = userEvent.setup();
    mocks.caStatus.mockResolvedValue({ exists: true, trusted: false });
    mocks.caInstall.mockResolvedValue({ exists: true, trusted: true });

    renderWithProviders(<SitesPage />);

    expect(
      await screen.findByText(/ca not installed/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /install ca/i }));
    await waitFor(() => expect(mocks.caInstall).toHaveBeenCalledTimes(1));
  });

  it("reports an unknown trust state when the helper is unavailable", async () => {
    mocks.caStatus.mockResolvedValue({ exists: true, trusted: null });

    renderWithProviders(<SitesPage />);

    expect(
      await screen.findByText(/ca trust unknown/i),
    ).toBeInTheDocument();
    // Without a definite "not trusted" there is nothing to install against.
    expect(screen.queryByRole("button", { name: /install ca/i })).not.toBeInTheDocument();
  });

  it("switches to template scaffolding when clicking Import from template in Add site dialog", async () => {
    const user = userEvent.setup();
    mocks.templateList.mockResolvedValue([
      {
        id: "laravel",
        name: "Laravel",
        description: "Scaffolding runs through composer.",
        local: false,
      },
      {
        id: "static",
        name: "Static site",
        description: "A single index.html page.",
        local: true,
      },
    ]);

    renderWithProviders(<SitesPage />);

    await user.click(await screen.findByRole("button", { name: /\+? ?add site/i }));
    const dialog = await screen.findByRole("dialog", { name: "Add a site" });

    const importBtn = within(dialog).getByRole("button", { name: /import from template/i });
    expect(importBtn).toBeInTheDocument();

    await user.click(importBtn);

    expect(await within(dialog).findByText("Choose template")).toBeInTheDocument();
    expect(within(dialog).getByText("Laravel")).toBeInTheDocument();
    expect(within(dialog).getByText("Static site")).toBeInTheDocument();

    const manualBtn = within(dialog).getByRole("button", { name: /manual configuration/i });
    expect(manualBtn).toBeInTheDocument();
    await user.click(manualBtn);

    expect(within(dialog).queryByText("Choose template")).not.toBeInTheDocument();
  });
});
