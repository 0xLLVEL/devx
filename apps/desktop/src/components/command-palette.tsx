import { Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";

import { COMMAND_GROUPS, type Command } from "@/lib/commands";
import { rankItems } from "@/lib/fuzzy";
import { cn } from "@/lib/utils";

/**
 * Command palette (§33, §92, §93).
 *
 * Local-only: the command list is built from what the backend has already
 * told the shell, and filtering is a fuzzy pass over a handful of strings, so
 * the whole interaction stays far inside §33's 50ms budget. The palette owns
 * nothing but its query and its selection — opening, closing and running are
 * the caller's business, which is also what makes it testable without IPC.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reopening starts from a clean slate rather than the last search.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      inputRef.current?.focus();
    }
  }, [open]);

  const grouped = useMemo(() => {
    const ranked = rankItems(query, commands, (command) => ({
      name: command.title,
      aliases: [...command.keywords, command.group],
    }));
    return COMMAND_GROUPS.map((group) => ({
      group,
      items: ranked
        .filter((entry) => entry.item.group === group)
        .map((entry) => entry.item),
    })).filter((section) => section.items.length > 0);
  }, [commands, query]);

  const flat = useMemo(
    () => grouped.flatMap((section) => section.items),
    [grouped],
  );

  // A shorter result list can leave the selection past the end.
  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(flat.length - 1, 0)));
  }, [flat.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const active = listRef.current?.querySelector('[data-active="true"]');
    // Environments without layout (jsdom) have no scrollIntoView; scrolling is
    // a nicety, and its absence must not break the palette.
    if (typeof active?.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, open]);

  if (!open) {
    return null;
  }

  const run = (command: Command | undefined) => {
    if (!command) {
      return;
    }
    onClose();
    command.run();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % Math.max(flat.length, 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex(
        (current) => (current - 1 + flat.length) % Math.max(flat.length, 1),
      );
    } else if (event.key === "Enter") {
      event.preventDefault();
      run(flat[activeIndex]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      // Clicking the dim area closes; clicking the panel must not.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-[6px]"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="glass-surface w-[640px] max-w-full rounded-command"
      >
        <div className="flex items-center gap-3 border-b border-line-subtle px-4 py-3">
          <Search className="size-4 shrink-0 text-ink-muted" aria-hidden />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded
            aria-controls="command-palette-results"
            aria-activedescendant={
              flat[activeIndex] ? `command-${flat[activeIndex].id}` : undefined
            }
            aria-label="Search commands"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Type a command or search..."
            autoComplete="off"
            spellCheck={false}
            // §55: no `outline-none` here. The palette autofocuses this field,
            // so it is the first thing a keyboard user lands on and it has to
            // show the same focus ring as every other input in the app.
            className="h-6 min-w-0 flex-1 bg-transparent text-sm text-foreground placeholder:text-ink-muted"
          />
          <kbd className="rounded-sm border border-line-subtle px-1.5 py-0.5 font-mono text-caption text-ink-muted">
            Ctrl K
          </kbd>
        </div>

        <div
          ref={listRef}
          id="command-palette-results"
          role="listbox"
          aria-label="Commands"
          className="max-h-[420px] overflow-y-auto p-2"
        >
          {flat.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-muted">
              No command matches “{query.trim()}”.
            </p>
          ) : (
            grouped.map((section) => (
              <div key={section.group} className="mb-1 last:mb-0">
                <p className="px-3 py-1.5 text-caption tracking-wide text-ink-muted uppercase">
                  {section.group}
                </p>
                {section.items.map((command) => {
                  const index = flat.indexOf(command);
                  const active = index === activeIndex;
                  const Icon = command.icon;
                  return (
                    <div
                      key={command.id}
                      id={`command-${command.id}`}
                      role="option"
                      aria-selected={active}
                      data-active={active}
                      onMouseMove={() => setActiveIndex(index)}
                      onClick={() => run(command)}
                      className={cn(
                        "flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors duration-150",
                        active ? "bg-hover text-foreground" : "text-ink-secondary",
                      )}
                    >
                      <Icon
                        aria-hidden
                        className={cn(
                          "size-4 shrink-0",
                          active ? "text-primary" : "text-ink-muted",
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate">{command.title}</span>
                      {command.hint ? (
                        <kbd className="font-mono text-caption text-ink-muted">
                          {command.hint}
                        </kbd>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="flex items-center gap-4 border-t border-line-subtle px-4 py-2 text-caption text-ink-muted">
          <span>↑↓ Navigate</span>
          <span>Enter Run</span>
          <span>Esc Close</span>
        </div>
      </div>
    </div>
  );
}
