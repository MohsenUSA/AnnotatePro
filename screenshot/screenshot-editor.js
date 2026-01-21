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

      // Remove overlay
      overlay.remove();

      // Minimum selection size
      if (width < 10 || height < 10) {
        showToast('Selection too small', 'error');
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
          openEditor(croppedDataUrl);
        }
      } catch (error) {
        console.error('AnnotatePro: Screenshot capture failed', error);
        showToast('Failed to capture screenshot', 'error');
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
      showToast('Failed to capture visible area', 'error');
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
      showToast('Failed to capture element', 'error');
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
      showToast('Page too large for full capture. Try visible area instead.', 'error');
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
      showToast('Failed to capture whole page', 'error');
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
        <kbd>Ctrl+C</kbd> Copy
      </div>
    `;

    document.body.appendChild(editorEl);

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
      btn.addEventListener('click', () => {
        currentTool = btn.dataset.tool;
        editorEl.querySelectorAll('[data-tool]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
    });

    // Color buttons
    editorEl.querySelectorAll('[data-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        currentColor = btn.dataset.color;
        editorEl.querySelectorAll('[data-color]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
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

    // Canvas drawing events
    canvas.addEventListener('mousedown', onCanvasMouseDown);
    canvas.addEventListener('mousemove', onCanvasMouseMove);
    canvas.addEventListener('mouseup', onCanvasMouseUp);
    canvas.addEventListener('mouseleave', onCanvasMouseUp);

    // Keyboard shortcuts
    document.addEventListener('keydown', onEditorKeyDown);
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
    const coords = getCanvasCoords(e);
    startX = coords.x;
    startY = coords.y;
    lastX = coords.x;
    lastY = coords.y;
    isDrawing = true;

    if (currentTool === 'text') {
      isDrawing = false;
      showTextInput(coords.x, coords.y);
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
   * Show text input at position
   */
  function showTextInput(x, y) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = rect.width / canvas.width;
    const scaleY = rect.height / canvas.height;

    const input = document.createElement('textarea');
    input.className = 'annotatepro-text-input-overlay';
    input.style.left = (rect.left + x * scaleX) + 'px';
    input.style.top = (rect.top + y * scaleY) + 'px';
    input.style.color = currentColor;
    input.style.fontSize = (12 + strokeWidth * 2) + 'px';

    const wrapper = editorEl.querySelector('.annotatepro-editor-canvas-wrapper');
    wrapper.appendChild(input);
    input.focus();

    function commitText() {
      const text = input.value.trim();
      if (text) {
        ctx.font = `${12 + strokeWidth * 2}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
        ctx.fillStyle = currentColor;
        ctx.fillText(text, x, y + (12 + strokeWidth * 2));
        saveToHistory();
      }
      input.remove();
    }

    input.addEventListener('blur', commitText);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        commitText();
      }
      if (e.key === 'Escape') {
        input.remove();
      }
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

    // Save current state
    history.push(canvas.toDataURL());
    historyIndex++;

    // Limit history size
    if (history.length > MAX_HISTORY) {
      history.shift();
      historyIndex--;
    }
  }

  /**
   * Restore canvas from current history state
   */
  function restoreFromHistory() {
    if (historyIndex >= 0 && history[historyIndex]) {
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
      img.src = history[historyIndex];
    }
  }

  /**
   * Undo last action
   */
  function undo() {
    if (historyIndex > 0) {
      historyIndex--;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
      img.src = history[historyIndex];
    }
  }

  /**
   * Redo last undone action
   */
  function redo() {
    if (historyIndex < history.length - 1) {
      historyIndex++;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
      };
      img.src = history[historyIndex];
    }
  }

  /**
   * Copy canvas to clipboard
   */
  async function copyToClipboard() {
    try {
      const blob = await new Promise(resolve => {
        canvas.toBlob(resolve, 'image/png');
      });

      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': blob })
      ]);

      showToast('Copied to clipboard!', 'success');
    } catch (error) {
      console.error('AnnotatePro: Failed to copy to clipboard', error);
      showToast('Failed to copy to clipboard', 'error');
    }
  }

  /**
   * Download screenshot as PNG
   */
  function downloadScreenshot() {
    const dataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `screenshot-${Date.now()}.png`;
    link.href = dataUrl;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Screenshot downloaded!', 'success');
  }

  /**
   * Export screenshot as PDF
   */
  function exportAsPdf() {
    try {
      // Get image as JPEG for smaller PDF size
      const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.92);
      const jpegBase64 = jpegDataUrl.split(',')[1];
      const jpegBinary = atob(jpegBase64);

      // Image dimensions (in points, 72 points = 1 inch)
      // Scale to fit on a page while maintaining aspect ratio
      const maxWidth = 595.28; // A4 width in points
      const maxHeight = 841.89; // A4 height in points
      const margin = 36; // 0.5 inch margin

      const availableWidth = maxWidth - (margin * 2);
      const availableHeight = maxHeight - (margin * 2);

      let imgWidth = canvas.width;
      let imgHeight = canvas.height;

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

      showToast('PDF exported!', 'success');
    } catch (error) {
      console.error('AnnotatePro: Failed to export PDF', error);
      showToast('Failed to export PDF', 'error');
    }
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
      editorEl.remove();
      editorEl = null;
      canvas = null;
      ctx = null;
      originalImage = null;
      history = [];
      historyIndex = -1;
    }
  }

  /**
   * Keyboard event handler
   */
  function onEditorKeyDown(e) {
    if (!editorEl) return;

    if (e.key === 'Escape') {
      closeEditor();
      return;
    }

    if (e.ctrlKey || e.metaKey) {
      if (e.key === 'z') {
        e.preventDefault();
        undo();
      } else if (e.key === 'y' || (e.shiftKey && e.key === 'z')) {
        e.preventDefault();
        redo();
      } else if (e.key === 'c' && !window.getSelection().toString()) {
        e.preventDefault();
        copyToClipboard();
      }
    }

    // Tool shortcuts
    if (!e.ctrlKey && !e.metaKey && !e.altKey) {
      const toolMap = { p: 'pen', r: 'rect', e: 'ellipse', a: 'arrow', t: 'text' };
      if (toolMap[e.key]) {
        currentTool = toolMap[e.key];
        editorEl.querySelectorAll('[data-tool]').forEach(b => {
          b.classList.toggle('active', b.dataset.tool === currentTool);
        });
      }
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
    captureWholePage,
    captureElement
  };

  console.log('AnnotatePro: Screenshot editor initialized');
})();
