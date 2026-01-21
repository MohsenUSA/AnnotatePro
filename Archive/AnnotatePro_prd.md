# Product Requirements Document (PRD)

## Product Name
**AnnotatePro** - Persistent Web Annotations

## Overview
A Firefox browser extension that allows users to add persistent checkboxes, highlights, and annotations directly onto web pages. All annotations are stored locally using IndexedDB and reliably re-applied across page reloads, sessions, and moderate DOM changes.

The product is designed for researchers, auditors, developers, students, and power users who need durable, structured, and searchable page-level annotations without accounts or cloud dependencies.

---

## Goals
- Enable persistent, reliable annotations on arbitrary web pages
- Survive page reloads, SPA navigation, and moderate DOM changes
- Scale to large numbers of annotations without performance degradation
- Remain lightweight, private, and offline-first

## Non-Goals
- Real-time collaboration or shared annotations
- Mandatory user accounts or cloud sync
- Heavy AI-driven workflows by default

---

## Target Users
- Researchers and analysts
- QA, auditors, and compliance reviewers
- Developers reviewing documentation
- Students and self-learners
- Power users who prefer keyboard-driven workflows

---

## Core Features

### 1. Element Annotation
- Add checkboxes next to arbitrary DOM elements
- Highlight text or block elements with customizable colors
- Attach notes to any annotation
- Toggle visibility on/off

### 2. Persistent Storage (IndexedDB)
- Store all annotations locally using IndexedDB
- Indexed by:
  - Page URL
  - Element fingerprint
  - Annotation type
- Supports thousands of records efficiently

Example record:
```json
{
  "id": "uuid",
  "pageUrl": "https://example.com",
  "elementFingerprint": "fp_abc123",
  "textSnapshot": "Some highlighted text",
  "annotationType": "highlight",
  "intent": "ACTION",
  "color": "#ffeb3b",
  "checked": true,
  "note": "Follow up",
  "createdAt": 1700000000,
  "updatedAt": 1700001200
}
```

---

## Differentiating Features

### 3. Semantic Anchoring (DOM-Resilient)
Each annotated element is identified using a hybrid fingerprint:
- XPath or CSS selector
- Text content hash
- Surrounding text context (before/after)

On page load, the extension attempts to reattach annotations even if DOM structure shifts.

### 4. Intent-Based Highlights
Annotations can be tagged with semantic intent:
- ACTION (Yellow)
- QUESTION (Blue)
- RISK (Red)
- REFERENCE (Green)
- CUSTOM (Purple)

Intent affects:
- Color presets
- Icons
- Filtering and search

### 5. Cross-Page Grouping
- Group annotations into named collections (e.g., "Project A")
- Groups can span multiple URLs
- One annotation may belong to multiple groups

### 6. Change Detection
- On page revisit, compare stored text snapshot with current DOM content
- Detect modifications and mark annotation as "Changed"
- Optional visual diff or badge

Use cases:
- Policy monitoring
- Documentation changes
- Product listing updates

### 7. Timeline & History
- Track lifecycle of each annotation:
  - Created
  - Modified
  - Last verified unchanged
- Ability to undo or rollback changes per annotation

---

## Productivity Features

### 8. Global Search
- Full-text search across:
  - Highlighted text
  - Notes
  - URLs
  - Groups
- Implemented via IndexedDB indexes

### 9. Keyboard-First Interaction
- Fully usable without mouse

**Keyboard Shortcuts:**
| Shortcut | Action |
|----------|--------|
| `Alt+H` | Highlight selection |
| `Alt+C` | Add checkbox to element |
| `1` | Highlight as ACTION (Yellow) |
| `2` | Highlight as QUESTION (Blue) |
| `3` | Highlight as RISK (Red) |
| `4` | Highlight as REFERENCE (Green) |
| `5` | Highlight as CUSTOM (Purple) |
| `Shift+Right-click` | Delete annotation |

### 10. Rules Engine
Auto-annotation rules:
- Keyword match
- Regex match
- Element attribute match

Example:
> Highlight any text containing "deprecated" in red

Rules execute on page load and dynamic content updates.

### 11. Session Mode
- Temporary annotations that auto-expire
- Configurable lifespan (minutes / hours)
- Ideal for reviews, audits, and short-term tasks

### 12. Export & Import
Export formats:
- Markdown
- JSON
- CSV

Import allows restoring annotations on supported pages.

---

## Visualization

### 13. Page Heatmap Overlay
Optional overlay showing:
- Frequently annotated areas
- Most changed sections
- Density of annotations

---

## Firefox-Specific Enhancements

### 14. Reader Mode Support
- Preserve and display annotations in Firefox Reader View
- Map reader content back to original page anchors

---

## Technical Architecture

### Extension Structure
```
AnnotatePro/
├── background/
│   ├── background.js        # Message router, command handler
│   └── indexeddb-helper.js  # Database singleton
├── content/
│   └── content.js           # DOM interaction, fingerprinting, reattachment
├── popup/
│   ├── popup.html
│   ├── popup.css
│   └── popup.js
├── styles/
│   └── annotations.css
├── icons/
│   └── icon.svg
└── manifest.json            # Manifest V3
```

### Data Flow
1. **Content Script** captures user interactions (selections, clicks)
2. **Content Script** sends messages to **Background Script**
3. **Background Script** owns IndexedDB, performs all read/write operations
4. **Background Script** returns results to Content Script
5. **Content Script** renders annotations in DOM

This pattern prevents race conditions and schema drift.

---

## IndexedDB Schema

### Database Overview
- **Database name:** `annotatepro-db`
- **Versioned schema:** Yes (IndexedDB versioning)
- **Single shared database** accessed via background script

---

## Object Stores

### 1. `annotations` (Core Store)
Stores every checkbox, highlight, and note.

**Key**
- `id` (string, primary key – UUID)

**Indexes**
- `by_page` → `pageUrl`
- `by_page_element` → `[pageUrl, elementFingerprint]` (unique)
- `by_type` → `annotationType`
- `by_updated` → `updatedAt`

**Record Shape**
```json
{
  "id": "uuid",
  "pageUrl": "https://example.com",
  "elementFingerprint": "fp_abc123",
  "selector": "#content > p:nth-child(3)",
  "tagName": "p",
  "className": "content-paragraph",
  "textSnapshot": "Original highlighted text",
  "textHash": "a1b2c3d4",
  "contextBefore": "Previous sentence",
  "contextAfter": "Next sentence",
  "annotationType": "highlight | checkbox",
  "intent": "ACTION | QUESTION | RISK | REFERENCE | CUSTOM",
  "color": "#ffeb3b",
  "checked": true,
  "note": "Optional user note",
  "groups": ["project-a"],
  "boundingBox": { "top": 100, "left": 50, "width": 200, "height": 20 },
  "createdAt": 1700000000,
  "updatedAt": 1700001200,
  "lastVerifiedAt": 1700001200,
  "changeStatus": "unchanged | changed"
}
```

---

### 2. `groups`
Logical collections spanning multiple pages.

**Key**
- `id` (string)

**Indexes**
- `by_name` → `name` (unique)

**Record Shape**
```json
{
  "id": "project-a",
  "name": "Project A",
  "createdAt": 1700000000
}
```

---

### 3. `rules` (Future)
Auto-annotation rules engine.

**Key**
- `id` (string)

**Indexes**
- `by_enabled` → `enabled`

**Record Shape**
```json
{
  "id": "rule_1",
  "type": "keyword | regex",
  "pattern": "deprecated",
  "annotationType": "highlight",
  "intent": "RISK",
  "color": "#ff5252",
  "enabled": true,
  "createdAt": 1700000000
}
```

---

### 4. `sessions` (Future)
Temporary annotations with expiration.

**Key**
- `id` (string)

**Indexes**
- `by_expires` → `expiresAt`

**Record Shape**
```json
{
  "id": "session_1",
  "expiresAt": 1700003600,
  "annotationIds": ["uuid1", "uuid2"]
}
```

---

### 5. `history` (Future)
Tracks annotation changes over time.

**Key**
- `id` (auto-increment)

**Indexes**
- `by_annotation` → `annotationId`
- `by_timestamp` → `timestamp`

**Record Shape**
```json
{
  "id": 1,
  "annotationId": "uuid",
  "event": "created | modified | verified | changed",
  "previousValue": {"color": "#fff"},
  "timestamp": 1700001200
}
```

---

## Migration Strategy

### Version 1 (Current MVP)
- `annotations` store with core indexes
- `groups` store

### Version 2 (Future)
- Add `rules` store
- Add `intent` index to annotations

### Version 3 (Future)
- Add `history` store
- Track annotation lifecycle events

### Version 4 (Future)
- Add `sessions` store
- Expiration cleanup job

---

## Element Fingerprinting Algorithm

### Fingerprint Components (Weighted)
Each element is identified using a composite fingerprint:

| Component | Weight | Description |
|-----------|--------|-------------|
| Tag Name | 10% | Required match (disqualifying if different) |
| Text Content | 40% | Exact match, partial match, or hash match |
| CSS Selector | 20% | Generated path from element to root |
| Class Name | 10% | Exact or partial class match |
| Context | 10% | Surrounding text (before/after) |
| Position | 10% | Bounding box proximity |

### Fingerprint Generation
```js
function createFingerprint(element) {
  return {
    elementFingerprint: `${tagName}_${textHash}_${selectorHash}`,
    selector: getCSSSelector(element),
    tagName: element.tagName.toLowerCase(),
    className: element.className,
    textSnapshot: normalizeText(element.textContent).slice(0, 200),
    textHash: hashText(element.textContent),
    contextBefore: getContextBefore(element, 50),
    contextAfter: getContextAfter(element, 50),
    boundingBox: element.getBoundingClientRect()
  };
}
```

---

## Reattachment Algorithm

### Process
1. **Fast Path:** Try exact CSS selector match
2. **Scoring:** If selector fails, scan all elements with same tag
3. **Threshold:** Attach to highest-scoring candidate above 0.5
4. **Orphan:** Mark as orphaned if no match found

### Scoring Function
```js
function scoreCandidate(element, record) {
  let score = 0, maxScore = 10;

  // Tag match (required)
  if (element.tagName.toLowerCase() !== record.tagName) return 0;
  score += 1;

  // Text match (high weight)
  const text = normalizeText(element.textContent);
  if (text === record.textSnapshot) score += 4;
  else if (text.includes(record.textSnapshot)) score += 3;
  else if (hashText(text) === record.textHash) score += 3;

  // Class match
  if (element.className === record.className) score += 2;

  // Context match
  if (parentContains(element, record.contextBefore)) score += 1;
  if (parentContains(element, record.contextAfter)) score += 1;

  // Position match
  if (withinBounds(element, record.boundingBox, 50)) score += 1;

  return score / maxScore;
}
```

---

## SPA Support (MutationObserver)

### Strategy
- Observe `document.body` for `childList` and `subtree` changes
- Throttle reactions using `requestIdleCallback`
- Re-run reattachment on meaningful mutations
- Handle `pushState`/`popstate` for SPA navigation

### Configuration
```js
const observer = new MutationObserver(() => {
  if (pending) return;
  pending = true;
  requestIdleCallback(runReattachment, { timeout: 1000 });
});

observer.observe(document.body, {
  childList: true,
  subtree: true,
  attributes: false,
  characterData: false
});
```

### SPA Navigation Detection
```js
const originalPushState = history.pushState;
history.pushState = function(...args) {
  originalPushState.apply(history, args);
  attachedAnnotations.clear();
  setTimeout(loadAnnotations, 100);
};

window.addEventListener('popstate', () => {
  attachedAnnotations.clear();
  setTimeout(loadAnnotations, 100);
});
```

---

## Anti-False-Positive Guarantees

### Structural Invariants
A candidate is invalid if any fail:
- `element.tagName !== record.tagName`
- `element.textContent.length < record.textSnapshot.length * 0.6`
- `element.offsetParent === null` (hidden/detached)

### Confidence Thresholds
| Score | Behavior |
|-------|----------|
| ≥ 0.7 | Auto-attach |
| 0.5–0.7 | Attach with low-confidence flag |
| < 0.5 | Do not attach (orphan) |

### One-to-One Lock
- Each DOM element can only be attached to one annotation
- Each annotation can only be attached to one element
- Prevents cross-anchor collisions

---

## Performance Guardrails

| Rule | Limit |
|------|-------|
| Max DOM queries per batch | 200 |
| Max reattach attempts | 50 |
| Idle callback timeout | 1000ms |
| Observer re-fire debounce | 300ms |
| Max text snapshot length | 200 chars |

---

## Data Integrity Rules
- `pageUrl + elementFingerprint` must be unique
- Annotations never reference raw DOM nodes
- All hashes are deterministic
- Schema is backward compatible

---

## Privacy & Security
- All data stored locally (no cloud sync)
- No tracking or analytics
- No external network requests
- Content scripts sanitize DOM operations

---

## Installation

### Development
1. Open Firefox and navigate to `about:debugging`
2. Click "This Firefox"
3. Click "Load Temporary Add-on"
4. Select `manifest.json` from the project root

### Production
Package as `.xpi` and submit to Firefox Add-ons store.

---

## Future Roadmap

### Phase 2
- Rules engine for auto-annotation
- Cross-page groups UI
- Export/Import functionality

### Phase 3
- Change detection with visual diff
- History/timeline view
- Session mode

### Phase 4
- Reader Mode support
- Heatmap overlay
- Advanced search filters

---

## Open Questions (Resolved)
- **Fingerprint hash:** MurmurHash-inspired (fast, deterministic)
- **History retention:** Last 50 events per annotation
- **Rule execution:** Max once per page load
- **Minimum score threshold:** 0.5
