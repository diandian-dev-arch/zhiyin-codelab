---
name: "知因 CodeLab · Glass Lab"
description: "夜色里的玻璃实验室；真实要求、执行证据与教师决定的工作台。"
colors:
  gl-bg: "#0d0c0b"
  gl-bg-2: "#16140f"
  gl-solid: "rgb(31 28 24)"
  gl-text: "rgb(237 232 224)"
  gl-muted: "rgb(158 150 139)"
  gl-c1: "rgb(205 165 120)"
  gl-c2: "rgb(146 178 142)"
  gl-c3: "rgb(234 214 188)"
  gl-c4: "rgb(212 144 126)"
  gl-c5: "rgb(130 172 178)"
  gl-on-c1: "#17120c"
  gl-danger: "rgb(222 128 112)"
  celadon-bg: "#0a0f0f"
  celadon-c1: "rgb(143 188 170)"
  celadon-c2: "rgb(210 182 128)"
  celadon-c3: "rgb(208 230 220)"
  celadon-c4: "rgb(214 150 130)"
  celadon-c5: "rgb(148 170 200)"
  ochre-bg: "#110e0c"
  ochre-c1: "rgb(210 142 106)"
  ochre-c2: "rgb(166 178 126)"
  ochre-c3: "rgb(240 212 190)"
  ochre-c4: "rgb(206 146 158)"
  ochre-c5: "rgb(128 172 164)"
  rose-bg: "#100e10"
  rose-c1: "rgb(206 158 164)"
  rose-c2: "rgb(156 182 158)"
  rose-c3: "rgb(238 218 216)"
  rose-c4: "rgb(216 186 140)"
  rose-c5: "rgb(150 172 192)"
typography:
  body:
    fontFamily: '"HarmonyOS Sans SC", "MiSans", "PingFang SC", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "14.5px"
    lineHeight: 1.7
    letterSpacing: "0"
  display:
    fontFamily: '"HarmonyOS Sans SC", "MiSans", "PingFang SC", "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif'
    fontSize: "76px"
    fontWeight: 900
    lineHeight: 1.14
    letterSpacing: "0"
  label:
    fontSize: "13px"
    fontWeight: 600
rounded:
  gl-r-xs: "6px"
  gl-r-sm: "10px"
  gl-r-md: "14px"
  gl-r-lg: "20px"
  gl-r-xl: "28px"
  gl-r-2xl: "40px"
  gl-r-pill: "999px"
spacing:
  gl-sp-1: "4px"
  gl-sp-2: "8px"
  gl-sp-3: "12px"
  gl-sp-4: "16px"
  gl-sp-5: "20px"
  gl-sp-6: "24px"
  gl-sp-8: "32px"
  gl-sp-10: "40px"
  gl-sp-12: "48px"
components:
  button-primary:
    backgroundColor: "{colors.gl-c1}"
    textColor: "{colors.gl-on-c1}"
    rounded: "{rounded.gl-r-pill}"
    padding: "0 20px"
    height: "44px"
  input:
    textColor: "{colors.gl-text}"
    rounded: "{rounded.gl-r-md}"
    padding: "10px 14px"
    height: "46px"
  glass-panel:
    rounded: "{rounded.gl-r-xl}"
    padding: "{spacing.gl-sp-6}"
---

# 2026-10-18 Glass Lab 深色玻璃视觉

Documentation review completed: **2026-10-19**. This is a source-extracted design record, not a claim that implementation acceptance, accessibility certification or live-model validation is complete. Current verification evidence and unresolved gates belong in [Glass Lab verification](../../docs/verification/2026-10-18/GLASS-LAB.md).

## Overview

**Creative North Star: "夜色里的玻璃实验室"**

Keep the real evidence desk and replace its retired paper skin with tinted dark grounds, restrained translucent glass and four muted semantic palettes. The approved [design handoff](../../design-proposals/2026-10-18-glass-lab/handoff/01-DESIGN_SPEC.md) is the visual authority; test contracts, product truth and accessibility take precedence over decorative reference details. Workspace screens remain task-first. Login and the public welcome page carry the liquid/core presentation.

This dated entry supersedes historical **visual** rules below: rice-paper backgrounds and grain, cinnabar as the only accent, serif workspace hierarchy, square corners, ink-inversion treatments, and the blanket prohibition on entrance effects are no longer the active visual system. Historical accessibility, native interaction, source-reader focus, data truth and business safeguards remain binding. Preserve the historical text and exports as archival evidence, not as current token values or adapters.

**Key Characteristics:**

- Four muted palettes with stable semantic roles and authenticated-role accents.
- Glass is a material treatment, never a substitute for readable text backing.
- Operative controls remain native, named, keyboard-visible and geometrically stable.
- Decorative WebGL is presentation-only; the workspace contains no WebGL scenes.

## Colors

The frontmatter records the default `bronze` palette and the actual alternate theme accent/background values. Runtime theme values, including each theme's text, surface and on-accent values, are authoritative in `src/styles/glass/tokens.css`; do not use the default snapshot to override another theme. `html[data-theme]` selects `bronze` (石墨·铜金), `celadon` (墨色·青瓷), `ochre` (炭灰·赭石) or `rose` (烟墨·灰玫). Required readable text contrast remains at least 4.5:1, and functional boundaries/non-text indicators at least 3:1, measured against their actual composited backing rather than an isolated nominal token.

### Primary

`--gl-c1` is the identity accent; `--gl-c3` is its pale highlight. `--gl-role-rgb` selects c1 by default and c2 under `body[data-role="student"]`. Use the role token for primary controls, active navigation and role-aware focus. A login appearance preview must not alter authentication fields, requests or server-derived account identity.

### Secondary

`--gl-c2` supplies success, publication and student signals. Its hue varies by palette: sage in bronze/rose, sand-gold in celadon and olive in ochre. Semantics follow the token, not a hard-coded green assumption.

### Tertiary

`--gl-c4` supplies attention/review/warning and referenced source highlights; `--gl-c5` supplies information/execution and cool counterpoints. Shared brick-red `--gl-danger` is reserved for errors and destructive actions. The illustrative five-stage chain is submission c1 → execution c5 → organization c2 → review c4 → resubmission c1; it must not invent business states.

### Neutral

Use themed dark ground, text, muted text and solid surface tokens. `--gl-faint` is only for placeholders or disabled presentation, never required readable copy. Decorative lines (`--gl-line`, `--gl-line-strong`) are not functional control borders; use `--gl-control-line` for those boundaries.

**The Semantic Color Rule.** Keep all four accent roles; avoid saturated neon, blue-purple AI gradients and unrelated rainbow gradients. Adjacent warm c3/c1/c4 and cool c2/c5 blends are the normal families; evidence-chain and brand-ring color sequences describe their specific motifs, not a general gradient license.

### Stable Token Bridge

Load `src/styles/glass/tokens.css` before `apps/web/tokens.css`. The latter preserves existing names rather than introducing a second palette: canvas → gl-bg, sidebar/spine → gl-bg-2, ink → gl-text, muted → gl-muted, control-line → gl-control-line, accent → role RGB, success/warning/danger → semantic Glass tokens. Body/display font names bridge to system sans; outlier bridges to mono. Existing rem spacing and text scales remain stable while radius and shadow names bridge to Glass values.

`--paper` now means a translucent strong surface, not white; `--accent-ink` is no longer the old dark-on-pale button text contract. Solid primary buttons use `--gl-on-c1`. Never copy the historical paper/primary export examples below into new runtime CSS. The production entry is `src/main-codelab.ts`; it loads old functional styles first and Glass base, motion, components and compatibility overrides afterward. Retain old selectors and directives consumed by existing pages/tests.

## Typography

System sans owns operative text and Chinese headings; no external font download. Serif italic is restricted to supporting presentation accents and selected numbers; mono identifies paths, evidence IDs and metadata. Use tabular numerals for comparable values. Current compatibility/login/welcome styles reset their operative headings and controls to zero letter spacing, overriding older negative-tracking reference utilities.

The body token is the frontmatter body role. The welcome display role is a desktop-specific extraction, not a global heading default: welcome CSS steps to 62px at 1280px, 56px at 980px, 43px at 640px and 36px at 360px. Login title is 32px, then 25px at 900px. Keep the completed-report component's smaller, scoped hierarchy and long-name disclosure; do not promote presentation typography into reading or task panels.

## Layout

- Workspace: a 248px sidebar beside `minmax(0, 1fr)`; at 760px and below the compatibility layer uses one column and fixed bottom glass navigation, with safe-area padding and 96px bottom content clearance. Keep the existing four-track navigation, source-reader container breakpoint and report reading order. At 320px, its labels use 13px to retain the complete accessible names.
- Login: `1.25fr / 1fr`, full dynamic viewport height; at 900px and below, one column with a 40vh scene above the form. Card width is `min(440px, calc(100% - 48px))`, with 36px/38px/28px padding; narrow width uses a 36px total gutter and 28px/24px/20px padding. Fields are at least 58px high; submit is at least 54px high.
- Welcome: navigation is at most 1180px wide; primary content is at most 1240px. Desktop hero uses `1.1fr / 1fr`; at 980px it stacks, and at 640px content has 18px side gutters. The implemented desktop hero has a 900px minimum / 1200px maximum with `100dvh`; the evidence-tree story uses a 420vh scroll region. These are observed page dimensions, not universal layout tokens.
- Shared Glass spacing uses the extracted four-pixel scale. Bridged legacy spacing remains in rem. Existing task filters, loaded-only scope labels, report tabs, evidence split/modal behavior and model-settings scrolling remain in their original contracts.

**The Stable Target Rule.** No workspace hover may translate a click target, change its padding/width or shift its label. Feedback uses color, border, surface and non-moving light. Preserve at least 44×44px interactive targets and no horizontal overflow at 320, 375, 390, 414, 768, 1280 and 1440px.

## Elevation & Depth

Glass combines a themed translucent surface, restrained 160° highlight, 1px decorative outline, inset top highlight and diffuse black shadow. Base/strong surface alpha is 0.52/0.78; the common material uses `blur(20px) saturate(150%)`. Workspace sidebar uses surface alpha 0.35 and 18px blur. The legacy compatibility layer gives ordinary panels the small shadow; canonical Glass panels use medium, while login/dialogs use large. Exact shadow tokens and durations are in the sidecar and runtime CSS.

Ambient color and subtle grain are decoration, not content. Calm workspace ambient is quieter than presentation ambient. Reduced transparency replaces glass with `--gl-solid` and disables backdrop blur; increased contrast strengthens boundaries/text, and forced-colors respects system colors. These are implementation rules, not evidence that every composited state passed an audit.

**The Opaque Evidence Rule.** Map root/module text must always have an opaque `--gl-solid` backing in rest and hover; selection mixes accent into that opaque base. Never substitute translucent `--paper` or an alpha accent over chart grid lines. Tables, code, menus and evidence panes also use solid backing where readability requires it.

Motion is slow, sparse and soft: Glass state tokens are 0.2s / 0.4s / 0.7s / 1.1s, with the shipped ease-out/spring/in-out curves. Workspace interaction stays calm and non-moving; reveal/state/progress/loading effects must not obstruct work. Under reduced motion, transitions must compute to exactly **`0s`**, including `details::details-content`; reveal text is visible immediately, loops stop, and liquid is a static frame. Do not replace zero with a tiny non-zero transition duration.

## Shapes

Use the actual Glass radius scale from frontmatter: inputs and native disclosure shells use medium; task items use large; shared panels/dialogs use extra-large; buttons and status capsules use pill. Login specifically uses 32px corners; this local value is not an added shared radius token. Existing task collection wrappers are unframed to avoid nesting repeated cards inside a decorative card.

## Components

### Buttons, Fields and Native Controls

Canonical Glass buttons have at least 44px height, 20px horizontal padding and pill ends; large buttons are 54px high. Primary uses role accent with on-accent dark text, ghost uses a low-alpha neutral surface, subtle stays quiet, and danger is semantically reserved. Canonical fields use 46px minimum height, medium corners and 10px/14px padding; legacy controls retain their 44px minimum and login overrides them to 58px. General controls use visible role-colored solid focus outlines; retain the report/map/source reader's stricter local inset, marker-clearance and focus-restoration contracts. Input focus must never compute to `outline-style: none`.

Retain native labelled inputs, forms, links, selects, checkboxes/radios, details/summary and dialogs. Preserve password visibility, pending/busy, disabled, error/retry, Escape and return-focus behavior. Icon-only controls require an accessible name; decorative icons are hidden from assistive technology. Do not rename Chinese labels, remove test IDs/classes or flatten disclosure DOM just to reproduce a prototype.

Search refinement (2026-10-19): all live search surfaces share the final
`styles/glass/search.css` layer: a 48px-high, 14px-corner surface with one control
border, an 18px leading icon and a reserved 44px clear-action track. Inputs are
transparent and borderless; the containing surface draws the immediate visible
role-colored keyboard outline. The transparent input outline does not replace
that visible parent outline. Source-tree search keeps its existing label and
keyboard/file-selection behavior. Shared list search restores input focus after
clearing. No expanding search, shifting text track, second input border or extra
search shadow. Coursework uses the same shared skin, not a local patch.

### Navigation, Panels and States

Workspace navigation keeps `aria-current="page"`, a 48px minimum row and a stationary role-tinted active surface with inset marker. Panels combine the glass material with their actual local padding/radius; task collections remain unframed and task cards are individually framed. Chips map completed→success, manual→role, preparing→info, interrupted→warning and infra_error→danger without changing those underlying statuses. `data-testid="agent-studio"` remains part of the existing contract.

Shared workspace finish (2026-10-19): sidebar width and desktop content offset share `--workspace-sidebar-width` (248px); at 760px and below the content offset clears for the existing mobile navigation. The sidebar scrolls vertically in short windows so account actions remain reachable. Pressed buttons give immediate brightness feedback without moving hover targets. Working routes use opacity only (160ms enter / 90ms leave), with exactly 0s transitions under reduced motion. Headings retain system sans and fixed size tiers: page titles 32px/28px and project-import titles 32px/24px across desktop/mobile. The model dialog keeps opaque header/footer backing over its scrolling fields, a 180ms entrance and no entrance animation under reduced motion. Both theme radio groups use one Tab stop, arrow-key selection and Home/End navigation, preserving local appearance persistence. These refinements do not change business rules, APIs or permissions. [Frontend finish evidence](../../docs/verification/2026-10-19/FRONTEND-FINISH.md) records the implementation and scoped review, not full-product or device certification.

Coursework board refinement (2026-10-19): the assignment collection is unframed,
with individually framed assignment rows and real loaded counts. Search, class
and publication-state filters operate only on the loaded list; draft visibility
still comes from the server. Creation uses unframed fieldsets for assignment
identity and the first task, two-column fields on desktop and one column on
phones. Keep native labels/selects, stable 44px actions, source-option checkboxes
and the existing draft/publish/student-preview paths. Nested preview/brief
sections are not styled as cards inside cards. Course pages reserve the actual
248px sidebar width until the existing 760px mobile breakpoint. Working section
headings are 18px, row titles 20px, page titles 32px/28px, all fixed-size system
sans. No task, submission, model, invitation or publication rule changes.
Verification: [Coursework board polish](../../docs/verification/2026-10-19/ASSIGNMENTS-POLISH.md).

### Presentation Scenes and Product Truth

Only login and public `/welcome` may mount liquid/core/particle scenes, tilt or magnetic presentation effects. Keep WebGL out of authenticated workspaces, reports and source readers. Scenes are decorative/aria-hidden, cannot gate form use, pause offscreen/hidden and release resources on unmount; lack of WebGL retains a CSS fallback, reduced motion retains one static frame. The login preview is appearance-only; the settings appearance selector stores a local theme preference, not a new account capability.

Login optical refinement (2026-10-19): the login alone opts into the `glass`
appearance of EvidenceCore. A larger shaded globe uses the existing warm c1/c4,
cool c5/c2 and pearl c3/text reflections, with clipped caustic ribbons and two
projected orbit tracks drawn behind/in front of its shell. The legacy radar stays
the default for welcome. Globe and optical tracks float together on a slow
16.5-second vertical / 33-second lateral cycle (10% / 3.5% of anchor radius),
without moving form controls or evidence labels. Login code particles are fewer and dimmer, with most
replaced by small light motes. Reduced motion keeps a static globe that still
repaints on theme/role/anchor changes. The shared WebGL water parameters, product
palette values, login behavior and workspace presentation are unchanged.
Verification: [Login orb refinement](../../docs/verification/2026-10-19/LOGIN-ORB.md).

Welcome examples must say they are illustrative. README-backed counts (eight independent cases, five core requirements, six restricted tools) are product-capability descriptions, not operational analytics or evidence of model quality. Workspace counts, rings, progress, costs, roles and publication states come from current API data. AI feedback remains a candidate: only the teacher publishes. This visual upgrade does not change APIs, authentication, authorization, model settings writes, review hashes, submission versions or publication/cancellation/comparison guards; the explicit public welcome route and local appearance preference are the scoped additions.

## Do's and Don'ts

### Do:

- **Do** preserve native controls, existing accessible names, classes, test IDs and source-reader focus/cancellation contracts.
- **Do** use themed semantic tokens, opaque evidence text backing and exact zero-second reduced-motion transitions.
- **Do** retain real-data boundaries, teacher publication authority and explicit illustrative labels.
- **Do** check painted/composited states, keyboard flow, hover geometry and narrow layouts separately from static token checks.

### Don't:

- **Don't** restore historical paper/cinnabar-only visual rules or treat the archived exports as current runtime adapters.
- **Don't** mount decorative WebGL or move hover targets in the workspace.
- **Don't** infer audit success, live model quality or production readiness from this documentation, a build or fixture tests.
- **Don't** change API, permission, model, source-reading or publication behavior to achieve a visual effect.

---

# Historical Design Record

The original text below is retained in full. Its visual directions and token/export snapshots are superseded by the dated Glass Lab entry above. Its accessibility, data-truth and business safeguards continue to apply unless an explicitly stricter current safeguard replaces them.

# 杏光 Studio · implementation direction

The user-provided `CodeLab-AppleDesign-杏光Studio.html` is the visual reference; the Vue application remains the real product. Audience: teachers reviewing project evidence and students acting on published feedback.

## Tokens and layout

- Canvas `#F2F2EF`, sidebar `#E8E9E4`, paper `#FFFFFF`, ink `#24272C`, apricot `#F3B58B`, action `#A54524` (white text). Muted text `#62656B`.
- System sans for headings and body; headings use restrained negative tracking. Monospace only for case identifiers, fingerprints and counts. Body and forms use rem; no external font dependency.
- Rounded solid surfaces, 24–32px main spacing, thin neutral dividers. Functional sticky toolbar may blur; content cards stay opaque.
- Overview: task-focused charcoal spotlight + real rule readiness count, searchable task list. Task: work summary, requirements disclosure, filterable submission records. Report: criterion navigation / evidence and facts / teacher feedback. Narrow screens reflow into the same reading order.

## Signature and critique

The signature is a visible chain from requirement to evidence to teacher decision. A progress ring represents real confirmation or rule readiness, never fabricated student metrics. The initial generic dashboard idea was replaced with a working evidence desk and contextual actions. Every displayed count comes from current API data. Keep the reference's apricot warmth without teal or metallic copper treatments.

## Interaction and safeguards

Native links, buttons, inputs and disclosures; visible keyboard focus, immediate pressed feedback, 160–200ms transitions with reduced-motion support. Search and filter are local and reversible. Preserve business version routing, review hashes, save/publish guards, unpublished report restrictions, authenticated evidence URLs, cancellation and comparison semantics. Evidence selection resets when the criterion changes, stale requests cannot replace a newer selection, object URLs are revoked.

## Component reference

Uiverse Galaxy snapshot `adbd2adde0a299a3956ea288fb444ec01891ca41`, MIT. Compared `Inputs/TimTrayler_orange-bat-25.html` and `Inputs/fanishah_fat-pig-29.html`. Adapt the former's icon/input grouping into a native labelled search component; omit Google/voice branding and incorrect combobox semantics. Reject expanding search because hidden input and moving hit targets reduce usability. No new runtime dependency. Attribution and license in `THIRD_PARTY_NOTICES.md`.

## Validation boundary

Build/typecheck, isolated teacher/student workflow regression, and desktop/mobile browser screenshots. Fixture tests establish UI/API contracts; they do not claim real submitted-project execution or model quality. Live workspace inspection is read-only apart from authentication.

## 2026-09-29 refinement

The four requested design skills inform a single product system: Apple-style hierarchy and native controls, Impeccable responsive and state handling, Frontend Design's deliberate composition, and Hallmark's restrained workbench structure. The existing apricot identity and system font are the authority. The design does not imitate a marketing landing page.

- `tokens.css` is the source of truth. Both entry points load the existing `src/style.css`, then tokens, then `src/styles/studio.css`. Existing global CSS remains intact for legacy routes.
- Login uses a dark introduction and a calm form; mobile keeps the brand and form. Account identity comes from the server. Password visibility, pending/error states and safe redirect remain functional.
- Tasks use a compact readiness overview and rows. Scope details expand on demand; pagination and loaded-only statistics remain explicit. Descendant routes retain the correct active navigation.
- Review places the page title, draft status, real confirmation progress and evidence/feedback before optional Agent analysis. Evidence and editable feedback share a desktop desk and stack in reading order on narrow screens. Draft recovery and publication restrictions remain visible.
- Projects use adjacent analysis options and a ZIP drop area on desktop, then a single mobile column. Report sections, coverage, event history, citations and analysis limits have separate roles.
- Account and model settings use labelled native controls, a scrollable modal, explicit billing information, Escape dismissal and return focus. No cosmetic role selector or invented analytics.
- Primary controls use a 44px minimum height. Focus uses a 2–3px action-colored outline. Reduced-motion removes animation and transitions. Muted copy retains at least 4.5:1 contrast against the canvas; control borders use `#858A84`, above 3:1 against both white and canvas.

Progress conic/radial gradients encode a real count. They are the sole purposeful exception to the flat surface direction. Multi-line criterion and source buttons remain where their labels require context. System sans and repeated workbench navigation are intentional product-consistency choices.

Verification and screenshot index: [Frontend design acceptance](../../docs/engineering/FRONTEND-DESIGN-ACCEPTANCE.md). The original frozen delivery archive is not rebuilt by this UI change.

## 2026-09-30 task and disclosure refinement

Practical tasks are the primary course entry. Use real pending work and direct filter buttons; distinguish feedback for the current submission from historical feedback. Open project tasks connect requirements, submission, shared AI reading, peer review and selected work without inventing teaching-round states.

`StudioSelect.vue` preserves native selection and form semantics, with a styled browser picker where `appearance: base-select` is supported and a native fallback elsewhere. Shared disclosures use a clear title row, consistent chevron and separated content. Keep 44px primary targets, keyboard focus, reduced motion and long-text wrapping. Model settings keep their heading and close action visible while scrolling.

Project reports prioritize purpose, business paths, the most relevant finding and the next reading action. Details, history and costs remain accessible without dominating the reading surface. Remove the placeholder prefix only from the two exact seed account names; real names and permissions remain intact.

Current results and screenshot index: [Workspace experience upgrade](../../docs/verification/2026-09-30/WORKSPACE-EXPERIENCE-UPGRADE.md). Future review assignment, feedback responses and reusable case learning remain in the linked product plan.

## 2026-10-04 Mist Harbor manuscript

Direction: a harbour pilot's manuscript. AI project analysis is the hero surface; every other page borrows its vocabulary but stays quieter.

- Layer order: `style.css` → `tokens.css` → `studio.css` → `motion.css` → `styles/manuscript.css`. Utilities live in `manuscript.css` (`ms-cap`, `ms-ul`, `ms-flag`, `ms-dot`, `ms-draw`, `ms-wordmark`, `.rv/.in` via `v-reveal`). Token names are unchanged.
- Structure: cards lose their boxes. Sections open with a 1.5px ink rule, corners are square, numbers (`01`, `02` …) are large `--font-display` serifs in `--ink-line` that turn rust on hover or selection. Labels and metadata use `--font-outlier` with wide tracking.
- Rust (`--accent`) marks only "you are here": the selected tab underline, the active trace step, the chosen map node, the primary action. Ink inversions (`--ink` background) are reserved for the Agent masthead, the login cover and the first step of a reading route.
- AI analysis: `ProjectChart.vue` draws a decorative harbour route (aria-hidden) whose stations are the reading stages or the report's real module titles. `SourceProjectMap` uses a graticule canvas with offset ink shadows; `SourceProjectReport` uses drawn tab underlines and staggered panel entry; `AgentStudio` shows real metrics as serif numerals and the operation trace as a numbered, ink-drawn route.
- Motion: entry `studio-rise` with ≤.3s stagger, underline `studio-draw`, route `studio-ink`. Hover lifts are 1–2px with an offset ink shadow. Everything is disabled under `prefers-reduced-motion`, and SMIL animations in `ProjectChart` are not rendered at all in that mode.
- Safeguards: 44px targets, `2px dashed var(--accent)` focus, secondary text on ink uses `#B9C1BD`, every number comes from the API. No business logic changed.

### Refinement pass (same day)

The brutalist edges were sanded down so the page reads like ink on paper, not cut card stock. This supersedes the 1.5px rule and offset-shadow notes above.

- Rules are 1px `--ink`; dividers between entries are solid `1px var(--line)` hairlines (no dashes). Dashed lines are reserved for focus rings, pending route steps and disabled actions.
- No offset or solid shadows. Hover feedback on filled buttons is an ink wash: a `::before` layer at `scale: 0 1` from the left, growing to `1 1` over 560ms `--ease-emphasis` (`studio-start`, `studio-adopt`, `btn-login`, `reading-state-primary`). The login card keeps one soft drop shadow.
- `.ms-log`: a logbook strip in `--font-outlier` above page headers, built only from real data (date, project id, file and line counts, analysis count). On ≤760px the middle item is hidden.
- `.ms-diamond`: ◇ rust bullets for principle notes and boundaries.
- Page caps sit in the margin: a 2rem rust serif numeral over a column of labels, separated by a hairline; ≤1100px they fold back into one row.
- The project-map root is a cartouche: 1px ink border plus a `--line` outline at 3px offset that widens to 6px on hover; the chosen state tints the outline rust.
- Report entries shift their summary 0.75rem right on hover, like turning a page; the open entry darkens its bottom rule to `--ink-line`.
- The primary "开始项目分析" action is the only ink-filled button in the reading state; secondary actions stay as text links. Disabled import actions become dashed outlines in `--muted`.

### Palette v2 · 宣纸 · 松烟墨 · 朱砂 · 黛青 · 泥金 (same day)

The first palette copied the reference's cool grey paper and a blue-grey grain multiplied at 34%, which made every surface look dusty. v2 keeps the token names and moves the values:

- Paper `--canvas #F3EEE4`, `--paper #FAF7F0`, `--surface #EAE3D6`: warm rice paper. The grain is now sepia at 22% so it reads as paper fibre, not dust.
- Ink `--ink #1A2327` (13.8:1), `--muted #4B524F` (6.9:1). Cinnabar `--accent #A6402A` (5.4:1) is still the only "you are here" colour.
- 黛青 `--sea #2E4954` for secondary signals and chart contours; 泥金 `--gold #A88350` / `--apricot #C4A06A` for hairline ornament only, never text on paper.
- The sidebar is an ink spine (`--spine #172024`). It re-scopes `--ink / --muted / --line / --accent / --paper` locally, so the shell rules invert without being rewritten. On ink, accent becomes `--accent-on-ink #D9805F` (5.7:1), ornament `--gold-on-ink #C9A46B`, secondary text `--on-ink-muted #C2BBAE` (8.7:1).
- On ink surfaces (sidebar, login cover, training link, Agent masthead), numerals, icons, outlined wordmarks and dividers use gold; rust stays reserved for the current item and the primary flag.

## Project Reading V2 (2026-10-17)

Completed reports are continuous reading surfaces, not analysis dashboards. Preserve the existing paper, ink and cinnabar tokens. Use a compact project identity, one Analysis Details entry, and More > Reinterpret. Details has four ordered groups: scope, model/cost, process, history. Analysis setup mounts only after an explicit action and retains edits while hidden; viewing or closing it must not launch analysis.

Keep the three report tabs. Put purpose, business scene and the first reading entry ahead of stack, maps and diagnostics. Legacy text stays intact; do not synthesize summaries by truncation or filename rules. Names longer than 48 characters have a two-line presentation with an explicit full-name disclosure; never rewrite the stored name. Completed titles use 1.75rem (1.5rem narrow), body 1rem, overview headings 1.125rem, zero letter spacing. Only the completed project route reduces the main top inset.

SourceEvidenceReader owns selection, request cancellation and responsive evidence presentation for both personal and course reports. Split only when its actual container is at least 1040px; otherwise use a modal dialog. Keep the current judgment, source/report identity, absolute line numbers and within-judgment navigation. Fetch citation context on demand, full source only after explicit choice. Close/identity changes must invalidate pending responses; return focus without scrolling the explanation during source loading. Preserve the range and selected source on responsive transitions.

Keyboard citation navigation must not drop focus when the invoked arrow becomes disabled at the first or last citation: move focus to the enabled opposite arrow. Full-file/snippet reloads replace their toolbar button, so restore its keyboard focus after the current request settles (or focus its retry on failure) only if focus is still on the document or pane fallback. Do not steal focus from a control the user selected while loading, or restore after a superseding request or close.

`readingBrief` and finding guidance are optional shared contracts. Render only validated sources; preserve legacy overview/nextStep labels and do not infer semantic truth from schema validity. `SOURCE_READING_BRIEF=1` opts new generation in, default off; `VITE_READING_BRIEF=0` independently hides enhancements after a rebuild. Never recompute stored reports. Structured evidence flows show business summary first; implementation steps and branching relationships are an explicit disclosure, with inferred labels and gaps retained.

Implementation and automated verification are recorded in `docs/product/AI项目解读_V2实施与验收记录.md`. Automated fixtures do not establish live historical-report acceptance, full composite contrast, real-model content quality, human usability or production readiness. Those remain separate release gates.

Map module numbers use opaque text tokens, not translucent rule tokens. Keep root and module hover surfaces opaque (`--paper`, or `--accent-soft` for selected modules) so the global translucent button hover cannot put text directly over chart grid lines. Named scrollable explanations use an explicit group role. The dedicated map-hover regression covers root and module normal, hover and selected states at four widths; the live scroll audit has a separate, explicitly bounded coverage record.

Report summaries and module nodes must not move their click targets or labels on hover. Use 180ms color, surface or border feedback, not padding/width changes or node translation. Test both normal and reduced motion, including transient geometry during hover; wait for native disclosure layout/scroll adjustment before starting the hover observation. Isolated negative controls must detect the removed padding and translation behavior, not silently pass it.

In the report reader, reduced motion also disables `details::details-content` transitions explicitly; disabling element, before and after transitions does not cover this native pseudo element. On narrow screens, use three stable tab tracks and 14px labels, retaining an attached finding count and at least 44px targets. A 320px viewport must not split a tab label into individual characters or detach its count. These rules stay scoped to the report, not the global workspace.

Keep selection markers and keyboard focus distinct from adjacent rules: report tab markers sit 2px above the baseline with a 3px stroke; focused tabs have an opaque paper clearance under their outer ring. Map-root keyboard focus uses an immediate 2px dashed outline at -5px, with enough local selector specificity to override the parent reader rule and no outline transition through graph connectors. Locate-source and tree-clear focus stay inset; the selected file marker starts 6px inside the row, clear of its focus border. Sticky desktop evidence starts below the workspace banner, not behind it. Non-text audits must inspect actual painted pixels and reject pseudo markers painted outside their target bounds; passing the recorded subset is not certification of every control or full accessibility.

## 2026-10-18 Workspace polish

This scoped refinement supersedes the older serif/mono UI-label, square-corner and staggered workspace-entry guidance above. Preserve the current palette in `tokens.css`: canvas `#F6F2EA`, paper `#FCFAF5`, ink `#15201F`, spine `#111B1E` and cinnabar `#A8352A`.

- Operative headings, navigation and task metadata use the existing system sans stack with normal tracking. Page display size is 2rem; completed report sizing remains component-owned. Serif brand lettering and report-specific diagrams remain intact.
- Solid paper controls use control-border tokens, 6px input corners and 8px shared surface corners. Task collections use a quiet frame; repeated task rows remain separated by dividers. Paper texture opacity is 0.055, not the historical 22%.
- Task descriptions use 14px text with a 75ch maximum measure. Mobile task metadata is 14px. Four mobile navigation tracks allow balanced wrapping and retain at least 44px touch targets, including 320px screens.
- Workspace/task content is immediately visible. Remove routine staggered entrances and rotating navigation/task icons; keep meaningful loading and state feedback. Reduced motion explicitly includes native disclosure content.
- Course notices and errors use complete 1px semantic borders rather than thick side bars. No API, permissions, routes, model settings or publication behavior changed.

Browser checks and screenshots: [Workspace polish verification](../../docs/verification/2026-10-18/FRONTEND-POLISH.md).

## Exports

These are portable mappings for future consumers, not additional runtime dependencies. This Vue project uses only the CSS source. Preserve its existing token names when extending it; `--accent-ink` means dark text on a pale accent, while text on a solid primary button is `--paper`.

### CSS source

```css
/* Source: apps/web/tokens.css; loaded before studio.css. */
@import "./tokens.css";
.primary-action { color: var(--paper); background: var(--accent); }
.workspace-surface { background: var(--canvas); color: var(--ink); }
```

### Tailwind v4 adapter

```css
@theme inline {
  --color-canvas: var(--canvas);
  --color-sidebar: var(--sidebar);
  --color-paper: var(--paper);
  --color-surface: var(--surface);
  --color-ink: var(--ink);
  --color-muted: var(--muted);
  --color-rule: var(--line);
  --color-control: var(--control-line);
  --color-accent: var(--accent);
  --color-focus: var(--accent);
  --font-sans: var(--font-body);
  --font-mono: var(--font-outlier);
  --spacing-xs: var(--space-xs);
  --spacing-sm: var(--space-sm);
  --spacing-md: var(--space-md);
  --spacing-lg: var(--space-lg);
  --radius-card: var(--radius);
  --shadow-card: var(--shadow);
}
```

### DTCG core color export

```json
{
  "color": {
    "$type": "color",
    "canvas": {"$value": {"colorSpace": "oklch", "components": [0.96032, 0.00398, 106.47]}},
    "paper": {"$value": {"colorSpace": "oklch", "components": [1, 0, 89.88]}},
    "ink": {"$value": {"colorSpace": "oklch", "components": [0.27177, 0.01024, 260.70]}},
    "muted": {"$value": {"colorSpace": "oklch", "components": [0.50616, 0.01018, 264.48]}},
    "action": {"$value": {"colorSpace": "oklch", "components": [0.51270, 0.13530, 38.75]}},
    "control": {"$value": {"colorSpace": "oklch", "components": [0.62741, 0.01060, 140.51]}}
  }
}
```

### Focused task and settings pass (2026-10-18)

- On phones up to 640px, task overview actions share three compact columns. Counts, loaded-data scope and accessible action labels remain intact; suppress decorative icons and visually hide the repeated action captions. Refresh is a quiet 44px icon button with an accessible name and tooltip.
- Preserve task search, both filter groups and the loaded-only statistics warning. Hide only the repeated course introduction and learning-flow strip on phones, and tighten local spacing so the first task title enters the 390px viewport.
- Settings use two separated, compact sections instead of equal large panels. Account fields and model facts form labelled columns on desktop and label/value rows on phones. The model settings action stays alongside its section heading.
- Model status, provider and model name come from the existing `/model-settings` read endpoint and shared vendor labels. Configured does not imply tested connectivity. Loading, failed read with retry, disabled service, unconfigured and active analysis remain distinct; never show key text. Refresh the summary after the dialog's existing changed event; abort abandoned/superseded reads and ignore their responses.
- No report reader, route, permissions, model-write endpoint or configuration-dialog behavior changed in this focused pass. Test and live-check scope is appended to the existing frontend polish verification record.

### shadcn/ui target mapping

For a separate shadcn consumer, map these names to the values in `tokens.css`. This table avoids collisions with this project's existing `--sidebar`, `--muted`, and `--accent` names.

| shadcn variable | CodeLab source |
| --- | --- |
| `--background`, `--foreground` | `--canvas`, `--ink` |
| `--card`, `--card-foreground` | `--paper`, `--ink` |
| `--popover`, `--popover-foreground` | `--paper`, `--ink` |
| `--primary`, `--primary-foreground` | `--accent`, `--paper` |
| `--secondary`, `--secondary-foreground` | `--surface`, `--ink` |
| `--muted`, `--muted-foreground` | `--surface`, `--muted` |
| `--accent`, `--accent-foreground` | `--accent-soft`, `--accent-ink` |
| `--destructive`, `--destructive-foreground` | `--danger`, `--paper` |
| `--border`, `--input`, `--ring` | `--line`, `--control-line`, `--accent` |
| `--radius` | `--radius-input` |
