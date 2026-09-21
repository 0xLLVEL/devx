import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { HostsButton } from "@/components/hosts-panel";
import { IpcError } from "@/lib/ipc";
import { renderWithProviders } from "@/test/render";

/**
 * §111 Hosts Manager.
 *
 * Beyond the happy path, three things are held to account here: that the panel
 * never implies it is showing the whole hosts file, that the elevation prompt
 * is announced before the buttons that raise it, and that nothing is removed
 * before the user confirms it by name.
 */

const mocks = vi.hoisted(() => ({
  hostsList: vi.fn(),
  hostsAdd: vi.fn(),
  hostsRemove: vi.fn(),
  hostsFlushDns: vi.fn(),
  hostsResync: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const LARAVEL = { hostname: "laravel.test", ip: "127.0.0.1" };
const NEXTJS = { hostname: "nextjs.local", ip: "127.0.0.1" };

/** The helper-not-running failure `hosts_list` reports. */
const helperDown = () =>
  new IpcError({
    code: "privileged",
    message:
      "the privileged helper is not running, so DevX cannot read the hosts entries it manages",
    hint: "elevated actions on this page bring the helper up after one Windows permission prompt",
  });

/** Opens the manager through the button the product actually ships. */
async function openManager(user = userEvent.setup()) {
  renderWithProviders(<HostsButton />);
  await user.click(screen.getByRole("button", { name: "Hosts entries" }));
  return user;
}

/** The row of the entries table for `hostname`. */
async function row(hostname: string): Promise<HTMLElement> {
  const cell = await screen.findByText(hostname);
  return cell.closest("tr") as HTMLElement;
}

describe("HostsManager", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.hostsList.mockResolvedValue([]);
    mocks.hostsAdd.mockResolvedValue([]);
    mocks.hostsRemove.mockResolvedValue([]);
    mocks.hostsFlushDns.mockResolvedValue(null);
    mocks.hostsResync.mockResolvedValue([]);
  });

  it("reads the entries only once the dialog is open", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HostsButton />);

    // Closed: no helper round trip, nothing on screen.
    expect(mocks.hostsList).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Hosts entries" }));

    await waitFor(() => expect(mocks.hostsList).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("dialog")).toHaveAccessibleName("Hosts entries");
  });

  it("lists the managed entries and says the list is not the whole hosts file", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL, NEXTJS]);
    await openManager();

    const laravel = await row("laravel.test");
    expect(within(laravel).getByText("127.0.0.1")).toBeInTheDocument();
    await row("nextjs.local");

    // The scope of the panel is stated, not implied: a user reading this list
    // must not conclude that these are the machine's only hosts entries.
    const dialog = screen.getByRole("dialog", { name: "Hosts entries" });
    expect(
      within(dialog).getByText(/entries you or other software added are not listed/i),
    ).toBeInTheDocument();
  });

  it("announces the permission prompt before any action that can raise it", async () => {
    await openManager();

    const dialog = screen.getByRole("dialog", { name: "Hosts entries" });
    expect(
      within(dialog).getByText(/Windows may ask for administrator permission/i),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/declining that prompt applies nothing and changes nothing/i),
    ).toBeInTheDocument();
  });

  it("says DevX manages nothing rather than that the file is empty (§38)", async () => {
    await openManager();

    const empty = await screen.findByText("DevX does not manage any hosts entries.");
    expect(empty).toBeInTheDocument();
    // The empty state still offers the way off it.
    expect(screen.getByRole("button", { name: "Add entry" })).toBeInTheDocument();
  });

  it("explains an unreadable list and offers a retry instead of an add form (§131 Rule 18)", async () => {
    mocks.hostsList.mockRejectedValueOnce(helperDown());
    const user = await openManager();

    expect(
      await screen.findByText("Could not read the hosts entries."),
    ).toBeInTheDocument();
    expect(screen.getByText(/the privileged helper is not running/i)).toBeInTheDocument();
    expect(screen.getByText(/one Windows permission prompt/i)).toBeInTheDocument();

    // No form is offered while the list is unread: an Add button here would
    // look like it works and then fail on the permission prompt.
    expect(screen.queryByRole("button", { name: "Add entry" })).not.toBeInTheDocument();

    mocks.hostsList.mockResolvedValue([LARAVEL]);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    await row("laravel.test");
    expect(mocks.hostsList).toHaveBeenCalledTimes(2);
  });

  it("adds an entry and shows the list the helper returned", async () => {
    mocks.hostsAdd.mockResolvedValue([LARAVEL]);
    const user = await openManager();

    await user.click(await screen.findByRole("button", { name: "Add entry" }));
    await user.type(screen.getByLabelText("Host name"), "laravel.test");
    await user.clear(screen.getByLabelText("IP address"));
    await user.type(screen.getByLabelText("IP address"), "127.0.0.1");
    await user.click(screen.getByRole("button", { name: "Add entry" }));

    await waitFor(() =>
      expect(mocks.hostsAdd).toHaveBeenCalledWith("laravel.test", "127.0.0.1"),
    );
    await row("laravel.test");
    // The form closes on success, so the entry is the only thing left to read.
    expect(screen.queryByLabelText("Host name")).not.toBeInTheDocument();
  });

  it("edits an address in place with a single add", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    mocks.hostsAdd.mockResolvedValue([{ ...LARAVEL, ip: "127.0.0.99" }]);
    const user = await openManager();

    await row("laravel.test");
    await user.click(screen.getByRole("button", { name: "Edit laravel.test" }));

    expect(screen.getByLabelText("Host name")).toHaveValue("laravel.test");
    expect(screen.getByLabelText("IP address")).toHaveValue("127.0.0.1");

    await user.clear(screen.getByLabelText("IP address"));
    await user.type(screen.getByLabelText("IP address"), "127.0.0.99");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(mocks.hostsAdd).toHaveBeenCalledWith("laravel.test", "127.0.0.99"),
    );
    // The name did not move, so nothing needs removing.
    expect(mocks.hostsRemove).not.toHaveBeenCalled();
    await row("laravel.test");
  });

  it("renames by adding the new name before removing the old one", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    // Recorded rather than read off `invocationCallOrder`: the order is the
    // assertion, so it is worth seeing in the test itself.
    const order: string[] = [];
    mocks.hostsAdd.mockImplementation(async () => {
      order.push("add");
      return [LARAVEL, { hostname: "api.test", ip: "127.0.0.1" }];
    });
    mocks.hostsRemove.mockImplementation(async () => {
      order.push("remove");
      return [{ hostname: "api.test", ip: "127.0.0.1" }];
    });
    const user = await openManager();

    await row("laravel.test");
    await user.click(screen.getByRole("button", { name: "Edit laravel.test" }));
    await user.clear(screen.getByLabelText("Host name"));
    await user.type(screen.getByLabelText("Host name"), "api.test");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mocks.hostsRemove).toHaveBeenCalledWith("laravel.test"));
    expect(mocks.hostsAdd).toHaveBeenCalledWith("api.test", "127.0.0.1");

    // Order is the point: a refused new name must not cost the old entry.
    expect(order).toEqual(["add", "remove"]);
  });

  it("does not remove an entry before the confirmation is accepted", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    mocks.hostsRemove.mockResolvedValue([]);
    const user = await openManager();

    await row("laravel.test");
    await user.click(screen.getByRole("button", { name: "Remove laravel.test" }));

    // The confirmation names the entry and what it will change.
    const confirm = await screen.findByRole("dialog", { name: "Remove laravel.test?" });
    expect(within(confirm).getByText(/stops resolving to 127\.0\.0\.1/)).toBeInTheDocument();
    expect(within(confirm).getByText(/administrator permission/i)).toBeInTheDocument();
    expect(mocks.hostsRemove).not.toHaveBeenCalled();

    await user.click(within(confirm).getByRole("button", { name: "Remove entry" }));

    await waitFor(() => expect(mocks.hostsRemove).toHaveBeenCalledWith("laravel.test"));
  });

  it("cancels without removing anything", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    const user = await openManager();

    await row("laravel.test");
    await user.click(screen.getByRole("button", { name: "Remove laravel.test" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove laravel.test?" })).getByRole(
        "button",
        { name: "Cancel" },
      ),
    );

    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Remove laravel.test?" }),
      ).not.toBeInTheDocument(),
    );
    expect(mocks.hostsRemove).not.toHaveBeenCalled();
    await row("laravel.test");
  });

  it("reports a refused removal as feedback instead of looking like it worked (§54)", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    mocks.hostsRemove.mockRejectedValue(
      new IpcError({
        code: "privileged",
        message: "the user declined the elevation prompt",
        hint: "run DevX as administrator, or accept the prompt",
      }),
    );
    const user = await openManager();

    await row("laravel.test");
    await user.click(screen.getByRole("button", { name: "Remove laravel.test" }));
    await user.click(
      within(await screen.findByRole("dialog", { name: "Remove laravel.test?" })).getByRole(
        "button",
        { name: "Remove entry" },
      ),
    );

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("laravel.test was not removed")).toBeInTheDocument();
    expect(within(alert).getByText(/declined the elevation prompt/i)).toBeInTheDocument();
  });

  it("flushes the DNS cache and says so (§111)", async () => {
    mocks.hostsList.mockResolvedValue([LARAVEL]);
    const user = await openManager();

    await user.click(screen.getByRole("button", { name: "Flush DNS" }));

    await waitFor(() => expect(mocks.hostsFlushDns).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("DNS cache flushed")).toBeInTheDocument();
  });

  it("re-syncs stale entries with their owning servers and says so", async () => {
    const stale = { hostname: "mtdb.test", ip: "127.0.0.1" };
    const fixed = { hostname: "mtdb.test", ip: "127.0.0.2" };
    mocks.hostsList.mockResolvedValue([stale]);
    mocks.hostsResync.mockResolvedValue([fixed]);
    const user = await openManager();

    await row("mtdb.test");
    await user.click(screen.getByRole("button", { name: "Re-sync with sites" }));

    await waitFor(() => expect(mocks.hostsResync).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Hosts entries re-synced with your sites")).toBeInTheDocument();
    expect(await row("mtdb.test")).toBeInTheDocument();
  });

  it("reports a refused flush instead of a silent success", async () => {
    mocks.hostsFlushDns.mockRejectedValue(
      new IpcError({
        code: "privileged",
        message: "`ipconfig /flushdns` said: The requested operation requires elevation.",
        hint: "the DNS cache can only be flushed by an elevated process",
      }),
    );
    const user = await openManager();

    await user.click(screen.getByRole("button", { name: "Flush DNS" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("The DNS cache was not flushed")).toBeInTheDocument();
    expect(within(alert).getByText(/requires elevation/i)).toBeInTheDocument();
  });

  it("keeps a refused add visible so the values can be corrected", async () => {
    mocks.hostsAdd.mockRejectedValue(
      new IpcError({
        code: "conflict",
        message: "`corporate-thing` is already mapped by a line outside DevX's control",
        hint: "remove the existing hosts entry manually, then let DevX manage it",
      }),
    );
    const user = await openManager();

    await user.click(await screen.findByRole("button", { name: "Add entry" }));
    await user.type(screen.getByLabelText("Host name"), "corporate-thing");
    await user.click(screen.getByRole("button", { name: "Add entry" }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("corporate-thing was not added")).toBeInTheDocument();

    // The form is still there with what the user typed, so the fix is an edit
    // rather than a retype.
    expect(screen.getByLabelText("Host name")).toHaveValue("corporate-thing");
  });
});
