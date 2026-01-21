/**
 * AnnotatePro Popup Script
 */

const MessageType = {
  ADD_ANNOTATION: 'ADD_ANNOTATION',
  UPDATE_ANNOTATION: 'UPDATE_ANNOTATION',
  DELETE_ANNOTATION: 'DELETE_ANNOTATION',
  GET_PAGE_ANNOTATIONS: 'GET_PAGE_ANNOTATIONS',
  GET_ALL_ANNOTATIONS: 'GET_ALL_ANNOTATIONS',
  GET_ANNOTATION_COUNT: 'GET_ANNOTATION_COUNT',
  CLEAR_PAGE_ANNOTATIONS: 'CLEAR_PAGE_ANNOTATIONS',
  GET_ALL_COLORS: 'GET_ALL_COLORS'
};

// Legacy intent colors for backwards compatibility
const INTENT_COLORS = {
  ACTION: 'rgba(255, 235, 59, 0.5)',
  QUESTION: 'rgba(100, 181, 246, 0.5)',
  RISK: 'rgba(239, 83, 80, 0.5)',
  REFERENCE: 'rgba(129, 199, 132, 0.5)',
  CUSTOM: 'rgba(206, 147, 216, 0.5)',
  DEFAULT: 'rgba(255, 235, 59, 0.5)'
};

// Legacy intent names for backwards compatibility
const INTENT_NAMES = {
  ACTION: 'Action (Yellow)',
  QUESTION: 'Question (Blue)',
  RISK: 'Risk (Red)',
  REFERENCE: 'Reference (Green)',
  CUSTOM: 'Custom (Purple)',
  DEFAULT: 'Action (Yellow)'
};

let currentTab = null;
let pageAnnotations = [];
let activeNoteEditor = null;
let cachedColors = [];

/**
 * Convert hex color to rgba
 */
function hexToRgba(hex, alpha = 0.5) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    const r = parseInt(result[1], 16);
    const g = parseInt(result[2], 16);
    const b = parseInt(result[3], 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
  return hex;
}

/**
 * Get color by ID from cache
 */
function getColorById(colorId) {
  return cachedColors.find(c => c.id === colorId);
}

/**
 * Get display color for an annotation (prefers colorId, falls back to legacy)
 */
function getAnnotationColor(annotation) {
  const { colorId, color, intent } = annotation;

  // If explicit color is set (including transparent), use it
  if (color) return color;

  // If colorId is set, get color from cache
  if (colorId) {
    const colorObj = getColorById(colorId);
    if (colorObj) {
      return hexToRgba(colorObj.color, 0.5);
    }
  }

  // Legacy fallback: use intent
  if (intent && INTENT_COLORS[intent]) {
    return INTENT_COLORS[intent];
  }

  return INTENT_COLORS.DEFAULT;
}

/**
 * Get color name for an annotation
 */
function getAnnotationColorName(annotation) {
  const { colorId, intent } = annotation;

  // If colorId is set, get color name from cache
  if (colorId) {
    const colorObj = getColorById(colorId);
    if (colorObj) {
      return colorObj.name;
    }
  }

  // Legacy fallback: use intent name
  if (intent && INTENT_NAMES[intent]) {
    return INTENT_NAMES[intent];
  }

  return 'Default';
}

/**
 * Load colors from the database
 */
async function loadColors() {
  try {
    cachedColors = await browser.runtime.sendMessage({
      type: MessageType.GET_ALL_COLORS,
      payload: {}
    });
    cachedColors.sort((a, b) => a.sortOrder - b.sortOrder);
  } catch (error) {
    console.error('Failed to load colors:', error);
    cachedColors = [];
  }
}

/**
 * Get the current active tab
 */
async function getCurrentTab() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

/**
 * Get page URL from tab
 */
function getPageUrl(tab) {
  return tab.url.split('#')[0];
}

/**
 * Render annotation list
 */
function renderAnnotationList() {
  const listEl = document.getElementById('annotation-list');
  const emptyEl = document.getElementById('empty-state');

  // Clear existing items (except empty state)
  const items = listEl.querySelectorAll('.annotation-item');
  items.forEach(item => item.remove());

  if (pageAnnotations.length === 0) {
    emptyEl.style.display = 'block';
    return;
  }

  emptyEl.style.display = 'none';

  // Sort annotations: page notes first, then by updated time
  const sortedAnnotations = [...pageAnnotations].sort((a, b) => {
    if (a.annotationType === 'page-note' && b.annotationType !== 'page-note') return -1;
    if (a.annotationType !== 'page-note' && b.annotationType === 'page-note') return 1;
    return (b.updatedAt || 0) - (a.updatedAt || 0);
  });

  for (const annotation of sortedAnnotations) {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.dataset.id = annotation.id;

    const isPageNote = annotation.annotationType === 'page-note';
    const color = getAnnotationColor(annotation);
    const text = isPageNote ? 'Page Note' : (annotation.textSnapshot || '(no text)');
    const isCheckbox = annotation.annotationType === 'checkbox';
    const hasNote = annotation.note && annotation.note.trim().length > 0;

    item.innerHTML = `
      ${isPageNote ? '<span class="annotation-icon">📄</span>' : `<span class="annotation-color" style="background: ${color}"></span>`}
      <div class="annotation-main">
        <span class="annotation-text" title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 50))}${text.length > 50 ? '...' : ''}</span>
        ${hasNote ? '<span class="annotation-note-indicator" title="Has note">📝</span>' : ''}
      </div>
      ${isCheckbox ? `<input type="checkbox" class="popup-checkbox" ${annotation.checked ? 'checked' : ''} title="Toggle checkbox">` : ''}
      <button class="annotation-delete" title="Delete annotation">&times;</button>
    `;

    // Click on main area to edit note
    item.querySelector('.annotation-main').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleNoteEditor(item, annotation);
    });

    // Checkbox toggle handler
    const checkboxEl = item.querySelector('.popup-checkbox');
    if (checkboxEl) {
      checkboxEl.addEventListener('change', async (e) => {
        e.stopPropagation();
        const isChecked = e.target.checked;
        await browser.runtime.sendMessage({
          type: MessageType.UPDATE_ANNOTATION,
          payload: { id: annotation.id, patch: { checked: isChecked } }
        });
        annotation.checked = isChecked;

        // Tell content script to update checkbox on page
        try {
          await browser.tabs.sendMessage(currentTab.id, {
            type: 'COMMAND_UPDATE_CHECKBOX',
            annotationId: annotation.id,
            checked: isChecked
          });
        } catch (e) {}
      });
    }

    // Delete button handler
    item.querySelector('.annotation-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Delete this annotation?')) return;
      await deleteAnnotation(annotation.id);
    });

    listEl.appendChild(item);
  }
}

/**
 * Toggle note editor for an annotation item
 */
function toggleNoteEditor(item, annotation) {
  // If already editing this item, close it
  if (activeNoteEditor?.annotationId === annotation.id) {
    closeNoteEditor();
    return;
  }

  // Close any existing editor
  closeNoteEditor();

  const currentColor = getAnnotationColor(annotation);
  const isCheckbox = annotation.annotationType === 'checkbox';
  const isPageNote = annotation.annotationType === 'page-note';
  const hasNoColor = currentColor === 'transparent' || !annotation.colorId;

  // Build color swatches from cached colors
  const colorSwatches = cachedColors.map(c => {
    const colorValue = hexToRgba(c.color, 0.5);
    const isActive = c.id === annotation.colorId || colorValue === currentColor;
    return `
      <button class="color-swatch ${isActive ? 'active' : ''}"
              data-color-id="${c.id}"
              data-color="${colorValue}"
              title="${c.name}"
              style="background: ${colorValue}"></button>
    `;
  }).join('');

  // Create editor
  const editorEl = document.createElement('div');
  editorEl.className = 'annotation-note-editor';
  editorEl.innerHTML = `
    ${!isPageNote ? `
    <div class="color-picker">
      ${colorSwatches}
      ${isCheckbox ? `<button class="color-swatch color-clear ${hasNoColor ? 'active' : ''}" data-color="transparent" title="No color">&times;</button>` : ''}
    </div>
    ` : ''}
    <div class="note-toolbar">
      <button class="note-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
      <button class="note-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
    </div>
    <textarea class="note-textarea"
              placeholder="Add a note..."
              autocapitalize="sentences"
              rows="2">${escapeHtml(annotation.note || '')}</textarea>
    <div class="note-editor-footer">
      <span class="note-status"></span>
    </div>
  `;

  item.appendChild(editorEl);
  item.classList.add('editing');

  const textarea = editorEl.querySelector('.note-textarea');
  const statusEl = editorEl.querySelector('.note-status');

  // Color swatch click handlers
  editorEl.querySelectorAll('.color-swatch').forEach(swatch => {
    swatch.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newColorId = swatch.dataset.colorId;
      const newColor = swatch.dataset.color;

      // Update active state
      editorEl.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');

      // Build patch - use colorId if available, otherwise color (for transparent)
      const patch = newColorId ? { colorId: newColorId, color: null } : { colorId: null, color: newColor };

      // Save color
      try {
        statusEl.textContent = 'Saving...';
        await browser.runtime.sendMessage({
          type: MessageType.UPDATE_ANNOTATION,
          payload: { id: annotation.id, patch }
        });
        annotation.colorId = newColorId || null;
        annotation.color = newColorId ? null : newColor;

        // Update color indicator in list
        const displayColor = newColorId ? hexToRgba(getColorById(newColorId)?.color || '#FFEB3B', 0.5) : newColor;
        const colorIndicator = item.querySelector('.annotation-color');
        if (colorIndicator) {
          colorIndicator.style.background = displayColor;
        }

        // Tell content script to update
        try {
          await browser.tabs.sendMessage(currentTab.id, {
            type: 'COMMAND_UPDATE_COLOR',
            annotationId: annotation.id,
            color: displayColor
          });
        } catch (e) {}

        statusEl.textContent = 'Saved!';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      } catch (err) {
        statusEl.textContent = 'Error';
        console.error('Failed to save color:', err);
      }
    });
  });

  // Toolbar button handlers
  editorEl.querySelectorAll('.note-toolbar-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const action = btn.dataset.action;
      insertNoteFormat(textarea, action);
      textarea.focus();
    });
  });

  activeNoteEditor = {
    annotationId: annotation.id,
    element: editorEl,
    item: item,
    originalNote: annotation.note || ''
  };

  setupAutoCapitalize(textarea);
  textarea.focus();

  // Auto-save with debounce
  let saveTimer;
  textarea.addEventListener('input', () => {
    statusEl.textContent = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveNote(annotation, textarea, statusEl, item), 500);
  });
}

/**
 * Save note for an annotation
 */
async function saveNote(annotation, textarea, statusEl, item) {
  try {
    statusEl.textContent = 'Saving...';
    await browser.runtime.sendMessage({
      type: MessageType.UPDATE_ANNOTATION,
      payload: { id: annotation.id, patch: { note: textarea.value } }
    });
    statusEl.textContent = 'Saved!';
    annotation.note = textarea.value; // Update local reference

    // Update note indicator in popup
    updateNoteIndicator(item, textarea.value);

    // Tell content script to update note badge on the page
    try {
      await browser.tabs.sendMessage(currentTab.id, {
        type: 'COMMAND_UPDATE_NOTE_BADGE',
        annotationId: annotation.id,
        note: textarea.value
      });
    } catch (e) {
      // Content script may not be loaded on this page
    }

    setTimeout(() => { statusEl.textContent = ''; }, 1500);
  } catch (err) {
    statusEl.textContent = 'Error';
    console.error('Failed to save note:', err);
  }
}

/**
 * Update note indicator visibility
 */
function updateNoteIndicator(item, note) {
  const mainEl = item.querySelector('.annotation-main');
  let indicator = mainEl.querySelector('.annotation-note-indicator');

  if (note && note.trim().length > 0 && !indicator) {
    indicator = document.createElement('span');
    indicator.className = 'annotation-note-indicator';
    indicator.title = 'Has note';
    indicator.textContent = '📝';
    mainEl.appendChild(indicator);
  } else if ((!note || note.trim().length === 0) && indicator) {
    indicator.remove();
  }
}

/**
 * Close the active note editor
 */
function closeNoteEditor() {
  if (activeNoteEditor) {
    activeNoteEditor.element.remove();
    activeNoteEditor.item.classList.remove('editing');
    activeNoteEditor = null;
  }
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Auto-capitalize first letter of textarea
 */
function setupAutoCapitalize(textarea) {
  textarea.addEventListener('input', () => {
    const val = textarea.value;
    if (val.length === 1 && val[0] !== val[0].toUpperCase()) {
      const start = textarea.selectionStart;
      textarea.value = val[0].toUpperCase() + val.slice(1);
      textarea.selectionStart = textarea.selectionEnd = start;
    }
  });
}

/**
 * Insert bullet or checkbox prefix at cursor position in textarea
 */
function insertNoteFormat(textarea, format) {
  const prefix = format === 'bullet' ? '- ' : '[] ';
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;

  // Find the start of the current line
  let lineStart = start;
  while (lineStart > 0 && value[lineStart - 1] !== '\n') {
    lineStart--;
  }

  // Check if line already has this prefix
  const lineContent = value.slice(lineStart, end);
  const bulletMatch = lineContent.match(/^- /);
  const checkboxMatch = lineContent.match(/^\[[x ]?\] /);

  if ((format === 'bullet' && bulletMatch) || (format === 'checkbox' && checkboxMatch)) {
    // Remove existing prefix
    const prefixLen = bulletMatch ? 2 : (checkboxMatch[0].length);
    textarea.value = value.slice(0, lineStart) + value.slice(lineStart + prefixLen);
    textarea.selectionStart = textarea.selectionEnd = start - prefixLen;
  } else {
    // Insert prefix at line start
    textarea.value = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    textarea.selectionStart = textarea.selectionEnd = start + prefix.length;
  }

  // Trigger input event for auto-save
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Delete annotation
 */
async function deleteAnnotation(id) {
  try {
    // Delete from database
    await browser.runtime.sendMessage({
      type: MessageType.DELETE_ANNOTATION,
      payload: { id }
    });

    // Tell content script to remove from DOM
    await browser.tabs.sendMessage(currentTab.id, {
      type: 'COMMAND_DELETE_BY_ID',
      annotationId: id
    });

    // Update local list and re-render
    pageAnnotations = pageAnnotations.filter(a => a.id !== id);
    renderAnnotationList();
    updateStats();
  } catch (error) {
    console.error('Failed to delete annotation:', error);
  }
}

/**
 * Update stats display
 */
async function updateStats() {
  try {
    // Get total count
    const totalCount = await browser.runtime.sendMessage({
      type: MessageType.GET_ANNOTATION_COUNT
    });

    // Update UI
    document.getElementById('count').textContent = totalCount;

    const highlights = pageAnnotations.filter(a => a.annotationType === 'highlight').length;
    const checkboxes = pageAnnotations.filter(a => a.annotationType === 'checkbox').length;
    const pageNotes = pageAnnotations.filter(a => a.annotationType === 'page-note');

    document.getElementById('page-highlights').textContent = highlights;
    document.getElementById('page-checkboxes').textContent = checkboxes;
    document.getElementById('page-notes').textContent = pageNotes.length;

    // Update page note indicator
    const hasPageNote = pageNotes.some(a => a.note && a.note.trim());
    document.getElementById('page-note-indicator').classList.toggle('visible', hasPageNote);
  } catch (error) {
    console.error('Failed to update stats:', error);
  }
}

/**
 * Load annotations for current page
 */
async function loadAnnotations() {
  try {
    const pageUrl = getPageUrl(currentTab);

    pageAnnotations = await browser.runtime.sendMessage({
      type: MessageType.GET_PAGE_ANNOTATIONS,
      payload: { pageUrl }
    });

    renderAnnotationList();
    await updateStats();
  } catch (error) {
    console.error('Failed to load annotations:', error);
  }
}

/**
 * Send command to content script with timeout
 */
async function sendCommand(command, data = {}, timeout = 500) {
  if (!currentTab?.id) return null;
  try {
    // Add timeout to prevent hanging
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), timeout)
    );
    const messagePromise = browser.tabs.sendMessage(currentTab.id, { type: command, ...data });
    return await Promise.race([messagePromise, timeoutPromise]);
  } catch (error) {
    // Don't log timeout errors - they're expected on some pages
    if (error.message !== 'Timeout') {
      console.error('Failed to send command:', command, error);
    }
    return null;
  }
}

/**
 * Check if there's a text selection on the page
 */
async function checkSelection() {
  const quickActionsEl = document.getElementById('section-quick-actions');
  const intentsEl = document.getElementById('section-intents');
  const noSelectionEl = document.getElementById('section-no-selection');

  try {
    const hasSelection = await sendCommand('COMMAND_CHECK_SELECTION');

    if (hasSelection) {
      quickActionsEl.style.display = '';
      intentsEl.style.display = '';
      noSelectionEl.style.display = 'none';
    } else {
      quickActionsEl.style.display = 'none';
      intentsEl.style.display = 'none';
      noSelectionEl.style.display = '';
    }
  } catch (error) {
    console.error('Failed to check selection:', error);
    // Hide action buttons on error
    quickActionsEl.style.display = 'none';
    intentsEl.style.display = 'none';
    noSelectionEl.style.display = '';
  }
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

/**
 * Update storage usage display
 */
async function updateStorageInfo() {
  const storageEl = document.getElementById('storage-value');
  const storageInfoEl = document.getElementById('storage-info');
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage || 0;
      const quota = estimate.quota || 0;
      const percent = quota > 0 ? ((used / quota) * 100).toFixed(1) : 0;

      storageEl.textContent = formatBytes(used);
      storageInfoEl.title = `${formatBytes(used)} of ${formatBytes(quota)} (${percent}% used)`;
    } else {
      storageEl.textContent = 'N/A';
    }
  } catch (error) {
    console.error('Failed to get storage estimate:', error);
    storageEl.textContent = 'N/A';
  }
}

/**
 * Export annotations on current page to Markdown file
 */
function exportToMarkdown() {
  if (pageAnnotations.length === 0) {
    alert('No annotations to export on this page.');
    return;
  }

  const pageUrl = getPageUrl(currentTab);
  const pageTitle = currentTab.title || 'Untitled Page';
  const domain = new URL(pageUrl).hostname;

  // Group annotations by type
  const pageNotes = pageAnnotations.filter(a => a.annotationType === 'page-note');
  const highlights = pageAnnotations.filter(a => a.annotationType === 'highlight');
  const checkboxes = pageAnnotations.filter(a => a.annotationType === 'checkbox');

  // Group highlights by color
  const highlightsByColor = {};
  for (const h of highlights) {
    const colorName = getAnnotationColorName(h);
    if (!highlightsByColor[colorName]) {
      highlightsByColor[colorName] = [];
    }
    highlightsByColor[colorName].push(h);
  }

  // Build YAML frontmatter
  let md = `---
url: ${pageUrl}
title: ${pageTitle.replace(/:/g, ' -')}
exported: ${new Date().toISOString()}
annotations: ${pageAnnotations.length}
---

# ${pageTitle}

Source: [${domain}](${pageUrl})

`;

  // Page Notes section
  if (pageNotes.length > 0) {
    md += `## Page Notes\n`;
    for (const note of pageNotes) {
      if (note.note && note.note.trim()) {
        md += `- ${note.note.trim().replace(/\n/g, '\n  ')}\n`;
      }
    }
    md += `\n`;
  }

  // Highlights section
  if (highlights.length > 0) {
    md += `## Highlights\n\n`;
    for (const [colorName, items] of Object.entries(highlightsByColor)) {
      md += `### ${colorName}\n`;
      for (const h of items) {
        const text = h.textSnapshot || '(no text)';
        md += `- "${text}"\n`;
        if (h.note && h.note.trim()) {
          md += `  - Note: ${h.note.trim().replace(/\n/g, '\n    ')}\n`;
        }
      }
      md += `\n`;
    }
  }

  // Checkboxes section
  if (checkboxes.length > 0) {
    md += `## Checkboxes\n`;
    for (const cb of checkboxes) {
      const checked = cb.checked ? 'x' : ' ';
      const text = cb.textSnapshot || '(no text)';
      md += `- [${checked}] ${text}\n`;
      if (cb.note && cb.note.trim()) {
        md += `  - Note: ${cb.note.trim().replace(/\n/g, '\n    ')}\n`;
      }
    }
    md += `\n`;
  }

  // Download the markdown file
  const blob = new Blob([md], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const filename = `${pageTitle.slice(0, 50).replace(/[^a-zA-Z0-9]/g, '-')}-annotations.md`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Load clipboard history from content script
 */
async function loadClipboardHistory() {
  const clipboardListEl = document.getElementById('clipboard-list');
  const clipboardCountEl = document.getElementById('clipboard-count');
  const clipboardEmptyEl = document.getElementById('clipboard-empty');

  try {
    // Get clipboard history from content script
    const clipboardHistory = await browser.tabs.sendMessage(currentTab.id, {
      type: 'GET_CLIPBOARD_HISTORY'
    });

    if (!clipboardHistory || clipboardHistory.length === 0) {
      clipboardCountEl.textContent = '0';
      clipboardEmptyEl.style.display = '';
      return;
    }

    clipboardCountEl.textContent = clipboardHistory.length;
    clipboardEmptyEl.style.display = 'none';

    // Render clipboard items (show most recent 5)
    const itemsToShow = clipboardHistory.slice(0, 5);
    const itemsHtml = itemsToShow.map((entry, index) => {
      const truncatedText = entry.text.length > 80 ? entry.text.slice(0, 80) + '...' : entry.text;
      const timeAgo = formatRelativeTime(entry.timestamp);

      return `
        <div class="clipboard-item" data-index="${index}">
          <div class="clipboard-text">${escapeHtml(truncatedText)}</div>
          <div class="clipboard-meta">
            <span>${timeAgo}</span>
            <div class="clipboard-actions">
              <button class="clipboard-btn copy-btn" data-action="copy">Copy</button>
              <button class="clipboard-btn delete-btn" data-action="delete">&times;</button>
            </div>
          </div>
        </div>
      `;
    }).join('');

    clipboardListEl.innerHTML = itemsHtml;

    // Add click handlers for clipboard buttons
    clipboardListEl.querySelectorAll('.clipboard-btn').forEach(btnEl => {
      btnEl.addEventListener('click', async (e) => {
        e.stopPropagation();
        const action = btnEl.dataset.action;
        const index = parseInt(btnEl.closest('.clipboard-item').dataset.index);
        const entry = itemsToShow[index];

        if (action === 'copy' && entry) {
          await navigator.clipboard.writeText(entry.text);
          btnEl.textContent = 'Copied!';
          setTimeout(() => { btnEl.textContent = 'Copy'; }, 1500);
        } else if (action === 'delete') {
          if (!confirm('Delete this clipboard item?')) return;
          // Find and remove the entry from storage
          try {
            const { clipboardHistory: storedHistory = [] } = await browser.storage.local.get('clipboardHistory');
            const newHistory = storedHistory.filter(h =>
              !(h.text === entry.text && h.timestamp === entry.timestamp)
            );
            await browser.storage.local.set({ clipboardHistory: newHistory });
            // Reload the list
            loadClipboardHistory();
          } catch (err) {
            console.error('Failed to delete clipboard item:', err);
          }
        }
      });
    });

  } catch (error) {
    console.error('Failed to load clipboard history:', error);
    clipboardCountEl.textContent = '0';
  }
}

/**
 * Format relative time
 */
function formatRelativeTime(timestamp) {
  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/**
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Initialize popup
 */
function init() {
  // Attach event listeners IMMEDIATELY so popup is interactive right away

  // Highlight button
  document.getElementById('btn-highlight').addEventListener('click', async () => {
    await sendCommand('COMMAND_HIGHLIGHT', {}, 1000);
    window.close();
  });

  // Checkbox button
  document.getElementById('btn-checkbox').addEventListener('click', async () => {
    await sendCommand('COMMAND_CHECKBOX', {}, 1000);
    window.close();
  });

  // Clear button
  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (pageAnnotations.length === 0) {
      return;
    }

    // Show the styled confirmation dialog in the content script
    await sendCommand('COMMAND_CLEAR_CONFIRM', {}, 1000);
    // Close popup - the content script will handle the rest
    window.close();
  });

  // Export to Markdown button
  document.getElementById('btn-export-md').addEventListener('click', () => {
    exportToMarkdown();
  });

  // Screenshot buttons
  document.getElementById('btn-capture-area').addEventListener('click', async () => {
    await sendCommand('COMMAND_CAPTURE_AREA', {}, 1000);
    window.close();
  });

  document.getElementById('btn-capture-visible').addEventListener('click', async () => {
    await sendCommand('COMMAND_CAPTURE_VISIBLE', {}, 1000);
    window.close();
  });

  document.getElementById('btn-capture-fullpage').addEventListener('click', async () => {
    await sendCommand('COMMAND_CAPTURE_FULL_PAGE', {}, 1000);
    window.close();
  });

  // Color/Intent buttons - map legacy intent to colorId
  document.querySelectorAll('.intent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const intent = btn.dataset.intent;
      // Map legacy intent to colorId
      const intentToColorId = {
        'ACTION': 'default-action',
        'QUESTION': 'default-question',
        'RISK': 'default-risk',
        'REFERENCE': 'default-reference'
      };
      const colorId = intentToColorId[intent] || 'default-action';
      await sendCommand('COMMAND_HIGHLIGHT', { colorId }, 1000);
      window.close();
    });
  });

  // All Pages button - open dashboard
  document.getElementById('btn-all-pages').addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });

  // Page note button
  document.getElementById('btn-page-note').addEventListener('click', async () => {
    if (currentTab) {
      await browser.tabs.sendMessage(currentTab.id, { type: 'COMMAND_PAGE_NOTE' });
      window.close();
    }
  });

  // Sidebar toggle button
  document.getElementById('btn-sidebar-toggle').addEventListener('click', async () => {
    const response = await sendCommand('COMMAND_TOGGLE_SIDEBAR', {}, 1000);
    if (response) {
      updateSidebarUI(response);
    }
  });

  // Sidebar position button
  document.getElementById('btn-sidebar-position').addEventListener('click', async () => {
    const response = await sendCommand('COMMAND_SWITCH_SIDEBAR_POSITION', {}, 1000);
    if (response) {
      updateSidebarUI(response);
    }
  });

  // Load data asynchronously (non-blocking)
  loadPopupData();
}

/**
 * Load sidebar state from content script and update UI
 */
async function loadSidebarState() {
  try {
    // Try to get state directly from the sidebar on the page
    const response = await sendCommand('GET_SIDEBAR_STATE', {}, 500);
    if (response) {
      updateSidebarUI(response);
    } else {
      // Fallback to storage if content script not available
      const result = await browser.storage.local.get('sidebarSettings');
      const settings = result.sidebarSettings || { collapsed: true, position: 'right' };
      updateSidebarUI(settings);
    }
  } catch (error) {
    console.error('Failed to load sidebar state:', error);
  }
}

/**
 * Update sidebar UI buttons based on state
 */
function updateSidebarUI(state) {
  const statusEl = document.getElementById('sidebar-status');
  const positionEl = document.getElementById('sidebar-position-target');

  if (statusEl) {
    statusEl.textContent = state.collapsed ? 'Show' : 'Hide';
  }
  if (positionEl) {
    positionEl.textContent = state.position === 'right' ? 'Left' : 'Right';
  }
}

/**
 * Wake up background script with a simple ping
 */
async function wakeBackground() {
  try {
    // Send a simple message to wake up the background script
    // GET_ANNOTATION_COUNT is lightweight and will initialize the DB
    await browser.runtime.sendMessage({ type: MessageType.GET_ANNOTATION_COUNT });
  } catch (error) {
    // Ignore errors - background might not be ready yet
  }
}

/**
 * Load popup data asynchronously
 */
async function loadPopupData() {
  try {
    // Wake up background script first (ensures DB is ready)
    await wakeBackground();

    // Load colors first so they're available for rendering
    await loadColors();

    currentTab = await getCurrentTab();

    // Check if we can access this tab
    const isAccessibleUrl = currentTab?.url &&
      !currentTab.url.startsWith('about:') &&
      !currentTab.url.startsWith('moz-extension:') &&
      !currentTab.url.startsWith('chrome:');

    if (isAccessibleUrl) {
      // Run these in parallel for faster loading
      await Promise.all([
        loadAnnotations(),
        checkSelection(),
        loadClipboardHistory()
      ]);
    } else {
      // Show message for inaccessible pages
      document.getElementById('section-quick-actions').style.display = 'none';
      document.getElementById('section-intents').style.display = 'none';
      document.getElementById('section-clipboard').style.display = 'none';
      document.getElementById('section-no-selection').innerHTML = '<p class="no-selection-msg">Annotations not available on this page</p>';
      document.getElementById('section-no-selection').style.display = '';
    }

    // Update storage info (non-critical, do last)
    updateStorageInfo();

    // Load sidebar state
    loadSidebarState();
  } catch (error) {
    console.error('Failed to load popup data:', error);
  }
}

/**
 * Handle realtime sync messages from background script
 */
function setupMessageListener() {
  browser.runtime.onMessage.addListener((message) => {
    if (!currentTab) return;

    const currentPageUrl = getPageUrl(currentTab);

    switch (message.type) {
      case 'ANNOTATION_ADDED':
        // Only update if annotation is for current page
        if (message.pageUrl === currentPageUrl && message.annotation) {
          pageAnnotations.push(message.annotation);
          renderAnnotationList();
          updateStats();
        }
        break;

      case 'ANNOTATION_UPDATED':
        if (message.pageUrl === currentPageUrl && message.annotationId) {
          const annotation = pageAnnotations.find(a => a.id === message.annotationId);
          if (annotation && message.patch) {
            Object.assign(annotation, message.patch);
            renderAnnotationList();
          }
        }
        break;

      case 'ANNOTATION_DELETED':
        if (message.pageUrl === currentPageUrl && message.annotationId) {
          pageAnnotations = pageAnnotations.filter(a => a.id !== message.annotationId);
          renderAnnotationList();
          updateStats();
        }
        break;

      case 'PAGE_CLEARED':
        if (message.pageUrl === currentPageUrl) {
          pageAnnotations = [];
          renderAnnotationList();
          updateStats();
        }
        break;

      case 'CHECKBOX_UPDATED':
        if (message.annotationId) {
          const annotation = pageAnnotations.find(a => a.id === message.annotationId);
          if (annotation) {
            annotation.checked = message.checked;
            // Update checkbox in list if visible
            const checkboxEl = document.querySelector(`.annotation-item[data-id="${message.annotationId}"] .popup-checkbox`);
            if (checkboxEl) {
              checkboxEl.checked = message.checked;
            }
          }
        }
        break;
    }
  });
}

// Start immediately - script is at end of body so DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    init();
    setupMessageListener();
  });
} else {
  init();
  setupMessageListener();
}
