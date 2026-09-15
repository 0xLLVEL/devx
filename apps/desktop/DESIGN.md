# DevX design identity — "warm utility"

This file is the source the UI tokens in `src/index.css` implement. Every
color, radius, shadow, icon and motion decision below has a reason written
down; changes to the visual system update this file first.

## Brand idea

DevX is a **workshop panel for Windows**: a control surface that sits open
next to an editor all day. The design borrows from physical control panels —
solid machined surfaces, warm neutral materials, one amber power lamp — not
from SaaS landing pages. It should feel like an instrument, not a website.

## Palette (2 core + 1 accent, per the active-palette cap)

- **Base (neutral):** warm stone family, oklch hue 60–85, low chroma.
  Backgrounds, cards, borders, sidebar. The blue-grey neutrals this replaced
  were a default, not a choice.
- **Ink (foreground):** deep warm umber, the same hue family as the base —
  text and icons never go cold grey.
- **Accent (amber power lamp):** `--primary`, oklch hue ~70. Used at **the
  key moment per screen only**: the primary action, the running-state
  emphasis, the active nav marker. An accent everywhere is no accent.
- **Semantic states** stay separate and are retuned into the warm family:
  success (running), warning (starting/stopping), destructive (failed).

## Type

- **UI:** Segoe UI system stack — the Windows-native face; a Windows-only
  utility shipping a downloaded webfont would be decoration.
- **Mono:** Cascadia Code (then JetBrains Mono, ui-monospace) — Microsoft's
  own terminal face; the right brand reason for hostnames, ports and logs.
- No uppercase tracked eyebrow labels; headings read as sentences.

## Dials (declared)

- **RHYTHM = 2:** sections vary between page types — status-led pages
  (Dashboard, Services, Logs) lead with the live surface; form-led pages
  (Settings, Sites) lead with the form. Within a page, spacing follows a
  scale, not one repeated value.
- **MOTION = 1:** hover states and short state transitions only. The only
  allowed loops are *real* states: the starting/stopping pulse dot and
  indeterminate progress. Nothing else pulses, floats or loops.

## Dose caps

- **Radius scale:** `2px` inputs/badges, `4px` cards, `6px` the primary CTA
  at most. Machined edges, not pills.
- **Shadow:** popover/dialog elevation only. Most surfaces sit flat with a
  border; nothing "floats".
- **No gradients, no glass, no glow, no background textures.** Flat color
  and borders carry hierarchy.
- **Icons:** Lucide, kept deliberately — thin-stroke glyphs read as machined
  detail at 14–16px and the set is consistent with Windows line-icon
  conventions. Relevance rule still applies per glyph; no sparkle/AI glyphs.

## App-screen rule

Every screen is built around the one decision the user makes there
("is anything broken, what do I click"). Stat rows are secondary summaries
of real data only — no invented numbers, no trend deltas without a real
comparison period, no feed entries that did not happen.
