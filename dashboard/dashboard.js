/**
 * Dashboard Script for AnnotatePro
 * Shows all pages with annotations
 */

(function() {
  'use strict';

  let allPages = [];
  let currentSort = 'recent';
  let searchQuery = '';

  const COLOR_PRESETS = [
    { name: 'Yellow', value: 'rgba(255, 235, 59, 0.5)' },
    { name: 'Blue', value: 'rgba(100, 181, 246, 0.5)' },
    { name: 'Red', value: 'rgba(239, 83, 80, 0.5)' },
    { name: 'Green', value: 'rgba(129, 199, 132, 0.5)' },
    { name: 'Purple', value: 'rgba(206, 147, 216, 0.5)' }
  ];

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

    const totalCount = page.highlightCount + page.checkboxCount + (page.pageNoteCount || 0);
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
      </div>
      <div class="page-card-footer">
        <div class="page-stats">
          ${page.highlightCount > 0 ? `<span class="page-stat highlight-stat">${page.highlightCount} highlights</span>` : ''}
          ${page.checkboxCount > 0 ? `<span class="page-stat checkbox-stat">${page.checkedCount || 0}/${page.checkboxCount} checked</span>` : ''}
          ${page.pageNoteCount > 0 ? `<span class="page-stat pagenote-stat">${page.pageNoteCount} page note${page.pageNoteCount > 1 ? 's' : ''}</span>` : ''}
        </div>
        <div class="page-meta">
          <span class="page-time">${formatRelativeTime(page.lastUpdated)}</span>
        </div>
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

    // Sort annotations: page notes first, then by updated time
    const sortedAnnotations = [...annotations].sort((a, b) => {
      if (a.annotationType === 'page-note' && b.annotationType !== 'page-note') return -1;
      if (a.annotationType !== 'page-note' && b.annotationType === 'page-note') return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

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
            ${sortedAnnotations.length === 0 ? '<p class="no-annotations">No annotations on this page.</p>' : ''}
          </div>
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
    const intentLabel = annotation.intent && annotation.intent !== 'DEFAULT' ? ` (${annotation.intent})` : '';
    const modalTypeClass = isPageNote ? 'page-note-modal' : (isCheckbox ? 'checkbox-modal' : 'highlight-modal');

    detailModal.innerHTML = `
      <div class="modal detail-modal annotation-detail-modal ${modalTypeClass}">
        <div class="modal-header annotation-detail-header ${modalTypeClass}-header">
          <h2>${typeLabel}${intentLabel}</h2>
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
              ${COLOR_PRESETS.map(c => `
                <button class="detail-color-swatch ${c.value === (annotation.color || 'rgba(255, 235, 59, 0.5)') ? 'active' : ''}"
                        data-color="${c.value}"
                        title="${c.name}"
                        style="background: ${c.value}"></button>
              `).join('')}
              ${isCheckbox ? `<button class="detail-color-swatch detail-color-clear ${!annotation.color || annotation.color === 'transparent' ? 'active' : ''}" data-color="transparent" title="No color">&times;</button>` : ''}
            </div>
          </div>
          ` : ''}
          <div class="detail-section">
            <div class="detail-section-header">
              <h3>NOTE</h3>
              <span class="note-edit-status"></span>
            </div>
            <div class="note-toolbar">
              <button class="note-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
              <button class="note-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
            </div>
            <textarea class="detail-note-textarea"
                      placeholder="${isPageNote ? 'Write notes about this page...' : 'Add a note to this annotation...'}"
                      autocapitalize="sentences"
                      rows="4">${escapeHtml(annotation.note || '')}</textarea>
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

    // Copy button handler
    const copyBtn = detailModal.querySelector('.copy-btn');
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

    // Color picker handlers
    const colorStatus = detailModal.querySelector('.color-edit-status');
    detailModal.querySelectorAll('.detail-color-swatch').forEach(swatch => {
      swatch.addEventListener('click', async () => {
        const newColor = swatch.dataset.color;

        // Update active state
        detailModal.querySelectorAll('.detail-color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        // Save color
        try {
          colorStatus.textContent = 'Saving...';
          colorStatus.className = 'color-edit-status saving';

          await sendMessage('UPDATE_ANNOTATION', {
            id: annotation.id,
            patch: { color: newColor }
          });
          annotation.color = newColor;

          // Update color in annotation list
          const listItem = document.querySelector(`.annotation-item[data-id="${annotation.id}"]`);
          if (listItem) {
            listItem.querySelector('.annotation-color').style.background = newColor;
          }

          // Tell content script on matching page to update color
          try {
            const tabs = await browser.tabs.query({});
            for (const tab of tabs) {
              if (tab.url && annotation.pageUrl && tab.url.startsWith(annotation.pageUrl.split('#')[0])) {
                browser.tabs.sendMessage(tab.id, {
                  type: 'COMMAND_UPDATE_COLOR',
                  annotationId: annotation.id,
                  color: newColor
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
        filtered.sort((a, b) => (b.highlightCount + b.checkboxCount + (b.pageNoteCount || 0)) - (a.highlightCount + a.checkboxCount + (a.pageNoteCount || 0)));
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
    const totalAnnotations = allPages.reduce((sum, p) => sum + p.highlightCount + p.checkboxCount + (p.pageNoteCount || 0), 0);
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
    // Search input
    searchInputEl.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      renderPages();
    });

    // Sort select
    sortSelectEl.addEventListener('change', (e) => {
      currentSort = e.target.value;
      renderPages();
    });

    // Export button
    document.getElementById('btn-export').addEventListener('click', exportAnnotations);

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

    // Load pages and storage info
    loadPages();
    updateStorageInfo();
  }

  init();
})();
