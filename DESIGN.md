# DESIGN.md — DevX Brand & Motion/Rhythm (Part 3)

**Purpose (core Part 3):** State the reason before using a visual treatment. Every R-XX that needs a reason refers here.

**Brand character:** Developer environment manager for Windows — calm, technical, trustworthy. Not marketing landing, not playful. Audience: Windows devs running PHP/Node/DB locally. Product type: signed-in dashboard, not content site.

**Palette (R-01, R-29, R-31):**
- Core neutrals: `--bg-app #0f172a` (navy), `--bg-surface #ffffff` (light), `--border-*` — 2 cores + neutral base.
- Accent: `--accent` burnt-orange `#c2410c` (light) / coral `#ff6b5a` (dark), `--accent-soft` for hover. Used at key moment only: primary CTA, 2px top line `from-accent to transparent` (hierarchy: level 1 vs 2), `Card` hover `-1px + border`. Zero accents is sterile, accent everywhere is slop — we keep 1-2.
- No `blue-purple` default gradient (R-01). Gradient only as hierarchy function with reason written here.

**Typography (R-06) — Vercel minimal:**
- Sans `Geist Sans` (primary, tight -0.02em), fallback `Inter` + system — chosen for minimal, clean dev tool (Vercel-like), not loud. Scale: display 28/34/600 -0.02em, h1 22/28/600 -0.02em, h2 16/22/600 -0.015em, h3 14/18/600 -0.01em, sm 13/18, xs 12/16, caption 11/14/500, code 12/17. One h1 per page, tracking tight for headings.

**Radius & Elevation (R-11, R-12):**
- Radius: `--radius 8` + `xs 4 / sm 6 / md 8 / lg 12 / xl 16 / 2xl 20 / command 14`, pills `999`. Applied deliberately, not pill everywhere.
- Shadows `sm/md/lg` navy-tinted (light) / black (dark) — elevation marker only, most elements flat.

**Glass/Glow Dose Caps (R-10, R-13):**
- Glass `backdrop-blur 14px + --glass-bg 0.82` only on `Dialog` + `CommandPalette` (1-2 elements). Topbar is solid `bg-surface`.
- Glow `shadow-[0_0_12px_var(--accent-soft)]` only on `Card hover`, max 1-2.

**RHYTHM dial: 2 (subtle variation)**
- Spacing scale 4px base, vary `p-4` vs `p-6` vs `gap-6`, not uniform. Sections alternate text-heavy vs visual, but not every section centered title + grid (R-05).

**MOTION dial: 1 (hover only) — R-19**
- Allowed: `hover -translate-y-px 160ms ease-standard`, `dialog 160ms scale 0.96`, `toast 160ms`, `active scale 0.97`.
- Forbidden: endless `status-pulse 3s`, `ambient-drift 24s` loops — removed. 1 dot without glow for real `running` state only (R-31, R-19). `prefers-reduced-motion` kills all.

**Layout Decision (C-3, R-20):**
- Dashboard job: "is my pool healthy?" — hero is `PHP pools healthy (3/4)` + `Pool CPU per hour, last 24h` chart. Failed jobs footnote, not hero. App shell `sidebar 232/68 + topbar + main` desktop-only `min 940`.

**Empty/Loading/Error (R-27):**
- Empty: `No sites yet. Add one and DevX will route...` + CTA. Loading: `shimmer-skeleton`, not spinner. Error: `Could not read — reason + Try again`.
