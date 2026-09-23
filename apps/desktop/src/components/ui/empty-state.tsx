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
    <div className="rounded-lg border border-dashed border-border p-10 text-center">
      {icon ? (
        <div className="mb-3 flex justify-center text-muted-foreground [&_svg]:size-7">
          {icon}
        </div>
      ) : null}
      <p className="text-h3">{title}</p>
      {description ? (
        <p className="mt-2 text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-5 flex justify-center">{action}</div> : null}
    </div>
  );
}
