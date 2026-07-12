/**
 * AnnotatePro — shared keyboard-shortcut model.
 *
 * Loaded both as a content script (in every page, before content.js and
 * screenshot-editor.js) and via a <script> tag on the dashboard page. It owns:
 *   - DEFAULT_SHORTCUTS      canonical default binding per action
 *   - ACTIONS                ordered UI metadata (label / group / scope)
 *   - eventToBinding(e)      KeyboardEvent -> canonical binding string
 *   - bindingMatches(b, e)   does a binding string match this KeyboardEvent?
 *   - formatBinding(b)       pretty, platform-aware label for display
 *   - matches(id, e)         convenience: match the *live* binding for an action
 *
 * Bindings are canonical strings like "Alt+H", "Mod+Z", "1", "=", "Space".
 * Modifiers are ordered Ctrl, Alt, Shift, Meta (or the cross-platform token
 * "Mod" == Ctrl-or-Meta, used by the screenshot editor's undo/copy so they keep
 * working with both Ctrl (Win/Linux) and ⌘ (macOS)).
 *
 * The live binding map is read from browser.storage.local under
 * settings.shortcuts and refreshed automatically on change, so the in-page
 * keydown handlers never touch storage directly.
 */
(function () {
  'use strict';

  // Canonical default binding for every configurable action.
  const DEFAULT_SHORTCUTS = {
    // Page actions — mirrored by the manifest `commands` and rebound at runtime
    // via browser.commands.update(). Must include a Ctrl/Alt modifier.
    highlight: 'Alt+H',
    checkbox: 'Alt+C',
    toggleSidebar: 'Alt+S',
    captureArea: 'Alt+X',
    // The other three capture modes have no default key — assign in the dashboard.
    captureVisible: '',
    captureVisibleTimer: '',
    captureFullPage: '',

    // Highlight colors — applied to the active text selection, by color order.
    color1: '1',
    color2: '2',
    color3: '3',
    color4: '4',
    color5: '5',
    color6: '6',
    color7: '7',
    color8: '8',
    color9: '9',

    // Screenshot editor.
    editorPen: 'P',
    editorRect: 'R',
    editorEllipse: 'E',
    editorArrow: 'A',
    editorText: 'T',
    editorCrop: 'C',
    editorPan: 'H',
    editorPanHold: 'Space',
    editorUndo: 'Mod+Z',
    editorRedo: 'Mod+Y',
    editorCopy: 'Mod+C',
    editorZoomIn: '=',
    editorZoomOut: '-',
    editorZoomReset: '0'
  };

  // Ordered metadata driving the settings UI.
  //   scope:  conflict scope ('page' or 'editor'); duplicates within a scope conflict
  //   global: true => also a manifest command (must include a modifier)
  const ACTIONS = [
    { id: 'highlight', label: 'Highlight selection', group: 'Page actions', scope: 'page', global: true },
    { id: 'checkbox', label: 'Add checkbox', group: 'Page actions', scope: 'page', global: true },
    { id: 'toggleSidebar', label: 'Toggle sidebar', group: 'Page actions', scope: 'page', global: true },

    { id: 'captureArea', label: 'Screenshot: selected area', group: 'Screenshots', scope: 'page', global: true },
    { id: 'captureVisible', label: 'Screenshot: visible area', group: 'Screenshots', scope: 'page', global: true },
    { id: 'captureVisibleTimer', label: 'Screenshot: visible area (5s timer)', group: 'Screenshots', scope: 'page', global: true },
    { id: 'captureFullPage', label: 'Screenshot: whole page', group: 'Screenshots', scope: 'page', global: true },

    { id: 'color1', label: 'Highlight color 1', group: 'Highlight colors', scope: 'page' },
    { id: 'color2', label: 'Highlight color 2', group: 'Highlight colors', scope: 'page' },
    { id: 'color3', label: 'Highlight color 3', group: 'Highlight colors', scope: 'page' },
    { id: 'color4', label: 'Highlight color 4', group: 'Highlight colors', scope: 'page' },
    { id: 'color5', label: 'Highlight color 5', group: 'Highlight colors', scope: 'page' },
    { id: 'color6', label: 'Highlight color 6', group: 'Highlight colors', scope: 'page' },
    { id: 'color7', label: 'Highlight color 7', group: 'Highlight colors', scope: 'page' },
    { id: 'color8', label: 'Highlight color 8', group: 'Highlight colors', scope: 'page' },
    { id: 'color9', label: 'Highlight color 9', group: 'Highlight colors', scope: 'page' },

    { id: 'editorPen', label: 'Pen tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorRect', label: 'Rectangle tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorEllipse', label: 'Ellipse tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorArrow', label: 'Arrow tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorText', label: 'Text tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorCrop', label: 'Crop tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorPan', label: 'Pan tool', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorPanHold', label: 'Hold to pan', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorUndo', label: 'Undo', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorRedo', label: 'Redo', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorCopy', label: 'Copy to clipboard', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorZoomIn', label: 'Zoom in', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorZoomOut', label: 'Zoom out', group: 'Screenshot editor', scope: 'editor' },
    { id: 'editorZoomReset', label: 'Reset zoom', group: 'Screenshot editor', scope: 'editor' }
  ];

  // Shifted symbols collapse to their base key so "+"/"=" and "_"/"-" match
  // regardless of the Shift state — mirrors the editor's original behaviour.
  const SYMBOL_BASE = { '+': '=', '_': '-' };

  function normalizeKey(key) {
    if (key === ' ' || key === 'Spacebar') return 'Space';
    if (key.length === 1) {
      if (SYMBOL_BASE[key]) return SYMBOL_BASE[key];
      return /[a-z]/i.test(key) ? key.toUpperCase() : key;
    }
    return key; // named keys: Escape, Enter, ArrowUp, Delete, ...
  }

  /**
   * Turn a KeyboardEvent into a canonical binding string.
   * Shift is only recorded alongside another modifier, so bare letters/symbols
   * are Shift-insensitive (H == Shift+H, + == =).
   */
  function eventToBinding(e) {
    const parts = [];
    if (e.ctrlKey) parts.push('Ctrl');
    if (e.altKey) parts.push('Alt');
    if (e.metaKey) parts.push('Meta');
    const hasModifier = e.ctrlKey || e.altKey || e.metaKey;
    if (e.shiftKey && hasModifier) parts.push('Shift');
    parts.push(normalizeKey(e.key));
    return parts.join('+');
  }

  /** Does binding string `binding` describe this KeyboardEvent? */
  function bindingMatches(binding, e) {
    if (!binding) return false;
    const tokens = binding.split('+');
    const key = tokens.pop();
    const mods = new Set(tokens);

    if (mods.has('Alt') !== e.altKey) return false;

    if (mods.has('Mod')) {
      if (!(e.ctrlKey || e.metaKey)) return false;
    } else {
      if (mods.has('Ctrl') !== e.ctrlKey) return false;
      if (mods.has('Meta') !== e.metaKey) return false;
    }

    // Shift is only meaningful when another modifier is present (see eventToBinding).
    if (e.ctrlKey || e.altKey || e.metaKey) {
      if (mods.has('Shift') !== e.shiftKey) return false;
    }

    return normalizeKey(e.key) === normalizeKey(key);
  }

  const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');

  const MAC_GLYPHS = { Mod: '⌘', Meta: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };

  /** Human-readable label for a binding, e.g. "Mod+Z" -> "⌘Z" / "Ctrl+Z". */
  function formatBinding(binding) {
    if (!binding) return '—';
    return binding
      .split('+')
      .map((t) => {
        if (IS_MAC && MAC_GLYPHS[t]) return MAC_GLYPHS[t];
        if (t === 'Mod') return 'Ctrl';
        if (t === 'Space') return 'Space';
        return t;
      })
      .join(IS_MAC ? '' : '+');
  }

  // ---- live binding map (backed by storage) ----------------------------------

  let liveMap = { ...DEFAULT_SHORTCUTS };

  function applyStored(settings) {
    liveMap = { ...DEFAULT_SHORTCUTS, ...((settings && settings.shortcuts) || {}) };
  }

  async function reload() {
    try {
      if (typeof browser === 'undefined' || !browser.storage || !browser.storage.local) return;
      const out = await browser.storage.local.get('settings');
      applyStored(out.settings);
    } catch (_) {
      /* keep defaults */
    }
  }

  if (typeof browser !== 'undefined' && browser.storage) {
    reload();
    if (browser.storage.onChanged) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === 'local' && changes.settings) {
          applyStored(changes.settings.newValue);
        }
      });
    }
  }

  const api = {
    DEFAULT_SHORTCUTS,
    ACTIONS,
    eventToBinding,
    bindingMatches,
    formatBinding,
    reload,
    get: (id) => liveMap[id],
    matches: (id, e) => bindingMatches(liveMap[id], e)
  };

  (typeof window !== 'undefined' ? window : self).AnnotateProShortcuts = api;
})();
