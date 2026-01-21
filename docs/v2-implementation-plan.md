# AnnotatePro v2.0 Implementation Plan

## Overview

Major feature expansion for AnnotatePro Firefox extension with 7 new features plus subscription system.

**Pricing Model:**
- Free trial: 3 days
- Monthly: $3/month
- Annual: $30/year
- Lifetime: TBD ($60-99)

---

## Phase 1: Foundation (Export & Search)

### 1.1 Export to Markdown/Obsidian
**Complexity:** Low | **Files:** `dashboard/dashboard.js`, `dashboard/dashboard.html`

- Add `exportToMarkdown()` function
- Format: Obsidian-compatible with YAML frontmatter
- Support single-page and all-pages export
- Group by intent (ACTION/QUESTION/RISK/etc.)

### 1.2 Enhanced Full-Text Search
**Complexity:** Medium | **Files:** `background/indexeddb-helper.js`, `dashboard/dashboard.js`

- Search across: `textSnapshot`, `note`, `pageUrl`, `pageTitle`
- Add search highlighting in results
- Support filters: by type, by intent, by date range
- Add `searchAnnotations(query, options)` method to DB helper

---

## Phase 2: Tags & Organization

### 2.1 Tags System
**Complexity:** Medium | **DB Version:** 2

**Schema Changes:**
```javascript
// New store: 'tags'
{ name: string, color: string, usageCount: number, createdAt: timestamp }

// Add to annotations store:
- New index: 'by_tags' (multiEntry: true)
- Add 'tags' array field to annotation records
```

**Files to Modify:**
- `background/indexeddb-helper.js` - Add tags store, CRUD operations
- `background/background.js` - Add tag message handlers
- `content/content.js` - Tag editing in note modal
- `dashboard/dashboard.js` - Tag filtering UI
- `popup/popup.js` - Tag display
- `styles/annotations.css` - Tag pill styles

**New Message Types:** `ADD_TAG`, `GET_ALL_TAGS`, `DELETE_TAG`, `UPDATE_TAG`

---

## Phase 3: Sidebar UI

### 3.1 Fixed Sidebar Panel
**Complexity:** High

**New Files:**
```
sidebar/
├── sidebar.html
├── sidebar.js
├── sidebar.css
└── sidebar-inject.js
```

**Features:**
- Toggle button (floating at edge)
- Position: left or right (user preference)
- Collapsible with remembered state
- Page annotations list with inline editing
- Quick highlight/checkbox buttons (on text selection)
- Search within current page
- Tag quick-filter
- Clipboard history tab (Phase 4)

**Storage Preferences:**
```javascript
sidebarSettings: {
  enabled: true,
  position: 'right', // 'left' | 'right'
  width: 320,
  collapsed: false
}
```

**Manifest Changes:**
- Add `sidebar/sidebar-inject.js` to content_scripts
- Add `sidebar/*` to web_accessible_resources

---

## Phase 4: Clipboard History

### 4.1 Copy History Tracking
**Complexity:** Medium

**Implementation:**
- Listen to `copy` event in content script
- Store in background memory (not IndexedDB) - ephemeral per session
- Map: `tabId -> [{text, timestamp, url}]`
- Keep last 50 entries per tab
- Clean up on tab close

**Files to Modify:**
- `content/content.js` - Add copy event listener
- `background/background.js` - Clipboard store management
- `popup/popup.js` - Clipboard history section
- `sidebar/sidebar.js` - Clipboard history tab

**New Message Types:** `CLIPBOARD_COPY`, `GET_CLIPBOARD_HISTORY`

---

## Phase 5: Advanced Annotations

### 5.1 Screenshot Annotations
**Complexity:** High | **DB Version:** 3

**New Files:**
```
screenshot/
├── capture.js
├── editor.js
├── editor.html
├── editor.css
```

**Schema:**
```javascript
// New store: 'screenshots'
{
  id: uuid,
  pageUrl: string,
  pageTitle: string,
  imageData: "data:image/png;base64,...",
  thumbnail: "data:image/png;base64,...",
  annotations: [{ type, x, y, width, height, color, content }],
  note: string,
  tags: string[],
  createdAt: timestamp
}
```

**Features:**
- Capture visible viewport via `browser.tabs.captureVisibleTab()`
- Region selection mode
- Canvas-based annotation editor (rectangles, arrows, text)
- Gallery view in dashboard

### 5.2 PDF Annotation Support
**Complexity:** Very High

**Approach:**
- Detect PDF via URL pattern, content type, or pdf.js viewer presence
- Create overlay div positioned over PDF canvas
- Store annotations with `pdfPage` number and relative coordinates
- Handle Firefox's built-in pdf.js viewer

**Schema Additions:**
- Add `pdfPage` field to annotations
- Add `pdfCoordinates: {x, y, width, height}` for PDF positioning

**Challenges:**
- Firefox pdf.js uses `resource://` which has access restrictions
- Need coordinate mapping between viewer zoom levels
- May require fallback overlay mode

---

## Phase 6: Subscription System

### 6.1 Supabase Auth + Stripe Payments
**Complexity:** Very High

**New Files:**
```
lib/
└── supabase.js

auth/
├── auth.js
├── subscription.js
├── settings.html
├── settings.js
└── settings.css

supabase/functions/
├── stripe-webhook/index.ts
└── create-checkout/index.ts
```

**Supabase Tables:**
```sql
-- profiles (auto-created on signup)
id, email, trial_start, plan_tier, created_at

-- subscriptions
id, user_id, stripe_customer_id, stripe_subscription_id,
status, current_period_end, created_at
```

**Feature Gating:**
- Free: Core highlights, checkboxes, page notes, JSON export
- Pro: Sidebar, clipboard history, screenshot, PDF, markdown export, tags

**Auth Flow:**
1. Sign up/in via Supabase (email or Google OAuth)
2. Store session in `browser.storage.local`
3. Check subscription status on feature access
4. 3-day trial starts on signup
5. Paywall modal when trial expires

**Manifest Additions:**
```json
{
  "permissions": ["identity"],
  "host_permissions": [
    "https://YOUR_PROJECT.supabase.co/*",
    "https://api.stripe.com/*"
  ]
}
```

---

## File Summary

### New Files to Create
| Path | Purpose |
|------|---------|
| `sidebar/sidebar.html` | Sidebar markup |
| `sidebar/sidebar.js` | Sidebar logic |
| `sidebar/sidebar.css` | Sidebar styles |
| `sidebar/sidebar-inject.js` | Injection into pages |
| `screenshot/capture.js` | Screenshot capture |
| `screenshot/editor.js` | Annotation canvas |
| `screenshot/editor.html` | Editor modal |
| `screenshot/editor.css` | Editor styles |
| `lib/supabase.js` | Supabase client |
| `auth/auth.js` | Auth functions |
| `auth/subscription.js` | Subscription logic |
| `auth/settings.html` | Settings/account page |
| `auth/settings.js` | Settings logic |
| `auth/settings.css` | Settings styles |

### Files to Modify
| Path | Changes |
|------|---------|
| `manifest.json` | Permissions, content scripts, web resources |
| `background/indexeddb-helper.js` | Tags store, screenshots store, search, schema migrations |
| `background/background.js` | New message handlers, clipboard store, subscription gating |
| `content/content.js` | Copy listener, PDF detection, tag editing |
| `popup/popup.js` | Tags display, clipboard section, trial status |
| `popup/popup.html` | Tags UI, clipboard UI, auth section |
| `dashboard/dashboard.js` | Markdown export, enhanced search, tag filtering, screenshot gallery |
| `dashboard/dashboard.html` | Export buttons, search UI, tags filter |
| `styles/annotations.css` | Tag pills, sidebar toggle button |

---

## Verification Plan

### Phase 1
- [ ] Export single page to Markdown, verify Obsidian opens it correctly
- [ ] Export all pages, check frontmatter and grouping
- [ ] Search for text in notes, verify highlighting
- [ ] Filter by intent and type

### Phase 2
- [ ] Create tags, verify autocomplete works
- [ ] Add tags to annotations
- [ ] Filter dashboard by tag
- [ ] Delete tag, verify removal from annotations

### Phase 3
- [ ] Toggle sidebar on/off
- [ ] Switch position left/right
- [ ] Create annotation from sidebar
- [ ] Edit note inline in sidebar
- [ ] Verify sync with popup changes

### Phase 4
- [ ] Copy text on page, verify appears in clipboard history
- [ ] Search clipboard history
- [ ] Copy from history to clipboard
- [ ] Close tab, verify history cleared

### Phase 5
- [ ] Capture screenshot of visible area
- [ ] Draw rectangle and arrow annotations
- [ ] Save and view in dashboard gallery
- [ ] Open PDF, add highlight annotation
- [ ] Reload PDF, verify annotation reattaches

### Phase 6
- [ ] Sign up with email
- [ ] Sign in with Google
- [ ] Verify 3-day trial starts
- [ ] After trial, verify paywall appears
- [ ] Complete Stripe checkout
- [ ] Verify Pro features unlock
- [ ] Cancel subscription, verify downgrade

---

## Implementation Order

1. **Phase 1** - Export & Search (no dependencies)
2. **Phase 2** - Tags (no dependencies, enables Phase 3 filtering)
3. **Phase 3** - Sidebar (uses tags for filtering)
4. **Phase 4** - Clipboard (displays in sidebar)
5. **Phase 5** - Screenshot & PDF (display in sidebar/dashboard)
6. **Phase 6** - Subscription (gates Phases 3-5 as Pro features)
