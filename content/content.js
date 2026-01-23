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

  // Legacy intent colors - used as fallback for old annotations
  const INTENT_COLORS = {
    ACTION: 'rgba(255, 235, 59, 0.5)',
    QUESTION: 'rgba(100, 181, 246, 0.5)',
    RISK: 'rgba(239, 83, 80, 0.5)',
    REFERENCE: 'rgba(129, 199, 132, 0.5)',
    CUSTOM: 'rgba(206, 147, 216, 0.5)',
    DEFAULT: 'rgba(255, 235, 59, 0.5)'
  };

  /**
   * Get the highlight color for an annotation
   * Prefers colorId, falls back to legacy color/intent
   */
  function getAnnotationColor(annotation) {
    const { colorId, color, intent } = annotation;

    // If explicit color is set (including transparent), use it
    if (color) return color;

    // If colorId is set, get color from cache
    if (colorId) {
      const colorObj = cachedColors.find(c => c.id === colorId);
      if (colorObj) {
        return hexToRgba(colorObj.color, 0.5);
      }
    }

    // Legacy fallback: use intent
    if (intent && INTENT_COLORS[intent]) {
      return INTENT_COLORS[intent];
    }

    return INTENT_COLORS.DEFAULT;
  }

  function applyHighlight(element, annotation) {
    const { id, textSnapshot, selectionStartOffset, selectionLength } = annotation;

    // Check if annotation already exists in DOM - prevent duplicates
    const existing = document.querySelector(`[data-annotatepro-id="${id}"]`);
    if (existing) {
      return existing;
    }

    if (selectionStartOffset !== undefined && selectionLength) {
      return applyTextHighlight(element, annotation);
    }

    const highlightColor = getAnnotationColor(annotation);

    element.setAttribute('data-annotatepro-id', id);
    element.setAttribute('data-annotatepro-type', 'highlight');
    element.classList.add('annotatepro-highlight');
    element.style.setProperty('--annotatepro-color', highlightColor);

    return element;
  }

  function applyTextHighlight(element, annotation) {
    const { id, textSnapshot } = annotation;

    // Check if annotation already exists in DOM - prevent duplicates
    const existing = document.querySelector(`[data-annotatepro-id="${id}"]`);
    if (existing) {
      return existing;
    }

    const highlightColor = getAnnotationColor(annotation);
    const hasTransparentColor = highlightColor === 'transparent';

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
          wrapper.classList.add('annotatepro-text-highlight');

          // Only add highlight class and background if not transparent
          if (hasTransparentColor) {
            wrapper.style.cssText = 'background: transparent !important; background-color: transparent !important; color: inherit !important; position: relative;';
          } else {
            wrapper.classList.add('annotatepro-highlight');
            wrapper.style.setProperty('--annotatepro-color', highlightColor);
          }

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
    const { id, checked, note, textSnapshot } = annotation;
    const checkboxColor = getAnnotationColor(annotation);
    const hasTransparentColor = checkboxColor === 'transparent';

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

          // Set wrapper inline styles - let CSS gradient handle the background
          wrapper.style.cssText = `position: relative !important; display: inline-block !important; padding-left: 22px !important; --annotatepro-color: ${checkboxColor};`;
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
      const pageUrl = window.location.href;
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
   * Update note badge on annotation element (purple circle at bottom-right)
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
        badge.setAttribute('data-annotation-id', annotationId);
        annotatedEl.appendChild(badge);

        // Add hover listeners for tooltip preview
        badge.addEventListener('mouseenter', (e) => {
          const annotation = annotationDataMap.get(annotationId);
          if (annotation?.note) {
            showNoteTooltip(annotation.note, e.target);
          }
        });
        badge.addEventListener('mouseleave', () => {
          hideNoteTooltip();
        });

        // Add click listener to open the note modal
        badge.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          hideNoteTooltip();
          const annotation = annotationDataMap.get(annotationId);
          if (annotation) {
            createNoteModal(annotation);
          }
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

  /**
   * Build color swatches HTML from cached colors
   */
  function buildColorSwatchesHTML(currentColorId, currentColor, isCheckbox = false) {
    const hasNoColor = currentColor === 'transparent' || !currentColor;

    let html = cachedColors.map(c => {
      const colorValue = hexToRgba(c.color, 0.5);
      const isActive = c.id === currentColorId || colorValue === currentColor;
      return `
        <button class="annotatepro-color-swatch ${isActive ? 'active' : ''}"
                data-color-id="${c.id}"
                data-color="${colorValue}"
                title="${c.name}"
                style="background: ${colorValue}"></button>
      `;
    }).join('');

    // Add clear/transparent option for checkboxes
    if (isCheckbox) {
      html += `<button class="annotatepro-color-swatch annotatepro-color-clear ${hasNoColor ? 'active' : ''}" data-color="transparent" title="No color">&times;</button>`;
    }

    return html;
  }

  function createNoteEditor(annotation, anchorElement) {
    // Remove any existing editor
    removeNoteEditor();

    const editor = document.createElement('div');
    editor.className = 'annotatepro-note-editor';
    editor.setAttribute('data-annotation-id', annotation.id);

    const currentColor = getAnnotationColor(annotation);
    const isCheckbox = annotation.annotationType === 'checkbox';

    editor.innerHTML = `
      <div class="annotatepro-note-header">
        <span class="annotatepro-note-title">Note</span>
        <span class="annotatepro-note-status"></span>
        <button class="annotatepro-note-close" title="Close">&times;</button>
      </div>
      <div class="annotatepro-color-picker">
        ${buildColorSwatchesHTML(annotation.colorId, annotation.color, isCheckbox)}
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

  // ============ Note Modal (Large View) ============

  let activeNoteModal = null;
  let modalSaveTimer = null;

  function createNoteModal(annotation) {
    // Remove any existing modal or editor
    removeNoteModal();
    removeNoteEditor();

    const currentColor = getAnnotationColor(annotation);
    const isCheckbox = annotation.annotationType === 'checkbox';
    const hasNoColor = currentColor === 'transparent' || !annotation.colorId;
    const snippetText = annotation.textSnapshot || '(element annotation)';
    const modalTypeClass = isCheckbox ? 'annotatepro-checkbox-modal' : 'annotatepro-highlight-modal';
    const typeLabel = isCheckbox ? 'Checkbox' : 'Highlight';

    const overlay = document.createElement('div');
    overlay.className = 'annotatepro-note-modal-overlay';

    // Build color swatches from cached colors
    const colorSwatches = cachedColors.map(c => {
      const colorValue = hexToRgba(c.color, 0.5);
      const isActive = c.id === annotation.colorId || colorValue === currentColor;
      return `
        <button class="annotatepro-note-modal-color ${isActive ? 'active' : ''}"
                data-color-id="${c.id}"
                data-color="${colorValue}"
                title="${c.name}"
                style="background: ${colorValue}"></button>
      `;
    }).join('');

    overlay.innerHTML = `
      <div class="annotatepro-note-modal ${modalTypeClass}">
        <div class="annotatepro-note-modal-header ${modalTypeClass}-header">
          <h2>${typeLabel}</h2>
          <span class="annotatepro-note-modal-status"></span>
          <button class="annotatepro-note-modal-close" title="Close">&times;</button>
        </div>
        <div class="annotatepro-note-modal-snippet-wrapper">
          <div class="annotatepro-note-modal-snippet">${escapeHtml(snippetText.length > 150 ? snippetText.slice(0, 150) + '...' : snippetText)}</div>
          <button class="annotatepro-note-modal-copy-btn snippet-copy" title="Copy text">Copy</button>
        </div>
        <div class="annotatepro-note-modal-colors">
          <span class="annotatepro-note-modal-colors-label">Color:</span>
          ${colorSwatches}
          <button class="annotatepro-note-modal-color annotatepro-note-modal-color-clear ${hasNoColor ? 'active' : ''}" data-color="transparent" title="Clear color">&times;</button>
        </div>
        <div class="annotatepro-note-modal-toolbar-wrapper">
          <div class="annotatepro-note-modal-toolbar">
            <button class="annotatepro-note-modal-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
            <button class="annotatepro-note-modal-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
          </div>
          <button class="annotatepro-note-modal-copy-btn note-copy" title="Copy note">Copy</button>
        </div>
        <div class="annotatepro-note-modal-body">
          <textarea class="annotatepro-note-modal-textarea"
                    placeholder="Write your note here..."
                    autocapitalize="sentences">${escapeHtml(annotation.note || '')}</textarea>
        </div>
        <div class="annotatepro-note-modal-footer">
          <span class="annotatepro-note-modal-hint">Auto-saves as you type</span>
          <div class="annotatepro-note-modal-actions">
            <button class="annotatepro-note-modal-btn annotatepro-note-modal-btn-secondary close-btn">Done</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);
    activeNoteModal = { overlay, annotation, originalNote: annotation.note || '' };

    // Setup event listeners
    setupNoteModalListeners(overlay, annotation);

    // Focus the textarea
    const textarea = overlay.querySelector('.annotatepro-note-modal-textarea');
    setupAutoCapitalize(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);

    return overlay;
  }

  function removeNoteModal() {
    if (activeNoteModal) {
      activeNoteModal.overlay.remove();
      activeNoteModal = null;
    }
    clearTimeout(modalSaveTimer);
  }

  function setupNoteModalListeners(overlay, annotation) {
    const modal = overlay.querySelector('.annotatepro-note-modal');
    const textarea = overlay.querySelector('.annotatepro-note-modal-textarea');
    const closeBtn = overlay.querySelector('.annotatepro-note-modal-close');
    const doneBtn = overlay.querySelector('.close-btn');
    const statusEl = overlay.querySelector('.annotatepro-note-modal-status');

    // Copy snippet button handler
    const snippetCopyBtn = overlay.querySelector('.snippet-copy');
    if (snippetCopyBtn && annotation.textSnapshot) {
      snippetCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(annotation.textSnapshot);
          snippetCopyBtn.textContent = 'Copied!';
          snippetCopyBtn.classList.add('copied');
          setTimeout(() => {
            snippetCopyBtn.textContent = 'Copy';
            snippetCopyBtn.classList.remove('copied');
          }, 2000);
        } catch (err) {
          console.error('Failed to copy snippet:', err);
        }
      });
    }

    // Copy note button handler
    const noteCopyBtn = overlay.querySelector('.note-copy');
    if (noteCopyBtn) {
      noteCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const noteText = textarea ? textarea.value : '';
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

    // Color swatch click handlers
    overlay.querySelectorAll('.annotatepro-note-modal-color').forEach(swatch => {
      swatch.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newColorId = swatch.dataset.colorId;
        const newColor = swatch.dataset.color;

        // Update active state
        overlay.querySelectorAll('.annotatepro-note-modal-color').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        // Build patch - use colorId if available, otherwise color (for transparent)
        const patch = newColorId ? { colorId: newColorId, color: null } : { colorId: null, color: newColor };

        // Update annotation color
        try {
          statusEl.textContent = 'Saving...';
          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch
          });

          annotation.colorId = newColorId || null;
          annotation.color = newColorId ? null : newColor;

          // Update the element on the page
          const annotatedEl = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
          if (annotatedEl) {
            const displayColor = newColorId ? hexToRgba(getColorById(newColorId)?.color || '#FFEB3B', 0.5) : newColor;
            if (displayColor === 'transparent') {
              annotatedEl.style.removeProperty('--annotatepro-color');
              annotatedEl.style.backgroundColor = 'transparent';
            } else {
              annotatedEl.style.setProperty('--annotatepro-color', displayColor);
              if (annotatedEl.classList.contains('annotatepro-checkbox-text')) {
                annotatedEl.style.backgroundColor = displayColor;
              }
            }
          }

          statusEl.textContent = 'Saved';
          setTimeout(() => { statusEl.textContent = ''; }, 1500);
        } catch (err) {
          statusEl.textContent = 'Error';
          console.error('AnnotatePro: Failed to save color', err);
        }
      });
    });

    // Toolbar button handlers
    overlay.querySelectorAll('.annotatepro-note-modal-toolbar-btn').forEach(btn => {
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

      clearTimeout(modalSaveTimer);
      modalSaveTimer = setTimeout(async () => {
        try {
          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch: { note: textarea.value }
          });
          statusEl.textContent = 'Saved';
          if (activeNoteModal) {
            activeNoteModal.originalNote = textarea.value;
          }
          annotation.note = textarea.value;
          updateNoteBadge(annotation.id, !!(textarea.value && textarea.value.trim()));
        } catch (err) {
          statusEl.textContent = 'Error';
          console.error('AnnotatePro: Failed to save note', err);
        }
      }, 500);
    });

    // Close button
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNoteModal();
    });

    // Done button
    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      removeNoteModal();
    });

    // Click outside modal to close
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        removeNoteModal();
      }
    });

    // Prevent modal content clicks from closing
    modal.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Escape to close
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        removeNoteModal();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);
  }

  // ============ Page Note Functionality ============

  let pageNoteBubble = null;
  let pageNoteTooltip = null;
  let pageNoteData = null; // Stores the page note annotation
  let sidebarCollapsed = true; // Track if sidebar is collapsed (per-tab, always starts collapsed)

  /**
   * Update page note bubble - shows badge only when sidebar is collapsed and page has a note
   */
  function updatePageNoteBubble() {
    // Remove existing bubble
    if (pageNoteBubble) {
      pageNoteBubble.remove();
      pageNoteBubble = null;
    }

    // Only show if sidebar is collapsed and there's a page note with content
    if (!sidebarCollapsed || !pageNoteData || !pageNoteData.note) {
      return;
    }

    // Create bubble
    pageNoteBubble = document.createElement('div');
    pageNoteBubble.className = 'annotatepro-page-note-bubble';

    // Click to open page note modal
    pageNoteBubble.addEventListener('click', () => {
      openPageNoteModal();
    });

    // Hover to show tooltip preview
    pageNoteBubble.addEventListener('mouseenter', () => {
      showPageNoteTooltip(pageNoteData.note);
    });
    pageNoteBubble.addEventListener('mouseleave', () => {
      hidePageNoteTooltip();
    });

    document.body.appendChild(pageNoteBubble);
  }

  /**
   * Show tooltip preview of page note
   */
  function showPageNoteTooltip(noteText) {
    hidePageNoteTooltip();

    pageNoteTooltip = document.createElement('div');
    pageNoteTooltip.className = 'annotatepro-page-note-tooltip';

    const displayText = noteText.length > 150 ? noteText.slice(0, 150) + '...' : noteText;
    pageNoteTooltip.innerHTML = renderFormattedNote(displayText);

    document.body.appendChild(pageNoteTooltip);

    // Make visible
    requestAnimationFrame(() => {
      pageNoteTooltip.classList.add('visible');
    });
  }

  /**
   * Hide page note tooltip
   */
  function hidePageNoteTooltip() {
    if (pageNoteTooltip) {
      pageNoteTooltip.remove();
      pageNoteTooltip = null;
    }
  }

  /**
   * Load page note from storage
   */
  async function loadPageNote() {
    try {
      const pageUrl = getPageUrl();
      const annotations = await sendMessage(MessageType.GET_PAGE_ANNOTATIONS, { pageUrl });

      // Find page note (annotationType === 'page-note')
      pageNoteData = annotations.find(a => a.annotationType === 'page-note') || null;
      updatePageNoteBubble();
    } catch (error) {
      console.error('AnnotatePro: Failed to load page note', error);
    }
  }

  /**
   * Create or update page note
   */
  async function savePageNote(noteText) {
    const pageUrl = getPageUrl();

    if (pageNoteData) {
      // Update existing page note
      await sendMessage(MessageType.UPDATE_ANNOTATION, {
        id: pageNoteData.id,
        patch: { note: noteText }
      });
      pageNoteData.note = noteText;
    } else {
      // Create new page note
      const annotation = {
        elementFingerprint: `page-note_${hashText(pageUrl)}`,
        selector: 'body',
        tagName: 'body',
        className: '',
        textSnapshot: 'Page Note',
        textHash: hashText('Page Note'),
        contextBefore: '',
        contextAfter: '',
        pageUrl: pageUrl,
        annotationType: 'page-note',
        note: noteText,
        color: null,
        intent: null
      };

      pageNoteData = await sendMessage(MessageType.ADD_ANNOTATION, annotation);
    }

    updatePageNoteBubble();
  }

  /**
   * Open page note modal for editing
   */
  function openPageNoteModal() {
    removeNoteModal();
    removeNoteEditor();

    const noteText = pageNoteData?.note || '';

    const overlay = document.createElement('div');
    overlay.className = 'annotatepro-note-modal-overlay';

    overlay.innerHTML = `
      <div class="annotatepro-note-modal">
        <div class="annotatepro-note-modal-header">
          <h2>Page Note</h2>
          <span class="annotatepro-note-modal-status"></span>
          <button class="annotatepro-note-modal-close" title="Close">&times;</button>
        </div>
        <div class="annotatepro-note-modal-snippet">Notes for this page</div>
        <div class="annotatepro-note-modal-toolbar-wrapper">
          <div class="annotatepro-note-modal-toolbar">
            <button class="annotatepro-note-modal-toolbar-btn" data-action="bullet" title="Add bullet point">•</button>
            <button class="annotatepro-note-modal-toolbar-btn" data-action="checkbox" title="Add checkbox">☐</button>
          </div>
          <button class="annotatepro-note-modal-copy-btn note-copy" title="Copy note">Copy</button>
        </div>
        <div class="annotatepro-note-modal-body">
          <textarea class="annotatepro-note-modal-textarea"
                    placeholder="Write notes about this page..."
                    autocapitalize="sentences">${escapeHtml(noteText)}</textarea>
        </div>
        <div class="annotatepro-note-modal-footer">
          <span class="annotatepro-note-modal-hint">Auto-saves as you type</span>
          <div class="annotatepro-note-modal-actions">
            <button class="annotatepro-note-modal-btn annotatepro-note-modal-btn-secondary close-btn">Done</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const modal = overlay.querySelector('.annotatepro-note-modal');
    const textarea = overlay.querySelector('.annotatepro-note-modal-textarea');
    const closeBtn = overlay.querySelector('.annotatepro-note-modal-close');
    const doneBtn = overlay.querySelector('.close-btn');
    const statusEl = overlay.querySelector('.annotatepro-note-modal-status');

    // Toolbar button handlers
    overlay.querySelectorAll('.annotatepro-note-modal-toolbar-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const action = btn.dataset.action;
        insertNoteFormat(textarea, action);
        textarea.focus();
      });
    });

    // Copy note button handler
    const noteCopyBtn = overlay.querySelector('.note-copy');
    if (noteCopyBtn) {
      noteCopyBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const noteContent = textarea ? textarea.value : '';
        if (!noteContent.trim()) {
          noteCopyBtn.textContent = 'Empty';
          setTimeout(() => { noteCopyBtn.textContent = 'Copy'; }, 1500);
          return;
        }
        try {
          await navigator.clipboard.writeText(noteContent);
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

    // Auto-save with debounce
    let saveTimer;
    textarea.addEventListener('input', () => {
      statusEl.textContent = 'Saving...';

      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        try {
          await savePageNote(textarea.value);
          statusEl.textContent = 'Saved';
          setTimeout(() => { statusEl.textContent = ''; }, 1500);
        } catch (err) {
          statusEl.textContent = 'Error';
          console.error('AnnotatePro: Failed to save page note', err);
        }
      }, 500);
    });

    // Close handlers
    const closeModal = () => {
      clearTimeout(saveTimer);
      overlay.remove();
    };

    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });

    doneBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeModal();
    });

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        closeModal();
      }
    });

    modal.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    // Escape to close
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        closeModal();
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    // Focus textarea
    setupAutoCapitalize(textarea);
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }

  function setupNoteEditorListeners(editor, annotation) {
    const textarea = editor.querySelector('.annotatepro-note-textarea');
    const closeBtn = editor.querySelector('.annotatepro-note-close');
    const statusEl = editor.querySelector('.annotatepro-note-status');

    // Color swatch click handlers
    editor.querySelectorAll('.annotatepro-color-swatch').forEach(swatch => {
      swatch.addEventListener('click', async (e) => {
        e.stopPropagation();
        const newColorId = swatch.dataset.colorId;
        const newColor = swatch.dataset.color;

        // Update active state
        editor.querySelectorAll('.annotatepro-color-swatch').forEach(s => s.classList.remove('active'));
        swatch.classList.add('active');

        // Build patch - use colorId if available, otherwise color (for transparent)
        const patch = newColorId ? { colorId: newColorId, color: null } : { colorId: null, color: newColor };

        // Update annotation color
        try {
          statusEl.textContent = 'Saving...';
          statusEl.className = 'annotatepro-note-status saving';

          await sendMessage(MessageType.UPDATE_ANNOTATION, {
            id: annotation.id,
            patch
          });

          annotation.colorId = newColorId || null;
          annotation.color = newColorId ? null : newColor;

          // Update the element on the page (highlight or checkbox wrapper)
          const annotatedEl = document.querySelector(`[data-annotatepro-id="${annotation.id}"]`);
          if (annotatedEl) {
            const displayColor = newColorId ? hexToRgba(getColorById(newColorId)?.color || '#FFEB3B', 0.5) : newColor;
            if (displayColor === 'transparent') {
              annotatedEl.style.setProperty('--annotatepro-color', 'transparent');
            } else {
              annotatedEl.style.setProperty('--annotatepro-color', displayColor);
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
    GET_ANNOTATION: 'GET_ANNOTATION',
    GET_ALL_COLORS: 'GET_ALL_COLORS',
    ADD_COLOR: 'ADD_COLOR'
  };

  // Cache for colors loaded from database
  let cachedColors = [];
  let colorsLoaded = false;

  // Clipboard history tracking
  const MAX_CLIPBOARD_ENTRIES = 50;
  let clipboardHistory = [];

  /**
   * Load clipboard history from storage
   */
  async function loadClipboardHistoryFromStorage() {
    try {
      const result = await browser.storage.local.get('clipboardHistory');
      if (result.clipboardHistory && Array.isArray(result.clipboardHistory)) {
        clipboardHistory = result.clipboardHistory;
        window.__annotateProClipboardHistory = clipboardHistory;
      }
    } catch (error) {
      console.error('AnnotatePro: Failed to load clipboard history', error);
    }
  }

  /**
   * Save clipboard history to storage
   */
  async function saveClipboardHistoryToStorage() {
    try {
      await browser.storage.local.set({ clipboardHistory });
    } catch (error) {
      console.error('AnnotatePro: Failed to save clipboard history', error);
    }
  }

  /**
   * Set up clipboard tracking
   * Listens for copy events and stores text in history
   */
  async function setupClipboardTracking() {
    // Load existing history from storage
    await loadClipboardHistoryFromStorage();

    document.addEventListener('copy', async () => {
      // Get the copied text from selection
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const text = selection.toString().trim();
      if (!text || text.length === 0) return;

      // Don't duplicate if same as most recent
      if (clipboardHistory.length > 0 && clipboardHistory[0].text === text) {
        return;
      }

      // Add to history
      clipboardHistory.unshift({
        text,
        timestamp: Date.now(),
        pageUrl: getPageUrl(),
        pageTitle: document.title
      });

      // Trim to max entries
      if (clipboardHistory.length > MAX_CLIPBOARD_ENTRIES) {
        clipboardHistory = clipboardHistory.slice(0, MAX_CLIPBOARD_ENTRIES);
      }

      // Expose to window for sidebar access
      window.__annotateProClipboardHistory = clipboardHistory;

      // Save to storage
      await saveClipboardHistoryToStorage();

      // Notify sidebar of update
      window.dispatchEvent(new CustomEvent('annotatepro-clipboard-updated'));
    });

    // Initialize window property
    window.__annotateProClipboardHistory = clipboardHistory;
  }

  /**
   * Get clipboard history (for sidebar)
   */
  function getClipboardHistory() {
    return clipboardHistory;
  }

  /**
   * Load colors from the database
   */
  async function loadColors() {
    try {
      cachedColors = await sendMessage(MessageType.GET_ALL_COLORS, {});
      cachedColors.sort((a, b) => a.sortOrder - b.sortOrder);
      colorsLoaded = true;
      return cachedColors;
    } catch (error) {
      console.error('AnnotatePro: Failed to load colors', error);
      return [];
    }
  }

  /**
   * Get color by ID from cache
   */
  function getColorById(colorId) {
    return cachedColors.find(c => c.id === colorId);
  }

  /**
   * Get the actual color value (with alpha) for rendering
   */
  function getColorValue(colorId, fallbackColor = null) {
    if (fallbackColor) return fallbackColor;
    const color = getColorById(colorId);
    if (color) {
      // Convert hex to rgba with 0.5 alpha for highlights
      return hexToRgba(color.color, 0.5);
    }
    // Default yellow if no color found
    return 'rgba(255, 235, 59, 0.5)';
  }

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
   * Get default color ID
   */
  function getDefaultColorId() {
    const defaultColor = cachedColors.find(c => c.id === 'default-action') || cachedColors[0];
    return defaultColor?.id || 'default-action';
  }

  const attachedAnnotations = new Set();

  async function sendMessage(type, payload) {
    return browser.runtime.sendMessage({ type, payload });
  }

  function getPageUrl() {
    return window.location.href;
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

  async function createHighlight(colorId = null, color = null) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      return null;
    }

    const fingerprint = createSelectionFingerprint(selection);
    if (!fingerprint) return null;

    // Use provided colorId, or default to first color if none specified
    const effectiveColorId = colorId || getDefaultColorId();

    const annotation = {
      ...fingerprint,
      pageUrl: getPageUrl(),
      annotationType: 'highlight',
      colorId: color === 'transparent' ? null : effectiveColorId,
      color: color, // Only used for transparent
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
      note: '',
      color: 'transparent'
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
      note: '',
      color: 'transparent'
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
        // Default to no background color for checkboxes
        wrapper.style.cssText = `position: relative !important; display: inline-block !important; padding-left: 22px !important; border-radius: 2px;`;

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
        // Don't trigger on badge clicks (handled separately)
        if (e.target.classList.contains('annotatepro-note-badge')) return;
        // Don't trigger if user is selecting text
        const selection = window.getSelection();
        if (selection && !selection.isCollapsed) return;

        e.stopPropagation();
        createNoteModal(annotation);
      });
    }

    element.addEventListener('contextmenu', (e) => {
      if (e.shiftKey) {
        e.preventDefault();
        if (confirm('Delete this annotation?')) {
          deleteAnnotation(annotation.id);
        }
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

      // Number keys 1-9 select colors by sort order
      if (!e.ctrlKey && !e.altKey && !e.metaKey) {
        const num = parseInt(e.key);
        if (num >= 1 && num <= 9 && cachedColors.length > 0) {
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed) {
            e.preventDefault();
            const colorIndex = num - 1;
            const color = cachedColors[colorIndex];
            if (color) {
              await createHighlight(color.id);
            }
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
        // Support both old intent-based and new colorId-based messages
        if (message.colorId) {
          createHighlight(message.colorId);
        } else if (message.intent) {
          // Legacy: map intent to color ID
          const intentToColorId = {
            'ACTION': 'default-action',
            'QUESTION': 'default-question',
            'RISK': 'default-risk',
            'REFERENCE': 'default-reference',
            'CUSTOM': 'default-action',
            'DEFAULT': 'default-action'
          };
          createHighlight(intentToColorId[message.intent] || 'default-action');
        } else {
          createHighlight();
        }
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
            if (confirm('Delete this annotation?')) {
              deleteAnnotation(annotationId);
            }
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
          if (confirm('Delete this annotation?')) {
            deleteAnnotation(message.annotationId);
          }
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
              colorEl.style.setProperty('--annotatepro-color', 'transparent');
            } else {
              colorEl.style.setProperty('--annotatepro-color', message.color);
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
          // First, check if there's selected text - create annotation with note (no highlight by default)
          const selection = window.getSelection();
          if (selection && !selection.isCollapsed && selection.toString().trim().length > 0) {
            const saved = await createHighlight(null, 'transparent');
            if (saved) {
              createNoteModal(saved);
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
                createNoteModal(annotationData);
              }
            }
          }
        })();
        break;

      case 'COMMAND_PAGE_NOTE':
        openPageNoteModal();
        break;

      // ============ Realtime Sync Messages ============

      case 'ANNOTATION_ADDED':
        // Another source (popup, dashboard, other tab) added an annotation to this page
        if (message.annotation) {
          // Guard: only process annotations for this page
          const addedPageUrl = message.annotation.pageUrl;
          if (addedPageUrl && addedPageUrl !== getPageUrl()) {
            break;
          }
          // Handle page notes separately
          if (message.annotation.annotationType === 'page-note') {
            pageNoteData = message.annotation;
            updatePageNoteBubble();
          } else if (!attachedAnnotations.has(message.annotation.id)) {
            const match = reattach(message.annotation);
            if (match) {
              applyAnnotation(match.element, message.annotation);
              attachedAnnotations.add(message.annotation.id);
              setupAnnotationListeners(match.element, message.annotation);
            }
          }
        }
        break;

      case 'ANNOTATION_UPDATED':
        if (message.annotationId && message.patch) {
          // Guard: only process updates for this page
          if (message.pageUrl && message.pageUrl !== getPageUrl()) {
            break;
          }
          // Check if this is a page note update
          if (pageNoteData && pageNoteData.id === message.annotationId) {
            Object.assign(pageNoteData, message.patch);
            updatePageNoteBubble();
            break;
          }

          // Update local annotation data
          const existingAnnotation = annotationDataMap.get(message.annotationId);
          if (existingAnnotation) {
            Object.assign(existingAnnotation, message.patch);
          }

          // Handle specific patch updates
          if (message.patch.colorId !== undefined || message.patch.color !== undefined) {
            const colorEl = document.querySelector(`[data-annotatepro-id="${message.annotationId}"]`);
            if (colorEl) {
              let displayColor;
              if (message.patch.colorId) {
                const colorObj = getColorById(message.patch.colorId);
                displayColor = colorObj ? hexToRgba(colorObj.color, 0.5) : 'rgba(255, 235, 59, 0.5)';
              } else if (message.patch.color) {
                displayColor = message.patch.color;
              }

              if (displayColor) {
                if (displayColor === 'transparent') {
                  colorEl.style.setProperty('--annotatepro-color', 'transparent');
                } else {
                  colorEl.style.setProperty('--annotatepro-color', displayColor);
                }
              }
            }
          }

          if (message.patch.note !== undefined) {
            updateNoteBadge(message.annotationId, !!(message.patch.note && message.patch.note.trim()));
          }

          if (message.patch.checked !== undefined) {
            const checkboxEl = document.querySelector(`[data-annotatepro-checkbox-id="${message.annotationId}"]`);
            if (checkboxEl) {
              checkboxEl.checked = message.patch.checked;
            }
          }
        }
        break;

      case 'ANNOTATION_DELETED':
        if (message.annotationId) {
          // Guard: only process deletions for this page
          if (message.pageUrl && message.pageUrl !== getPageUrl()) {
            break;
          }
          // Check if deleted annotation is the page note
          if (pageNoteData && pageNoteData.id === message.annotationId) {
            pageNoteData = null;
            updatePageNoteBubble();
          } else {
            removeAnnotation(message.annotationId);
            attachedAnnotations.delete(message.annotationId);
            annotationDataMap.delete(message.annotationId);
          }
        }
        break;

      case 'PAGE_CLEARED':
        // Guard: only clear annotations for this page
        if (message.pageUrl && message.pageUrl !== getPageUrl()) {
          break;
        }
        clearAllAnnotationsFromDOM();
        // Also clear page note
        pageNoteData = null;
        updatePageNoteBubble();
        break;

      case 'DATABASE_CLEARED':
        clearAllAnnotationsFromDOM();
        pageNoteData = null;
        updatePageNoteBubble();
        break;

      // Color management events - refresh cache
      case 'COLOR_ADDED':
      case 'COLOR_UPDATED':
      case 'COLOR_DELETED':
        loadColors();
        break;

      case 'GET_CLIPBOARD_HISTORY':
        // Return clipboard history to popup
        return Promise.resolve(clipboardHistory);

      case 'SIDEBAR_POSITION_CHANGED':
        // Update badge position when sidebar position changes
        if (message.position) {
          updateBadgePosition(message.position);
        }
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

  /**
   * Listen for sidebar collapse/expand events
   */
  function setupSidebarEventListeners() {
    window.addEventListener('annotatepro-sidebar-toggle', (event) => {
      if (event.detail && typeof event.detail.collapsed === 'boolean') {
        sidebarCollapsed = event.detail.collapsed;
        updatePageNoteBubble();
      }
    });
  }

  async function init() {
    if (document.readyState === 'loading') {
      await new Promise(resolve => {
        document.addEventListener('DOMContentLoaded', resolve);
      });
    }

    // Load colors first so they're available for rendering
    await loadColors();

    setupKeyboardShortcuts();
    setupMutationObserver();
    setupSidebarEventListeners();
    await setupClipboardTracking();
    await loadAnnotations();
    await loadPageNote();

    console.log('AnnotatePro: Content script initialized');
  }

  init();
})();
