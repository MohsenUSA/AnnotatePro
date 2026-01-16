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
  ADD_GROUP: 'ADD_GROUP',
  GET_ALL_GROUPS: 'GET_ALL_GROUPS',
  DELETE_GROUP: 'DELETE_GROUP'
};

/**
 * Notify all dashboard tabs to refresh their data
 */
async function notifyDashboardTabs(messageType, data = {}) {
  const dashboardUrl = browser.runtime.getURL('dashboard/dashboard.html');
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (tab.url && tab.url.startsWith(dashboardUrl)) {
      browser.tabs.sendMessage(tab.id, { type: messageType, ...data }).catch(() => {});
    }
  }
}

/**
 * Handle messages from content scripts and popup
 */
browser.runtime.onMessage.addListener((message, sender) => {
  const { type, payload } = message;

  switch (type) {
    case MessageType.ADD_ANNOTATION:
      return db.addAnnotation(payload);

    case MessageType.UPDATE_ANNOTATION:
      return db.updateAnnotation(payload.id, payload.patch);

    case MessageType.DELETE_ANNOTATION:
      return db.deleteAnnotation(payload.id);

    case MessageType.GET_ANNOTATION:
      return db.getAnnotation(payload.id);

    case MessageType.GET_PAGE_ANNOTATIONS:
      return db.getAnnotationsByPage(payload.pageUrl);

    case MessageType.GET_ALL_ANNOTATIONS:
      return db.getAllAnnotations();

    case MessageType.GET_ANNOTATION_COUNT:
      return db.getAnnotationCount();

    case MessageType.GET_PAGES_SUMMARY:
      return db.getPagesSummary();

    case MessageType.CLEAR_PAGE_ANNOTATIONS:
      return db.clearPageAnnotations(payload.pageUrl).then(() => {
        notifyDashboardTabs('REFRESH_DATA');
      });

    case MessageType.IMPORT_ANNOTATIONS:
      return db.importAnnotations(payload.annotations);

    case MessageType.ADD_GROUP:
      return db.addGroup(payload);

    case MessageType.GET_ALL_GROUPS:
      return db.getAllGroups();

    case MessageType.DELETE_GROUP:
      return db.deleteGroup(payload.id);

    case 'OPEN_DASHBOARD':
      browser.tabs.create({ url: browser.runtime.getURL('dashboard/dashboard.html') });
      return Promise.resolve();

    case 'BROADCAST_CHECKBOX_UPDATE':
      notifyDashboardTabs('CHECKBOX_UPDATED', {
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
  }
});

/**
 * Create context menus
 */
function createContextMenus() {
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

  // Highlight with intent submenu
  browser.contextMenus.create({
    id: 'annotatepro-highlight-intent',
    parentId: 'annotatepro-parent',
    title: 'Highlight as...',
    contexts: ['selection']
  });

  const intents = [
    { id: 'ACTION', title: 'Action (Yellow)' },
    { id: 'QUESTION', title: 'Question (Blue)' },
    { id: 'RISK', title: 'Risk (Red)' },
    { id: 'REFERENCE', title: 'Reference (Green)' },
    { id: 'CUSTOM', title: 'Custom (Purple)' }
  ];

  for (const intent of intents) {
    browser.contextMenus.create({
      id: `annotatepro-intent-${intent.id}`,
      parentId: 'annotatepro-highlight-intent',
      title: intent.title,
      contexts: ['selection']
    });
  }

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

  // Add/Edit Note
  browser.contextMenus.create({
    id: 'annotatepro-edit-note',
    parentId: 'annotatepro-parent',
    title: 'Add/Edit Note',
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
}

/**
 * Handle context menu clicks
 */
browser.contextMenus.onClicked.addListener(async (info, tab) => {
  const menuId = info.menuItemId;

  if (menuId === 'annotatepro-highlight') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_HIGHLIGHT', intent: 'DEFAULT' });
  } else if (menuId.startsWith('annotatepro-intent-')) {
    const intent = menuId.replace('annotatepro-intent-', '');
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_HIGHLIGHT', intent });
  } else if (menuId === 'annotatepro-checkbox') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CHECKBOX' });
  } else if (menuId === 'annotatepro-edit-note') {
    console.log('AnnotatePro: Sending COMMAND_EDIT_NOTE to tab', tab.id);
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_EDIT_NOTE' });
  } else if (menuId === 'annotatepro-remove') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_REMOVE' });
  } else if (menuId === 'annotatepro-clear-page') {
    // Show confirmation dialog in content script
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CLEAR_CONFIRM' });
  }
});

/**
 * Initialize database and context menus on install
 */
browser.runtime.onInstalled.addListener(async (details) => {
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
