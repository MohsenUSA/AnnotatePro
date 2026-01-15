/**
 * Dashboard Script for AnnotatePro
 * Shows all pages with annotations
 */

(function() {
  'use strict';

  let allPages = [];
  let currentSort = 'recent';
  let searchQuery = '';

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

    const totalCount = page.highlightCount + page.checkboxCount;
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
            ${annotations.map(a => `
              <div class="annotation-item ${a.annotationType}" data-id="${a.id}">
                ${a.annotationType === 'checkbox'
                  ? `<input type="checkbox" class="annotation-checkbox" ${a.checked ? 'checked' : ''} data-id="${a.id}">`
                  : `<div class="annotation-type-badge">🖍️</div>`
                }
                <div class="annotation-content clickable" data-annotation='${escapeAttr(JSON.stringify(a))}'>
                  <p class="annotation-text">${escapeHtml(truncate(a.textSnapshot || '(element)', 100))}</p>
                  <span class="annotation-time">${formatRelativeTime(a.updatedAt)}</span>
                </div>
                <button class="annotation-delete" title="Delete">&times;</button>
              </div>
            `).join('')}
            ${annotations.length === 0 ? '<p class="no-annotations">No annotations on this page.</p>' : ''}
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
        await sendMessage('UPDATE_ANNOTATION', {
          id,
          patch: { checked: checkbox.checked }
        });
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

    const typeLabel = annotation.annotationType === 'checkbox' ? 'Checkbox' : 'Highlight';
    const intentLabel = annotation.intent && annotation.intent !== 'DEFAULT' ? ` (${annotation.intent})` : '';

    detailModal.innerHTML = `
      <div class="modal detail-modal">
        <div class="modal-header">
          <h2>${typeLabel}${intentLabel}</h2>
          <button class="modal-close">&times;</button>
        </div>
        <div class="modal-body">
          <div class="detail-section">
            <div class="detail-section-header">
              <h3>Full Text</h3>
              ${annotation.textSnapshot ? '<button class="copy-btn" title="Copy to clipboard">Copy</button>' : ''}
            </div>
            <div class="detail-text-box">
              ${annotation.textSnapshot ? escapeHtml(annotation.textSnapshot) : '<em>(No text - element annotation)</em>'}
            </div>
          </div>
          ${annotation.annotationType === 'checkbox' ? `
          <div class="detail-section">
            <h3>Status</h3>
            <p>${annotation.checked ? '✅ Checked' : '⬜ Unchecked'}</p>
          </div>
          ` : ''}
          ${annotation.note ? `
          <div class="detail-section">
            <h3>Note</h3>
            <p>${escapeHtml(annotation.note)}</p>
          </div>
          ` : ''}
          <div class="detail-section">
            <h3>Created</h3>
            <p>${new Date(annotation.createdAt).toLocaleString()}</p>
          </div>
          <div class="detail-section">
            <h3>Last Updated</h3>
            <p>${new Date(annotation.updatedAt).toLocaleString()}</p>
          </div>
        </div>
      </div>
    `;

    // Close handlers
    detailModal.querySelector('.modal-close').addEventListener('click', () => detailModal.remove());
    detailModal.addEventListener('click', (e) => {
      if (e.target === detailModal) detailModal.remove();
    });

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
        filtered.sort((a, b) => (b.highlightCount + b.checkboxCount) - (a.highlightCount + a.checkboxCount));
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
    const totalAnnotations = allPages.reduce((sum, p) => sum + p.highlightCount + p.checkboxCount, 0);
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

    // Load pages and storage info
    loadPages();
    updateStorageInfo();
  }

  init();
})();
