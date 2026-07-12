/**
 * AnnotatePro Screenshot Editor
 * Ephemeral screenshot capture and annotation
 */

(function() {
  'use strict';

  // Avoid double initialization
  if (window.annotateProScreenshotInitialized) return;
  window.annotateProScreenshotInitialized = true;

  // Editor state
  let editorEl = null;
  let canvas = null;
  let ctx = null;
  let originalImage = null;

  // Drawing state
  let currentTool = 'pen';
  let currentColor = '#FF0000';
  let strokeWidth = 3;
  let isDrawing = false;
  let startX = 0;
  let startY = 0;
  let lastX = 0;
  let lastY = 0;

  // History for undo/redo
  let history = [];
  let historyIndex = -1;
  const MAX_HISTORY = 50;

  // Zoom state
  let zoomLevel = 1;
  const ZOOM_MIN = 0.25;
  const ZOOM_MAX = 4;
  const ZOOM_STEP = 0.25;

  // Crop state
  let isCropping = false;
  let cropStartX = 0;
  let cropStartY = 0;
  let cropOverlay = null;

  // Pan state
  let isPanning = false;
  let panStartX = 0;
  let panStartY = 0;
  let spaceHeld = false;
  let previousTool = null;

  // Text annotations (draggable)
  let textAnnotations = [];
  let nextTextId = 1;
  let selectedTextAnnotation = null;

  // Tool colors
  const COLORS = [
    '#FF0000', // Red
    '#FF9800', // Orange
    '#FFEB3B', // Yellow
    '#4CAF50', // Green
    '#2196F3', // Blue
    '#9C27B0', // Purple
    '#000000', // Black
    '#FFFFFF'  // White
  ];

  // Stroke sizes
  const SIZES = {
    small: 2,
    medium: 4,
    large: 8
  };

  /**
   * Start area selection mode
   */
  function startAreaSelection() {
    const overlay = document.createElement('div');
    overlay.className = 'annotatepro-selection-overlay';

    const instructions = document.createElement('div');
    instructions.className = 'annotatepro-selection-instructions';
    instructions.textContent = 'Click and drag to select area. Press ESC to cancel.';
    overlay.appendChild(instructions);

    const selectionBox = document.createElement('div');
    selectionBox.className = 'annotatepro-selection-box';
    selectionBox.style.display = 'none';
    overlay.appendChild(selectionBox);

    const dimensions = document.createElement('div');
    dimensions.className = 'annotatepro-selection-dimensions';
    dimensions.style.display = 'none';
    overlay.appendChild(dimensions);

    let selecting = false;
    let startX, startY;

    function updateSelectionBox(e) {
      const currentX = e.clientX;
      const currentY = e.clientY;

      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      selectionBox.style.left = left + 'px';
      selectionBox.style.top = top + 'px';
      selectionBox.style.width = width + 'px';
      selectionBox.style.height = height + 'px';

      dimensions.style.left = (left + width + 10) + 'px';
      dimensions.style.top = (top + height / 2) + 'px';
      dimensions.textContent = `${width} x ${height}`;
    }

    function onMouseDown(e) {
      selecting = true;
      startX = e.clientX;
      startY = e.clientY;
      selectionBox.style.display = 'block';
      dimensions.style.display = 'block';
      updateSelectionBox(e);
    }

    function onMouseMove(e) {
      if (!selecting) return;
      updateSelectionBox(e);
    }

    async function onMouseUp(e) {
      if (!selecting) return;
      selecting = false;

      const endX = e.clientX;
      const endY = e.clientY;

      const left = Math.min(startX, endX);
      const top = Math.min(startY, endY);
      const width = Math.abs(endX - startX);
      const height = Math.abs(endY - startY);

      // Remove overlay (and its keydown handler) before capturing so the
      // dashed selection box isn't baked into the screenshot.
      overlay.remove();
      document.removeEventListener('keydown', onKeyDown);

      // Minimum selection size
      if (width < 10 || height < 10) {
        showToast('Selection Too Small', 'error');
        return;
      }

      // Request screenshot from background
      try {
        const response = await browser.runtime.sendMessage({
          type: 'CAPTURE_SCREENSHOT'
        });

        if (response && response.dataUrl) {
          // Crop the image to selection
          const croppedDataUrl = await cropImage(response.dataUrl, left, top, width, height);

          // Re-draw the purple selection outline (standalone, non-interactive)
          // so the user still sees exactly what they captured behind the bar.
          const outline = document.createElement('div');
          outline.className = 'annotatepro-selection-outline';
          outline.style.left = left + 'px';
          outline.style.top = top + 'px';
          outline.style.width = width + 'px';
          outline.style.height = height + 'px';
          document.body.appendChild(outline);

          // Most captures just need a quick copy/export, so offer inline
          // actions anchored to the selection instead of always opening the
          // full editor. "Edit" is one click away for annotation.
          showAreaActionBar(croppedDataUrl, { left, top, width, height }, () => outline.remove());
        }
      } catch (error) {
        console.error('AnnotatePro: Screenshot capture failed', error);
        showToast('Failed To Capture Screenshot', 'error');
      }
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', onKeyDown);
      }
    }

    overlay.addEventListener('mousedown', onMouseDown);
    overlay.addEventListener('mousemove', onMouseMove);
    overlay.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);

    document.body.appendChild(overlay);
  }

  /**
   * Inline quick-action bar shown after an area selection.
   * Lets the user copy/download/export the cropped image without opening the
   * full editor (the common case), with an "Edit" button to open the editor.
   * @param {string} croppedDataUrl - PNG data URL of the selected region
   * @param {{left:number, top:number, width:number, height:number}} rect - viewport-space selection bounds
   */
  function showAreaActionBar(croppedDataUrl, rect, onDismiss) {
    // Only one bar at a time.
    const existing = document.querySelector('.annotatepro-area-actions');
    if (existing) existing.remove();

    const bar = document.createElement('div');
    bar.className = 'annotatepro-area-actions';
    bar.style.visibility = 'hidden'; // hide until positioned to avoid a flash
    bar.innerHTML = `
      <button class="annotatepro-area-btn" data-area-action="copy" title="Copy to clipboard">📋 Copy</button>
      <button class="annotatepro-area-btn" data-area-action="png" title="Download PNG">⬇ PNG</button>
      <button class="annotatepro-area-btn" data-area-action="pdf" title="Export as PDF">📄 PDF</button>
      <button class="annotatepro-area-btn annotatepro-area-btn-edit" data-area-action="edit" title="Open in editor">✏️ Edit</button>
      <button class="annotatepro-area-btn annotatepro-area-btn-close" data-area-action="close" title="Cancel (ESC)">&times;</button>
    `;
    document.body.appendChild(bar);

    // Position below the selection, clamped to the viewport; flip above if
    // there isn't room below.
    const gap = 8;
    const barRect = bar.getBoundingClientRect();
    let top = rect.top + rect.height + gap;
    if (top + barRect.height > window.innerHeight) {
      top = Math.max(gap, rect.top - barRect.height - gap);
    }
    let left = rect.left;
    if (left + barRect.width > window.innerWidth) {
      left = Math.max(gap, window.innerWidth - barRect.width - gap);
    }
    bar.style.top = top + 'px';
    bar.style.left = left + 'px';
    bar.style.visibility = 'visible';

    // Lazily build the source canvas once, shared across actions.
    let canvasPromise = null;
    const getCanvas = () => (canvasPromise || (canvasPromise = canvasFromDataUrl(croppedDataUrl)));

    function dismiss() {
      bar.remove();
      if (onDismiss) onDismiss();
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onDocMouseDown, true);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        dismiss();
      }
    }

    function onDocMouseDown(e) {
      if (!bar.contains(e.target)) dismiss();
    }

    bar.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-area-action]');
      if (!btn) return;
      const action = btn.dataset.areaAction;

      if (action === 'close') { dismiss(); return; }
      if (action === 'edit') { dismiss(); openEditor(croppedDataUrl); return; }

      try {
        const srcCanvas = await getCanvas();
        if (action === 'copy') {
          await copyCanvasToClipboard(srcCanvas);
          showToast('Copied To Clipboard!', 'success');
        } else if (action === 'png') {
          downloadCanvasPng(srcCanvas);
          showToast('Screenshot Downloaded!', 'success');
        } else if (action === 'pdf') {
          exportCanvasAsPdf(srcCanvas);
          showToast('PDF Exported!', 'success');
        }
        dismiss();
      } catch (error) {
        console.error('AnnotatePro: area quick action failed', error);
        showToast('Action Failed', 'error');
      }
    });

    // Defer the outside-click/ESC listeners so the mouseup that ended the
    // selection doesn't instantly dismiss the bar.
    setTimeout(() => {
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('mousedown', onDocMouseDown, true);
    }, 0);
  }

  /**
   * Capture the visible area (entire viewport) without selection
   */
  async function captureVisibleArea() {
    try {
      const response = await browser.runtime.sendMessage({
        type: 'CAPTURE_SCREENSHOT'
      });

      if (response && response.dataUrl) {
        openEditor(response.dataUrl);
      } else if (response && response.error) {
        showToast('Failed to capture screenshot: ' + response.error, 'error');
      }
    } catch (error) {
      console.error('AnnotatePro: Visible area capture failed', error);
      showToast('Failed To Capture Visible Area', 'error');
    }
  }

  /**
   * Show countdown overlay (non-blocking so user can interact with page)
   */
  function showCountdown(seconds) {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'annotatepro-countdown-overlay';
      overlay.innerHTML = `
        <div class="annotatepro-countdown-content">
          <div class="annotatepro-countdown-number">${seconds}</div>
          <div class="annotatepro-countdown-text">Prepare your screen...</div>
          <button class="annotatepro-countdown-cancel">Cancel (ESC)</button>
        </div>
      `;
      document.body.appendChild(overlay);

      const numberEl = overlay.querySelector('.annotatepro-countdown-number');
      const cancelBtn = overlay.querySelector('.annotatepro-countdown-cancel');
      let cancelled = false;
      let currentCount = seconds;

      cancelBtn.addEventListener('click', () => {
        cancelled = true;
        overlay.remove();
        resolve(false);
      });

      // Handle ESC key
      function onKeyDown(e) {
        if (e.key === 'Escape') {
          cancelled = true;
          overlay.remove();
          document.removeEventListener('keydown', onKeyDown);
          resolve(false);
        }
      }
      document.addEventListener('keydown', onKeyDown);

      const interval = setInterval(() => {
        if (cancelled) {
          clearInterval(interval);
          return;
        }

        currentCount--;
        if (currentCount > 0) {
          numberEl.textContent = currentCount;
          numberEl.classList.add('annotatepro-countdown-pulse');
          setTimeout(() => numberEl.classList.remove('annotatepro-countdown-pulse'), 200);
        } else {
          clearInterval(interval);
          document.removeEventListener('keydown', onKeyDown);
          overlay.remove();
          resolve(true);
        }
      }, 1000);
    });
  }

  /**
   * Capture the visible area with a 5 second countdown timer
   */
  async function captureVisibleWithTimer() {
    const proceed = await showCountdown(5);
    if (proceed) {
      await captureVisibleArea();
    }
  }

  /**
   * Capture a specific element
   */
  async function captureElement(element) {
    try {
      const rect = element.getBoundingClientRect();
      const padding = 20;

      // Ensure element is in viewport
      element.scrollIntoView({ behavior: 'instant', block: 'center' });

      // Wait for scroll to settle
      await new Promise(r => setTimeout(r, 100));

      // Get updated rect after scroll
      const newRect = element.getBoundingClientRect();

      const response = await browser.runtime.sendMessage({
        type: 'CAPTURE_SCREENSHOT'
      });

      if (response && response.dataUrl) {
        const left = Math.max(0, newRect.left - padding);
        const top = Math.max(0, newRect.top - padding);
        const width = newRect.width + padding * 2;
        const height = newRect.height + padding * 2;

        const croppedDataUrl = await cropImage(response.dataUrl, left, top, width, height);
        openEditor(croppedDataUrl);
      }
    } catch (error) {
      console.error('AnnotatePro: Element capture failed', error);
      showToast('Failed To Capture Element', 'error');
    }
  }

  /**
   * Capture the whole page by stitching viewport captures
   */
  async function captureWholePage() {
    // Save original scroll position
    const originalScrollX = window.scrollX;
    const originalScrollY = window.scrollY;

    // Calculate page dimensions
    const pageWidth = Math.max(
      document.documentElement.scrollWidth,
      document.body.scrollWidth || 0
    );
    const pageHeight = Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight || 0
    );
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Check for canvas size limits (typically ~16k pixels max)
    const MAX_DIMENSION = 16000;
    if (pageWidth > MAX_DIMENSION || pageHeight > MAX_DIMENSION) {
      showToast('Page Too Large For Full Capture. Try Visible Area Instead.', 'error');
      return;
    }

    // Calculate segments needed
    const cols = Math.ceil(pageWidth / viewportWidth);
    const rows = Math.ceil(pageHeight / viewportHeight);
    const totalSegments = cols * rows;

    // Device pixel ratio for high-DPI screens
    const dpr = window.devicePixelRatio || 1;

    // Create output canvas
    const outputCanvas = document.createElement('canvas');
    outputCanvas.width = pageWidth * dpr;
    outputCanvas.height = pageHeight * dpr;
    const ctx = outputCanvas.getContext('2d');

    // Show progress overlay
    showCaptureProgress(0, totalSegments);

    try {
      let segmentIndex = 0;

      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const x = col * viewportWidth;
          const y = row * viewportHeight;

          // Scroll to segment position
          window.scrollTo(x, y);

          // Wait for render (allows lazy-loaded content to appear)
          await delay(150);

          // Hide AnnotatePro UI elements during capture so they don't appear in screenshot
          const elementsToHide = [
            document.querySelector('.annotatepro-capture-progress'),
            document.querySelector('.annotatepro-sidebar'),
            document.querySelector('.annotatepro-toast')
          ].filter(Boolean);

          // Store original display values
          const originalDisplays = elementsToHide.map(el => el.style.display);
          elementsToHide.forEach(el => el.style.display = 'none');

          // Small delay to ensure elements are hidden before capture
          await delay(50);

          // Capture the viewport
          const response = await browser.runtime.sendMessage({
            type: 'CAPTURE_SCREENSHOT'
          });

          // Restore original display values
          elementsToHide.forEach((el, i) => {
            el.style.display = originalDisplays[i];
          });

          if (!response || !response.dataUrl) {
            throw new Error('Failed to capture segment');
          }

          // Load and draw the segment
          const img = await loadImage(response.dataUrl);

          // Calculate actual position (may be offset if at edge)
          const actualX = window.scrollX;
          const actualY = window.scrollY;

          ctx.drawImage(img, actualX * dpr, actualY * dpr);

          segmentIndex++;
          updateCaptureProgress(segmentIndex, totalSegments);
        }
      }

      // Restore original scroll position
      window.scrollTo(originalScrollX, originalScrollY);

      // Hide progress and open editor
      hideCaptureProgress();
      openEditor(outputCanvas.toDataURL('image/png'));

    } catch (error) {
      console.error('AnnotatePro: Whole page capture failed', error);
      window.scrollTo(originalScrollX, originalScrollY);
      hideCaptureProgress();
      showToast('Failed To Capture Whole Page', 'error');
    }
  }

  /**
   * Load an image from data URL
   */
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  /**
   * Delay helper
   */
  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Show capture progress overlay
   */
  function showCaptureProgress(current, total) {
    let overlay = document.querySelector('.annotatepro-capture-progress');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'annotatepro-capture-progress';
      overlay.innerHTML = `
        <div class="annotatepro-capture-progress-content">
          <div class="annotatepro-capture-progress-spinner"></div>
          <div class="annotatepro-capture-progress-text">Capturing page...</div>
          <div class="annotatepro-capture-progress-bar">
            <div class="annotatepro-capture-progress-fill"></div>
          </div>
          <div class="annotatepro-capture-progress-count">0 / 0</div>
        </div>
      `;
      document.body.appendChild(overlay);
    }
    updateCaptureProgress(current, total);
  }

  /**
   * Update capture progress indicator
   */
  function updateCaptureProgress(current, total) {
    const overlay = document.querySelector('.annotatepro-capture-progress');
    if (!overlay) return;

    const fill = overlay.querySelector('.annotatepro-capture-progress-fill');
    const count = overlay.querySelector('.annotatepro-capture-progress-count');

    if (fill) {
      fill.style.width = `${(current / total) * 100}%`;
    }
    if (count) {
      count.textContent = `${current} / ${total}`;
    }
  }

  /**
   * Hide capture progress overlay
   */
  function hideCaptureProgress() {
    const overlay = document.querySelector('.annotatepro-capture-progress');
    if (overlay) {
      overlay.remove();
    }
  }

  /**
   * Crop image to specified region
   */
  async function cropImage(dataUrl, x, y, width, height) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        // Account for device pixel ratio
        const dpr = window.devicePixelRatio || 1;

        const cropCanvas = document.createElement('canvas');
        cropCanvas.width = width * dpr;
        cropCanvas.height = height * dpr;

        const cropCtx = cropCanvas.getContext('2d');
        cropCtx.drawImage(
          img,
          x * dpr, y * dpr, width * dpr, height * dpr,
          0, 0, width * dpr, height * dpr
        );

        resolve(cropCanvas.toDataURL('image/png'));
      };
      img.src = dataUrl;
    });
  }

  /**
   * Open the screenshot editor
   */
  function openEditor(imageDataUrl) {
    // Reset state
    history = [];
    historyIndex = -1;
    currentTool = 'pen';
    currentColor = '#FF0000';
    strokeWidth = SIZES.medium;
    zoomLevel = 1;
    isCropping = false;
    isPanning = false;
    spaceHeld = false;
    previousTool = null;
    textAnnotations = [];
    nextTextId = 1;

    // Create editor UI
    editorEl = document.createElement('div');
    editorEl.className = 'annotatepro-screenshot-editor';
    editorEl.innerHTML = `
      <div class="annotatepro-editor-header">
        <h2 class="annotatepro-editor-title">Screenshot Editor</h2>
        <div class="annotatepro-editor-actions">
          <button class="annotatepro-editor-btn annotatepro-editor-btn-secondary" data-action="copy">
            Copy to Clipboard
          </button>
          <button class="annotatepro-editor-btn annotatepro-editor-btn-secondary" data-action="export-pdf">
            Export as PDF
          </button>
          <button class="annotatepro-editor-btn annotatepro-editor-btn-primary" data-action="download">
            Download PNG
          </button>
          <button class="annotatepro-editor-btn annotatepro-editor-btn-close" data-action="close">
            &times;
          </button>
        </div>
      </div>
      <div class="annotatepro-editor-toolbar">
        <div class="annotatepro-toolbar-group">
          <span class="annotatepro-toolbar-label">Tools</span>
          <button class="annotatepro-tool-btn active" data-tool="pen" title="Pen (P)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 19l7-7 3 3-7 7-3-3z"/>
              <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
              <path d="M2 2l7.586 7.586"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="rect" title="Rectangle (R)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="3" width="18" height="18" rx="2"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="ellipse" title="Ellipse (E)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <ellipse cx="12" cy="12" rx="10" ry="7"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="arrow" title="Arrow (A)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="5" y1="19" x2="19" y2="5"/>
              <polyline points="12 5 19 5 19 12"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="text" title="Text (T)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="4 7 4 4 20 4 20 7"/>
              <line x1="12" y1="4" x2="12" y2="20"/>
              <line x1="8" y1="20" x2="16" y2="20"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="crop" title="Crop (C)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M6 2v4"/>
              <path d="M2 6h4"/>
              <path d="M6 6v12h12"/>
              <path d="M18 22v-4"/>
              <path d="M22 18h-4"/>
              <path d="M18 18V6H6"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-tool="pan" title="Pan (H / Hold Space)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v0"/>
              <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v2"/>
              <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8"/>
              <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15"/>
            </svg>
          </button>
        </div>
        <div class="annotatepro-toolbar-divider"></div>
        <div class="annotatepro-toolbar-group">
          <span class="annotatepro-toolbar-label">Color</span>
          ${COLORS.map(c => `
            <button class="annotatepro-color-btn ${c === currentColor ? 'active' : ''}"
                    data-color="${c}"
                    style="background: ${c}; ${c === '#FFFFFF' ? 'border: 1px solid #444;' : ''}"
                    title="${c}">
            </button>
          `).join('')}
        </div>
        <div class="annotatepro-toolbar-divider"></div>
        <div class="annotatepro-toolbar-group">
          <span class="annotatepro-toolbar-label">Size</span>
          <button class="annotatepro-size-btn" data-size="small" title="Small">
            <span class="annotatepro-size-dot"></span>
          </button>
          <button class="annotatepro-size-btn active" data-size="medium" title="Medium">
            <span class="annotatepro-size-dot"></span>
          </button>
          <button class="annotatepro-size-btn" data-size="large" title="Large">
            <span class="annotatepro-size-dot"></span>
          </button>
        </div>
        <div class="annotatepro-toolbar-divider"></div>
        <div class="annotatepro-toolbar-group">
          <button class="annotatepro-tool-btn" data-action="undo" title="Undo (Ctrl+Z)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 7v6h6"/>
              <path d="M21 17a9 9 0 00-9-9 9 9 0 00-6 2.3L3 13"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-action="redo" title="Redo (Ctrl+Y)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 7v6h-6"/>
              <path d="M3 17a9 9 0 019-9 9 9 0 016 2.3l3 2.7"/>
            </svg>
          </button>
        </div>
        <div class="annotatepro-toolbar-divider"></div>
        <div class="annotatepro-toolbar-group">
          <span class="annotatepro-toolbar-label">Zoom</span>
          <button class="annotatepro-tool-btn" data-action="zoom-out" title="Zoom Out (-)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <span class="annotatepro-zoom-level" data-zoom-display>100%</span>
          <button class="annotatepro-tool-btn" data-action="zoom-in" title="Zoom In (+)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="11" cy="11" r="8"/>
              <line x1="21" y1="21" x2="16.65" y2="16.65"/>
              <line x1="11" y1="8" x2="11" y2="14"/>
              <line x1="8" y1="11" x2="14" y2="11"/>
            </svg>
          </button>
          <button class="annotatepro-tool-btn" data-action="zoom-reset" title="Reset Zoom (0)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
              <path d="M3 3v5h5"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="annotatepro-editor-canvas-container">
        <div class="annotatepro-editor-canvas-wrapper">
          <canvas class="annotatepro-editor-canvas"></canvas>
        </div>
      </div>
      <div class="annotatepro-editor-shortcuts">
        <kbd>ESC</kbd> Close &nbsp;
        <kbd>Ctrl+Z</kbd> Undo &nbsp;
        <kbd>Ctrl+Y</kbd> Redo &nbsp;
        <kbd>+/-</kbd> Zoom &nbsp;
        <kbd>Space</kbd> Pan &nbsp;
        <kbd>C</kbd> Crop
      </div>
    `;

    document.body.appendChild(editorEl);
    document.body.classList.add('annotatepro-editor-open');

    // Get canvas and context
    canvas = editorEl.querySelector('.annotatepro-editor-canvas');
    ctx = canvas.getContext('2d');

    // Load image and initialize canvas
    const img = new Image();
    img.onload = () => {
      originalImage = img;
      canvas.width = img.width;
      canvas.height = img.height;
      ctx.drawImage(img, 0, 0);
      saveToHistory();

      // Set initial zoom to account for device pixel ratio
      // so the image displays at actual screen size
      const dpr = window.devicePixelRatio || 1;
      zoomLevel = 1 / dpr;
      updateZoom();
    };
    img.src = imageDataUrl;

    // Set up event listeners
    setupEditorListeners();
  }

  /**
   * Set up editor event listeners
   */
  function setupEditorListeners() {
    // Header buttons
    editorEl.querySelector('[data-action="copy"]').addEventListener('click', copyToClipboard);
    editorEl.querySelector('[data-action="export-pdf"]').addEventListener('click', exportAsPdf);
    editorEl.querySelector('[data-action="download"]').addEventListener('click', downloadScreenshot);
    editorEl.querySelector('[data-action="close"]').addEventListener('click', closeEditor);

    // Tool buttons
    editorEl.querySelectorAll('[data-tool]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        currentTool = btn.dataset.tool;
        editorEl.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        updateCanvasCursor();
        console.log('Tool Selected:', currentTool);
      });
    });

    // Color buttons
    editorEl.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        editorEl.querySelectorAll('[data-color]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // Update selected text annotation color if any
        if (selectedTextAnnotation) {
          selectedTextAnnotation.color = currentColor;
          updateTextAnnotationColor(selectedTextAnnotation);
        }
      });
    });

    // Size buttons
    editorEl.querySelectorAll('[data-size]').forEach(btn => {
      btn.addEventListener('click', () => {
        strokeWidth = SIZES[btn.dataset.size];
        editorEl.querySelectorAll('[data-size]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Undo/Redo buttons
    editorEl.querySelector('[data-action="undo"]').addEventListener('click', undo);
    editorEl.querySelector('[data-action="redo"]').addEventListener('click', redo);

    // Zoom buttons
    editorEl.querySelector('[data-action="zoom-in"]').addEventListener('click', zoomIn);
    editorEl.querySelector('[data-action="zoom-out"]').addEventListener('click', zoomOut);
    editorEl.querySelector('[data-action="zoom-reset"]').addEventListener('click', zoomReset);

    // Canvas drawing events
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseup', onCanvasMouseUp);
    canvas.addEventListener('mouseleave', onCanvasMouseUp);

    // Keyboard shortcuts
    document.addEventListener('keydown', onEditorKeyDown);
    document.addEventListener('keyup', onEditorKeyUp);

    // Prevent scroll wheel from affecting page behind, use for zoom instead
    editorEl.addEventListener('wheel', onEditorWheel, { passive: false });
  }

  /**
   * Handle mouse wheel for zoom
   */
  function onEditorWheel(e) {
    e.preventDefault();
    e.stopPropagation();

    // Use wheel for zooming
    if (e.deltaY < 0) {
      zoomIn();
    } else if (e.deltaY > 0) {
      zoomOut();
    }
  }

  /**
   * Get canvas coordinates from mouse event
   */
  function getCanvasCoords(e) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY
    };
  }

  /**
   * Canvas mouse down handler
   */
  function onCanvasMouseDown(e) {
    console.log('Canvas MouseDown Fired, currentTool:', currentTool);
    const coords = getCanvasCoords(e);
    startX = coords.x;
    startY = coords.y;
    lastX = coords.x;
    lastY = coords.y;

    // Clear text selection when clicking on canvas
    clearTextSelection();

    if (currentTool === 'text') {
      e.preventDefault();
      e.stopPropagation();
      console.log('Text Tool Clicked At:', coords.x, coords.y);
      showTextInput(coords.x, coords.y);
      return;
    }

    isDrawing = true;

    if (currentTool === 'crop') {
      isCropping = true;
      cropStartX = coords.x;
      cropStartY = coords.y;
      showCropOverlay();
      // Listen for mouseup anywhere in case user releases outside canvas
      document.addEventListener('mouseup', onDocumentMouseUpForCrop);
      return;
    }

    if (currentTool === 'pan') {
      e.preventDefault();
      isPanning = true;
      panStartX = e.clientX;
      panStartY = e.clientY;
      canvas.style.cursor = 'grabbing';
      return;
    }

    if (currentTool === 'pen') {
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = strokeWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
    }
  }

  /**
   * Canvas mouse move handler
   */
  function onCanvasMouseMove(e) {
    if (isPanning) {
      e.preventDefault();
      e.stopPropagation();
      const container = editorEl.querySelector('.annotatepro-editor-canvas-container');
      const deltaX = panStartX - e.clientX;
      const deltaY = panStartY - e.clientY;
      container.scrollLeft += deltaX;
      container.scrollTop += deltaY;
      panStartX = e.clientX;
      panStartY = e.clientY;
      return;
    }

    if (isCropping) {
      const coords = getCanvasCoords(e);
      updateCropOverlay(coords.x, coords.y);
      return;
    }

    if (!isDrawing) return;

    const coords = getCanvasCoords(e);

    if (currentTool === 'pen') {
      ctx.lineTo(coords.x, coords.y);
      ctx.stroke();
      lastX = coords.x;
      lastY = coords.y;
    } else {
      // For shapes, redraw from history
      restoreFromHistory();
      drawShape(currentTool, startX, startY, coords.x, coords.y);
    }
  }

  /**
   * Canvas mouse up handler
   */
  function onCanvasMouseUp(e) {
    if (isPanning) {
      isPanning = false;
      canvas.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
      return;
    }

    if (isCropping) {
      // Don't finalize crop on mouseleave - only on actual mouseup
      if (e.type === 'mouseleave') return;
      // Remove document listener since we're handling it here
      document.removeEventListener('mouseup', onDocumentMouseUpForCrop);
      const coords = getCanvasCoords(e);
      finishCrop(coords.x, coords.y);
      return;
    }

    if (!isDrawing) return;
    isDrawing = false;

    if (currentTool !== 'pen') {
      const coords = getCanvasCoords(e);
      drawShape(currentTool, startX, startY, coords.x, coords.y);
    }

    saveToHistory();
  }

  /**
   * Draw a shape
   */
  function drawShape(tool, x1, y1, x2, y2) {
    ctx.strokeStyle = currentColor;
    ctx.lineWidth = strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    switch (tool) {
      case 'rect':
        ctx.beginPath();
        ctx.rect(x1, y1, x2 - x1, y2 - y1);
        ctx.stroke();
        break;

      case 'ellipse':
        const centerX = (x1 + x2) / 2;
        const centerY = (y1 + y2) / 2;
        const radiusX = Math.abs(x2 - x1) / 2;
        const radiusY = Math.abs(y2 - y1) / 2;
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();
        break;

      case 'arrow':
        drawArrow(ctx, x1, y1, x2, y2);
        break;
    }
  }

  /**
   * Draw an arrow
   */
  function drawArrow(ctx, fromX, fromY, toX, toY) {
    const headLength = 15 + strokeWidth * 2;
    const angle = Math.atan2(toY - fromY, toX - fromX);

    // Line
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Arrowhead
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLength * Math.cos(angle - Math.PI / 6),
      toY - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLength * Math.cos(angle + Math.PI / 6),
      toY - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.stroke();
  }

  /**
   * Create a new text annotation at position
   */
  function showTextInput(x, y) {
    console.log('ShowTextInput Called:', x, y, 'zoomLevel:', zoomLevel);

    const baseFontSize = 12 + strokeWidth * 4;

    // Create annotation object
    const annotation = {
      id: nextTextId++,
      x: x,
      y: y,
      text: '',
      color: currentColor,
      fontSize: baseFontSize
    };

    // Create and show the editable text element
    createTextElement(annotation, true);
  }

  /**
   * Create a draggable text element for an annotation
   */
  function createTextElement(annotation, isEditing = false) {
    const wrapper = editorEl.querySelector('.annotatepro-editor-canvas-wrapper');
    if (!wrapper) {
      console.error('Canvas Wrapper Not Found!');
      return;
    }

    // Remove existing element for this annotation if any
    const existing = wrapper.querySelector(`[data-text-id="${annotation.id}"]`);
    if (existing) existing.remove();

    const displayX = annotation.x * zoomLevel;
    const displayY = annotation.y * zoomLevel;
    const displayFontSize = Math.max(14, annotation.fontSize * zoomLevel);

    const el = document.createElement('div');
    el.className = 'annotatepro-text-annotation';
    el.dataset.textId = annotation.id;
    el.style.left = displayX + 'px';
    el.style.top = displayY + 'px';
    el.style.color = annotation.color;
    el.style.fontSize = displayFontSize + 'px';

    if (isEditing || !annotation.text) {
      // Show textarea for editing
      const textarea = document.createElement('textarea');
      textarea.className = 'annotatepro-text-annotation-input';
      textarea.value = annotation.text;
      textarea.placeholder = 'Type here...';
      textarea.autocapitalize = 'sentences';
      textarea.style.color = annotation.color;
      textarea.style.fontSize = displayFontSize + 'px';

      // Auto-capitalize first letter on desktop
      textarea.addEventListener('input', () => {
        const val = textarea.value;
        if (val.length === 1 && val[0] !== val[0].toUpperCase()) {
          textarea.value = val[0].toUpperCase();
        }
      });

      el.appendChild(textarea);

      wrapper.appendChild(el);

      // Select this annotation when editing
      selectTextAnnotation(annotation);

      setTimeout(() => {
        textarea.focus();
        if (annotation.text) textarea.select();
      }, 10);

      let committed = false;

      function commitText() {
        if (committed) return;
        committed = true;

        const text = textarea.value.trim();
        if (text) {
          annotation.text = text;
          // Add to annotations if new
          if (!textAnnotations.find(a => a.id === annotation.id)) {
            textAnnotations.push(annotation);
          }
          // Re-render as static text
          createTextElement(annotation, false);
        } else {
          // Remove if empty
          removeTextAnnotation(annotation.id);
        }
      }

      textarea.addEventListener('blur', commitText);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          commitText();
        }
        if (e.key === 'Escape') {
          committed = true;
          if (!annotation.text) {
            el.remove();
          } else {
            createTextElement(annotation, false);
          }
        }
        e.stopPropagation();
      });
    } else {
      // Show static text (draggable)
      el.innerHTML = annotation.text.replace(/\n/g, '<br>');
      el.draggable = false; // We'll handle drag manually

      // Double-click to edit
      el.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        createTextElement(annotation, true);
      });

      // Drag to move
      let isDragging = false;
      let dragStartX, dragStartY, origX, origY;

      el.addEventListener('mousedown', (e) => {
        if (currentTool !== 'text') return;
        e.stopPropagation();
        isDragging = true;
        dragStartX = e.clientX;
        dragStartY = e.clientY;
        origX = annotation.x;
        origY = annotation.y;
        el.style.cursor = 'grabbing';
        el.classList.add('dragging');
        // Attach drag listeners only for the duration of this drag so they
        // don't accumulate on document across re-renders/captures.
        document.addEventListener('mousemove', onDragMove);
        document.addEventListener('mouseup', onDragEnd);
      });

      function onDragMove(e) {
        if (!isDragging) return;
        const deltaX = (e.clientX - dragStartX) / zoomLevel;
        const deltaY = (e.clientY - dragStartY) / zoomLevel;

        // Constrain to canvas bounds
        const newX = Math.max(0, Math.min(canvas.width - 20, origX + deltaX));
        const newY = Math.max(0, Math.min(canvas.height - 20, origY + deltaY));

        annotation.x = newX;
        annotation.y = newY;
        el.style.left = (newX * zoomLevel) + 'px';
        el.style.top = (newY * zoomLevel) + 'px';
      }

      function onDragEnd() {
        // Always detach, even if a drag never actually started, so no stale
        // document listeners survive this element.
        document.removeEventListener('mousemove', onDragMove);
        document.removeEventListener('mouseup', onDragEnd);
        if (!isDragging) return;
        isDragging = false;
        el.style.cursor = 'move';
        el.classList.remove('dragging');
      }

      // Delete with Delete key when focused
      el.tabIndex = 0;
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          removeTextAnnotation(annotation.id);
        }
        e.stopPropagation();
      });

      // Select this annotation when focused or clicked
      el.addEventListener('focus', () => {
        selectTextAnnotation(annotation);
      });
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectTextAnnotation(annotation);
        el.focus();
      });

      wrapper.appendChild(el);
    }
  }

  /**
   * Remove a text annotation
   */
  function removeTextAnnotation(id) {
    textAnnotations = textAnnotations.filter(a => a.id !== id);
    const wrapper = editorEl.querySelector('.annotatepro-editor-canvas-wrapper');
    const el = wrapper?.querySelector(`[data-text-id="${id}"]`);
    if (el) el.remove();
    // Clear selection if this was selected
    if (selectedTextAnnotation && selectedTextAnnotation.id === id) {
      selectedTextAnnotation = null;
    }
  }

  /**
   * Update the DOM element color for a text annotation
   */
  function updateTextAnnotationColor(annotation) {
    const wrapper = editorEl.querySelector('.annotatepro-editor-canvas-wrapper');
    const el = wrapper?.querySelector(`[data-text-id="${annotation.id}"]`);
    if (el) {
      el.style.color = annotation.color;
      // Also update textarea if editing
      const textarea = el.querySelector('textarea');
      if (textarea) {
        textarea.style.color = annotation.color;
      }
    }
  }

  /**
   * Select a text annotation (highlight in ribbon)
   */
  function selectTextAnnotation(annotation) {
    selectedTextAnnotation = annotation;
    // Update color picker to match selected annotation's color
    if (annotation) {
      currentColor = annotation.color;
      editorEl.querySelectorAll('[data-color]').forEach(b => {
        b.classList.toggle('active', b.dataset.color === currentColor);
      });
    }
  }

  /**
   * Clear text annotation selection
   */
  function clearTextSelection() {
    selectedTextAnnotation = null;
  }

  /**
   * Re-render all text annotations (after zoom change)
   */
  function rerenderTextAnnotations() {
    textAnnotations.forEach(ann => createTextElement(ann, false));
  }

  /**
   * Flatten text annotations to canvas (for export)
   */
  function flattenTextToCanvas() {
    textAnnotations.forEach(ann => {
      ctx.font = `${ann.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillStyle = ann.color;

      const lines = ann.text.split('\n');
      const lineHeight = ann.fontSize * 1.2;
      lines.forEach((line, index) => {
        ctx.fillText(line, ann.x, ann.y + ann.fontSize + (index * lineHeight));
      });
    });
  }

  /**
   * Save current canvas state to history
   */
  function saveToHistory() {
    // Remove any redo states
    if (historyIndex < history.length - 1) {
      history = history.slice(0, historyIndex + 1);
    }

    // Save current state as ImageData along with dimensions
    const state = {
      imageData: ctx.getImageData(0, 0, canvas.width, canvas.height),
      width: canvas.width,
      height: canvas.height
    };
    history.push(state);
    historyIndex++;

    // Limit history size
    if (history.length > MAX_HISTORY) {
      history.shift();
      historyIndex--;
    }
  }

  /**
   * Restore canvas from current history state (synchronous)
   */
  function restoreFromHistory() {
    if (historyIndex >= 0 && history[historyIndex]) {
      const state = history[historyIndex];
      // Restore canvas dimensions if they changed (e.g., after crop)
      if (canvas.width !== state.width || canvas.height !== state.height) {
        canvas.width = state.width;
        canvas.height = state.height;
      }
      ctx.putImageData(state.imageData, 0, 0);
    }
  }

  /**
   * Undo last action
   */
  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      restoreFromHistory();
      updateZoom();
    }
  }

  /**
   * Redo last undone action
   */
  function redo() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      restoreFromHistory();
      updateZoom();
    }
  }

  /**
   * Update zoom display and canvas scale
   */
  function updateZoom() {
    const container = editorEl.querySelector('.annotatepro-editor-canvas-container');
    const zoomDisplay = editorEl.querySelector('[data-zoom-display]');
    const dpr = window.devicePixelRatio || 1;

    // Set actual display size (not transform) so scrolling works properly
    if (canvas) {
      const displayWidth = canvas.width * zoomLevel;
      const displayHeight = canvas.height * zoomLevel;
      canvas.style.width = displayWidth + 'px';
      canvas.style.height = displayHeight + 'px';

      // Check if canvas is larger than container - switch to scrollable mode
      if (container) {
        const containerRect = container.getBoundingClientRect();
        const isLarge = displayWidth > containerRect.width - 40 || displayHeight > containerRect.height - 40;
        container.classList.toggle('zoomed-large', isLarge);
      }
    }

    if (zoomDisplay) {
      // Show zoom relative to actual screen size (100% = 1/dpr)
      const displayPercent = Math.round(zoomLevel * dpr * 100);
      zoomDisplay.textContent = `${displayPercent}%`;
    }

    // Re-render text annotations at new zoom level
    rerenderTextAnnotations();
  }

  /**
   * Zoom in
   */
  function zoomIn() {
    if (zoomLevel < ZOOM_MAX) {
      zoomLevel = Math.min(ZOOM_MAX, zoomLevel + ZOOM_STEP);
      updateZoom();
    }
  }

  /**
   * Zoom out
   */
  function zoomOut() {
    if (zoomLevel > ZOOM_MIN) {
      zoomLevel = Math.max(ZOOM_MIN, zoomLevel - ZOOM_STEP);
      updateZoom();
    }
  }

  /**
   * Reset zoom to actual screen size (accounting for DPR)
   */
  function zoomReset() {
    const dpr = window.devicePixelRatio || 1;
    zoomLevel = 1 / dpr;
    updateZoom();
  }

  /**
   * Show crop overlay on canvas
   */
  function showCropOverlay() {
    const wrapper = editorEl.querySelector('.annotatepro-editor-canvas-wrapper');

    cropOverlay = document.createElement('div');
    cropOverlay.className = 'annotatepro-crop-overlay';
    cropOverlay.innerHTML = `
      <div class="annotatepro-crop-selection"></div>
      <div class="annotatepro-crop-dimensions"></div>
    `;
    wrapper.appendChild(cropOverlay);
  }

  /**
   * Update crop selection overlay position and size
   */
  function updateCropOverlay(currentX, currentY) {
    if (!cropOverlay) return;

    const selection = cropOverlay.querySelector('.annotatepro-crop-selection');
    const dimensions = cropOverlay.querySelector('.annotatepro-crop-dimensions');
    const rect = canvas.getBoundingClientRect();

    // Calculate selection bounds in canvas coordinates
    const left = Math.min(cropStartX, currentX);
    const top = Math.min(cropStartY, currentY);
    const width = Math.abs(currentX - cropStartX);
    const height = Math.abs(currentY - cropStartY);

    // Convert to display coordinates (account for zoom)
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;

    selection.style.left = (left * scaleX) + 'px';
    selection.style.top = (top * scaleY) + 'px';
    selection.style.width = (width * scaleX) + 'px';
    selection.style.height = (height * scaleY) + 'px';

    dimensions.style.left = ((left + width) * scaleX + 8) + 'px';
    dimensions.style.top = ((top + height / 2) * scaleY) + 'px';
    dimensions.textContent = `${Math.round(width)} x ${Math.round(height)}`;
  }

  /**
   * Document mouseup handler for crop (catches releases outside canvas)
   */
  function onDocumentMouseUpForCrop(e) {
    if (!isCropping) return;
    document.removeEventListener('mouseup', onDocumentMouseUpForCrop);

    // Get coordinates - if outside canvas, clamp to canvas bounds
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;

    let endX = (e.clientX - rect.left) * scaleX;
    let endY = (e.clientY - rect.top) * scaleY;

    // Clamp to canvas bounds
    endX = Math.max(0, Math.min(canvas.width, endX));
    endY = Math.max(0, Math.min(canvas.height, endY));

    finishCrop(endX, endY);
  }

  /**
   * Finish crop operation
   */
  function finishCrop(endX, endY) {
    isCropping = false;
    isDrawing = false;

    // Remove document listener if still attached
    document.removeEventListener('mouseup', onDocumentMouseUpForCrop);

    // Remove overlay
    if (cropOverlay) {
      cropOverlay.remove();
      cropOverlay = null;
    }

    // Calculate crop bounds
    const left = Math.round(Math.min(cropStartX, endX));
    const top = Math.round(Math.min(cropStartY, endY));
    const width = Math.round(Math.abs(endX - cropStartX));
    const height = Math.round(Math.abs(endY - cropStartY));

    // Minimum crop size
    if (width < 10 || height < 10) {
      showToast('Selection Too Small To Crop', 'error');
      return;
    }

    // Clamp to canvas bounds
    const cropX = Math.max(0, left);
    const cropY = Math.max(0, top);
    const cropW = Math.min(width, canvas.width - cropX);
    const cropH = Math.min(height, canvas.height - cropY);

    // Get the cropped image data
    const imageData = ctx.getImageData(cropX, cropY, cropW, cropH);

    // Resize canvas
    canvas.width = cropW;
    canvas.height = cropH;

    // Put the cropped image data
    ctx.putImageData(imageData, 0, 0);

    // Save to history
    saveToHistory();

    // Reset zoom after crop
    zoomReset();

    showToast('Image Cropped', 'success');
  }

  /**
   * Cancel crop operation
   */
  function cancelCrop() {
    isCropping = false;
    document.removeEventListener('mouseup', onDocumentMouseUpForCrop);
    if (cropOverlay) {
      cropOverlay.remove();
      cropOverlay = null;
    }
  }

  /**
   * Copy canvas to clipboard
   */
  // ---- Shared output helpers ----
  // These operate on any source canvas so both the editor and the inline
  // area-capture quick actions reuse the exact same copy/PNG/PDF logic.
  // They perform no flatten/restore and no toast — callers own that.

  async function copyCanvasToClipboard(srcCanvas) {
    const blob = await new Promise(resolve => srcCanvas.toBlob(resolve, 'image/png'));
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': blob })
    ]);
  }

  function downloadCanvasPng(srcCanvas) {
    const dataUrl = srcCanvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `screenshot-${Date.now()}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Build an offscreen canvas from an image data URL (for inline actions that
   * never open the editor and so have no editor canvas to read from).
   */
  async function canvasFromDataUrl(dataUrl) {
    const img = await loadImage(dataUrl);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || img.width;
    c.height = img.naturalHeight || img.height;
    c.getContext('2d').drawImage(img, 0, 0);
    return c;
  }

  /**
   * Copy the editor canvas to the clipboard (flattens annotations first).
   */
  async function copyToClipboard() {
    // Flatten text annotations to canvas before copying
    flattenTextToCanvas();
    try {
      await copyCanvasToClipboard(canvas);
      showToast('Copied To Clipboard!', 'success');
    } catch (error) {
      console.error('AnnotatePro: Failed to copy to clipboard', error);
      showToast('Failed To Copy To Clipboard', 'error');
    } finally {
      // Restore canvas state (remove flattened text)
      restoreFromHistory();
    }
  }

  /**
   * Download screenshot as PNG
   */
  function downloadScreenshot() {
    // Flatten text annotations to canvas before downloading
    flattenTextToCanvas();
    try {
      downloadCanvasPng(canvas);
      showToast('Screenshot Downloaded!', 'success');
    } finally {
      // Restore canvas state (remove flattened text)
      restoreFromHistory();
    }
  }

  /**
   * Export the editor canvas as PDF (flattens annotations first).
   */
  function exportAsPdf() {
    // Flatten text annotations to canvas before exporting
    flattenTextToCanvas();
    try {
      exportCanvasAsPdf(canvas);
      showToast('PDF Exported!', 'success');
    } catch (error) {
      console.error('AnnotatePro: Failed to export PDF', error);
      showToast('Failed To Export PDF', 'error');
    } finally {
      // Restore canvas state (remove flattened text)
      restoreFromHistory();
    }
  }

  /**
   * Export any source canvas as a single-page PDF and download it.
   * Throws on failure; callers handle toasts.
   */
  function exportCanvasAsPdf(srcCanvas) {
      // Get image as JPEG for smaller PDF size
      const jpegDataUrl = srcCanvas.toDataURL('image/jpeg', 0.92);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBinary = atob(jpegBase64);

      // Image dimensions (in points, 72 points = 1 inch)
      // Scale to fit on a page while maintaining aspect ratio
      const maxWidth = 595.28; // A4 width in points
      const maxHeight = 841.89; // A4 height in points
      const margin = 36; // 0.5 inch margin

      const availableWidth = maxWidth - (margin * 2);
      const availableHeight = maxHeight - (margin * 2);

      let imgWidth = srcCanvas.width;
      let imgHeight = srcCanvas.height;

      // Scale to fit available space
      const scaleX = availableWidth / imgWidth;
      const scaleY = availableHeight / imgHeight;
      const scale = Math.min(scaleX, scaleY, 1); // Don't upscale

      imgWidth = imgWidth * scale;
      imgHeight = imgHeight * scale;

      // Center the image on the page
      const xOffset = margin + (availableWidth - imgWidth) / 2;
      const yOffset = margin + (availableHeight - imgHeight) / 2;

      // Build PDF
      const pdf = buildPdf(jpegBinary, imgWidth, imgHeight, xOffset, yOffset, maxWidth, maxHeight);

      // Download
      const blob = new Blob([pdf], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.download = `screenshot-${Date.now()}.pdf`;
      link.href = url;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
  }

  /**
   * Build a minimal PDF with an embedded JPEG image
   */
  function buildPdf(jpegBinary, imgWidth, imgHeight, x, y, pageWidth, pageHeight) {
    // Convert JPEG binary string to Uint8Array
    const jpegData = new Uint8Array(jpegBinary.length);
    for (let i = 0; i < jpegBinary.length; i++) {
      jpegData[i] = jpegBinary.charCodeAt(i);
    }

    // PDF objects (text parts)
    const header = '%PDF-1.4\n%\xD0\xD4\xC5\xD8\n';

    const obj1 = '1 0 obj\n<<\n/Type /Catalog\n/Pages 2 0 R\n>>\nendobj\n';

    const obj2 = '2 0 obj\n<<\n/Type /Pages\n/Kids [3 0 R]\n/Count 1\n>>\nendobj\n';

    const obj3 = `3 0 obj\n<<\n/Type /Page\n/Parent 2 0 R\n/MediaBox [0 0 ${pageWidth.toFixed(2)} ${pageHeight.toFixed(2)}]\n/Contents 4 0 R\n/Resources <<\n/XObject << /Im1 5 0 R >>\n>>\n>>\nendobj\n`;

    const contentStream = `q\n${imgWidth.toFixed(2)} 0 0 ${imgHeight.toFixed(2)} ${x.toFixed(2)} ${(pageHeight - y - imgHeight).toFixed(2)} cm\n/Im1 Do\nQ`;
    const obj4 = `4 0 obj\n<<\n/Length ${contentStream.length}\n>>\nstream\n${contentStream}\nendstream\nendobj\n`;

    const imageHeader = `5 0 obj\n<<\n/Type /XObject\n/Subtype /Image\n/Width ${canvas.width}\n/Height ${canvas.height}\n/ColorSpace /DeviceRGB\n/BitsPerComponent 8\n/Filter /DCTDecode\n/Length ${jpegData.length}\n>>\nstream\n`;
    const imageFooter = '\nendstream\nendobj\n';

    // Calculate offsets
    const offsets = [];
    let currentOffset = header.length;

    offsets.push(currentOffset); // obj1
    currentOffset += obj1.length;

    offsets.push(currentOffset); // obj2
    currentOffset += obj2.length;

    offsets.push(currentOffset); // obj3
    currentOffset += obj3.length;

    offsets.push(currentOffset); // obj4
    currentOffset += obj4.length;

    offsets.push(currentOffset); // obj5
    currentOffset += imageHeader.length + jpegData.length + imageFooter.length;

    const xrefOffset = currentOffset;

    // Build xref table
    let xref = `xref\n0 6\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += off.toString().padStart(10, '0') + ' 00000 n \n';
    }

    const trailer = `trailer\n<<\n/Size 6\n/Root 1 0 R\n>>\nstartxref\n${xrefOffset}\n%%EOF`;

    // Combine all parts
    const textEncoder = new TextEncoder();
    const headerBytes = textEncoder.encode(header);
    const obj1Bytes = textEncoder.encode(obj1);
    const obj2Bytes = textEncoder.encode(obj2);
    const obj3Bytes = textEncoder.encode(obj3);
    const obj4Bytes = textEncoder.encode(obj4);
    const imageHeaderBytes = textEncoder.encode(imageHeader);
    const imageFooterBytes = textEncoder.encode(imageFooter);
    const xrefBytes = textEncoder.encode(xref);
    const trailerBytes = textEncoder.encode(trailer);

    // Calculate total size
    const totalSize = headerBytes.length + obj1Bytes.length + obj2Bytes.length +
                      obj3Bytes.length + obj4Bytes.length + imageHeaderBytes.length +
                      jpegData.length + imageFooterBytes.length + xrefBytes.length +
                      trailerBytes.length;

    // Create final PDF buffer
    const pdfBuffer = new Uint8Array(totalSize);
    let pos = 0;

    pdfBuffer.set(headerBytes, pos); pos += headerBytes.length;
    pdfBuffer.set(obj1Bytes, pos); pos += obj1Bytes.length;
    pdfBuffer.set(obj2Bytes, pos); pos += obj2Bytes.length;
    pdfBuffer.set(obj3Bytes, pos); pos += obj3Bytes.length;
    pdfBuffer.set(obj4Bytes, pos); pos += obj4Bytes.length;
    pdfBuffer.set(imageHeaderBytes, pos); pos += imageHeaderBytes.length;
    pdfBuffer.set(jpegData, pos); pos += jpegData.length;
    pdfBuffer.set(imageFooterBytes, pos); pos += imageFooterBytes.length;
    pdfBuffer.set(xrefBytes, pos); pos += xrefBytes.length;
    pdfBuffer.set(trailerBytes, pos);

    return pdfBuffer;
  }

  /**
   * Close the editor
   */
  function closeEditor() {
    if (editorEl) {
      document.removeEventListener('keydown', onEditorKeyDown);
      document.removeEventListener('keyup', onEditorKeyUp);
      document.body.classList.remove('annotatepro-editor-open');
      editorEl.remove();
      editorEl = null;
      canvas = null;
      ctx = null;
      originalImage = null;
      history = [];
      historyIndex = -1;
      textAnnotations = [];
    }
  }

  /**
   * Keyboard event handler
   */
  function onEditorKeyDown(e) {
    if (!editorEl) return;

    // Escape and shape-delete stay fixed (not user-configurable).
    if (e.key === 'Escape') {
      // Cancel crop if in progress
      if (isCropping) {
        cancelCrop();
        return;
      }
      closeEditor();
      return;
    }

    // Bindings for every other editor action come from the shared shortcut map
    // (AnnotateProShortcuts, backed by settings.shortcuts and edited in the
    // dashboard). Falls back to hardcoded defaults if the module is missing.
    const sc = window.AnnotateProShortcuts;
    const hit = (id) => sc && sc.matches(id, e);

    if (hit('editorUndo')) {
      e.preventDefault();
      undo();
      return;
    }
    // Mod+Shift+Z remains an always-on alias for redo alongside the configurable binding.
    if (hit('editorRedo') || (sc && sc.bindingMatches('Mod+Shift+Z', e))) {
      e.preventDefault();
      redo();
      return;
    }
    if (hit('editorCopy') && !window.getSelection().toString()) {
      e.preventDefault();
      copyToClipboard();
      return;
    }

    // Tool shortcuts.
    const toolActions = {
      editorPen: 'pen', editorRect: 'rect', editorEllipse: 'ellipse',
      editorArrow: 'arrow', editorText: 'text', editorCrop: 'crop', editorPan: 'pan'
    };
    for (const [id, tool] of Object.entries(toolActions)) {
      if (hit(id)) {
        currentTool = tool;
        editorEl.querySelectorAll('[data-tool]').forEach(b => {
          b.classList.toggle('active', b.dataset.tool === currentTool);
        });
        updateCanvasCursor();
        return;
      }
    }

    // Hold-to-pan.
    if (hit('editorPanHold') && !spaceHeld) {
      e.preventDefault();
      spaceHeld = true;
      previousTool = currentTool;
      currentTool = 'pan';
      editorEl.querySelectorAll('[data-tool]').forEach(b => {
        b.classList.toggle('active', b.dataset.tool === currentTool);
      });
      updateCanvasCursor();
      return;
    }

    // Zoom shortcuts.
    if (hit('editorZoomIn')) {
      e.preventDefault();
      zoomIn();
    } else if (hit('editorZoomOut')) {
      e.preventDefault();
      zoomOut();
    } else if (hit('editorZoomReset')) {
      e.preventDefault();
      zoomReset();
    }
  }

  /**
   * Keyboard key up handler
   */
  function onEditorKeyUp(e) {
    if (!editorEl) return;

    // Release hold-to-pan key - restore previous tool
    const sc = window.AnnotateProShortcuts;
    const panHoldReleased = sc ? sc.matches('editorPanHold', e) : e.key === ' ';
    if (panHoldReleased && spaceHeld) {
      e.preventDefault();
      spaceHeld = false;
      // Stop any panning in progress and prevent drawing from starting
      isPanning = false;
      isDrawing = false;
      if (previousTool) {
        currentTool = previousTool;
        previousTool = null;
        editorEl.querySelectorAll('[data-tool]').forEach(b => {
          b.classList.toggle('active', b.dataset.tool === currentTool);
        });
        updateCanvasCursor();
      }
    }
  }

  /**
   * Update canvas cursor based on current tool
   */
  function updateCanvasCursor() {
    if (!canvas) return;
    switch (currentTool) {
      case 'pan':
        canvas.style.cursor = 'grab';
        break;
      case 'text':
        canvas.style.cursor = 'text';
        break;
      case 'crop':
        canvas.style.cursor = 'crosshair';
        break;
      default:
        canvas.style.cursor = 'crosshair';
    }
  }

  /**
   * Show toast notification
   */
  function showToast(message, type = 'info') {
    const existing = document.querySelector('.annotatepro-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `annotatepro-toast ${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => toast.remove(), 3000);
  }

  /**
   * Listen for screenshot commands
   */
  browser.runtime.onMessage.addListener((message) => {
    switch (message.type) {
      case 'COMMAND_CAPTURE_AREA':
        startAreaSelection();
        break;

      case 'COMMAND_CAPTURE_VISIBLE':
        captureVisibleArea();
        break;

      case 'COMMAND_CAPTURE_VISIBLE_TIMER':
        captureVisibleWithTimer();
        break;

      case 'COMMAND_CAPTURE_FULL_PAGE':
        captureWholePage();
        break;

      case 'COMMAND_CAPTURE_ELEMENT':
        if (message.annotationId) {
          const element = document.querySelector(`[data-annotatepro-id="${message.annotationId}"]`);
          if (element) {
            captureElement(element);
          }
        }
        break;
    }
  });

  // Expose functions for other scripts
  window.annotateProScreenshot = {
    startAreaSelection,
    captureVisibleArea,
    captureVisibleWithTimer,
    captureWholePage,
    captureElement
  };

  console.log('AnnotatePro: Screenshot Editor Initialized');
})();
