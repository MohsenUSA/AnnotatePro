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
      return db.clearPageAnnotations(payload.pageUrl);

    case MessageType.IMPORT_ANNOTATIONS:
      return db.importAnnotations(payload.annotations);

    case MessageType.ADD_GROUP:
      return db.addGroup(payload);

    case MessageType.GET_ALL_GROUPS:
      return db.getAllGroups();

    case MessageType.DELETE_GROUP:
      return db.deleteGroup(payload.id);

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
  } else if (menuId === 'annotatepro-remove') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_REMOVE' });
  } else if (menuId === 'annotatepro-clear-page') {
    const pageUrl = tab.url.split('#')[0];
    await db.clearPageAnnotations(pageUrl);
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_RELOAD_ANNOTATIONS' });
  }
});

/**
 * Initialize database and context menus on install
 */
browser.runtime.onInstalled.addListener(async (details) => {
  await db.open();
  createContextMenus();
  console.log('AnnotatePro: Database initialized, context menus created');
});

console.log('AnnotatePro: Background script loaded');
