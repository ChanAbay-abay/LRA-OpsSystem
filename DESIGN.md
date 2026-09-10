# LRA Ops Monitoring System — Design System

**Status:** binding on the `coder` agent. Written 2026-09-08 by `designer`.
**Extended 2026-09-10** with **Part II (§16–§26)** — responsive/mobile, the shared label
layer, duration formatting, the activity heatmap, the tooltip and "know more" system, the
guided briefing, the `/points` date register, scoreboard card geometry, and the "keep it
light" rules. Part I (§0–§15) is unchanged and Part II never overrides it.
**Companions:** `PRD.md` (what it is), `PLAN.md` (how it gets built), `design/tokens.css`
(the same `:root` block as a real file you can copy).

> **Precedence.** Where this file and `PLAN.md` disagree on a colour, a font, a radius, a
> spacing value or a motion curve, **this file wins** (PLAN.md §4.1 says so explicitly).
> Where this file is silent, use the nearest shadcn default and flag it in your report.
>
> **Nothing here is a suggestion.** Every value is a value, not a direction. If a value
> looks wrong once it is on screen, say so in your report — do not quietly substitute one.

---

## 0. Reference system

**Structure taken from Linear** (`awesome-design-md/design-md/linear.app`), **numeric
grammar taken from Stripe** (`design-md/stripe`). Two layers, declared, because mixing
references silently is how systems go incoherent:

| Layer | Source | What was taken |
|---|---|---|
| Surface & depth | Linear | Four-step surface ladder + 1px hairline borders carrying all hierarchy. **Cards get no shadow.** Shadow exists for exactly three things (drag, popover, modal). |
| Shape | Linear | 4 / 6 / 8 / 12 / 16 radius ladder. Buttons and inputs at 8, panels at 12. **No pills anywhere except avatars and the tiny status dot.** |
| Tracking | Linear | Aggressively negative on display sizes (−0.72px at 32px), flat at body. |
| Density | Linear | Dense by default: 14px body, 34px controls, 36px table rows. |
| Numeric treatment | Stripe | Tabular figures (`tnum`) on **every** cell containing a point value, an hour count, a date or an ID. This is the brand's quiet financial signal, and it is the entire reason the points ledger reads as money. |
| Ink | Stripe | Body text is deep navy, never pure black, never pure grey. |

**Deliberately left behind:** Linear's near-black canvas (this app is light — see §2.7),
Linear's lavender accent, Stripe's gradient mesh, Stripe's pill buttons, Stripe's Sohne
weight-300 display tier (Urbanist at 300 goes weak and illegible at dashboard sizes).

---

## 1. Direction

**Release, not decoration.**

A customs entry does not get prettier as it moves; it gets *endorsed*. It travels left to
right, collects marks from people with authority, and at the end it is **released** — and
that single moment is the only one worth ceremony. This app is built on that shape. Work
moves left to right across the board. Points move left to right through a three-dot chain
of custody: submitted → GM → Founder. Everything is flat, dense, hairline-ruled and quiet,
because a brokerage's product is precision, and precision looks like restraint. Then one
thing in the whole system gets a moment of craft: **points clearing**. That is the payoff
the founder logs in for, and it is the only animation in the app anyone will remember.

The second organising idea is the one Chan named: **points are money waiting to clear.**
That is not a metaphor in the copy, it is a rule in the type. Settled value is solid navy
ink. Unsettled value is *never* solid ink — it is amber with a dashed underline, exactly
the way a bank shows a pending transaction. Get that one rule right everywhere a number
appears and the product explains itself without a tooltip.

**Why it is not the HR portal.** HR was manifest-paper cream, IBM Plex and a violet stamp —
office stationery. Bland because it had no hierarchy: everything was the same size, the same
weight, on the same warm beige. Ops is cool navy on near-white, Urbanist's geometry against
Geist Mono's grid, a 40px number sitting next to an 11px uppercase label. The personality
comes from **contrast of scale**, not from adding things.

---

## 2. Colour

### 2.1 Brand — ground truth from the live site

Verified 2026-09-08 by `curl` against `lraglobalsynergychain.com`: `LRA-logo-blue.svg`
contains exactly two colours, `#041C5A` (14 uses) and `#68CEF8` (6 uses). The Next.js CSS
bundle contains exactly three, `#010F31`, `#1662E8`, `#8B8B8B`. Nothing below invents a
brand colour; the ramp is interpolated **around** those five.

| Token | Hex | Role |
|---|---|---|
| `--navy-900` | `#010F31` | Site deep navy. Sidebar, briefing chrome, founder header. |
| `--navy-800` | `#041C5A` | **Logo navy.** Secondary dark surface, dark table footers. |
| `--navy-700` | `#0A2E7E` | Hover on navy-800 surfaces. |
| `--brand-800` | `#0C3FA3` | Deepest interactive; charts. |
| `--brand-700` | `#0F4FC4` | Link text on white, primary button **active**. |
| `--brand-600` | `#1662E8` | **Primary.** Site's bright blue. Buttons, links, focus ring. |
| `--brand-500` | `#3D7FEE` | Primary on navy surfaces (`#1662E8` is too dark on navy). |
| `--brand-300` | `#9CC2F7` | Drop-target ring, chart tint. Non-text only. |
| `--brand-200` | `#C9DDFB` | Selected-row border. Non-text only. |
| `--brand-100` | `#E8F0FE` | Input focus halo. |
| `--brand-50` | `#F2F7FF` | Drop-target fill, selected row fill. |
| `--cyan` | `#68CEF8` | **Logo cyan.** See the restraint rule below. |

#### The cyan rule (binding)

`#68CEF8` scores **1.78:1 on white**. It is not a light-mode colour and it must never be
used as one. Rule, no exceptions:

> **Cyan only ever appears on navy.**

That gives it exactly three homes, and it may not appear anywhere else:

1. The **2px left indicator bar** on the active sidebar nav item (`#68CEF8` on `#010F31` —
   10.57:1).
2. The **focus ring on navy surfaces** — `--ring-on-navy` (8.93:1 on `#041C5A`).
3. The **week-progress fill** in the navy briefing header, and the logo mark itself.

Because cyan is rationed, it reads as the brand instead of as decoration. Spraying it is
the single fastest way to make this look like a template.

### 2.2 Neutrals — a cool ramp, tinted toward the navy

Not Tailwind slate. Tailwind slate next to `#010F31` reads muddy-warm.

| Token | Hex | Role |
|---|---|---|
| `--canvas` | `#F7F8FA` | App background. Everything sits on this. |
| `--surface` | `#FFFFFF` | Panels, cards, table bodies, popovers, dialogs. |
| `--surface-2` | `#F1F3F7` | Board column background, row hover, ghost-button hover, table head. |
| `--surface-3` | `#E7EAF1` | Pressed states, disabled input fill, board column header. |
| `--hairline` | `#E2E6EE` | Default 1px border. Cards, table rows, dividers. |
| `--hairline-strong` | `#CBD2E0` | Input borders, secondary-button borders, drag placeholder. |
| `--ink` | `#0B1B3F` | Headings and primary body. 16.90:1 on white, 15.90:1 on canvas. |
| `--ink-2` | `#47536B` | Secondary body, table cells. 7.73:1 / 7.27:1. |
| `--ink-3` | `#5F6B80` | Labels, captions, timestamps, eyebrows. 5.38:1 / 5.07:1. |
| `--ink-disabled` | `#8A94A6` | Disabled text only. 3.06:1 — **exempt** under WCAG 1.4.3 (disabled controls). Never use for live text. |
| `--on-dark` | `#FFFFFF` | Text on navy and on filled buttons. |
| `--on-dark-2` | `#C9D3E8` | Sidebar nav idle label. 12.54:1 on navy-900. |
| `--on-dark-3` | `#8FA0C4` | Sidebar section headings, meta on navy. 7.18:1 on navy-900. |

> **Hard rule:** `--ink-3` is legal on `--surface`, `--canvas` and `--surface-2`. It is
> **illegal on `--surface-3`** (4.47:1, fails AA). Use `--ink-2` there.

### 2.3 Semantics — one hue per meaning

Five states, five hues, chosen so that a colour-blind reader still has hue *and* shape
(icon, dash, dot) to separate them.

| Meaning | Token | Fill | Wash | Border | Contrast (fill on white / on wash) |
|---|---|---|---|---|---|
| Cleared / success | `--cleared` | `#0E7A46` | `#E6F4EC` | `#BFE3CE` | 5.40 / 4.76 |
| Pending / waiting to clear | `--pending` | `#8A5A00` | `#FCF3E3` | `#EBD9AE` | 5.93 / 5.38 |
| Rejected / returned / danger | `--danger` | `#B3261E` | `#FBEBE9` | `#F0CFCD` | 6.54 / 5.65 |
| Blocked / stalled | `--blocked` | `#475569` | `#EEF1F5` | `#D3DAE4` | 7.58 / 6.69 |
| Info / this-week / committed | `--brand-600` | `#1662E8` | `#F2F7FF` | `#C9DDFB` | 5.32 / 4.95 |

**White on a filled semantic chip:** cleared 5.40, pending 5.93, danger 6.54, blocked 7.58 —
all pass AA for normal text.

> **Judgment call — `--blocked` is a slate, not a sixth hue.** I considered giving "blocked"
> its own chromatic colour. Rejected: pending (amber), rejected (red) and a third warm hue
> would be three muddy neighbours, and violet is the HR portal's identity that Chan is
> replacing. So blocked is a **strong neutral plus a 45° hatch** (`--hatch-blocked`, §5.4).
> The reasoning is honest, not just aesthetic: *blocked is a stall, not an error* — nobody
> did anything wrong. If a block passes 24h the **age counter** turns `--danger`, which is
> the part that should feel bad. Chan: say the word and blocked becomes `#9A3412` burnt
> orange instead, one token change.

### 2.4 Chart colours

`--chart-1` `#1662E8` · `--chart-2` `#0E7A46` · `--chart-3` `#8A5A00` · `--chart-4`
`#041C5A` · `--chart-5` `#64748B`.
Rule: on the reliability/hit-rate sparkline the line is `--chart-1` at 1.5px; the "8-week
average" reference line is `--hairline-strong` at 1px dashed `2 3`. No area fills, no
gradients under lines, no dots except on the most recent point.

### 2.5 The reliability bands (PRD §5.3)

| Band | Text | Wash | Notes |
|---|---|---|---|
| Excellent 90–100 | `--cleared` `#0E7A46` | `#E6F4EC` | |
| Solid 75–89 | `--ink-2` `#47536B` | `#F1F3F7` | Deliberately unremarkable — "fine" should look fine. |
| Watch 60–74 | `--pending` `#8A5A00` | `#FCF3E3` | |
| At risk 0–59 | `--danger` `#B3261E` | `#FBEBE9` | |
| **Unrated** | `--ink-3` `#5F6B80` | none, `1px dashed --hairline-strong` | A thin file is an absence, so it gets an outline and no fill. Renders `—` not `0`. |

### 2.6 shadcn variable mapping — exact values

`npx shadcn init` will write HSL triplets and `hsl(var(--x))` wrappers. **Overwrite them.**
This project uses raw colour values so there is one source of truth and a token can be
inspected in DevTools as a colour. After `init`, replace the generated block with §9 and
delete every `hsl(...)` wrapper from `tailwind.config.ts`.

| shadcn var | Value | = our token |
|---|---|---|
| `--background` | `#F7F8FA` | canvas |
| `--foreground` | `#0B1B3F` | ink |
| `--card` | `#FFFFFF` | surface |
| `--card-foreground` | `#0B1B3F` | ink |
| `--popover` | `#FFFFFF` | surface |
| `--popover-foreground` | `#0B1B3F` | ink |
| `--primary` | `#1662E8` | brand-600 |
| `--primary-foreground` | `#FFFFFF` | on-dark |
| `--secondary` | `#F1F3F7` | surface-2 |
| `--secondary-foreground` | `#0B1B3F` | ink |
| `--muted` | `#F1F3F7` | surface-2 |
| `--muted-foreground` | `#5F6B80` | ink-3 |
| `--accent` | `#F2F7FF` | brand-50 |
| `--accent-foreground` | `#0F4FC4` | brand-700 (6.65:1 on brand-50) |
| `--destructive` | `#B3261E` | danger |
| `--destructive-foreground` | `#FFFFFF` | on-dark |
| `--border` | `#E2E6EE` | hairline |
| `--input` | `#CBD2E0` | hairline-strong |
| `--ring` | `#1662E8` | brand-600 |
| `--radius` | `0.5rem` | 8px |

`--accent` / `--accent-foreground` are what shadcn uses for **hovered menu items and
selected combobox rows.** Getting them right is what stops every dropdown in the app from
looking like default slate.

### 2.7 Dark mode — recommendation: **out of scope for the MVP**

Three reasons, and I am recommending, not deciding:

1. The briefing screen runs on a **shared display in a lit meeting room**. Dark mode is the
   wrong default for the app's highest-stakes surface.
2. The brand is a light brand — the marketing site declares `color-scheme: light`.
3. A second theme doubles the token surface (five semantic hues × fill/wash/border, plus
   the whole neutral ladder) before the first one has been used in anger.

**But leave the door open, at zero cost:** every colour lives in `:root` and **no component
may contain a literal hex, `rgb()`, or a Tailwind palette class** (`bg-slate-100`,
`text-gray-500`, `border-zinc-200` are all banned). Adding dark mode later is then one
`.dark { }` block in one file. The coder must enforce this; the tester should grep for it.

---

## 3. Typography

### 3.1 Families

```
--font-sans: 'Urbanist Variable', 'Urbanist', ui-sans-serif, system-ui, -apple-system, sans-serif;
--font-mono: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;
```

Self-hosted via `@fontsource-variable/urbanist` and `@fontsource-variable/geist-mono`
(PLAN §4.1 — no `fonts.googleapis.com` link; the briefing display cannot depend on
Google being reachable). Import weights 400–700 only.

Global: `-webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;`
Urbanist has open, geometric forms; it needs antialiasing to not look chunky at 13–14px.

### 3.2 The mono rule (binding)

> **Geist Mono is used for every figure a person could argue about, and nothing else.**

Mono, always with `font-feature-settings: 'tnum' 1, 'zero' 1`:

- point values (chips, balances, catalog, ledger, overrides)
- hour and day counts (blocked hours, staleness age, "3d", "41h", cycle time)
- percentages (hit-rate, carry-over rate, recurring-cap %)
- reliability scores
- dates, times, week identifiers (`W38 · 2026`), task IDs, week ranges
- PHP amounts, if Phase 2 quotes/advances land

**Not mono:** task titles, names, reasons, catalog guideline notes, buttons, nav, prose.
Mono for anything narrative makes the app look like a terminal toy.

`'zero' 1` gives Geist Mono's slashed zero — necessary because point values and IDs sit
next to each other and `0`/`O` must never be ambiguous on a shared display.

### 3.3 Sans scale

Base is **14px**, not 16px. This is a dense internal tool; 16px body forces scroll on the
founder's dashboard. The compensation is that nothing live is smaller than 11px and every
size below passes AA.

| Class | px | Weight | Line-height | Tracking | Where |
|---|---|---|---|---|---|
| `text-display` | 32 | 600 | 1.10 | −0.72px | Briefing screen section headers only |
| `text-title-lg` | 24 | 600 | 1.15 | −0.48px | Briefing sub-headers, person profile name |
| `text-title` | 20 | 600 | 1.25 | −0.30px | Page title (one per screen) |
| `text-subtitle` | 16 | 600 | 1.35 | −0.15px | Panel/card headers, dialog titles |
| `text-strong` | 14 | 600 | 1.40 | −0.05px | Board card title, table row emphasis |
| `text-body` | 14 | 400 | 1.50 | 0 | Default. Paragraphs, form values |
| `text-body-sm` | 13 | 400 | 1.45 | 0 | Table cells, card meta, help text |
| `text-label` | 12 | 500 | 1.35 | 0 | Form labels, chip text, inline meta |
| `text-eyebrow` | 11 | 600 | 1.20 | **+0.08em**, `uppercase` | Board column headers, table headers, sidebar group titles, balance labels |
| `text-micro` | 11 | 500 | 1.30 | 0 | Badge counts, footnotes |

`text-eyebrow` is doing a lot of work: it is the single device that makes this look
designed rather than generated. Uppercase 11/600 at +0.08em against a 32px number is the
scale contrast the whole system leans on. **Use it for every column and table header.**

Max line length for prose (rejection reasons, catalog guideline notes): `max-width: 68ch`.

### 3.4 Mono scale

| Class | px | Weight | Line-height | Tracking | Where |
|---|---|---|---|---|---|
| `num-hero` | 40 | 500 | 1.00 | −1.0px | The three balance figures |
| `num-lg` | 24 | 500 | 1.00 | −0.40px | Scorecard cells, reliability score, leaderboard |
| `num-md` | 16 | 500 | 1.00 | −0.20px | Board card point chip, week totals |
| `num-sm` | 13 | 500 | 1.20 | 0 | Table numeric cells, ages, hours |
| `num-xs` | 11 | 500 | 1.20 | +0.02em | IDs, timestamps, `W38 · 2026` |

Numeric table columns are `text-align: right`, `white-space: nowrap`, and their header is
also right-aligned. Non-negotiable — the whole point of `tnum` is columns that line up.

---

## 4. Space, shape, depth

### 4.1 Spacing

4px base. Use only: `2 4 6 8 12 16 20 24 32 40 48 64`. Anything else is a bug.

| Situation | Value |
|---|---|
| Page gutter | `px-6` (24) mobile/tablet, `px-8` (32) ≥1280 |
| Page vertical | `py-6` (24), page header `mb-5` (20) |
| Panel padding | `p-5` (20); dense panel `p-4` (16) |
| Board card padding | `12px 12px` |
| Gap between board cards | `8px` |
| Gap between board columns | `12px` |
| Gap between panels | `16px` |
| Form field vertical gap | `16px`; label→input `6px`; input→error `4px` |
| Table cell padding | `8px 12px` (row height 36px) |
| Icon→label gap | `6px` |
| Chip padding | `2px 7px` |

Content max width: `1440px` centred for dashboards; **the board is full-bleed and scrolls
horizontally**; the briefing screen is `1200px` centred (it is read, not scanned).

### 4.2 Radii

`--radius-xs 4px` chips/badges/dots · `--radius-sm 6px` small buttons, inline tags ·
`--radius-md 8px` **buttons, inputs, board cards, dropdown items** · `--radius-lg 12px`
panels, cards, board columns · `--radius-xl 16px` dialogs, briefing panels ·
`--radius-full` avatars and the 6px chain-of-custody dots only.

No pills. Pills read consumer; this is an instrument.

### 4.3 Borders

Everything structural is a **1px hairline**. `--hairline` by default, `--hairline-strong`
on things you can type into or grab. Border is the primary hierarchy device — if you are
reaching for a shadow to separate two surfaces, use a border and a surface step instead.

### 4.4 Elevation — exactly three shadows

```
--shadow-pop:   0 4px 16px -2px rgba(1,15,49,.12), 0 1px 3px rgba(1,15,49,.08);
--shadow-drag:  0 8px 24px -4px rgba(1,15,49,.18), 0 2px 6px -1px rgba(1,15,49,.10);
--shadow-modal: 0 24px 64px -12px rgba(1,15,49,.28);
```

`--shadow-pop` → popover, dropdown, select, tooltip, command palette.
`--shadow-drag` → a card **while it is being dragged**, and only then.
`--shadow-modal` → dialog and sheet.

**Cards, panels, tables, board columns and chips have no shadow, ever.** Depth ladder is
`canvas → surface-2 → surface → hairline`, Linear-style. A shadow in this app means
"this is temporarily above the document", which is exactly the drag/overlay meaning.

Scrim for dialogs: `rgba(1,15,49,0.40)` with `backdrop-filter: blur(2px)`.

---

## 5. Components

Every interactive element gets `:focus-visible { outline: 2px solid var(--ring);
outline-offset: 2px; border-radius: inherit; }`. On navy surfaces `--ring-on-navy`
(`#68CEF8`). **Never `outline: none` without an equivalent replacement.** Ring vs white =
5.32:1, vs canvas = 5.01:1 (needs 3:1 for non-text — passes with room).

Minimum hit target **44×44 CSS px** on touch. Controls render at 34px high, so any
icon-only control gets `position: relative` + an `::after` inset `-5px` hit expander, or
`p-2.5` padding. This applies to: board card menu, chip dismiss, table row actions,
notification bell, sidebar collapse. The tester will check this.

### 5.1 Button

Heights: `sm 28` · `default 34` · `lg 40`. Padding `0 14px` (sm `0 10px`, lg `0 18px`).
Radius 8. Type `text-strong` (14/600). Icon 16px, gap 6px.
`transition: background-color 120ms var(--ease), border-color 120ms var(--ease), transform 120ms var(--ease-out);`

| Variant | Default | Hover | Active | Disabled |
|---|---|---|---|---|
| `primary` | bg `#1662E8`, text `#FFF` | bg `#1355C9` (6.62:1) | bg `#0F4FC4` + `scale(.98)` | bg `#A9C4F5`, text `#FFF`, `cursor: not-allowed`, no hover |
| `secondary` | bg `#FFF`, 1px `#CBD2E0`, text `--ink` | bg `#F1F3F7`, border `#B7C0D2` | bg `#E7EAF1` + `scale(.98)` | bg `#F7F8FA`, border `#E2E6EE`, text `--ink-disabled` |
| `ghost` | transparent, text `--ink-2` | bg `#F1F3F7`, text `--ink` | bg `#E7EAF1` | text `--ink-disabled` |
| `destructive` | bg `#B3261E`, text `#FFF` | bg `#9C201A` | bg `#851B16` + `scale(.98)` | opacity .5 |
| `clear` | bg `#0E7A46`, text `#FFF` | bg `#0C6A3D` | bg `#0A5A34` + `scale(.98)` | opacity .5 |

**`clear` is the founder's approve button and it exists nowhere else in the app.** A green
fill anywhere other than the approvals queue is a bug. That restraint is what makes the
approve action feel like an event.

**Loading:** button keeps its exact width (measure and lock, or `min-width`), the leading
icon slot swaps to a 14px spinner (1.5px stroke, `currentColor` at 35%/100% arc, 600ms
linear rotate), label stays put, element gets `disabled` + `aria-busy="true"`. **No width
jump, no label swap to "Loading…".**

Press feedback (`scale(.98)`) is required on every button. It is the cheapest thing in the
system and it is what makes the app feel like it is listening.

### 5.2 Input / Select / Textarea

Height 34 (textarea `min-height: 80`), radius 8, `1px #CBD2E0`, bg `#FFF`, padding `0 10px`
(textarea `8px 10px`), type `text-body`, placeholder `--ink-3`.

| State | Treatment |
|---|---|
| Hover | border `#B7C0D2` |
| Focus | border `#1662E8`, `box-shadow: 0 0 0 3px #E8F0FE`, plus the standard focus ring |
| Error | border `#B3261E`, `box-shadow: 0 0 0 3px #FBEBE9`, `aria-invalid="true"`, message below in `text-label` `--danger` with a 12px `AlertCircle` |
| Disabled | bg `#F1F3F7`, border `#E2E6EE`, text `--ink-disabled` |
| Read-only | bg transparent, border transparent, text `--ink`, no hover |

Label `text-label` `--ink-2`. Required marker is the word `Required` in `text-micro`
`--ink-3` on the right of the label row — **not** a red asterisk.

Every `reason` field in this app (rejection, points override, block) is a `textarea` with a
**live character minimum**: `min 10 chars`, counter in `num-xs` `--ink-3`, turning
`--danger` under the minimum only after first blur. Submitting a reason is a moment of
accountability; the UI should make it feel deliberate, not like a formality.

### 5.3 Panel / Card (non-board)

`bg #FFF`, `1px #E2E6EE`, radius 12, no shadow, `p-5`.
Header row: `text-subtitle` left, actions right, `pb-4`, then `border-bottom: 1px #E2E6EE`
only if the body is a list or a table (a prose body gets no rule).
Interactive card (person tile, catalog row): hover `border-color: #CBD2E0` +
`background: #FCFDFF`; **never** a hover lift or shadow.

### 5.4 Board card — the specification

The board card is the most-touched object in the app. Everything is fixed.

```
┌──────────────────────────────────────────────┐
│ ▏ [type eyebrow]                    [ 8 ]   │   ← 11/600 uppercase ink-3 · mono num-md
│ ▏ Clear BOC entry for Cebu shipment          │   ← text-strong, clamp 2 lines
│ ▏ ┌──┐                                       │
│ ▏ │MB│  ⟳2w   ◷3d   ⛌1                       │   ← 20px avatar · mono num-xs badges
└──────────────────────────────────────────────┘
```

- `bg #FFF`, `1px #E2E6EE`, radius 8, padding 12, **no shadow at rest**.
- Left status rail: a `3px` full-height bar on the left edge (inside the radius) whose
  colour is the card's dominant state — `--brand-600` committed, `--blocked` blocked,
  `--pending` submitted/verified, `--cleared` cleared, `--hairline-strong` uncommitted.
  **This rail is the only place two states can be resolved into one colour**, and its
  priority order is: blocked > pending > cleared > committed > none.
- Title: `text-strong`, `--ink`, `-webkit-line-clamp: 2`.
- Type eyebrow: catalog type name, `text-eyebrow`, `--ink-3`.
- **Point chip:** `num-md`, `--ink` when the card is cleared, `--pending` with a
  `border-bottom: 1px dashed currentColor` when submitted/verified, `--ink-2` otherwise.
  The dashed underline is the money-not-yet-cleared signal from §6 and it is the same
  everywhere. If points were overridden, prefix with a 12px `Pencil` icon and put the
  reason in the tooltip — **never hide an override**.
- Avatar 20px, `--radius-full`, initials `text-micro` on `--navy-800`, `#FFF` text.
- Meta badges, `num-xs` in `--ink-3`, each with a 12px lucide icon, `gap 6px`:
  `RotateCcw 2w` carry-over age · `Clock 3d` staleness · `Ban 1` open blocks.
  Staleness badge turns `--pending` at 3d and `--danger` at 7d.
  Carry-over badge turns `--danger` at 3+ consecutive weeks (it is a −2 reliability hit).
- **Blocked card:** the card body gets `--hatch-blocked`, a 45° 4px repeating gradient of
  `#EEF1F5` / `#E4E9F0`, at 100% opacity behind white content areas. It is texture, not
  colour, so it survives greyscale printing of the briefing screen.

| State | Treatment |
|---|---|
| Hover | `border-color: #CBD2E0`; the `⋯` menu fades in `opacity 0→1` 120ms; **no lift** |
| Focus-visible | standard 2px ring, `outline-offset: 2px` |
| Selected (bulk/briefing commit) | `bg #F2F7FF`, `border #C9DDFB`, 3px rail → `--brand-600` |
| Grabbed | see §7.2 |
| Placeholder (vacated slot) | `1px dashed #CBD2E0`, radius 8, transparent fill, exact height of the grabbed card, no animation |
| Optimistic-pending (transition in flight) | `opacity: .6`, `pointer-events: none`, 12px spinner top-right |
| Rejected-by-server | card snaps back, `border-color` flashes to `--danger` for 900ms then eases back over 200ms; a `sonner` toast carries the **database's own message**, never "Something went wrong" |

### 5.5 Board column

`bg #F1F3F7`, radius 12, no border, width `288px` fixed, `padding 8px`, header
`padding 8px 8px 12px`.
Header: `text-eyebrow` `--ink-2` + count in `num-xs` `--ink-3` in a `#E7EAF1` radius-4 chip
+ a right-aligned column point total in `num-sm`. The **Blocked** column header gets a 12px
`Ban` in `--blocked`; the **Cleared** column header gets a 12px `CheckCircle2` in
`--cleared`. No other column gets an icon.
Empty column: see §8.

### 5.6 Table

Full-width, `border-collapse: collapse`, on `--surface` inside a radius-12 panel with
`overflow: hidden`.
`thead`: `bg #F1F3F7`, `text-eyebrow` `--ink-2`, `height 32px`, `padding 0 12px`,
`border-bottom: 1px #E2E6EE`. Sticky (`position: sticky; top: 0; z-index: 1`) on any table
that can exceed 12 rows.
`tbody tr`: `height 36px`, `border-bottom: 1px #E2E6EE`, last row none.
Hover `bg #F7F8FA`. Selected `bg #F2F7FF`. Clickable rows get `cursor: pointer` and the
whole row is a focus target.
Numeric columns right-aligned, `num-sm`. Zebra striping is **banned** — hairlines already
do that job and stripes fight the tinted status washes.

### 5.7 Chip / Badge

`height 20px`, `padding 2px 7px`, radius 4, `text-label` (12/500), `gap 4px`, optional 12px
icon. Two forms only:
- **soft** (default): `background: <wash>`, `color: <fill>`, `border: 1px <border>`.
- **solid** (counts on navy, notification badge): `background: <fill>`, `color: #FFF`.
No outline-only chips, no pill chips, no gradient chips.

### 5.8 App shell

- **Sidebar** `240px` (collapsed `64px`), `bg --navy-900 #010F31`, no border, full height.
  Logo lockup at top, `padding 16px`, `LRA-logo-blue.svg` at `24px` height on navy —
  the logo file is already the on-navy version.
  Group headings `text-eyebrow` `--on-dark-3`, `padding 16px 12px 6px`.
  Nav item: `height 34px`, radius 6, `padding 0 10px`, `text-body` `--on-dark-2`, 16px icon.
  Hover `bg rgba(255,255,255,.06)`, text `#FFF`.
  **Active**: `bg rgba(255,255,255,.10)`, text `#FFF`, weight 600, plus a `2px × 16px`
  `--cyan` bar at `left: 0`, vertically centred, radius `0 2px 2px 0`. `aria-current="page"`.
  Badge counts (approvals waiting, unread) right-aligned, solid chip, `--brand-500` on navy.
- **Page header**: `text-title` + optional `text-body-sm --ink-3` description underneath,
  actions right-aligned on the same baseline as the title, `mb-5`. One `primary` button
  maximum per page header.
- **Week context strip**, present on every page under the header: `W38 · 15–21 Sep 2026`
  in `num-xs`, the week state as a soft chip (`planning` blocked-slate / `open` brand /
  `closed` ink-2), and days remaining in `num-xs`. Left-aligned, 32px tall, hairline
  bottom border. This is what makes "the unit is the week" a fact of the UI rather than a
  claim in the PRD.
- **Notification inbox**: Radix popover, `380px`, `--shadow-pop`, radius 12, max-height
  `min(520px, 70vh)`. Unread row `bg #F2F7FF` with a `6px` `--brand-600` dot at the left;
  read rows plain. Grouped by `Today` / `Earlier` under `text-eyebrow` headings.

---

## 6. The bank-balance metaphor — spec

This is the part Chan named, so it is specified to the pixel.

### 6.1 The one rule

> **Settled value is solid ink. Unsettled value is never solid ink.**

| Money state | Colour | Extra device |
|---|---|---|
| Cleared | `--ink` `#0B1B3F` | none — solid, finished |
| Pending (with GM or Founder) | `--pending` `#8A5A00` | `border-bottom: 1px dashed currentColor` |
| Committed, not yet submitted | `--ink-3` `#5F6B80` | none |
| Rejected / returned | `--danger` `#B3261E` | `text-decoration: line-through` on the figure |

This applies to **every** point figure in the app: balance panel, board chips, tables,
leaderboard, scorecard, ledger. A reader learns it in one glance and never needs a legend.

### 6.2 The balance panel

One panel (`--surface`, radius 12, `1px --hairline`, `p-5`), three cells in a row
(`grid-cols-3`, stacked below 768px), separated by `1px --hairline` vertical rules.

```
  CLEARED THIS WEEK        WAITING TO CLEAR          COMMITTED
        21                       13                      34
  ────────────────      ┌──────────────────┐    ─────────────────
  W38 · 15–21 Sep       │ 8 with GM        │    5 tasks not yet
                        │ 5 with Founder   │    submitted
                        │ oldest 3d ← amber│
                        └──────────────────┘
```

- Figures: `num-hero` (40/500/−1px), coloured by §6.1.
- Labels above: `text-eyebrow` `--ink-3`.
- **The pending cell is the only tinted region on the panel** — `bg --pending-wash #FCF3E3`,
  radius 8, `padding 12px`, extending 12px beyond the figure. Everything else sits on white.
  That is deliberate: the pending figure is the number that makes a slow approver visible,
  and it should be the thing your eye lands on. One tinted region on the page; not two.
- The pending breakdown ("8 with GM", "5 with Founder") is `num-sm` + `text-body-sm`.
- "Oldest item waiting **3d**" renders `--pending` at ≥2d and `--danger` at ≥4d. That single
  line is the accountability mechanism from PRD §3.5, so it is always present, never
  collapsed behind a disclosure.
- Below the row, a **4px settlement bar**, full width, radius full: `--cleared` for the
  cleared proportion, `--pending` for pending, `--surface-3` for committed-not-submitted.
  No labels, no legend, no percentages — it is a texture, not a chart.

### 6.3 Chain of custody

Every ledger row and every submitted/verified card carries a **24px three-dot chain**:

```
 ●───●───○      6px dots, 1px --hairline-strong connectors, radius full
```

- Passed step: filled `--cleared`.
- Current step (where it is sitting now): filled `--pending`, plus a `2px` ring in
  `--pending-wash`.
- Not reached: `1px --hairline-strong` outline, transparent fill.
- Rejected: the step where it was rejected becomes `--danger` with a 8px `X`; steps after
  it stay outlined.

`aria-label` reads e.g. `"Submitted, verified by GM, waiting on Founder"`. The dots are
decorative to a screen reader (`aria-hidden`) — the label carries the meaning.

### 6.4 The ledger

Append-only, so it renders as a **register**, not a data grid: newest first, grouped by day
under `text-eyebrow` day headings, one 36px row each:
`[time num-xs] [chain] [task title text-body-sm] [actor text-body-sm --ink-3] [Δpoints num-sm]`.
Δ renders `+8` in `--cleared` on a clearing, and `—` (em dash, `--ink-3`) on any non-crediting
transition, because only clearing moves money. Rows are never editable and there is no
delete affordance anywhere on this screen — the immutability should be visible.

---

## 7. Motion

```
--ease:         cubic-bezier(0.4, 0, 0.2, 1);      /* colour / hover only */
--ease-out:     cubic-bezier(0.23, 1, 0.32, 1);    /* enter, drop, release */
--ease-in-out:  cubic-bezier(0.77, 0, 0.175, 1);   /* on-screen movement */
--dur-press: 120ms;  --dur-fast: 160ms;  --dur-pop: 200ms;
--dur-dialog: 260ms; --dur-clear: 420ms;
```

**No `ease-in` anywhere. No `transition: all` anywhere.** Only `transform`, `opacity`,
`background-color`, `border-color`, `color`, `box-shadow`, `clip-path`, `filter` are
animated. `height`, `width`, `margin`, `padding`, `top/left` are never animated.

### 7.1 Where motion is allowed

| Allowed | Spec |
|---|---|
| Button / card press | `transform: scale(.98)`, `--dur-press`, `--ease-out` |
| Hover colour changes | `--dur-press`, `--ease`, behind `@media (hover: hover) and (pointer: fine)` |
| Dropdown / popover / select / tooltip | `opacity 0→1`, `transform: scale(.97)→1`, `--dur-pop`, `--ease-out`, `transform-origin: var(--radix-popover-content-transform-origin)` |
| Dialog / sheet | content `opacity 0→1` + `scale(.96)→1` centred origin, scrim `opacity 0→1`, `--dur-dialog`, `--ease-out`. Exit `--dur-fast` |
| Toast (`sonner`) | library defaults; enter from bottom-right, exit same direction |
| Drag & drop | §7.2 |
| Points clearing | §7.3 |
| Sparkline | `stroke-dashoffset` draw, 500ms `--ease-out`, **on first mount only**, never on re-render |
| Accordion / collapsible | Radix `--radix-collapsible-content-height` keyframe, `--dur-pop`, `--ease-out` |
| Skeleton | `opacity .55↔1`, 1.4s `ease-in-out` alternate. **No shimmer sweep.** |

### 7.2 Where motion is banned

Route changes · sidebar nav (used dozens of times a day — Raycast rule) · table rows
appearing, sorting or filtering · number count-ups on page load · the "who's working on
what" screen when it polls (changed values crossfade `opacity` over 160ms, nothing moves) ·
any stagger longer than 4 items · anything on the briefing screen while someone is
speaking to it.

### 7.3 Drag and drop (`@dnd-kit`) — craft moment #1

The board is the primary interaction and it runs on a touch display in the meeting.

**Pick up** (`onDragStart`), 140ms `--ease-out`:
`transform: scale(1.02)`, `box-shadow: none → --shadow-drag`, `cursor: grabbing`,
`opacity: 1`. Activation constraint: pointer `distance: 6px` (so a tap still opens the card)
and touch `delay: 180ms, tolerance: 6px` (so a scroll still scrolls).

> **Judgment call, flagged:** I am specifying **no rotation** on the grabbed card. A 1–2°
> tilt reads playful/Trello; Chan asked for Linear-sharp. If he wants it warmer, add
> `rotate(1.2deg)` to the same transform — one line, no other change.

**Origin slot:** becomes the dashed placeholder from §5.4 immediately, no transition.
**Sibling cards:** reflow with `@dnd-kit/sortable`'s transform at 200ms `--ease-in-out`.
**Drop target:** the hovered column only — `background: #F1F3F7 → #F2F7FF` and
`box-shadow: inset 0 0 0 1px #9CC2F7`, 120ms `--ease`. Never highlight all columns; never
highlight a column the card cannot legally enter.
**Illegal target:** `cursor: not-allowed`, `box-shadow: inset 0 0 0 1px #CBD2E0`, no fill
change. The card cannot be dropped there; nothing "bounces".
**Drop** (`onDragEnd`): dnd-kit `dropAnimation` `duration: 200, easing: var(--ease-out)`;
shadow returns to `none` and scale to `1` over the same 200ms, together.
**Server rejection:** the card lands in its new column optimistically, then returns to
origin over 200ms `--ease-out` and flashes `--danger` per §5.4. It never disappears and
reappears.
**Keyboard:** dnd-kit `KeyboardSensor` — Space picks up, arrows move, Space drops, Esc
cancels. Screen-reader announcements must be written in LRA's language, not dnd-kit's
defaults: `"Picked up 'Clear BOC entry', 8 points, from In progress."` /
`"Moved to Submitted. Waiting on GM."` / `"Move cancelled, returned to In progress."`
This is a hard requirement, not polish: the founder may run the board from a keyboard on a
shared display.
**Dropping into Blocked** opens the required block dialog *before* the optimistic move
commits. If the dialog is cancelled, the card returns to origin with the standard 200ms
drop animation — no error flash, because cancelling is not a failure.

### 7.4 Points clearing — craft moment #2

Fires when the founder approves. It is rare, it is meaningful, and it is the one animation
in this app that is allowed to be a small event. Total 420ms.

1. **0–120ms** — the approved row's border eases `--hairline → --cleared-border #BFE3CE`;
   the current chain dot fills `--pending → --cleared`; the next dot's outline fills.
2. **60–320ms** — **the release sweep.** A `--cleared-wash #E6F4EC` overlay on the row is
   revealed left → right via `clip-path: inset(0 100% 0 0) → inset(0 0 0 0)`, 260ms
   `--ease-out`. Left-to-right because that is the direction of custody in this whole
   system — the same direction the board columns run and the chain dots run. Then it fades
   out `opacity 1→0` over 160ms starting at 320ms.
3. **120–500ms** — **the transfer.** The Pending figure tweens down and the Cleared figure
   tweens up, simultaneously, 380ms `--ease-in-out`, driven on the numeric value (mono
   `tnum` means the width never shifts). At the crossover both figures pass through
   `filter: blur(1.5px)` and back — Emil's trick for masking a value swap so it reads as
   one transformation rather than two elements changing. The Cleared figure additionally
   does `scale(1) → 1.04 → 1` over 180ms `--ease-out` peaking at 260ms. The settlement bar
   (§6.2) animates its segment widths over the same 380ms `--ease-in-out`.
4. **320–480ms** — the row leaves the pending list: `opacity 1→0`, `transform: translateX(4px)`,
   160ms `--ease-out`; remaining rows close the gap over 200ms `--ease-in-out`.

No confetti. No sound. No checkmark that draws itself. The sweep and the number are enough,
and they will still feel good on the four-hundredth approval.

### 7.5 Reduced motion

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

Then **restore the transitions that carry meaning**, as opacity/colour only:

- Clearing: no sweep, no tween, no scale. The row's background goes `--cleared-wash` and the
  figures **snap** to their new values, with a 120ms `opacity` crossfade so the change is
  still perceptible. Meaning preserved, movement removed.
- Drag: dnd-kit `dropAnimation: null`, no pick-up scale, **keep** the drop-target background
  change (it is the only thing telling the user where the card will land).
- Popovers/dialogs: `opacity` only, 120ms. No scale.
- Skeleton pulse: static `opacity: .7`, no animation.
- Sparkline: renders complete, no draw.

The coder must read the preference in JS too (`useReducedMotion` or
`matchMedia('(prefers-reduced-motion: reduce)')`) for the dnd-kit and number-tween paths —
CSS alone will not stop a JS-driven tween.

---

## 8. Empty, loading, error states

Most misses live here. Every list surface below needs all four.

| Surface | Empty copy | Treatment |
|---|---|---|
| Board column | `No tasks` | `text-body-sm --ink-3`, centred, `padding 24px 8px`, `1px dashed --hairline-strong` radius 8 inset by 4px. Still a valid drop target — it must highlight on hover-drag. |
| Approvals queue | `Nothing waiting on you.` + `text-body-sm --ink-3`: `Submitted work will appear here.` | Panel, 16px `CheckCircle2` in `--ink-3` above. **No illustration.** |
| Ledger | `No points yet this week.` | Register with the day headings suppressed. |
| Notifications | `You're all caught up.` | 200px min height. |
| Leaderboard, <3 weeks history | `Not enough history to rank.` | Rows still render with `—` in the reliability column, band chip `Unrated`. |
| Who's working now | Per-person `Nothing in progress` in `--ink-3` — **never** collapse the person's column. Absence is the information. |
| Briefing, week not yet planned | `Week 38 hasn't been opened.` + `primary` button `Open the week` | Centred, `max-width 420px`. |

**Loading.** Skeletons that match the real layout's geometry (`--surface-2`, radius 4,
exact final heights), never a centred spinner on a full page. Board: three skeleton cards
per column. Tables: five skeleton rows. Numbers: a skeleton block the width of the final
figure — `tnum` makes that predictable.

**Error.** Panel-level: `--danger-wash` band inside the panel with the real message and a
`secondary` `Retry`. Never a full-page error for a partial failure. Every server message is
surfaced verbatim (PRD §6.1 — the database's own message, not a swallowed generic).

**Zero vs nothing.** `0` and "no data" are different and must look different. A real zero
renders `0` in mono; an absence renders `—` (em dash) in `--ink-3`. Reliability with a thin
file renders `—`, never `0`. Getting this wrong is the difference between "you failed" and
"we don't know yet", and this app is a management instrument — it must not accuse someone
by rendering a default.

---

## 9. Ready to paste — `src/index.css`

Also written to `design/tokens.css` in this repo. Copy it in **before** generating the
first component, then run the shadcn init check in PLAN.md step 4a.

```css
@import '@fontsource-variable/urbanist';
@import '@fontsource-variable/geist-mono';

@tailwind base;
@tailwind components;
@tailwind utilities;

:root {
  color-scheme: light;

  /* ── brand ─────────────────────────────────────────── */
  --navy-900: #010F31;
  --navy-800: #041C5A;
  --navy-700: #0A2E7E;
  --brand-800: #0C3FA3;
  --brand-700: #0F4FC4;
  --brand-600: #1662E8;
  --brand-500: #3D7FEE;
  --brand-300: #9CC2F7;
  --brand-200: #C9DDFB;
  --brand-100: #E8F0FE;
  --brand-50:  #F2F7FF;
  --cyan:      #68CEF8;   /* ON NAVY ONLY — 1.78:1 on white */

  /* ── neutrals ──────────────────────────────────────── */
  --canvas:          #F7F8FA;
  --surface:         #FFFFFF;
  --surface-2:       #F1F3F7;
  --surface-3:       #E7EAF1;
  --hairline:        #E2E6EE;
  --hairline-strong: #CBD2E0;
  --ink:             #0B1B3F;
  --ink-2:           #47536B;
  --ink-3:           #5F6B80;
  --ink-disabled:    #8A94A6;
  --on-dark:         #FFFFFF;
  --on-dark-2:       #C9D3E8;
  --on-dark-3:       #8FA0C4;

  /* ── semantics ─────────────────────────────────────── */
  --cleared: #0E7A46;  --cleared-wash: #E6F4EC;  --cleared-border: #BFE3CE;
  --pending: #8A5A00;  --pending-wash: #FCF3E3;  --pending-border: #EBD9AE;
  --danger:  #B3261E;  --danger-wash:  #FBEBE9;  --danger-border:  #F0CFCD;
  --blocked: #475569;  --blocked-wash: #EEF1F5;  --blocked-border: #D3DAE4;
  --info:    #1662E8;  --info-wash:    #F2F7FF;  --info-border:    #C9DDFB;

  --hatch-blocked: repeating-linear-gradient(45deg,
      #EEF1F5 0 4px, #E4E9F0 4px 8px);

  /* ── charts ────────────────────────────────────────── */
  --chart-1: #1662E8;
  --chart-2: #0E7A46;
  --chart-3: #8A5A00;
  --chart-4: #041C5A;
  --chart-5: #64748B;

  /* ── shadcn aliases (raw values, NOT hsl triplets) ─── */
  --background: var(--canvas);
  --foreground: var(--ink);
  --card: var(--surface);
  --card-foreground: var(--ink);
  --popover: var(--surface);
  --popover-foreground: var(--ink);
  --primary: var(--brand-600);
  --primary-foreground: var(--on-dark);
  --secondary: var(--surface-2);
  --secondary-foreground: var(--ink);
  --muted: var(--surface-2);
  --muted-foreground: var(--ink-3);
  --accent: var(--brand-50);
  --accent-foreground: var(--brand-700);
  --destructive: var(--danger);
  --destructive-foreground: var(--on-dark);
  --border: var(--hairline);
  --input: var(--hairline-strong);
  --ring: var(--brand-600);
  --ring-on-navy: var(--cyan);
  --radius: 0.5rem;

  /* ── type ──────────────────────────────────────────── */
  --font-sans: 'Urbanist Variable', Urbanist, ui-sans-serif, system-ui, -apple-system, sans-serif;
  --font-mono: 'Geist Mono Variable', 'Geist Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  /* ── elevation ─────────────────────────────────────── */
  --shadow-pop:   0 4px 16px -2px rgba(1,15,49,.12), 0 1px 3px rgba(1,15,49,.08);
  --shadow-drag:  0 8px 24px -4px rgba(1,15,49,.18), 0 2px 6px -1px rgba(1,15,49,.10);
  --shadow-modal: 0 24px 64px -12px rgba(1,15,49,.28);
  --scrim: rgba(1,15,49,.40);

  /* ── motion ────────────────────────────────────────── */
  --ease:        cubic-bezier(0.4, 0, 0.2, 1);
  --ease-out:    cubic-bezier(0.23, 1, 0.32, 1);
  --ease-in-out: cubic-bezier(0.77, 0, 0.175, 1);
  --dur-press: 120ms;
  --dur-fast: 160ms;
  --dur-pop: 200ms;
  --dur-dialog: 260ms;
  --dur-clear: 420ms;
}

@layer base {
  * { border-color: var(--hairline); }

  html { -webkit-text-size-adjust: 100%; }

  body {
    background: var(--canvas);
    color: var(--ink);
    font-family: var(--font-sans);
    font-size: 14px;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  :focus-visible {
    outline: 2px solid var(--ring);
    outline-offset: 2px;
    border-radius: inherit;
  }

  .on-navy :focus-visible { outline-color: var(--ring-on-navy); }

  /* Every figure a person could argue about. */
  .num {
    font-family: var(--font-mono);
    font-feature-settings: 'tnum' 1, 'zero' 1;
    font-variant-numeric: tabular-nums;
  }
  .num-col { text-align: right; white-space: nowrap; }

  /* Unsettled money is never solid ink. */
  .num-pending { color: var(--pending); border-bottom: 1px dashed currentColor; }
  .num-cleared { color: var(--ink); }
  .num-committed { color: var(--ink-3); }
  .num-rejected { color: var(--danger); text-decoration: line-through; }

  ::selection { background: var(--brand-100); color: var(--ink); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: .01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .01ms !important;
    scroll-behavior: auto !important;
  }
}
```

## 10. Ready to paste — `tailwind.config.ts`

```ts
import type { Config } from 'tailwindcss'
import animate from 'tailwindcss-animate'

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy:    { 900: 'var(--navy-900)', 800: 'var(--navy-800)', 700: 'var(--navy-700)' },
        brand:   {
          800: 'var(--brand-800)', 700: 'var(--brand-700)', 600: 'var(--brand-600)',
          500: 'var(--brand-500)', 300: 'var(--brand-300)', 200: 'var(--brand-200)',
          100: 'var(--brand-100)', 50:  'var(--brand-50)',
          DEFAULT: 'var(--brand-600)',
        },
        cyan:     'var(--cyan)',
        canvas:   'var(--canvas)',
        surface:  { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        hairline: { DEFAULT: 'var(--hairline)', strong: 'var(--hairline-strong)' },
        ink:      { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)', disabled: 'var(--ink-disabled)' },
        'on-dark':{ DEFAULT: 'var(--on-dark)', 2: 'var(--on-dark-2)', 3: 'var(--on-dark-3)' },

        cleared: { DEFAULT: 'var(--cleared)', wash: 'var(--cleared-wash)', border: 'var(--cleared-border)' },
        pending: { DEFAULT: 'var(--pending)', wash: 'var(--pending-wash)', border: 'var(--pending-border)' },
        blocked: { DEFAULT: 'var(--blocked)', wash: 'var(--blocked-wash)', border: 'var(--blocked-border)' },
        info:    { DEFAULT: 'var(--info)',    wash: 'var(--info-wash)',    border: 'var(--info-border)' },

        // shadcn aliases — raw values, no hsl() wrapper
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card:       { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover:    { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary:    { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary:  { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted:      { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent:     { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        destructive:{ DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        border:     'var(--border)',
        input:      'var(--input)',
        ring:       'var(--ring)',
        chart: { 1:'var(--chart-1)', 2:'var(--chart-2)', 3:'var(--chart-3)', 4:'var(--chart-4)', 5:'var(--chart-5)' },
      },
      fontFamily: {
        sans: ['Urbanist Variable', 'Urbanist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        display:    ['32px', { lineHeight: '1.10', letterSpacing: '-0.72px', fontWeight: '600' }],
        'title-lg': ['24px', { lineHeight: '1.15', letterSpacing: '-0.48px', fontWeight: '600' }],
        title:      ['20px', { lineHeight: '1.25', letterSpacing: '-0.30px', fontWeight: '600' }],
        subtitle:   ['16px', { lineHeight: '1.35', letterSpacing: '-0.15px', fontWeight: '600' }],
        strong:     ['14px', { lineHeight: '1.40', letterSpacing: '-0.05px', fontWeight: '600' }],
        body:       ['14px', { lineHeight: '1.50', letterSpacing: '0' }],
        'body-sm':  ['13px', { lineHeight: '1.45', letterSpacing: '0' }],
        label:      ['12px', { lineHeight: '1.35', letterSpacing: '0', fontWeight: '500' }],
        eyebrow:    ['11px', { lineHeight: '1.20', letterSpacing: '0.08em', fontWeight: '600' }],
        micro:      ['11px', { lineHeight: '1.30', letterSpacing: '0', fontWeight: '500' }],
        'num-hero': ['40px', { lineHeight: '1.00', letterSpacing: '-1.0px',  fontWeight: '500' }],
        'num-lg':   ['24px', { lineHeight: '1.00', letterSpacing: '-0.40px', fontWeight: '500' }],
        'num-md':   ['16px', { lineHeight: '1.00', letterSpacing: '-0.20px', fontWeight: '500' }],
        'num-sm':   ['13px', { lineHeight: '1.20', letterSpacing: '0',       fontWeight: '500' }],
        'num-xs':   ['11px', { lineHeight: '1.20', letterSpacing: '0.02em',  fontWeight: '500' }],
      },
      borderRadius: {
        xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px',
      },
      boxShadow: {
        pop: 'var(--shadow-pop)',
        drag: 'var(--shadow-drag)',
        modal: 'var(--shadow-modal)',
      },
      backgroundImage: { 'hatch-blocked': 'var(--hatch-blocked)' },
      transitionTimingFunction: {
        DEFAULT: 'var(--ease)', out: 'var(--ease-out)', 'in-out': 'var(--ease-in-out)',
      },
      transitionDuration: {
        press: '120ms', fast: '160ms', pop: '200ms', dialog: '260ms', clear: '420ms',
      },
      width: { column: '288px', sidebar: '240px' },
      maxWidth: { prose: '68ch', briefing: '1200px', app: '1440px' },
    },
  },
  plugins: [animate],
} satisfies Config
```

---

## 11. Data density

The founder scans; the team works. Two densities, not one.

| Surface | Density | Concretely |
|---|---|---|
| Founder dashboard, tables, ledger, approvals | **Dense** | 36px rows, 13px cells, 20px page title. **12+ rows visible without scrolling at a 900px-tall viewport.** If a table shows fewer than 12, it is over-padded. |
| Board | Dense | 288px columns, 12px card padding, 8px gaps, ~4 cards visible per column at 900px. 7 columns means horizontal scroll below 2100px — that is correct, do not shrink the columns to fit. Pin the column headers on horizontal scroll. |
| Person profile | Medium | Panels `p-5`, `gap-4`; one 24px number per panel, everything else ≤14px. |
| **Briefing screen** | **Presentation** | Read from across a room. Everything ×1.25: body 16, section headers 32, scorecard figures `num-hero` 40. `max-width 1200px` centred. Nothing below 14px. One section visible at a time. |
| **Who's working now** | **Presentation** | 44px rows, 16px body, 20px names, no filters, no hover, no chrome. |

Rules that apply everywhere:

- **Never more than one 24px+ number per panel.** Two big numbers side by side means neither
  is the answer.
- **Never more than 7 columns in a table.** Everything else goes in the row detail.
- A screen may have **one** tinted region and **one** primary button. If it wants two, the
  screen is doing two jobs.
- Whitespace comes from consistent 4px-grid rhythm, not from large paddings. Dense is not
  cramped; cramped is inconsistent.

---

## 12. Accessibility — measured, not asserted

Every ratio below was computed with the WCAG 2.1 relative-luminance formula
(sRGB linearisation, `(L1+0.05)/(L2+0.05)`) against these exact hex pairs on 2026-09-08.

**Body text (AA needs 4.5:1):**

| Pair | Ratio |
|---|---|
| `--ink #0B1B3F` on `--surface #FFF` | **16.90** |
| `--ink` on `--canvas #F7F8FA` | **15.90** |
| `--ink` on `--surface-2 #F1F3F7` | **15.21** |
| `--ink-2 #47536B` on white / canvas / surface-3 | **7.73 / 7.27 / 6.42** |
| `--ink-3 #5F6B80` on white / canvas / surface-2 | **5.38 / 5.07 / 4.85** |
| `--ink-3` on `--surface-3 #E7EAF1` | **4.47 — FAILS.** Banned; use `--ink-2`. |
| `--on-dark-2 #C9D3E8` on `--navy-900` | **12.54** |
| `--on-dark-3 #8FA0C4` on `--navy-900` | **7.18** |

**Semantic text:**

| Pair | Ratio |
|---|---|
| `--cleared` on white / canvas / its wash | **5.40 / 5.08 / 4.76** |
| `--pending` on white / canvas / its wash | **5.93 / 5.58 / 5.38** |
| `--danger` on white / canvas / its wash | **6.54 / 6.15 / 5.65** |
| `--blocked` on white / canvas / its wash | **7.58 / 7.13 / 6.69** |
| `--brand-600` on white / canvas | **5.32 / 5.01** |
| `--brand-700` on white / on `--brand-50` (shadcn accent pair) | **7.15 / 6.65** |
| `--brand-500 #3D7FEE` on `--navy-900` (primary on navy) | **4.91** |
| `--ink-2` on `--cleared-wash` / `--ink-3` on `--pending-wash` | **6.81 / 4.89** |

**Text on fills:**

| Pair | Ratio |
|---|---|
| `#FFF` on `--brand-600` / hover `#1355C9` / active `--brand-700` | **5.32 / 6.62 / 7.15** |
| `#FFF` on `--cleared` / `--danger` / `--blocked` | **5.40 / 6.54 / 7.58** |
| `#FFF` on `--navy-900` / `--navy-800` | **18.85 / 15.92** |
| `--cyan` on `--navy-900` / `--navy-800` | **10.57 / 8.93** |

**Non-text (AA needs 3:1):** focus ring `--brand-600` on white **5.32**, on canvas **5.01**;
drop-target ring `--brand-300` on `--surface-2` **1.65** — this is *decorative reinforcement
only*; the drop target is also indicated by the background fill change **and** the dnd-kit
live-region announcement, so it does not carry information alone.

**Known, accepted failures — documented, not hidden:**
- `--ink-disabled #8A94A6` on white = **3.06**. WCAG 1.4.3 exempts inactive controls. It is
  legal only on `disabled` elements.
- `--hairline #E2E6EE` on white = **1.25**, `--hairline-strong` = **1.52**. Borders that only
  separate content are exempt from 1.4.11. But **an input's border is a control boundary and
  must reach 3:1** — `--hairline-strong` at 1.52 does not. **Mitigation, binding:** inputs
  are additionally identified by a `--surface-2`-to-white fill contrast and a permanent
  visible label; and the focus state (border `--brand-600` at 5.32 plus the 2px ring) is what
  carries the 3:1 requirement for the focused control. **Flagging this to Chan as a real,
  measured gap rather than claiming full 1.4.11 compliance.** If strict compliance is
  required, change `--input` to `#8A94A6` (3.06:1 on white, the only value in this ramp that clears 3:1) — forms will look visibly heavier and greyer.

**Beyond contrast (all binding):**
- Every status is carried by **hue + icon or shape**, never hue alone (chain dots, hatch,
  dashed underline, line-through, lucide icons on chips).
- Focus is never removed. Focus order follows visual order. Dialogs trap focus and restore
  it to the trigger on close (Radix does this — do not override).
- Drag has a full keyboard path with live-region announcements (§7.3).
- The board's horizontal scroller is keyboard-scrollable and has `aria-label="Task board"`;
  each column is a `section` with an accessible name and `aria-live="polite"` off.
- Numbers that change asynchronously (pending balance, approvals count) live in
  `aria-live="polite"` regions so a screen reader hears a clearing.
- Touch targets ≥44×44 (§5).
- Text can reach 200% zoom without horizontal scroll on everything except the board, which
  is a legitimately 2D surface.

---

## 13. A worked screen — the board at 1440px

So the coder has an example, not just rules.

```
┌ sidebar 240 navy-900 ┬────────────────────────────────────────────────────────────┐
│ ▪ LRA logo 24px      │ 32px page gutter                                            │
│                      │                                                             │
│ WORK          eyebrow│ Board                            [Filters ▾]  [+ New task]  │
│  ▎Board       active │ text-title 20/600/-0.30           secondary      primary    │
│   Briefing           │ Everyone's week, live.       ← text-body-sm ink-3            │
│   Who's on what      │ ──────────────────────────────────────────────── mb-5 ──────│
│   Approvals    [3]   │ W38 · 15–21 Sep 2026   [open]   4 days left  ← 32px strip    │
│                      │                                                             │
│ PEOPLE        eyebrow│ ┌ BACKLOG 6 ──┐┌ THIS WEEK ─┐┌ IN PROGRESS ┐┌ BLOCKED 2 ─┐  │
│   Scoreboard         │ │ surface-2   ││            ││             ││  Ban icon   │  │
│   Mark Basa          │ │ radius 12   ││            ││             ││             │  │
│   …                  │ │ 288px       ││            ││             ││ ▓▓ hatched  │  │
│                      │ │             ││            ││             ││             │  │
│ ──────────────       │ └─────────────┘└────────────┘└─────────────┘└─────────────┘ │
│  Mark Basa      GM   │              ← 12px gaps, horizontal scroll past SUBMITTED  │
└──────────────────────┴─────────────────────────────────────────────────────────────┘
```

- Page gutter `px-8` at ≥1280, `py-6`.
- Header row: `text-title` + `text-body-sm --ink-3` description; right side one `secondary`
  (Filters, Radix dropdown) and one `primary` (`+ New task`, 16px `Plus`, gap 6). One
  primary per page — the rule from §11.
- Week strip: 32px tall, `border-bottom: 1px --hairline`, `W38 · 15–21 Sep 2026` in
  `num-xs --ink-3`, `open` as a soft `info` chip, `4 days left` in `num-xs` turning
  `--pending` at ≤2 days.
- Columns: `288px` fixed, `gap 12px`, `overflow-x: auto` with the column headers sticky at
  `top: 0` inside each column. The seven columns total 2076px + gaps, so at 1440 you scroll —
  correct. Give the scroller `scroll-snap-type: x proximity` and each column
  `scroll-snap-align: start`, so on the meeting-room touch display a swipe lands on a column
  rather than half-way between two.
- First card in **In progress**, exactly:
  `bg #FFF` · `1px #E2E6EE` · radius 8 · `padding 12px` · 3px `--pending` left rail ·
  eyebrow `BOC ENTRY` `--ink-3` · title `Clear BOC entry for Cebu shipment` `text-strong`
  clamp-2 · chip `8` `num-md` `--pending` with dashed underline · 20px `MB` avatar on
  `--navy-800` · `RotateCcw 2w` and `Clock 3d` in `num-xs --ink-3`, the `3d` in `--pending`.

**At 768px:** sidebar collapses to a Radix `Sheet` behind a hamburger; page gutter `px-6`;
board columns stay `288px` and scroll; balance panel goes `grid-cols-1` with the three cells
stacked and separated by horizontal hairlines instead of vertical.
**At 375px:** the board is usable but not the primary target — one column visible with snap;
the week strip wraps to two lines; the balance panel figures drop from `num-hero` 40 to
`num-lg` 24 so three stacked cells still fit above the fold.

---

## 14. Anti-goals — what will make this look generic

Reject in review if you see any of these:

1. **A shadow on a card.** Three shadows exist and they are for drag, popover, modal.
2. **Tailwind palette classes.** `bg-slate-50`, `text-gray-500`, `border-zinc-200`,
   `bg-blue-500` — all banned. Every colour comes from a token.
3. **A literal hex outside `:root`.**
4. **Cyan on a light surface.** 1.78:1. It is a navy-only colour.
5. **Green anywhere except the cleared state and the founder's approve button.**
6. **Emoji as status icons.** lucide only, 12/16px only.
7. **Gradients.** Anywhere. Including "subtle" ones on buttons and cards.
8. **Pill buttons and pill chips.** Radius 8 and 4 respectively.
9. **Everything at 14px semibold.** If a screen has no 11px eyebrow and no 24px+ number,
   it has no hierarchy and it is the HR portal again.
10. **A hero section, a marketing headline, or centred body copy.** This is a tool.
11. **`transition: all`**, and any `ease-in`.
12. **A generic error toast.** The database's message, verbatim.
13. **Illustrations or spot art in empty states.** One 16px lucide icon at most.
14. **Zebra-striped tables.**
15. **Count-up number animations on page load.** Numbers only animate when *value moves*,
    i.e. on clearing.
16. **A `0` where the answer is "we don't know yet".** Use `—`.
17. **Rounded-full avatars at 32px+ in dense lists.** 20px on cards, 24px in tables.
18. **A second accent colour** introduced to make a chart "pop". The five chart colours in
    §2.4 are the whole set.
19. **Silent points overrides.** An overridden figure always shows the pencil + reason.
20. **21st.dev output pasted with its own palette, radii, shadows or fonts intact.** Every
    generated component gets ported onto these tokens before it is committed. If a generated
    component's structure fights the tokens, keep the structure and rewrite the classes —
    never the other way round.

---

## 15. Open questions for Chan

1. **Dark mode.** A) Light only for the MVP, tokens structured so it is a one-file addition
   later. B) Both from day one. → **I'd pick A**, because the briefing screen runs on a
   shared display in a lit room and a second theme doubles the token surface before the
   first is proven.
2. **`--blocked` as slate + hatch, or its own hue?** A) Slate `#475569` + 45° hatch, block
   age turning red past 24h. B) Burnt orange `#9A3412`. → **I'd pick A**, because blocked is
   a stall rather than an error, and a third warm hue next to amber and red goes muddy.
3. **Grabbed card: flat or tilted?** A) `scale(1.02)` + shadow, no rotation (Linear-sharp).
   B) Add `rotate(1.2deg)` (warmer, more physical). → **I'd pick A**, matching "simple but
   better", but B is one line if the board feels too clinical on the touch display.
4. **Input border strictness.** A) Keep `--hairline-strong #CBD2E0` (1.52:1) — better
   looking, documented WCAG 1.4.11 gap on unfocused inputs. B) `#8A94A6` (3.06:1) — strictly
   compliant, visibly heavier and greyer forms. → **I'd pick A** for an internal tool with four known
   users, but this is Chan's call to make knowingly, not mine to make quietly.

---
---

# Part II — Mobile, plain language, and guidance

**Added 2026-09-10 by `designer`, from Chan's brief.** Part I (§0–§15) is unchanged and
still binding. Nothing below overrides a token, a hue, a radius or a curve from Part I; it
extends the system to cover four things Part I did not specify — **the phone**, **the words
on the screen**, **the explanations**, and **a person's own velocity**.

> **Chan's brief, in his words, and where each ask is answered:**
>
> | His words | Section |
> |---|---|
> | "make sure its mobile responsive… go over all the tabs" | **§16** |
> | "things like in_progress should be In Progress" | **§17** |
> | durations "should automatically transition from hours to days to weeks… 371 hours old" | **§18** |
> | "like git commits… the greener it is but instead of green use a blue" | **§19** |
> | "i also want general tooltips incase the users forget how they work" | **§20** |
> | "they should be guided… especially the briefing feature… input placeholders" | **§21** |
> | "the date displays are pretty bland on the my points page" | **§22** |
> | "scoreboard cards should be taller" | **§23** |
> | "i dont want this webapp to be too daunting… something light" | **§24** |
> | new colour, light and dark | **§25** |

**Reference, restated.** Still Linear (structure) + Stripe (numeric grammar) from §0. Part II
adds one borrowed pattern and names it: the **GitHub contribution calendar** (§19) — taken
for its *grid and its legend*, not its palette; the green is replaced by the LRA brand blue
ramp, and the bucket thresholds are re-derived for a three-person team (§19.3). Linear's
mobile behaviour is also the model for §16: Linear does **not** shrink its board onto a
phone, it changes what the board *is* — one lane at a time, and a menu where the drag was.
That is the call this section makes too.

---

## 16. Responsive — every tab, at three widths

### 16.1 Breakpoints and the design widths

Tailwind v3 defaults, already in use. Do not add custom breakpoints.

| Token | px | Meaning in this app |
|---|---|---|
| *(base)* | 0–639 | **Phone.** Design target **375**. One column, always. |
| `sm:` | ≥640 | Large phone / small tablet portrait. Two-up allowed. |
| `md:` | ≥768 | **The shell switch.** Sidebar returns as a persistent column (already built, `app-shell.tsx`). Design target **768**. |
| `lg:` | ≥1024 | Desktop. Presentation density (§11) turns on here, not before. |
| `xl:` | ≥1280 | Wide desktop. Page gutter reaches `px-8`. Design target **1440**. |

**Check at 375 / 768 / 1440.** Those three, every screen, every time.

### 16.2 Five rules that apply to every screen

1. **The page body never scrolls horizontally.** `<main>` is already
   `overflow-y-auto overflow-x-hidden` and that stays. Any surface wider than the column owns
   its **own** scroller: a `div` with `overflow-x-auto`, `role="region"`, `tabIndex={0}` and
   an `aria-label`. `CardRail` (`scoreboard/card-rail.tsx`) is the reference implementation —
   copy its contract, do not re-invent it.
2. **Gutters.** `app-shell.tsx` becomes `px-4 py-4 sm:px-6 sm:py-6 lg:px-8`. A 375px phone
   loses 32px to gutters, so **343px is the real content width** — every fixed width below
   that number must be checked against it.
3. **Touch targets.** Below `md`, and on any coarse pointer at any width, every button, menu
   item, tab and row-action is **≥44×44**. Implement once, in `index.css`, not per component:

   ```css
   @media (pointer: coarse) {
     button, [role='button'], [role='tab'], a.tap, summary {
       min-height: 44px;
     }
     button.icon-only, [role='button'].icon-only { min-width: 44px; }
   }
   ```
   Controls stay 34px tall on a fine pointer (§5.1 unchanged). `card-rail.tsx`'s 40px
   `RailButton` is brought up by this rule and its documented shortfall closes.
4. **`100dvh`, never `100vh`.** iOS Safari's collapsing toolbar makes `100vh` taller than the
   screen; `app-shell.tsx`'s `h-screen` becomes `h-[100dvh]`. Sticky footers get
   `padding-bottom: max(12px, env(safe-area-inset-bottom))` and `index.html` gets
   `viewport-fit=cover`.
5. **A fixed pixel width below `sm` is a bug.** `min-w-[300px]`, `w-32`, `w-10` and friends
   either become `min-w-0` + `flex-1`, or move behind a `sm:` prefix.

### 16.3 The Board — the hard one

Today: five lanes, `w-column` (288px), `snap-x`, horizontal scroll, `@dnd-kit` drag. Five
lanes at 288 + 12 gap = **1488px**, so a phone shows one lane and a fifth of the next.

**Below `md`, the board becomes a one-lane-at-a-time view.** Three changes, no new state:

- **Lane width** `w-column` → `w-[calc(100vw-2rem)] md:w-column`, and the scroller's snap goes
  `snap-x` → `snap-x snap-mandatory md:snap-proximity`. A swipe now lands on exactly one lane
  instead of between two. The DOM, the lanes, the tabs and the sticky lane headers are
  unchanged.
- **A lane pager**, sticky above the scroller, below `md` only: a horizontally scrollable
  `role="tablist"` of the five lane names with their counts —
  `Plan 6 · In Progress 3 · Blocked 2 · Submitted 1 · Settled 9`. `text-eyebrow`, active tab
  `--ink` with a 2px `--brand-600` underline, idle `--ink-3`. Tapping scrolls the rail to that
  lane; scrolling the rail updates the tab (`IntersectionObserver` on the lanes, threshold
  0.6). It is navigation, not a second source of truth — it never stores which lane is
  showing, it reads the scroller.
- **Drag-and-drop is OFF below `md`.** This is the important decision. A drag cannot cross a
  lane boundary when only one lane is on screen, and a 180ms-delay touch drag on a scrolling
  surface is the single most frustrating interaction on a phone. Replace it with a
  **`Move to…` submenu on the card's existing menu.** `task-card-menu.tsx` and
  `task-menu-items.ts` already exist and already own the legality logic:

  - Add one entry, `Move to…`, opening a submenu of **every** `BoardColumn`.
  - A target the actor may not use renders **disabled, with `moveRefusal()`'s sentence as its
    own label line** in `text-micro --ink-3`. Nothing is hidden; the refusal is the teaching.
  - `blocked` as a target opens the block dialog first, exactly as the drop does (§7.3).
  - Reuses `moveRefusal` verbatim. **No new permission logic may be written for this.**

  Gate the sensors, not the render: `useSensors(...)` takes the pointer/keyboard sensors only
  when `matchMedia('(pointer: fine)').matches`. Keyboard drag (§7.3) survives on every width.
  On a fine pointer nothing changes at all, and `Move to…` is a welcome second path.
- Tap a card = open the detail (already). Long-press = the Radix `ContextMenu` (already —
  Radix handles long-press on touch natively).
- The lane's sticky header stays; its 28px height stays.

**At 768** the board is unchanged from today: 288px lanes, horizontal scroll, drag on.

### 16.4 The Briefing — the other hard one

The commit grid is already `grid-cols-1 md:grid-cols-2 lg:grid-cols-3`, which is correct.
What is missing is that a phone gets **four full-height person cards stacked**, and the reader
has to scroll past two colleagues to find themselves.

- Below `md`, each person's commit card becomes a **collapsible**. Header row always visible:
  avatar, name, committed total in `num-md`, and a chevron. Body (committed list + candidates)
  collapses. **The reader's own card is first in the list and open by default**; everyone
  else's is closed. Above `md` nothing collapses — the whole grid is open, because that is the
  meeting-room view.
- Use a Radix `Collapsible` with the §7.1 accordion motion. Below `md` only; above `md` render
  the body unconditionally, do not just leave it "open" (a collapsible with a dead trigger is
  worse than no collapsible).
- **Last week's scorecard** is a real `<table>` with 4–5 columns. Below `sm` it becomes a
  stacked list, not a scroller — 4 columns is few enough to stack and a scroller here hides
  the hit-rate off the right edge. Per person: one card, name in `text-strong`, then a
  `grid-cols-3` of `text-eyebrow` label over `num-sm` value (Committed / Cleared / Hit-rate).
  Above `sm`, the table returns exactly as it is.
- **Presentation density (§11) is `lg:` and up only.** Below 1024 the briefing uses normal
  density. A 32px section header on a 375px screen wraps to three lines and reads as a poster,
  not a tool. `text-display` → `text-title-lg lg:text-display` on this screen.
- The close bar (§21.4) is `sticky bottom-0` below `md`, with the safe-area padding from
  §16.2.

### 16.5 Every other tab, one line each

| Route | At 375 |
|---|---|
| `/now` | Already `grid-cols-1 lg:grid-cols-2`. Rows get the §16.6 two-line treatment. Nothing else. |
| `/queue` (Approvals) | Rows are `flex items-center gap-4` with a fixed age column — apply §16.6. The `Approve` / `Return` buttons stay on line 1, right-aligned, and are the 44px targets. |
| `/digest` (founder) | Four sections of the same row shape → §16.6. The `grid-cols-2 sm:grid-cols-4` stat strip stays 2-up at 375 (four 24px numbers in a row do not fit 343px). |
| `/points` | Balance panel already stacks at `sm`. Below `sm` the three `num-hero` 40px figures drop to `num-lg` 24px (§13 already says so — it is not implemented; implement it). Ledger → §22. |
| `/scoreboard` | The rail becomes a **vertical stack** below `sm`: `flex-col`, cards `w-full min-w-0`, `RailControls` hidden, `role="region"` dropped (nothing scrolls). Horizontal scroll on a phone rail is a swipe fight with the page. Above `sm` the rail is exactly as built. |
| `/people/:id` | The `grid-cols-[auto_1fr_1fr_1fr_1fr_1fr_auto]` week table is 7 columns → its own `overflow-x-auto` scroller with the **first column sticky** (`sticky left-0 z-[1] bg-surface`, and `bg-surface-2` in the header). This is the one place a horizontal scroller is correct: the rows are genuinely a matrix. |
| `/catalog` | Already uses the `lg:contents` card→row trick. Keep. Verify the action buttons fit 343px — this screen has broken at 768 before (`app-shell.tsx` comment). |
| `/inbox` | Single column already. Rows → §16.6. Unread dot stays at the left. |
| `/admin/everything`, `/admin/audit` | Dense forensic lists nobody reads on a phone. Rows → §16.6, and that is enough. Do not build a mobile table for an audit log. |
| `/admin-users` | The only `<table>` outside the briefing, 6+ columns → own scroller, sticky first column, same as `/people/:id`. |
| `/admin-settings` | `grid-cols-2` → `grid-cols-1 sm:grid-cols-2`. |
| `/login`, `/set-password` | Already single-column. Inputs go `h-11` below `md` (typing on a 34px field on a phone is unpleasant), and the submit button is full width. |
| **Task detail dialog** | Below `md` it is **not a dialog** — it is a full-screen sheet: `inset-0 h-[100dvh] max-w-none rounded-none translate-x-0 translate-y-0`. Header sticky top with a `X` close at 44px, footer sticky bottom holding the actions, body the only scroller. It is 1338 lines of content; a centred 600px modal on a phone is a scroll trap. |

### 16.6 The row pattern — write it once

Eight screens render "a list of things with meta on the right" as
`flex items-center gap-4` with fixed-width columns. Below `sm` they all squeeze. One shared
component, `components/ui/list-row.tsx`, and every one of them uses it:

```
≥640:   [ icon ] [ title ......................... ] [ meta ] [ meta ] [ actions ]
<640:   [ icon ] [ title ..................... ] [ actions ]
                 [ meta · meta · meta ]
```

- Line 1: the identifying text, `text-body-sm`, `truncate`, plus the actions, right-aligned,
  never wrapped, never collapsed into a menu (a hidden approve button is a slower approval).
- Line 2: every meta value, `flex flex-wrap gap-x-3 gap-y-1`, `text-micro`/`num-xs`, separated
  by a `·` in `--ink-3`. Each keeps its own tone (`ageTone`, `.num-pending`, etc.).
- **Numeric right-alignment is abandoned below `sm`.** `tnum` buys column alignment; at one
  column there are no columns. Keep the mono family, drop `.num-col`.
- Fixed meta widths (`w-10`, `w-32`) live behind `sm:` only.

---

## 17. The label layer — one module, no string literals

Chan: *"things like in_progress should be In Progress."* He is describing a symptom. The
cause is that display strings are scattered across seven modules and, in
`routes/points.tsx`, absent entirely — the ledger prints
`row.from_status → row.to_status`, so a member auditing their own points reads
`in_progress → submitted`.

### 17.1 The rule

> **`apps/web/src/lib/labels.ts` is the only file in the web app that may contain a display
> string for a database enum.** A component that needs a word calls `label(kind, key)`. A
> component that contains `'In Progress'` as a literal is a defect.

Consolidate into it, and delete from their current homes:

| Currently in | What moves |
|---|---|
| `lib/task-types.ts` | `STATUS_LABEL` |
| `lib/task-permissions.ts` | `COLUMN_LABEL` |
| `components/tasks/edit-request-diff.tsx` | its private `STATUS_LABEL` |
| `lib/reliability-ui.ts` | `BAND_LABEL` |
| `lib/edit-suggestions.ts` | `SUGGESTION_FIELD_LABEL` |
| `components/scoreboard/scoreboard-model.ts` | `PERIOD_TAB_LABEL` |
| `components/scoreboard/points-bar.tsx` | `SEGMENT_WORD` |
| `lib/task-types.ts` | `blockRelationLabel` (wording unchanged — it was written from Chan's own words) |

Re-export from the old paths for one commit so the change is mechanical, then delete the
re-exports in the same PR. `statusTone()` stays where it is: it is a **colour** decision and
belongs with the design layer, not the language layer.

### 17.2 Tone

These are read by three people who do customs brokerage, not software. Binding:

- **Title Case for the name of a state** (it is the state's proper name: *In Progress*).
  Sentence case for everything else.
- **A label is ≤ 2 words.** If it needs a sentence, the sentence is the `hint` (§20), not the
  label. `pending_cancellation`'s current label — `Awaiting cancellation decision` — is a
  sentence wearing a chip; it changes.
- **Never auto-prettify.** `key.replace(/_/g, ' ')` produces *Pending cancellation*, which is
  both wrong and plausible. Banned.
- **Unknown key** renders the raw key in `--ink-3` and `console.warn`s in dev. Never blank,
  never a crash, never a guess.

### 17.3 The strings — exact

**Task status** (`ops.task_status`). `hint` is the tooltip copy from §20; both live here.

| key | label | hint |
|---|---|---|
| `todo` | Backlog | Agreed, not started yet. |
| `in_progress` | In Progress | Someone is working on this right now. |
| `submitted` | Submitted | Sent to the GM to check. |
| `verified` | Verified | The GM checked it. Waiting on the founder to release the points. |
| `cleared` | Cleared | Done. The points are yours. |
| `rejected` | Returned | Sent back with a reason. Fix it and submit again. |
| `cancelled` | Cancelled | Called off. No points for it. |
| `pending_cancellation` | Cancellation Requested | Someone asked to call this off. Waiting on a decision. |

**Board columns / lanes.** `Backlog` · `This Week` · `In Progress` · `Blocked` ·
`Submitted` · `Verified` · `Cleared`. Lane names join with ` / `: `Backlog / This Week`,
`Verified / Cleared`. (`This week` → `This Week`; it is a column name.)

**Ledger state** — same table as task status. The ledger's transition line reads
`Backlog → In Progress`, never the raw keys. The `→` is `U+2192` with a hairspace either side.

**Authority.** `staff` → Staff · `gm` → GM · `founder` → Founder · `admin` → Admin ·
read-only oversight → **Read-only**. Never `oversight_only` on screen.
**Position.** `broker` → Broker · `sales` → Sales · `other` → Other. Never `capitalize` on a
raw column (`person-card.tsx` does this today — it renders `Oversight_only`).

**Reliability band.** Excellent · Solid · Watch · At risk · Unrated. (Unchanged.)

**Block target.** Unchanged wording, moved file.

**Edit-request / suggestion state.** Pending · Approved · Rejected · Withdrawn.

**Week state.** `planning` → **Planning** (hint: *Monday's meeting hasn't been closed yet.*)
· `open` → **Open** (hint: *Commitments are locked. Work is in flight.*) · `closed` →
**Closed** (hint: *The week is finished and scored.*)

---

## 18. Durations — hours to days to weeks

Chan: *"371 hours old… which is annoying."* He is right, and it is real: `queue.tsx:146,171`,
`founder-digest.tsx:232,666,705` all render `{n}h` with no ceiling.

### 18.1 The function

`apps/web/src/lib/duration.ts`. One function, one rule:

> **At most two units. The larger unit first. The smaller unit is dropped when it is zero.**

`formatDuration(ms: number): string`

| Input | Output | Why |
|---|---|---|
| ≤ 0, or in the future | `now` | Never a negative age. |
| < 1 hour | `<1h` | **Never `0h`.** A zero-hour age is not zero — it is young. |
| < 24 hours | `7h` | Floor. |
| < 7 days | `2d 4h`, or `2d` when the hour remainder is 0 | |
| < 8 weeks | `2w 1d`, or `3w` when the day remainder is 0 | |
| ≥ 8 weeks | `12w` | **No months.** The unit of this product is the week; `1mo 2w` is ambiguous and nobody can act on it. |

**371h → `2w 1d`.** (371h = 15d 11h = 2w 1d 11h; the third unit is dropped.)

Also export:

- `formatDurationLong(ms)` → `2 weeks, 1 day` — for `aria-label` and tooltip bodies. A screen
  reader saying "two double-u one dee" is not an age.
- `ageTone(ms)` → the existing thresholds, moved here and now measured in ms rather than
  hours: `--ink-3` under 8h, `--pending` 8h–24h, `--danger` over 24h. `founder-digest.tsx`'s
  local `ageTone(hours)` is deleted, not duplicated.

### 18.2 Where it applies — all of them

`/queue` row age · `/digest` task age, oldest-in-group, blocked hours · `/people/:id`
`hoursBlockedByThem` · board card staleness `Clock` badge and carry-over `RotateCcw` badge
(§5.4) · task detail dialog block age · `/points` "oldest item waiting" · anywhere a `{n}h`
or `{n}d` string is being built today.

**`/points` has a second bug this fixes.** It computes
`Math.floor((Date.now() - oldest) / 864e5)` and renders `oldest item waiting 0d` for anything
under 24 hours. Pass the raw timestamp to `formatDuration` and delete the arithmetic.

### 18.3 Rendering

- Mono, `tnum`, per §3.2 — unchanged.
- **Reserve `w-14` (56px), not `w-10`.** `2w 1d` is five glyphs plus a space; today's `w-10`
  columns will clip. Below `sm` the width goes away entirely (§16.6).
- Always pair with the exact timestamp in a `<Hint>` (§20): the badge says `2w 1d`, the
  tooltip says `Since Mon 25 Aug 2026, 09:14 (Asia/Manila) — 2 weeks, 1 day`.
- `formatDuration` never returns an empty string, so a duration slot never collapses. If the
  source timestamp is `null`, render `—` (§8's absence rule), not `formatDuration(0)`.

---

## 19. The activity heatmap — "git commits, but blue"

Chan: *"like git commits, the greens on how many tasks they complete on those days, the
greener it is — but instead of green use a blue."*

Component: `apps/web/src/components/scoreboard/activity-heatmap.tsx`.
Lives on **`/points`** (the reader's own, full size) and **`/people/:id`** (full size), and in
`variant="mini"` inside the scoreboard person card (§23).

This is the only piece of the app that speaks to Chan's second requirement from PLAN.md
§10.2 — *"points… for the staff to track their progress and stay accountable on their own"* —
as a picture rather than a number. It belongs to the person, not to management. That is why
it renders for every viewer including staff, unlike reliability.

### 19.1 What one cell counts

**Tasks that reached `cleared` on that calendar day, for that person, in `Asia/Manila`** —
read from the points ledger (`state = 'cleared'`), the same source as the balance figures. It
must be the same source, so the picture can never disagree with the number above it.

Count of **tasks**, not points — Chan said "how many tasks they complete". Points are the
tooltip's second line.

### 19.2 Geometry

| | Full (`/points`, `/people/:id`) | Mini (scoreboard card) |
|---|---|---|
| Cell | 12×12, `13×13` on `(pointer: coarse)` | 8×8 |
| Gap | 3px | 2px |
| Radius | `--radius-cell` **2px** | 2px |
| Day labels | Left column, 24px, `text-micro --ink-3`, **Mon / Wed / Fri only** | none |
| Month labels | Above, `text-micro --ink-3`, only where the month changes and ≥3 columns since the last | none |
| Legend | yes (§19.5) | no |
| Total line | yes | no |

- **Rows are 7 days, Monday at the top.** GitHub starts on Sunday; this product's unit is the
  Monday-to-Sunday week (§5.8's week strip), so it starts on Monday. Columns are weeks, oldest
  at the left, **this week at the right edge**.
- **How many weeks: measured, not guessed.** A `ResizeObserver` on the container computes
  `weeks = clamp(floor((width - labelCol - 8) / (cell + gap)), 8, 26)`. No width media query,
  no JS breakpoint constant, and it can never overflow its container — which is the actual
  requirement (§16.2 rule 1). In practice that lands on **26 weeks at ≥1024**, **~17 at 768**,
  **~13 at 375**, and 13 fixed for the mini variant.
- Full variant height: `7 × 12 + 6 × 3 = 102px` grid + 14px month row + 8px legend row.

### 19.3 The buckets — fixed, not relative

A relative scale (quartiles of this person's own history) is what GitHub does and it is wrong
here: on a three-person team a quiet week would paint "1 task" as dark, and a person could
look busiest in their worst month. Fixed thresholds, so two people's grids are comparable and
a person's own year is comparable to itself:

| Cleared that day | Step | Token |
|---|---|---|
| 0 | L0 | `--heat-0` |
| 1 | L1 | `--heat-1` |
| 2 | L2 | `--heat-2` |
| 3–4 | L3 | `--heat-3` |
| 5+ | L4 | `--heat-4` |

### 19.4 The blue ramp — light and dark from one set of hexes

Values, and why (all four are the existing brand ramp; `--brand-400` is one new interpolated
step between the existing `--brand-300` and `--brand-500`, not a new brand colour):

| | Light | Dark |
|---|---|---|
| `--heat-0` (zero) | `#F1F3F7` `--surface-2`, + `inset 0 0 0 1px var(--heat-ring)` | `#182031` |
| `--heat-1` | `#C9DDFB` `--brand-200` | `#0C3FA3` |
| `--heat-2` | `#6D9CF3` `--brand-400` **(new)** | `#1662E8` |
| `--heat-3` | `#1662E8` `--brand-600` | `#6D9CF3` |
| `--heat-4` | `#0C3FA3` `--brand-800` | `#C9DDFB` |

**The same four hexes, assigned in reverse.** On white, more work = darker; on navy, more
work = brighter. One ramp, one direction flip, nothing new to maintain.

Measured on 2026-09-10 (WCAG relative luminance), light ramp:

| Pair | Ratio |
|---|---|
| `heat-0` → `heat-1` | 1.24 — weak, which is **why L0 carries a 1px `--hairline` inset ring**. A zero cell must read as a cell. |
| `heat-1` → `heat-2` | **1.98** |
| `heat-2` → `heat-3` | **1.95** |
| `heat-3` → `heat-4` | **1.75** |
| `heat-4` on `--canvas` | 8.76 |

Monotonic in luminance (0.895 → 0.711 → 0.335 → 0.147 → 0.063) with ~2:1 between adjacent
steps — roughly 40% more separation than GitHub's own ramp, which is the point: three people
generate a sparse grid and the steps have to survive being read across a meeting room.

Dark ramp steps: 1.68 / 1.75 / 1.95 / 1.95. Also monotonic.

`--heat-2` `#6D9CF3` is the **only new hex in Part II.**

### 19.5 States — all of them

- **A zero day.** L0 with the inset ring. It is a real zero (§8's zero-vs-nothing rule) and it
  gets a tooltip: `No tasks cleared · Tue 16 Sep 2026`.
- **A day before this person's account existed**, or before the app went live. `--heat-0` at
  `opacity: .4`, **no tooltip**, `aria-hidden`. That is an absence, not a zero, and the
  difference is exactly the difference between "you did nothing" and "we weren't watching".
- **No history at all** (nobody has cleared anything yet). **Render the full empty grid
  anyway**, plus one line under it in `text-body-sm --ink-3`:
  `No cleared work yet. Squares fill in as you clear tasks.` Hiding the grid hides the
  feature; the shape is what teaches it.
- **Loading.** The exact grid geometry in `skeleton-pulse` `--surface-2`, one pulse for the
  whole block (not per cell — 182 staggered pulses is a strobe).
- **Error.** The `--danger-wash` panel band from §8 with the server's message and a `Retry`;
  the rest of the page keeps working. A failed heatmap never blanks `/points`.
- **Partial data** (the window starts mid-history): normal. The grid is a window, not a claim
  about all time — the total line says `in the last 26 weeks` so it can't be misread.

### 19.6 Tooltip, legend, and not-colour-alone

- **Cell tooltip** (`<Hint>`, §20 — so it works on tap too):
  line 1 `4 tasks cleared · 21 points`, line 2 `Mon 15 Sep 2026`. Zero days: `No tasks
  cleared`. Never "0 tasks".
- **Legend**, right-aligned under the grid: `Less` · five swatches · `More`, `text-micro
  --ink-3`. **Under the swatches, the thresholds in `num-xs`: `0 1 2 3–4 5+`.** That numeric
  row is the non-colour channel and it is not optional — it is what makes the chart legible to
  a colour-blind reader, in greyscale, and on the printed briefing.
- **Total line**, left of the legend, `text-body-sm --ink-2`:
  `<span class="num">37</span> tasks cleared in the last <span class="num">26</span> weeks`.
- **Semantics.** Container `role="grid"` + `aria-label="Tasks cleared per day"`; each week a
  `role="row"`; each cell `role="gridcell"` with
  `aria-label="Monday 15 September 2026: 4 tasks cleared, 21 points"`. Cells are not focus
  stops (182 tab stops is hostile) — the grid is one tab stop and arrow keys move a roving
  `tabindex`, which is also how a keyboard user reaches a tooltip.
- **Forced colors.** `@media (forced-colors: active)` flattens every background; the ramp
  becomes a border-width ramp instead: `0 / 1 / 2 / 3 / 4px` of `CanvasText` inset.
- **Motion: none.** No entrance, no stagger, no per-cell transition — §7.2 bans staggers past
  four items and this is 182. Hover is a `1px solid var(--ink-3)` outline at 0ms.

### 19.7 What it is not

Not a chart with axes. No y-axis, no tick labels, no title inside the plot, no gradient, no
second series, no "compare with last quarter" toggle. It is a texture that answers one
question — *did I do work that day* — and the moment it needs a legend beyond five swatches it
has stopped being that.

---

## 20. Tooltips and "know more"

Chan: *"i also want general tooltips incase the users forget how they work… when they forget
something, they have the option to know more instead of me having back to back meetings with
them on how to use it."*

The deliverable is therefore **not a tooltip component**. It is a place where the
explanations live, so Chan can rewrite how the app explains itself without opening a
component — and so a person can answer their own question at 11pm without messaging him.

**A dependency must be added: `@radix-ui/react-tooltip` and `@radix-ui/react-popover`.**
Neither is currently in `apps/web/package.json`. Everything below is built on them.

### 20.1 Three tiers, and which is which

| Tier | Component | Answers | Lives on |
|---|---|---|---|
| **(a)** short hint | `<Hint>` | *What does this control do / what is this number?* | a control, a badge, a figure |
| **(b)** screen help | `<WhatIsThis>` | *What is this screen for, and what do I do here?* | every page header, always |
| **(c)** first run | auto-opened `<WhatIsThis>` | *I've never seen this before* | `/briefing` only |

### 20.2 (a) `<Hint>` — and how it works on touch

```tsx
<Hint text="Sent to the GM to check.">
  <Chip tone="pending">Submitted</Chip>
</Hint>
```

- Radix `Tooltip`. Open delay **350ms**, `skipDelayDuration` 300 within a `TooltipProvider`
  group, `side="top"`, `sideOffset={6}`, collision-aware.
- Content: `bg --navy-900`, `text --on-dark`, `text-label` (12/500), `px-2.5 py-1.5`,
  `radius 6`, `max-w-[240px]`, `--shadow-pop`, 6px arrow. Motion per §7.1 (popover row):
  `opacity 0→1` + `scale .97→1`, `--dur-pop`, `--ease-out`, Radix's transform origin.
- **Touch has no hover, so `<Hint>` swaps itself.** On `matchMedia('(pointer: coarse)')` the
  same component renders a Radix **`Popover`** instead, opened by tap, dismissed by tap
  outside or `Esc`, with identical content and identical styling. Consumers never branch —
  the branch is inside `<Hint>`, once. A trigger that is otherwise not interactive gets
  `tabIndex={0}` and `role="button"` so keyboard and screen-reader users reach it too.
- **`title=` is banned.** It is invisible on touch, unstyled, slow, and unreadable to some
  screen readers. Three live uses must be replaced: `person-card.tsx:157` (the Capped chip),
  `board.tsx:788` (`title={laneDim}`), and the block-relation markers.
- `<Hint>` never carries information that exists nowhere else. If losing the tooltip would
  lose the meaning, the meaning belongs on the screen.

### 20.3 (b) `<WhatIsThis>` — one per screen, permanent

- A 20px lucide `HelpCircle`, `--ink-3`, hover `--ink-2`, sitting immediately right of the
  `PageHeader` title on the same baseline, `ml-2`. `aria-label="What is this screen for?"`.
- Opens a Radix **`Popover`** (never a Dialog): `320px`, `radius 12`, `--surface`,
  `1px --hairline`, `--shadow-pop`, `p-4`, `align="start"`. It **does not trap focus and does
  not dim the page** — people read it while working. `Esc` and outside-click close it.
- Content shape, fixed:
  - `text-subtitle` title,
  - 1–3 paragraphs of `text-body-sm --ink-2`, `max-w-prose`,
  - optionally `text-eyebrow --ink-3` **WHAT TO DO HERE** over a 2–3 item list, each item
    `text-body-sm`, marker a 12px `ArrowRight` in `--brand-600`.
  - No images, no video, no external link.
- **`PageHeader` gains a required `help: HelpTopicId` prop.** Required, not optional — a
  screen cannot silently ship without an explanation, and TypeScript enforces it across all
  fifteen routes. That single type change is what makes this real rather than aspirational.

### 20.4 Where the copy lives

`apps/web/src/lib/help.ts`, and nowhere else:

```ts
export interface HelpTopic {
  title: string;
  body: string[];      // paragraphs
  todo?: string[];     // "what to do here"
}
export const HELP = { … } satisfies Record<HelpTopicId, HelpTopic>;
```

`labels.ts` (§17) holds the one-sentence `hint` per enum value; `help.ts` holds the per-screen
explanation. Two files, and between them **every word the app uses to explain itself**. Chan
can reword the entire product's guidance by editing two files.

### 20.5 Copy rules — binding, and they matter more than the component

1. Second person, present tense. *"Send it to the GM."* Not *"The task is transitioned."*
2. **Name the LRA thing, not the UI thing.** *"The GM checks it"*, not *"the record moves to
   the verified state."*
3. A hint answers **what happens if I press this**, not what it is called.
4. **State the consequence** when there is one: *"Every 8 hours a block stays open costs one
   reliability point, up to 10."*
5. Word budgets: `hint` ≤ 20 words · a `body` paragraph ≤ 2 sentences · a `todo` item ≤ 12
   words · a page description ≤ 12 words.
6. Banned: `simply`, `just`, `easily`, `please`, `oops`, exclamation marks, emoji, and any
   sentence that begins *"This screen allows you to…"*.
7. Never explain something the screen could have said plainly instead. A hint that exists to
   apologise for a confusing label means the label is wrong (§17).

### 20.6 Where hints are mandatory

Not "nice to have" — the tester checks for these:

The three balance figures · the dashed-underline pending treatment (§6.1) · the
chain-of-custody dots (§6.3) · every board lane header · the `Capped` chip · reliability score
and hit-rate · the carry-over and staleness badges · every duration badge (with its exact
timestamp, §18.3) · the heatmap legend and every cell · `Submit` / `Return` / `Clear` /
`Block` / `Uncommit` · the Monday lock banner · the edit-suggestion batch flow · every
disabled control, where the hint is the refusal reason (`moveRefusal`'s sentence — a disabled
button with no explanation is the single most common cause of "how does this work?").

---

## 21. The Briefing as a guided flow

Chan: *"they should be guided with how to do it with the input placeholders etc."* This is
the ritual the whole product exists around, and it is the screen a new person meets first.
Target: **someone who has never used it gets through it unaided.**

### 21.1 Four steps, stated on the screen

The existing four sections are already the right steps; they just don't say so. Above each
`text-title-lg` heading add a `text-eyebrow --ink-3` step marker, and below it a one-line
purpose in `text-body-sm --ink-3`:

| | Marker | Heading (unchanged) | Purpose line |
|---|---|---|---|
| 1 | `STEP 1 OF 4` | Last week's scorecard | What we said we'd do last week, and what actually cleared. |
| 2 | `STEP 2 OF 4` | Carry-overs | Work that didn't finish. Decide if it's still worth doing. |
| 3 | `STEP 3 OF 4` | Blocks | What stopped people, and who is clearing each one. |
| 4 | `STEP 4 OF 4` | Commit | Each person picks this week's work. This is the record. |

A **progress rail** sits under the page header: four segments in the chain-of-custody dot
language from §6.3 — filled `--cleared` for a step scrolled past, `--pending` with its ring
for the current one, outlined for not-reached. Reusing that language rather than inventing a
stepper is the point: the whole app already means "left to right, collecting endorsements".
Driven by an `IntersectionObserver` on the four `<section>`s. Below `md` it is sticky under
the header; above `md` it is static.

### 21.2 Placeholders — a placeholder is an example answer

> **A placeholder models an answer. It never restates the label, and it is never a required
> marker** (§5.2 already handles required with the word `Required`).

Exact strings — the four marked **change** are currently restatements of their own label:

| Field | Placeholder |
|---|---|
| Block reason | `e.g. Waiting on BOC for the release order` **(change)** |
| Cancellation reason | `e.g. Client withdrew the shipment` **(change)** |
| Edit-suggestion reason | `e.g. Points were set before we knew the container count` **(change)** |
| Batch rejection reason | `e.g. Keep the original points — we agreed these on Monday` **(change)** |
| New task title | `What needs doing?` (keep) |
| Progress note / comment | `What did you do? What's next?` (keep) |
| Description | `Anything the person needs to know before starting` |
| Client ref | `e.g. SHPT-2026-0412` |
| Catalog type (select) | `No catalog type (price it later)` (keep) |
| Person (select) | `Choose a person` (keep) |
| Outside party | `e.g. Bureau of Customs` (keep) |

Placeholder colour stays `--ink-3` (§5.2). Below `md` inputs are `h-11` (§16.5).

### 21.3 Empty states — every one, in plain words

| Where | Now | Should be |
|---|---|---|
| No previous week | "There is no previous week yet — this is the first one." | Keep, and add a `ghost` link: `Skip to Commit ↓`. |
| Nobody committed last week | "Nobody committed to anything last week." | Keep. |
| No carry-overs | *(unspecified)* | `Nothing carried over. Everything committed last week finished.` — a **good** empty state, so it gets a 16px `CheckCircle2` in `--cleared`, the only place an empty state is allowed a semantic colour. |
| No blocks | *(unspecified)* | `No blocks were raised last week.` |
| Person has committed nothing | "Nothing yet." | `Nothing committed yet. Pick from the candidates below.` |
| Person has no candidates | "No uncommitted board/backlog tasks." | `No backlog work to pick from.` + a `secondary` **New task** button opening `create-task-dialog` with that person pre-selected. **This is the single biggest unaided-usage fix on the screen** — today it is a dead end phrased in schema. |
| Week is locked | a bare amber sentence | A `--pending-wash` band at the top of Commit with a 12px `Lock`: **`Commitments are locked for this week.`** then `text-body-sm`: `Monday's record can't be changed. A GM can suggest edits below; the founder or admin approves them.` |
| Loading | `BriefingSkeleton` | Already correct — it mirrors all four sections. Add the step markers to it so the shape is right from the first paint. |
| Permission denied (read-only oversight) | affordances absent | A `--blocked-wash` band under the header: `You have read-only access. You can see everything and change nothing.` Absence with no explanation reads as a bug. |

### 21.4 What "done" looks like

- The close control is a **sticky bar** at the bottom of the screen (`bottom-0`, `--surface`,
  `border-top 1px --hairline`, `py-3`, safe-area padding), holding on the left a `text-body-sm`
  readout — `3 of 3 people have committed · 34 points` — and on the right the one `primary`
  button, `Close the briefing`.
- **Disabled while anyone has zero committed tasks**, with the `<Hint>`:
  `Everyone needs at least one committed task before the week can be locked.` A disabled
  button with a reason teaches; a disabled button without one is the thing people call Chan
  about.
- The confirm dialog states the consequence in LRA's words:
  `Closing locks Monday's record. Nobody can change what was committed after this — a GM can
  only suggest edits, and you or the admin approve them.`
- **After closing**, the screen's completion signal is a `--cleared-wash` band under the
  header with a 16px `CheckCircle2`: `Week 38 is open. Committed work is locked.` plus
  `Closed 15 Sep 2026, 09:41 by Chan` in `num-xs --ink-3`. That band is what makes "done" a
  visible state rather than an absence of buttons.

### 21.5 First run

- On first visit to `/briefing` with no `localStorage['lra.seen.briefing.v1']`, the
  `<WhatIsThis>` popover **opens automatically**, anchored to the title, with a `primary`
  `Got it` button that writes the key.
- **This is the only auto-opening help in the app.** Everywhere else the icon waits.
- It never re-opens on its own; the icon stays for later.
- Honest limitation, state it in the code comment: this is per-browser, not per-user. Clearing
  site data re-shows it. That is acceptable for four users and does not justify a
  `core.person` column.

---

## 22. `/points` — the date display

Chan: *"the date displays are pretty bland on the my points page."* They are worse than
bland. `points.tsx` renders `new Date(row.created_at).toLocaleString()` into a `w-32` mono
block: browser-locale-dependent, seconds included, and the widest thing on the row — the
timestamp currently outweighs the transition it timestamps.

### 22.1 The ledger becomes the register §6.4 already specified

§6.4 said "grouped by day under `text-eyebrow` day headings". That was never built. Build it.

- **Day heading row**: `bg --surface-2`, height 28, `px-3`, `text-eyebrow --ink-2`, sticky
  `top-0` inside the panel (`z-1`). Left side:
  - today → `TODAY · MON 15 SEP`
  - yesterday → `YESTERDAY · SUN 14 SEP`
  - this year → `MON 15 SEP`
  - otherwise → `MON 15 SEP 2025`

  Right side: the day's net in `num-sm` — `+21` in `--cleared`, or `—` in `--ink-3` when
  nothing cleared that day. A day's total is the thing a person actually wants from a ledger,
  and it costs one `reduce`.
- **Row**: `[time w-12] [chain dots] [transition] [reason] [Δ]`.
  - Time: `num-xs --ink-3`, **`14:05`** — 24-hour, `Asia/Manila`, no seconds, no date. 12px of
    information instead of 128px.
  - `<Hint>` on the time: `Mon 15 Sep 2026, 14:05 (Asia/Manila)`.
  - Transition: `Backlog → In Progress` via §17, not raw enums.
  - Δ unchanged (`+8` `--cleared` / `—`).
- Below `sm`: the time joins line 2 per §16.6; the day heading stays (it is the structure).

### 22.2 One date module, and a grep-able ban

`apps/web/src/lib/dates.ts`, built on a single memoised
`Intl.DateTimeFormat('en-PH', { timeZone: 'Asia/Manila', … })` per format:

| Export | Output |
|---|---|
| `fmtTime(iso)` | `14:05` |
| `fmtDayHeading(iso)` | `TODAY · MON 15 SEP` / `MON 15 SEP 2025` |
| `fmtDate(iso)` | `15 Sep 2026` |
| `fmtDateTime(iso)` | `Mon 15 Sep 2026, 14:05 (Asia/Manila)` |
| `fmtWeekRange(a, b)` | `15–21 Sep 2026` (en dash) |
| `weekLabel(iso)` | `W38 · 2026` |

> **`toLocaleString` / `toLocaleDateString` / `toLocaleTimeString` are banned outside
> `lib/dates.ts`.** The server clock is Manila; a browser set to another locale currently
> renders a different date than the one the approval was recorded against, and this is a
> system whose purpose is a record that cannot be quietly rewritten. The tester greps for it.

All of it mono + `tnum` per §3.2. `weekNumber()` in `briefing.tsx:534` moves here too — it is
date logic living in a route.

### 22.3 Three more defects on this screen, while it is open

1. **`bg-[#FCF3E3]`** on the pending cell is a literal hex outside `:root` — anti-goal #3.
   → `bg-pending-wash`.
2. **`oldest item waiting {n}d`** → §18, and sentence-cased: `Oldest item waiting 3d 4h`.
3. **The three `num-hero` figures do not step down below `sm`** — §13 says they drop to
   `num-lg`; they are hard-coded `text-[40px]`. → `text-num-lg sm:text-num-hero`.

### 22.4 And the heatmap goes here

The full-size `<ActivityHeatmap>` (§19) sits **between the balance panel and the ledger**, in
its own `--surface` panel with a `text-subtitle` header **Activity** and a `<WhatIsThis>`-style
`<Hint>`: `One square per day. The darker it is, the more you cleared that day.`

That ordering is deliberate: *what I have now* (balance) → *how I've been going* (heatmap) →
*exactly what happened* (ledger). Three questions, in the order a person asks them.

---

## 23. Scoreboard card geometry — taller, with something in it

Chan: *"scoreboard cards should be taller."* Padding is not the answer; §4.1 fixes the
spacing scale and §11 says whitespace comes from rhythm, not from large paddings. The card
gets taller because **it gains the thing that was missing from it**.

### 23.1 What fills the height

`min-h-[268px]` (from ~200), and the new content, in order:

1. Person row — unchanged.
2. Hairline.
3. **NEW — the 13-week mini heatmap** (§19, `variant="mini"`): 8px cells, 2px gaps, no
   labels, no legend, **68px tall**. This is the honest filler, and the reason is the product's
   reason: PLAN.md §10.2 — points exist so *"staff track their own progress… velocity and
   accountability."* A per-person velocity texture is exactly what the scoreboard was missing,
   it is per-person data the card already has the identity for, and it is the same component
   as §19, so it costs one import.
4. Completed / `of N possible` + `PointsBar` — unchanged.
5. The three bucket cells — unchanged.
6. **Founder/admin:** the hit-rate + reliability row — unchanged.
   **Everyone else:** in that row's place, `text-eyebrow` **Velocity** over
   `<span class="num">37</span> tasks cleared in 13 weeks` in `text-body-sm --ink-2`.
   Every viewer's card is therefore the same height, which is why the rail doesn't go ragged
   when a GM looks at it — and it honours PLAN.md §10 #4 (judgement of a person is
   founder-only; a person's own output is not).

§11's "never more than one 24px+ number per panel" still holds: the heatmap has no numbers.

### 23.2 Geometry changes

- `flex-[1_1_300px]` → `flex-[1_1_320px]`; `max-w-[420px]` → `max-w-[460px]`;
  `min-w-[300px]` unchanged, so three-up still fills 1440 and the rail still starts scrolling
  past four.
- Below `sm`, per §16.5, the rail stacks vertically and cards go `w-full min-w-0`; the mini
  heatmap's `ResizeObserver` handles the width with no extra rule.
- `PersonCardSkeleton` gains a 68px `skeleton-pulse` block in the strip's place. A skeleton
  that is the wrong height is a layout shift with extra steps.
- Card hover, radius, border, and the `no lift, no shadow` rule (§5.3) are unchanged.

---

## 24. Light, not daunting — rules the coder can follow

Chan: *"i dont want this webapp to be too daunting. something easy and gets the job done.
something light."*

"Light" here does not mean sparse or pale — this is a dense instrument and §11 stays. It
means **a person always knows what they are looking at and what to do next.** Eleven rules:

1. **One idea per screen**, stated in the `PageHeader` description in ≤ 12 words. If the
   description needs an "and", the screen is doing two jobs.
2. **Answer "what do I do now?" above the fold.** Exactly one `primary` button per screen
   (§11), and when there is nothing to do, an empty state that says so in plain words.
3. **Progressive disclosure.** Reliability arithmetic, cap arithmetic, audit rows and ledger
   internals live behind `<WhatIsThis>` or a row expansion — never a permanent column.
4. **Never show a person a number they cannot act on.** (Which is *why* hit-rate is
   founder-only — restated here as a design rule, not just a permission.)
5. **No screen presents more than five distinct kinds of interactive control.** Counting
   kinds, not instances. A screen with buttons, tabs, a select, a search box, a date range, a
   multi-select and a drag surface is a control panel, not a tool.
6. **Word budgets** from §20.5, everywhere.
7. **Prefer a sentence to a chart, a chart to a table, a table to a form.** `/digest`'s
   "oldest item waiting 3d" line is the model: one sentence that does a chart's job.
8. **Every irreversible action states its consequence in the confirm**, in LRA's words
   (§21.4's close dialog is the model), and destructive confirms name the thing:
   `Cancel "Clear BOC entry for Cebu shipment"?`
9. **Default to the reader.** `/points`, `/now` and `/board` open on *me*, already filtered.
   Nobody should have to operate a picker before seeing their own work.
10. **Nothing blinks, pulses or wears a badge unless a human must act on it today.** A count
    badge that is always non-zero is decoration and people stop seeing it.
11. **New colour is not how you add meaning.** The five semantic hues (§2.3) plus the blue
    ramp (§19.4) are the entire set. A sixth hue means the information architecture failed.

---

## 25. New tokens — and the honest state of dark mode

### 25.1 Dark mode is NOT currently implemented — flagging this plainly

The brief for Part II said the existing palette is theme-aware. **It is not.**
`apps/web/src/index.css:22` declares `color-scheme: light` and there is **no `.dark` block
anywhere in the app.** §2.7 recommended light-only for the MVP, Chan did not overturn it, and
the code matches the recommendation. `tailwind.config.ts` does carry `darkMode: ['class']`, so
the door §2.7 left open is still open — it has simply never been walked through.

So Part II does two things and claims nothing more:

1. Every new token below is given a **light and a dark value**, both measured. The `.dark`
   block is added to `index.css` now. Until a theme toggle exists it is **inert but correct**,
   and it costs nothing.
2. Full dark mode remains **out of scope and unbuilt**. It needs the whole neutral ladder,
   the five semantic hue triplets and the on-navy set re-derived and re-measured — a day of
   work, its own task, and Chan's decision (§26 Q1). Do not half-build it by adding `dark:`
   classes to components; §2.7's rule that no component contains a literal colour is what
   makes it a one-file change later, and it must hold.

### 25.2 Add to `:root` in `index.css` (and mirror into `design/tokens.css`)

```css
:root {
  /* ── brand ramp: one new interpolated step ─────────── */
  --brand-400: #6D9CF3;   /* between --brand-300 and --brand-500 */

  /* ── activity heatmap (§19) — light: more = darker ─── */
  --heat-0: var(--surface-2);
  --heat-1: #C9DDFB;      /* = --brand-200 */
  --heat-2: #6D9CF3;      /* = --brand-400 */
  --heat-3: #1662E8;      /* = --brand-600 */
  --heat-4: #0C3FA3;      /* = --brand-800 */
  --heat-ring: var(--hairline);

  --radius-cell: 2px;     /* heatmap cells only — 4px is too round at 12px */
}

/* Inert until a theme toggle exists (§25.1), but correct when it does.
   Same four hexes as light, assigned in reverse: on navy, more = brighter. */
.dark {
  --heat-0: #182031;
  --heat-1: #0C3FA3;
  --heat-2: #1662E8;
  --heat-3: #6D9CF3;
  --heat-4: #C9DDFB;
  --heat-ring: #232C42;
}
```

`tailwind.config.ts` → `theme.extend.colors`:

```ts
brand: { …, 400: 'var(--brand-400)' },
heat:  { 0: 'var(--heat-0)', 1: 'var(--heat-1)', 2: 'var(--heat-2)',
         3: 'var(--heat-3)', 4: 'var(--heat-4)', ring: 'var(--heat-ring)' },
```
and `theme.extend.borderRadius.cell: 'var(--radius-cell)'`.

### 25.3 Measured — 2026-09-10, WCAG relative luminance

Light ramp relative luminance: `0.895 → 0.711 → 0.335 → 0.147 → 0.063` (monotonic).
Adjacent-step contrast: `1.24` (mitigated by the L0 ring) · `1.98` · `1.95` · `1.75`.
`--heat-4` on `--canvas` = **8.76**. `--heat-1` on `--canvas` = 1.30 — which is correct for a
low-magnitude cell and is why the numeric legend (§19.6) carries the meaning.

Dark ramp relative luminance: `0.017 → 0.063 → 0.147 → 0.335 → 0.711` (monotonic).
Adjacent-step contrast: `1.68` · `1.75` · `1.95` · `1.95`.

`--brand-400 #6D9CF3` on white = **2.31** — **non-text only.** It is a heatmap fill and a
chart tint; it may never carry text, and it is not added to the chart set in §2.4.

### 25.4 New dependencies

`@radix-ui/react-tooltip`, `@radix-ui/react-popover`, `@radix-ui/react-collapsible`,
`@radix-ui/react-tabs` *(only if the §16.3 lane pager is not hand-rolled; `board.tsx` already
hand-rolls a `role="tablist"` and copying that is also fine)*. Nothing else. No new motion
library, no charting library — the heatmap is `div`s, and `recharts` is already present for
the sparkline.

---

## 26. New open questions for Chan

1. **Dark mode.** A) Stay light-only; the `.dark` heatmap tokens sit inert until you ask.
   B) Schedule a full dark pass as its own task now. → **I'd pick A** — nothing in the brief
   asked for a toggle, the briefing display runs in a lit room, and a half-built dark mode is
   worse than none. But say the word and it becomes a scoped task.
2. **Drag-and-drop on phones.** A) Off below 768; a `Move to…` menu replaces it (my spec).
   B) Keep touch drag with the existing 180ms delay. → **I'd pick A** — with one lane visible
   you cannot drag a card to another lane, so B is a gesture that mostly fails. A also reuses
   `moveRefusal` and teaches the rules instead of just refusing.
3. **The heatmap counts tasks, not points.** You said "how many tasks they complete", so a
   day with one 13-point job looks the same as a day with one 2-point job. A) Tasks (my
   spec; points in the tooltip). B) Points, bucketed 0/1–4/5–9/10–19/20+. → **I'd pick A** —
   it is what you asked for, and it rewards finishing things, which is the behaviour the
   system is trying to produce.
4. **`pending_cancellation` reads `Cancellation Requested`** on a chip, with
   *"Someone asked to call this off. Waiting on a decision."* as the tooltip. Today it reads
   `Awaiting cancellation decision`, which is a sentence in a 20px chip. → Confirm the
   shorter label; it is one line in `labels.ts` either way.
