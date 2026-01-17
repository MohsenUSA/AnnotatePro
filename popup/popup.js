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
  CLEAR_PAGE_ANNOTATIONS: 'CLEAR_PAGE_ANNOTATIONS'
};

const INTENT_COLORS = {
  ACTION: 'rgba(255, 235, 59, 0.5)',
  QUESTION: 'rgba(100, 181, 246, 0.5)',
  RISK: 'rgba(239, 83, 80, 0.5)',
  REFERENCE: 'rgba(129, 199, 132, 0.5)',
  CUSTOM: 'rgba(206, 147, 216, 0.5)',
  DEFAULT: 'rgba(255, 235, 59, 0.5)'
};

const COLOR_PRESETS = [
  { name: 'Yellow', value: 'rgba(255, 235, 59, 0.5)' },
  { name: 'Blue', value: 'rgba(100, 181, 246, 0.5)' },
  { name: 'Red', value: 'rgba(239, 83, 80, 0.5)' },
  { name: 'Green', value: 'rgba(129, 199, 132, 0.5)' },
  { name: 'Purple', value: 'rgba(206, 147, 216, 0.5)' }
];

let currentTab = null;
let pageAnnotations = [];
let activeNoteEditor = null;

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
    const color = annotation.color || INTENT_COLORS[annotation.intent] || INTENT_COLORS.DEFAULT;
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

  const currentColor = annotation.color || INTENT_COLORS[annotation.intent] || INTENT_COLORS.DEFAULT;
  const isCheckbox = annotation.annotationType === 'checkbox';
  const isPageNote = annotation.annotationType === 'page-note';
  const hasNoColor = !annotation.color || annotation.color === 'transparent';

  // Create editor
  const editorEl = document.createElement('div');
  editorEl.className = 'annotation-note-editor';
  editorEl.innerHTML = `
    ${!isPageNote ? `
    <div class="color-picker">
      ${COLOR_PRESETS.map(c => `
        <button class="color-swatch ${c.value === currentColor ? 'active' : ''}"
                data-color="${c.value}"
                title="${c.name}"
                style="background: ${c.value}"></button>
      `).join('')}
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
      const newColor = swatch.dataset.color;

      // Update active state
      editorEl.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');

      // Save color
      try {
        statusEl.textContent = 'Saving...';
        await browser.runtime.sendMessage({
          type: MessageType.UPDATE_ANNOTATION,
          payload: { id: annotation.id, patch: { color: newColor } }
        });
        annotation.color = newColor;

        // Update color indicator in list
        item.querySelector('.annotation-color').style.background = newColor;

        // Tell content script to update
        try {
          await browser.tabs.sendMessage(currentTab.id, {
            type: 'COMMAND_UPDATE_COLOR',
            annotationId: annotation.id,
            color: newColor
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
    const pageNotes = pageAnnotations.filter(a => a.annotationType === 'page-note').length;

    document.getElementById('page-highlights').textContent = highlights;
    document.getElementById('page-checkboxes').textContent = checkboxes;
    document.getElementById('page-notes').textContent = pageNotes;
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

  // Intent buttons
  document.querySelectorAll('.intent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const intent = btn.dataset.intent;
      await sendCommand('COMMAND_HIGHLIGHT', { intent }, 1000);
      window.close();
    });
  });

  // All Pages button - open dashboard
  document.getElementById('btn-all-pages').addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });

  // Load data asynchronously (non-blocking)
  loadPopupData();
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

    currentTab = await getCurrentTab();

    // Check if we can access this tab
    const isAccessibleUrl = currentTab?.url &&
      !currentTab.url.startsWith('about:') &&
      !currentTab.url.startsWith('moz-extension:') &&
      !currentTab.url.startsWith('chrome:') &&
      !currentTab.url.startsWith('file:');

    if (isAccessibleUrl) {
      // Run these in parallel for faster loading
      await Promise.all([
        loadAnnotations(),
        checkSelection()
      ]);
    } else {
      // Show message for inaccessible pages
      document.getElementById('section-quick-actions').style.display = 'none';
      document.getElementById('section-intents').style.display = 'none';
      document.getElementById('section-no-selection').innerHTML = '<p class="no-selection-msg">Annotations not available on this page</p>';
      document.getElementById('section-no-selection').style.display = '';
    }

    // Update storage info (non-critical, do last)
    updateStorageInfo();
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
