/**
 * Main Content Script for AnnotatePro
 * Bundled version - no ES module imports
 */

(function() {
  'use strict';

  // Prevent multiple initializations
  if (window.__annotateProInitialized) {
    return;
  }
  window.__annotateProInitialized = true;

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
    ACTION: 'rgba(255, 235, 59, 0.5)',
    QUESTION: 'rgba(100, 181, 246, 0.5)',
    RISK: 'rgba(239, 83, 80, 0.5)',
    REFERENCE: 'rgba(129, 199, 132, 0.5)',
    CUSTOM: 'rgba(206, 147, 216, 0.5)',
    DEFAULT: 'rgba(255, 235, 59, 0.5)'
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

    // Check if checkbox already exists
    const existing = document.querySelector(`[data-annotatepro-checkbox-id="${id}"]`);
    if (existing) {
      return existing;
    }

    // If it's a text selection checkbox, wrap the text first
    if (selectionStartOffset !== undefined && selectionLength && textSnapshot) {
      return applyTextCheckbox(element, annotation);
    }

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
    const { id, checked, note, textSnapshot, color, intent } = annotation;
    const hasTransparentColor = color === 'transparent';
    const checkboxColor = hasTransparentColor ? 'transparent' : (color || INTENT_COLORS[intent] || INTENT_COLORS.DEFAULT);

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
          wrapper.style.setProperty('--annotatepro-color', checkboxColor);

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

          // Also set wrapper inline styles as backup (include background color if not transparent)
          if (hasTransparentColor) {
            wrapper.style.cssText = 'position: relative !important; display: inline-block !important; padding-left: 22px !important;';
          } else {
            wrapper.style.cssText = `position: relative !important; display: inline-block !important; padding-left: 22px !important; background-color: var(--annotatepro-color, ${checkboxColor}) !important; border-radius: 2px;`;
          }
          return checkbox;
        } catch (err) {
          console.error('AnnotatePro: Failed to wrap text for checkbox:', err);
          // Continue searching for another match
          continue;
        }
      }
    }

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

  // ============ Note Editor Module ============

  let activeNoteEditor = null;
  let saveDebounceTimer = null;
  let activeTooltip = null;

  /**
   * Show clear confirmation dialog
   */
  function showClearConfirmDialog() {
    // Remove any existing dialog
    const existing = document.querySelector('.annotatepro-confirm-dialog');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.className = 'annotatepro-confirm-overlay';

    overlay.innerHTML = `
      <div class="annotatepro-confirm-dialog">
        <div class="annotatepro-confirm-header">
          <span class="annotatepro-confirm-icon">⚠️</span>
          <h3>Clear All Annotations</h3>
        </div>
        <div class="annotatepro-confirm-body">
          <p><strong>You are about to delete all annotations on this page.</strong></p>
          <p>This action cannot be undone. All highlights, checkboxes, and notes on this page will be permanently lost.</p>
          <p class="annotatepro-confirm-tip">You can export your data first from the Dashboard to create a backup.</p>
        </div>
        <div class="annotatepro-confirm-actions">
          <button class="annotatepro-confirm-btn cancel">Cancel</button>
          <button class="annotatepro-confirm-btn export">Open Dashboard</button>
          <button class="annotatepro-confirm-btn delete">Delete All</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    // Button handlers
    overlay.querySelector('.cancel').addEventListener('click', () => {
      overlay.remove();
    });

    overlay.querySelector('.export').addEventListener('click', () => {
      browser.runtime.sendMessage({ type: 'OPEN_DASHBOARD' });
      overlay.remove();
    });

    overlay.querySelector('.delete').addEventListener('click', async () => {
      overlay.remove();
      // Send message to background to clear and reload
      const pageUrl = window.location.href.split('#')[0];
      await browser.runtime.sendMessage({
        type: 'CLEAR_PAGE_ANNOTATIONS',
        payload: { pageUrl }
      });
      clearAllAnnotationsFromDOM();
    });

    // Click outside to cancel
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        overlay.remove();
      }
    });

    // Escape to cancel
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  /**
   * Update note badge on annotation element (plain purple circle, no icon)
   */
  function updateNoteBadge(annotationId, hasNote) {
    const annotatedEl = document.querySelector(`[data-annotatepro-id="${annotationId}"]`);
    if (!annotatedEl) return;

    // Find or create badge
    let badge = annotatedEl.querySelector('.annotatepro-note-badge');

    if (hasNote) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'annotatepro-note-badge';
        // No text content - just the purple circle
        annotatedEl.appendChild(badge);

        // Add hover listeners for tooltip
        badge.addEventListener('mouseenter', (e) => {
          const annotation = annotationDataMap.get(annotationId);
          if (annotation?.note) {
            showNoteTooltip(annotation.note, e.target);
          }
        });
        badge.addEventListener('mouseleave', () => {
          hideNoteTooltip();
        });
      }
      annotatedEl.setAttribute('data-has-note', 'true');
    } else {
      if (badge) {
        badge.remove();
      }
      annotatedEl.removeAttribute('data-has-note');
    }
  }

  /**
   * Show note tooltip near the badge
   */
  function showNoteTooltip(noteText, anchorEl) {
    hideNoteTooltip();

    const tooltip = document.createElement('div');
    tooltip.className = 'annotatepro-note-tooltip';

    // Truncate for display, then render formatted
    const displayText = noteText.length > 150 ? noteText.slice(0, 150) + '...' : noteText;
    tooltip.innerHTML = renderFormattedNote(displayText);

    document.body.appendChild(tooltip);

    // Position near anchor
    const rect = anchorEl.getBoundingClientRect();
    tooltip.style.top = `${rect.bottom + 6}px`;
    tooltip.style.left = `${rect.left}px`;

    // Make visible after positioning
    requestAnimationFrame(() => {
      tooltip.classList.add('visible');
    });

    activeTooltip = tooltip;
  }

  /**
   * Hide note tooltip
   */
  function hideNoteTooltip() {
    if (activeTooltip) {
      activeTooltip.remove();
      activeTooltip = null;
    }
  }

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
   * Render note text with formatted bullets and checkboxes
   */
  function renderFormattedNote(text, annotationId = null) {
    if (!text) return '';

    const lines = text.split('\n');
    let html = '';
    let inList = false;

    for (const line of lines) {
      const bulletMatch = line.match(/^- (.*)$/);
      const uncheckedMatch = line.match(/^\[\] (.*)$/);
      const checkedMatch = line.match(/^\[x\] (.*)$/i);

      if (bulletMatch) {
        if (!inList) {
          html += '<ul class="annotatepro-note-list">';
          inList = true;
        }
        html += `<li>${escapeHtml(bulletMatch[1])}</li>`;
      } else if (uncheckedMatch || checkedMatch) {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        const checked = !!checkedMatch;
        const content = checked ? checkedMatch[1] : uncheckedMatch[1];
        const dataAttr = annotationId ? `data-annotation-id="${annotationId}"` : '';
        html += `<div class="annotatepro-note-checkbox-item" ${dataAttr}>
          <input type="checkbox" class="annotatepro-note-cb" ${checked ? 'checked' : ''}>
          <span>${escapeHtml(content)}</span>
        </div>`;
      } else {
        if (inList) {
          html += '</ul>';
          inList = false;
        }
        if (line.trim()) {
          html += `<p>${escapeHtml(line)}</p>`;
        }
      }
    }

    if (inList) {
      html += '</ul>';
    }

    return html;
  }

  const COLOR_PRESETS = [
    { name: 'Yellow', value: 'rgba(255, 235, 59, 0.5)' },
    { name: 'Blue', value: 'rgba(100, 181, 246, 0.5)' },
    { name: 'Red', value: 'rgba(239, 83, 80, 0.5)' },
    { name: 'Green', value: 'rgba(129, 199, 132, 0.5)' },
    { name: 'Purple', value: 'rgba(206, 147, 216, 0.5)' }
  ];

  function createNoteEditor(annotation, anchorElement) {
    // Remove any existing editor
    removeNoteEditor();

    const editor = document.createElement('div');
    editor.className = 'annotatepro-note-editor';
    editor.setAttribute('data-annotation-id', annotation.id);

    const currentColor = annotation.color || INTENT_COLORS[annotation.intent] || INTENT_COLORS.DEFAULT;

    const isCheckbox = annotation.annotationType === 'checkbox';
    const hasNoColor = !annotation.color || annotation.color === 'transparent';

    editor.innerHTML = `
      <div class="annotatepro-note-header">
        <span class="annotatepro-note-title">Note</span>
        <span class="annotatepro-note-status"></span>
        <button class="annotatepro-note-close" title="Close">&times;</button>
      </div>
      <div class="annotatepro-color-picker">
        ${COLOR_PRESETS.map(c => `
          <button class="annotatepro-color-swatch ${c.value === currentColor ? 'active' : ''}"
                  data-color="${c.value}"
                  title="${c.name}"
                  style="background: ${c.value}"></button>
        `).join('')}
        ${isCheckbox ? `<button class="annotatepro-color-swatch annotatepro-color-clear ${hasNoColor ? 'active' : ''}" data-color="transparent" title="No color">&times;</button>` : ''}
      </div>
      <div class="annotatepro-note-toolbar">
        <button class="annotatepro-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
        <button class="annotatepro-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
      </div>
      <textarea class="annotatepro-note-textarea"
                placeholder="Add a note..."
                autocapitalize="sentences"
                rows="3">${escapeHtml(annotation.note || '')}</textarea>
    `;

    // Position near the anchor element
    const rect = anchorElement.getBoundingClientRect();
    editor.style.top = `${Math.min(rect.bottom + 8, window.innerHeight - 200)}px`;
    editor.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 300))}px`;

    document.body.appendChild(editor);
    activeNoteEditor = { editor, annotation, originalNote: annotation.note || '' };

    // Setup event listeners
    setupNoteEditorListeners(editor, annotation);

    // Focus the textarea
    const textarea = editor.querySelector('.annotatepro-note-textarea');
    setupAutoCapitalize(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    return editor;
  }

  function removeNoteEditor() {
    if (activeNoteEditor) {
      activeNoteEditor.editor.remove();
      activeNoteEditor = null;
      document.removeEventListener('click', handleClickOutsideNote);
    }
    clearTimeout(saveDebounceTimer);
  }

  function setupNoteEditorListeners(editor, annotation) {
    const textarea = editor.querySelector('.annotatepro-note-textarea');
    const closeBtn = editor.querySelector('.annotatepro-note-close');
    const statusEl = editor.querySelector('.annotatepro-note-status');

    // Color swatch click handlers
    editor.querySelectorAll('.annotatepro-color-swatch').forEach(swatch => {
      swatch.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newColor = swatch.dataset.color;

        // Update active state
        editor.querySelectorAll('.annotatepro-color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        // Update annotation color
        try {
          statusEl.textContent = 'Saving...';
          statusEl.className = 'annotatepro-note-status saving';

          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch: { color: newColor }
          });

          annotation.color = newColor;

          // Update the element on the page (highlight or checkbox wrapper)
          const annotatedEl = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
          if (annotatedEl) {
            if (newColor === 'transparent') {
              annotatedEl.style.removeProperty('--annotatepro-color');
              annotatedEl.style.backgroundColor = 'transparent';
            } else {
              annotatedEl.style.setProperty('--annotatepro-color', newColor);
              // For checkbox wrappers, also update background-color directly
              if (annotatedEl.classList.contains('annotatepro-checkbox-text')) {
                annotatedEl.style.backgroundColor = newColor;
              }
            }
          }

          statusEl.textContent = 'Saved';
          statusEl.className = 'annotatepro-note-status saved';
          setTimeout(() => { statusEl.textContent = ''; }, 1500);
        } catch (err) {
          statusEl.textContent = 'Error';
          statusEl.className = 'annotatepro-note-status error';
          console.error('AnnotatePro: Failed to save color', err);
        }
      });
    });

    // Toolbar button handlers
    editor.querySelectorAll('.annotatepro-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        insertNoteFormat(textarea, action);
        textarea.focus();
      });
    });

    // Auto-save on input with debounce
    textarea.addEventListener('input', () => {
      statusEl.textContent = 'Saving...';
      statusEl.className = 'annotatepro-note-status saving';

      clearTimeout(saveDebounceTimer);
      saveDebounceTimer = setTimeout(async () => {
        try {
          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch: { note: textarea.value }
          });
          statusEl.textContent = 'Saved';
          statusEl.className = 'annotatepro-note-status saved';
          if (activeNoteEditor) {
            activeNoteEditor.originalNote = textarea.value;
          }
          // Update the annotation object
          annotation.note = textarea.value;
          // Update the note badge
          updateNoteBadge(annotation.id, !!(textarea.value && textarea.value.trim()));
        } catch (err) {
          statusEl.textContent = 'Error';
          statusEl.className = 'annotatepro-note-status error';
          console.error('AnnotatePro: Failed to save note', err);
        }
      }, 500);
    });

    // Close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNoteEditor();
    });

    // Escape to cancel (revert to original)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        // Revert to original
        if (activeNoteEditor) {
          textarea.value = activeNoteEditor.originalNote;
        }
        removeNoteEditor();
      }
    });

    // Prevent editor from closing when clicking inside
    editor.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Click outside to close (delayed to avoid immediate close)
    setTimeout(() => {
      document.addEventListener('click', handleClickOutsideNote);
    }, 100);
  }

  function handleClickOutsideNote(e) {
    if (activeNoteEditor && !activeNoteEditor.editor.contains(e.target)) {
      removeNoteEditor();
    }
  }

  // ============ Main Content Script ============

  const MessageType = {
    ADD_ANNOTATION: 'ADD_ANNOTATION',
    UPDATE_ANNOTATION: 'UPDATE_ANNOTATION',
    DELETE_ANNOTATION: 'DELETE_ANNOTATION',
    GET_PAGE_ANNOTATIONS: 'GET_PAGE_ANNOTATIONS',
    GET_ANNOTATION: 'GET_ANNOTATION'
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

      if (!annotations || annotations.length === 0) {
        return;
      }

      const results = reattachAll(annotations);

      for (const { annotation, element, score } of results.attached) {
        // Check if already attached AND still exists in DOM
        if (attachedAnnotations.has(annotation.id)) {
          const existingElement = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
          const existingCheckbox = document.querySelector(`[data-annotatepro-checkbox-id="${annotation.id}"]`);
          if (existingElement || existingCheckbox) {
            continue; // Already exists in DOM, skip
          }
          // Element was removed by page - clear stale entry
          attachedAnnotations.delete(annotation.id);
        }

        applyAnnotation(element, annotation);
        attachedAnnotations.add(annotation.id);
        setupAnnotationListeners(element, annotation);
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
        // Set default color using CSS variable for future color changes
        wrapper.style.setProperty('--annotatepro-color', INTENT_COLORS.DEFAULT);
        wrapper.style.cssText = `position: relative !important; display: inline-block !important; padding-left: 22px !important; background-color: var(--annotatepro-color, ${INTENT_COLORS.DEFAULT}) !important; border-radius: 2px;`;

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

  // Store annotation data for click-to-edit access
  const annotationDataMap = new Map();

  function setupAnnotationListeners(element, annotation) {
    // Store annotation data for later access
    annotationDataMap.set(annotation.id, annotation);

    // Update note badge based on whether annotation has a note
    updateNoteBadge(annotation.id, !!(annotation.note && annotation.note.trim()));

    if (annotation.annotationType === 'checkbox') {
      const checkbox = document.querySelector(
        `[data-annotatepro-checkbox-id="${annotation.id}"]`
      );
      if (checkbox) {
        checkbox.addEventListener('change', async (e) => {
          const isChecked = e.target.checked;
          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch: { checked: isChecked }
          });
          // Notify dashboard to update checkbox
          browser.runtime.sendMessage({
            type: 'BROADCAST_CHECKBOX_UPDATE',
            annotationId: annotation.id,
            checked: isChecked
          }).catch(() => {});
        });
      }
    }

    // Click to edit note - find the actual annotated element
    const annotatedEl = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
    if (annotatedEl) {
      annotatedEl.addEventListener('click', (e) => {
        // Don't trigger on checkbox input clicks
        if (e.target.classList.contains('annotatepro-checkbox')) return;
        // Don't trigger if user is selecting text
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;

        e.stopPropagation();
        createNoteEditor(annotation, annotatedEl);
      });
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

    // Handle text nodes
    if (current && current.nodeType === Node.TEXT_NODE) {
      current = current.parentElement;
    }

    while (current && current !== document.body) {
      // Check for highlight annotation
      if (current.hasAttribute && current.hasAttribute('data-annotatepro-id')) {
        return current.getAttribute('data-annotatepro-id');
      }
      // Check for checkbox annotation (the input element)
      if (current.hasAttribute && current.hasAttribute('data-annotatepro-checkbox-id')) {
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

      case 'COMMAND_CLEAR_CONFIRM':
        showClearConfirmDialog();
        break;

      case 'COMMAND_DELETE_BY_ID':
        if (message.annotationId) {
          deleteAnnotation(message.annotationId);
        }
        break;

      case 'COMMAND_CHECK_SELECTION':
        const sel = window.getSelection();
        return Promise.resolve(sel && !sel.isCollapsed && sel.toString().trim().length > 0);

      case 'COMMAND_UPDATE_NOTE_BADGE':
        if (message.annotationId !== undefined) {
          // Update local annotation data if we have it
          const existingData = annotationDataMap.get(message.annotationId);
          if (existingData) {
            existingData.note = message.note || '';
          }
          updateNoteBadge(message.annotationId, !!(message.note && message.note.trim()));
        }
        break;

      case 'COMMAND_UPDATE_COLOR':
        if (message.annotationId && message.color) {
          // Update local annotation data
          const colorData = annotationDataMap.get(message.annotationId);
          if (colorData) {
            colorData.color = message.color;
          }
          // Update the element (highlight or checkbox wrapper)
          const colorEl = document.querySelector(`[data-annotatepro-id="${message.annotationId}"]`);
          if (colorEl) {
            if (message.color === 'transparent') {
              colorEl.style.removeProperty('--annotatepro-color');
              colorEl.style.backgroundColor = 'transparent';
            } else {
              colorEl.style.setProperty('--annotatepro-color', message.color);
              // For checkbox wrappers, also update background-color directly
              if (colorEl.classList.contains('annotatepro-checkbox-text')) {
                colorEl.style.backgroundColor = message.color;
              }
            }
          }
        }
        break;

      case 'COMMAND_UPDATE_CHECKBOX':
        if (message.annotationId !== undefined) {
          // Update local annotation data
          const checkboxData = annotationDataMap.get(message.annotationId);
          if (checkboxData) {
            checkboxData.checked = message.checked;
          }
          // Update the checkbox element
          const checkboxEl = document.querySelector(`[data-annotatepro-checkbox-id="${message.annotationId}"]`);
          if (checkboxEl) {
            checkboxEl.checked = message.checked;
          }
        }
        break;

      case 'COMMAND_EDIT_NOTE':
        (async () => {
          // First, check if there's selected text - create highlight + open note
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
            const saved = await createHighlight('DEFAULT');
            if (saved) {
              const annotatedEl = document.querySelector(`[data-annotatepro-id="${saved.id}"]`);
              if (annotatedEl) {
                createNoteEditor(saved, annotatedEl);
              }
            }
            return;
          }

          // Otherwise, check if right-clicked on an existing annotation
          if (lastContextMenuTarget) {
            const noteAnnotationId = findAnnotationId(lastContextMenuTarget);
            if (noteAnnotationId) {
              // Get annotation data from map, or fetch from database
              let annotationData = annotationDataMap.get(noteAnnotationId);
              if (!annotationData) {
                annotationData = await sendMessage(MessageType.GET_ANNOTATION, { id: noteAnnotationId });
                if (annotationData) {
                  annotationDataMap.set(noteAnnotationId, annotationData);
                }
              }
              if (annotationData) {
                const annotatedEl = document.querySelector(`[data-annotatepro-id="${noteAnnotationId}"]`);
                if (annotatedEl) {
                  createNoteEditor(annotationData, annotatedEl);
                }
              }
            }
          }
        })();
        break;
    }
  });

  function setupMutationObserver() {
    let pending = false;
    let debounceTimer = null;

    const observer = new MutationObserver((mutations) => {
      // Ignore mutations caused by our own extension
      const isOwnMutation = mutations.every(mutation => {
        // Check if the mutation target or added/removed nodes are our elements
        const target = mutation.target;
        if (target.classList?.contains('annotatepro-highlight') ||
            target.classList?.contains('annotatepro-checkbox') ||
            target.classList?.contains('annotatepro-note-editor') ||
            target.classList?.contains('annotatepro-confirm-overlay') ||
            target.hasAttribute?.('data-annotatepro-id')) {
          return true;
        }
        // Check added nodes
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (node.classList?.contains('annotatepro-highlight') ||
                node.classList?.contains('annotatepro-checkbox') ||
                node.classList?.contains('annotatepro-note-editor') ||
                node.hasAttribute?.('data-annotatepro-id')) {
              return true;
            }
          }
        }
        return false;
      });

      if (isOwnMutation) return;
      if (pending) return;

      // Debounce with longer timeout
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        pending = true;
        if (typeof requestIdleCallback !== 'undefined') {
          requestIdleCallback(() => {
            pending = false;
            loadAnnotations();
          }, { timeout: 2000 });
        } else {
          setTimeout(() => {
            pending = false;
            loadAnnotations();
          }, 500);
        }
      }, 300);
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
