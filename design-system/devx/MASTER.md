# Design System Master File — DevX

> **LOGIC:** When building a specific page, first check `design-system/devx/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.
>
> This is the reconciled hybrid: the database recommendation (ui-ux-pro-max,
> "developer tool dashboard", dials variance 5 / motion 3 / density 8) supplies
> the **structure** — density scale, Real-Time Monitor pattern, accessibility
> rules — while the hand-written identity in `apps/desktop/DESIGN.md` keeps the
> **character**: warm surfaces, amber accent, Windows-native type. Where the
> generated palette suggested slate-blue + green, this file keeps the warm
> family; the conflict is resolved in favor of brand.

---

**Project:** DevX
**Generated:** 2026-09-14 (reconciled)
**Category:** Developer tool / desktop control panel
**Design Dials:** Variance 5/10 (Balanced / Modern) | Motion 3/10 (Subtle) | Density 8/10 (Dense / Dashboard)

---

## Global Rules

### Color Palette

Expressed in oklch in `apps/desktop/src/index.css`; hex approximations here for
reference. Dark is the default theme (a tool that sits open next to an editor).

| Role | Dark (default) | Light | CSS Variable |
|------|----------------|-------|--------------|
| Background | near-black warm `oklch(0.145 0.008 70)` ≈ `#131110` | warm paper `oklch(0.972 0.006 80)` | `--background` |
| Foreground | warm off-white `oklch(0.95 0.006 80)` | deep umber `oklch(0.24 0.015 70)` | `--foreground` |
| Card | one step up `oklch(0.19 0.01 70)` | `oklch(0.99 0.003 80)` | `--card` |
| Muted | `oklch(0.25 0.012 70)` | `oklch(0.945 0.008 80)` | `--muted` |
| Border | `oklch(0.27 0.012 70)` | `oklch(0.9 0.01 80)` | `--border` |
| Primary (amber lamp) | `oklch(0.78 0.14 70)` | `oklch(0.62 0.14 65)` | `--primary` |
| Destructive | `oklch(0.63 0.2 25)` | `oklch(0.55 0.21 28)` | `--destructive` |
| Success | `oklch(0.72 0.14 150)` | `oklch(0.58 0.13 150)` | `--success` |
| Warning | `oklch(0.8 0.14 72)` | `oklch(0.72 0.14 70)` | `--warning` |
| Ring | `oklch(0.78 0.14 70)` | `oklch(0.62 0.1 65)` | `--ring` |

**Rules (from the database, kept verbatim):**

- Text contrast ≥ 4.5:1 against its background in **both** themes; the amber
  accent was lightened for dark mode specifically to hold this.
- Status is **never color alone**: running = green dot **+ "Running" label**,
  failed = red **+ icon + label**, starting = amber pulse **+ label**.
- One accent (amber) at the key moment per screen; zero accents is sterile,
  accent-everywhere is slop.

### Typography

- **UI face:** Segoe UI system stack (Windows-native; no downloaded webfont).
- **Data face:** Cascadia Code → JetBrains Mono → ui-monospace. Every
  **port, path, hostname, version, size, metric value and log line** renders
  in the data face via the `.data-value` utility (Tailwind `font-mono`).
  Numbers in prose stay in the UI face; numbers that *are* the content go mono.
- Headings read as sentences; no uppercase tracked labels.

### Spacing (density 8 — dense dashboard)

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | 2px | Icon gaps |
| `--space-sm` | 4px | Inline spacing, chip padding |
| `--space-md` | 8px | Table cell padding, control gaps |
| `--space-lg` | 12px | Card padding, list row padding |
| `--space-xl` | 16px | Between sibling cards |
| `--space-2xl` | 24px | Page section margins |
| `--space-3xl` | 32px | Page header block |

Page shell padding: 20px. Forms are the density exception — they keep 16px+ row
spacing (error-prone input benefits from air).

### Component Specs

- **Table (monitor rows):** 8px cell padding, border-divided rows, actions as
  icon buttons ≥ 32×32px with tooltips, hover raises row bg one step. The
  deciding column (name/status) comes first.
- **Status strip:** horizontal band under the page header for CA/DNS/SMTP-style
  background states; each entry = dot + label + action link.
- **Tabs:** used to split a page heavier than one screen (Services). Tab bar is
  a border-bottom row, active tab carries the amber underline marker.
- **Buttons:** primary = amber fill, dark text; secondary = bordered, no fill.
  Transitions 150–200ms, `cursor-pointer`, visible focus ring.
- **Radius:** 2px inputs/badges, 4px cards, 6px primary CTA max. Shadow on
  popover/dialog only.
- **Icons:** Lucide, 14–16px, machined-detail weight; no emoji, no sparkles.

### Page Pattern — Real-Time Monitor

Every app screen is a monitor built around the one decision the user makes
there. Structure per page:

1. **Page header** (flat, border-bottom): title + right-slot live status.
2. **Status strip** (when the page has background states).
3. **The live surface** — the table/board the user watches and acts on.
4. **Secondary summary** — real numbers only, no invented deltas.

Anti-patterns (from the database, adopted): emoji as icons, layout-shifting
hover transforms, instant (0ms) state changes, invisible focus, color-only
status, fabricated metrics.

### Motion

Dial 3 (subtle), implemented as CSS only — **no GSAP** in a desktop app:

- Hover/state transitions: 150–200ms ease-out.
- The only allowed loops are real states: starting/stopping pulse, and
  indeterminate progress. Nothing else loops.
- `prefers-reduced-motion: reduce` collapses all transitions to instant.

## Pre-Delivery Checklist

- [ ] No emoji as icons; Lucide set consistent
- [ ] `cursor-pointer` + hover transition (150–200ms) on all clickables
- [ ] Contrast ≥ 4.5:1 in the active theme
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Status = dot + label (+ icon when failed), never color alone
- [ ] Ports/paths/versions/metrics render in the data (mono) face
- [ ] No invented numbers, feeds, or deltas
- [ ] No horizontal scroll at 1024px; sidebar nav usable at 375px
