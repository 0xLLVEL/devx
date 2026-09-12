import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MailPage } from "@/routes/mail";
import { renderWithProviders } from "@/test/render";

const mocks = vi.hoisted(() => ({
  mailStatus: vi.fn(),
  mailList: vi.fn(),
  mailMessage: vi.fn(),
  mailDelete: vi.fn(),
}));

vi.mock("@/lib/ipc", async () => {
  const actual = await vi.importActual<typeof import("@/lib/ipc")>("@/lib/ipc");
  return { ...actual, ipc: mocks };
});

const summary = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: "abc123",
  read: false,
  from: { name: "My App", address: "app@myapp.test" },
  to: [{ name: "", address: "user@example.com" }],
  subject: "Welcome!",
  created: "2026-09-12T10:30:00+02:00",
  size: 5120,
  attachments: 0,
  snippet: "Thanks for signing up",
  tags: [],
  ...overrides,
});

describe("MailPage", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.mailStatus.mockResolvedValue({
      running: true,
      port: 8025,
      smtp_port: 1025,
      total: 2,
      unread: 1,
    });
    mocks.mailList.mockResolvedValue([
      summary(),
      summary({
        id: "def456",
        read: true,
        subject: "Password reset",
      }),
    ]);
    mocks.mailMessage.mockResolvedValue({
      id: "abc123",
      from: { name: "My App", address: "app@myapp.test" },
      to: [{ name: "", address: "user@example.com" }],
      cc: [],
      bcc: [],
      subject: "Welcome!",
      date: "2026-09-12T10:30:00+02:00",
      text: "Thanks for signing up.",
      html: null,
      size: 5120,
      tags: [],
      attachments: [],
    });
    mocks.mailDelete.mockResolvedValue(undefined);
  });

  it("points at the SMTP port while running, with counters", async () => {
    renderWithProviders(<MailPage />);

    expect(
      await screen.findByText(/127\.0\.0\.1:1025/),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 unread of 2/)).toBeInTheDocument();
  });

  it("tells the user to start the service when stopped", async () => {
    mocks.mailStatus.mockResolvedValue({
      running: false,
      port: null,
      smtp_port: 1025,
      total: null,
      unread: null,
    });

    renderWithProviders(<MailPage />);

    expect(
      await screen.findByText(/start the mailpit service/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/inbox/i)).not.toBeInTheDocument();
  });

  it("lists messages with subjects and recipients", async () => {
    renderWithProviders(<MailPage />);

    expect(await screen.findByText("Welcome!")).toBeInTheDocument();
    expect(screen.getByText("Password reset")).toBeInTheDocument();
    expect(screen.getAllByText(/My App/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/user@example.com/).length).toBeGreaterThan(0);
  });

  it("opens a message and shows its text body", async () => {
    renderWithProviders(<MailPage />);

    await userEvent.click(await screen.findByText("Welcome!"));

    await waitFor(() => {
      expect(mocks.mailMessage).toHaveBeenCalledWith("abc123");
    });
    expect(
      await screen.findByText("Thanks for signing up."),
    ).toBeInTheDocument();
  });

  it("deletes a single message and refreshes the list", async () => {
    renderWithProviders(<MailPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /delete message welcome/i }),
    );

    await waitFor(() => {
      expect(mocks.mailDelete).toHaveBeenCalledWith(["abc123"]);
    });
  });

  it("clears the whole inbox with an empty id list", async () => {
    renderWithProviders(<MailPage />);

    await userEvent.click(
      await screen.findByRole("button", { name: /clear inbox/i }),
    );

    await waitFor(() => {
      expect(mocks.mailDelete).toHaveBeenCalledWith([]);
    });
  });
});
