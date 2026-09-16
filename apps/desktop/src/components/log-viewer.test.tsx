import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { LogViewer, parseLogLine, type LogLine } from "@/components/log-viewer";
import { renderWithProviders } from "@/test/render";

function line(id: string, text: string, stream?: "stdout" | "stderr"): LogLine {
  return { id, text, stream };
}

describe("parseLogLine", () => {
  it("takes the timestamp and level §22 prints, and leaves the message", () => {
    expect(parseLogLine("21:44:01 INFO  Server started")).toEqual({
      time: "21:44:01",
      severity: "INFO",
      message: "Server started",
    });
  });

  it("reads the bracketed level nginx writes", () => {
    expect(parseLogLine("2026/09/16 21:44:05 [error] 1234#0: connect() failed")).toEqual({
      time: "2026/09/16 21:44:05",
      severity: "ERROR",
      message: "1234#0: connect() failed",
    });
  });

  it("normalises an alias onto §22's five names", () => {
    expect(parseLogLine("WARNING port 3306 already in use").severity).toBe("WARN");
  });

  it("invents neither a timestamp nor a level for a bare line", () => {
    expect(parseLogLine("Listening on 127.0.0.1:8080")).toEqual({
      time: null,
      severity: null,
      message: "Listening on 127.0.0.1:8080",
    });
  });
});

describe("LogViewer", () => {
  it("renders severity as text, so colour is never the only signal", () => {
    renderWithProviders(
      <LogViewer
        lines={[
          line("1", "21:44:07 ERROR Failed to start worker"),
          line("2", "21:44:02 INFO  Listening on 127.0.0.1:8080"),
        ]}
      />,
    );

    // Scoped to the log itself: the level filter lists the same names.
    const log = within(screen.getByRole("log"));
    expect(log.getByText("ERROR")).toBeInTheDocument();
    expect(log.getByText("INFO")).toBeInTheDocument();
    expect(log.getByText("Failed to start worker")).toBeInTheDocument();
  });

  it("narrows the view by search and reports how much of the log is left", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LogViewer
        lines={[
          line("1", "21:44:01 INFO Server started"),
          line("2", "21:44:02 WARN Port 3306 already in use"),
          line("3", "21:44:03 INFO Ready"),
        ]}
      />,
    );

    await user.type(screen.getByLabelText(/search log lines/i), "3306");

    expect(screen.getByText("1 of 3 lines")).toBeInTheDocument();
    expect(screen.queryByText("Server started")).not.toBeInTheDocument();
    expect(screen.getByText(/port 3306 already in use/i)).toBeInTheDocument();
  });

  it("filters by level, and only offers levels the log actually states", async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <LogViewer
        lines={[
          line("1", "21:44:01 INFO Server started"),
          line("2", "21:44:07 ERROR Failed to start worker"),
        ]}
      />,
    );

    const select = screen.getByLabelText(/filter lines by level/i);
    // DEBUG and TRACE never appear in this feed, so they are not offered.
    expect(screen.queryByRole("option", { name: "DEBUG" })).not.toBeInTheDocument();

    await user.selectOptions(select, "ERROR");

    expect(screen.getByText("Failed to start worker")).toBeInTheDocument();
    expect(screen.queryByText("Server started")).not.toBeInTheDocument();
  });

  it("hides the level control entirely when no line states a level", () => {
    renderWithProviders(<LogViewer lines={[line("1", "listening on :9100")]} />);

    expect(
      screen.queryByLabelText(/filter lines by level/i),
    ).not.toBeInTheDocument();
  });

  it("pauses and resumes the feed instead of only hiding new lines", async () => {
    const user = userEvent.setup();
    const onPausedChange = vi.fn();

    renderWithProviders(
      <LogViewer lines={[line("1", "INFO started")]} paused={false} onPausedChange={onPausedChange} />,
    );

    expect(screen.getByText("Live")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /pause/i }));
    expect(onPausedChange).toHaveBeenCalledWith(true);
  });

  it("says it is paused, and offers Resume", () => {
    renderWithProviders(
      <LogViewer lines={[line("1", "INFO started")]} paused onPausedChange={vi.fn()} />,
    );

    expect(screen.getByText(/paused — the feed is stopped/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /resume/i })).toBeInTheDocument();
  });

  it("clears the view through the caller", async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();

    renderWithProviders(<LogViewer lines={[line("1", "INFO started")]} onClear={onClear} />);

    await user.click(screen.getByRole("button", { name: /clear/i }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it("follows the newest line while auto-scroll is on, and stops when it is off", async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <LogViewer lines={[line("1", "INFO first")]} />,
    );

    const area = screen.getByRole("log");
    // jsdom reports no layout, so the scroll height is stubbed to give the
    // follow behaviour something real to move to.
    Object.defineProperty(area, "scrollHeight", { value: 480, configurable: true });
    area.scrollTop = 0;

    rerender(<LogViewer lines={[line("1", "INFO first"), line("2", "INFO second")]} />);
    await waitFor(() => expect(area.scrollTop).toBe(480));

    await user.click(screen.getByRole("switch", { name: /follow new lines/i }));
    area.scrollTop = 0;

    rerender(
      <LogViewer
        lines={[line("1", "INFO first"), line("2", "INFO second"), line("3", "INFO third")]}
      />,
    );

    // The toggle is off: a new line must not move the viewport any more.
    await waitFor(() => expect(screen.getByText("third")).toBeInTheDocument());
    expect(area.scrollTop).toBe(0);
  });

  it("copies exactly the lines in view", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderWithProviders(
      <LogViewer
        lines={[line("1", "INFO started"), line("2", "ERROR failed")]}
        title="nginx.log"
      />,
    );

    await user.type(screen.getByLabelText(/search nginx\.log/i), "ERROR");
    await user.click(screen.getByRole("button", { name: /copy/i }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith("ERROR failed"));
    expect(await screen.findByText(/copied 1 line/i)).toBeInTheDocument();
  });

  it("marks standard error with a word, not a colour", () => {
    renderWithProviders(<LogViewer lines={[line("1", "boom", "stderr")]} />);

    expect(screen.getByText("err")).toBeInTheDocument();
  });

  it("leaves out the controls a caller did not wire up", () => {
    renderWithProviders(<LogViewer lines={[]} emptyMessage="Nothing captured yet." />);

    expect(screen.queryByRole("button", { name: /pause/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /resume/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /clear/i })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing captured yet.")).toBeInTheDocument();
  });

  it("shows a read failure as an alert instead of an empty log", () => {
    renderWithProviders(<LogViewer lines={[]} error="service `nginx` is not registered" />);

    expect(screen.getByRole("alert")).toHaveTextContent(/not registered/);
  });

  it("numbers lines with the sequence the source reported", () => {
    renderWithProviders(
      <LogViewer lines={[{ id: "7", text: "INFO ready", position: 7 }]} />,
    );

    expect(screen.getByText("7")).toBeInTheDocument();
  });
});
