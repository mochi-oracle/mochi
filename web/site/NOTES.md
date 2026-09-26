# W12 implementation notes

## Files added or changed

| File | Change |
|---|---|
| `tailwind.config.js` | Added Tailwind 3.4.3 tokens and page/source content globs. |
| `postcss.config.js` | Added Tailwind and Autoprefixer processing. |
| `src/site.js` | Vite module entry for the generated site stylesheet and motion modules. |
| `src/styles/site.css` | Added self-hosted font face, Tailwind layers, handwritten page components, frame, loader, menu, popup, carousel and portfolio rules. |
| `src/motion/index.js` | Added GSAP, ScrollTrigger, Observer, Lenis and Swiper behavior for existing page hooks. |
| Seven route HTML files | Removed direct source-asset links, loaded `/src/site.js`, and updated the loader SVG text family. Dashboard React entry is unchanged. |
| `public/enhancements.js` | Removed the menu state check that depended on the removed animation runtime. Keyboard support, logo ink switching and reduced motion remain. |
| `package.json`, `bun.lock` | Pinned exact dependencies and switched the package lock to Bun. |
| `THIRD-PARTY-NOTICES.md` | Replaced prior source notices with the current dependency licenses. |
| `../START-HERE.md`, `../BUILD-MAP.md`, `../VERIFICATION.md` | Updated install/build instructions and recorded the W12 source replacement and verification limits. |
| `../MANIFEST.json` | Removed stale inventory entries for the deleted public assets. |
| `public/assets/css/main.0954346d5b41f3d6c200.css` | Removed. |
| `public/assets/js/main.491db88fa054a7534721.js` and its license sidecar | Removed. |
| `public/assets/fonts/0633708bbd75ec2db7d7.woff2`, `3dd1e4632f5a0f3b5ebd.woff2` | Removed. |
| `pnpm-lock.yaml`, `pnpm-workspace.yaml` | Removed after producing `bun.lock`. |

## Font choice and measured metrics

The site uses Hanken Grotesk Variable from `@fontsource-variable/hanken-grotesk` 5.2.6, licensed under OFL 1.1. The variable font supplies weights 100 through 900, including the site's 400 and 500 weights. It is a close match in x-height, cap height and sample-text width.

| Measurement | Original regular / medium | Hanken Grotesk variable default |
|---|---:|---:|
| Units per em | 2048 | 1000 |
| x-height / em | 0.4912 / 0.4932 | 0.4930 |
| cap height / em | 0.6938 / 0.6938 | 0.6970 |
| Mean advance / em for the measured specimen | 0.5270 | 0.5113 |

The specimen included a representative MOCHI paragraph and uppercase, lowercase and digit glyphs. The font face uses `size-adjust: 103.1%`, `ascent-override: 77.56%`, `descent-override: 19.42%` and `line-gap-override: 0%`. The adjusted mean advance is approximately 0.527 em. Metric source files were inspected with Fontkit 2.0.4 during selection; Fontkit was removed from the project dependencies after measurement.

## Motion behavior mapping

| Existing bundle behavior | Replacement module or function | Parameters and treatment |
|---|---|---|
| Nested preloader frame, M/O initials, mark, page reveal | `completeLoader()` | Frame entrances use 1.2 s; layers stagger by 0.1 s; outgoing layers use 1.05 s; overlay reveal and exit use 0.9 s. Existing pink/lavender/orange layer offsets and initials remain in HTML/CSS. Reduced motion completes immediately. |
| Heading and text line reveals | `splitWords()`, `wordsInVisualLines()`, `revealFromData()` | Words are grouped by rendered line. Entrance moves from 105% down with opacity 0 to rest over 0.9 s, stagger 0.035 s. Per-element `data-delay` is preserved. Scroll reveals trigger at 88% viewport height and play once unless `data-repeat` is set. |
| Fade and move-up reveals | `revealFromData()` | Fade starts 24 px lower; move-up starts 35% lower. Both default to 1.2 s and the existing `data-duration` overrides that value. |
| Clip, scale, scale-down and rule drawing | `revealFromData()` | Uses the existing `data-from`, `data-to`, `data-delay` and `data-duration` values. Default duration is 1.2 s with `power3.inOut`; scale-right grows from the left edge and scale-down from the top. |
| Smooth scroll and scroll-linked sections | `bootSmoothScroll()` | Lenis uses the existing `[data-scroll-wrapper]` and `[data-scroller]`, `lerp: 0.1`; GSAP ticker runs Lenis and ScrollTrigger refreshes on load. |
| Terrain and content parallax | `revealFromData()` | Existing `data-start`, `data-end`, and `data-scroll-speed` are read as ScrollTrigger ranges and scrubbed. Travel is derived from `(1 - speed) * 24 px`. |
| Hero ambient terrain drift | `setupAmbient()` and ambient branch in `revealFromData()` | Pointer position shifts the three existing layers by up to 24 px horizontally and 15 px vertically with a 0.7 s ease. |
| Portfolio row and image hover | `setupPortfolioHover()` and `.portfolio-row__image` styles | Activates the matching image with the existing full-frame clip; CSS transition is 0.3 s with 0.15 s delay. Row identity follows `data-portfolio-work`. |
| Portfolio load more | `setupLoadMore()` | Reveals the four rows already marked hidden with a 50 px rise, `power3.out` and 0.1 s stagger, then removes the control. |
| Principles image and content carousel | `setupCarousels()` | Image Swiper uses one vertically moving creative-effect slide, touch disabled, previous layer at -10% and next layer at +100%. Content Swiper uses a 1.2 s fade, disabled touch, linked image control, existing previous/next navigation, and counter hooks. Text exits over 0.35 s with 0.05 s stagger; incoming text begins after 0.4 s and enters over 0.85 s with the same stagger. Swiper styles come from the package. |
| Menu open, close and staggered links | `setupMenu()` and `[data-menu]` styles | Menu clip opens over 0.9 s. Link reveal uses 1.2 s, 0.25 s delay and 0.1 s stagger. Escape, focus return, inert state and reduced-motion behavior are included. |
| Floating logo ink switching | `updateLogoInk()` in `public/enhancements.js` | Existing behavior is retained: pink ink over white content, white ink over colored content, and white ink while the menu is open. |
| Testimonial popups | `setupPopups()` and popup styles | Panel enters over 1.3 s; overlay opacity transitions over 1.2 s. Existing toggle and close hooks are wired. |
| Accordions | `setupAccordions()` | Existing hooks toggle `is-active`; content height animates over 0.65 s. No current route contains accordion hooks. |
| Reduced-motion preference | `setupReveals()` and `public/mochi.css` | Skips entrance and scroll motion, loads images immediately, and makes animated content visible. |

GSAP 3.13.0 uses the Standard “no charge” license. The package declares it in `node_modules/gsap/package.json` and points to `https://gsap.com/standard-license`; the installed npm package does not contain a standalone license-text file. Hanken Grotesk's OFL text is at `node_modules/@fontsource-variable/hanken-grotesk/LICENSE`.

## Known visual and motion differences

- Hanken Grotesk is a different typeface. Metric overrides match specimen width and font box closely, but individual glyph shapes and some line breaks can differ.
- Split reveals animate words grouped by measured visual line. They may not match the former line-splitting renderer on every nested inline element.
- The original parallax distance calculation and smooth-scroll tuning were reconstructed from the page hooks and bundle behavior. The replacement uses a documented 24 px travel scale and Lenis `lerp: 0.1`; these can differ at intermediate scroll positions.
- The loader uses the same frame colors, offsets, initials and stagger cadence, but its layer travel and page-overlay timing are newly authored. Entrance frames are not claimed to be pixel identical.
- Browser-based computed-style comparison and screenshot review were unavailable in this workspace. Build output confirms asset and module wiring, not pixel equivalence at the requested viewport sizes.

## Round 2: measured corrections

Used `.agents/runs/w12-measure/*.json` and `w12-diff-round1.md` as the source for the corrections below. The paired captures establish the original 1440px frame bars at 50px lavender / 25px orange, 390px bars at 24px / 12px, 20px desktop content gutters, 146px desktop hero type with 131.4px line-height, and 1px hero rules. Values were taken from the brief or measured boxes/styles rather than visually estimated.

| Measured cause | Correction |
|---|---|
| Mobile root sizing was 16px, scaling every rem utility and authored spacing by 1.6×. | Restored `html { font-size: 10px; }` and the exact desktop `0.6944444444444444vw` rule. This also restores the measured rem-based mobile type, padding and frame coordinates. |
| The desktop lavender/orange pseudo-bars were 24px/12px, and the floating white mark was hidden after load. | Kept the existing third-layer inset in the page HTML, changed desktop frame bars to 2.5rem × layer multiplier (50px/25px), retained 1.2rem mobile bars (24px/12px), restored a 5rem desktop overlay mark window, and removed the completion rule that hid the pink-backed mascot. The existing M/O layer initials remain. |
| Inner routes kept the expanded menu element in the rendered layout when the reference omitted it. | `src/motion/index.js` adds `.inner-page` when `#home` is absent; CSS hides the menu element on inner routes until the menu opens, so the existing header control still opens it. |
| The homepage hero underline followed word width and used an 0.08em thick inset shadow; the requested lines span the title column. The vertical Who We Are rule retained a `scale-y-0` utility after its GSAP tween. | Scoped two 1px full-width rules to `#home .intro-heading` at the measured line positions; block sizing lets the existing caption follow the second line. Scale reveals now grow from the top and remove the initial zero-scale utility on completion, preserving the vertical rule. |
| Reveal triggers could settle before the loader completed, leaving elements in the first viewport hidden; scale utility classes could also override the completed transform. | After the loader, refresh/update ScrollTrigger and play unfinished reveals whose boxes intersect the viewport. Offscreen reveals remain attached to their scroll triggers. The reveal itself continues to animate opacity/visibility and the existing transform/clip property from its `data-animation` hook. |
| Desktop content sections were 10px narrower than measured, shifting the 12-column grid by 0.83px per column. | Changed wide `.container` gutters from 2.5rem to the measured 2rem; column widths and starts now derive from the 20px source gutter. Nav icon placement and 2px nav rules were aligned to their measured computed positions/heights. |

The original captures show 1,150 hidden and 670 visible state differences across all DOM entries; many are runtime-generated split-text nodes absent from the rewrite and are excluded by the reviewer’s stated exception. This workspace does not have the reference browser or a browser capture runner, so the corrected candidate still needs the reviewer’s fresh 12-capture pass to confirm the remaining page-level rows and the <2px box target. Hanken Grotesk glyph widths remain the documented font exception.

## Round 3: measured corrections

| Cause | Fix |
|---|---|
| `[data-page-wrapper]` had `height: 100%` while its containing block was auto-height; its top frame padding expanded the wrapper to viewport plus 50px desktop or 24px mobile. | Give the page wrapper a border-box `100svh` height while retaining the frame padding. |
| The three home terrain pictures retained `min-width: 140rem` on phones. Their overflow widened the scroll content and expanded fixed overlays through the scroll containing block. | At widths below 768px, override the home pictures to `min-width: 100%`; keep the terrain's wide minimum at desktop. |
| The prior `.inner-page` test treated every route without `#home` as an inner page, which hid the source About page's navigation frame. The reference frame is only part of the source home/About page type at desktop and is omitted on phone layouts. | Treat `#home` and the source About section `#about-mochi` as the source page flag, keep the frame absent on the added page type, and hide the closed frame under 768px. Opening the menu restores its panel. |
| The rewrite used GSAP `autoAlpha` for text and menu reveals, which sets `visibility: hidden`. The source bundle uses opacity for fade/move and translated split lines, while the loader alone gates `main` with `visibility`; scroll reveal state belongs to each animation holder. | Use opacity for fade/move and menu transitions, translate split words from 120% without changing visibility, keep `main` hidden by visibility only while loading, and set `is-started` / `is-complete` on each holder as its ScrollTrigger enters and completes. The entrance removes the loading state as the main reveal begins. |
| Several repeated style differences came from component rules emitted inside Tailwind layers: utility output overrode the source order for section rules and header buttons. Other missing source component details affected inline marks, citation display, multiline text, icon spacing/position, large title display, and tight tracking. | Restore the source cascade after generated utilities for section borders and the header CTA; restore the source `.15rem` mobile / `.3rem` desktop borders, mark and cite styles, multiline outline clipping and padding, static icon flow with a 5px gap, block title headings, inline action buttons, and `tracking-tighter: -.04em`. |

`bun run build` is the requested acceptance check for this round. The reviewer will perform the next browser measurements; no local browser capture runner is available in this workspace.

- `bun run build`: passed for all seven routes; Vite emitted the hashed site CSS/JS and Hanken font with no missing-asset warnings.

## Round 4: reliable full-resolution comparison

| Difference | Cause | Fix |
|---|---|---|
| Lavender and orange frame bars and M/O labels vanished after the entrance. | The entrance tween moved all three full-screen preloader layers 110% offscreen, including the two permanent frame layers. | Keep layers 1 and 2 at their original offsets and animate only the pink cover layer out. Their inset backgrounds and labels remain in place on every route and viewport. |
| The two hero rules rendered 1px thick instead of about 3px. | The authored title background used a 1px gradient for both rule stripes. | Increase the stripe height to 3px while keeping the measured line positions and full title-column width. |
| The desktop hamburger measured 20px instead of 45px. | The wide-screen width rule appeared before the base pseudo-element width, so the later 2rem declaration won. | Put the 1280px breakpoint rule after the base declaration; desktop lines now use 4.5rem and mobile retains 2rem. |
| The mobile menu button was outside the visible 390px frame, and terrain began around y=735 instead of filling the lower half. | A mobile picture override replaced the page's 140rem terrain width with 100%, shrinking each source layer to 366×109px; loaded scroll content could also widen the scroll wrapper. | Remove the mobile width override, keep the original 140rem pictures clipped by the scroll viewport, and explicitly size that viewport to 100vw. This also keeps the fixed orange menu box aligned to the viewport's top-right. |
| A thin seam showed along the bottom edge of the first screen. | The compressed terrain stopped short of the original full-width crop and exposed the hero's viewport edge. | Restoring the source terrain width/fill carries the layered art to the screen edge and removes the exposed seam. |
| The measured rows showed the same menu-width mismatch, collapsed mobile terrain boxes and generated split-word wrappers in place of the source line wrappers. | The first three came from the CSS cascade and responsive picture override above; split-word spans are created by the replacement reveal runtime rather than source markup. | Correct the width and terrain declarations above. Preserve the replacement text animation; its generated wrapper boxes differ structurally, while the visible title lines and text remain aligned to the measured positions. |

`bun run build` is the acceptance check. Fresh headless recaptures are still required to confirm final pixels and remaining text-metric differences.

## Checks, deviations and open questions

- `TMPDIR=/private/tmp bun install --ignore-scripts --frozen-lockfile --cache-dir /private/tmp/mochi-w12-bun-cache`: passed; 102 installs checked, no changes.
- `bun run build`: passed; seven routes emitted with hashed site CSS/JS and a self-hosted Hanken Grotesk WOFF2. No missing-asset warnings.
- The `web/` scan finds no remaining page or build references to the retired assets; only the removal-history rows in this file contain their old filenames. The generated `dist/` output contains none of them.
- No HTML copy, page structure, images, dashboard data flow or `src/fixtures.js` were changed.
- Deviations: the workspace disallows browser execution and local port binding, so visual comparison remains a reviewer check. GSAP's npm archive contains its license declaration and official URL, but no standalone license text file to cite locally.
- Interface issues: none.
- Open question: none.
