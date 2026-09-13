import type { ReactNode } from "react";

/**
 * The standard "nothing here yet" box: dashed border, one message, and an
 * optional action so the user always knows what would fill the space.
 */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-lg border border-dashed border-border p-8 text-center">
      {icon ? (
        <div className="mb-2 flex justify-center text-muted-foreground [&_svg]:size-6">
          {icon}
        </div>
      ) : null}
      <p className="text-sm">{title}</p>
      {description ? (
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
