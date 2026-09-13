import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** One glossy stat tile: icon, label, a big number, and an optional extra. */
export function StatTile({
  icon,
  label,
  value,
  sub,
  tone = "neutral",
  children,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  sub: string;
  tone?: "success" | "neutral";
  children?: ReactNode;
}) {
  return (
    <Card className="h-full">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-2 text-sm text-muted-foreground">
            {icon}
            {label}
          </span>
          {tone === "success" ? <Badge variant="success">{sub}</Badge> : null}
        </div>
        <p className="mt-2 text-3xl font-semibold tracking-tight">{value}</p>
        {tone === "success" ? null : (
          <p className="text-xs text-muted-foreground">{sub}</p>
        )}
        {children}
      </CardContent>
    </Card>
  );
}
