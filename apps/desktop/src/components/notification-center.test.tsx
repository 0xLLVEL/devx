import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { NotificationSlot } from "@/components/notification-center";
import type { NotificationEntry, NotificationList } from "@/lib/ipc";
import { renderWithProviders } from "@/test/render";

/**
 * §98's notification center.
 *
 * The panel is a view of what Rust decided, so these tests are about the
 * wiring — badge, entries, the two actions — and about the one rule that is
 * easy to get wrong: a failure stays until it is acknowledged.
 *
 * The `findBy*` calls below wait on a mocked IPC answer, and React Testing
 * Library gives such a query 1000ms by default. That default is a budget for a
 * page that has already settled, not for a reply: with 30 test files sharing
 * the box, the mocked promise can take longer than that to be flushed and
 * re-rendered, and the query then expires with the panel still in its
 * `isPending` skeleton — a busy machine reported as a bell that never named its
 * count. 8s is headroom over the slowest reply observed under load, and stays
 * inside the 15s `testTimeout`, so an element that is genuinely missing still
 * fails here rather than surfacing as a hung test.
 */
const ANSWER_TIMEOUT_MS = 8000;

const mocks = vi.hoisted(() => ({
  notificationsList: vi.fn(),
  notificationsMarkAllRead: vi.fn(),
  notificationsClear: vi.fn(),
  serviceMetrics: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const NOW = Math.floor(Date.now() / 1000);

function entry(overrides: Partial<NotificationEntry> = {}): NotificationEntry {
  return {
    at_unix: NOW - 120,
    id: "nginx",
    state: "running",
    exit: null,
    severity: "info",
    unread: true,
    ...overrides,
  };
}

/** A backend answer: `unread_count` is counted over every event, so it is
 * passed in rather than derived from the page of entries. */
function panel(overrides: Partial<NotificationList> = {}): NotificationList {
  const entries = overrides.entries ?? [entry()];
  return {
    entries,
    unread_count: entries.filter((item) => item.unread).length,
    recorded: entries.length,
    ...overrides,
  };
}

const FAILURE = entry({
  at_unix: NOW - 300,
  id: "mariadb",
  state: "failed",
  exit: "crashed",
  severity: "error",
  unread: true,
});

/** Everything read except the failure, which is what Rust returns after
 * "Mark all read": §98 keeps an error until it is acknowledged. */
const AFTER_MARK_ALL_READ = panel({
  entries: [entry({ unread: false }), { ...FAILURE, unread: true }],
  unread_count: 1,
  recorded: 2,
});

function renderSlot() {
  return renderWithProviders(<NotificationSlot />);
}

/** Opens the panel and waits for it to be on screen. */
async function openPanel(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /notifications/i }));
  await screen.findByText("Notifications");
}

/** Opens the panel and returns the list of recorded events inside it. */
async function openList(user: ReturnType<typeof userEvent.setup>) {
  await openPanel(user);
  return screen.findByRole(
    "list",
    { name: "Recorded service events" },
    { timeout: ANSWER_TIMEOUT_MS },
  );
}

describe("NotificationSlot (§98)", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.serviceMetrics.mockResolvedValue([]);
    mocks.notificationsList.mockResolvedValue(panel());
  });

  it("counts the unread notifications the backend reported on the bell", async () => {
    mocks.notificationsList.mockResolvedValue(
      panel({ entries: [entry(), entry()], unread_count: 3, recorded: 9 }),
    );

    renderSlot();

    const bell = await screen.findByRole(
      "button",
      { name: "Notifications: 3 unread" },
      { timeout: ANSWER_TIMEOUT_MS },
    );
    // The number is on the bell, and it counts what the list could not show.
    expect(bell).toHaveTextContent("3");
    expect(mocks.notificationsList).toHaveBeenCalledWith(50);
  });

  it("keeps naming the services that are failing right now", async () => {
    mocks.serviceMetrics.mockResolvedValue([
      { id: "redis", state: "failed", cpu_percent: 0, memory_bytes: 0, processes: 0 },
    ]);
    mocks.notificationsList.mockResolvedValue(panel({ unread_count: 2 }));

    renderSlot();

    // §118's live count and §98's unread count are different facts, and the
    // bell names both instead of dropping one when the other appears.
    expect(
      await screen.findByRole(
        "button",
        { name: "Notifications: 1 service failed, 2 unread" },
        { timeout: ANSWER_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
  });

  it("invents no count before the backend has answered", () => {
    mocks.notificationsList.mockReturnValue(new Promise(() => {}));

    renderSlot();

    const bell = screen.getByRole("button", { name: "Notifications" });
    expect(bell).toHaveTextContent("");
    expect(bell.querySelector("span")).toBeNull();
  });

  it("lists each recorded transition with its state and how long ago it happened", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(
      panel({
        entries: [
          entry({ id: "nginx", state: "running", at_unix: NOW - 120 }),
          FAILURE,
        ],
        recorded: 2,
      }),
    );

    renderSlot();
    const list = await openList(user);

    const rows = within(list).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    // Newest first, in the words the §42 timeline uses.
    expect(within(rows[0]!).getByText("Started nginx")).toBeInTheDocument();
    expect(within(rows[0]!).getByText("2 min ago")).toBeInTheDocument();
    // §55: the state and the exit reason are text, not a colour.
    expect(within(rows[0]!).getByText(/running/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("mariadb failed")).toBeInTheDocument();
    expect(within(rows[1]!).getByText(/exited unexpectedly/)).toBeInTheDocument();
    expect(within(rows[1]!).getByText("Error")).toBeInTheDocument();
  });

  it("marks the entries that are still unread, in words as well as in colour", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(
      panel({
        entries: [entry({ id: "nginx" }), entry({ id: "redis", unread: false })],
        recorded: 2,
      }),
    );

    renderSlot();
    const list = await openList(user);

    const rows = within(list).getAllByRole("listitem");
    // §55: the dot is decoration; "Unread" is what a screen reader hears.
    expect(within(rows[0]!).getByText("Unread")).toBeInTheDocument();
    expect(within(rows[1]!).queryByText("Unread")).not.toBeInTheDocument();
  });

  it("says nothing has happened yet instead of showing sample notifications", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(panel({ entries: [], recorded: 0 }));

    renderSlot();
    await openPanel(user);

    // No list at all, rather than an empty one pretending to be a list.
    expect(
      screen.queryByRole("list", { name: "Recorded service events" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("No service events yet.")).toBeInTheDocument();
    // §56: both actions have nothing to do, so both are unavailable.
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("tells 'cleared' apart from 'nothing ever happened'", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(panel({ entries: [], recorded: 12 }));

    renderSlot();
    await openPanel(user);

    expect(screen.getByText("Nothing to read.")).toBeInTheDocument();
    expect(screen.queryByText("No service events yet.")).not.toBeInTheDocument();
  });

  it("reports a backend that cannot be read, with a way to try again", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockRejectedValue(new Error("the log is unreadable"));

    renderSlot();
    await user.click(screen.getByRole("button", { name: "Notifications" }));

    expect(
      await screen.findByText(
        "Could not read the notifications.",
        {},
        { timeout: ANSWER_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  it("marks everything read through the backend and keeps the failure visible", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(panel({ unread_count: 3, recorded: 3 }));
    mocks.notificationsMarkAllRead.mockResolvedValue(AFTER_MARK_ALL_READ);

    renderSlot();
    const list = await openList(user);

    await user.click(screen.getByRole("button", { name: "Mark all read" }));

    await waitFor(() => expect(mocks.notificationsMarkAllRead).toHaveBeenCalledWith(50));
    // The failure is still listed, still unread, and the panel says why.
    expect(
      await within(list).findByText("mariadb failed", {}, { timeout: ANSWER_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(within(list).getByText("Unread")).toBeInTheDocument();
    expect(screen.getByText("A failure stays until you clear it.")).toBeInTheDocument();
    // The badge still counts it: §98 keeps errors until they are acknowledged.
    expect(
      screen.getByRole("button", { name: "Notifications: 1 unread" }),
    ).toBeInTheDocument();
  });

  it("disables Mark all read when only an unacknowledged failure is left", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(AFTER_MARK_ALL_READ);

    renderSlot();
    await openPanel(user);

    // Reading again could not change anything; Clear is the action that can.
    expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Clear" })).toBeEnabled();
  });

  it("clears through the backend and empties the panel", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(
      panel({ entries: [entry(), FAILURE], unread_count: 2, recorded: 2 }),
    );
    mocks.notificationsClear.mockResolvedValue(panel({ entries: [], recorded: 2 }));

    renderSlot();
    const list = await openList(user);
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => expect(mocks.notificationsClear).toHaveBeenCalledWith(50));
    // Gone from the panel, and honest that it was cleared rather than never
    // recorded — the timeline still has it.
    expect(
      await screen.findByText("Nothing to read.", {}, { timeout: ANSWER_TIMEOUT_MS }),
    ).toBeInTheDocument();
    expect(screen.queryByText("mariadb failed")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Notifications" })).toBeInTheDocument();
  });

  it("says so when an action could not be saved", async () => {
    const user = userEvent.setup();
    mocks.notificationsList.mockResolvedValue(panel());
    mocks.notificationsMarkAllRead.mockRejectedValue(new Error("disk is full"));

    renderSlot();
    await openPanel(user);

    await user.click(screen.getByRole("button", { name: "Mark all read" }));

    // §131 Rule 18: a refusal the user never reads is not feedback.
    expect(
      await screen.findByText(
        "Could not mark notifications as read",
        {},
        { timeout: ANSWER_TIMEOUT_MS },
      ),
    ).toBeInTheDocument();
  });
});
