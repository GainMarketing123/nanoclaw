# Design System — Atlas Command

## Product Context
- **What this is:** CEO operations dashboard for a multi-company AI platform
- **Who it's for:** Non-technical CEO who glances for 10 seconds to know if businesses are running
- **Space/industry:** AI operations, property management (GPG), landscaping (Crownscape), holding company (WiseStream)
- **Project type:** Dark-themed data-dense app UI (not marketing site)

## Aesthetic Direction
- **Direction:** Industrial/Utilitarian with Luxury touches
- **Decoration level:** Intentional (subtle gradient borders, glass-blur sidebar, animated indicators)
- **Mood:** Bloomberg Terminal meets premium watch brand. A cockpit, not a template. Dense but every detail intentional.
- **Reference sites:** Linear, Vercel, Raycast, Arc Browser

## Typography
- **Display/Hero:** Satoshi — geometric sans, confident, modern. Used by Vercel/Raycast.
- **Body:** Geist — Vercel's font, built for developer tools. Clean at small sizes.
- **UI/Labels:** Geist (same as body)
- **Data/Tables:** Geist with font-variant-numeric: tabular-nums — numbers align in columns
- **Code:** Geist Mono
- **Loading:** CDN (fontsource for Satoshi, jsdelivr for Geist)
- **Scale:** 11px (caption) / 12px (small) / 13px (body-sm) / 14px (body) / 16px (subtitle) / 20px (title) / 24px (heading) / 32px (display)

## Color
- **Approach:** Restrained — one accent (blue), one distinctive secondary (gold for money)
- **Background:** #08080A (near-black, slightly warm)
- **Surface hierarchy:**
  - Surface: #111114
  - Surface hover: #17171C
  - Surface active: #1C1C24
- **Border:** #2A2A36 (1px solid, no shadows — borders create depth)
- **Accent:** #3B82F6 (blue — trust, authority, action)
- **Accent dim:** #2563EB (hover/pressed state)
- **Gold:** #E7DBB3 (distinctive secondary — used ONLY for money/cost values)
- **Gold dim:** #A89968 (muted gold)
- **Text primary:** #F0F0F5 (high contrast against backgrounds)
- **Text secondary:** #A0A0B8 (readable secondary text)
- **Text muted:** #7B7B94 (labels, captions — still readable)
- **Semantic:** success #34D399, warning #FBBF24, error #EF4444, info #4D7EFF
- **Dark mode:** This IS dark mode. No light mode planned.

### Color Rules
- Money values ($0.38, costs, budgets) are ALWAYS gold (#E7DBB3)
- Active/running states use accent blue
- Entity badges: GPG = blue pill, Crownscape = green pill, WiseStream = gold pill
- Never use color alone to convey meaning — pair with icons/text

## Spacing
- **Base unit:** 4px
- **Density:** Compact (CEO glance window is 10 seconds — no wasted space)
- **Scale:** 2xs(2px) xs(4px) sm(8px) md(16px) lg(24px) xl(32px) 2xl(48px) 3xl(64px)

## Layout
- **Approach:** Grid-disciplined
- **Sidebar:** 200px fixed, glass-blur effect (backdrop-filter: blur(12px))
- **Content:** max-width 1200px, padding 24px
- **Grid:** CSS Grid for dashboard panels, auto-fill for stat cards
- **Border radius:** sm: 4px, md: 8px (cards), lg: 12px, full: 9999px (pills/badges)

## Motion
- **Approach:** Minimal-functional with intentional cockpit indicators
- **Easing:** ease-out for enters, ease-in for exits
- **Duration:** micro: 100ms, short: 150ms, medium: 250ms
- **Allowed animations:**
  - Service health indicator pulse (subtle green glow, 2s cycle)
  - Progress ring pulse on active missions
  - Sparkline fade-in on stat cards
  - State transitions (150ms ease-out)
- **Forbidden:** Page entrance animations, scroll-driven effects, decorative motion

## Visual Elements
- **Charts:** Inline SVG only (no chart libraries). Sparklines in stat cards, area charts for trends, progress rings for mission status.
- **Gauges:** SVG speedometer dials for service health. Green = active, red = down.
- **Progress bars:** Horizontal bars with rounded caps for role completion.
- **Gradient borders:** Subtle bottom-border gradients on stat cards (blue for status, gold for money).
- **Glass effect:** Sidebar only — backdrop-filter: blur(12px) with semi-transparent background.

## Anti-Patterns (never do these)
- No purple/violet gradients
- No 3-column icon-in-circle feature grids
- No centered-everything layouts
- No decorative blobs, waves, or floating shapes
- No box-shadows for depth (use 1px borders only)
- No Montserrat, Inter, Roboto, or other overused fonts
- No generic "Welcome to..." hero copy
- No uniform border-radius on everything

## Decisions Log
| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-04-16 | Initial design system | Created by /design-consultation based on Linear/Vercel/Raycast research. Industrial/Luxury aesthetic with gold-as-money distinctive element. |
| 2026-04-16 | Satoshi + Geist typography | Replaces Montserrat. Geist has superior tabular-nums for data tables. Satoshi for display adds confidence. |
| 2026-04-16 | Text contrast bump | --text-muted from #52526B to #7B7B94, --text-secondary from #8B8B9E to #A0A0B8. Original was too hard to read. |
| 2026-04-16 | Cockpit visual language | SVG gauges, sparklines, progress rings. CEO feedback: "like a car dashboard." |
