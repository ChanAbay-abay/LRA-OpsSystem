/**
 * LRA Global Ops :: Tailwind config
 *
 * Copied verbatim from DESIGN.md §10 — the designer's binding token
 * mapping. Every colour, radius, font-size and duration here reads a CSS
 * custom property from src/index.css (design/tokens.css); nothing is a
 * raw value invented at build time.
 */
import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

export default {
  darkMode: ['class'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: { 900: 'var(--navy-900)', 800: 'var(--navy-800)', 700: 'var(--navy-700)' },
        brand: {
          800: 'var(--brand-800)', 700: 'var(--brand-700)', 600: 'var(--brand-600)',
          500: 'var(--brand-500)', 400: 'var(--brand-400)', 300: 'var(--brand-300)', 200: 'var(--brand-200)',
          100: 'var(--brand-100)', 50: 'var(--brand-50)',
          DEFAULT: 'var(--brand-600)',
        },
        // The activity heatmap's blue ramp (DESIGN.md §19.4/§25.2) —
        // one new interpolated brand step (400) plus the ramp's own
        // named tokens, since `--heat-2` is the same hex as `brand-400`
        // but the two mean different things (a chart tint vs. a cell
        // fill) and `§19.4`'s "one ramp, one direction flip" wants its
        // own tokens rather than reusing `brand-*` positionally.
        heat: {
          0: 'var(--heat-0)', 1: 'var(--heat-1)', 2: 'var(--heat-2)',
          3: 'var(--heat-3)', 4: 'var(--heat-4)', ring: 'var(--heat-ring)',
        },
        cyan: 'var(--cyan)',
        canvas: 'var(--canvas)',
        surface: { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)', 3: 'var(--surface-3)' },
        hairline: { DEFAULT: 'var(--hairline)', strong: 'var(--hairline-strong)' },
        ink: { DEFAULT: 'var(--ink)', 2: 'var(--ink-2)', 3: 'var(--ink-3)', disabled: 'var(--ink-disabled)' },
        'on-dark': { DEFAULT: 'var(--on-dark)', 2: 'var(--on-dark-2)', 3: 'var(--on-dark-3)' },

        cleared: { DEFAULT: 'var(--cleared)', wash: 'var(--cleared-wash)', border: 'var(--cleared-border)' },
        pending: { DEFAULT: 'var(--pending)', wash: 'var(--pending-wash)', border: 'var(--pending-border)' },
        blocked: { DEFAULT: 'var(--blocked)', wash: 'var(--blocked-wash)', border: 'var(--blocked-border)' },
        info: { DEFAULT: 'var(--info)', wash: 'var(--info-wash)', border: 'var(--info-border)' },
        // Was missing entirely -- `text-danger` was already used in
        // Phase 2's admin-users.tsx/login.tsx and silently generated no
        // CSS at all (Tailwind ignores an unrecognised utility rather
        // than erroring). Added here rather than left as a no-op.
        danger: { DEFAULT: 'var(--danger)', wash: 'var(--danger-wash)', border: 'var(--danger-border)' },

        // shadcn aliases — raw values, no hsl() wrapper
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        card: { DEFAULT: 'var(--card)', foreground: 'var(--card-foreground)' },
        popover: { DEFAULT: 'var(--popover)', foreground: 'var(--popover-foreground)' },
        primary: { DEFAULT: 'var(--primary)', foreground: 'var(--primary-foreground)' },
        secondary: { DEFAULT: 'var(--secondary)', foreground: 'var(--secondary-foreground)' },
        muted: { DEFAULT: 'var(--muted)', foreground: 'var(--muted-foreground)' },
        accent: { DEFAULT: 'var(--accent)', foreground: 'var(--accent-foreground)' },
        destructive: { DEFAULT: 'var(--destructive)', foreground: 'var(--destructive-foreground)' },
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        chart: { 1: 'var(--chart-1)', 2: 'var(--chart-2)', 3: 'var(--chart-3)', 4: 'var(--chart-4)', 5: 'var(--chart-5)' },
      },
      fontFamily: {
        sans: ['Urbanist Variable', 'Urbanist', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['Geist Mono Variable', 'Geist Mono', 'ui-monospace', 'SF Mono', 'Menlo', 'monospace'],
      },
      fontSize: {
        display: ['32px', { lineHeight: '1.10', letterSpacing: '-0.72px', fontWeight: '600' }],
        'title-lg': ['24px', { lineHeight: '1.15', letterSpacing: '-0.48px', fontWeight: '600' }],
        title: ['20px', { lineHeight: '1.25', letterSpacing: '-0.30px', fontWeight: '600' }],
        subtitle: ['16px', { lineHeight: '1.35', letterSpacing: '-0.15px', fontWeight: '600' }],
        strong: ['14px', { lineHeight: '1.40', letterSpacing: '-0.05px', fontWeight: '600' }],
        body: ['14px', { lineHeight: '1.50', letterSpacing: '0' }],
        'body-sm': ['13px', { lineHeight: '1.45', letterSpacing: '0' }],
        label: ['12px', { lineHeight: '1.35', letterSpacing: '0', fontWeight: '500' }],
        eyebrow: ['11px', { lineHeight: '1.20', letterSpacing: '0.08em', fontWeight: '600' }],
        micro: ['11px', { lineHeight: '1.30', letterSpacing: '0', fontWeight: '500' }],
        'num-hero': ['40px', { lineHeight: '1.00', letterSpacing: '-1.0px', fontWeight: '500' }],
        'num-lg': ['24px', { lineHeight: '1.00', letterSpacing: '-0.40px', fontWeight: '500' }],
        'num-md': ['16px', { lineHeight: '1.00', letterSpacing: '-0.20px', fontWeight: '500' }],
        'num-sm': ['13px', { lineHeight: '1.20', letterSpacing: '0', fontWeight: '500' }],
        'num-xs': ['11px', { lineHeight: '1.20', letterSpacing: '0.02em', fontWeight: '500' }],
      },
      borderRadius: {
        xs: '4px', sm: '6px', md: '8px', lg: '12px', xl: '16px',
        cell: 'var(--radius-cell)',
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
      // DESIGN.md §7.1: "Accordion / collapsible — Radix
      // `--radix-collapsible-content-height` keyframe, `--dur-pop`,
      // `--ease-out`." Added for the briefing's below-`md` per-person
      // Collapsible (§16.4) — the first Radix Collapsible in the app.
      keyframes: {
        'collapsible-down': { from: { height: '0' }, to: { height: 'var(--radix-collapsible-content-height)' } },
        'collapsible-up': { from: { height: 'var(--radix-collapsible-content-height)' }, to: { height: '0' } },
      },
      animation: {
        'collapsible-down': 'collapsible-down var(--dur-pop) var(--ease-out)',
        'collapsible-up': 'collapsible-up var(--dur-pop) var(--ease-out)',
      },
    },
  },
  plugins: [animate],
} satisfies Config;
