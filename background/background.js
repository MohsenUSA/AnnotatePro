/**
 * Background Script for AnnotatePro
 * Owns all IndexedDB access and handles message routing
 */

import { db } from './indexeddb-helper.js';

// Message types
const MessageType = {
  ADD_ANNOTATION: 'ADD_ANNOTATION',
  UPDATE_ANNOTATION: 'UPDATE_ANNOTATION',
  DELETE_ANNOTATION: 'DELETE_ANNOTATION',
  GET_ANNOTATION: 'GET_ANNOTATION',
  GET_PAGE_ANNOTATIONS: 'GET_PAGE_ANNOTATIONS',
  GET_ALL_ANNOTATIONS: 'GET_ALL_ANNOTATIONS',
  GET_ANNOTATION_COUNT: 'GET_ANNOTATION_COUNT',
  GET_PAGES_SUMMARY: 'GET_PAGES_SUMMARY',
  CLEAR_PAGE_ANNOTATIONS: 'CLEAR_PAGE_ANNOTATIONS',
  IMPORT_ANNOTATIONS: 'IMPORT_ANNOTATIONS',
  SEARCH_ANNOTATIONS: 'SEARCH_ANNOTATIONS',
  ADD_GROUP: 'ADD_GROUP',
  GET_ALL_GROUPS: 'GET_ALL_GROUPS',
  DELETE_GROUP: 'DELETE_GROUP',
  // Color operations
  ADD_COLOR: 'ADD_COLOR',
  GET_ALL_COLORS: 'GET_ALL_COLORS',
  GET_COLOR: 'GET_COLOR',
  UPDATE_COLOR: 'UPDATE_COLOR',
  DELETE_COLOR: 'DELETE_COLOR'
};

/**
 * Broadcast a message to all extension contexts (dashboard, popup, content scripts)
 */
async function broadcastMessage(messageType, data = {}) {
  const dashboardUrl = browser.runtime.getURL('dashboard/dashboard.html');
  const tabs = await browser.tabs.query({});

  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(dashboardUrl)) {
      // Send to dashboard tabs
      browser.tabs.sendMessage(tab.id, { type: messageType, ...data }).catch(() => {});
    } else if (data.pageUrl && tab.url) {
      // Send to content scripts on matching pages (exact URL match including hash)
      if (tab.url === data.pageUrl) {
        browser.tabs.sendMessage(tab.id, { type: messageType, ...data }).catch(() => {});
      }
    }
  }

  // Send to popup (if open) via runtime message
  browser.runtime.sendMessage({ type: messageType, ...data }).catch(() => {});
}

/**
 * Handle messages from content scripts and popup
 */
browser.runtime.onMessage.addListener((message, sender) => {
  const { type, payload } = message;

  switch (type) {
    case MessageType.ADD_ANNOTATION:
      return db.addAnnotation(payload).then(async saved => {
        // Track color usage
        if (saved.colorId) {
          await db.incrementColorUsage(saved.colorId);
        }
        broadcastMessage('ANNOTATION_ADDED', { annotation: saved, pageUrl: saved.pageUrl });
        return saved;
      });

    case MessageType.UPDATE_ANNOTATION:
      return db.getAnnotation(payload.id).then(async oldAnnotation => {
        const updated = await db.updateAnnotation(payload.id, payload.patch);

        // Track color usage changes
        if (payload.patch.colorId && oldAnnotation?.colorId !== payload.patch.colorId) {
          if (oldAnnotation?.colorId) {
            await db.decrementColorUsage(oldAnnotation.colorId);
          }
          await db.incrementColorUsage(payload.patch.colorId);
        }

        broadcastMessage('ANNOTATION_UPDATED', {
          annotationId: payload.id,
          patch: payload.patch,
          pageUrl: updated?.pageUrl
        });
        return updated;
      });

    case MessageType.DELETE_ANNOTATION:
      return db.getAnnotation(payload.id).then(async annotation => {
        await db.deleteAnnotation(payload.id);

        // Track color usage
        if (annotation?.colorId) {
          await db.decrementColorUsage(annotation.colorId);
        }

        broadcastMessage('ANNOTATION_DELETED', {
          annotationId: payload.id,
          pageUrl: annotation?.pageUrl
        });
      });

    case MessageType.GET_ANNOTATION:
      return db.getAnnotation(payload.id);

    case MessageType.GET_PAGE_ANNOTATIONS:
      return db.getAnnotationsByPage(payload.pageUrl);

    case MessageType.GET_ALL_ANNOTATIONS:
      return db.getAllAnnotations();

    case MessageType.GET_ANNOTATION_COUNT:
      return db.getAnnotationCount();

    case MessageType.GET_PAGES_SUMMARY:
      return db.getPagesSummary().then(async (pages) => {
        // Add clipboard counts from storage
        try {
          const { clipboardHistory = [] } = await browser.storage.local.get('clipboardHistory');

          // Count clipboard items per page
          const clipboardCounts = {};
          for (const entry of clipboardHistory) {
            if (entry.pageUrl) {
              clipboardCounts[entry.pageUrl] = (clipboardCounts[entry.pageUrl] || 0) + 1;
            }
          }

          // Add clipboard count to each page
          for (const page of pages) {
            page.clipboardCount = clipboardCounts[page.pageUrl] || 0;
          }

          // Add pages that only have clipboard entries (no annotations)
          for (const [pageUrl, count] of Object.entries(clipboardCounts)) {
            if (!pages.find(p => p.pageUrl === pageUrl)) {
              const entry = clipboardHistory.find(e => e.pageUrl === pageUrl);
              pages.push({
                pageUrl,
                title: entry?.pageTitle || pageUrl,
                highlightCount: 0,
                checkboxCount: 0,
                pageNoteCount: 0,
                clipboardCount: count,
                lastUpdated: entry?.timestamp || Date.now()
              });
            }
          }

          // Re-sort by last updated
          pages.sort((a, b) => b.lastUpdated - a.lastUpdated);
        } catch (e) {
          console.error('Failed to load clipboard counts:', e);
        }
        return pages;
      });

    case MessageType.CLEAR_PAGE_ANNOTATIONS:
      return db.clearPageAnnotations(payload.pageUrl).then(() => {
        broadcastMessage('PAGE_CLEARED', { pageUrl: payload.pageUrl });
      });

    case MessageType.IMPORT_ANNOTATIONS:
      return db.importAnnotations(payload.annotations).then(result => {
        broadcastMessage('ANNOTATIONS_IMPORTED', { result });
        return result;
      });

    case MessageType.SEARCH_ANNOTATIONS:
      return db.searchAnnotations(payload.query, payload.options).then(async (annotations) => {
        // Also search clipboard items if not filtering by type (or if clipboard type included)
        const typeFilter = payload.options?.types || [];
        const includeClipboard = typeFilter.length === 0 || typeFilter.includes('clipboard');

        if (includeClipboard) {
          try {
            const { clipboardHistory = [] } = await browser.storage.local.get('clipboardHistory');
            const query = (payload.query || '').toLowerCase();

            let matchingClipboard = clipboardHistory;

            // Filter by search query
            if (query) {
              matchingClipboard = matchingClipboard.filter(item =>
                (item.text || '').toLowerCase().includes(query) ||
                (item.pageTitle || '').toLowerCase().includes(query) ||
                (item.pageUrl || '').toLowerCase().includes(query)
              );
            }

            // Apply date range filter if present
            if (payload.options?.dateRange) {
              const now = Date.now();
              const ranges = {
                'today': 24 * 60 * 60 * 1000,
                'week': 7 * 24 * 60 * 60 * 1000,
                'month': 30 * 24 * 60 * 60 * 1000
              };
              const maxAge = ranges[payload.options.dateRange];
              if (maxAge) {
                matchingClipboard = matchingClipboard.filter(item =>
                  (now - (item.timestamp || 0)) <= maxAge
                );
              }
            }

            // Convert clipboard items to annotation-like format
            const clipboardAsAnnotations = matchingClipboard.map(item => ({
              id: `clipboard-${item.timestamp}`,
              annotationType: 'clipboard',
              textSnapshot: item.text,
              pageUrl: item.pageUrl,
              pageTitle: item.pageTitle,
              createdAt: item.timestamp,
              updatedAt: item.timestamp,
              isClipboard: true
            }));

            // Combine and sort by updatedAt
            const combined = [...annotations, ...clipboardAsAnnotations];
            combined.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            return combined;
          } catch (e) {
            console.error('Failed to search clipboard:', e);
          }
        }

        return annotations;
      });

    case 'CLEAR_ALL_ANNOTATIONS':
      return db.clearAllAnnotations().then(() => {
        broadcastMessage('DATABASE_CLEARED', {});
      });

    case MessageType.ADD_GROUP:
      return db.addGroup(payload);

    case MessageType.GET_ALL_GROUPS:
      return db.getAllGroups();

    case MessageType.DELETE_GROUP:
      return db.deleteGroup(payload.id);

    // Color operations
    case MessageType.ADD_COLOR:
      return db.addColor(payload).then(color => {
        broadcastMessage('COLOR_ADDED', { color });
        // Rebuild context menus with new color
        createContextMenus();
        return color;
      });

    case MessageType.GET_ALL_COLORS:
      return db.getAllColors();

    case MessageType.GET_COLOR:
      return db.getColor(payload.id);

    case MessageType.UPDATE_COLOR:
      return db.updateColor(payload.id, payload.patch).then(color => {
        broadcastMessage('COLOR_UPDATED', { color });
        // Rebuild context menus if color name changed
        if (payload.patch.name) {
          createContextMenus();
        }
        return color;
      });

    case MessageType.DELETE_COLOR:
      return db.deleteColor(payload.id, payload.reassignToColorId).then(result => {
        broadcastMessage('COLOR_DELETED', { colorId: payload.id });
        // Rebuild context menus without deleted color
        createContextMenus();
        return result;
      });

    case 'OPEN_DASHBOARD':
      browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
      return Promise.resolve();

    case 'CAPTURE_SCREENSHOT':
      // Capture the visible tab as a screenshot
      return browser.tabs.captureVisibleTab(null, { format: 'png' })
        .then(dataUrl => ({ dataUrl }))
        .catch(error => {
          console.error('AnnotatePro: Screenshot capture failed', error);
          return { error: error.message };
        });

    case 'BROADCAST_CHECKBOX_UPDATE':
      // This is now handled by ANNOTATION_UPDATED broadcast, but keep for backwards compatibility
      broadcastMessage('CHECKBOX_UPDATED', {
        annotationId: payload?.annotationId || message.annotationId,
        checked: payload?.checked ?? message.checked
      });
      return Promise.resolve();

    default:
      return Promise.reject(new Error(`Unknown message type: ${type}`));
  }
});

/**
 * Handle keyboard commands
 */
browser.commands.onCommand.addListener(async (command) => {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  if (tabs.length === 0) return;

  const tabId = tabs[0].id;

  switch (command) {
    case 'toggle-highlight':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_HIGHLIGHT' });
      break;
    case 'toggle-checkbox':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_CHECKBOX' });
      break;
    case 'toggle-sidebar':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_TOGGLE_SIDEBAR' });
      break;
    case 'capture-screenshot':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_CAPTURE_AREA' });
      break;
  }
});

/**
 * Create context menus
 */
async function createContextMenus() {
  // Remove all existing menus first
  await browser.contextMenus.removeAll();

  // Parent menu
  browser.contextMenus.create({
    id: 'annotatepro-parent',
    title: 'AnnotatePro',
    contexts: ['all']
  });

  // Highlight selection (only when text selected)
  browser.contextMenus.create({
    id: 'annotatepro-highlight',
    parentId: 'annotatepro-parent',
    title: 'Highlight Selection',
    contexts: ['selection']
  });

  // Highlight with color submenu
  browser.contextMenus.create({
    id: 'annotatepro-highlight-color',
    parentId: 'annotatepro-parent',
    title: 'Highlight as...',
    contexts: ['selection']
  });

  // Get colors from database and create menu items
  try {
    const colors = await db.getAllColors();
    colors.sort((a, b) => a.sortOrder - b.sortOrder);

    for (const color of colors) {
      browser.contextMenus.create({
        id: `annotatepro-color-${color.id}`,
        parentId: 'annotatepro-highlight-color',
        title: color.name,
        contexts: ['selection']
      });
    }
  } catch (error) {
    console.error('AnnotatePro: Failed to load colors for context menu', error);
    // Fallback to default colors if database not ready
    const defaultColors = [
      { id: 'default-action', name: 'Action' },
      { id: 'default-question', name: 'Question' },
      { id: 'default-risk', name: 'Risk' },
      { id: 'default-reference', name: 'Reference' }
    ];
    for (const color of defaultColors) {
      browser.contextMenus.create({
        id: `annotatepro-color-${color.id}`,
        parentId: 'annotatepro-highlight-color',
        title: color.name,
        contexts: ['selection']
      });
    }
  }

  // Add/Edit Note
  browser.contextMenus.create({
    id: 'annotatepro-edit-note',
    parentId: 'annotatepro-parent',
    title: 'Add/Edit Note',
    contexts: ['all']
  });

  // Add Page Note
  browser.contextMenus.create({
    id: 'annotatepro-page-note',
    parentId: 'annotatepro-parent',
    title: 'Add Page Note',
    contexts: ['page']
  });

  // Separator
  browser.contextMenus.create({
    id: 'annotatepro-separator-1',
    parentId: 'annotatepro-parent',
    type: 'separator',
    contexts: ['all']
  });

  // Add checkbox
  browser.contextMenus.create({
    id: 'annotatepro-checkbox',
    parentId: 'annotatepro-parent',
    title: 'Add Checkbox',
    contexts: ['all']
  });

  // Separator
  browser.contextMenus.create({
    id: 'annotatepro-separator-2',
    parentId: 'annotatepro-parent',
    type: 'separator',
    contexts: ['all']
  });

  // Remove annotation
  browser.contextMenus.create({
    id: 'annotatepro-remove',
    parentId: 'annotatepro-parent',
    title: 'Remove Annotation',
    contexts: ['all']
  });

  // Clear all on page
  browser.contextMenus.create({
    id: 'annotatepro-clear-page',
    parentId: 'annotatepro-parent',
    title: 'Clear All on Page',
    contexts: ['all']
  });

  // Separator
  browser.contextMenus.create({
    id: 'annotatepro-separator-3',
    parentId: 'annotatepro-parent',
    type: 'separator',
    contexts: ['all']
  });

  // Sidebar submenu
  browser.contextMenus.create({
    id: 'annotatepro-sidebar-parent',
    parentId: 'annotatepro-parent',
    title: 'Sidebar',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-sidebar-toggle',
    parentId: 'annotatepro-sidebar-parent',
    title: 'Show/Hide Sidebar',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-sidebar-position',
    parentId: 'annotatepro-sidebar-parent',
    title: 'Switch Side (Left/Right)',
    contexts: ['all']
  });

  // Capture screenshot submenu
  browser.contextMenus.create({
    id: 'annotatepro-screenshot-parent',
    parentId: 'annotatepro-parent',
    title: 'Capture Screenshot',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-capture-area',
    parentId: 'annotatepro-screenshot-parent',
    title: 'Selected Area',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-capture-visible',
    parentId: 'annotatepro-screenshot-parent',
    title: 'Visible Area',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-capture-fullpage',
    parentId: 'annotatepro-screenshot-parent',
    title: 'Whole Page',
    contexts: ['all']
  });
}

/**
 * Handle context menu clicks
 */
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;

  if (menuId === 'annotatepro-highlight') {
    // Use default color (first color in sort order)
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_HIGHLIGHT', colorId: 'default-action' });
  } else if (menuId.startsWith('annotatepro-color-')) {
    const colorId = menuId.replace('annotatepro-color-', '');
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_HIGHLIGHT', colorId });
  } else if (menuId.startsWith('annotatepro-intent-')) {
    // Legacy support for old intent-based menu items
    const intent = menuId.replace('annotatepro-intent-', '');
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_HIGHLIGHT', intent });
  } else if (menuId === 'annotatepro-checkbox') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CHECKBOX' });
  } else if (menuId === 'annotatepro-edit-note') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_EDIT_NOTE' });
  } else if (menuId === 'annotatepro-page-note') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_PAGE_NOTE' });
  } else if (menuId === 'annotatepro-remove') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_REMOVE' });
  } else if (menuId === 'annotatepro-clear-page') {
    // Show confirmation dialog in content script
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CLEAR_CONFIRM' });
  } else if (menuId === 'annotatepro-sidebar-toggle') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_TOGGLE_SIDEBAR' });
  } else if (menuId === 'annotatepro-sidebar-position') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_SWITCH_SIDEBAR_POSITION' });
  } else if (menuId === 'annotatepro-capture-area') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_AREA' });
  } else if (menuId === 'annotatepro-capture-visible') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_VISIBLE' });
  } else if (menuId === 'annotatepro-capture-fullpage') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_FULL_PAGE' });
  }
});

/**
 * Initialize database and context menus on install
 */
browser.runtime.onInstalled.addListener(async () => {
  await db.open();
  createContextMenus();
  console.log('AnnotatePro: Extension installed/updated, context menus created');
});

/**
 * Initialize on every script startup (including wake from suspension)
 */
(async function initBackground() {
  try {
    // Pre-open database immediately so it's ready for requests
    await db.open();
    console.log('AnnotatePro: Background script ready');
  } catch (error) {
    console.error('AnnotatePro: Failed to initialize background:', error);
  }
})();

/**
 * Keep background script alive by responding to alarms
 * This helps prevent Firefox from suspending the background too aggressively
 */
browser.alarms?.create('keepalive', { periodInMinutes: 0.5 });
browser.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === 'keepalive') {
    // Just a heartbeat to keep the script alive
  }
});
