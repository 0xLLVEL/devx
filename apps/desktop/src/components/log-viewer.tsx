import { Copy, Loader2, Pause, Play, Search, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";

/**
 * Log viewer (§22).
 *
 * Monospace, timestamp, severity, search, clear, pause, auto-scroll and copy —
 * the controls §22 lists, minus save/export, which needs a write command the
 * backend does not expose.
 *
 * The viewer is presentational: it is handed the lines its caller has already
 * collected, so one component serves the live service tail, the PHP pool tail
 * and (later) the whole log files on the Logs page without knowing how any of
 * them are fetched. Pause is the caller's too — it controls whether the feed
 * keeps running — so a paused viewer really stops reading rather than hiding
 * incoming lines.
 *
 * Two rules decide everything below. Nothing is invented: a line gets a
 * timestamp or a severity only where the source actually wrote one (§131 Rule
 * 17), and the fallback is the raw text, never a guessed level. And colour is
 * never the only signal (§55/§65): the severity tag and the `err` marker are
 * text first, tinted second.
 */

/**
 * §22's severity vocabulary.
 *
 * Systems spell the same level differently, so a recognised alias folds onto
 * its §22 name (`critical`, `fatal` and `panic` read as `ERROR`). That is a
 * renaming inside §22's five-level vocabulary, not a level invented for a line
 * that had none.
 */
export type LogSeverity = "ERROR" | "WARN" | "INFO" | "DEBUG" | "TRACE";

export const LOG_SEVERITIES: readonly LogSeverity[] = [
  "ERROR",
  "WARN",
  "INFO",
  "DEBUG",
  "TRACE",
];

const SEVERITY_ALIASES: Record<string, LogSeverity> = {
  error: "ERROR",
  err: "ERROR",
  critical: "ERROR",
  crit: "ERROR",
  fatal: "ERROR",
  panic: "ERROR",
  warn: "WARN",
  warning: "WARN",
  info: "INFO",
  notice: "INFO",
  debug: "DEBUG",
  trace: "TRACE",
};

/** One line handed to the viewer, oldest first. */
export type LogLine = {
  /** Stable React key — the source's sequence number where it has one. */
  id: string;
  /** The line exactly as the source produced it, and what Copy yields. */
  text: string;
  /** Which stream it came from, when the source distinguishes them. */
  stream?: "stdout" | "stderr";
  /**
   * The source's own sequence number. Shown as the line number when present;
   * it counts what that source captured, so it is not a file line number.
   */
  position?: number;
};

export type ParsedLogLine = {
  /** The leading timestamp, verbatim, or `null` when the line has none. */
  time: string | null;
  /** The level the line states, normalised to §22's names, or `null`. */
  severity: LogSeverity | null;
  /** Everything after the timestamp and level that were recognised. */
  message: string;
};

/**
 * A leading timestamp: ISO-8601, `YYYY/MM/DD HH:MM:SS` (nginx) or a bare
 * `HH:MM:SS`. The digits are kept verbatim — reformatting would add precision
 * the source never wrote.
 */
const TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?|\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}|\d{2}:\d{2}:\d{2}(?:[.,]\d{1,6})?)\s+/;

/** A leading level, bare or wrapped (`INFO`, `[error]`, `(WARN)`). */
const SEVERITY_PATTERN = /^([[<]?)([A-Za-z]{3,9})([\]>:]?)(?=\s|$)/;

/** Splits one raw line into the parts §22 displays. */
export function parseLogLine(text: string): ParsedLogLine {
  let rest = text.trim();
  let time: string | null = null;
  let severity: LogSeverity | null = null;

  const timeMatch = TIME_PATTERN.exec(rest);
  if (timeMatch) {
    time = timeMatch[1]!;
    rest = rest.slice(timeMatch[0].length);
  }

  const severityMatch = SEVERITY_PATTERN.exec(rest);
  if (severityMatch) {
    const known = SEVERITY_ALIASES[severityMatch[2]!.toLowerCase()];
    if (known) {
      severity = known;
      rest = rest.slice(severityMatch[0].length).trimStart();
    }
  }

  return { time, severity, message: rest };
}

/** §22: colours sparingly — errors and warnings carry a tint, the rest do not. */
const SEVERITY_TONE: Record<LogSeverity, string> = {
  ERROR: "text-destructive",
  WARN: "text-warning",
  INFO: "text-ink-secondary",
  DEBUG: "text-ink-muted",
  TRACE: "text-ink-muted",
};

type SeverityFilter = "all" | LogSeverity;

export function LogViewer({
  lines,
  title,
  meta,
  paused,
  onPausedChange,
  onClear,
  pending = false,
  error = null,
  emptyMessage = "No output yet.",
  className,
}: {
  /** Lines to display, oldest first. */
  lines: readonly LogLine[];
  /** Mono heading, so a viewer always names its source (§55). */
  title?: string;
  /** Optional detail beside the title — a file name, a byte count. */
  meta?: ReactNode;
  /** Freezes the feed. Omit both to leave Pause out entirely. */
  paused?: boolean;
  onPausedChange?: (paused: boolean) => void;
  /** Drops the lines from the view. Omit to leave Clear out entirely. */
  onClear?: () => void;
  pending?: boolean;
  error?: string | null;
  emptyMessage?: string;
  className?: string;
}) {
  const toast = useToast();
  const [search, setSearch] = useState("");
  const [severity, setSeverity] = useState<SeverityFilter>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const scrollArea = useRef<HTMLDivElement>(null);

  const parsed = useMemo(
    () => lines.map((line) => ({ line, ...parseLogLine(line.text) })),
    [lines],
  );

  // A control for a level no line uses would be decoration, so the severity
  // select only appears once the source has actually stated a level.
  const levels = useMemo(() => {
    const present = new Set<LogSeverity>();
    for (const item of parsed) {
      if (item.severity) {
        present.add(item.severity);
      }
    }
    return LOG_SEVERITIES.filter((level) => present.has(level));
  }, [parsed]);

  const hasTime = useMemo(() => parsed.some((item) => item.time !== null), [parsed]);

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      parsed.filter((item) => {
        if (severity !== "all" && item.severity !== severity) {
          return false;
        }
        return needle === "" || item.line.text.toLowerCase().includes(needle);
      }),
    [parsed, severity, needle],
  );

  const filtering = needle !== "" || severity !== "all";

  // §22 auto-scroll: stay on the newest line while it is on. Reduced motion
  // turns the jump into an instant one, which is what a log tail wants anyway.
  useEffect(() => {
    const area = scrollArea.current;
    if (area && autoScroll) {
      area.scrollTop = area.scrollHeight;
    }
  }, [visible.length, autoScroll, lines]);

  const copy = async () => {
    const payload = visible.map((item) => item.line.text).join("\n");
    if (!navigator.clipboard) {
      toast.error("Could not copy the log", {
        description: "The clipboard is not available in this window.",
      });
      return;
    }
    try {
      await navigator.clipboard.writeText(payload);
      toast.success(
        `Copied ${count(visible.length, "line")}`,
        // Says exactly what went out, so a filtered view is never mistaken for
        // the whole log (§54: no silent surprises).
        { description: filtering ? "The lines currently in view." : "Every line in view." },
      );
    } catch (err) {
      toast.error("Could not copy the log", {
        details: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return (
    <section className={cn("space-y-2", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {title ? (
            <h3 className="data-value min-w-0 truncate font-medium text-foreground" title={title}>
              {title}
            </h3>
          ) : null}
          {meta ? <span className="text-caption text-ink-muted">{meta}</span> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {onPausedChange ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={paused ?? false}
              onClick={() => onPausedChange(!(paused ?? false))}
            >
              {paused ? <Play aria-hidden /> : <Pause aria-hidden />}
              {paused ? "Resume" : "Pause"}
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={visible.length === 0}
            onClick={() => void copy()}
          >
            <Copy aria-hidden />
            Copy
          </Button>
          {onClear ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={lines.length === 0}
              title="Clears this view. The log file on disk keeps everything."
              onClick={onClear}
            >
              <Trash2 aria-hidden />
              Clear
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-64 max-w-full">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            className="h-8 pl-8 text-xs"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search lines…"
            aria-label={title ? `Search ${title}` : "Search log lines"}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {levels.length > 0 ? (
          <Select
            className="h-8 w-36 text-xs"
            value={severity}
            onChange={(event) => setSeverity(event.target.value as SeverityFilter)}
            aria-label={title ? `Filter ${title} by level` : "Filter lines by level"}
          >
            <option value="all">All levels</option>
            {levels.map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </Select>
        ) : null}

        <label className="flex items-center gap-2 text-xs text-ink-muted">
          Auto-scroll
          <Switch
            checked={autoScroll}
            onCheckedChange={setAutoScroll}
            aria-label="Follow new lines"
          />
        </label>

        {/* §65: the state is written out, not signalled by a colour. */}
        {onPausedChange ? (
          <span className="flex items-center gap-1.5 text-xs text-ink-muted" role="status">
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                paused ? "bg-warning" : "bg-success",
              )}
            />
            {paused ? "Paused — the feed is stopped" : "Live"}
          </span>
        ) : null}

        <span className="text-xs text-ink-muted">
          {filtering
            ? `${visible.length} of ${lines.length} lines`
            : count(lines.length, "line")}
        </span>
      </div>

      <div
        ref={scrollArea}
        role="log"
        // Streaming logs would otherwise interrupt a screen reader on every
        // poll; the line count above carries the updates instead.
        aria-live="off"
        aria-label={title ? `${title} log lines` : "Log lines"}
        className="max-h-96 overflow-auto rounded-sm border border-border bg-background/60 py-1"
        data-selectable
      >
        {error ? (
          // §39: a titled failure rather than a monospace line that reads like
          // output. The backend's own text stays, as the detail.
          <div className="p-2">
            <Callout variant="destructive" title="Could not read these lines.">
              <p className="font-mono text-code">{error}</p>
            </Callout>
          </div>
        ) : pending && lines.length === 0 ? (
          <p
            className="flex items-center gap-2 px-2 py-3 font-mono text-code text-ink-muted"
            role="status"
          >
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            Waiting for output…
          </p>
        ) : lines.length === 0 ? (
          <p className="px-2 py-3 font-mono text-code text-ink-muted">{emptyMessage}</p>
        ) : visible.length === 0 ? (
          <p className="px-2 py-3 font-mono text-code text-ink-muted">
            No line matches the current search and level filter.
          </p>
        ) : (
          visible.map((item) => (
            <div
              key={item.line.id}
              className="flex items-start gap-2 px-2 py-px font-mono text-code hover:bg-hover/60"
            >
              {item.line.position !== undefined ? (
                <span
                  className="w-10 shrink-0 text-right text-ink-muted tabular-nums"
                  title="Sequence number from the service supervisor"
                >
                  {item.line.position}
                </span>
              ) : null}
              {hasTime ? (
                <span className="w-[4.5rem] shrink-0 text-ink-muted">{item.time ?? ""}</span>
              ) : null}
              {levels.length > 0 ? (
                <span
                  className={cn(
                    "w-11 shrink-0 font-medium",
                    item.severity ? SEVERITY_TONE[item.severity] : "text-ink-muted",
                  )}
                >
                  {item.severity ?? "·"}
                </span>
              ) : null}
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap text-foreground">
                {item.message}
              </span>
              {item.line.stream === "stderr" ? (
                <span className="shrink-0 text-ink-muted" title="Standard error">
                  err
                </span>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

/** `1 line` / `2 lines`, so counts never read as machine output. */
function count(value: number, noun: string): string {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}
