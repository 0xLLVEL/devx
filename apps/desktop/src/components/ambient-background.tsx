/**
 * Ambient background (§15, §86).
 *
 * A sparse field of 1px dots over the graphite base — accent, cyan and ink —
 * drifting on a 24s cycle. No gradients, no orbs, no glow: the layer is the
 * particle field alone. It is fixed to the window so it does not scroll away
 * from a long page, sits below every in-flow element (the chrome has real
 * surfaces and covers it), and takes no pointer events. §15's reduced-motion
 * rule removes the particle layer outright.
 */
export function AmbientBackground() {
  return (
    <div
      aria-hidden
      data-testid="ambient-background"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden"
    >
      {/* Positioned by the class itself: a 2px anchor whose box-shadow
          paints the dots, so no wrapper box can stretch it. */}
      <div className="ambient-particles ambient-drift" />
    </div>
  );
}
