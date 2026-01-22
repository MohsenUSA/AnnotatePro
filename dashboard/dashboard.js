/**
 * Dashboard Script for AnnotatePro
 * Shows all pages with annotations
 */

(function() {
  'use strict';

  let allPages = [];
  let currentSort = 'recent';
  let searchQuery = '';
  let activeView = 'all'; // 'all', 'pages', or 'annotations'
  let searchResults = [];
  let activeFilters = { types: [], colorIds: [], dateRange: null };
  let searchDebounceTimer = null;
  let cachedColors = [];

  // Legacy intent names for backwards compatibility
  const INTENT_NAMES = {
    ACTION: 'Action (Yellow)',
    QUESTION: 'Question (Blue)',
    RISK: 'Risk (Red)',
    REFERENCE: 'Reference (Green)',
    CUSTOM: 'Custom (Purple)',
    DEFAULT: 'Action (Yellow)'
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
    if (color) return color;
    if (colorId) {
      const colorObj = getColorById(colorId);
      if (colorObj) return hexToRgba(colorObj.color, 0.5);
    }
    if (intent && INTENT_COLORS[intent]) return INTENT_COLORS[intent];
    return INTENT_COLORS.DEFAULT;
  }

  /**
   * Get color name for an annotation
   */
  function getAnnotationColorName(annotation) {
    const { colorId, intent } = annotation;
    if (colorId) {
      const colorObj = getColorById(colorId);
      if (colorObj) return colorObj.name;
    }
    if (intent && INTENT_NAMES[intent]) return INTENT_NAMES[intent];
    return 'Default';
  }

  /**
   * Load colors from the database
   */
  async function loadColors() {
    try {
      cachedColors = await sendMessage('GET_ALL_COLORS', {});
      cachedColors.sort((a, b) => a.sortOrder - b.sortOrder);

      // Update color filter chips dynamically
      updateColorFilterChips();
    } catch (error) {
      console.error('Failed to load colors:', error);
      cachedColors = [];
    }
  }

  /**
   * Update color filter chips based on cached colors
   */
  function updateColorFilterChips() {
    const colorGroup = document.querySelector('.filter-group:has([data-intent])');
    if (!colorGroup) return;

    // Get label and clear button container
    const label = colorGroup.querySelector('.filter-label');
    label.textContent = 'Color:';

    // Remove old chips
    const oldChips = colorGroup.querySelectorAll('.filter-chip');
    oldChips.forEach(chip => chip.remove());

    // Add new chips for each color
    for (const color of cachedColors) {
      const chip = document.createElement('button');
      chip.className = 'filter-chip';
      chip.dataset.colorId = color.id;
      chip.textContent = color.name;
      chip.style.setProperty('--chip-color', hexToRgba(color.color, 0.3));
      chip.addEventListener('click', () => toggleFilter('colorIds', color.id));
      colorGroup.appendChild(chip);
    }
  }

  // DOM Elements
  const pageListEl = document.getElementById('page-list');
  const emptyStateEl = document.getElementById('empty-state');
  const searchInputEl = document.getElementById('search-input');
  const sortSelectEl = document.getElementById('sort-select');
  const totalPagesEl = document.getElementById('total-pages');
  const totalAnnotationsEl = document.getElementById('total-annotations');

  /**
   * Send message to background script
   */
  async function sendMessage(type, payload = {}) {
    return browser.runtime.sendMessage({ type, payload });
  }

  /**
   * Format date to relative time
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
   * Extract domain from URL
   */
  function getDomain(url) {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  }

  /**
   * Truncate text with ellipsis
   */
  function truncate(text, maxLength) {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Create page card element
   */
  function createPageCard(page) {
    const card = document.createElement('div');
    card.className = 'page-card';
    card.dataset.url = page.pageUrl;

    const totalCount = page.highlightCount + page.checkboxCount + (page.pageNoteCount || 0) + (page.clipboardCount || 0);
    const domain = getDomain(page.pageUrl);

    card.innerHTML = `
      <div class="page-card-header">
        <div class="page-favicon">
          <img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32"
               alt=""
               onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
          <div class="page-favicon-fallback">📄</div>
        </div>
        <div class="page-info">
          <h3 class="page-title">${escapeHtml(truncate(page.title, 60))}</h3>
          <p class="page-url">${escapeHtml(truncate(page.pageUrl, 80))}</p>
        </div>
        <span class="page-time">${formatRelativeTime(page.lastUpdated)}</span>
      </div>
      <div class="page-card-stats">
        ${page.highlightCount > 0 ? `<span class="page-stat highlight-stat"><span class="stat-icon">🖍️</span><span class="stat-value">${page.highlightCount}</span><span class="stat-label">highlights</span></span>` : ''}
        ${page.checkboxCount > 0 ? `<span class="page-stat checkbox-stat"><span class="stat-icon">☑️</span><span class="stat-value">${page.checkedCount || 0}/${page.checkboxCount}</span><span class="stat-label">checked</span></span>` : ''}
        ${page.pageNoteCount > 0 ? `<span class="page-stat pagenote-stat"><span class="stat-icon">📄</span><span class="stat-value">${page.pageNoteCount}</span><span class="stat-label">page note${page.pageNoteCount > 1 ? 's' : ''}</span></span>` : ''}
        ${page.clipboardCount > 0 ? `<span class="page-stat clipboard-stat"><span class="stat-icon">📋</span><span class="stat-value">${page.clipboardCount}</span><span class="stat-label">clipboard</span></span>` : ''}
      </div>
      <div class="page-card-actions">
        <button class="action-btn open-btn" title="Open page">Open</button>
        <button class="action-btn view-btn" title="View annotations">View</button>
        <button class="action-btn delete-btn" title="Delete all annotations">Delete</button>
      </div>
    `;

    // Event listeners
    card.querySelector('.open-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      browser.tabs.create({ url: page.pageUrl });
    });

    card.querySelector('.view-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      showPageAnnotations(page);
    });

    card.querySelector('.delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (confirm(`Delete all annotations on this page?\n\n${truncate(page.pageUrl, 50)}`)) {
        await sendMessage('CLEAR_PAGE_ANNOTATIONS', { pageUrl: page.pageUrl });
        loadPages();
      }
    });

    // Click card to open page
    card.addEventListener('click', () => {
      browser.tabs.create({ url: page.pageUrl });
    });

    return card;
  }

  /**
   * Show annotations for a specific page in a modal
   */
  async function showPageAnnotations(page) {
    const annotations = await sendMessage('GET_PAGE_ANNOTATIONS', { pageUrl: page.pageUrl });

    // Load clipboard items for this page
    let clipboardItems = [];
    try {
      const { clipboardHistory = [] } = await browser.storage.local.get('clipboardHistory');
      clipboardItems = clipboardHistory.filter(item => item.pageUrl === page.pageUrl);
    } catch (e) {
      console.error('Failed to load clipboard history:', e);
    }

    // Sort annotations: page notes first, then by updated time
    const sortedAnnotations = [...annotations].sort((a, b) => {
      if (a.annotationType === 'page-note' && b.annotationType !== 'page-note') return -1;
      if (a.annotationType !== 'page-note' && b.annotationType === 'page-note') return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    // Sort clipboard items by timestamp (newest first)
    clipboardItems.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

    const hasContent = sortedAnnotations.length > 0 || clipboardItems.length > 0;

    // Create modal
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal">
        <div class="modal-header">
          <h2>${escapeHtml(truncate(page.title, 40))}</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${sortedAnnotations.length > 0 ? `
          <div class="modal-section">
            <h3 class="modal-section-title">Annotations</h3>
            <div class="annotation-list">
              ${sortedAnnotations.map(a => `
                <div class="annotation-item ${a.annotationType}" data-id="${a.id}">
                  ${a.annotationType === 'checkbox'
                    ? `<input type="checkbox" class="annotation-checkbox" ${a.checked ? 'checked' : ''} data-id="${a.id}">`
                    : `<div class="annotation-type-badge">${a.annotationType === 'page-note' ? '📄' : '🖍️'}</div>`
                  }
                  <div class="annotation-content clickable" data-annotation='${escapeAttr(JSON.stringify(a))}'>
                    <p class="annotation-text">${escapeHtml(truncate(a.annotationType === 'page-note' ? 'Page Note' : (a.textSnapshot || '(element)'), 100))}</p>
                    <span class="annotation-time">${formatRelativeTime(a.updatedAt)}</span>
                  </div>
                  ${a.note && a.note.trim() ? '<span class="annotation-note-icon" title="Has note">📝</span>' : ''}
                  <button class="annotation-delete" title="Delete">&times;</button>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          ${clipboardItems.length > 0 ? `
          <div class="modal-section">
            <h3 class="modal-section-title">Clipboard History</h3>
            <div class="clipboard-list">
              ${clipboardItems.map((item, index) => `
                <div class="clipboard-item" data-index="${index}">
                  <div class="annotation-type-badge">📋</div>
                  <div class="clipboard-content">
                    <p class="clipboard-text">${escapeHtml(truncate(item.text, 100))}</p>
                    <span class="annotation-time">${formatRelativeTime(item.timestamp)}</span>
                  </div>
                  <button class="clipboard-copy" title="Copy to clipboard">Copy</button>
                  <button class="clipboard-delete" title="Delete">&times;</button>
                </div>
              `).join('')}
            </div>
          </div>
          ` : ''}
          ${!hasContent ? '<p class="no-annotations">No content on this page.</p>' : ''}
        </div>
      </div>
    `;

    // Close modal
    modal.querySelector('.modal-close').addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    // Toggle checkbox status
    modal.querySelectorAll('.annotation-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', async (e) => {
        const id = checkbox.dataset.id;
        const isChecked = checkbox.checked;
        await sendMessage('UPDATE_ANNOTATION', {
          id,
          patch: { checked: isChecked }
        });

        // Notify content script on matching page to update checkbox
        try {
          const tabs = await browser.tabs.query({});
          for (const tab of tabs) {
            if (tab.url && page.pageUrl && tab.url.startsWith(page.pageUrl.split('#')[0])) {
              browser.tabs.sendMessage(tab.id, {
                type: 'COMMAND_UPDATE_CHECKBOX',
                annotationId: id,
                checked: isChecked
              }).catch(() => {});
            }
          }
        } catch (e) {}

        // Refresh page list to update counts
        loadPages();
      });
    });

    // Delete individual annotations
    modal.querySelectorAll('.annotation-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this annotation?')) return;

        const item = btn.closest('.annotation-item');
        const id = item.dataset.id;
        await sendMessage('DELETE_ANNOTATION', { id });
        item.remove();
        loadPages();

        // If no more annotations, close modal
        if (modal.querySelectorAll('.annotation-item').length === 0) {
          modal.remove();
        }
      });
    });

    // Click annotation content to view details
    modal.querySelectorAll('.annotation-content.clickable').forEach(content => {
      content.addEventListener('click', (e) => {
        e.stopPropagation();
        try {
          const annotation = JSON.parse(content.dataset.annotation);
          showAnnotationDetail(annotation);
        } catch (err) {
          console.error('Failed to parse annotation data:', err);
        }
      });
    });

    // Copy clipboard item
    modal.querySelectorAll('.clipboard-copy').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const item = btn.closest('.clipboard-item');
        const index = parseInt(item.dataset.index, 10);
        const clipboardItem = clipboardItems[index];
        if (clipboardItem) {
          try {
            await navigator.clipboard.writeText(clipboardItem.text);
            btn.textContent = 'Copied!';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
          } catch (err) {
            console.error('Failed to copy:', err);
          }
        }
      });
    });

    // Delete clipboard item
    modal.querySelectorAll('.clipboard-delete').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this clipboard item?')) return;

        const item = btn.closest('.clipboard-item');
        const index = parseInt(item.dataset.index, 10);

        try {
          const { clipboardHistory = [] } = await browser.storage.local.get('clipboardHistory');
          // Find and remove the item by matching text and timestamp
          const itemToRemove = clipboardItems[index];
          const newHistory = clipboardHistory.filter(h =>
            !(h.text === itemToRemove.text && h.timestamp === itemToRemove.timestamp && h.pageUrl === itemToRemove.pageUrl)
          );
          await browser.storage.local.set({ clipboardHistory: newHistory });

          // Update local array and remove from DOM
          clipboardItems.splice(index, 1);
          item.remove();
          loadPages();

          // Update indices for remaining items
          modal.querySelectorAll('.clipboard-item').forEach((el, i) => {
            el.dataset.index = i;
          });

          // Close modal if no content left
          if (modal.querySelectorAll('.annotation-item, .clipboard-item').length === 0) {
            modal.remove();
          }
        } catch (err) {
          console.error('Failed to delete clipboard item:', err);
        }
      });
    });

    document.body.appendChild(modal);
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
   * Escape for HTML attribute
   */
  function escapeAttr(text) {
    return text.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
  }

  /**
   * Show annotation detail modal
   */
  function showAnnotationDetail(annotation) {
    const detailModal = document.createElement('div');
    detailModal.className = 'modal-overlay detail-modal-overlay';

    const isPageNote = annotation.annotationType === 'page-note';
    const isCheckbox = annotation.annotationType === 'checkbox';
    const typeLabel = isPageNote ? 'Page Note' : (isCheckbox ? 'Checkbox' : 'Highlight');
    const colorName = getAnnotationColorName(annotation);
    const colorLabel = colorName !== 'Default' ? ` (${colorName})` : '';
    const modalTypeClass = isPageNote ? 'page-note-modal' : (isCheckbox ? 'checkbox-modal' : 'highlight-modal');

    // Build color swatches from cached colors
    const currentColor = getAnnotationColor(annotation);
    const hasNoColor = currentColor === 'transparent' || !annotation.colorId;
    const colorSwatches = cachedColors.map(c => {
      const colorValue = hexToRgba(c.color, 0.5);
      const isActive = c.id === annotation.colorId || colorValue === currentColor;
      return `
        <button class="detail-color-swatch ${isActive ? 'active' : ''}"
                data-color-id="${c.id}"
                data-color="${colorValue}"
                title="${c.name}"
                style="background: ${colorValue}"></button>
      `;
    }).join('');

    detailModal.innerHTML = `
      <div class="modal detail-modal annotation-detail-modal ${modalTypeClass}">
        <div class="modal-header annotation-detail-header ${modalTypeClass}-header">
          <h2>${typeLabel}${colorLabel}</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          ${!isPageNote ? `
          <div class="detail-section">
            <div class="detail-section-header">
              <h3>FULL TEXT</h3>
              ${annotation.textSnapshot ? '<button class="copy-btn" title="Copy to clipboard">Copy</button>' : ''}
            </div>
            <div class="detail-text-box">
              ${annotation.textSnapshot ? escapeHtml(annotation.textSnapshot) : '<em>(No text - element annotation)</em>'}
            </div>
          </div>
          ` : ''}
          ${isCheckbox ? `
          <div class="detail-section">
            <h3>STATUS</h3>
            <p>${annotation.checked ? '✅ Checked' : '⬜ Unchecked'}</p>
          </div>
          ` : ''}
          ${!isPageNote ? `
          <div class="detail-section">
            <div class="detail-section-header">
              <h3>COLOR</h3>
              <span class="color-edit-status"></span>
            </div>
            <div class="detail-color-picker">
              ${colorSwatches}
              ${isCheckbox ? `<button class="detail-color-swatch detail-color-clear ${hasNoColor ? 'active' : ''}" data-color="transparent" title="No color">&times;</button>` : ''}
            </div>
          </div>
          ` : ''}
          <div class="detail-section">
            <div class="detail-section-header">
              <h3>NOTE</h3>
              <span class="note-edit-status"></span>
            </div>
            <div class="note-input-wrapper">
              <button class="copy-btn note-copy-btn" title="Copy note to clipboard">Copy</button>
              <div class="note-toolbar">
                <button class="note-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
                <button class="note-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
              </div>
              <textarea class="detail-note-textarea"
                        placeholder="${isPageNote ? 'Write notes about this page...' : 'Add a note to this annotation...'}"
                        autocapitalize="sentences"
                        rows="4">${escapeHtml(annotation.note || '')}</textarea>
            </div>
          </div>
          <div class="detail-section detail-timestamps">
            <div class="detail-timestamp">
              <h3>CREATED</h3>
              <p>${new Date(annotation.createdAt).toLocaleString()}</p>
            </div>
            <div class="detail-timestamp">
              <h3>LAST UPDATED</h3>
              <p>${new Date(annotation.updatedAt).toLocaleString()}</p>
            </div>
          </div>
        </div>
      </div>
    `;

    // Copy button handler for full text
    const copyBtn = detailModal.querySelector('.detail-section-header .copy-btn:not(.note-copy-btn)');
    if (copyBtn && annotation.textSnapshot) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(annotation.textSnapshot);
          copyBtn.textContent = 'Copied!';
          copyBtn.classList.add('copied');
          setTimeout(() => {
            copyBtn.textContent = 'Copy';
            copyBtn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Failed to copy:', err);
        }
      });
    }

    // Copy button handler for note
    const noteCopyBtn = detailModal.querySelector('.note-copy-btn');
    if (noteCopyBtn) {
      noteCopyBtn.addEventListener('click', async () => {
        const noteTextarea = detailModal.querySelector('.detail-note-textarea');
        const noteText = noteTextarea ? noteTextarea.value : '';
        if (!noteText.trim()) {
          noteCopyBtn.textContent = 'Empty';
          setTimeout(() => { noteCopyBtn.textContent = 'Copy'; }, 1500);
          return;
        }
        try {
          await navigator.clipboard.writeText(noteText);
          noteCopyBtn.textContent = 'Copied!';
          noteCopyBtn.classList.add('copied');
          setTimeout(() => {
            noteCopyBtn.textContent = 'Copy';
            noteCopyBtn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Failed to copy note:', err);
        }
      });
    }

    // Color picker handlers
    const colorStatus = detailModal.querySelector('.color-edit-status');
    detailModal.querySelectorAll('.detail-color-swatch').forEach(swatch => {
      swatch.addEventListener('click', async () => {
        const newColorId = swatch.dataset.colorId;
        const newColor = swatch.dataset.color;

        // Update active state
        detailModal.querySelectorAll('.detail-color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        // Build patch - use colorId if available, otherwise color (for transparent)
        const patch = newColorId ? { colorId: newColorId, color: null } : { colorId: null, color: newColor };

        // Save color
        try {
          colorStatus.textContent = 'Saving...';
          colorStatus.className = 'color-edit-status saving';

          await sendMessage('UPDATE_ANNOTATION', {
            id: annotation.id,
            patch
          });
          annotation.colorId = newColorId || null;
          annotation.color = newColorId ? null : newColor;

          // Get display color for UI update
          const displayColor = newColorId ? hexToRgba(getColorById(newColorId)?.color || '#FFEB3B', 0.5) : newColor;

          // Update color in annotation list
          const listItem = document.querySelector(`.annotation-item[data-id="${annotation.id}"]`);
          if (listItem) {
            const colorEl = listItem.querySelector('.annotation-color');
            if (colorEl) colorEl.style.background = displayColor;
          }

          // Tell content script on matching page to update color
          try {
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
              if (tab.url && annotation.pageUrl && tab.url.startsWith(annotation.pageUrl.split('#')[0])) {
                browser.tabs.sendMessage(tab.id, {
                  type: 'COMMAND_UPDATE_COLOR',
                  annotationId: annotation.id,
                  color: displayColor
                }).catch(() => {});
              }
            }
          } catch (e) {}

          colorStatus.textContent = 'Saved';
          colorStatus.className = 'color-edit-status saved';
          setTimeout(() => { colorStatus.textContent = ''; }, 1500);
        } catch (err) {
          colorStatus.textContent = 'Error';
          colorStatus.className = 'color-edit-status error';
          console.error('Failed to save color:', err);
        }
      });
    });

    // Note editing with auto-save
    const noteTextarea = detailModal.querySelector('.detail-note-textarea');
    const noteStatus = detailModal.querySelector('.note-edit-status');
    setupAutoCapitalize(noteTextarea);

    // Toolbar button handlers
    detailModal.querySelectorAll('.note-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        insertNoteFormat(noteTextarea, action);
        noteTextarea.focus();
      });
    });

    let saveTimer;

    noteTextarea.addEventListener('input', () => {
      noteStatus.textContent = 'Saving...';
      noteStatus.className = 'note-edit-status saving';

      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await sendMessage('UPDATE_ANNOTATION', {
            id: annotation.id,
            patch: { note: noteTextarea.value }
          });
          noteStatus.textContent = 'Saved';
          noteStatus.className = 'note-edit-status saved';
          annotation.note = noteTextarea.value;

          // Tell content script on matching page to update badge
          try {
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
              if (tab.url && annotation.pageUrl && tab.url.startsWith(annotation.pageUrl.split('#')[0])) {
                browser.tabs.sendMessage(tab.id, {
                  type: 'COMMAND_UPDATE_NOTE_BADGE',
                  annotationId: annotation.id,
                  note: noteTextarea.value
                }).catch(() => {}); // Ignore errors for tabs without content script
              }
            }
          } catch (e) {
            // Ignore errors
          }

          setTimeout(() => { noteStatus.textContent = ''; }, 2000);
        } catch (err) {
          noteStatus.textContent = 'Error saving';
          noteStatus.className = 'note-edit-status error';
          console.error('Failed to save note:', err);
        }
      }, 500);
    });

    // Update note icon in list and close modal
    const closeDetailModal = () => {
      // Update note icon in the annotation list
      const listItem = document.querySelector(`.annotation-item[data-id="${annotation.id}"]`);
      if (listItem) {
        let noteIcon = listItem.querySelector('.annotation-note-icon');
        const hasNote = annotation.note && annotation.note.trim();
        if (hasNote && !noteIcon) {
          noteIcon = document.createElement('span');
          noteIcon.className = 'annotation-note-icon';
          noteIcon.title = 'Has note';
          noteIcon.textContent = '📝';
          listItem.querySelector('.annotation-delete').before(noteIcon);
        } else if (!hasNote && noteIcon) {
          noteIcon.remove();
        }
      }
      detailModal.remove();
    };

    detailModal.querySelector('.modal-close').addEventListener('click', closeDetailModal);
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) closeDetailModal();
    });

    document.body.appendChild(detailModal);
  }

  /**
   * Filter and sort pages
   */
  function getFilteredPages() {
    let filtered = allPages;

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(page =>
        page.title.toLowerCase().includes(query) ||
        page.pageUrl.toLowerCase().includes(query)
      );
    }

    // Sort
    switch (currentSort) {
      case 'recent':
        filtered.sort((a, b) => b.lastUpdated - a.lastUpdated);
        break;
      case 'most':
        filtered.sort((a, b) => (b.highlightCount + b.checkboxCount + (b.pageNoteCount || 0) + (b.clipboardCount || 0)) - (a.highlightCount + a.checkboxCount + (a.pageNoteCount || 0) + (a.clipboardCount || 0)));
        break;
      case 'alpha':
        filtered.sort((a, b) => a.title.localeCompare(b.title));
        break;
    }

    return filtered;
  }

  /**
   * Render page list
   */
  function renderPages() {
    const filtered = getFilteredPages();

    // Update stats
    totalPagesEl.textContent = allPages.length;
    const totalAnnotations = allPages.reduce((sum, p) => sum + p.highlightCount + p.checkboxCount + (p.pageNoteCount || 0) + (p.clipboardCount || 0), 0);
    totalAnnotationsEl.textContent = totalAnnotations;

    // Clear existing cards (keep empty state)
    pageListEl.querySelectorAll('.page-card').forEach(el => el.remove());

    if (filtered.length === 0) {
      emptyStateEl.style.display = 'flex';
      if (searchQuery && allPages.length > 0) {
        emptyStateEl.querySelector('h2').textContent = 'No matches found';
        emptyStateEl.querySelector('p').textContent = 'Try a different search term.';
      } else {
        emptyStateEl.querySelector('h2').textContent = 'No annotations yet';
        emptyStateEl.querySelector('p').textContent = "Start annotating pages and they'll appear here.";
      }
    } else {
      emptyStateEl.style.display = 'none';
      filtered.forEach(page => {
        pageListEl.appendChild(createPageCard(page));
      });
    }
  }

  /**
   * Perform annotation search
   */
  async function performSearch() {
    const filtersBar = document.getElementById('filters-bar');
    const options = buildFilterOptions();

    try {
      searchResults = await sendMessage('SEARCH_ANNOTATIONS', {
        query: searchQuery,
        options
      });
      renderSearchResults();
    } catch (error) {
      console.error('Search failed:', error);
    }
  }

  /**
   * Build filter options object from activeFilters
   */
  function buildFilterOptions() {
    const options = {};

    if (activeFilters.types.length > 0) {
      options.types = activeFilters.types;
    }

    if (activeFilters.colorIds.length > 0) {
      options.colorIds = activeFilters.colorIds;
    }

    if (activeFilters.dateRange) {
      options.dateRange = activeFilters.dateRange;
    }

    return options;
  }

  /**
   * Highlight matching text in search results
   */
  function highlightMatch(text, query) {
    if (!query || !text) return escapeHtml(text || '');

    const escapedText = escapeHtml(text);
    const escapedQuery = escapeHtml(query);
    const regex = new RegExp(`(${escapedQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    return escapedText.replace(regex, '<mark>$1</mark>');
  }

  /**
   * Switch between views (all, pages, annotations)
   */
  function switchView(view) {
    activeView = view;

    // Update tab UI
    document.querySelectorAll('.view-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });

    // Update placeholder
    const searchInputEl = document.getElementById('search-input');
    if (view === 'all') {
      searchInputEl.placeholder = 'Search everything...';
    } else if (view === 'pages') {
      searchInputEl.placeholder = 'Search pages...';
    } else {
      searchInputEl.placeholder = 'Search annotations...';
    }

    // Render appropriate view
    updateView();
  }

  /**
   * Update the current view based on activeView and searchQuery
   */
  function updateView() {
    const filtersBar = document.getElementById('filters-bar');
    const searchResultsEl = document.getElementById('search-results');
    const pageListEl = document.getElementById('page-list');

    if (activeView === 'pages') {
      // Pages only view
      pageListEl.style.display = '';
      searchResultsEl.style.display = 'none';
      filtersBar.style.display = 'none';
      renderPages();
    } else if (activeView === 'annotations') {
      // Annotations only view
      pageListEl.style.display = 'none';
      searchResultsEl.style.display = 'block';
      filtersBar.style.display = 'flex';
      performSearch();
    } else {
      // 'all' view - show both pages and annotations
      pageListEl.style.display = '';
      searchResultsEl.style.display = 'block';
      filtersBar.style.display = 'flex';
      renderPages();
      performSearch();
    }
  }

  /**
   * Render search results (annotation cards)
   */
  function renderSearchResults() {
    const searchResultsEl = document.getElementById('search-results');

    // Update result count with context
    const resultCount = document.getElementById('search-result-count');
    if (activeView === 'all') {
      resultCount.textContent = `${searchResults.length} annotation${searchResults.length !== 1 ? 's' : ''}`;
    } else {
      resultCount.textContent = `${searchResults.length} annotation${searchResults.length !== 1 ? 's' : ''} found`;
    }

    // Clear existing results
    const resultsContainer = searchResultsEl.querySelector('.search-results-list');
    resultsContainer.innerHTML = '';

    if (searchResults.length === 0) {
      resultsContainer.innerHTML = `
        <div class="search-empty-state">
          <p>No annotations match your search${searchQuery ? ` for "${escapeHtml(searchQuery)}"` : ''}.</p>
          ${hasActiveFilters() ? '<p>Try removing some filters.</p>' : ''}
        </div>
      `;
      return;
    }

    // Render each annotation result
    for (const annotation of searchResults) {
      const card = createAnnotationCard(annotation);
      resultsContainer.appendChild(card);
    }
  }

  /**
   * Check if any filters are active
   */
  function hasActiveFilters() {
    return activeFilters.types.length > 0 ||
           activeFilters.colorIds.length > 0 ||
           activeFilters.dateRange !== null;
  }

  /**
   * Create annotation card for search results
   */
  function createAnnotationCard(annotation) {
    const card = document.createElement('div');
    card.className = `annotation-card ${annotation.annotationType}`;
    card.dataset.id = annotation.id;

    const isPageNote = annotation.annotationType === 'page-note';
    const isCheckbox = annotation.annotationType === 'checkbox';
    const isClipboard = annotation.annotationType === 'clipboard';
    const text = isPageNote ? 'Page Note' : (annotation.textSnapshot || '(no text)');
    const colorName = getAnnotationColorName(annotation);
    const colorLabel = !isClipboard && colorName !== 'Default' ? ` (${colorName})` : '';

    // Determine type label
    let typeLabel = 'Highlight';
    if (isPageNote) typeLabel = 'Page Note';
    else if (isCheckbox) typeLabel = 'Checkbox';
    else if (isClipboard) typeLabel = 'Clipboard';

    // Determine text to display - highlight if searching
    const displayText = searchQuery
      ? highlightMatch(truncate(text, 150), searchQuery)
      : escapeHtml(truncate(text, 150));

    const noteText = annotation.note && annotation.note.trim()
      ? (searchQuery ? highlightMatch(truncate(annotation.note, 100), searchQuery) : escapeHtml(truncate(annotation.note, 100)))
      : '';

    card.innerHTML = `
      <div class="annotation-card-header">
        <span class="annotation-card-type ${annotation.annotationType}">
          ${typeLabel}${colorLabel}
        </span>
        <span class="annotation-card-time">${formatRelativeTime(annotation.updatedAt)}</span>
      </div>
      <div class="annotation-card-content">
        ${isCheckbox ? `<input type="checkbox" class="annotation-card-checkbox" ${annotation.checked ? 'checked' : ''}>` : ''}
        <div class="annotation-card-text">
          <p class="annotation-card-main-text">${displayText}</p>
          ${noteText ? `<p class="annotation-card-note">Note: ${noteText}</p>` : ''}
        </div>
      </div>
      <div class="annotation-card-footer">
        <a href="${escapeHtml(annotation.pageUrl)}" class="annotation-card-source" title="${escapeHtml(annotation.pageTitle || annotation.pageUrl)}">
          ${escapeHtml(truncate(annotation.pageTitle || getDomain(annotation.pageUrl), 40))}
        </a>
        ${isClipboard ? `<button class="annotation-card-copy" title="Copy">Copy</button>` : ''}
        <button class="annotation-card-delete" title="Delete">&times;</button>
      </div>
    `;

    // Checkbox handler
    const checkbox = card.querySelector('.annotation-card-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', async (e) => {
        e.stopPropagation();
        await sendMessage('UPDATE_ANNOTATION', {
          id: annotation.id,
          patch: { checked: checkbox.checked }
        });
        annotation.checked = checkbox.checked;
      });
    }

    // Copy handler for clipboard items
    const copyBtn = card.querySelector('.annotation-card-copy');
    if (copyBtn) {
      copyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(annotation.textSnapshot);
          copyBtn.textContent = 'Copied!';
          setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        } catch (err) {
          console.error('Failed to copy:', err);
        }
      });
    }

    // Delete handler
    card.querySelector('.annotation-card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(isClipboard ? 'Delete this clipboard item?' : 'Delete this annotation?')) return;

      if (isClipboard) {
        // Delete from clipboard storage
        try {
          const { clipboardHistory = [] } = await browser.storage.local.get('clipboardHistory');
          const newHistory = clipboardHistory.filter(h =>
            !(h.text === annotation.textSnapshot && h.timestamp === annotation.createdAt)
          );
          await browser.storage.local.set({ clipboardHistory: newHistory });
        } catch (err) {
          console.error('Failed to delete clipboard item:', err);
        }
      } else {
        await sendMessage('DELETE_ANNOTATION', { id: annotation.id });
      }
      performSearch(); // Refresh results
    });

    // Click card to view detail (skip for clipboard items)
    card.addEventListener('click', (e) => {
      if (e.target.closest('.annotation-card-checkbox') ||
          e.target.closest('.annotation-card-delete') ||
          e.target.closest('.annotation-card-copy') ||
          e.target.closest('.annotation-card-source')) return;
      if (!isClipboard) {
        showAnnotationDetail(annotation);
      }
    });

    // Source link handler
    card.querySelector('.annotation-card-source').addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      browser.tabs.create({ url: annotation.pageUrl });
    });

    return card;
  }

  /**
   * Toggle filter chip
   */
  function toggleFilter(category, value) {
    if (category === 'dateRange') {
      // Date is single-select
      activeFilters.dateRange = activeFilters.dateRange === value ? null : value;
    } else {
      // Types and intents are multi-select
      const index = activeFilters[category].indexOf(value);
      if (index === -1) {
        activeFilters[category].push(value);
      } else {
        activeFilters[category].splice(index, 1);
      }
    }

    updateFilterChipStates();
    performSearch();
  }

  /**
   * Update filter chip active states
   */
  function updateFilterChipStates() {
    // Type filters
    document.querySelectorAll('.filter-chip[data-type]').forEach(chip => {
      chip.classList.toggle('active', activeFilters.types.includes(chip.dataset.type));
    });

    // Color filters
    document.querySelectorAll('.filter-chip[data-color-id]').forEach(chip => {
      chip.classList.toggle('active', activeFilters.colorIds.includes(chip.dataset.colorId));
    });

    // Date filters
    document.querySelectorAll('.filter-chip[data-date]').forEach(chip => {
      chip.classList.toggle('active', activeFilters.dateRange === chip.dataset.date);
    });

    // Clear filters button visibility
    const clearBtn = document.getElementById('clear-filters');
    clearBtn.style.display = hasActiveFilters() ? '' : 'none';
  }

  /**
   * Clear all filters
   */
  function clearFilters() {
    activeFilters = { types: [], colorIds: [], dateRange: null };
    updateFilterChipStates();
    performSearch();
  }

  /**
   * Load pages from storage
   */
  async function loadPages() {
    try {
      allPages = await sendMessage('GET_PAGES_SUMMARY');
      renderPages();
    } catch (error) {
      console.error('Failed to load pages:', error);
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
    const storageEl = document.getElementById('storage-used');
    try {
      if (navigator.storage && navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        const used = estimate.usage || 0;
        const quota = estimate.quota || 0;
        const percent = quota > 0 ? ((used / quota) * 100).toFixed(1) : 0;

        storageEl.textContent = formatBytes(used);
        storageEl.title = `${formatBytes(used)} of ${formatBytes(quota)} (${percent}%)`;
      } else {
        storageEl.textContent = 'N/A';
      }
    } catch (error) {
      console.error('Failed to get storage estimate:', error);
      storageEl.textContent = 'N/A';
    }
  }

  /**
   * Export all annotations to JSON file
   */
  async function exportAnnotations() {
    try {
      const annotations = await sendMessage('GET_ALL_ANNOTATIONS');

      if (annotations.length === 0) {
        alert('No annotations to export.');
        return;
      }

      const exportData = {
        version: 1,
        exportedAt: new Date().toISOString(),
        annotationCount: annotations.length,
        annotations: annotations
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `annotatepro-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export annotations:', error);
      alert('Failed to export annotations. Please try again.');
    }
  }

  /**
   * Export all annotations to Markdown file
   */
  async function exportAllToMarkdown() {
    try {
      const annotations = await sendMessage('GET_ALL_ANNOTATIONS');

      if (annotations.length === 0) {
        alert('No annotations to export.');
        return;
      }

      // Group annotations by pageUrl
      const pageMap = new Map();
      for (const a of annotations) {
        if (!pageMap.has(a.pageUrl)) {
          pageMap.set(a.pageUrl, {
            pageUrl: a.pageUrl,
            pageTitle: a.pageTitle || getDomain(a.pageUrl),
            annotations: []
          });
        }
        pageMap.get(a.pageUrl).annotations.push(a);
      }

      const pages = Array.from(pageMap.values());

      // Build markdown with Table of Contents
      let md = `---
exported: ${new Date().toISOString()}
total_pages: ${pages.length}
total_annotations: ${annotations.length}
---

# AnnotatePro Export

Exported: ${new Date().toLocaleString()}

## Table of Contents

`;

      // Generate TOC
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const anchor = `page-${i + 1}`;
        md += `${i + 1}. [${page.pageTitle}](#${anchor}) (${page.annotations.length} annotations)\n`;
      }

      md += `\n---\n\n`;

      // Generate each page section
      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        const anchor = `page-${i + 1}`;
        const domain = getDomain(page.pageUrl);

        md += `## <a id="${anchor}"></a>${page.pageTitle}\n\n`;
        md += `Source: [${domain}](${page.pageUrl})\n\n`;

        // Group annotations by type
        const pageNotes = page.annotations.filter(a => a.annotationType === 'page-note');
        const highlights = page.annotations.filter(a => a.annotationType === 'highlight');
        const checkboxes = page.annotations.filter(a => a.annotationType === 'checkbox');

        // Group highlights by color
        const highlightsByColor = {};
        for (const h of highlights) {
          const colorName = getAnnotationColorName(h);
          if (!highlightsByColor[colorName]) {
            highlightsByColor[colorName] = [];
          }
          highlightsByColor[colorName].push(h);
        }

        // Page Notes
        if (pageNotes.length > 0) {
          md += `### Page Notes\n`;
          for (const note of pageNotes) {
            if (note.note && note.note.trim()) {
              md += `- ${note.note.trim().replace(/\n/g, '\n  ')}\n`;
            }
          }
          md += `\n`;
        }

        // Highlights
        if (highlights.length > 0) {
          md += `### Highlights\n\n`;
          for (const [colorName, items] of Object.entries(highlightsByColor)) {
            md += `#### ${colorName}\n`;
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

        // Checkboxes
        if (checkboxes.length > 0) {
          md += `### Checkboxes\n`;
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

        md += `---\n\n`;
      }

      // Download the markdown file
      const blob = new Blob([md], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = `annotatepro-export-${new Date().toISOString().slice(0, 10)}.md`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Failed to export annotations to markdown:', error);
      alert('Failed to export annotations. Please try again.');
    }
  }

  /**
   * Import annotations from JSON file
   */
  async function importAnnotations(file) {
    try {
      const text = await file.text();
      const data = JSON.parse(text);

      // Validate format
      if (!data.annotations || !Array.isArray(data.annotations)) {
        alert('Invalid backup file format.');
        return;
      }

      if (data.annotations.length === 0) {
        alert('The backup file contains no annotations.');
        return;
      }

      const confirmMsg = `Import ${data.annotations.length} annotations?\n\nThis will add to your existing annotations. Duplicates will be skipped.`;
      if (!confirm(confirmMsg)) return;

      const result = await sendMessage('IMPORT_ANNOTATIONS', { annotations: data.annotations });

      alert(`Import complete!\n\nImported: ${result.imported}\nSkipped (duplicates): ${result.skipped}`);

      // Refresh the page list
      loadPages();
      updateStorageInfo();
    } catch (error) {
      console.error('Failed to import annotations:', error);
      if (error instanceof SyntaxError) {
        alert('Invalid JSON file. Please select a valid backup file.');
      } else {
        alert('Failed to import annotations. Please try again.');
      }
    }
  }

  /**
   * Show color management modal
   */
  function showColorManagement() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay color-management-overlay';

    const renderColorList = () => {
      return cachedColors.map((color, index) => `
        <div class="color-item" data-id="${color.id}" data-sort="${color.sortOrder}">
          <div class="color-item-drag" title="Drag to reorder">⋮⋮</div>
          <div class="color-item-swatch" style="background: ${hexToRgba(color.color, 0.5)}"></div>
          <input type="text" class="color-item-name" value="${escapeHtml(color.name)}" placeholder="Color name">
          <input type="color" class="color-item-picker" value="${color.color}">
          <span class="color-item-usage">${color.usageCount || 0} uses</span>
          ${color.isDefault ? '<span class="color-item-default">Default</span>' : `<button class="color-item-delete" title="Delete">&times;</button>`}
        </div>
      `).join('');
    };

    modal.innerHTML = `
      <div class="modal color-management-modal">
        <div class="modal-header">
          <h2>Manage Colors</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <p class="color-management-help">Customize highlight colors. Default colors cannot be deleted but can be renamed.</p>
          <div class="color-list" id="color-list">
            ${renderColorList()}
          </div>
          <button class="add-color-btn" id="add-color-btn">+ Add Color</button>
        </div>
        <div class="modal-footer">
          <span class="color-save-status"></span>
          <button class="modal-done-btn">Done</button>
        </div>
      </div>
    `;

    const statusEl = modal.querySelector('.color-save-status');
    const colorList = modal.querySelector('#color-list');

    // Auto-save color name changes with debounce
    let saveTimer = null;
    colorList.addEventListener('input', async (e) => {
      if (e.target.classList.contains('color-item-name')) {
        clearTimeout(saveTimer);
        const item = e.target.closest('.color-item');
        const colorId = item.dataset.id;
        const newName = e.target.value.trim();

        if (!newName) return;

        saveTimer = setTimeout(async () => {
          try {
            statusEl.textContent = 'Saving...';
            await sendMessage('UPDATE_COLOR', { id: colorId, patch: { name: newName } });

            // Update cache
            const color = cachedColors.find(c => c.id === colorId);
            if (color) color.name = newName;

            statusEl.textContent = 'Saved';
            setTimeout(() => { statusEl.textContent = ''; }, 1500);
          } catch (err) {
            statusEl.textContent = 'Error';
            console.error('Failed to save color name:', err);
          }
        }, 500);
      }
    });

    // Color picker changes
    colorList.addEventListener('change', async (e) => {
      if (e.target.classList.contains('color-item-picker')) {
        const item = e.target.closest('.color-item');
        const colorId = item.dataset.id;
        const newColor = e.target.value;

        try {
          statusEl.textContent = 'Saving...';
          await sendMessage('UPDATE_COLOR', { id: colorId, patch: { color: newColor } });

          // Update cache and UI
          const color = cachedColors.find(c => c.id === colorId);
          if (color) color.color = newColor;
          item.querySelector('.color-item-swatch').style.background = hexToRgba(newColor, 0.5);

          statusEl.textContent = 'Saved';
          setTimeout(() => { statusEl.textContent = ''; }, 1500);
        } catch (err) {
          statusEl.textContent = 'Error';
          console.error('Failed to save color:', err);
        }
      }
    });

    // Delete color
    colorList.addEventListener('click', async (e) => {
      if (e.target.classList.contains('color-item-delete')) {
        const item = e.target.closest('.color-item');
        const colorId = item.dataset.id;
        const color = cachedColors.find(c => c.id === colorId);

        if (!color || color.isDefault) return;

        // Check usage count
        if (color.usageCount > 0) {
          const reassign = confirm(`This color is used by ${color.usageCount} annotation(s).\n\nDelete and reassign to Action color?`);
          if (!reassign) return;

          try {
            statusEl.textContent = 'Deleting...';
            await sendMessage('DELETE_COLOR', { id: colorId, reassignToColorId: 'default-action' });
          } catch (err) {
            statusEl.textContent = 'Error';
            console.error('Failed to delete color:', err);
            return;
          }
        } else {
          if (!confirm(`Delete "${color.name}"?`)) return;

          try {
            statusEl.textContent = 'Deleting...';
            await sendMessage('DELETE_COLOR', { id: colorId });
          } catch (err) {
            statusEl.textContent = 'Error';
            console.error('Failed to delete color:', err);
            return;
          }
        }

        // Remove from cache and UI
        cachedColors = cachedColors.filter(c => c.id !== colorId);
        item.remove();
        updateColorFilterChips();
        statusEl.textContent = 'Deleted';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      }
    });

    // Add new color
    modal.querySelector('#add-color-btn').addEventListener('click', async () => {
      const newColor = {
        name: `Custom ${cachedColors.length + 1}`,
        color: '#9C27B0', // Purple default
        sortOrder: cachedColors.length
      };

      try {
        statusEl.textContent = 'Adding...';
        const savedColor = await sendMessage('ADD_COLOR', newColor);
        cachedColors.push(savedColor);

        // Re-render color list
        colorList.innerHTML = renderColorList();
        updateColorFilterChips();

        statusEl.textContent = 'Added';
        setTimeout(() => { statusEl.textContent = ''; }, 1500);
      } catch (err) {
        statusEl.textContent = 'Error';
        console.error('Failed to add color:', err);
      }
    });

    // Close modal
    const closeModal = () => {
      modal.remove();
      // Refresh the page data to reflect any color changes
      loadPages();
    };

    modal.querySelector('.modal-close').addEventListener('click', closeModal);
    modal.querySelector('.modal-done-btn').addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    document.body.appendChild(modal);
  }

  /**
   * Clear all data from the database
   */
  async function clearDatabase() {
    const annotations = await sendMessage('GET_ALL_ANNOTATIONS');
    const count = annotations.length;

    if (count === 0) {
      alert('Database is already empty.');
      return;
    }

    const confirmMsg = `Are you sure you want to delete ALL ${count} annotations?\n\nThis action cannot be undone. All highlights, checkboxes, and notes will be permanently lost.\n\nTip: Click "Export" first to create a backup of your data.`;
    if (!confirm(confirmMsg)) return;

    // Double confirmation for safety
    const doubleConfirm = confirm('This will permanently delete all your annotations. Are you absolutely sure?');
    if (!doubleConfirm) return;

    try {
      await sendMessage('CLEAR_ALL_ANNOTATIONS');
      alert('All annotations have been deleted.');
      loadPages();
      updateStorageInfo();
    } catch (error) {
      console.error('Failed to clear database:', error);
      alert('Failed to clear database. Please try again.');
    }
  }

  /**
   * Initialize
   */
  function init() {
    // Search input with debounce
    const searchClearBtn = document.getElementById('search-clear');

    // Update clear button visibility
    function updateClearButtonVisibility() {
      if (searchInputEl.value.length > 0) {
        searchClearBtn.classList.add('visible');
      } else {
        searchClearBtn.classList.remove('visible');
      }
    }

    searchInputEl.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      updateClearButtonVisibility();

      // Switch to 'all' view when searching (if not already on annotations view)
      if (searchQuery && activeView === 'pages') {
        switchView('all');
        return;
      }

      // Debounce search
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        updateView();
      }, 300);
    });

    // Clear button click
    searchClearBtn.addEventListener('click', () => {
      searchInputEl.value = '';
      searchQuery = '';
      updateClearButtonVisibility();
      searchInputEl.focus();
      updateView();
    });

    // ESC key to clear search
    searchInputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        searchInputEl.value = '';
        searchQuery = '';
        updateClearButtonVisibility();
        updateView();
      }
    });

    // View tabs
    document.querySelectorAll('.view-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        const view = tab.dataset.view;
        switchView(view);
      });
    });

    // Filter chip handlers for types and dates (colors added dynamically in updateColorFilterChips)
    document.querySelectorAll('.filter-chip[data-type]').forEach(chip => {
      chip.addEventListener('click', () => toggleFilter('types', chip.dataset.type));
    });

    document.querySelectorAll('.filter-chip[data-date]').forEach(chip => {
      chip.addEventListener('click', () => toggleFilter('dateRange', chip.dataset.date));
    });

    // Clear filters button
    document.getElementById('clear-filters').addEventListener('click', clearFilters);

    // Sort select
    sortSelectEl.addEventListener('change', (e) => {
      currentSort = e.target.value;
      renderPages();
    });

    // Export button (JSON)
    document.getElementById('btn-export').addEventListener('click', exportAnnotations);

    // Export Markdown button
    document.getElementById('btn-export-md').addEventListener('click', exportAllToMarkdown);

    // Import button and file input
    const importFileEl = document.getElementById('import-file');
    document.getElementById('btn-import').addEventListener('click', () => {
      importFileEl.click();
    });
    importFileEl.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        importAnnotations(e.target.files[0]);
        e.target.value = ''; // Reset for future imports
      }
    });

    // Color management button
    document.getElementById('btn-manage-colors').addEventListener('click', showColorManagement);

    // Clear database button
    document.getElementById('btn-clear-db').addEventListener('click', clearDatabase);

    // Listen for messages from background script
    browser.runtime.onMessage.addListener((message) => {
      switch (message.type) {
        case 'REFRESH_DATA':
        case 'ANNOTATION_ADDED':
        case 'ANNOTATION_DELETED':
        case 'PAGE_CLEARED':
        case 'ANNOTATIONS_IMPORTED':
          loadPages();
          updateStorageInfo();
          break;

        case 'ANNOTATION_UPDATED':
          // Update specific UI elements without full refresh
          if (message.annotationId && message.patch) {
            // Update checkbox in modal if open
            if (message.patch.checked !== undefined) {
              const checkbox = document.querySelector(`.annotation-checkbox[data-id="${message.annotationId}"]`);
              if (checkbox) {
                checkbox.checked = message.patch.checked;
              }
            }
            // Update note icon in modal if open
            if (message.patch.note !== undefined) {
              const annotationItem = document.querySelector(`.annotation-item[data-id="${message.annotationId}"]`);
              if (annotationItem) {
                let noteIcon = annotationItem.querySelector('.annotation-note-icon');
                const hasNote = message.patch.note && message.patch.note.trim();
                if (hasNote && !noteIcon) {
                  noteIcon = document.createElement('span');
                  noteIcon.className = 'annotation-note-icon';
                  noteIcon.title = 'Has note';
                  noteIcon.textContent = '📝';
                  const deleteBtn = annotationItem.querySelector('.annotation-delete');
                  if (deleteBtn) deleteBtn.before(noteIcon);
                } else if (!hasNote && noteIcon) {
                  noteIcon.remove();
                }
              }
            }
            // Refresh page list to update counts (for checkbox state changes)
            loadPages();
          }
          break;

        case 'CHECKBOX_UPDATED':
          // Update checkbox in modal if open
          const checkbox = document.querySelector(`.annotation-checkbox[data-id="${message.annotationId}"]`);
          if (checkbox) {
            checkbox.checked = message.checked;
          }
          // Refresh page list to update counts
          loadPages();
          break;
      }
    });

    // Load colors first, then pages and storage info
    loadColors().then(() => {
      loadPages().then(() => {
        updateView(); // Initialize the "All" view properly
      });
      updateStorageInfo();
    });
  }

  init();
})();
