---
version: alpha
name: Airbnb
description: "Airbnb's design language is a warm, approachable consumer system built around a single proprietary rounded sans — Airbnb Cereal VF — that carries every word on the page at weights 400 and 700, never in between. The palette is strikingly restrained: near-black ink on pure white, punctuated at exactly one point by the brand's signature coral-pink Rausch used exclusively on the primary CTA and the logo. Surfaces are white or barely-off-white; depth comes not from colour but from photograph — full-bleed listing imagery with fully-rounded corners is the decoration system. The search bar is the hero: a wide pill container with hairline shadow, three segmented fields, and a coral search button. Everything else steps back."
colors:
  primary: "#FF385C"
  on-primary: "#ffffff"
  ink: "#222222"
  body: "#222222"
  mute: "#717171"
  hairline: "#DDDDDD"
  canvas: "#ffffff"
  canvas-soft: "#F7F7F7"
  link: "#222222"
  error: "#C13515"
  new-badge-bg: "#E8F4F8"
  new-badge-text: "#005A6E"
typography:
  display-lg:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 28px
    fontWeight: 700
    lineHeight: 40px
    letterSpacing: normal
  display-md:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 22px
    fontWeight: 700
    lineHeight: 28px
    letterSpacing: normal
  display-sm:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 18px
    fontWeight: 700
    lineHeight: 24px
    letterSpacing: normal
  body-lg:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 16px
    fontWeight: 400
    lineHeight: 24px
    letterSpacing: normal
  body-md:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: normal
  body-md-strong:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 14px
    fontWeight: 700
    lineHeight: 20px
    letterSpacing: normal
  body-sm:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: normal
  body-sm-strong:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 12px
    fontWeight: 700
    lineHeight: 16px
    letterSpacing: normal
  caption:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 12px
    fontWeight: 400
    lineHeight: 16px
    letterSpacing: normal
  button-md:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 14px
    fontWeight: 700
    lineHeight: 20px
    letterSpacing: normal
  button-lg:
    fontFamily: '"Airbnb Cereal VF", Circular, -apple-system, "system-ui", Roboto, "Helvetica Neue", sans-serif'
    fontSize: 16px
    fontWeight: 700
    lineHeight: 20px
    letterSpacing: normal
rounded:
  none: 0px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  card: 16px
  pill: 10px
  button: 50px
  full: 9999px
spacing:
  xxs: 4px
  xs: 8px
  sm: 12px
  md: 16px
  lg: 24px
  xl: 32px
  2xl: 40px
  3xl: 48px
  4xl: 64px
  section: 96px
components:
  nav-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    height: 80px
    padding: "{spacing.sm} {spacing.xl}"
    borderBottom: 1px solid {colors.hairline}
  nav-link:
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs} {spacing.sm}"
  nav-cta-host:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs} {spacing.sm}"
  nav-globe-button:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs}"
  nav-user-menu:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs} {spacing.sm}"
  search-bar:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.button}"
    padding: "{spacing.sm} {spacing.lg}"
    shadow: 0 1px 2px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05)
  search-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    labelTypography: "{typography.body-sm-strong}"
    inputTypography: "{typography.body-md}"
    padding: "{spacing.sm} {spacing.md}"
  search-button:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.button}"
    padding: "{spacing.sm} {spacing.md}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-lg}"
    rounded: "{rounded.button}"
    padding: "{spacing.sm} {spacing.lg}"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.button}"
    padding: "{spacing.sm} {spacing.lg}"
  button-ghost:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs} {spacing.sm}"
  listing-card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.card}"
    imageRadius: "{rounded.card}"
  listing-card-badge:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.button}"
    padding: "{spacing.xxs} {spacing.xs}"
  listing-card-save:
    textColor: "{colors.canvas}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
  listing-card-title:
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
  listing-card-meta:
    textColor: "{colors.mute}"
    typography: "{typography.body-md}"
  listing-card-price:
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
  section-header:
    textColor: "{colors.ink}"
    typography: "{typography.display-lg}"
    padding: "{spacing.lg} 0"
  section-see-all:
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
    rounded: "{rounded.button}"
    padding: "{spacing.xs} {spacing.xs}"
  new-badge:
    backgroundColor: "{colors.new-badge-bg}"
    textColor: "{colors.new-badge-text}"
    typography: "{typography.body-sm-strong}"
    rounded: "{rounded.pill}"
    padding: "{spacing.xxs} {spacing.xs}"
  nav-tab-active:
    textColor: "{colors.ink}"
    typography: "{typography.body-md-strong}"
    borderBottom: 2px solid {colors.ink}
    padding: "{spacing.sm} 0"
  carousel-arrow:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    borderColor: "{colors.hairline}"
    rounded: "{rounded.full}"
    padding: "{spacing.xs}"
    shadow: 0 1px 2px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05)
  footer:
    backgroundColor: "{colors.canvas-soft}"
    textColor: "{colors.mute}"
    typography: "{typography.body-sm}"
    borderTop: 1px solid {colors.hairline}
    padding: "{spacing.lg} {spacing.xl}"
---
## Overview

Airbnb is a marketplace brand whose visual language is engineered to disappear behind the listing photograph. The surface is almost entirely white — `{colors.canvas}` everywhere, with `{colors.canvas-soft}` reserved for the footer band — so that the full-bleed imagery of real homes, mountain cabins, and resort pools becomes the page's only colour. Every card is a photograph with a corner radius of 16 px and no visible border; the image IS the card chrome.

The brand's singular accent is Rausch (`{colors.primary}` — the coral-pink that Airbnb's own team named after the founder's street). It appears in exactly two places at page scale: the circular search button and the logo. Nowhere else. Body text, nav links, prices, and section headings are all rendered in the same near-black ink (`{colors.ink}`, `#222222`); secondary metadata like star ratings, night counts, and distance leans on `{colors.mute}` (`#717171`). The brand trusts neutral contrast rather than colour variety to establish hierarchy.

Type is set in a single face throughout: Airbnb Cereal VF, the brand's own variable-axis rounded geometric sans. It runs at weight 700 for every heading, label, price, and button — weight 400 for body copy and secondary metadata. There is no middle weight (500 or 600) in use. The tracked values are all at `normal`; the brand does not use tight negative tracking. This produces a voice that is friendly and legible rather than editorial and precise.

The search bar is the hero interaction. A wide rounded-pill container (`{rounded.button}` — 50 px radius) floats below the nav with a soft two-layer box shadow, divided into three segments ("Where / When / Who") by hairline dividers, and terminated with the coral search button. All other CTAs — "Become a host," nav user menu, carousel arrows — are ghost pills or icon circles. The page's conversion grammar is: one coral button, everything else white.

## Colors

### Brand
- **Rausch / Primary** (`{colors.primary}` — `#FF385C`): The brand's coral-pink. Used only on the search button and the logo mark. The sole departure from the ink-and-white palette at page scale. Not used on text.
- **On-Primary** (`{colors.on-primary}` — `#ffffff`): White text and icons sitting on the coral search button.

### Ink & Text
- **Ink** (`{colors.ink}` — `#222222`): Every heading, listing title, price, nav link, and button label. The page is essentially one ink-on-white system.
- **Mute** (`{colors.mute}` — `#717171`): Secondary metadata — star ratings, "2 nights," distance labels, footer body copy. The accessible mid-gray that signals supporting information without competing with the headline.

### Surface
- **Canvas** (`{colors.canvas}` — `#ffffff`): The universal page and card surface. The entire page background, every listing card, the search bar container, nav bar.
- **Canvas Soft** (`{colors.canvas-soft}` — `#F7F7F7`): The footer band background and occasional section dividers. Barely perceptible on screen; its job is to signal "the content has ended."
- **Hairline** (`{colors.hairline}` — `#DDDDDD`): 1 px dividers between search-bar segments, card borders where images haven't loaded, nav bottom border, carousel arrow rings.

### Semantic
- **Error** (`{colors.error}` — `#C13515`): Validation and destructive-action states. Not visible in the marketing surface but present in the brand token system.
- **New Badge BG** (`{colors.new-badge-bg}` — `#E8F4F8`): The soft teal-wash fill behind the "NEW" badge pill on Experiences and Services nav tabs.
- **New Badge Text** (`{colors.new-badge-text}` — `#005A6E`): The dark teal label inside the "NEW" badge pill.

## Typography

### Font Family
Airbnb runs a single typeface throughout the entire product: **Airbnb Cereal VF**, the brand's proprietary variable-weight rounded geometric sans. It appears at weight 400 for body, metadata, and secondary labels; at weight 700 for headings, prices, button labels, and listing titles. No intermediate weights (500, 600) are in use on the captured surface. Tracking is `normal` at all sizes — the brand's voice is warm and legible, not tight and editorial.

A note on substitutes: the font stack falls through to **Circular** (another proprietary rounded sans), then to `-apple-system` and **Roboto** as system fallbacks. For open-source use, **DM Sans** (400/700) is the closest stylistic match; **Nunito** is a passable second choice.

### Hierarchy

| Token | Size | Weight | Line Height | Use |
|---|---|---|---|---|
| `{typography.display-lg}` | 28px | 700 | 40px | Section headlines ("Popular homes in Big Bear Lake", "Earn Airbnb credit at featured hotels"). |
| `{typography.display-md}` | 22px | 700 | 28px | Subsection or feature heads where a step below display-lg is needed. |
| `{typography.display-sm}` | 18px | 700 | 24px | Card cluster sub-headlines, modal headers. |
| `{typography.body-lg}` | 16px | 400 | 24px | Lead descriptive copy beneath section headlines. |
| `{typography.body-md}` | 14px | 400 | 20px | Default body — listing type label ("Home in Big Bear Lake"), price secondary text, search field placeholder. |
| `{typography.body-md-strong}` | 14px | 700 | 20px | Listing card title, nav links, "Become a host," section "see all" arrows, search field labels ("Where / When / Who"). |
| `{typography.body-sm}` | 12px | 400 | 16px | Secondary metadata — "4.89 · 126 reviews," distance, footer links. |
| `{typography.body-sm-strong}` | 12px | 700 | 16px | "Guest favorite" badge label, "NEW" badge label, pricing footnotes. |
| `{typography.caption}` | 12px | 400 | 16px | Fine print, accessibility labels. |
| `{typography.button-md}` | 14px | 700 | 20px | Small pill buttons — nav CTAs, inline actions. |
| `{typography.button-lg}` | 16px | 700 | 20px | Marketing-scale primary buttons. |

### Principles
- **Two-weight system only.** Cereal VF runs exclusively at 400 and 700. There is no medium (500) weight used anywhere in the captured surface. The jump from regular to bold is the only typographic contrast mechanism.
- **Normal tracking throughout.** The brand never applies negative letter-spacing. Friendliness over precision.
- **Sentence-case for all headings.** "Popular homes in Big Bear Lake" — not title-case, not all-caps. The approachable consumer voice extends to capitalisation.
- **Prices use bold body text, not a display size.** "$486 for 2 nights" is set in `{typography.body-md-strong}` — the brand puts the photograph first, not the price.

## Layout

### Spacing System
- **Base unit**: 4 px. The extracted scale (`4 / 5.5 / 6 / 8 / 9.5 / 12 px`) reveals a mixed 4-px and sub-pixel grid driven by the variable-font metrics. Practical layout tokens round to the nearest 4-px multiple.
- **Tokens**: `{spacing.xxs}` 4 px · `{spacing.xs}` 8 px · `{spacing.sm}` 12 px · `{spacing.md}` 16 px · `{spacing.lg}` 24 px · `{spacing.xl}` 32 px · `{spacing.2xl}` 40 px · `{spacing.3xl}` 48 px · `{spacing.4xl}` 64 px · `{spacing.section}` 96 px.
- **Section padding**: listing-grid sections use `{spacing.lg}` to `{spacing.xl}` top/bottom. The hero search area uses `{spacing.xl}` below the nav before the search bar appears.
- **Card grid gap**: approximately `{spacing.md}` (16 px) between listing cards in the horizontal scroll row.

### Grid & Container
- **Max width**: approximately 1280 px; content centres with `{spacing.xl}` gutters at desktop.
- **Column patterns**:
  - Listing card row: 6-up horizontal scroll at wide desktop (visible in screenshot), collapsing to fewer columns at narrower viewports.
  - Nav row: logo left, tab strip centre, host CTA + globe + user-menu cluster right.
  - Search bar: full-width pill below the nav, three equal-weight fields + search button.

### Whitespace Philosophy
The page earns its openness by letting the listing photographs breathe. Section headlines sit close to their card grids (tight `{spacing.xs}` gap) but sections themselves are separated by generous `{spacing.section}` bands. The search bar floats with box-shadow rather than a coloured band — the entire decoration system is shadow + photography, not background colour.

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| Level 0 — Flat | No shadow, no border. | Full-bleed listing photographs within the card image area. |
| Level 1 — Hairline | `0 0 0 1px {colors.hairline}` | Carousel arrow circles, nav bottom divider. |
| Level 2 — Soft Float | `0 1px 2px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.05)` | The search bar container and carousel nav arrows — the brand's primary elevation cue. |
| Level 3 — Card Hover | `0 2px 4px rgba(0,0,0,0.08), 0 8px 16px rgba(0,0,0,0.08)` | Listing card hover state (implicit from brand patterns). |

The brand uses a two-stop soft shadow — a 1-px near blur for crispness plus a 12-px ambient layer for float — never a single heavy drop. Cards on rest have no shadow; the image fills the rounded container completely and the shadow appears only on hover or on interactive floating elements like the search bar.

## Shapes

### Border Radius Scale

| Token | Value | Use |
|---|---|---|
| `{rounded.none}` | 0px | Full-bleed bands. |
| `{rounded.xs}` | 4px | Tightest inline element. |
| `{rounded.sm}` | 8px | Small badges in non-pill contexts. |
| `{rounded.md}` | 12px | Moderate card inner elements. |
| `{rounded.lg}` | 16px | Listing card image radius — the universal card corner. |
| `{rounded.card}` | 16px | Canonical listing card radius (alias of `lg`). |
| `{rounded.xl}` | 24px | Larger modal or sheet containers. |
| `{rounded.pill}` | 10px | "NEW" badge pills on the Experiences and Services nav tabs. |
| `{rounded.button}` | 50px | Every button CTA, the search bar, the user-menu chip, and the "Guest favorite" badge. The brand's defining shape. |
| `{rounded.full}` | 9999px | Circular carousel arrows, save-button icon containers. |

The 50 px pill (`{rounded.button}`) is the brand's most distinctive shape decision. At button scale it reads as a true pill; at search-bar scale the same radius creates the brand's iconic wide rounded rectangle. The two shapes are the same token applied at different sizes — a deliberate economy.

## Components

### Search Bar

**`search-bar`** — the hero interaction surface, a wide pill container below the nav.
- Background `{colors.canvas}`, 1 px solid `{colors.hairline}` border, rounded `{rounded.button}` (50 px), two-layer soft shadow. Contains three `search-field` segments divided by hairline verticals and terminated with `search-button`.

**`search-field`** — one of the three segments inside `search-bar` ("Where / When / Who").
- Background transparent, label in `{typography.body-sm-strong}` (12 px / 700), input hint in `{typography.body-md}` (14 px / 400), padding `{spacing.sm} {spacing.md}`.

**`search-button`** — the coral circular CTA inside the search bar.
- Background `{colors.primary}`, icon + optional label in `{colors.on-primary}`, rounded `{rounded.button}`, padding `{spacing.sm} {spacing.md}`.

### Navigation

**`nav-bar`** — the sticky top bar.
- Background `{colors.canvas}`, hairline bottom border, height 80 px, padding `{spacing.sm} {spacing.xl}`. Layout: logo left, tab strip centre, CTA cluster right.

**`nav-tab-active`** — the active underlined tab in the centre nav strip ("Homes").
- Text `{colors.ink}`, `{typography.body-md-strong}`, 2 px solid ink underline, padding `{spacing.sm} 0`.

**`nav-link`** — inactive nav tab links ("Experiences," "Services").
- Text `{colors.ink}`, `{typography.body-md-strong}`, no underline, rounded `{rounded.button}`.

**`new-badge`** — the "NEW" pill overlaid on the Experiences and Services nav icons.
- Background `{colors.new-badge-bg}`, text `{colors.new-badge-text}`, `{typography.body-sm-strong}`, rounded `{rounded.pill}` (10 px), padding `{spacing.xxs} {spacing.xs}`.

**`nav-cta-host`** — the "Become a host" text-style nav button.
- Background `{colors.canvas}`, text `{colors.ink}`, `{typography.body-md-strong}`, rounded `{rounded.button}`.

**`nav-globe-button`** — the language/region icon button in the nav cluster.
- Background `{colors.canvas}`, text `{colors.ink}`, rounded `{rounded.button}`, hairline hover ring.

**`nav-user-menu`** — the hamburger + avatar chip.
- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border, rounded `{rounded.button}`, padding `{spacing.xs} {spacing.sm}`.

### Listing Cards

**`listing-card`** — the canonical property card, the most frequent surface on the page.
- Background `{colors.canvas}`, rounded `{rounded.card}` (16 px) on the image container. No border at rest. Stacks: full-bleed photograph → location type label (`{typography.body-md}` / mute) → listing title (`{typography.body-md-strong}` / ink) → metadata row (rating · count) → price row.

**`listing-card-badge`** — the "Guest favorite" label pinned to the top-left of listing photos.
- Background `{colors.canvas}`, text `{colors.ink}`, `{typography.body-sm-strong}`, rounded `{rounded.button}` (50 px pill), padding `{spacing.xxs} {spacing.xs}`.

**`listing-card-save`** — the heart icon button in the top-right corner of listing photos.
- Text `{colors.canvas}` (white heart outline against the image), rounded `{rounded.full}`.

**`listing-card-title`** — the listing location title line.
- Text `{colors.ink}`, `{typography.body-md-strong}`.

**`listing-card-meta`** — secondary line (price per period, star rating).
- Text `{colors.mute}`, `{typography.body-md}`.

### Sections & Layout

**`section-header`** — the section headline + "see all" arrow row.
- Text `{colors.ink}`, `{typography.display-lg}`, padding `{spacing.lg} 0`.

**`section-see-all`** — the circular arrow link beside section headlines.
- Background `{colors.canvas}`, text `{colors.ink}`, `{typography.body-md-strong}`, rounded `{rounded.button}`, padding `{spacing.xs}`.

**`carousel-arrow`** — the prev/next navigation buttons at the section right edge.
- Background `{colors.canvas}`, text `{colors.ink}`, 1 px solid `{colors.hairline}` border, rounded `{rounded.full}`, soft shadow Level 2.

**`footer`** — the bottom navigation band.
- Background `{colors.canvas-soft}`, text `{colors.mute}`, `{typography.body-sm}`, 1 px solid `{colors.hairline}` top border, padding `{spacing.lg} {spacing.xl}`.

### Example Surfaces

**`ex-pricing-tier`** — Default listing-tier summary card.
- backgroundColor: "{colors.canvas}"
- textColor: "{colors.ink}"
- borderColor: "{colors.hairline}"
- rounded: "{rounded.card}"
- padding: "{spacing.lg}"

**`ex-pricing-tier-featured`** — Featured or "Guest favorite" polarity-highlighted card.
- backgroundColor: "{colors.ink}"
- textColor: "{colors.on-primary}"
- rounded: "{rounded.card}"
- padding: "{spacing.lg}"

**`ex-product-selector`** — Category / filter selector card (property type, amenities).
- backgroundColor: "{colors.canvas-soft}"
- rounded: "{rounded.md}"
- padding: "{spacing.md}"

**`ex-cart-drawer`** — Booking summary panel (dates, guests, price breakdown).
- backgroundColor: "{colors.canvas}"
- rounded: "{rounded.lg}"
- padding: "{spacing.lg}"
- item-divider: "{colors.hairline}"

**`ex-app-shell-row`** — Sidebar or tab nav row inside the host dashboard.
- backgroundColor: "{colors.canvas}"
- activeIndicator: "{colors.primary}"
- rounded: "{rounded.sm}"
- padding: "{spacing.xs} {spacing.sm}"

**`ex-data-table-cell`** — Reservation / earnings table chrome.
- headerBackground: "{colors.canvas-soft}"
- headerTypography: "{typography.body-sm-strong}"
- bodyTypography: "{typography.body-md}"
- cellPadding: "{spacing.xs} {spacing.sm}"
- rowBorder: "{colors.hairline}"

**`ex-auth-form-card`** — Sign-in / sign-up modal card.
- backgroundColor: "{colors.canvas}"
- rounded: "{rounded.lg}"
- padding: "{spacing.xl}"

**`ex-modal-card`** — Generic modal dialog surface.
- backgroundColor: "{colors.canvas}"
- rounded: "{rounded.lg}"
- padding: "{spacing.xl}"

**`ex-empty-state-card`** — Empty search results or no-bookings state.
- backgroundColor: "{colors.canvas-soft}"
- rounded: "{rounded.lg}"
- padding: "{spacing.3xl}"
- captionTypography: "{typography.body-md}"

**`ex-toast`** — Toast notification.
- backgroundColor: "{colors.ink}"
- rounded: "{rounded.button}"
- padding: "{spacing.sm} {spacing.md}"
- typography: "{typography.body-sm-strong}"

## Do's and Don'ts

### Do
- Reserve `{colors.primary}` (`#FF385C`) for the search button and brand mark exclusively. Rausch is the brand's single conversion colour; diluting it across secondary CTAs breaks the grammar.
- Use `{rounded.button}` (50 px) for every pill button, the search bar container, and the "Guest favorite" badge. The pill is the brand's shape signature.
- Set every listing title, price, and button label at weight 700 (`{typography.body-md-strong}` or `{typography.button-md}`). The two-weight system — 400 and 700 only — is non-negotiable.
- Let listing photography carry all visual richness. The page surface is white on white; every accent colour and texture comes from the images.
- Use a two-layer soft shadow (`0 1px 2px + 0 4px 12px`) for interactive floating surfaces (search bar, carousel arrows). Never a single heavy drop.
- Honour sentence-case for all section headlines. "Popular homes in Big Bear Lake" — not title-case.
- Use `{colors.mute}` (`#717171`) for all secondary metadata (ratings, durations, footer copy) to maintain clear hierarchy without introducing a new colour.

### Don't
- Don't introduce a third font weight. There is no 500 or 600 in the Airbnb Cereal VF system as used on this surface.
- Don't apply negative letter-spacing to headings. The brand's voice is open and round, never tight or editorial.
- Don't reuse `{colors.primary}` Rausch on text links, hover states, or secondary buttons. It exists only on the logo and the search CTA.
- Don't give listing cards a visible border at rest. The image fills the rounded container fully; a border competes with the photograph.
- Don't use the `{rounded.pill}` (10 px) token for buttons — it belongs exclusively to the "NEW" badge. Buttons always use `{rounded.button}` (50 px).
- Don't place section content on coloured bands. Every content section sits on `{colors.canvas}` white; only the footer uses `{colors.canvas-soft}`.
- Don't miniaturise the logo mark to a small icon without preserving the coral fill. The Rausch pink IS the logo; a monochrome version erases the brand's only colour accent.
