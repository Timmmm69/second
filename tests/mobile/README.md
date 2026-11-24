# Mobile UI regression checks

Run from the repository root:

```sh
npx playwright install --with-deps chromium webkit
npx playwright test --config tests/mobile/playwright.config.ts
```

The matrix covers 320×568, 375×667, 390×844 and 430×932 CSS pixels in Chromium and WebKit with touch input. Vite serves the application itself, with `VITE_PUBLIC_DEMO=0`. There is no backend connection and no demo adapter. The tests intercept all API and media traffic using `preview/catalog.json` plus clearly synthetic additional categories, photographs and options. External requests are blocked. The Telegram script is replaced by a local bridge stub that emits viewport and safe-area events.

## Assertions and evidence

- At most one accordion section is open. The next header, or the price field following Category, is checked for full geometry and hit testing **before** any interaction that could scroll it into view. Following headers are tapped by their measured screen coordinates. The last section reserves the existing Apply button.
- Selection counts and values survive switching, collapse/reopen and applying. Draft edits do not request the catalog again.
- Long option lists scroll internally without moving the sheet.
- Price focus and viewport resizing preserve the route, focused input and document scroll. Closing the emulated keyboard restores navigation even when the input retains DOM focus. Search inputs, one full option and the next control remain usable on a 330px-high keyboard viewport.
- Catalog search is also exercised outside a sheet, with normal document scrolling: focus, value and route survive keyboard resizing, Enter does not reload or repeat an applied request, and navigation returns without blurring the input.
- Physical portrait/landscape rotation uses a stable orientation event target independently of browser viewport resizing. Its actual width, height, type and angle are checked after each requested rotation. Both event orders are checked with an open keyboard, including the return to a taller portrait keyboard viewport and dismissal while DOM focus remains.
- The purchase action sits above the actual navigation, responds to changed Telegram safe-area insets and remains tappable with a shorter available viewport. A separate bridge-only resize keeps the browser layout height unchanged, exercises the nonzero bottom offset, and verifies that a purchase button under the navigation does not hide the floating action.
- The distance between the two category-chip rows is compared with temporarily restored original margins and must decrease by 2px. The catalog heading has the existing design-system separator and clear space before the product grid.
- At the bottom of the product, the gap between the final content and navigation targets 40px with at most 1 CSS px allowed for fractional layout/integer scroll rounding. A separate assertion still requires more than a 60% reduction from the former 104px reserve: even the maximum accepted 41px means a 60.58% reduction. The former CSS reserved 88px on the product plus 16px on the shell, excluding navigation itself.
- Chromium receives trusted CDP touch events to establish that horizontal drags do not scroll the document and vertical drags still do. Both engines separately exercise event arbitration, cancelled/multiple touches, click suppression and image zoom.
- Photo-loading tests use distinct image colours and real 240/480/960/1600 responsive candidates. They check decoded pixels and pixels from browser screenshots after slow responses, rapid selections, failures and retry, including preventing retry from opening the gallery. Selected catalog images load eagerly, while unrelated catalog photos are not prefetched.
- At DPR 3, tiny thumbnails select the 240px candidate. Full-size preloads start only after the current item photo loads, use the same responsive candidate and stay within its immediate neighbours. The delayed-image test attaches loading/ready screenshots and the elapsed time from releasing its synthetic response to verifying the painted pixels.

Screenshots are attached to the HTML report and saved in `test-results/mobile`, including closed filters, sorting, audience, category, a middle long list, the last filter, multiselection, keyboard states and the top/bottom of a product. Failures retain screenshots and Playwright traces. No screenshot baselines are silently generated or accepted.

## Limits

These are browser-engine tests with an emulated Telegram bridge, screen and safe areas. Resizing the viewport models keyboard space; it does not launch the native Android or iOS keyboard. WebKit's synthetic gesture tests establish handler behavior, not native Safari scrolling. Passing this suite does not claim validation inside a physical Telegram Android/iOS client. A final real-device check remains useful for OS keyboard animation, native Telegram chrome and gesture arbitration with Telegram itself.

Playwright request routing disables HTTP caching. Photo tests establish request selection, load/error behaviour and actual rendering; their controlled timing is not a production latency measurement or a claim about cache hit rates.

Do not weaken system sandboxing to run a browser. Where the local runtime denies browser processes or sockets, run this suite in the normal CI runner and inspect its screenshots/artifacts.
