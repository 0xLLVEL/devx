import {
  CircleAlert,
  CircleCheck,
  Info,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Toast notifications (§36).
 *
 * Bottom-right, 320–420px wide, one stack. Every async action that finishes
 * without changing the page under the user's cursor gets one of these, so a
 * click never looks like it did nothing (§54, Rule 7). Errors last long
 * enough to be read and carry their cause: a toast that only says "failed" is
 * a hidden error (§131 Rule 18).
 */

export type ToastType = "success" | "info" | "warning" | "error";

export type ToastInput = {
  type: ToastType;
  title: string;
  description?: string;
  /** Full text behind "View Details" — usually the backend error message. */
  details?: string;
  /** Milliseconds; `null` keeps it until dismissed. Defaults come from §36. */
  duration?: number | null;
  action?: { label: string; onClick: () => void };
};

/** §36 durations. Errors sit at the top of the range. */
export const TOAST_DURATION: Record<ToastType, number> = {
  success: 4000,
  info: 5000,
  warning: 6000,
  error: 8000,
};

type ToastRecord = ToastInput & { id: number };

type ToastApi = {
  toast: (input: ToastInput) => number;
  success: (title: string, input?: Omit<ToastInput, "type" | "title">) => number;
  info: (title: string, input?: Omit<ToastInput, "type" | "title">) => number;
  warning: (title: string, input?: Omit<ToastInput, "type" | "title">) => number;
  error: (title: string, input?: Omit<ToastInput, "type" | "title">) => number;
  dismiss: (id: number) => void;
};

/**
 * A component rendered outside the provider (a test harness, a story) should
 * not crash, so the fallback is a no-op rather than a thrown error.
 */
const ToastContext = createContext<ToastApi>({
  toast: () => -1,
  success: () => -1,
  info: () => -1,
  warning: () => -1,
  error: () => -1,
  dismiss: () => {},
});

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [records, setRecords] = useState<ToastRecord[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setRecords((current) => current.filter((record) => record.id !== id));
  }, []);

  const toast = useCallback((input: ToastInput) => {
    const id = nextId.current++;
    // Newest last, so the stack grows upward from the corner.
    setRecords((current) => [...current, { ...input, id }]);
    return id;
  }, []);

  const api = useMemo<ToastApi>(() => {
    const shorthand =
      (type: ToastType) =>
      (title: string, input: Omit<ToastInput, "type" | "title"> = {}) =>
        toast({ type, title, ...input });
    return {
      toast,
      dismiss,
      success: shorthand("success"),
      info: shorthand("info"),
      warning: shorthand("warning"),
      error: shorthand("error"),
    };
  }, [toast, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div
          aria-live="polite"
          aria-label="Notifications"
          className="pointer-events-none fixed right-4 bottom-4 z-60 flex w-[380px] max-w-[calc(100vw-2rem)] flex-col gap-2"
        >
          {records.map((record) => (
            <ToastItem key={record.id} record={record} onDismiss={dismiss} />
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

const ICONS: Record<ToastType, LucideIcon> = {
  success: CircleCheck,
  info: Info,
  warning: TriangleAlert,
  error: CircleAlert,
};

const ACCENTS: Record<ToastType, string> = {
  success: "text-success",
  info: "text-info",
  warning: "text-warning",
  error: "text-destructive",
};

function ToastItem({
  record,
  onDismiss,
}: {
  record: ToastRecord;
  onDismiss: (id: number) => void;
}) {
  // Reading the details is not a race: an expanded toast stops counting down.
  const [expanded, setExpanded] = useState(false);
  const duration =
    record.duration === undefined ? TOAST_DURATION[record.type] : record.duration;

  useEffect(() => {
    if (duration === null || expanded) {
      return;
    }
    const timer = setTimeout(() => onDismiss(record.id), duration);
    return () => clearTimeout(timer);
  }, [duration, expanded, onDismiss, record.id]);

  const Icon = ICONS[record.type];

  return (
    <div
      // Errors interrupt; everything else waits its turn.
      role={record.type === "error" ? "alert" : "status"}
      className="toast-enter glass-surface pointer-events-auto flex items-start gap-3 rounded-lg p-3 shadow-lg"
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", ACCENTS[record.type])} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{record.title}</p>
        {record.description ? (
          <p className="mt-0.5 text-xs text-ink-secondary">{record.description}</p>
        ) : null}
        {expanded && record.details ? (
          <pre
            data-selectable
            className="mt-2 max-h-40 overflow-auto rounded-md border border-line-subtle bg-surface-2 p-2 font-mono text-xs whitespace-pre-wrap text-ink-secondary"
          >
            {record.details}
          </pre>
        ) : null}
        <div className="mt-2 flex items-center gap-2">
          {record.details ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              aria-expanded={expanded}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? "Hide Details" : "View Details"}
            </Button>
          ) : null}
          {record.action ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => {
                record.action?.onClick();
                onDismiss(record.id);
              }}
            >
              {record.action.label}
            </Button>
          ) : null}
        </div>
      </div>
      {/* §94/§123: icon-only, so it names itself on hover and focus like every
          other icon-only control. */}
      <Tooltip label="Dismiss notification">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          aria-label="Dismiss notification"
          onClick={() => onDismiss(record.id)}
        >
          <X />
        </Button>
      </Tooltip>
    </div>
  );
}
