# AnnotatePro Maintenance Notes

Living punch list of known issues, half-finished work, and cleanup tasks. Add items as they're found; cross out / delete as they're fixed.

**Scope reminder:** AnnotatePro is Firefox-only (MV3, gecko id in `manifest.json`). A Chrome build doesn't exist yet — if/when one is started, several items below pick up new constraints (noted inline).

Last reviewed: 2026-05-17 (against working tree on `main`; two uncommitted features stacked — find-on-page, and link previews / clipboard notes / dashboard auto-refresh).

---

## In-flight work (uncommitted)

The working tree on `main` now has **two features in flight, stacked in the same diff**. They should probably be split into two commits before landing.

### Feature 1: find-on-page

Files touched: `manifest.json`, `background/background.js`, `content/content.js`, `popup/popup.html`, `popup/popup.js`, `popup/popup.css`.

Before this can be committed:

- [ ] **Sidebar has no find integration.** Searching in sidebar doesn't sync with `browser.find` state on the page. Decide whether sidebar search should drive page find or stay independent, and wire it up either way.
- [ ] **Find state is lost on tab navigation.** `background/background.js` clears state when the tab navigates. If the user navigates back, the previous query is gone. Either persist last query per-tab or document the behavior.
- [ ] **Popup footer shortcuts not updated.** `popup/popup.js` still lists the old shortcuts — find shortcuts missing.
- [ ] **No debounce on rapid find button clicks.** `refreshFindState()` in `popup/popup.js` fires on every popup open; rapid clicks can stack requests.

> Chrome note: `browser.find` is a Firefox-only WebExtensions API. If a Chrome port happens, this whole feature needs a different implementation (or to be disabled at build time).

### Feature 2: link previews + clipboard notes + dashboard auto-refresh

Files touched: `manifest.json` (host_permissions), `background/background.js` (FETCH_LINK_PREVIEW + X-specific fetchers), `dashboard/dashboard.html`, `dashboard/dashboard.js`, `dashboard/dashboard.css`.

What shipped:
- OG link previews for clipboard URLs, with `linkPreviewCache` in `browser.storage.local` (30d TTL on success, 1d on failure, 90d hard prune).
- X.com (Twitter) special handling via X-owned endpoints — `cdn.syndication.twimg.com/tweet-result` primary, `publish.twitter.com/oembed` fallback. No third-party proxy.
- Settings toggle `loadLinkPreviews` (default on) persisted under `settings` key in `browser.storage.local`.
- Single-item View modal for clipboard items, opened from standalone cards (card click or 📝 button) and from inside the page modal (📝 button per item).
- Clipboard notes — auto-saved into `clipboardHistory[].note`, matched by `(text, timestamp, pageUrl)`.
- Dashboard auto-refresh — extended annotation message listener + `browser.storage.onChanged` for `clipboardHistory`, debounced 600ms, with self-write counter to avoid flashing under the modal during note typing.
- Notes filter chip (pseudo-type `has-note`) — restricts results to items with non-empty notes, excluding page-notes. Stripped from backend payload, applied client-side.
- Always-visible 📝 button on clipboard and annotation items in modals (faded when empty, opaque when present, clickable to open detail).
- Red modal close buttons (`.modal-close`).
- ESC closes the topmost `.modal-overlay`.

Follow-ups before committing or shortly after:
- [ ] **Clipboard note key is fragile.** Match by `(text, timestamp, pageUrl)` works today but breaks if any field is later edited. Consider adding a stable `id` to each clipboardHistory entry (UUID at insert time). Touches the content-script copy capture and migration of existing entries.
- [ ] **Link-preview cache has no max size.** Prune is age-based only (90d). A power user copying lots of unique URLs could grow `linkPreviewCache` indefinitely within the 90d window. Add a max-entries cap (e.g., 500) with LRU eviction.
- [ ] **X.com syndication endpoint is fragile.** Undocumented, breaks periodically when X tightens it. oEmbed fallback returns no thumbnail. When both fail, user sees "Preview unavailable" — no manual retry button yet. Consider a "Retry preview" affordance on failed cards.
- [ ] **Failure TTL is 24h, which is too long for transient errors.** A single bad fetch locks the cache for a day. Either shorten to ~5 min, or distinguish 404s (cache long) from network/timeouts (cache short).
- [ ] **`host_permissions: ["<all_urls>"]` was added.** Existing-install users will need to grant it manually in `about:addons` → Permissions; new installs get prompted. Worth a release-note line.
- [ ] **`hydrateStandaloneClipboardPreviews` runs sequentially.** Fine for typical clipboard sizes but O(n) requests with no parallelism. If clipboard history grows large (50+ URLs), the last cards take time to hydrate. Consider small parallelism (e.g., 3 at a time).
- [ ] **Note-icon 📝 button is always rendered** even when no note exists. Visual noise concern on cards with many items. If this becomes a complaint, revert to conditional rendering (only show when has-note) but keep clickable.

### Pre-commit shared steps

- [ ] **`docs/security-and-competitors.md` was untracked** at the time of feature 1, now tracked. `docs/subscription-implementation-guide.md` has heavy edits that read as incomplete — finish or stash before committing the find feature so the commit stays scoped.
- [ ] **Split into two commits** (find, then link-previews+notes) so revert/bisect stays useful.

---

## High priority

- [x] ~~**Screenshot text-tool listener leak** — `screenshot/screenshot-editor.js:1135-1170`. Drag `mousemove` / `mouseup` listeners are attached to `document` every time a text element is created, but only removed in a single branch. Listeners stack across captures.~~ **Fixed 2026-07-04:** drag listeners now attach on `mousedown` and detach unconditionally in `onDragEnd`, so `document` holds at most one pair during an active drag.
- [x] ~~**Bulk import has no quota check** — `dashboard/dashboard.js:1415-1449`. Large JSON imports silently fail past the storage quota with no user feedback.~~ **Fixed 2026-07-04:** annotations live in IndexedDB (not `storage.local`), so `importAnnotations()` now pre-checks with `navigator.storage.estimate()` and aborts with a specific "not enough storage" message. Also fixed the deeper bug in `indexeddb-helper.js:importAnnotations()` — it counted `QuotaExceededError` adds as duplicate skips ("Imported: 0, Skipped: 5000"); it now detects quota errors, stops the loop, and returns `quotaExceeded` so the dashboard shows an accurate mid-import message.
- [ ] **Service-worker keepalive alarm is cosmetic** — `background/background.js:788-793`. The 30s alarm doesn't actually prevent MV3 from suspending the worker after ~5 min idle; first action after idle is slow. Either accept it and ensure all state is persisted (preferred for MV3), or document the latency. Don't pretend the alarm fixes it.

---

## Medium priority

- [ ] **PDF selector built via template string** — `pdf/pdf-overlay.js:679`. `[data-annotation-id="${id}"]` works today because IDs are UUIDs, but there's no escaping. Switch to `CSS.escape()` or `querySelectorAll` + iterate.
- [ ] **Sidebar resize listeners not always cleaned up** — `sidebar/sidebar.js:363-364, 398-399`. `mousemove`/`mouseup` are attached on mousedown and detached only in the mouseup path. Interrupted resizes (alt-tab, Esc, devtools) leak listeners. Detach unconditionally or use `{ once: true }`.
- [ ] **Sidebar search/filter state persists across collapse** — `sidebar/sidebar.js:502-537`. Module-scope `searchQuery` and `colorFilter` survive collapse/reopen, and the active filter isn't visible when on the clipboard tab. Either reset on collapse or surface a "filter active" indicator.
- [ ] **PDF annotation coords stored as % without zoom context** — `pdf/pdf-overlay.js:566-571`. Positions drift across zoom levels because the percentage is taken against the zoomed viewport. Either store at a normalized zoom or stash the zoom level alongside the coords.
- [ ] **Content scripts inject on `<all_urls>`** — `manifest.json:25`. All 5 scripts (including ~40KB `lib/qrcode.min.js`) load on every page, even ones the user never annotates. Consider lazy-loading via `browser.scripting.executeScript` on first user action.
- [ ] **Silent error swallowing in sidebar** — `sidebar/sidebar.js:99-102, 153-166`. `loadColors()` and `loadClipboardHistory()` swallow errors and default to empty arrays; popup logs them. Make sidebar consistent with popup so failures aren't invisible.

---

## Low priority / nits

- [ ] **`hexToRgba` duplicated 3 times** — `popup/popup.js:49-58`, `sidebar/sidebar.js:183-192`, `dashboard/dashboard.js:41-50`. Promote to a shared util (e.g., `lib/color-utils.js`) and import.
- [ ] **`content/content.js` is 2714 lines** and mixes annotation lifecycle, find, and event wiring. Worth splitting (annotation, find, events) when next touched.
- [ ] **`screenshot/screenshot-editor.js` is 1912 lines** and mixes drawing tools, text tool, export, and PDF-aware capture. Split when next touched.
- [ ] **`updateCanvasCursor()` falls back to `crosshair` silently** — `screenshot/screenshot-editor.js:1838-1853`. Invalid tool states should at least `console.warn`.
- [ ] **`renderColorFilter()` always re-renders the "All" chip** — `sidebar/sidebar.js:793-810`. Indirect — should be driven directly from `colorFilter` state.

---

## Not bugs, but worth knowing

- **`hexToRgba` consolidation** depends on choosing a shared-lib pattern that works for content scripts, popup, and dashboard simultaneously. The dashboard isn't a content script context, so a plain `<script>` import works there but not in `content/content.js`. Either duplicate intentionally or use `manifest.json` to inject the util as the first content script.
- **MV3 service worker + `type: "module"`** (`manifest.json:21`) means top-level imports are supported but global state is wiped on suspension. Anything stored only in module-scope variables in `background.js` is lost across suspensions — `tabFindState` (line 40) is one example.
