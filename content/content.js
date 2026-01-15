/**
 * Main Content Script for AnnotatePro
 * Bundled version - no ES module imports
 */

(function() {
  'use strict';

  // ============ Fingerprint Module ============

  function normalizeText(text) {
    if (!text) return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  /**
   * Normalize text for matching - handles curly quotes, special chars
   * Does NOT change case or length significantly to preserve position mapping
   */
  function normalizeQuotes(text) {
    if (!text) return '';
    return text
      .replace(/[\u2018\u2019\u201A\u201B\u0060\u00B4]/g, "'")  // Smart/accent single quotes to straight
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')  // Smart/guillemet double quotes to straight
      .replace(/[\u2013\u2014]/g, '-')  // En/em dashes to hyphen
      .replace(/\u00A0/g, ' ');  // Non-breaking space to regular space
  }

  /**
   * Find text in a node, handling quote variations and case
   * Returns {start, length} or null if not found
   */
  function findTextMatch(nodeText, targetText) {
    if (!nodeText || !targetText) return null;

    // 1. Try exact match
    let idx = nodeText.indexOf(targetText);
    if (idx !== -1) return { start: idx, length: targetText.length };

    // 2. Try with quotes normalized
    const normalizedNode = normalizeQuotes(nodeText);
    const normalizedTarget = normalizeQuotes(targetText);
    idx = normalizedNode.indexOf(normalizedTarget);
    if (idx !== -1) return { start: idx, length: normalizedTarget.length };

    // 3. Try case-insensitive
    idx = nodeText.toLowerCase().indexOf(targetText.toLowerCase());
    if (idx !== -1) return { start: idx, length: targetText.length };

    // 4. Try case-insensitive with quotes normalized
    idx = normalizedNode.toLowerCase().indexOf(normalizedTarget.toLowerCase());
    if (idx !== -1) return { start: idx, length: normalizedTarget.length };

    return null;
  }

  function hashText(text) {
    if (!text) return '0';
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = Math.imul(31, h) + text.charCodeAt(i) | 0;
    }
    return Math.abs(h).toString(16);
  }

  function getSelector(element) {
    if (element.id) {
      return `#${CSS.escape(element.id)}`;
    }

    const parts = [];
    let current = element;

    while (current && current !== document.body) {
      let selector = current.tagName.toLowerCase();

      if (current.id) {
        selector = `#${CSS.escape(current.id)}`;
        parts.unshift(selector);
        break;
      }

      if (current.className && typeof current.className === 'string') {
        const classes = current.className.trim().split(/\s+/).filter(c => c);
        if (classes.length > 0) {
          selector += '.' + classes.map(c => CSS.escape(c)).join('.');
        }
      }

      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          el => el.tagName === current.tagName
        );
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          selector += `:nth-of-type(${index})`;
        }
      }

      parts.unshift(selector);
      current = current.parentElement;
    }

    return parts.join(' > ');
  }

  function getContext(element, length = 50) {
    const parent = element.parentElement;
    if (!parent) return { before: '', after: '' };

    const siblings = Array.from(parent.childNodes);
    const index = siblings.indexOf(element);

    let beforeText = '';
    let afterText = '';

    for (let i = index - 1; i >= 0 && beforeText.length < length; i--) {
      const text = siblings[i].textContent || '';
      beforeText = text + beforeText;
    }

    for (let i = index + 1; i < siblings.length && afterText.length < length; i++) {
      const text = siblings[i].textContent || '';
      afterText += text;
    }

    return {
      before: normalizeText(beforeText).slice(-length),
      after: normalizeText(afterText).slice(0, length)
    };
  }

  function createFingerprint(element) {
    const text = normalizeText(element.textContent || '');
    const textHash = hashText(text);
    const context = getContext(element);
    const selector = getSelector(element);
    const rect = element.getBoundingClientRect();

    return {
      elementFingerprint: `${element.tagName.toLowerCase()}_${textHash}_${hashText(selector)}`,
      selector,
      tagName: element.tagName.toLowerCase(),
      className: element.className || '',
      textSnapshot: text.slice(0, 200),
      textHash,
      contextBefore: context.before,
      contextAfter: context.after,
      boundingBox: {
        top: Math.round(rect.top + window.scrollY),
        left: Math.round(rect.left + window.scrollX),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    };
  }

  function createSelectionFingerprint(selection) {
    if (!selection || selection.isCollapsed) return null;

    const range = selection.getRangeAt(0);
    const container = range.commonAncestorContainer;
    const element = container.nodeType === Node.TEXT_NODE
      ? container.parentElement
      : container;

    const selectedText = normalizeText(selection.toString());
    const textHash = hashText(selectedText);
    const context = getContext(element);
    const selector = getSelector(element);

    const elementText = normalizeText(element.textContent || '');
    const startOffset = elementText.indexOf(selectedText);

    return {
      elementFingerprint: `highlight_${textHash}_${hashText(selector)}`,
      selector,
      tagName: element.tagName.toLowerCase(),
      className: element.className || '',
      textSnapshot: selectedText,
      textHash,
      contextBefore: context.before,
      contextAfter: context.after,
      selectionStartOffset: startOffset,
      selectionLength: selectedText.length
    };
  }

  // ============ Reattach Module ============

  const MIN_SCORE = 0.3;

  function scoreCandidate(element, record) {
    let score = 0;
    let maxScore = 0;

    maxScore += 1;
    if (element.tagName.toLowerCase() === record.tagName) {
      score += 1;
    } else {
      return 0;
    }

    maxScore += 4;
    const elementText = normalizeText(element.textContent || '');
    const recordText = record.textSnapshot || '';

    if (elementText === recordText) {
      score += 4;
    } else if (elementText.includes(recordText)) {
      score += 3;
    } else if (recordText && elementText.includes(recordText.slice(0, 50))) {
      score += 2;
    } else {
      const elementHash = hashText(elementText);
      if (elementHash === record.textHash) {
        score += 3;
      }
    }

    maxScore += 2;
    if (record.className && element.className === record.className) {
      score += 2;
    } else if (record.className && element.className?.includes(record.className.split(' ')[0])) {
      score += 1;
    }

    maxScore += 2;
    if (record.contextBefore || record.contextAfter) {
      const parent = element.parentElement;
      if (parent) {
        const parentText = normalizeText(parent.textContent || '');
        if (record.contextBefore && parentText.includes(record.contextBefore)) {
          score += 1;
        }
        if (record.contextAfter && parentText.includes(record.contextAfter)) {
          score += 1;
        }
      }
    }

    maxScore += 1;
    if (record.boundingBox) {
      const rect = element.getBoundingClientRect();
      const currentTop = rect.top + window.scrollY;
      const deltaY = Math.abs(currentTop - record.boundingBox.top);
      if (deltaY < 50) {
        score += 1;
      } else if (deltaY < 200) {
        score += 0.5;
      }
    }

    return score / maxScore;
  }

  function reattach(record) {
    // Method 1: Try exact selector first
    try {
      const element = document.querySelector(record.selector);
      if (element) {
        const score = scoreCandidate(element, record);
        if (score >= MIN_SCORE) {
          return { element, score, method: 'selector' };
        }
      }
    } catch (e) {
      // Invalid selector
    }

    // Method 2: Search by tagName
    const candidates = document.querySelectorAll(record.tagName);
    let best = null;
    let bestScore = 0;

    for (const element of candidates) {
      // Skip inline wrappers we created, but allow container elements with annotations
      const isInlineWrapper = element.tagName === 'MARK' || element.classList.contains('annotatepro-checkbox-text');
      if (isInlineWrapper && element.hasAttribute('data-annotatepro-id')) continue;

      const score = scoreCandidate(element, record);
      if (score > bestScore) {
        bestScore = score;
        best = element;
      }
    }

    if (bestScore >= MIN_SCORE) {
      return { element: best, score: bestScore, method: 'scoring' };
    }

    // Method 3: For text-based annotations, search ALL elements containing the text
    if (record.textSnapshot && record.selectionStartOffset !== undefined) {
      const textToFind = record.textSnapshot;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        const nodeText = node.textContent || '';
        // Use robust matching that handles quotes and case
        if (findTextMatch(nodeText, textToFind)) {
          // Found the text - return the parent element
          const parent = node.parentElement;
          if (parent) {
            // Don't skip elements with data-annotatepro-id - multiple annotations can share a container
            // Only skip inline wrappers we created
            const isInlineWrapper = parent.tagName === 'MARK' || parent.classList.contains('annotatepro-checkbox-text');
            if (!isInlineWrapper) {
              console.log('AnnotatePro: Found text match via TreeWalker:', textToFind.slice(0, 30));
              return { element: parent, score: 0.6, method: 'text-search' };
            }
          }
        }
      }
    }

    return null;
  }

  function reattachAll(annotations) {
    const results = {
      attached: [],
      orphaned: []
    };

    for (const record of annotations) {
      const match = reattach(record);
      if (match) {
        results.attached.push({
          annotation: record,
          element: match.element,
          score: match.score,
          method: match.method
        });
      } else {
        results.orphaned.push(record);
      }
    }

    return results;
  }

  // ============ Render Module ============

  const INTENT_COLORS = {
    ACTION: '#ffeb3b',
    QUESTION: '#64b5f6',
    RISK: '#ef5350',
    REFERENCE: '#81c784',
    CUSTOM: '#ce93d8',
    DEFAULT: '#ffeb3b'
  };

  function applyHighlight(element, annotation) {
    const { id, color, intent, textSnapshot, selectionStartOffset, selectionLength } = annotation;

    // Check if annotation already exists in DOM - prevent duplicates
    const existing = document.querySelector(`[data-annotatepro-id="${id}"]`);
    if (existing) {
      return existing;
    }

    if (selectionStartOffset !== undefined && selectionLength) {
      return applyTextHighlight(element, annotation);
    }

    const highlightColor = color || INTENT_COLORS[intent] || INTENT_COLORS.DEFAULT;

    element.setAttribute('data-annotatepro-id', id);
    element.setAttribute('data-annotatepro-type', 'highlight');
    element.classList.add('annotatepro-highlight');
    element.style.setProperty('--annotatepro-color', highlightColor);

    return element;
  }

  function applyTextHighlight(element, annotation) {
    const { id, color, intent, textSnapshot } = annotation;

    // Check if annotation already exists in DOM - prevent duplicates
    const existing = document.querySelector(`[data-annotatepro-id="${id}"]`);
    if (existing) {
      return existing;
    }

    const highlightColor = color || INTENT_COLORS[intent] || INTENT_COLORS.DEFAULT;

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const nodeText = node.textContent || '';

      // Skip text nodes that are inside an INLINE annotation wrapper (mark, span with our class)
      // Don't skip if parent is the container element itself
      const parent = node.parentElement;
      if (parent && parent.hasAttribute('data-annotatepro-id')) {
        const isInlineWrapper = parent.tagName === 'MARK' || parent.classList.contains('annotatepro-checkbox-text');
        if (isInlineWrapper) {
          continue;
        }
      }

      // Use robust text matching
      const match = findTextMatch(nodeText, textSnapshot);
      if (match) {
        const endIndex = Math.min(match.start + match.length, nodeText.length);

        try {
          const wrapper = document.createElement('mark');
          wrapper.setAttribute('data-annotatepro-id', id);
          wrapper.setAttribute('data-annotatepro-type', 'highlight');
          wrapper.classList.add('annotatepro-highlight', 'annotatepro-text-highlight');
          wrapper.style.setProperty('--annotatepro-color', highlightColor);

          const range = document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, endIndex);
          range.surroundContents(wrapper);

          return wrapper;
        } catch (err) {
          console.error('AnnotatePro: Failed to wrap text for highlight:', err);
          continue;
        }
      }
    }

    return applyHighlight(element, { ...annotation, selectionStartOffset: undefined });
  }

  function applyCheckbox(element, annotation) {
    const { id, checked, note, textSnapshot, selectionStartOffset, selectionLength } = annotation;

    console.log('AnnotatePro: applyCheckbox called:', {
      id,
      selectionStartOffset,
      selectionLength,
      hasTextSnapshot: !!textSnapshot,
      isTextCheckbox: selectionStartOffset !== undefined && selectionLength && textSnapshot
    });

    // Check if checkbox already exists
    const existing = document.querySelector(`[data-annotatepro-checkbox-id="${id}"]`);
    if (existing) {
      console.log('AnnotatePro: Checkbox already exists:', id);
      return existing;
    }

    // If it's a text selection checkbox, wrap the text first
    if (selectionStartOffset !== undefined && selectionLength && textSnapshot) {
      console.log('AnnotatePro: Creating text checkbox');
      return applyTextCheckbox(element, annotation);
    }

    console.log('AnnotatePro: Creating element checkbox');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = !!checked;
    checkbox.className = 'annotatepro-checkbox';
    checkbox.setAttribute('data-annotatepro-checkbox-id', id);
    checkbox.title = note || 'AnnotatePro checkbox';

    element.setAttribute('data-annotatepro-id', id);
    element.setAttribute('data-annotatepro-type', 'checkbox');

    // Add padding to element to make room for the checkbox (prevents clipping)
    const computedStyle = window.getComputedStyle(element);
    const currentPadding = parseInt(computedStyle.paddingLeft) || 0;
    element.style.paddingLeft = (currentPadding + 24) + 'px';
    element.style.position = 'relative';

    // Position checkbox inside the padding area (not negative left)
    checkbox.style.cssText = 'position: absolute !important; left: 2px !important; top: 0.15em !important;';

    // Insert checkbox as first child so it's positioned relative to the element
    element.insertAdjacentElement('afterbegin', checkbox);

    return checkbox;
  }

  function applyTextCheckbox(element, annotation) {
    const { id, checked, note, textSnapshot } = annotation;

    // Check if already exists
    const existing = document.querySelector(`[data-annotatepro-checkbox-id="${id}"]`);
    if (existing) {
      return existing;
    }

    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;

    while ((node = walker.nextNode())) {
      const nodeText = node.textContent || '';

      // Skip text nodes that are inside an INLINE annotation wrapper (mark, span with our class)
      // Don't skip if parent is the container element itself
      const parent = node.parentElement;
      if (parent && parent.hasAttribute('data-annotatepro-id')) {
        const isInlineWrapper = parent.tagName === 'MARK' || parent.classList.contains('annotatepro-checkbox-text');
        if (isInlineWrapper) {
          continue;
        }
      }

      // Use robust text matching
      const match = findTextMatch(nodeText, textSnapshot);
      if (match) {
        const endIndex = Math.min(match.start + match.length, nodeText.length);

        try {
          // Create wrapper span for the text
          const wrapper = document.createElement('span');
          wrapper.setAttribute('data-annotatepro-id', id);
          wrapper.setAttribute('data-annotatepro-type', 'checkbox');
          wrapper.classList.add('annotatepro-checkbox-text');

          // Wrap the selected text
          const range = document.createRange();
          range.setStart(node, match.start);
          range.setEnd(node, endIndex);
          range.surroundContents(wrapper);

          // Create and insert checkbox
          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.checked = !!checked;
          checkbox.className = 'annotatepro-checkbox';
          checkbox.setAttribute('data-annotatepro-checkbox-id', id);
          checkbox.title = note || 'AnnotatePro checkbox';

          // Add inline styles to ensure visibility (backup for CSS)
          checkbox.style.cssText = 'position: absolute !important; left: 2px !important; top: 0.15em !important;';

          // Insert checkbox at the beginning of the wrapper
          wrapper.insertBefore(checkbox, wrapper.firstChild);

          // Also set wrapper inline styles as backup
          wrapper.style.cssText = 'position: relative !important; display: inline-block !important; padding-left: 22px !important;';

          console.log('AnnotatePro: Created text checkbox for:', textSnapshot);
          return checkbox;
        } catch (err) {
          console.error('AnnotatePro: Failed to wrap text for checkbox:', err);
          // Continue searching for another match
          continue;
        }
      }
    }

    // Log debug info about why text wasn't found
    console.log('AnnotatePro: Text not found for checkbox:', {
      textSnapshot,
      elementTag: element.tagName,
      elementTextPreview: (element.textContent || '').slice(0, 100),
      textNodesCount: document.createTreeWalker(element, NodeFilter.SHOW_TEXT).nextNode() ? 'has text nodes' : 'no text nodes'
    });
    // Fallback to element checkbox if text not found
    return applyCheckbox(element, { ...annotation, selectionStartOffset: undefined });
  }

  function removeAnnotation(annotationId) {
    const highlights = document.querySelectorAll(`[data-annotatepro-id="${annotationId}"]`);
    for (const el of highlights) {
      // Check element type BEFORE removing classes/attributes
      const isMark = el.tagName === 'MARK';
      const isTextCheckbox = el.classList.contains('annotatepro-checkbox-text');

      el.classList.remove('annotatepro-highlight', 'annotatepro-text-highlight', 'annotatepro-checkbox-text');
      el.style.removeProperty('--annotatepro-color');
      el.removeAttribute('data-annotatepro-id');
      el.removeAttribute('data-annotatepro-type');

      // Unwrap mark elements or text checkbox spans (remove the tag but keep the text)
      if (isMark || isTextCheckbox) {
        // First remove the checkbox input if it's a text checkbox
        if (isTextCheckbox) {
          const checkbox = el.querySelector('.annotatepro-checkbox');
          if (checkbox) checkbox.remove();
        }

        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          parent.removeChild(el);
          // Normalize to merge adjacent text nodes
          parent.normalize();
        }
      }
    }

    const checkboxes = document.querySelectorAll(`[data-annotatepro-checkbox-id="${annotationId}"]`);
    for (const cb of checkboxes) {
      cb.remove();
    }
  }

  function applyAnnotation(element, annotation) {
    switch (annotation.annotationType) {
      case 'highlight':
        return applyHighlight(element, annotation);
      case 'checkbox':
        return applyCheckbox(element, annotation);
      default:
        console.warn('Unknown annotation type:', annotation.annotationType);
        return null;
    }
  }

  // ============ Main Content Script ============

  const MessageType = {
    ADD_ANNOTATION: 'ADD_ANNOTATION',
    UPDATE_ANNOTATION: 'UPDATE_ANNOTATION',
    DELETE_ANNOTATION: 'DELETE_ANNOTATION',
    GET_PAGE_ANNOTATIONS: 'GET_PAGE_ANNOTATIONS'
  };

  const attachedAnnotations = new Set();

  async function sendMessage(type, payload) {
    return browser.runtime.sendMessage({ type, payload });
  }

  function getPageUrl() {
    return window.location.href.split('#')[0];
  }

  async function loadAnnotations() {
    try {
      const pageUrl = getPageUrl();
      const annotations = await sendMessage(MessageType.GET_PAGE_ANNOTATIONS, { pageUrl });

      console.log('AnnotatePro: Loading annotations:', annotations?.length || 0);

      if (!annotations || annotations.length === 0) {
        return;
      }

      const results = reattachAll(annotations);

      console.log('AnnotatePro: Reattachment results:', {
        attached: results.attached.length,
        orphaned: results.orphaned.length
      });

      for (const { annotation, element, score } of results.attached) {
        // Check if already attached AND still exists in DOM
        if (attachedAnnotations.has(annotation.id)) {
          const existingElement = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
          const existingCheckbox = document.querySelector(`[data-annotatepro-checkbox-id="${annotation.id}"]`);
          if (existingElement || existingCheckbox) {
            continue; // Already exists in DOM, skip
          }
          // Element was removed by page - clear stale entry
          console.log('AnnotatePro: DOM element removed, re-applying:', annotation.id);
          attachedAnnotations.delete(annotation.id);
        }

        console.log('AnnotatePro: Applying annotation:', {
          id: annotation.id,
          type: annotation.annotationType,
          hasSelectionOffset: annotation.selectionStartOffset !== undefined,
          textSnapshot: annotation.textSnapshot?.slice(0, 30),
          score
        });

        applyAnnotation(element, annotation);
        attachedAnnotations.add(annotation.id);
        setupAnnotationListeners(element, annotation);
      }

      if (results.orphaned.length > 0) {
        console.log('AnnotatePro: Orphaned annotations:', results.orphaned.map(a => ({
          id: a.id,
          type: a.annotationType,
          textSnapshot: a.textSnapshot?.slice(0, 30)
        })));
      }
    } catch (error) {
      console.error('AnnotatePro: Failed to load annotations', error);
    }
  }

  async function createHighlight(intent = 'DEFAULT') {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const fingerprint = createSelectionFingerprint(selection);
    if (!fingerprint) return null;

    const annotation = {
      ...fingerprint,
      pageUrl: getPageUrl(),
      annotationType: 'highlight',
      intent,
      color: null,
      note: ''
    };

    try {
      const saved = await sendMessage(MessageType.ADD_ANNOTATION, annotation);

      const range = selection.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const element = container.nodeType === Node.TEXT_NODE
        ? container.parentElement
        : container;

      applyAnnotation(element, saved);
      attachedAnnotations.add(saved.id);
      setupAnnotationListeners(element, saved);

      selection.removeAllRanges();

      return saved;
    } catch (error) {
      console.error('AnnotatePro: Failed to create highlight', error);
      return null;
    }
  }

  async function createCheckbox(element) {
    // Check for text selection first (like highlights)
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      return createTextCheckbox();
    }

    const fingerprint = createFingerprint(element);

    const annotation = {
      ...fingerprint,
      pageUrl: getPageUrl(),
      annotationType: 'checkbox',
      checked: false,
      note: ''
    };

    try {
      const saved = await sendMessage(MessageType.ADD_ANNOTATION, annotation);

      applyAnnotation(element, saved);
      attachedAnnotations.add(saved.id);
      setupAnnotationListeners(element, saved);

      return saved;
    } catch (error) {
      console.error('AnnotatePro: Failed to create checkbox', error);
      return null;
    }
  }

  async function createTextCheckbox() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const fingerprint = createSelectionFingerprint(selection);
    if (!fingerprint) return null;

    const annotation = {
      ...fingerprint,
      pageUrl: getPageUrl(),
      annotationType: 'checkbox',
      checked: false,
      note: ''
    };

    try {
      const saved = await sendMessage(MessageType.ADD_ANNOTATION, annotation);

      // Directly wrap the selection using Range API (more reliable than searching)
      const range = selection.getRangeAt(0);

      try {
        // Create wrapper span
        const wrapper = document.createElement('span');
        wrapper.setAttribute('data-annotatepro-id', saved.id);
        wrapper.setAttribute('data-annotatepro-type', 'checkbox');
        wrapper.classList.add('annotatepro-checkbox-text');
        wrapper.style.cssText = 'position: relative !important; display: inline-block !important; padding-left: 22px !important;';

        // Wrap the selected range directly
        range.surroundContents(wrapper);

        // Create checkbox
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = false;
        checkbox.className = 'annotatepro-checkbox';
        checkbox.setAttribute('data-annotatepro-checkbox-id', saved.id);
        checkbox.title = 'AnnotatePro checkbox';
        checkbox.style.cssText = 'position: absolute !important; left: 2px !important; top: 0.15em !important;';

        wrapper.insertBefore(checkbox, wrapper.firstChild);

        attachedAnnotations.add(saved.id);

        // Get element for listeners
        const container = wrapper.parentElement || wrapper;
        setupAnnotationListeners(container, saved);

        console.log('AnnotatePro: Created text checkbox directly from selection');
      } catch (wrapError) {
        // surroundContents can fail if selection spans multiple elements
        console.warn('AnnotatePro: Direct wrap failed, falling back to search:', wrapError.message);

        const container = range.commonAncestorContainer;
        const element = container.nodeType === Node.TEXT_NODE
          ? container.parentElement
          : container;

        applyAnnotation(element, saved);
        attachedAnnotations.add(saved.id);
        setupAnnotationListeners(element, saved);
      }

      selection.removeAllRanges();

      return saved;
    } catch (error) {
      console.error('AnnotatePro: Failed to create text checkbox', error);
      return null;
    }
  }

  async function deleteAnnotation(annotationId) {
    try {
      await sendMessage(MessageType.DELETE_ANNOTATION, { id: annotationId });
      removeAnnotation(annotationId);
      attachedAnnotations.delete(annotationId);
    } catch (error) {
      console.error('AnnotatePro: Failed to delete annotation', error);
    }
  }

  function setupAnnotationListeners(element, annotation) {
    if (annotation.annotationType === 'checkbox') {
      const checkbox = document.querySelector(
        `[data-annotatepro-checkbox-id="${annotation.id}"]`
      );
      if (checkbox) {
        checkbox.addEventListener('change', async (e) => {
          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch: { checked: e.target.checked }
          });
        });
      }
    }

    element.addEventListener('contextmenu', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        deleteAnnotation(annotation.id);
      }
    });
  }

  function setupKeyboardShortcuts() {
    document.addEventListener('keydown', async (e) => {
      if (e.altKey && e.key.toLowerCase() === 'h') {
        e.preventDefault();
        await createHighlight();
      }

      if (e.altKey && e.key.toLowerCase() === 'c') {
        e.preventDefault();
        // Check for selection first - createCheckbox will handle it
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) {
          await createTextCheckbox();
        } else {
          const element = document.activeElement !== document.body
            ? document.activeElement
            : document.querySelector(':hover');
          if (element) {
            await createCheckbox(element);
          }
        }
      }

      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const intents = ['ACTION', 'QUESTION', 'RISK', 'REFERENCE', 'CUSTOM'];
        const num = parseInt(e.key);
        if (num >= 1 && num <= 5) {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            e.preventDefault();
            await createHighlight(intents[num - 1]);
          }
        }
      }
    });
  }

  // Track last right-clicked element for context menu actions
  let lastContextMenuTarget = null;

  document.addEventListener('contextmenu', (e) => {
    lastContextMenuTarget = e.target;
  });

  /**
   * Find annotation ID from element or its parents
   */
  function findAnnotationId(element) {
    let current = element;
    while (current && current !== document.body) {
      // Check for highlight annotation
      if (current.hasAttribute('data-annotatepro-id')) {
        return current.getAttribute('data-annotatepro-id');
      }
      // Check for checkbox annotation
      if (current.hasAttribute('data-annotatepro-checkbox-id')) {
        return current.getAttribute('data-annotatepro-checkbox-id');
      }
      current = current.parentElement;
    }
    return null;
  }

  /**
   * Clear all annotations from DOM
   */
  function clearAllAnnotationsFromDOM() {
    // Remove all annotations - get them as array since we'll modify DOM
    const annotations = Array.from(document.querySelectorAll('[data-annotatepro-id]'));
    for (const el of annotations) {
      const isMark = el.tagName === 'MARK';
      const isTextCheckbox = el.classList.contains('annotatepro-checkbox-text');

      el.classList.remove('annotatepro-highlight', 'annotatepro-text-highlight', 'annotatepro-checkbox-text');
      el.style.removeProperty('--annotatepro-color');
      el.removeAttribute('data-annotatepro-id');
      el.removeAttribute('data-annotatepro-type');

      if (isMark || isTextCheckbox) {
        // First remove the checkbox input if it's a text checkbox
        if (isTextCheckbox) {
          const checkbox = el.querySelector('.annotatepro-checkbox');
          if (checkbox) checkbox.remove();
        }

        const parent = el.parentNode;
        if (parent) {
          while (el.firstChild) {
            parent.insertBefore(el.firstChild, el);
          }
          parent.removeChild(el);
          parent.normalize();
        }
      }
    }

    // Remove any remaining standalone checkboxes
    const checkboxes = document.querySelectorAll('[data-annotatepro-checkbox-id]');
    for (const cb of checkboxes) {
      cb.remove();
    }

    attachedAnnotations.clear();
  }

  browser.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'COMMAND_HIGHLIGHT':
        createHighlight(message.intent || 'DEFAULT');
        break;

      case 'COMMAND_CHECKBOX':
        // Check for selection first (like highlights)
        const checkboxSelection = window.getSelection();
        if (checkboxSelection && !checkboxSelection.isCollapsed) {
          createTextCheckbox();
        } else {
          const targetElement = lastContextMenuTarget ||
            (document.activeElement !== document.body ? document.activeElement : null);
          if (targetElement) {
            createCheckbox(targetElement);
          }
        }
        break;

      case 'COMMAND_REMOVE':
        if (lastContextMenuTarget) {
          const annotationId = findAnnotationId(lastContextMenuTarget);
          if (annotationId) {
            deleteAnnotation(annotationId);
          }
        }
        break;

      case 'COMMAND_RELOAD_ANNOTATIONS':
        clearAllAnnotationsFromDOM();
        loadAnnotations();
        break;

      case 'COMMAND_DELETE_BY_ID':
        if (message.annotationId) {
          deleteAnnotation(message.annotationId);
        }
        break;

      case 'COMMAND_CHECK_SELECTION':
        const sel = window.getSelection();
        return Promise.resolve(sel && !sel.isCollapsed && sel.toString().trim().length > 0);
    }
  });

  function setupMutationObserver() {
    let pending = false;

    const observer = new MutationObserver(() => {
      if (pending) return;
      pending = true;

      if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(() => {
          pending = false;
          loadAnnotations();
        }, { timeout: 1000 });
      } else {
        setTimeout(() => {
          pending = false;
          loadAnnotations();
        }, 300);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    const originalPushState = history.pushState;
    history.pushState = function(...args) {
      originalPushState.apply(history, args);
      attachedAnnotations.clear();
      setTimeout(loadAnnotations, 100);
    };

    window.addEventListener('popstate', () => {
      attachedAnnotations.clear();
      setTimeout(loadAnnotations, 100);
    });
  }

  async function init() {
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    setupKeyboardShortcuts();
    setupMutationObserver();
    await loadAnnotations();

    console.log('AnnotatePro: Content script initialized');
  }

  init();
})();
