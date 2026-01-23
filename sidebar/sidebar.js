/**
 * AnnotatePro Sidebar
 * Injected sidebar panel for viewing and editing annotations
 */

(function() {
  'use strict';

  // Don't run in iframes
  if (window !== window.top) return;

  // Avoid double initialization
  if (window.annotateProSidebarInitialized) return;
  window.annotateProSidebarInitialized = true;

  // State
  let sidebarEl = null;
  let isCollapsed = true;
  let position = 'right';
  let sidebarWidth = 400; // Default width in pixels
  let annotations = [];
  let cachedColors = [];
  let activeTab = 'annotations'; // 'annotations' or 'clipboard'
  let colorFilter = null;
  let searchQuery = '';
  let clipboardHistory = [];
  let editingAnnotationId = null;

  /**
   * Initialize sidebar
   */
  async function init() {
    // Load settings
    await loadSettings();

    // Load colors
    await loadColors();

    // Create sidebar elements
    createSidebar();

    // Load initial data
    await loadAnnotations();
    await loadClipboardHistory();

    // Set up message listener for real-time updates
    setupMessageListener();

    // Listen for clipboard updates from content script
    window.addEventListener('annotatepro-clipboard-updated', () => {
      loadClipboardHistory();
    });

    console.log('AnnotatePro: Sidebar initialized');
  }

  /**
   * Load sidebar settings from storage (position and width only, collapsed state is per-tab)
   */
  async function loadSettings() {
    try {
      const result = await browser.storage.local.get('sidebarSettings');
      if (result.sidebarSettings) {
        // Don't load collapsed state - each tab starts collapsed independently
        position = result.sidebarSettings.position ?? 'right';
        sidebarWidth = result.sidebarSettings.width ?? 400;
      }
    } catch (error) {
      console.error('AnnotatePro: Failed to load sidebar settings', error);
    }
  }

  /**
   * Save sidebar settings to storage (position and width only)
   */
  async function saveSettings() {
    try {
      await browser.storage.local.set({
        sidebarSettings: {
          position: position,
          width: sidebarWidth
        }
      });
    } catch (error) {
      console.error('AnnotatePro: Failed to save sidebar settings', error);
    }
  }

  /**
   * Load colors from background
   */
  async function loadColors() {
    try {
      cachedColors = await browser.runtime.sendMessage({
        type: 'GET_ALL_COLORS',
        payload: {}
      });
      cachedColors.sort((a, b) => a.sortOrder - b.sortOrder);
    } catch (error) {
      console.error('AnnotatePro: Failed to load colors', error);
      cachedColors = [];
    }
  }

  /**
   * Load annotations for current page
   */
  async function loadAnnotations() {
    try {
      const pageUrl = window.location.href;
      annotations = await browser.runtime.sendMessage({
        type: 'GET_PAGE_ANNOTATIONS',
        payload: { pageUrl }
      });
      renderAnnotationsList();
      updatePageNoteIndicator();
      updateTabBadges();
    } catch (error) {
      console.error('AnnotatePro: Failed to load annotations', error);
      annotations = [];
    }
  }

  /**
   * Update page note indicator visibility
   */
  function updatePageNoteIndicator() {
    const indicator = sidebarEl?.querySelector('.annotatepro-page-note-indicator');
    if (!indicator) return;

    const hasPageNote = annotations.some(a => a.annotationType === 'page-note' && a.note && a.note.trim());
    indicator.classList.toggle('visible', hasPageNote);
  }

  /**
   * Update tab badges with counts
   */
  function updateTabBadges() {
    const annotationsBadge = sidebarEl?.querySelector('#annotatepro-annotations-badge');
    const clipboardBadge = sidebarEl?.querySelector('#annotatepro-clipboard-badge');

    if (annotationsBadge) {
      annotationsBadge.textContent = annotations.length;
    }
    if (clipboardBadge) {
      clipboardBadge.textContent = clipboardHistory.length;
    }
  }

  /**
   * Load clipboard history from storage
   */
  async function loadClipboardHistory() {
    try {
      // Load directly from storage for reliability
      const result = await browser.storage.local.get('clipboardHistory');
      if (result.clipboardHistory && Array.isArray(result.clipboardHistory)) {
        clipboardHistory = result.clipboardHistory;
      } else {
        // Fallback to window property
        clipboardHistory = window.__annotateProClipboardHistory || [];
      }
    } catch (error) {
      // Fallback to window property
      clipboardHistory = window.__annotateProClipboardHistory || [];
    }
    updateTabBadges();
    if (activeTab === 'clipboard') {
      renderClipboardList();
    }
  }

  /**
   * Get color by ID
   */
  function getColorById(colorId) {
    return cachedColors.find(c => c.id === colorId);
  }

  /**
   * Convert hex to rgba
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
   * Get annotation color value
   */
  function getAnnotationColor(annotation) {
    if (annotation.color) return annotation.color;
    if (annotation.colorId) {
      const color = getColorById(annotation.colorId);
      if (color) return hexToRgba(color.color, 0.5);
    }
    return 'rgba(255, 235, 59, 0.5)';
  }

  /**
   * Get annotation color name
   */
  function getAnnotationColorName(annotation) {
    if (annotation.colorId) {
      const color = getColorById(annotation.colorId);
      if (color) return color.name;
    }
    return 'Default';
  }

  /**
   * Format relative time
   */
  function formatRelativeTime(timestamp) {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 4000000);
    const days = Math.floor(diff / 86400000);

    if (minutes < 1) return 'Just now';
    if (minutes < 60) return `${minutes}m ago`;
    if (hours < 24) return `${hours}h ago`;
    if (days < 7) return `${days}d ago`;
    return new Date(timestamp).toLocaleDateString();
  }

  /**
   * Escape HTML
   */
  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  /**
   * Truncate text
   */
  function truncate(text, maxLength) {
    if (!text) return '';
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength - 3) + '...';
  }

  /**
   * Create the sidebar element
   */
  function createSidebar() {
    // Remove any existing sidebar (safeguard against duplicates)
    const existingSidebar = document.querySelector('.annotatepro-sidebar');
    if (existingSidebar) {
      existingSidebar.remove();
    }

    sidebarEl = document.createElement('div');
    sidebarEl.className = `annotatepro-sidebar ${position} ${isCollapsed ? 'collapsed' : ''}`;
    sidebarEl.style.width = `${sidebarWidth}px`;
    sidebarEl.innerHTML = `
      <div class="annotatepro-sidebar-resize" title="Drag to resize"></div>
      <div class="annotatepro-sidebar-header">
        <h2 class="annotatepro-sidebar-title">
          <span class="annotatepro-sidebar-title-icon">📝</span>
          AnnotatePro
          <span class="annotatepro-sidebar-count" id="annotatepro-count">0</span>
        </h2>
        <div class="annotatepro-sidebar-actions">
          <button class="annotatepro-sidebar-action-btn" id="annotatepro-dashboard-btn" title="Open Dashboard">📊</button>
          <button class="annotatepro-sidebar-action-btn" id="annotatepro-page-note-btn" title="Page Note">📄<span class="annotatepro-page-note-indicator"></span></button>
          <button class="annotatepro-sidebar-action-btn" id="annotatepro-position-btn" title="Switch side">⇄</button>
          <button class="annotatepro-sidebar-action-btn" id="annotatepro-refresh-btn" title="Refresh">↻</button>
          <button class="annotatepro-sidebar-action-btn" id="annotatepro-close-btn" title="Close sidebar">✕</button>
        </div>
      </div>
      <div class="annotatepro-sidebar-tabs">
        <button class="annotatepro-sidebar-tab active" data-tab="annotations">Annotations <span class="annotatepro-sidebar-tab-badge" id="annotatepro-annotations-badge">0</span></button>
        <button class="annotatepro-sidebar-tab" data-tab="clipboard">Clipboard <span class="annotatepro-sidebar-tab-badge" id="annotatepro-clipboard-badge">0</span></button>
      </div>
      <div class="annotatepro-sidebar-search">
        <div class="annotatepro-sidebar-search-wrapper">
          <span class="annotatepro-sidebar-search-icon">🔍</span>
          <input type="text" class="annotatepro-sidebar-search-input" id="annotatepro-search" placeholder="Search annotations...">
          <button class="annotatepro-sidebar-search-clear" id="annotatepro-search-clear" title="Clear search (Esc)">&times;</button>
        </div>
      </div>
      <div class="annotatepro-sidebar-filter" id="annotatepro-filter">
        <button class="annotatepro-sidebar-filter-chip active" data-color="all">All</button>
      </div>
      <div class="annotatepro-sidebar-content" id="annotatepro-content">
        <div class="annotatepro-sidebar-list" id="annotatepro-list"></div>
      </div>
    `;

    document.body.appendChild(sidebarEl);

    // Set up event listeners
    setupSidebarListeners();
    setupResizeHandler();
  }

  /**
   * Toggle sidebar visibility
   */
  function toggleSidebar() {
    isCollapsed = !isCollapsed;
    sidebarEl.classList.toggle('collapsed', isCollapsed);
    saveSettings();

    // Notify content script of collapse state for badge visibility
    window.dispatchEvent(new CustomEvent('annotatepro-sidebar-toggle', {
      detail: { collapsed: isCollapsed }
    }));

    // Load data when opening
    if (!isCollapsed) {
      loadAnnotations();
      if (activeTab === 'clipboard') {
        loadClipboardHistory();
      }
    }
  }

  /**
   * Switch sidebar position
   */
  function switchPosition() {
    position = position === 'right' ? 'left' : 'right';
    sidebarEl.classList.remove('left', 'right');
    sidebarEl.classList.add(position);
    saveSettings();
  }

  /**
   * Set up resize handler for sidebar
   */
  function setupResizeHandler() {
    const resizeHandle = sidebarEl.querySelector('.annotatepro-sidebar-resize');
    if (!resizeHandle) return;

    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const MIN_WIDTH = 280;
    const MAX_WIDTH_PERCENT = 0.5; // 50% of screen

    function onMouseDown(e) {
      isResizing = true;
      startX = e.clientX;
      startWidth = sidebarEl.offsetWidth;

      sidebarEl.classList.add('resizing');
      resizeHandle.classList.add('active');
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      e.preventDefault();
    }

    function onMouseMove(e) {
      if (!isResizing) return;

      const maxWidth = window.innerWidth * MAX_WIDTH_PERCENT;
      let newWidth;

      if (position === 'right') {
        // Dragging left edge of right-side sidebar
        newWidth = startWidth + (startX - e.clientX);
      } else {
        // Dragging right edge of left-side sidebar
        newWidth = startWidth + (e.clientX - startX);
      }

      // Clamp width between min and max
      newWidth = Math.max(MIN_WIDTH, Math.min(maxWidth, newWidth));

      sidebarEl.style.width = `${newWidth}px`;
      sidebarWidth = newWidth;
    }

    function onMouseUp() {
      if (!isResizing) return;
      isResizing = false;

      sidebarEl.classList.remove('resizing');
      resizeHandle.classList.remove('active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';

      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);

      // Save the new width
      saveSettings();
    }

    resizeHandle.addEventListener('mousedown', onMouseDown);

    // Double-click to reset to default width
    resizeHandle.addEventListener('dblclick', () => {
      sidebarWidth = 400;
      sidebarEl.style.width = `${sidebarWidth}px`;
      saveSettings();
    });
  }

  /**
   * Set up sidebar event listeners
   */
  function setupSidebarListeners() {
    // Page note button - focus on page note in sidebar
    sidebarEl.querySelector('#annotatepro-page-note-btn').addEventListener('click', () => {
      // Switch to annotations tab if needed
      if (activeTab !== 'annotations') {
        activeTab = 'annotations';
        sidebarEl.querySelectorAll('.annotatepro-sidebar-tab').forEach(t => t.classList.remove('active'));
        sidebarEl.querySelector('.annotatepro-sidebar-tab[data-tab="annotations"]').classList.add('active');
        sidebarEl.querySelector('#annotatepro-filter').style.display = 'flex';
        renderAnnotationsList();
      }

      // Find page note in annotations
      const pageNote = annotations.find(a => a.annotationType === 'page-note');

      if (pageNote) {
        // Open editor for existing page note
        editingAnnotationId = pageNote.id;
        renderAnnotationsList();

        // Scroll to page note item
        setTimeout(() => {
          const pageNoteItem = sidebarEl.querySelector(`.annotatepro-sidebar-item[data-id="${pageNote.id}"]`);
          if (pageNoteItem) {
            pageNoteItem.scrollIntoView({ behavior: 'smooth', block: 'start' });
            pageNoteItem.classList.add('highlight-flash');
            setTimeout(() => pageNoteItem.classList.remove('highlight-flash'), 1000);
          }
        }, 50);
      } else {
        // No page note exists - open modal to create one
        browser.runtime.sendMessage({ type: 'COMMAND_PAGE_NOTE' });
      }
    });

    // Dashboard button - open dashboard in new tab
    sidebarEl.querySelector('#annotatepro-dashboard-btn').addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
    });

    // Position switch button
    sidebarEl.querySelector('#annotatepro-position-btn').addEventListener('click', switchPosition);

    // Refresh button
    sidebarEl.querySelector('#annotatepro-refresh-btn').addEventListener('click', () => {
      loadAnnotations();
      loadClipboardHistory();
    });

    // Close button
    sidebarEl.querySelector('#annotatepro-close-btn').addEventListener('click', () => {
      isCollapsed = true;
      sidebarEl.classList.add('collapsed');
      saveSettings();

      // Notify content script of collapse state for badge visibility
      window.dispatchEvent(new CustomEvent('annotatepro-sidebar-toggle', {
        detail: { collapsed: true }
      }));
    });

    // Tab switching
    sidebarEl.querySelectorAll('.annotatepro-sidebar-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        activeTab = tab.dataset.tab;
        sidebarEl.querySelectorAll('.annotatepro-sidebar-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');

        // Show/hide filter bar based on tab
        const filterBar = sidebarEl.querySelector('#annotatepro-filter');
        filterBar.style.display = activeTab === 'annotations' ? 'flex' : 'none';

        if (activeTab === 'annotations') {
          renderAnnotationsList();
        } else {
          loadClipboardHistory();
        }
      });
    });

    // Search input
    const searchInput = sidebarEl.querySelector('#annotatepro-search');
    const searchClear = sidebarEl.querySelector('#annotatepro-search-clear');

    searchInput.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim().toLowerCase();
      searchClear.classList.toggle('visible', searchQuery.length > 0);
      if (activeTab === 'annotations') {
        renderAnnotationsList();
      } else {
        renderClipboardList();
      }
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        clearSearch();
        // Keep focus in search bar (matching clear button behavior)
      }
    });

    searchClear.addEventListener('click', () => {
      clearSearch();
      searchInput.focus();
    });

    // Color filter clicks (delegated)
    sidebarEl.querySelector('#annotatepro-filter').addEventListener('click', (e) => {
      const chip = e.target.closest('.annotatepro-sidebar-filter-chip');
      if (!chip) return;

      const colorValue = chip.dataset.color;
      colorFilter = colorValue === 'all' ? null : colorValue;

      // Update active state
      sidebarEl.querySelectorAll('.annotatepro-sidebar-filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');

      renderAnnotationsList();
    });

    // Annotation list clicks (delegated)
    sidebarEl.querySelector('#annotatepro-content').addEventListener('click', handleContentClick);

    // Close editor when clicking anywhere outside of it (inside sidebar)
    sidebarEl.addEventListener('click', (e) => {
      if (!editingAnnotationId) return;

      // Don't close if clicking on action buttons (they have their own handlers)
      if (e.target.closest('.annotatepro-sidebar-item-action')) return;
      // Don't close if clicking on copy buttons
      if (e.target.closest('.annotatepro-sidebar-copy-btn')) return;

      const editorItem = sidebarEl.querySelector(`.annotatepro-sidebar-item[data-id="${editingAnnotationId}"]`);
      if (editorItem && !editorItem.contains(e.target)) {
        editingAnnotationId = null;
        renderAnnotationsList();
      }
    });

    // Close editor when clicking outside sidebar
    document.addEventListener('click', (e) => {
      if (!editingAnnotationId) return;
      if (sidebarEl.contains(e.target)) return;

      editingAnnotationId = null;
      renderAnnotationsList();
    });
  }

  /**
   * Clear search query and update UI
   */
  function clearSearch() {
    searchQuery = '';
    const searchInput = sidebarEl.querySelector('#annotatepro-search');
    const searchClear = sidebarEl.querySelector('#annotatepro-search-clear');
    if (searchInput) searchInput.value = '';
    if (searchClear) searchClear.classList.remove('visible');
    if (activeTab === 'annotations') {
      renderAnnotationsList();
    } else {
      renderClipboardList();
    }
  }

  /**
   * Handle clicks in the content area
   */
  async function handleContentClick(e) {
    const item = e.target.closest('.annotatepro-sidebar-item');
    const clipboardItem = e.target.closest('.annotatepro-sidebar-clipboard-item');

    // Handle annotation item clicks
    if (item) {
      const annotationId = item.dataset.id;
      const annotation = annotations.find(a => a.id === annotationId);
      if (!annotation) return;

      // Check if clicking on specific elements
      if (e.target.classList.contains('annotatepro-sidebar-checkbox')) {
        // Toggle checkbox
        const isChecked = e.target.checked;
        await updateAnnotation(annotationId, { checked: isChecked });
        return;
      }

      // Handle copy buttons
      if (e.target.classList.contains('annotatepro-sidebar-copy-btn')) {
        e.stopPropagation();
        const btn = e.target;

        if (btn.classList.contains('text-copy')) {
          // Copy annotation text
          const text = btn.dataset.text || annotation.textSnapshot || '';
          if (!text.trim()) {
            btn.textContent = 'Empty';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            return;
          }
          try {
            await navigator.clipboard.writeText(text);
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          } catch (err) {
            console.error('Failed to copy text:', err);
          }
        } else if (btn.classList.contains('note-copy')) {
          // Copy note text
          const textarea = item.querySelector('.annotatepro-sidebar-editor-textarea');
          const noteText = textarea ? textarea.value : (annotation.note || '');
          if (!noteText.trim()) {
            btn.textContent = 'Empty';
            setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
            return;
          }
          try {
            await navigator.clipboard.writeText(noteText);
            btn.textContent = 'Copied!';
            btn.classList.add('copied');
            setTimeout(() => {
              btn.textContent = 'Copy';
              btn.classList.remove('copied');
            }, 2000);
          } catch (err) {
            console.error('Failed to copy note:', err);
          }
        }
        return;
      }

      if (e.target.closest('.annotatepro-sidebar-item-action')) {
        e.stopPropagation(); // Prevent sidebar click listener from interfering
        const action = e.target.closest('.annotatepro-sidebar-item-action');
        if (action.classList.contains('edit')) {
          toggleEditor(annotationId);
        } else if (action.classList.contains('delete')) {
          if (confirm('Delete this annotation?')) {
            await deleteAnnotation(annotationId);
          }
        } else if (action.classList.contains('goto')) {
          scrollToAnnotation(annotationId);
        } else if (action.classList.contains('screenshot')) {
          // Capture screenshot of this annotation
          if (window.annotateProScreenshot) {
            const element = document.querySelector(`[data-annotatepro-id="${annotationId}"]`);
            if (element) {
              window.annotateProScreenshot.captureElement(element);
            }
          }
        }
        return;
      }

      if (e.target.closest('.annotatepro-sidebar-editor')) {
        // Don't scroll when interacting with editor
        return;
      }

      if (e.target.closest('.annotatepro-sidebar-editor-color')) {
        const colorBtn = e.target.closest('.annotatepro-sidebar-editor-color');
        const newColorId = colorBtn.dataset.colorId;
        await updateAnnotation(annotationId, { colorId: newColorId, color: null });
        return;
      }

      // Default: scroll to annotation on page
      scrollToAnnotation(annotationId);
    }

    // Handle clipboard item clicks
    if (clipboardItem) {
      const index = parseInt(clipboardItem.dataset.index);
      const entry = clipboardHistory[index];
      if (!entry) return;

      if (e.target.classList.contains('annotatepro-sidebar-clipboard-btn')) {
        e.stopPropagation();
        const action = e.target.dataset.action;
        if (action === 'copy') {
          await navigator.clipboard.writeText(entry.text);
          e.target.textContent = 'Copied!';
          setTimeout(() => { e.target.textContent = 'Copy'; }, 1500);
        } else if (action === 'delete') {
          if (!confirm('Delete this clipboard item?')) return;
          // Remove from clipboard history
          clipboardHistory.splice(index, 1);
          window.__annotateProClipboardHistory = clipboardHistory;
          // Save to storage
          try {
            await browser.storage.local.set({ clipboardHistory });
          } catch (err) {
            console.error('Failed to save clipboard history:', err);
          }
          updateTabBadges();
          renderClipboardList();
        }
      }
    }
  }

  /**
   * Scroll to annotation on page
   */
  function scrollToAnnotation(annotationId) {
    const element = document.querySelector(`[data-annotatepro-id="${annotationId}"]`);
    if (element) {
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // Flash highlight
      element.style.transition = 'outline 0.3s';
      element.style.outline = '3px solid #6366f1';
      setTimeout(() => {
        element.style.outline = '';
      }, 2000);
    }
  }

  /**
   * Toggle inline editor for annotation
   */
  function toggleEditor(annotationId) {
    if (editingAnnotationId === annotationId) {
      editingAnnotationId = null;
    } else {
      editingAnnotationId = annotationId;
    }
    renderAnnotationsList();
  }

  /**
   * Update annotation
   */
  async function updateAnnotation(annotationId, patch) {
    try {
      await browser.runtime.sendMessage({
        type: 'UPDATE_ANNOTATION',
        payload: { id: annotationId, patch }
      });

      // Update local data
      const annotation = annotations.find(a => a.id === annotationId);
      if (annotation) {
        Object.assign(annotation, patch);
      }

      renderAnnotationsList();
    } catch (error) {
      console.error('AnnotatePro: Failed to update annotation', error);
    }
  }

  /**
   * Delete annotation
   */
  async function deleteAnnotation(annotationId) {
    try {
      await browser.runtime.sendMessage({
        type: 'DELETE_ANNOTATION',
        payload: { id: annotationId }
      });

      annotations = annotations.filter(a => a.id !== annotationId);
      renderAnnotationsList();
    } catch (error) {
      console.error('AnnotatePro: Failed to delete annotation', error);
    }
  }

  /**
   * Render color filter chips
   */
  function renderColorFilter() {
    const filterEl = sidebarEl.querySelector('#annotatepro-filter');

    let html = '<button class="annotatepro-sidebar-filter-chip ' + (!colorFilter ? 'active' : '') + '" data-color="all">All</button>';

    for (const color of cachedColors) {
      const isActive = colorFilter === color.id;
      html += `
        <button class="annotatepro-sidebar-filter-chip ${isActive ? 'active' : ''}"
                data-color="${color.id}"
                style="--chip-color: ${hexToRgba(color.color, 0.3)}">
          ${escapeHtml(color.name)}
        </button>
      `;
    }

    filterEl.innerHTML = html;
  }

  /**
   * Render annotations list
   */
  function renderAnnotationsList() {
    const listEl = sidebarEl.querySelector('#annotatepro-list');
    const countEl = sidebarEl.querySelector('#annotatepro-count');

    // Render color filter
    renderColorFilter();

    // Get current search query from input (ensure it's in sync)
    const searchInput = sidebarEl.querySelector('#annotatepro-search');
    const currentSearchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Filter annotations
    let filtered = [...annotations];

    // Apply color filter
    if (colorFilter) {
      filtered = filtered.filter(a => a.colorId === colorFilter);
    }

    // Apply search filter
    if (currentSearchQuery) {
      filtered = filtered.filter(a => {
        const text = (a.textSnapshot || '').toLowerCase();
        const note = (a.note || '').toLowerCase();
        const type = (a.annotationType || '').toLowerCase();
        return text.includes(currentSearchQuery) || note.includes(currentSearchQuery) || type.includes(currentSearchQuery);
      });
    }

    // Sort: page notes first, then by updated time
    filtered.sort((a, b) => {
      if (a.annotationType === 'page-note' && b.annotationType !== 'page-note') return -1;
      if (a.annotationType !== 'page-note' && b.annotationType === 'page-note') return 1;
      return (b.updatedAt || 0) - (a.updatedAt || 0);
    });

    countEl.textContent = filtered.length;

    if (filtered.length === 0) {
      const emptyMessage = currentSearchQuery
        ? `No annotations matching "${escapeHtml(currentSearchQuery)}"`
        : (colorFilter ? 'No annotations with this color' : 'Highlight text or add checkboxes to get started');

      listEl.innerHTML = `
        <div class="annotatepro-sidebar-empty">
          <div class="annotatepro-sidebar-empty-icon">${currentSearchQuery ? '🔍' : '📝'}</div>
          <div class="annotatepro-sidebar-empty-title">${currentSearchQuery ? 'No results' : 'No annotations'}</div>
          <div class="annotatepro-sidebar-empty-text">${emptyMessage}</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map(annotation => renderAnnotationItem(annotation)).join('');

    // Set up note textarea auto-save
    filtered.forEach(annotation => {
      if (editingAnnotationId === annotation.id) {
        const textarea = listEl.querySelector(`[data-annotation-id="${annotation.id}"] .annotatepro-sidebar-editor-textarea`);
        if (textarea) {
          let saveTimer;
          textarea.addEventListener('input', () => {
            clearTimeout(saveTimer);
            saveTimer = setTimeout(async () => {
              await updateAnnotation(annotation.id, { note: textarea.value });
              const statusEl = textarea.parentElement.querySelector('.annotatepro-sidebar-editor-status');
              if (statusEl) {
                statusEl.textContent = 'Saved';
                setTimeout(() => { statusEl.textContent = ''; }, 1500);
              }
            }, 500);
          });
        }
      }
    });
  }

  /**
   * Render single annotation item
   */
  function renderAnnotationItem(annotation) {
    const isPageNote = annotation.annotationType === 'page-note';
    const isCheckbox = annotation.annotationType === 'checkbox';
    const color = getAnnotationColor(annotation);
    const colorName = getAnnotationColorName(annotation);
    const text = isPageNote ? 'Page Note' : (annotation.textSnapshot || '(element)');
    const isEditing = editingAnnotationId === annotation.id;

    const typeLabel = isPageNote ? 'Page Note' : (isCheckbox ? 'Checkbox' : 'Highlight');

    let editorHtml = '';
    if (isEditing) {
      const colorSwatches = cachedColors.map(c => `
        <button class="annotatepro-sidebar-editor-color ${c.id === annotation.colorId ? 'active' : ''}"
                data-color-id="${c.id}"
                style="background: ${hexToRgba(c.color, 0.5)}"
                title="${escapeHtml(c.name)}"></button>
      `).join('');

      editorHtml = `
        <div class="annotatepro-sidebar-editor">
          ${!isPageNote ? `<div class="annotatepro-sidebar-editor-colors">${colorSwatches}</div>` : ''}
          <div class="annotatepro-sidebar-editor-note-header">
            <button class="annotatepro-sidebar-copy-btn note-copy" title="Copy note">Copy</button>
          </div>
          <textarea class="annotatepro-sidebar-editor-textarea"
                    placeholder="Add a note...">${escapeHtml(annotation.note || '')}</textarea>
          <div class="annotatepro-sidebar-editor-status"></div>
        </div>
      `;
    }

    return `
      <div class="annotatepro-sidebar-item ${annotation.annotationType}"
           data-id="${annotation.id}"
           data-annotation-id="${annotation.id}"
           style="--annotation-color: ${color}">
        <div class="annotatepro-sidebar-item-header">
          <span class="annotatepro-sidebar-item-type">
            ${!isPageNote ? `<span class="annotatepro-sidebar-item-color" style="background: ${color}"></span>` : ''}
            ${typeLabel}${!isPageNote && colorName !== 'Default' ? ` - ${escapeHtml(colorName)}` : ''}
          </span>
          <span class="annotatepro-sidebar-item-time">${formatRelativeTime(annotation.updatedAt)}</span>
        </div>
        <div class="annotatepro-sidebar-item-content">
          ${isCheckbox ? `<input type="checkbox" class="annotatepro-sidebar-checkbox" ${annotation.checked ? 'checked' : ''}>` : ''}
          <div class="annotatepro-sidebar-item-content-text">
            <div class="annotatepro-sidebar-item-text-wrapper">
              <div class="annotatepro-sidebar-item-text">${escapeHtml(truncate(text, 120))}</div>
              ${!isPageNote ? `<button class="annotatepro-sidebar-copy-btn text-copy" data-text="${escapeHtml(annotation.textSnapshot || '')}" title="Copy text">Copy</button>` : ''}
            </div>
            ${annotation.note && !isEditing ? `<div class="annotatepro-sidebar-item-note">${escapeHtml(truncate(annotation.note, 80))}</div>` : ''}
          </div>
        </div>
        ${editorHtml}
        <div class="annotatepro-sidebar-item-actions">
          <button class="annotatepro-sidebar-item-action goto" title="Go to annotation">Go to</button>
          ${!isPageNote ? `<button class="annotatepro-sidebar-item-action screenshot" title="Capture screenshot">Screenshot</button>` : ''}
          <button class="annotatepro-sidebar-item-action edit" title="Edit">${isEditing ? 'Done' : 'Edit'}</button>
          <button class="annotatepro-sidebar-item-action delete" title="Delete">Delete</button>
        </div>
      </div>
    `;
  }

  /**
   * Render clipboard list
   */
  function renderClipboardList() {
    const listEl = sidebarEl.querySelector('#annotatepro-list');
    const countEl = sidebarEl.querySelector('#annotatepro-count');

    // Get current search query from input (ensure it's in sync)
    const searchInput = sidebarEl.querySelector('#annotatepro-search');
    const currentSearchQuery = searchInput ? searchInput.value.trim().toLowerCase() : '';

    // Filter by search query (only search text content)
    let filtered = [...clipboardHistory];
    if (currentSearchQuery) {
      filtered = filtered.filter(entry => {
        const text = (entry.text || '').toLowerCase();
        return text.includes(currentSearchQuery);
      });
    }

    countEl.textContent = filtered.length;

    if (filtered.length === 0) {
      listEl.innerHTML = `
        <div class="annotatepro-sidebar-empty">
          <div class="annotatepro-sidebar-empty-icon">📋</div>
          <div class="annotatepro-sidebar-empty-title">${searchQuery ? 'No matching items' : 'No clipboard history'}</div>
          <div class="annotatepro-sidebar-empty-text">${searchQuery ? 'Try a different search term' : 'Copy text on this page to see it here'}</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = filtered.map((entry, index) => {
      // Find original index for data attribute
      const originalIndex = clipboardHistory.indexOf(entry);
      return `
        <div class="annotatepro-sidebar-clipboard-item" data-index="${originalIndex}">
          <div class="annotatepro-sidebar-clipboard-text">${escapeHtml(truncate(entry.text, 150))}</div>
          <div class="annotatepro-sidebar-clipboard-meta">
            <span>${formatRelativeTime(entry.timestamp)}</span>
            <div class="annotatepro-sidebar-clipboard-actions">
              <button class="annotatepro-sidebar-clipboard-btn copy-btn" data-action="copy">Copy</button>
              <button class="annotatepro-sidebar-clipboard-btn delete-btn" data-action="delete">&times;</button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  /**
   * Set up message listener for real-time updates
   */
  function setupMessageListener() {
    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      const currentPageUrl = window.location.href;

      switch (message.type) {
        case 'COMMAND_TOGGLE_SIDEBAR':
          toggleSidebar();
          // Return current state so popup can update
          sendResponse({ collapsed: isCollapsed, position, width: sidebarWidth });
          return true;

        case 'COMMAND_SWITCH_SIDEBAR_POSITION':
          switchPosition();
          // Return current state so popup can update
          sendResponse({ collapsed: isCollapsed, position, width: sidebarWidth });
          return true;

        case 'GET_SIDEBAR_STATE':
          sendResponse({ collapsed: isCollapsed, position, width: sidebarWidth });
          return true;

        case 'ANNOTATION_ADDED':
          if (message.pageUrl === currentPageUrl && message.annotation) {
            annotations.push(message.annotation);
            if (!isCollapsed && activeTab === 'annotations') {
              renderAnnotationsList();
            }
          }
          break;

        case 'ANNOTATION_UPDATED':
          if (message.pageUrl === currentPageUrl && message.annotationId) {
            const annotation = annotations.find(a => a.id === message.annotationId);
            if (annotation && message.patch) {
              Object.assign(annotation, message.patch);
              if (!isCollapsed && activeTab === 'annotations') {
                renderAnnotationsList();
              }
            }
          }
          break;

        case 'ANNOTATION_DELETED':
          if (message.pageUrl === currentPageUrl && message.annotationId) {
            annotations = annotations.filter(a => a.id !== message.annotationId);
            if (!isCollapsed && activeTab === 'annotations') {
              renderAnnotationsList();
            }
          }
          break;

        case 'PAGE_CLEARED':
          if (message.pageUrl === currentPageUrl) {
            annotations = [];
            if (!isCollapsed && activeTab === 'annotations') {
              renderAnnotationsList();
            }
          }
          break;

        case 'COLOR_ADDED':
        case 'COLOR_UPDATED':
        case 'COLOR_DELETED':
          loadColors().then(() => {
            if (!isCollapsed && activeTab === 'annotations') {
              renderAnnotationsList();
            }
          });
          break;
      }
    });
  }

  // Initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
