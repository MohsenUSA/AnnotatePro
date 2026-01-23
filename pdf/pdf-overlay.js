/**
 * AnnotatePro PDF Overlay System
 * Handles PDF detection and annotation overlay
 */

(function() {
  'use strict';

  // Avoid double initialization
  if (window.annotateProPdfInitialized) return;
  window.annotateProPdfInitialized = true;

  // PDF state
  let isPdfMode = false;
  let pdfViewer = null;
  let overlayContainer = null;
  let currentPage = 1;
  let totalPages = 1;
  let currentScale = 1;
  let pageOverlays = new Map(); // Map of page number -> overlay element

  /**
   * Detect if current page is a PDF
   */
  function detectPdf() {
    const url = window.location.href;

    // Check URL patterns
    if (url.endsWith('.pdf')) {
      return { isPdf: true, type: 'url' };
    }

    // Firefox built-in PDF viewer
    if (url.startsWith('resource://pdf.js/') ||
        url.includes('viewer.html') && url.includes('file=')) {
      return { isPdf: true, type: 'firefox-pdfjs' };
    }

    // Check for pdf.js viewer container
    const pdfViewerEl = document.getElementById('viewer') ||
                        document.querySelector('.pdfViewer');
    if (pdfViewerEl && document.querySelector('.page[data-page-number]')) {
      return { isPdf: true, type: 'pdfjs' };
    }

    // Check for embedded PDFs
    const embedPdf = document.querySelector('embed[type="application/pdf"]');
    if (embedPdf) {
      return { isPdf: true, type: 'embed', element: embedPdf };
    }

    const objectPdf = document.querySelector('object[type="application/pdf"]');
    if (objectPdf) {
      return { isPdf: true, type: 'object', element: objectPdf };
    }

    // Chrome's PDF viewer uses an embed with a specific structure
    const chromeEmbed = document.querySelector('embed[name="plugin"]');
    if (chromeEmbed && document.contentType === 'application/pdf') {
      return { isPdf: true, type: 'chrome-pdf', element: chromeEmbed };
    }

    return { isPdf: false };
  }

  /**
   * Initialize PDF mode
   */
  function initPdfMode(detection) {
    isPdfMode = true;
    window.annotateProPdfMode = true;

    console.log('AnnotatePro: PDF detected, type:', detection.type);

    // Different initialization based on PDF viewer type
    switch (detection.type) {
      case 'pdfjs':
      case 'firefox-pdfjs':
        initPdfJsOverlay();
        break;
      case 'embed':
      case 'object':
      case 'chrome-pdf':
        initEmbedOverlay(detection.element);
        break;
      case 'url':
        // Wait for viewer to load
        waitForPdfViewer();
        break;
    }
  }

  /**
   * Wait for PDF viewer to be ready
   */
  function waitForPdfViewer() {
    let attempts = 0;
    const maxAttempts = 50; // 5 seconds max

    const checkInterval = setInterval(() => {
      attempts++;

      const detection = detectPdf();
      if (detection.isPdf && detection.type !== 'url') {
        clearInterval(checkInterval);
        initPdfMode(detection);
        return;
      }

      // Check for pdf.js pages
      const pages = document.querySelectorAll('.page[data-page-number]');
      if (pages.length > 0) {
        clearInterval(checkInterval);
        initPdfJsOverlay();
        return;
      }

      if (attempts >= maxAttempts) {
        clearInterval(checkInterval);
        console.log('AnnotatePro: PDF viewer not detected after timeout');
      }
    }, 100);
  }

  /**
   * Initialize overlay for PDF.js viewer
   */
  function initPdfJsOverlay() {
    pdfViewer = document.getElementById('viewer') ||
                document.querySelector('.pdfViewer');

    if (!pdfViewer) {
      console.error('AnnotatePro: PDF viewer container not found');
      return;
    }

    // Create overlay container
    overlayContainer = document.createElement('div');
    overlayContainer.className = 'annotatepro-pdf-overlay-container';
    overlayContainer.style.cssText = `
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      pointer-events: none;
      z-index: 100;
    `;

    // Insert overlay container into viewer
    pdfViewer.style.position = 'relative';
    pdfViewer.appendChild(overlayContainer);

    // Get initial page count and scale
    updatePdfState();

    // Create overlays for visible pages
    createPageOverlays();

    // Set up observers for page changes and zoom
    setupPdfObservers();

    // Load existing annotations
    loadPdfAnnotations();

    console.log('AnnotatePro: PDF.js overlay initialized');
  }

  /**
   * Initialize overlay for embedded PDF
   */
  function initEmbedOverlay(embedElement) {
    // For embedded PDFs, we create an overlay div on top
    const rect = embedElement.getBoundingClientRect();

    overlayContainer = document.createElement('div');
    overlayContainer.className = 'annotatepro-pdf-overlay-container';
    overlayContainer.style.cssText = `
      position: absolute;
      top: ${rect.top + window.scrollY}px;
      left: ${rect.left + window.scrollX}px;
      width: ${rect.width}px;
      height: ${rect.height}px;
      pointer-events: none;
      z-index: 1000;
    `;

    document.body.appendChild(overlayContainer);

    // Update position on scroll/resize
    const updatePosition = () => {
      const newRect = embedElement.getBoundingClientRect();
      overlayContainer.style.top = (newRect.top + window.scrollY) + 'px';
      overlayContainer.style.left = (newRect.left + window.scrollX) + 'px';
      overlayContainer.style.width = newRect.width + 'px';
      overlayContainer.style.height = newRect.height + 'px';
    };

    window.addEventListener('scroll', updatePosition);
    window.addEventListener('resize', updatePosition);

    // Note: Embedded PDFs have limited annotation support
    // We can only add floating annotations, not text-based ones
    console.log('AnnotatePro: Embedded PDF overlay initialized (limited support)');
  }

  /**
   * Update PDF state (page count, scale)
   */
  function updatePdfState() {
    // Try to get page count from pdf.js
    const pages = document.querySelectorAll('.page[data-page-number]');
    totalPages = pages.length || 1;

    // Try to get current scale
    const pageEl = document.querySelector('.page');
    if (pageEl) {
      const canvas = pageEl.querySelector('canvas');
      if (canvas) {
        const pageWidth = parseFloat(pageEl.style.width) || pageEl.offsetWidth;
        // Estimate scale from canvas size vs page size
        currentScale = canvas.width / pageWidth || 1;
      }
    }

    // Try to get current page from pdf.js
    const visiblePage = document.querySelector('.page[data-loaded="true"]');
    if (visiblePage) {
      currentPage = parseInt(visiblePage.dataset.pageNumber) || 1;
    }
  }

  /**
   * Create overlay elements for each page
   */
  function createPageOverlays() {
    const pages = document.querySelectorAll('.page[data-page-number]');

    pages.forEach(page => {
      const pageNum = parseInt(page.dataset.pageNumber);

      if (pageOverlays.has(pageNum)) return;

      const overlay = document.createElement('div');
      overlay.className = 'annotatepro-pdf-page-overlay';
      overlay.dataset.pageNumber = pageNum;
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
      `;

      // Position overlay relative to page
      const pageRect = page.getBoundingClientRect();
      const containerRect = overlayContainer.getBoundingClientRect();

      overlay.style.top = (page.offsetTop) + 'px';
      overlay.style.left = (page.offsetLeft) + 'px';
      overlay.style.width = page.offsetWidth + 'px';
      overlay.style.height = page.offsetHeight + 'px';

      overlayContainer.appendChild(overlay);
      pageOverlays.set(pageNum, overlay);
    });
  }

  /**
   * Set up observers for PDF viewer changes
   */
  function setupPdfObservers() {
    // Observe viewer for new pages (lazy loading)
    const viewerObserver = new MutationObserver((mutations) => {
      let needsUpdate = false;

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.classList?.contains('page')) {
              needsUpdate = true;
              break;
            }
          }
        }
        if (mutation.type === 'attributes' &&
            (mutation.attributeName === 'style' ||
             mutation.attributeName === 'data-loaded')) {
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        updatePdfState();
        createPageOverlays();
        repositionAnnotations();
      }
    });

    if (pdfViewer) {
      viewerObserver.observe(pdfViewer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['style', 'data-loaded']
      });
    }

    // Listen for zoom changes via pdf.js events
    document.addEventListener('scalechange', (e) => {
      currentScale = e.detail?.scale || currentScale;
      repositionAnnotations();
    });

    // Listen for page changes
    document.addEventListener('pagechange', (e) => {
      currentPage = e.detail?.pageNumber || currentPage;
    });

    // Fallback: observe scale changes via resize
    window.addEventListener('resize', () => {
      setTimeout(() => {
        updatePdfState();
        updateOverlayPositions();
        repositionAnnotations();
      }, 100);
    });
  }

  /**
   * Update overlay positions after zoom/resize
   */
  function updateOverlayPositions() {
    const pages = document.querySelectorAll('.page[data-page-number]');

    pages.forEach(page => {
      const pageNum = parseInt(page.dataset.pageNumber);
      const overlay = pageOverlays.get(pageNum);

      if (overlay) {
        overlay.style.top = page.offsetTop + 'px';
        overlay.style.left = page.offsetLeft + 'px';
        overlay.style.width = page.offsetWidth + 'px';
        overlay.style.height = page.offsetHeight + 'px';
      }
    });
  }

  /**
   * Load existing PDF annotations
   */
  async function loadPdfAnnotations() {
    try {
      const pageUrl = window.location.href;
      const annotations = await browser.runtime.sendMessage({
        type: 'GET_PAGE_ANNOTATIONS',
        payload: { pageUrl }
      });

      // Filter for PDF annotations
      const pdfAnnotations = annotations.filter(a => a.pdfMode);

      for (const annotation of pdfAnnotations) {
        renderPdfAnnotation(annotation);
      }

      console.log(`AnnotatePro: Loaded ${pdfAnnotations.length} PDF annotations`);
    } catch (error) {
      console.error('AnnotatePro: Failed to load PDF annotations', error);
    }
  }

  /**
   * Render a single PDF annotation
   */
  function renderPdfAnnotation(annotation) {
    if (!annotation.pdfPage || !annotation.pdfCoordinates) return;

    const overlay = pageOverlays.get(annotation.pdfPage);
    if (!overlay) return;

    const coords = annotation.pdfCoordinates;

    // Create annotation element
    const annotEl = document.createElement('div');
    annotEl.className = 'annotatepro-pdf-annotation';
    annotEl.dataset.annotationId = annotation.id;
    annotEl.style.cssText = `
      position: absolute;
      left: ${coords.x}%;
      top: ${coords.y}%;
      width: ${coords.width}%;
      height: ${coords.height}%;
      pointer-events: auto;
      cursor: pointer;
    `;

    // Style based on annotation type
    if (annotation.annotationType === 'highlight') {
      const color = annotation.color || 'rgba(255, 235, 59, 0.4)';
      annotEl.style.background = color;
      annotEl.style.mixBlendMode = 'multiply';
    } else if (annotation.annotationType === 'checkbox') {
      annotEl.innerHTML = `
        <input type="checkbox"
               class="annotatepro-pdf-checkbox"
               ${annotation.checked ? 'checked' : ''}
               style="width: 16px; height: 16px; cursor: pointer;">
      `;
      annotEl.style.display = 'flex';
      annotEl.style.alignItems = 'center';
      annotEl.style.justifyContent = 'center';
    }

    // Add note indicator if has note
    if (annotation.note) {
      const noteIndicator = document.createElement('span');
      noteIndicator.className = 'annotatepro-pdf-note-indicator';
      noteIndicator.textContent = '📝';
      noteIndicator.style.cssText = `
        position: absolute;
        top: -8px;
        right: -8px;
        font-size: 12px;
      `;
      annotEl.appendChild(noteIndicator);
    }

    // Add click handler
    annotEl.addEventListener('click', (e) => {
      e.stopPropagation();
      showAnnotationPopup(annotation, annotEl);
    });

    // Add checkbox change handler
    const checkbox = annotEl.querySelector('.annotatepro-pdf-checkbox');
    if (checkbox) {
      checkbox.addEventListener('change', async (e) => {
        e.stopPropagation();
        await browser.runtime.sendMessage({
          type: 'UPDATE_ANNOTATION',
          payload: { id: annotation.id, patch: { checked: checkbox.checked } }
        });
      });
    }

    overlay.appendChild(annotEl);
  }

  /**
   * Reposition all annotations after zoom/scroll
   */
  function repositionAnnotations() {
    // Annotations use percentage-based positioning,
    // so they should reposition automatically with the overlay
    updateOverlayPositions();
  }

  /**
   * Show annotation popup for editing
   */
  function showAnnotationPopup(annotation, targetEl) {
    // Remove existing popup
    const existing = document.querySelector('.annotatepro-pdf-popup');
    if (existing) existing.remove();

    const rect = targetEl.getBoundingClientRect();

    const popup = document.createElement('div');
    popup.className = 'annotatepro-pdf-popup';
    popup.style.cssText = `
      position: fixed;
      top: ${rect.bottom + 5}px;
      left: ${rect.left}px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.15);
      z-index: 10000;
      min-width: 200px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: 13px;
    `;

    popup.innerHTML = `
      <div style="margin-bottom: 8px; font-weight: 500;">
        ${annotation.textSnapshot || 'Annotation'}
      </div>
      <textarea
        class="annotatepro-pdf-note-input"
        placeholder="Add a note..."
        style="width: 100%; min-height: 60px; padding: 8px; border: 1px solid #ddd; border-radius: 4px; font-size: 12px; resize: vertical; box-sizing: border-box;"
      >${annotation.note || ''}</textarea>
      <div style="display: flex; gap: 8px; margin-top: 8px;">
        <button class="annotatepro-pdf-popup-btn save" style="flex: 1; padding: 6px; background: #6366f1; color: white; border: none; border-radius: 4px; cursor: pointer;">Save</button>
        <button class="annotatepro-pdf-popup-btn delete" style="padding: 6px 12px; background: #fee2e2; color: #dc2626; border: none; border-radius: 4px; cursor: pointer;">Delete</button>
      </div>
    `;

    document.body.appendChild(popup);

    // Focus textarea
    popup.querySelector('textarea').focus();

    // Save handler
    popup.querySelector('.save').addEventListener('click', async () => {
      const note = popup.querySelector('textarea').value;
      await browser.runtime.sendMessage({
        type: 'UPDATE_ANNOTATION',
        payload: { id: annotation.id, patch: { note } }
      });
      popup.remove();
    });

    // Delete handler
    popup.querySelector('.delete').addEventListener('click', async () => {
      if (confirm('Delete this annotation?')) {
        await browser.runtime.sendMessage({
          type: 'DELETE_ANNOTATION',
          payload: { id: annotation.id }
        });
        targetEl.remove();
        popup.remove();
      }
    });

    // Close on outside click
    const closeOnOutside = (e) => {
      if (!popup.contains(e.target) && !targetEl.contains(e.target)) {
        popup.remove();
        document.removeEventListener('click', closeOnOutside);
      }
    };
    setTimeout(() => document.addEventListener('click', closeOnOutside), 0);
  }

  /**
   * Create a PDF annotation from selection
   */
  async function createPdfHighlight(colorId) {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim();
    if (!text) return;

    // Find which page the selection is in
    let pageEl = range.startContainer;
    while (pageEl && !pageEl.classList?.contains('page')) {
      pageEl = pageEl.parentElement;
    }

    if (!pageEl) {
      console.warn('AnnotatePro: Could not find PDF page for selection');
      return;
    }

    const pageNum = parseInt(pageEl.dataset.pageNumber);
    const pageRect = pageEl.getBoundingClientRect();
    const rangeRect = range.getBoundingClientRect();

    // Calculate percentage-based coordinates
    const coords = {
      x: ((rangeRect.left - pageRect.left) / pageRect.width) * 100,
      y: ((rangeRect.top - pageRect.top) / pageRect.height) * 100,
      width: (rangeRect.width / pageRect.width) * 100,
      height: (rangeRect.height / pageRect.height) * 100
    };

    // Get color value
    let color = 'rgba(255, 235, 59, 0.4)';
    if (colorId) {
      try {
        const colors = await browser.runtime.sendMessage({
          type: 'GET_ALL_COLORS',
          payload: {}
        });
        const colorObj = colors.find(c => c.id === colorId);
        if (colorObj) {
          const hex = colorObj.color;
          const r = parseInt(hex.slice(1, 3), 16);
          const g = parseInt(hex.slice(3, 5), 16);
          const b = parseInt(hex.slice(5, 7), 16);
          color = `rgba(${r}, ${g}, ${b}, 0.4)`;
        }
      } catch (e) {
        console.error('Failed to load colors', e);
      }
    }

    // Create annotation
    const annotation = {
      annotationType: 'highlight',
      pageUrl: window.location.href,
      pageTitle: document.title,
      textSnapshot: text,
      colorId: colorId || 'default-action',
      color,
      pdfMode: true,
      pdfPage: pageNum,
      pdfCoordinates: coords,
      elementFingerprint: `pdf-page-${pageNum}-${coords.x.toFixed(2)}-${coords.y.toFixed(2)}`
    };

    try {
      const saved = await browser.runtime.sendMessage({
        type: 'ADD_ANNOTATION',
        payload: annotation
      });

      // Render the new annotation
      renderPdfAnnotation(saved);

      // Clear selection
      selection.removeAllRanges();

      console.log('AnnotatePro: PDF annotation created', saved);
    } catch (error) {
      console.error('AnnotatePro: Failed to create PDF annotation', error);
    }
  }

  /**
   * Create a PDF checkbox annotation
   */
  async function createPdfCheckbox(x, y, pageNum) {
    const pageEl = document.querySelector(`.page[data-page-number="${pageNum}"]`);
    if (!pageEl) return;

    const pageRect = pageEl.getBoundingClientRect();

    // Calculate percentage-based coordinates
    const coords = {
      x: ((x - pageRect.left) / pageRect.width) * 100,
      y: ((y - pageRect.top) / pageRect.height) * 100,
      width: 3, // Fixed percentage width
      height: 3  // Fixed percentage height
    };

    const annotation = {
      annotationType: 'checkbox',
      pageUrl: window.location.href,
      pageTitle: document.title,
      checked: false,
      pdfMode: true,
      pdfPage: pageNum,
      pdfCoordinates: coords,
      elementFingerprint: `pdf-checkbox-${pageNum}-${coords.x.toFixed(2)}-${coords.y.toFixed(2)}`
    };

    try {
      const saved = await browser.runtime.sendMessage({
        type: 'ADD_ANNOTATION',
        payload: annotation
      });

      renderPdfAnnotation(saved);
      console.log('AnnotatePro: PDF checkbox created', saved);
    } catch (error) {
      console.error('AnnotatePro: Failed to create PDF checkbox', error);
    }
  }

  /**
   * Listen for messages
   */
  browser.runtime.onMessage.addListener((message) => {
    if (!isPdfMode) return;

    switch (message.type) {
      case 'COMMAND_HIGHLIGHT':
        createPdfHighlight(message.colorId);
        break;

      case 'ANNOTATION_DELETED':
        if (message.annotationId) {
          const el = document.querySelector(`[data-annotation-id="${message.annotationId}"]`);
          if (el) el.remove();
        }
        break;

      case 'ANNOTATION_UPDATED':
        // Refresh the annotation display
        if (message.annotationId) {
          const el = document.querySelector(`[data-annotation-id="${message.annotationId}"]`);
          if (el && message.patch) {
            if (message.patch.color) {
              el.style.background = message.patch.color;
            }
            if (message.patch.checked !== undefined) {
              const cb = el.querySelector('.annotatepro-pdf-checkbox');
              if (cb) cb.checked = message.patch.checked;
            }
          }
        }
        break;
    }
  });

  /**
   * Initialize on load
   */
  function init() {
    // Check for PDF on load
    const detection = detectPdf();

    if (detection.isPdf) {
      initPdfMode(detection);
    } else {
      // Re-check after a delay (some PDF viewers load asynchronously)
      setTimeout(() => {
        const delayedDetection = detectPdf();
        if (delayedDetection.isPdf) {
          initPdfMode(delayedDetection);
        }
      }, 1000);
    }
  }

  // Expose functions
  window.annotateProPdf = {
    detectPdf,
    createPdfHighlight,
    createPdfCheckbox,
    isPdfMode: () => isPdfMode
  };

  // Initialize
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  console.log('AnnotatePro: PDF module loaded');
})();
