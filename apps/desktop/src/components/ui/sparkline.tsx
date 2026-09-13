/** A tiny inline polyline of the last N samples, no chart library. */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) {
    return null;
  }
  const width = 120;
  const height = 24;
  const step = width / (values.length - 1);
  const points = values
    .map(
      (value, index) =>
        `${(index * step).toFixed(1)},${(height - (value / 100) * height).toFixed(1)}`,
    )
    .join(" ");

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="mt-2 h-6 w-full" aria-hidden>
      <polyline
        points={points}
        fill="none"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
        className="stroke-primary/70"
      />
    </svg>
  );
}
