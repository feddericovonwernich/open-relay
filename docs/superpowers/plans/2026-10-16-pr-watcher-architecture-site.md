# PR Watcher Architecture Site Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or coordinated parallel agents to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build three complete static explanations of the deterministic PR watcher architecture and expose them through one local-file-compatible layout switcher.

**Architecture:** A small shell at `docs/architecture/pr-watcher/site/index.html` owns layout selection through URL hashes and a single iframe. Three independent layout documents consume the same architecture facts and existing standalone Archify diagrams without copying diagram code. Separate files keep parallel implementation conflict-free.

**Tech Stack:** Semantic HTML, CSS, minimal classic browser JavaScript, Node.js built-in test runner, existing standalone Archify HTML.

**Spec:** `docs/superpowers/specs/2026-09-17-deterministic-pr-watcher-design.md`

## Global Constraints

- The site MUST open through `file://` without a server, build step, framework, package, or runtime dependency.
- Implement all three approved structures: Narrative Dossier, Guided Signal Desk, and Layered System Lens.
- `site/index.html` MUST switch among all layouts, preserve selection in the URL hash, support back/forward navigation, and default to Guided Signal Desk.
- Reuse the 11 existing Archify HTML files by relative path; NEVER duplicate their generated HTML or JSON.
- Every layout MUST provide access to all 11 diagrams and explain purpose, evidence acquisition, deterministic decisions, settlement, delivery, replay, failure isolation, and the future aggregation seam.
- Preserve the Signal Desk system from `DESIGN.md`: `#080807`, `#11110f`, `#f4f0e6`, `#aaa499`, `#6e6a63`, `#d8b86a`, `#f0d68f`, `#8ad4ad`, and `#e17b62`; Alumni Sans display, Albert Sans body, monospace only for protocol data.
- No decorative cards, glow, gradient text, generic icon tiles, shadows, or additional accent hues.
- Gold MUST encode active state, direction, contracts, or invariants rather than decoration.
- All controls MUST be keyboard accessible with visible focus. Content order MUST remain intact on mobile. Motion MUST respect `prefers-reduced-motion`.
- Diagram iframes MUST have descriptive titles and lazy loading where they are not initially visible.
- The first child of each layout body MUST be its Impeccable direction-contract HTML comment.
- Layout implementers MUST edit only their assigned HTML/CSS files and MUST NOT run tests, builds, linters, or formatters; the integration owner performs verification once after the parallel wave.

---

### Task 1: Shared shell contract and smoke test

**Files:**
- Create: `tests/pr-watcher-site.test.ts`
- Create: `docs/architecture/pr-watcher/site/site.js`
- Create: `docs/architecture/pr-watcher/site/shared.css`
- Create: `docs/architecture/pr-watcher/site/index.html`
- Create: `docs/architecture/pr-watcher/site/content.js`

**Interfaces:**
- Produces: `globalThis.PRWatcherArchitectureSite.resolveLayout(hash)` and `mountSwitcher(document, window)` from `site.js`.
- Produces: `globalThis.PR_WATCHER_CONTENT` with immutable `diagrams` and `chapters` arrays from `content.js`.
- Produces: shared CSS tokens and primitive classes consumed by every layout.
- Consumes: existing Archify HTML paths one directory above `site/`.

- [ ] **Step 1: Write the failing behavior test**

Create `tests/pr-watcher-site.test.ts` that imports `site.js`, asserts valid layout hashes resolve to the three exact HTML filenames, asserts empty and unknown hashes resolve to `guided-signal-desk.html`, and asserts `mountSwitcher` selects the requested iframe source and current tab using a minimal real fake DOM.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test tests/pr-watcher-site.test.ts`

Expected: failure because `site.js` does not exist.

- [ ] **Step 3: Implement the minimum shell behavior**

`site.js` uses one frozen layout map:

```js
const layouts = Object.freeze({
  "narrative-dossier": "narrative-dossier.html",
  "guided-signal-desk": "guided-signal-desk.html",
  "layered-system-lens": "layered-system-lens.html"
});
```

`resolveLayout(hash)` strips one leading `#`, returns the matching file, and otherwise returns `guided-signal-desk.html`. `mountSwitcher` updates the iframe, `aria-current`, current-layout label, document title, and responds to `hashchange` without writing storage.

- [ ] **Step 4: Author shared facts and shell presentation**

`content.js` contains the 11 diagram records in README reading order plus the approved architectural facts from the design spec. `shared.css` owns only durable tokens, resets, typography, focus, controls, iframe treatment, and reduced-motion behavior. `index.html` exposes three native hash links and a full remaining-viewport iframe.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run: `node --test tests/pr-watcher-site.test.ts`

Expected: all focused tests pass.

### Task 2: Narrative Dossier layout

**Files:**
- Create: `docs/architecture/pr-watcher/site/narrative-dossier.html`
- Create: `docs/architecture/pr-watcher/site/narrative-dossier.css`

**Interfaces:**
- Consumes: `shared.css`, `content.js`, and diagram paths `../<diagram>.html`.
- Produces: a direct-linkable static document with `data-layout="narrative-dossier"` on `<body>`.

- [ ] **Step 1: Build the dossier structure**

Create a persistent chapter rail and one continuous main document. The opening thesis pairs concise purpose/non-goals with `runtime.architecture.html`. Following chapters pair architecture claims with their proving diagrams. Each chapter ends in one ruled “Review invariant” line, not a card.

- [ ] **Step 2: Cover the complete story**

Explain setup, evidence, deterministic actions, continuous success/action-required paths, one-shot/replay, notification delivery, same-head evidence changes, failure isolation, and future aggregation. Make all 11 diagrams reachable inline or through the closing ruled index.

- [ ] **Step 3: Implement responsive reading behavior**

Keep prose at 65–75ch, make the rail sticky on wide screens, move it into normal flow below 900px, and preserve diagram legibility through bounded iframe height plus open-in-viewer links.

### Task 3: Guided Signal Desk layout

**Files:**
- Create: `docs/architecture/pr-watcher/site/guided-signal-desk.html`
- Create: `docs/architecture/pr-watcher/site/guided-signal-desk.css`

**Interfaces:**
- Consumes: `shared.css`, `content.js`, and diagram paths `../<diagram>.html`.
- Produces: a direct-linkable static document with `data-layout="guided-signal-desk"` on `<body>`.

- [ ] **Step 1: Build the review station**

Place a chapter key rail on the left, a plain-language briefing and reviewer prompts in the center, and one large diagram theater on the right. Use native anchor links and named sections so no JavaScript is required for comprehension.

- [ ] **Step 2: Guide the complete review**

Create grouped sections for system boundary, evidence, decisions, settlement, delivery, resilience, and extension seam. Each section names the question reviewers should challenge and links every applicable Archify viewer. All 11 diagrams remain reachable.

- [ ] **Step 3: Implement responsive reading behavior**

At narrow widths, stack briefing before diagram, keep chapter keys horizontally scrollable, and expose every diagram link without hover. Use one restrained active-signal transition and disable it for reduced motion.

### Task 4: Layered System Lens layout

**Files:**
- Create: `docs/architecture/pr-watcher/site/layered-system-lens.html`
- Create: `docs/architecture/pr-watcher/site/layered-system-lens.css`

**Interfaces:**
- Consumes: `shared.css`, `content.js`, and diagram paths `../<diagram>.html`.
- Produces: a direct-linkable static document with `data-layout="layered-system-lens"` on `<body>`.

- [ ] **Step 1: Build the map-first opening**

Give `runtime.architecture.html` most of the first viewport. Follow it with native anchor lens controls for evidence, decisions, settlement, delivery, resilience, and future aggregation.

- [ ] **Step 2: Build the lens ledger and atlas**

Each lens states owned inputs, invariant, emitted result, and failure boundary. End with a ruled sequence atlas that reaches all 10 sequence diagrams and preserves README order.

- [ ] **Step 3: Implement responsive reading behavior**

Collapse lens columns without changing order, keep the runtime map usable at phone widths, and retain visible labels and open-in-viewer links.

### Task 5: Integration, documentation, and verification

**Files:**
- Modify: `docs/architecture/pr-watcher/README.md`
- Verify: `tests/pr-watcher-site.test.ts`
- Verify: all files under `docs/architecture/pr-watcher/site/`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: one linked architecture site and browser evidence for desktop and mobile.

- [ ] **Step 1: Integrate and review the parallel files**

Confirm no implementer touched another layout, every relative URL resolves, all body contracts remain first, and shared tokens are used rather than redefined incompatibly.

- [ ] **Step 2: Link the site from the diagram README**

Add the architecture site as the primary guided explanation while retaining the direct diagram table.

- [ ] **Step 3: Run focused and repository checks**

Run:

```bash
node --test tests/pr-watcher-site.test.ts
npm run typecheck
```

Run `npm test` and report the known baseline E2E failure separately if it remains.

- [ ] **Step 4: Exercise the real surface**

Open `site/index.html` in Chromium, switch all three layouts, use back/forward, follow at least one diagram link per layout, and capture desktop and mobile screenshots for each layout. Confirm no overflow, clipped controls, inaccessible focus, console errors, or broken local-file URLs.

- [ ] **Step 5: Run the Impeccable detector and finish review**

Run the detector once over changed HTML/CSS/JS, resolve mechanical findings, then dispatch a fresh finish reviewer with the original request, desktop/mobile captures, direction contracts, and craft-floor path.
