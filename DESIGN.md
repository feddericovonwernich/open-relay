---
name: Open Relay Presentation
description: A dark editorial switchboard for technical architecture reviews.
colors:
  ink: "#080807"
  ink-raised: "#11110f"
  ivory: "#f4f0e6"
  muted: "#aaa499"
  faint: "#6e6a63"
  kinpaku-gold: "#d8b86a"
  signal-gold: "#f0d68f"
  success-green: "#8ad4ad"
  failure-red: "#e17b62"
typography:
  display:
    fontFamily: "Alumni Sans, Arial Narrow, sans-serif"
    fontSize: "clamp(3.5rem, 7.2vw, 7rem)"
    fontWeight: 500
    lineHeight: 0.88
    letterSpacing: "-0.025em"
  body:
    fontFamily: "Albert Sans, Arial, sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.55
  protocol:
    fontFamily: "SFMono-Regular, Consolas, Liberation Mono, monospace"
    fontSize: "0.68rem"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  panel: "12px"
  control: "999px"
spacing:
  grouped: "1rem"
  section: "clamp(3rem, 8vw, 9rem)"
  screen-edge: "clamp(1.25rem, 4vw, 4.75rem)"
components:
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.ivory}"
    rounded: "{rounded.control}"
    size: "2.25rem"
  code-panel:
    backgroundColor: "{colors.ink-raised}"
    textColor: "{colors.ivory}"
    rounded: "{rounded.panel}"
    padding: "1.35rem 1.5rem"
---

# Design System: Open Relay Presentation

## Overview

**Creative North Star: "The Signal Desk"**

The presentation behaves like a technical switchboard printed by an editorial studio. Near-black paper holds warm ivory information; restrained gold identifies active paths, contracts, and decisive words. Diagrams are the main explanatory surface, not decoration, and ledger rules keep dense protocol material scannable.

The system is flat, disciplined, and projection-ready. Full-viewport slides carry one argument each on desktop; mobile converts the same sequence into a vertically readable technical story without changing content order.

**Key Characteristics:**
- Editorial scale paired with precise protocol labels.
- Gold reserved for signals, active state, and architectural invariants.
- Hairline structure instead of container-heavy cards.
- Native HTML, CSS, and SVG diagrams with accessible text equivalents.
- One moving signal path, disabled for reduced-motion preferences.

## Colors

The palette is warm black and paper-white with a narrow metallic signal range; green and red appear only for success and failure semantics.

### Primary
- **Kintsugi Signal** (`#d8b86a`): Structural rules, active paths, and diagram connections.
- **Lit Signal** (`#f0d68f`): High-emphasis text and current-state details.

### Tertiary
- **Settled Green** (`#8ad4ad`): Successful commits, valid results, and winning leases.
- **Failure Clay** (`#e17b62`): Rejected leases, trust warnings, and terminal failures.

### Neutral
- **Black Paper** (`#080807`): Canonical page ground.
- **Raised Ink** (`#11110f`): Code and tooltip surfaces.
- **Warm Ivory** (`#f4f0e6`): Primary text.
- **Editorial Grey** (`#aaa499`): Explanations and secondary copy.
- **Faint Graphite** (`#6e6a63`): Low-priority metadata.

**The Signal Rarity Rule.** Gold identifies meaning or movement; it never fills generic decoration.

## Typography

**Display Font:** Alumni Sans (with Arial Narrow fallback)  
**Body Font:** Albert Sans (with Arial fallback)  
**Label/Mono Font:** SFMono-Regular, Consolas, Liberation Mono

**Character:** Condensed display lettering gives each slide projection-scale authority. The neutral body face carries explanation; monospace is reserved for endpoints, fields, data, and measured state.

### Hierarchy
- **Hero** (500, `clamp(4.2rem, 10vw, 8.8rem)`, 0.82): Opening proposition only.
- **Display** (500, `clamp(3.5rem, 7.2vw, 7rem)`, 0.88): One architectural claim per slide.
- **Title** (500, `clamp(1.75rem, 3vw, 2.5rem)`, 1): Diagram nodes and major substructures.
- **Body** (400, `16px`, 1.55): Explanations with restrained measure.
- **Protocol Label** (400, approximately `0.62–0.72rem`): Endpoints, fields, states, indices, and folios.

**The Two-Voice Rule.** Display type argues; body and protocol type prove.

## Layout

Slides occupy at least one viewport and align content inside an `88rem` maximum rail. Edge padding uses `clamp(1.25rem, 4vw, 4.75rem)`. Desktop compositions use split fields, lane matrices, and ruled tables. At `900px`, complex grids collapse or become two-column. At `560px`, they become single-column; the widest agent sequence remains locally scrollable rather than shrinking below legibility.

A fixed top chrome provides identity, count, and navigation. A right-hand rail shows slide position on desktop. A two-pixel bottom line shows continuous progress. Print mode produces one landscape slide per page.

## Elevation & Depth

The system is flat. Depth comes from black-on-black tonal changes, border hierarchy, and overlap created by the fixed chrome. Shadows are absent; colored halos are prohibited.

**The Flat Signal Rule.** A state change alters line, fill, or text role—not elevation.

## Shapes

Circular stations and controls represent connection points. Technical panels use restrained 12px corners; data tables, lanes, and matrices remain square and ruled. Borders stay one pixel. Pills are limited to compact circular controls.

## Components

### Circular Icon Button
A 2.25rem outlined circle with an authored SVG arrow. Hover fills with gold and reverses to black; disabled state lowers opacity; keyboard focus uses a two-pixel gold ring.

### Presentation Chrome
A fixed 4.75rem top bar with translucent black ground and one hairline divider. It owns identity, slide count, and previous/next controls.

### Slide Rail and Progress Line
The rail uses short graphite rules that scale toward the right edge when active. The bottom progress line uses `transform: scaleX()` from the left so progress does not trigger layout.

### Code Panel
Raised black ground, 12px corners, one subtle border, warm ivory code, gold keys, green string values, and graphite comments.

### Technical Diagrams
Transport maps, state tracks, database tables, sequence matrices, and responsibility columns share hairline borders, condensed titles, and monospace metadata. A diagram must express ownership, direction, or state transition.

## Do's and Don'ts

### Do:
- **Do** give each slide one architectural claim and one proving diagram.
- **Do** reserve monospace for actual protocol, schema, timing, and state data.
- **Do** preserve content order across desktop and mobile.
- **Do** keep dense diagrams horizontally scrollable when collapsing would destroy meaning.
- **Do** use gold to expose direction, authority, or an invariant.

### Don't:
- **Don't** replace diagrams with decorative cards or generic icon grids.
- **Don't** use glow, gradient text, or shadows to imply technical importance.
- **Don't** shrink labels below readable sizes to force a desktop matrix onto mobile.
- **Don't** let motion become the only way to understand dataflow.
- **Don't** introduce additional accent hues without a new semantic state.
