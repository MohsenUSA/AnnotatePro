/**
 * AnnotatePro Popup Script
 */

const MessageType = {
  ADD_ANNOTATION: 'ADD_ANNOTATION',
  DELETE_ANNOTATION: 'DELETE_ANNOTATION',
  GET_PAGE_ANNOTATIONS: 'GET_PAGE_ANNOTATIONS',
  GET_ALL_ANNOTATIONS: 'GET_ALL_ANNOTATIONS',
  GET_ANNOTATION_COUNT: 'GET_ANNOTATION_COUNT',
  CLEAR_PAGE_ANNOTATIONS: 'CLEAR_PAGE_ANNOTATIONS'
};

const INTENT_COLORS = {
  ACTION: '#ffeb3b',
  QUESTION: '#64b5f6',
  RISK: '#ef5350',
  REFERENCE: '#81c784',
  CUSTOM: '#ce93d8',
  DEFAULT: '#ffeb3b'
};

let currentTab = null;
let pageAnnotations = [];

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

  for (const annotation of pageAnnotations) {
    const item = document.createElement('div');
    item.className = 'annotation-item';
    item.dataset.id = annotation.id;

    const color = annotation.color || INTENT_COLORS[annotation.intent] || INTENT_COLORS.DEFAULT;
    const text = annotation.textSnapshot || '(no text)';
    const type = annotation.annotationType === 'checkbox' ? '☑' : '';

    item.innerHTML = `
      <span class="annotation-color" style="background: ${color}"></span>
      <span class="annotation-text" title="${escapeHtml(text)}">${escapeHtml(text.slice(0, 50))}${text.length > 50 ? '...' : ''}</span>
      <span class="annotation-type">${type}</span>
      <button class="annotation-delete" title="Delete annotation">&times;</button>
    `;

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
 * Escape HTML to prevent XSS
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
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

    document.getElementById('page-highlights').textContent = highlights;
    document.getElementById('page-checkboxes').textContent = checkboxes;
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
 * Send command to content script
 */
async function sendCommand(command, data = {}) {
  return browser.tabs.sendMessage(currentTab.id, { type: command, ...data });
}

/**
 * Check if there's a text selection on the page
 */
async function checkSelection() {
  try {
    const hasSelection = await sendCommand('COMMAND_CHECK_SELECTION');
    const quickActionsEl = document.getElementById('section-quick-actions');
    const intentsEl = document.getElementById('section-intents');
    const noSelectionEl = document.getElementById('section-no-selection');

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
async function init() {
  currentTab = await getCurrentTab();
  await loadAnnotations();
  await checkSelection();
  updateStorageInfo();

  // Highlight button
  document.getElementById('btn-highlight').addEventListener('click', async () => {
    await sendCommand('COMMAND_HIGHLIGHT');
    window.close();
  });

  // Checkbox button
  document.getElementById('btn-checkbox').addEventListener('click', async () => {
    await sendCommand('COMMAND_CHECKBOX');
    window.close();
  });

  // Clear button
  document.getElementById('btn-clear').addEventListener('click', async () => {
    if (pageAnnotations.length === 0) {
      return;
    }

    if (confirm(`Delete all ${pageAnnotations.length} annotations on this page?\n\nThis cannot be undone.`)) {
      const pageUrl = getPageUrl(currentTab);

      await browser.runtime.sendMessage({
        type: MessageType.CLEAR_PAGE_ANNOTATIONS,
        payload: { pageUrl }
      });

      // Tell content script to reload (clear DOM)
      await sendCommand('COMMAND_RELOAD_ANNOTATIONS');

      // Update local state
      pageAnnotations = [];
      renderAnnotationList();
      await updateStats();
    }
  });

  // Intent buttons
  document.querySelectorAll('.intent-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const intent = btn.dataset.intent;
      await sendCommand('COMMAND_HIGHLIGHT', { intent });
      window.close();
    });
  });

  // All Pages button - open dashboard
  document.getElementById('btn-all-pages').addEventListener('click', () => {
    browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
    window.close();
  });
}

// Start
document.addEventListener('DOMContentLoaded', init);
