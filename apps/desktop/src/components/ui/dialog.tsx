import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * The one modal primitive (§34).
 *
 * Built on the native `<dialog>` element so focus trapping, `Esc`, inertness
 * of the page behind and the `::backdrop` layer come from the platform rather
 * than from a reimplementation. Callers own `open`; the dialog only reports
 * how it was dismissed.
 *
 * Not every action belongs in here (§120 #9): simple operations stay inline.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  size = "md",
  footer,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  /** §34 widths: sm 400, md 520, lg 680, xl 860. */
  size?: "sm" | "md" | "lg" | "xl";
  footer?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    if (!open) {
      return;
    }
    const dialog = ref.current;
    if (!dialog) {
      return;
    }
    try {
      dialog.showModal();
    } catch {
      // Test environments without `showModal` still get a visible dialog.
      dialog.setAttribute("open", "");
    }
    // `autoFocus` on a child runs before the dialog is modal, so placement has
    // to happen here. Callers mark the safe target.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
  }, [open]);

  // Nothing is in the DOM while closed: a hidden dialog that screen readers,
  // tests and the tab order can still reach is a trap, not a component.
  if (!open) {
    return null;
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      {...(description ? { "aria-describedby": descriptionId } : {})}
      // Esc fires `cancel`; routing it through `onClose` keeps the caller's
      // state and the DOM in step.
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      className={cn(
        "m-auto rounded-xl border border-line-strong bg-elevated p-0 text-foreground shadow-lg backdrop:bg-black/60 backdrop:backdrop-blur-[6px]",
        SIZES[size],
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-line-subtle p-5 pb-4">
        <div className="min-w-0 space-y-1">
          <h2 id={titleId} className="text-h2">
            {title}
          </h2>
          {description ? (
            <p id={descriptionId} className="text-sm text-ink-secondary">
              {description}
            </p>
          ) : null}
        </div>
        {/* §94/§123: the last icon-only control in the app. Every other one
            (topbar, sidebar, drawer, row actions) names itself on hover and
            focus, so the dialog's closes the same way. */}
        <Tooltip label="Close">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="-mt-1 size-8 shrink-0"
            aria-label="Close"
            onClick={onClose}
          >
            <X />
          </Button>
        </Tooltip>
      </div>

      {children ? <div className="p-5 text-sm">{children}</div> : null}

      {footer ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-subtle p-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  );
}

const SIZES = {
  sm: "w-[400px] max-w-[calc(100vw-2rem)]",
  md: "w-[520px] max-w-[calc(100vw-2rem)]",
  lg: "w-[680px] max-w-[calc(100vw-2rem)]",
  xl: "w-[860px] max-w-[calc(100vw-2rem)]",
} as const;

/**
 * Confirmation for actions with real consequences (§35, §19).
 *
 * The description must say what will happen — "Are you sure?" on its own is
 * banned. Cancel holds initial focus: the safe choice is the one a stray
 * Enter picks.
 */
export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  pending = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  cancelLabel?: string;
  destructive?: boolean;
  pending?: boolean;
  children?: ReactNode;
}) {
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      size="sm"
      footer={
        <>
          <Button
            type="button"
            variant="ghost"
            data-autofocus
            disabled={pending}
            onClick={onClose}
          >
            {cancelLabel}
          </Button>
          <Button
            type="button"
            variant={destructive ? "destructive" : "default"}
            disabled={pending}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
