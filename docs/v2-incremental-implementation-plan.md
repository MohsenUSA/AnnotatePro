# AnnotatePro v2.0 Incremental Implementation Plan

## Overview

This plan reorganizes the v2.0 features into **incremental milestones** based on dependency hierarchy and smallest shippable units. Each milestone delivers standalone value and can be released independently.

**Pricing Model:**
- Free trial: 3 days
- Monthly: $3/month
- Annual: $30/year
- Lifetime: TBD ($60-99)

---

## Dependency Graph

```
                         ┌─────────────────┐
                         │   Tier 4:       │
                         │  Subscription   │ ← Gates Pro features
                         └────────┬────────┘
                                  │ gates
         ┌────────────────────────┼────────────────────────┐
         ▼                        ▼                        ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│    Tier 3:      │      │    Tier 2:      │      │    Tier 2:      │
│ Screenshot/PDF  │      │    Sidebar      │      │   Clipboard     │
│    (DB v3)      │      │                 │      │                 │
└─────────────────┘      └────────┬────────┘      └────────┬────────┘
                                  │ uses                   │ displays in
                                  ▼                        ▼
                         ┌─────────────────┐      ┌─────────────────┐
                         │    Tier 1:      │      │    Tier 2:      │
                         │ Custom Colors   │      │    Sidebar      │
                         │    (DB v2)      │      │                 │
                         └────────┬────────┘      └─────────────────┘
                                  │
         ┌────────────────────────┴────────────────────────┐
         │                 No dependencies                 │
         ▼                                                 ▼
┌─────────────────┐                               ┌─────────────────┐
│ 0.1-0.2         │                               │ 0.3-0.4         │
│ Markdown Export │                               │ Search          │
└─────────────────┘                               └─────────────────┘
```

---

## Tier 0: Quick Wins

**Goal:** Ship value immediately with no database changes.
**Release:** v1.4

### 0.1 Markdown Export (Single Page)
**Complexity:** Low | **Files:** `popup/popup.js`, `popup/popup.html`

**Implementation:**
- Add "Export to Markdown" button in popup
- Format with Obsidian-compatible YAML frontmatter
- Group annotations by color name (Action, Question, Risk, Reference, or custom names)
- Include checkbox state, highlights with notes

**Output Format:**
```markdown
---
url: https://example.com/page
title: Page Title
exported: 2025-01-19T10:30:00Z
annotations: 5
---

# Page Title

## Highlights

### Action
- [ ] "Selected text here"
  - Note: User's note

### Research (custom color)
- "Another highlight"

## Checkboxes
- [x] Element with checkbox (checked)
- [ ] Another element (unchecked)

## Page Notes
- General note about this page
```

**Verification:**
- [ ] Export single page from popup
- [ ] Open in Obsidian, verify frontmatter parses
- [ ] Confirm checkbox states render correctly

---

### 0.2 Markdown Export (All Pages)
**Complexity:** Low | **Files:** `dashboard/dashboard.js`, `dashboard/dashboard.html`

**Implementation:**
- Add "Export All to Markdown" button in dashboard
- Option: Single file or zip of individual files
- Include table of contents linking to pages

**Verification:**
- [ ] Export all pages from dashboard
- [ ] Verify each page section is properly formatted
- [ ] Test with 50+ pages for performance

---

### 0.3 Basic Search
**Complexity:** Low | **Files:** `dashboard/dashboard.js`, `background/indexeddb-helper.js`

**Implementation:**
- Add search input to dashboard header
- Search across: `textSnapshot`, `note`, `pageUrl`, `pageTitle`
- Real-time filtering as user types (debounced 300ms)
- Add `searchAnnotations(query)` method to DB helper

**Verification:**
- [ ] Search for text in annotation notes
- [ ] Search for text in highlighted content
- [ ] Search for URL fragments
- [ ] Verify case-insensitive matching

---

### 0.4 Search Filters
**Complexity:** Medium | **Files:** `dashboard/dashboard.js`, `dashboard/dashboard.html`, `dashboard/dashboard.css`

**Implementation:**
- Filter chips: Type (highlight/checkbox/page-note)
- Color filter: Show available colors (default + custom)
- Date range picker: Today, Last 7 days, Last 30 days, Custom
- Combine filters with AND logic
- Show active filter count

**Verification:**
- [ ] Filter by annotation type
- [ ] Filter by color
- [ ] Filter by date range
- [ ] Combine multiple filters
- [ ] Clear all filters

---

## Tier 1: Custom Named Colors

**Goal:** Replace fixed intents with user-defined named colors for better organization.
**Release:** v1.5
**Database Version:** 2

### Current State vs. New System

| Current (Fixed Intents) | New (Custom Named Colors) |
|-------------------------|---------------------------|
| 5 hardcoded: ACTION, QUESTION, RISK, REFERENCE, CUSTOM | Unlimited user-defined |
| Names can't be changed | Users name their own colors |
| Can't add new colors | Add via color palette picker |
| `intent` + `color` fields | Single `colorId` reference |

### 1.1 Colors Store + CRUD
**Complexity:** Medium | **Files:** `background/indexeddb-helper.js`, `background/background.js`

**Schema Changes:**
```javascript
// New object store: 'colors'
{
  id: string,             // uuid or 'default-action', 'default-question', etc.
  name: string,           // "Research", "Todo", "Action", etc.
  color: string,          // hex color "#4CAF50"
  isDefault: boolean,     // true for built-in colors (can't delete)
  usageCount: number,     // auto-updated
  createdAt: timestamp
}

// Modify 'annotations' store:
// REMOVE: intent, color fields
// ADD: colorId field (references colors store)
colorId: string  // references colors.id

// New index on annotations:
'by_color' (on colorId field)
```

**Default Colors (seeded on install/upgrade):**
```javascript
const DEFAULT_COLORS = [
  { id: 'default-action', name: 'Action', color: '#FFEB3B', isDefault: true },
  { id: 'default-question', name: 'Question', color: '#64B5F6', isDefault: true },
  { id: 'default-risk', name: 'Risk', color: '#EF5350', isDefault: true },
  { id: 'default-reference', name: 'Reference', color: '#81C784', isDefault: true },
];
```

**New Message Types:**
- `ADD_COLOR` → `COLOR_ADDED`
- `GET_ALL_COLORS`
- `UPDATE_COLOR` → `COLOR_UPDATED`
- `DELETE_COLOR` → `COLOR_DELETED` (fails for default colors)

**Migration Strategy:**
```javascript
// In indexeddb-helper.js upgrade handler
if (oldVersion < 2) {
  // Create colors store
  const colorStore = db.createObjectStore('colors', { keyPath: 'id' });

  // Seed default colors
  DEFAULT_COLORS.forEach(c => colorStore.add(c));

  // Add index to annotations
  const annotationStore = transaction.objectStore('annotations');
  annotationStore.createIndex('by_color', 'colorId');

  // Migrate existing annotations: intent → colorId
  // ACTION → 'default-action', QUESTION → 'default-question', etc.
}
```

**Verification:**
- [ ] Default colors exist after upgrade
- [ ] Create custom color with name and hex
- [ ] Rename color
- [ ] Change color hex value
- [ ] Delete custom color (verify removed from annotations)
- [ ] Cannot delete default colors
- [ ] Verify usageCount updates

---

### 1.2 Color Picker UI
**Complexity:** Medium | **Files:** `content/content.js`, `styles/annotations.css`

**Implementation:**
- Replace intent submenu with color picker in context menu
- Show color swatches: defaults first, then custom colors, then "+ New"
- Clicking "+ New" opens color creation modal

**Context Menu Structure:**
```
Right-click selection →
  ├── Highlight → [● Action] [● Question] [● Risk] [● Reference] [● Research] [+ New]
  ├── Checkbox
  └── ...
```

**Color Creation Modal:**
```
┌─────────────────────────────────────┐
│ New Highlight Color                 │
│                                     │
│ Name: [___________________]         │
│                                     │
│ Color:                              │
│ ┌─────────────────────────────────┐ │
│ │ 🟡 🟠 🔴 🟣 🔵 🟢 🩷 🩵 🤎 ⬛ │ │
│ └─────────────────────────────────┘ │
│                                     │
│ Or enter hex: [#________]           │
│                                     │
│ Preview: [███████████████████████]  │
│                                     │
│              [Cancel]  [Create]     │
└─────────────────────────────────────┘
```

**Preset Palette (for new colors):**
```javascript
const COLOR_PALETTE = [
  '#FFEB3B', '#FF9800', '#F44336', '#9C27B0',
  '#2196F3', '#4CAF50', '#E91E63', '#00BCD4',
  '#795548', '#212121', '#9E9E9E', '#CDDC39'
];
```

**Verification:**
- [ ] See all colors in context menu
- [ ] Create new color via modal
- [ ] Color preview updates in real-time
- [ ] Hex input validates format
- [ ] New color appears in menu immediately

---

### 1.3 Color Selection in Note Modal
**Complexity:** Low | **Files:** `content/content.js`

**Implementation:**
- Add color picker row in existing note edit modal
- Show current color as selected
- Click different color to change annotation's color

**UI Update:**
```
┌─────────────────────────────────┐
│ Edit Annotation                 │
│                                 │
│ Color:                          │
│ [● Action] [● Question] [●̲ R̲e̲s̲e̲a̲r̲c̲h̲] [● Risk] [+]
│                                 │
│ Note:                           │
│ ┌─────────────────────────────┐ │
│ │ User's note here...         │ │
│ └─────────────────────────────┘ │
│                                 │
│        [Cancel]  [Save]         │
└─────────────────────────────────┘
```

**Verification:**
- [ ] See current color highlighted
- [ ] Change color and save
- [ ] Highlight updates color on page
- [ ] Can create new color from modal

---

### 1.4 Color Display in Popup/Dashboard
**Complexity:** Low | **Files:** `popup/popup.js`, `popup/popup.html`, `dashboard/dashboard.js`, `dashboard/dashboard.html`

**Implementation:**
- Show color name (not just color swatch) on annotation cards
- Format: `[●] Research` or `[●] Action`
- In dashboard, show color distribution per page

**Verification:**
- [ ] Color name visible in popup annotation list
- [ ] Color name visible in dashboard
- [ ] Color swatch matches the hex value

---

### 1.5 Color Filtering
**Complexity:** Medium | **Files:** `dashboard/dashboard.js`, `dashboard/dashboard.html`

**Implementation:**
- Color filter section in dashboard
- Show all colors with usage counts
- Click color to filter, click again to remove filter
- Multiple color selection (OR logic)

**UI:**
```
Colors: [● Action (23)] [● Question (15)] [● Research (12)] [● Risk (8)]
        ───────────────                   ─────────────────
              active                           active
```

**Verification:**
- [ ] Filter dashboard by single color
- [ ] Filter by multiple colors (OR)
- [ ] Combine color filter with search
- [ ] Combine color filter with type filter

---

### 1.6 Color Management Settings
**Complexity:** Medium | **Files:** `popup/popup.js`, `popup/popup.html` or new `settings/` page

**Implementation:**
- "Manage Colors" section accessible from popup or dashboard
- List all colors with edit/delete options
- Reorder colors (drag or up/down buttons)
- Edit: change name or hex color
- Delete: only for non-default colors, with confirmation

**UI:**
```
┌─────────────────────────────────────────────────┐
│ Manage Colors                            [+ Add]│
├─────────────────────────────────────────────────┤
│ ● Action        #FFEB3B    23 uses    [Edit]    │  ← default (no delete)
│ ● Question      #64B5F6    15 uses    [Edit]    │
│ ● Risk          #EF5350    10 uses    [Edit]    │
│ ● Reference     #81C784     7 uses    [Edit]    │
│ ─────────────────────────────────────────────── │
│ ● Research      #9C27B0    12 uses    [Edit] [×]│  ← custom
│ ● Todo          #FF9800     8 uses    [Edit] [×]│
│ ● Important     #F44336     5 uses    [Edit] [×]│
└─────────────────────────────────────────────────┘
```

**Verification:**
- [ ] View all colors with usage counts
- [ ] Edit color name
- [ ] Edit color hex
- [ ] Delete custom color (with confirmation)
- [ ] Cannot delete default colors
- [ ] Annotations update when color edited

---

## Tier 2: UI & Convenience

**Goal:** Add sidebar panel and clipboard history.
**Release:** v1.6 (sidebar), v1.7 (clipboard)

### 2.1 Sidebar Scaffold
**Complexity:** High

**New Files:**
```
sidebar/
├── sidebar.html      # Sidebar markup
├── sidebar.js        # Sidebar logic
├── sidebar.css       # Sidebar styles
└── sidebar-inject.js # Injection script
```

**Implementation:**
- Inject sidebar container into pages via content script
- Toggle button (floating pill at screen edge)
- Position preference: left or right
- Collapsible with smooth animation
- Remember collapsed state in `browser.storage.local`
- Responsive: auto-collapse on narrow viewports

**Storage Schema:**
```javascript
// browser.storage.local
{
  sidebarSettings: {
    enabled: true,
    position: 'right',  // 'left' | 'right'
    width: 320,
    collapsed: false
  }
}
```

**Manifest Changes:**
```json
{
  "content_scripts": [{
    "js": ["content/content.js", "sidebar/sidebar-inject.js"],
    "css": ["styles/annotations.css", "sidebar/sidebar.css"]
  }],
  "web_accessible_resources": [{
    "resources": ["sidebar/*"],
    "matches": ["<all_urls>"]
  }]
}
```

**Verification:**
- [ ] Toggle sidebar with button
- [ ] Switch position left/right
- [ ] Collapse/expand sidebar
- [ ] State persists across page loads
- [ ] No layout shift on page content

---

### 2.2 Sidebar Annotations List
**Complexity:** Medium | **Files:** `sidebar/sidebar.js`, `sidebar/sidebar.html`

**Implementation:**
- Fetch current page annotations on sidebar open
- Display list with: type icon, text preview, color name, timestamp
- Click annotation to scroll to it on page
- Real-time sync with background changes

**Verification:**
- [ ] See all page annotations in sidebar
- [ ] Click annotation scrolls to element
- [ ] New annotations appear immediately
- [ ] Deleted annotations disappear

---

### 2.3 Sidebar Inline Editing
**Complexity:** Medium | **Files:** `sidebar/sidebar.js`

**Implementation:**
- Edit note directly in sidebar (expandable textarea)
- Toggle checkbox state
- Delete annotation with confirmation
- Change color via dropdown

**Verification:**
- [ ] Edit note in sidebar, verify saved
- [ ] Toggle checkbox in sidebar
- [ ] Delete annotation from sidebar
- [ ] Change color from sidebar

---

### 2.4 Sidebar Color Filter
**Complexity:** Low | **Files:** `sidebar/sidebar.js`
**Depends on:** Tier 1 (Custom Colors)

**Implementation:**
- Color filter dropdown at top of sidebar
- Filter current page annotations by color
- Show "All" option to clear filter

**Verification:**
- [ ] Filter sidebar annotations by color
- [ ] Clear filter shows all annotations

---

### 2.5 Clipboard Tracking
**Complexity:** Medium | **Files:** `content/content.js`, `background/background.js`

**Implementation:**
- Listen to `copy` event in content script
- Send copied text to background script
- Store in memory (not IndexedDB) - ephemeral per session
- Structure: `Map<tabId, Array<{text, timestamp, url, pageTitle}>>`
- Keep last 50 entries per tab
- Clean up on tab close (`browser.tabs.onRemoved`)

**New Message Types:**
- `CLIPBOARD_COPY` - content → background
- `GET_CLIPBOARD_HISTORY` - popup/sidebar → background
- `CLEAR_CLIPBOARD_HISTORY` - user action

**Verification:**
- [ ] Copy text on page, verify stored
- [ ] Copy multiple times, verify order (newest first)
- [ ] Close tab, verify history cleared
- [ ] Max 50 entries enforced

---

### 2.6 Clipboard in Popup
**Complexity:** Low | **Files:** `popup/popup.js`, `popup/popup.html`, `popup/popup.css`

**Implementation:**
- New tab/section in popup: "Clipboard"
- Show recent copies for current tab
- Click entry to copy back to clipboard
- "Clear history" button

**Verification:**
- [ ] View clipboard history in popup
- [ ] Click entry copies to clipboard
- [ ] Clear history works

---

### 2.7 Clipboard in Sidebar
**Complexity:** Low | **Files:** `sidebar/sidebar.js`, `sidebar/sidebar.html`
**Depends on:** 2.1 (Sidebar), 2.5 (Clipboard Tracking)

**Implementation:**
- Add "Clipboard" tab to sidebar
- Same functionality as popup clipboard section
- Convert clipboard entry to highlight with one click

**Verification:**
- [ ] View clipboard history in sidebar tab
- [ ] Convert clipboard entry to highlight
- [ ] Sync between popup and sidebar views

---

## Tier 3: Screenshot Capture & Annotate

**Goal:** Add ephemeral screenshot capture with annotation tools.
**Release:** v1.8
**Database Version:** No changes (screenshots are in-memory only)

**Design Philosophy:**
Screenshots are a **capture → annotate → export** workflow, not persistent storage.
- Captured screenshots live in memory only
- User annotates with drawing tools
- Export via copy-to-clipboard or download
- On editor close or tab navigation, screenshot is discarded
- No IndexedDB storage = no quota concerns, no data loss risks

---

### 3.1 Screenshot Capture
**Complexity:** Medium | **Files:** `background/background.js`, `content/content.js`

**Implementation:**
- Use `browser.tabs.captureVisibleTab()` for viewport capture
- Return as data URL (PNG)
- Handle high-DPI screens with `devicePixelRatio`
- Two capture modes:
  - **Element capture:** Screenshot annotation element + padding
  - **Area selection:** User draws rectangle to define capture region

**Manifest Changes:**
```json
{
  "permissions": ["activeTab"]
}
```

**Verification:**
- [ ] Capture current viewport
- [ ] Verify image quality on regular and retina displays
- [ ] Works on various page types

---

### 3.2 Screenshot Editor UI
**Complexity:** High

**New Files:**
```
screenshot/
├── screenshot-editor.js    # Editor overlay + canvas logic
├── screenshot-editor.css   # Editor styling
```

**Implementation:**
- Full-screen overlay modal injected into page
- Canvas displaying captured screenshot
- Toolbar with annotation tools
- Action buttons: Copy, Download, Cancel
- ESC key closes editor (discards screenshot)

**Editor Layout:**
```
┌─────────────────────────────────────────────────────────────┐
│ Screenshot Editor                          [Copy] [Download] [×] │
├─────────────────────────────────────────────────────────────┤
│ Tools: [✏️ Pen] [▭ Rect] [○ Ellipse] [→ Arrow] [T Text] [↩ Undo] │
│ Color: [●][●][●][●][●]  Size: [S][M][L]                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│                                                             │
│                    [ Screenshot Canvas ]                    │
│                                                             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Verification:**
- [ ] Editor opens as overlay
- [ ] Screenshot displays correctly
- [ ] ESC closes and discards
- [ ] Canvas is interactive

---

### 3.3 Annotation Tools
**Complexity:** High | **Files:** `screenshot/screenshot-editor.js`

**Implementation:**
- **Pen/Draw:** Freehand drawing with configurable color and thickness
- **Rectangle:** Draw rectangle outlines (click-drag)
- **Ellipse:** Draw ellipse/circle outlines
- **Arrow:** Draw directional arrows (click start → drag to end)
- **Text:** Click to place text, type label
- **Highlighter:** Semi-transparent wide brush
- **Undo/Redo:** History stack for all drawing operations

**Tool State:**
```javascript
// In-memory only, no persistence
let canvasState = {
  image: null,           // Original captured image
  history: [],           // Array of canvas states for undo
  historyIndex: -1,      // Current position in history
  currentTool: 'pen',
  currentColor: '#FF0000',
  strokeWidth: 3
};
```

**Verification:**
- [ ] Pen draws freehand lines
- [ ] Rectangle draws on drag
- [ ] Arrow draws with arrowhead
- [ ] Text input works
- [ ] Undo reverts last action
- [ ] Redo restores undone action
- [ ] Color picker changes stroke color
- [ ] Stroke width changes line thickness

---

### 3.4 Export Actions
**Complexity:** Medium | **Files:** `screenshot/screenshot-editor.js`

**Implementation:**
- **Copy to clipboard:**
  ```javascript
  async function copyToClipboard() {
    const blob = await canvasToBlob(canvas, 'image/png');
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
  }
  ```
- **Download as file:**
  ```javascript
  function downloadScreenshot() {
    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `screenshot-${Date.now()}.png`;
    link.href = dataUrl;
    link.click();
  }
  ```
- **Cancel:** Close editor, discard canvas (garbage collected)

**Verification:**
- [ ] Copy puts PNG in clipboard
- [ ] Paste works in other apps (Slack, Docs, etc.)
- [ ] Download saves PNG file
- [ ] Cancel closes editor without saving

---

### 3.5 Integration Points
**Complexity:** Medium | **Files:** `sidebar/sidebar.js`, `popup/popup.html`, `popup/popup.js`, `content/content.js`, `manifest.json`

**Trigger Points:**
- **Context menu:** "Capture Screenshot" (right-click anywhere)
- **Sidebar:** Screenshot button per annotation (captures that element)
- **Popup:** "Capture Area" button
- **Keyboard shortcut:** Alt+X

**Manifest Changes:**
```json
{
  "commands": {
    "capture-screenshot": {
      "suggested_key": { "default": "Alt+X" },
      "description": "Capture screenshot"
    }
  }
}
```

**Verification:**
- [ ] Context menu triggers area selection
- [ ] Sidebar button captures annotation element
- [ ] Popup button triggers area selection
- [ ] Alt+X keyboard shortcut works

---

### 3.5 PDF Detection
**Complexity:** Low | **Files:** `content/content.js`

**Implementation:**
- Detect PDF viewing contexts:
  - URL ends with `.pdf`
  - Content-Type header (via background fetch)
  - Firefox pdf.js viewer (`resource://pdf.js/`)
  - `<embed type="application/pdf">`
- Set flag: `window.annotateProPdfMode = true`

**Verification:**
- [ ] Detect local PDF file
- [ ] Detect PDF URL
- [ ] Detect embedded PDF
- [ ] Detect Firefox pdf.js viewer

---

### 3.6 PDF Overlay System
**Complexity:** Very High | **Files:** `content/content.js`

**New Files:**
```
pdf/
├── pdf-overlay.js   # Overlay management
├── pdf-overlay.css  # Overlay styles
```

**Implementation:**
- Create transparent overlay div over PDF canvas
- Position overlay to match PDF viewer dimensions
- Handle zoom changes (re-position overlay)
- Handle page changes in multi-page PDFs
- Store annotations with page number

**Schema Additions:**
```javascript
// Add to annotations for PDF:
{
  pdfMode: true,
  pdfPage: number,
  pdfCoordinates: {
    x: number,      // percentage of page width
    y: number,      // percentage of page height
    width: number,
    height: number
  }
}
```

**Challenges:**
- Firefox pdf.js uses `resource://` protocol with access restrictions
- Coordinate systems vary between zoom levels
- Canvas-based renderers don't have selectable text

**Verification:**
- [ ] Overlay positions correctly over PDF
- [ ] Overlay adjusts on zoom
- [ ] Annotations persist per page

---

### 3.7 PDF Annotation Persistence
**Complexity:** Very High | **Files:** `pdf/pdf-overlay.js`, `background/indexeddb-helper.js`

**Implementation:**
- Store PDF annotations with relative coordinates
- Reattach annotations when PDF reopens
- Handle page navigation within PDF
- Support highlight and checkbox types

**Verification:**
- [ ] Add highlight to PDF page 3
- [ ] Close and reopen PDF
- [ ] Navigate to page 3, see annotation
- [ ] Annotation position correct at different zoom

---

## Tier 4: Subscription System

**Goal:** Add authentication and payment processing.
**Release:** v2.0
**Can start in parallel after:** Tier 0

### 4.1 Supabase Auth Setup
**Complexity:** High

**New Files:**
```
lib/
└── supabase.js       # Supabase client singleton

auth/
├── auth.js           # Auth functions
```

**Implementation:**
- Initialize Supabase client with anon key
- Sign up with email/password
- Sign in with email/password
- Sign in with Google OAuth
- Store session in `browser.storage.local`
- Auto-refresh session tokens

**Supabase Tables:**
```sql
-- profiles (auto-created via trigger on auth.users)
CREATE TABLE profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  email TEXT,
  trial_start TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can read own profile"
  ON profiles FOR SELECT USING (auth.uid() = id);
```

**Manifest Changes:**
```json
{
  "permissions": ["identity"],
  "host_permissions": [
    "https://YOUR_PROJECT.supabase.co/*"
  ]
}
```

**Verification:**
- [ ] Sign up with email
- [ ] Sign in with email
- [ ] Sign in with Google
- [ ] Session persists across browser restart
- [ ] Sign out clears session

---

### 4.2 Trial Management
**Complexity:** Medium | **Files:** `auth/auth.js`, `auth/subscription.js`

**Implementation:**
- Trial starts on first sign-up (3 days)
- Check trial status: `trial_start + 3 days > now`
- Show trial days remaining in popup/settings
- Trial expired → show paywall

**Functions:**
```javascript
async function getTrialStatus() {
  const { data: profile } = await supabase
    .from('profiles')
    .select('trial_start')
    .single();

  const trialEnd = new Date(profile.trial_start);
  trialEnd.setDate(trialEnd.getDate() + 3);

  return {
    isActive: trialEnd > new Date(),
    daysRemaining: Math.ceil((trialEnd - new Date()) / (1000 * 60 * 60 * 24))
  };
}
```

**Verification:**
- [ ] New user gets 3-day trial
- [ ] Trial countdown displays correctly
- [ ] Trial expiration triggers paywall

---

### 4.3 Stripe Integration
**Complexity:** High

**New Files:**
```
supabase/functions/
├── create-checkout/index.ts   # Create Stripe checkout session
└── stripe-webhook/index.ts    # Handle Stripe webhooks
```

**Supabase Tables:**
```sql
CREATE TABLE subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES profiles(id),
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT,  -- 'active', 'canceled', 'past_due'
  plan TEXT,    -- 'monthly', 'annual', 'lifetime'
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

**Stripe Products:**
- Monthly: $3/month recurring
- Annual: $30/year recurring
- Lifetime: $60-99 one-time

**Checkout Flow:**
1. User clicks "Subscribe" → call `create-checkout` function
2. Redirect to Stripe Checkout
3. On success, Stripe webhook updates `subscriptions` table
4. Extension checks subscription status

**Verification:**
- [ ] Create checkout session
- [ ] Complete test payment
- [ ] Webhook creates subscription record
- [ ] Subscription status reflects in extension

---

### 4.4 Feature Gating
**Complexity:** Medium | **Files:** `background/background.js`, `auth/subscription.js`

**Free Features:**
- Highlights, checkboxes, page notes (with 4 default colors)
- JSON export
- Basic search

**Pro Features (require active subscription or trial):**
- Markdown export
- Custom named colors (beyond defaults)
- Sidebar
- Clipboard history
- Screenshots
- PDF annotations

**Implementation:**
```javascript
async function canAccessFeature(feature) {
  const proFeatures = ['markdown-export', 'custom-colors', 'sidebar', 'clipboard', 'screenshots', 'pdf'];

  if (!proFeatures.includes(feature)) return true;

  const subscription = await getSubscriptionStatus();
  const trial = await getTrialStatus();

  return subscription.isActive || trial.isActive;
}

// Usage in message handlers:
case 'ADD_COLOR':
  // Allow if it's a default color action, block if creating new custom color
  if (!await canAccessFeature('custom-colors')) {
    return { error: 'PRO_REQUIRED', feature: 'custom-colors' };
  }
  // ... proceed with color creation
```

**Verification:**
- [ ] Free user can use basic features with default colors
- [ ] Free user blocked from creating custom colors
- [ ] Trial user can access Pro features
- [ ] Subscribed user can access Pro features
- [ ] Paywall shown when Pro feature blocked

---

### 4.5 Settings & Account Page
**Complexity:** Medium

**New Files:**
```
auth/
├── settings.html   # Settings page markup
├── settings.js     # Settings logic
├── settings.css    # Settings styles
```

**Features:**
- Account info (email, plan, billing date)
- Manage subscription (cancel, change plan)
- Sign out
- Export all data
- Delete account

**Verification:**
- [ ] View account details
- [ ] Cancel subscription
- [ ] Change plan
- [ ] Sign out
- [ ] Delete account and data

---

## Release Schedule

| Version | Contents | Milestone |
|---------|----------|-----------|
| v1.4 | Markdown export, Search | Tier 0 complete |
| v1.5 | Custom Named Colors | Tier 1 complete |
| v1.6 | Sidebar | Tier 2.1-2.4 complete |
| v1.7 | Clipboard history | Tier 2.5-2.7 complete |
| v1.8 | Screenshot capture & annotate (ephemeral) | Tier 3.1-3.5 complete |
| v1.9 | PDF annotations | Tier 3.6-3.8 complete |
| v2.0 | Subscription system | Tier 4 complete |

---

## Database Migration Path

| Version | Changes |
|---------|---------|
| DB v1 → v2 | Add `colors` store with defaults, migrate `intent`/`color` → `colorId`, add `by_color` index |
| DB v2 → v3 | Add PDF fields to annotations (screenshots are ephemeral, no DB storage) |

**Migration Code Pattern:**
```javascript
const DB_VERSION = 2;
const request = indexedDB.open('annotatepro-db', DB_VERSION);

request.onupgradeneeded = (event) => {
  const db = event.target.result;
  const oldVersion = event.oldVersion;
  const transaction = event.target.transaction;

  if (oldVersion < 2) {
    // v1 → v2: Custom Named Colors

    // 1. Create colors store
    const colorStore = db.createObjectStore('colors', { keyPath: 'id' });

    // 2. Seed default colors
    const DEFAULT_COLORS = [
      { id: 'default-action', name: 'Action', color: '#FFEB3B', isDefault: true, usageCount: 0, createdAt: Date.now() },
      { id: 'default-question', name: 'Question', color: '#64B5F6', isDefault: true, usageCount: 0, createdAt: Date.now() },
      { id: 'default-risk', name: 'Risk', color: '#EF5350', isDefault: true, usageCount: 0, createdAt: Date.now() },
      { id: 'default-reference', name: 'Reference', color: '#81C784', isDefault: true, usageCount: 0, createdAt: Date.now() },
    ];
    DEFAULT_COLORS.forEach(c => colorStore.add(c));

    // 3. Add colorId index to annotations
    const annotationStore = transaction.objectStore('annotations');
    annotationStore.createIndex('by_color', 'colorId');

    // 4. Migrate existing annotations (intent → colorId)
    // This requires cursor iteration in a separate transaction after upgrade
  }

  if (oldVersion < 3) {
    // v2 → v3: PDF annotation fields
    // No new stores needed - screenshots are ephemeral (in-memory only)
    // PDF annotations use existing annotations store with additional fields
  }
};

// Post-upgrade migration for existing annotation data
async function migrateAnnotationsToColorId() {
  const INTENT_TO_COLOR_ID = {
    'ACTION': 'default-action',
    'QUESTION': 'default-question',
    'RISK': 'default-risk',
    'REFERENCE': 'default-reference',
    'CUSTOM': 'default-action',  // fallback
    'DEFAULT': 'default-action'
  };

  // Iterate all annotations and update intent → colorId
  const annotations = await getAllAnnotations();
  for (const annotation of annotations) {
    if (annotation.intent && !annotation.colorId) {
      annotation.colorId = INTENT_TO_COLOR_ID[annotation.intent] || 'default-action';
      delete annotation.intent;
      delete annotation.color;
      await updateAnnotation(annotation);
    }
  }
}
```

---

## Quick Reference: File Changes by Tier

### Tier 0
- `popup/popup.js` - Markdown export button
- `popup/popup.html` - Export UI
- `dashboard/dashboard.js` - Bulk export, search, filters
- `dashboard/dashboard.html` - Search UI, filter chips
- `dashboard/dashboard.css` - Filter styles
- `background/indexeddb-helper.js` - Search method

### Tier 1
- `background/indexeddb-helper.js` - Colors store, migration, CRUD
- `background/background.js` - Color message handlers
- `content/content.js` - Color picker UI, modal updates
- `popup/popup.js` - Color display, manage colors UI
- `popup/popup.html` - Color management section
- `dashboard/dashboard.js` - Color filtering
- `styles/annotations.css` - Color picker styles

### Tier 2
- **New:** `sidebar/sidebar.html`, `sidebar.js`, `sidebar.css`, `sidebar-inject.js`
- `manifest.json` - Content scripts, web resources
- `content/content.js` - Copy event listener
- `background/background.js` - Clipboard store
- `popup/popup.js` - Clipboard section

### Tier 3
- **New:** `screenshot/screenshot-editor.js`, `screenshot-editor.css`
- **New:** `pdf/pdf-overlay.js`, `pdf-overlay.css`
- `manifest.json` - Screenshot capture permission, Alt+X command
- `background/background.js` - captureVisibleTab handler
- `content/content.js` - Area selection overlay, PDF detection
- `sidebar/sidebar.js` - Screenshot button per annotation
- `popup/popup.js` - Capture Area button

### Tier 4
- **New:** `lib/supabase.js`
- **New:** `auth/auth.js`, `subscription.js`, `settings.html`, `settings.js`, `settings.css`
- **New:** `supabase/functions/create-checkout/`, `stripe-webhook/`
- `manifest.json` - Permissions, host permissions
- `background/background.js` - Feature gating
- `popup/popup.js` - Trial status, account section
