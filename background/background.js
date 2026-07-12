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
  DELETE_COLOR: 'DELETE_COLOR',
  // Page-find operations (Firefox browser.find API — native, no DOM injection)
  PAGE_FIND_QUERY: 'PAGE_FIND_QUERY',
  PAGE_FIND_NEXT: 'PAGE_FIND_NEXT',
  PAGE_FIND_PREV: 'PAGE_FIND_PREV',
  PAGE_FIND_CLEAR: 'PAGE_FIND_CLEAR',
  PAGE_FIND_GET_STATE: 'PAGE_FIND_GET_STATE',
  // Link preview (OG metadata fetch + cache for clipboard URLs)
  FETCH_LINK_PREVIEW: 'FETCH_LINK_PREVIEW'
};

// Link preview cache lives in browser.storage.local under LINK_PREVIEW_KEY.
// Each entry: { title, description, image, domain, status, fetchedAt }.
const LINK_PREVIEW_KEY = 'linkPreviewCache';
const LINK_PREVIEW_OK_TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days for successful fetches
const LINK_PREVIEW_FAIL_TTL = 24 * 60 * 60 * 1000;      // 1 day for failures (retry sooner)
const LINK_PREVIEW_PRUNE_AGE = 90 * 24 * 60 * 60 * 1000;
const LINK_PREVIEW_BODY_LIMIT = 256 * 1024;             // head tags live in the first 256KB
const LINK_PREVIEW_FETCH_TIMEOUT = 10000;

async function getLinkPreviewCache() {
  const out = await browser.storage.local.get(LINK_PREVIEW_KEY);
  return out[LINK_PREVIEW_KEY] || {};
}

async function setLinkPreviewCache(cache) {
  const now = Date.now();
  for (const [k, v] of Object.entries(cache)) {
    if (now - (v.fetchedAt || 0) > LINK_PREVIEW_PRUNE_AGE) delete cache[k];
  }
  await browser.storage.local.set({ [LINK_PREVIEW_KEY]: cache });
}

// X.com (Twitter) status URLs need special handling: the standard server-side
// HTML they return contains a near-empty React shell with no OG metadata. We
// instead use X-owned endpoints — the same ones X's own embed widget uses.
const X_STATUS_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/[^\/]+\/status(?:es)?\/(\d+)/i;

function extractXStatusId(url) {
  const m = url.match(X_STATUS_RE);
  return m ? m[1] : null;
}

// Token formula reverse-engineered from X's embed widget. The endpoint accepts
// any token-shaped string in practice, but matching the official formula gives
// us forward-compat if X tightens validation.
function computeSyndicationToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
}

function stripHtml(s) {
  return (s || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim();
}

async function fetchFromSyndication(id) {
  const token = computeSyndicationToken(id);
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&lang=en&token=${token}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_PREVIEW_FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const t = await resp.json();
    if (!t || !t.user) return null;
    const handle = t.user.screen_name ? `@${t.user.screen_name}` : '';
    const title = [t.user.name, handle].filter(Boolean).join(' ');
    const image =
      t.mediaDetails?.[0]?.media_url_https ||
      t.user.profile_image_url_https ||
      null;
    return {
      title: title || null,
      description: t.text || null,
      image,
      domain: 'x.com'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromOEmbed(originalUrl) {
  const url = `https://publish.twitter.com/oembed?url=${encodeURIComponent(originalUrl)}&omit_script=true`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_PREVIEW_FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, credentials: 'omit' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const o = await resp.json();
    // oEmbed returns a <blockquote>...<p>tweet text</p>... <a>date</a></blockquote>.
    // Extract just the <p> body for the description.
    const pMatch = o.html?.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const description = pMatch ? stripHtml(pMatch[1]) : null;
    return {
      title: o.author_name || null,
      description,
      image: null,
      domain: 'x.com'
    };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchXPreview(originalUrl, id) {
  // Primary: syndication endpoint (rich data, but undocumented and breaks
  // occasionally when X tightens it).
  try {
    const r = await fetchFromSyndication(id);
    if (r && (r.title || r.description)) {
      console.log('[AnnotatePro] x preview ok via syndication:', originalUrl);
      return r;
    }
  } catch (err) {
    console.warn('[AnnotatePro] x syndication failed:', err?.message || err);
  }
  // Fallback: official oEmbed (text + author only, no thumbnail).
  try {
    const r = await fetchFromOEmbed(originalUrl);
    if (r && (r.title || r.description)) {
      console.log('[AnnotatePro] x preview ok via oembed:', originalUrl);
      return r;
    }
  } catch (err) {
    console.warn('[AnnotatePro] x oembed failed:', err?.message || err);
  }
  return null;
}

function parseLinkPreviewHtml(html, baseUrl) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const meta = (sel) => doc.querySelector(sel)?.getAttribute('content')?.trim() || null;
  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    doc.querySelector('title')?.textContent?.trim() ||
    null;
  const description =
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    meta('meta[name="description"]') ||
    null;
  let image =
    meta('meta[property="og:image"]') ||
    meta('meta[property="og:image:url"]') ||
    meta('meta[name="twitter:image"]') ||
    meta('meta[name="twitter:image:src"]') ||
    null;
  if (image) {
    try { image = new URL(image, baseUrl).href; } catch { image = null; }
  }
  return {
    title: title ? title.slice(0, 300) : null,
    description: description ? description.slice(0, 600) : null,
    image,
    domain: baseUrl.hostname
  };
}

async function fetchLinkPreview(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const cache = await getLinkPreviewCache();
  const cached = cache[url];
  const now = Date.now();
  if (cached) {
    const ttl = cached.status === 'ok' ? LINK_PREVIEW_OK_TTL : LINK_PREVIEW_FAIL_TTL;
    if (now - (cached.fetchedAt || 0) < ttl) {
      console.log('[AnnotatePro] link preview cache hit:', url, cached.status);
      return cached;
    }
  }

  // x.com / twitter.com short-circuit: a generic fetch returns an empty React
  // shell, so we use X's own embed-backing endpoints instead.
  const xId = extractXStatusId(url);
  if (xId) {
    console.log('[AnnotatePro] link preview fetching (x.com path):', url);
    let preview = await fetchXPreview(url, xId);
    if (!preview) {
      preview = { status: 'failed', error: 'all x endpoints failed', domain: 'x.com' };
    } else {
      preview.status = 'ok';
    }
    preview.fetchedAt = now;
    cache[url] = preview;
    await setLinkPreviewCache(cache);
    return preview;
  }

  console.log('[AnnotatePro] link preview fetching:', url);
  let preview;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), LINK_PREVIEW_FETCH_TIMEOUT);
  try {
    const resp = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      credentials: 'omit',
      headers: { 'Accept': 'text/html,application/xhtml+xml' }
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const contentType = resp.headers.get('content-type') || '';
    if (!contentType.includes('html')) throw new Error(`not html (${contentType})`);

    // Read only the first ~256KB — meta tags are in <head>, no need for the rest.
    const reader = resp.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: false });
    let html = '';
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      html += decoder.decode(value, { stream: true });
      if (total >= LINK_PREVIEW_BODY_LIMIT) {
        try { await reader.cancel(); } catch (e) {}
        break;
      }
    }
    preview = parseLinkPreviewHtml(html, parsed);
    preview.status = 'ok';
    console.log('[AnnotatePro] link preview ok:', url, {
      title: preview.title,
      hasDesc: !!preview.description,
      hasImage: !!preview.image
    });
  } catch (err) {
    preview = { status: 'failed', error: String(err?.message || err), domain: parsed.hostname };
    console.warn('[AnnotatePro] link preview failed:', url, preview.error);
  } finally {
    clearTimeout(timer);
  }
  preview.fetchedAt = now;
  cache[url] = preview;
  await setLinkPreviewCache(cache);
  return preview;
}

// Per-tab find state. Keyed by tabId. Each entry: { query, count, index }
// index === -1 means "all matches highlighted" (not navigated yet).
const findState = new Map();

function getFindState(tabId) {
  return findState.get(tabId) || { query: '', count: 0, index: -1 };
}

async function updateFindBadge(tabId) {
  const s = getFindState(tabId);
  try {
    if (!s.query || s.count === 0) {
      const text = s.query ? '0' : '';
      await browser.action.setBadgeText({ text, tabId });
      if (s.query) {
        await browser.action.setBadgeBackgroundColor({ color: '#dc2626', tabId });
      }
      return;
    }
    const text = s.index >= 0 ? `${s.index + 1}/${s.count}` : `${s.count}`;
    await browser.action.setBadgeText({ text, tabId });
    await browser.action.setBadgeBackgroundColor({ color: '#16a34a', tabId });
  } catch (e) {
    // Tab may have closed — ignore.
  }
}

async function runFind(tabId, query) {
  query = (query || '').trim();
  if (!query) {
    return clearFind(tabId);
  }
  try {
    const result = await browser.find.find(query, { tabId, caseSensitive: false });
    const count = result?.count || 0;
    findState.set(tabId, { query, count, index: -1 });
    if (count > 0) {
      await browser.find.highlightResults({ tabId, noScroll: false });
    } else {
      await browser.find.removeHighlighting();
    }
    await updateFindBadge(tabId);
    return { query, count, index: -1 };
  } catch (e) {
    console.error('AnnotatePro: browser.find.find failed', e);
    return { query, count: 0, index: -1, error: e?.message };
  }
}

async function navigateFind(tabId, direction) {
  const s = getFindState(tabId);
  if (!s.query || s.count === 0) return s;
  // Re-run find before navigating in case the page state changed since last call.
  // browser.find stores results globally per-tab; subsequent highlightResults calls
  // use whatever was last found in that tab.
  try {
    const result = await browser.find.find(s.query, { tabId, caseSensitive: false });
    const count = result?.count || 0;
    if (count === 0) {
      findState.set(tabId, { query: s.query, count: 0, index: -1 });
      await browser.find.removeHighlighting();
      await updateFindBadge(tabId);
      return { query: s.query, count: 0, index: -1 };
    }
    let nextIndex;
    if (s.index < 0) {
      nextIndex = direction === 'prev' ? count - 1 : 0;
    } else {
      nextIndex = direction === 'prev'
        ? (s.index - 1 + count) % count
        : (s.index + 1) % count;
    }
    findState.set(tabId, { query: s.query, count, index: nextIndex });
    // browser.find.highlightResults with rangeIndex paints ONLY that one
    // range, so two calls are needed: first to scroll to the target match,
    // then a no-arg call to re-paint every match. The second call uses
    // noScroll so the scroll position from the first call is preserved.
    await browser.find.highlightResults({ tabId, rangeIndex: nextIndex, noScroll: false });
    await browser.find.highlightResults({ tabId, noScroll: true });
    await updateFindBadge(tabId);
    return { query: s.query, count, index: nextIndex };
  } catch (e) {
    console.error('AnnotatePro: navigateFind failed', e);
    return s;
  }
}

async function clearFind(tabId) {
  findState.delete(tabId);
  try {
    await browser.find.removeHighlighting();
  } catch (e) {
    // Ignore — nothing was highlighted.
  }
  await updateFindBadge(tabId);
  return { query: '', count: 0, index: -1 };
}

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
              note: item.note || '',
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

    case MessageType.PAGE_FIND_QUERY:
      return (async () => {
        const tabId = payload?.tabId ?? sender?.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { query: '', count: 0, index: -1 };
        return runFind(tabId, payload?.query || '');
      })();

    case MessageType.PAGE_FIND_NEXT:
      return (async () => {
        const tabId = payload?.tabId ?? sender?.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { query: '', count: 0, index: -1 };
        return navigateFind(tabId, 'next');
      })();

    case MessageType.PAGE_FIND_PREV:
      return (async () => {
        const tabId = payload?.tabId ?? sender?.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { query: '', count: 0, index: -1 };
        return navigateFind(tabId, 'prev');
      })();

    case MessageType.PAGE_FIND_CLEAR:
      return (async () => {
        const tabId = payload?.tabId ?? sender?.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { query: '', count: 0, index: -1 };
        return clearFind(tabId);
      })();

    case MessageType.PAGE_FIND_GET_STATE:
      return (async () => {
        const tabId = payload?.tabId ?? sender?.tab?.id ?? (await browser.tabs.query({ active: true, currentWindow: true }))[0]?.id;
        if (!tabId) return { query: '', count: 0, index: -1 };
        return getFindState(tabId);
      })();

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

    case MessageType.FETCH_LINK_PREVIEW:
      return fetchLinkPreview(payload?.url);

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
    case 'capture-visible':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_CAPTURE_VISIBLE' });
      break;
    case 'capture-visible-timer':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_CAPTURE_VISIBLE_TIMER' });
      break;
    case 'capture-fullpage':
      browser.tabs.sendMessage(tabId, { type: 'COMMAND_CAPTURE_FULL_PAGE' });
      break;
  }
});

/**
 * Rebind the manifest `commands` (highlight / checkbox / sidebar / screenshot)
 * to the user's custom shortcuts, saved from the dashboard under
 * settings.shortcuts. An empty/missing binding resets that command to its
 * manifest default. Runs on startup and whenever settings change.
 */
const COMMAND_ACTIONS = {
  highlight: 'toggle-highlight',
  checkbox: 'toggle-checkbox',
  toggleSidebar: 'toggle-sidebar',
  captureArea: 'capture-screenshot',
  captureVisible: 'capture-visible',
  captureVisibleTimer: 'capture-visible-timer',
  captureFullPage: 'capture-fullpage'
};

async function applyCommandShortcuts() {
  if (!browser.commands || !browser.commands.update) return;
  let shortcuts = {};
  try {
    const out = await browser.storage.local.get('settings');
    shortcuts = (out.settings && out.settings.shortcuts) || {};
  } catch (e) {
    return;
  }
  for (const [action, name] of Object.entries(COMMAND_ACTIONS)) {
    const shortcut = shortcuts[action];
    try {
      if (shortcut) {
        await browser.commands.update({ name, shortcut });
      } else if (browser.commands.reset) {
        await browser.commands.reset(name);
      }
    } catch (err) {
      console.warn('[AnnotatePro] Could not apply shortcut', name, shortcut, err);
    }
  }
}

if (browser.storage?.onChanged) {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
      applyCommandShortcuts();
    }
  });
}

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

  // Find feature group — divider, find items, divider.
  // Visibility of items within is managed dynamically by the onShown listener
  // so the group only appears when relevant (text selected, or find active).
  browser.contextMenus.create({
    id: 'annotatepro-find-pre-separator',
    parentId: 'annotatepro-parent',
    type: 'separator',
    contexts: ['all'],
    visible: false
  });

  browser.contextMenus.create({
    id: 'annotatepro-find-selection',
    parentId: 'annotatepro-parent',
    title: 'Find Selection on Page',
    contexts: ['selection']
  });

  browser.contextMenus.create({
    id: 'annotatepro-find-clear',
    parentId: 'annotatepro-parent',
    title: 'Find: Clear Highlights',
    contexts: ['all'],
    visible: false
  });

  browser.contextMenus.create({
    id: 'annotatepro-find-post-separator',
    parentId: 'annotatepro-parent',
    type: 'separator',
    contexts: ['all'],
    visible: false
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

  // Generate QR Code
  browser.contextMenus.create({
    id: 'annotatepro-generate-qr',
    parentId: 'annotatepro-parent',
    title: 'Generate QR Code',
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
    id: 'annotatepro-capture-visible-timer',
    parentId: 'annotatepro-screenshot-parent',
    title: 'Visible Area (5s Timer)',
    contexts: ['all']
  });

  browser.contextMenus.create({
    id: 'annotatepro-capture-fullpage',
    parentId: 'annotatepro-screenshot-parent',
    title: 'Whole Page',
    contexts: ['all']
  });
}

// Show/hide the find-feature items as a single group right before the menu
// opens. Keeps everything visually grouped without redundant separators.
browser.contextMenus.onShown?.addListener((info, tab) => {
  const hasSelection = info.contexts.includes('selection');
  const findActive = tab?.id != null && findState.has(tab.id);
  const groupVisible = hasSelection || findActive;

  browser.contextMenus.update('annotatepro-find-pre-separator', { visible: groupVisible });
  browser.contextMenus.update('annotatepro-find-post-separator', { visible: groupVisible });
  browser.contextMenus.update('annotatepro-find-clear', { visible: findActive });

  browser.contextMenus.refresh();
});

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
  } else if (menuId === 'annotatepro-generate-qr') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_GENERATE_QR' });
  } else if (menuId === 'annotatepro-capture-area') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_AREA' });
  } else if (menuId === 'annotatepro-capture-visible') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_VISIBLE' });
  } else if (menuId === 'annotatepro-capture-visible-timer') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_VISIBLE_TIMER' });
  } else if (menuId === 'annotatepro-capture-fullpage') {
    browser.tabs.sendMessage(tab.id, { type: 'COMMAND_CAPTURE_FULL_PAGE' });
  } else if (menuId === 'annotatepro-find-selection') {
    const query = (info.selectionText || '').trim();
    if (query) await runFind(tab.id, query);
  } else if (menuId === 'annotatepro-find-clear') {
    await clearFind(tab.id);
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
    // Restore any custom keyboard shortcuts for the manifest commands.
    applyCommandShortcuts();
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

// Drop find state when a tab closes — prevents stale entries piling up.
browser.tabs.onRemoved.addListener((tabId) => {
  findState.delete(tabId);
});

// Clear find state when a tab navigates — browser.find results are scoped to
// the prior document and become meaningless once the page changes.
browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status === 'loading' && findState.has(tabId)) {
    clearFind(tabId);
  }
});
