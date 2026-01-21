/**
 * IndexedDB Helper for AnnotatePro
 * Background-owned singleton for all database operations
 */

const DB_NAME = 'annotatepro-db';
const DB_VERSION = 2;

// Default colors (seeded on install/upgrade)
const DEFAULT_COLORS = [
  { id: 'default-action', name: 'Action', color: '#FFEB3B', isDefault: true, sortOrder: 0 },
  { id: 'default-question', name: 'Question', color: '#64B5F6', isDefault: true, sortOrder: 1 },
  { id: 'default-risk', name: 'Risk', color: '#EF5350', isDefault: true, sortOrder: 2 },
  { id: 'default-reference', name: 'Reference', color: '#81C784', isDefault: true, sortOrder: 3 },
];

// Map old intent values to new colorIds
const INTENT_TO_COLOR_ID = {
  'ACTION': 'default-action',
  'QUESTION': 'default-question',
  'RISK': 'default-risk',
  'REFERENCE': 'default-reference',
  'CUSTOM': 'default-action',
  'DEFAULT': 'default-action'
};

class IndexedDBHelper {
  constructor() {
    this.db = null;
    this.openPromise = null;
    this.needsMigration = false;
  }

  async open() {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;
        const transaction = event.target.transaction;

        if (oldVersion < 1) {
          // Annotations store
          const annotations = db.createObjectStore('annotations', { keyPath: 'id' });
          annotations.createIndex('by_page', 'pageUrl', { unique: false });
          annotations.createIndex('by_page_element', ['pageUrl', 'elementFingerprint'], { unique: true });
          annotations.createIndex('by_type', 'annotationType', { unique: false });
          annotations.createIndex('by_updated', 'updatedAt', { unique: false });

          // Groups store
          const groups = db.createObjectStore('groups', { keyPath: 'id' });
          groups.createIndex('by_name', 'name', { unique: true });
        }

        if (oldVersion < 2) {
          // v1 → v2: Custom Named Colors

          // 1. Create colors store
          const colorStore = db.createObjectStore('colors', { keyPath: 'id' });
          colorStore.createIndex('by_name', 'name', { unique: false });
          colorStore.createIndex('by_sort', 'sortOrder', { unique: false });

          // 2. Seed default colors
          DEFAULT_COLORS.forEach(c => {
            colorStore.add({
              ...c,
              usageCount: 0,
              createdAt: Date.now()
            });
          });

          // 3. Add colorId index to annotations (if store exists)
          if (oldVersion >= 1) {
            const annotationStore = transaction.objectStore('annotations');
            annotationStore.createIndex('by_color', 'colorId', { unique: false });
            // Flag that we need to migrate existing annotations
            this.needsMigration = true;
          }
        }
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.db.onerror = (event) => {
          console.error('IndexedDB error:', event.target.error);
        };
        resolve(this.db);
      };

      request.onerror = () => {
        this.openPromise = null;
        reject(new Error(`Failed to open database: ${request.error?.message}`));
      };
    });

    const db = await this.openPromise;

    // Run post-upgrade migration if needed
    if (this.needsMigration) {
      await this.migrateIntentToColorId();
      this.needsMigration = false;
    }

    return db;
  }

  /**
   * Migrate existing annotations from intent/color to colorId
   */
  async migrateIntentToColorId() {
    console.log('AnnotatePro: Migrating annotations to colorId...');
    const annotations = await this.getAllAnnotations();
    let migrated = 0;

    for (const annotation of annotations) {
      // Skip if already has colorId
      if (annotation.colorId) continue;

      // Determine colorId from intent
      const intent = annotation.intent || 'DEFAULT';
      const colorId = INTENT_TO_COLOR_ID[intent] || 'default-action';

      // Update annotation
      await new Promise((resolve, reject) => {
        const store = this.getStore('annotations', 'readwrite');
        const updated = {
          ...annotation,
          colorId,
          updatedAt: Date.now()
        };
        // Remove old fields
        delete updated.intent;

        const request = store.put(updated);
        request.onsuccess = () => {
          migrated++;
          resolve();
        };
        request.onerror = () => reject(request.error);
      });
    }

    console.log(`AnnotatePro: Migrated ${migrated} annotations to colorId`);

    // Update usage counts
    await this.recalculateColorUsageCounts();
  }

  /**
   * Recalculate usage counts for all colors
   */
  async recalculateColorUsageCounts() {
    const annotations = await this.getAllAnnotations();
    const colors = await this.getAllColors();

    // Count usage per color
    const usageCounts = {};
    for (const a of annotations) {
      if (a.colorId) {
        usageCounts[a.colorId] = (usageCounts[a.colorId] || 0) + 1;
      }
    }

    // Update each color
    for (const color of colors) {
      const count = usageCounts[color.id] || 0;
      if (color.usageCount !== count) {
        await this.updateColor(color.id, { usageCount: count });
      }
    }
  }

  /**
   * Get a transaction object store
   */
  getStore(storeName, mode = 'readonly') {
    if (!this.db) throw new Error('Database not open');
    return this.db.transaction(storeName, mode).objectStore(storeName);
  }

  /**
   * Generate a UUID for new records
   */
  generateId() {
    return crypto.randomUUID();
  }

  // ============ Annotation Operations ============

  async addAnnotation(annotation) {
    await this.open();

    const record = {
      ...annotation,
      id: annotation.id || this.generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readwrite');
      const request = store.add(record);
      request.onsuccess = () => resolve(record);
      request.onerror = () => reject(new Error(`Failed to add annotation: ${request.error?.message}`));
    });
  }

  async updateAnnotation(id, patch) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readwrite');
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        if (!getRequest.result) {
          reject(new Error(`Annotation not found: ${id}`));
          return;
        }

        const updated = {
          ...getRequest.result,
          ...patch,
          updatedAt: Date.now()
        };

        const putRequest = store.put(updated);
        putRequest.onsuccess = () => resolve(updated);
        putRequest.onerror = () => reject(new Error(`Failed to update annotation: ${putRequest.error?.message}`));
      };

      getRequest.onerror = () => reject(new Error(`Failed to get annotation: ${getRequest.error?.message}`));
    });
  }

  async deleteAnnotation(id) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve({ success: true, id });
      request.onerror = () => reject(new Error(`Failed to delete annotation: ${request.error?.message}`));
    });
  }

  async getAnnotation(id) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readonly');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error(`Failed to get annotation: ${request.error?.message}`));
    });
  }

  async getAnnotationsByPage(pageUrl) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readonly');
      const index = store.index('by_page');
      const request = index.getAll(pageUrl);
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error(`Failed to get annotations: ${request.error?.message}`));
    });
  }

  async getAllAnnotations() {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readonly');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error(`Failed to get all annotations: ${request.error?.message}`));
    });
  }

  async getAnnotationCount() {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readonly');
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error(`Failed to count annotations: ${request.error?.message}`));
    });
  }

  async clearPageAnnotations(pageUrl) {
    await this.open();
    const annotations = await this.getAnnotationsByPage(pageUrl);

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readwrite');
      let deleted = 0;

      if (annotations.length === 0) {
        resolve({ deleted: 0 });
        return;
      }

      for (const annotation of annotations) {
        const request = store.delete(annotation.id);
        request.onsuccess = () => {
          deleted++;
          if (deleted === annotations.length) {
            resolve({ deleted });
          }
        };
        request.onerror = () => reject(new Error(`Failed to delete annotation: ${request.error?.message}`));
      }
    });
  }

  /**
   * Clear ALL annotations from the database
   */
  async clearAllAnnotations() {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('annotations', 'readwrite');
      const request = store.clear();
      request.onsuccess = () => resolve({ success: true });
      request.onerror = () => reject(new Error(`Failed to clear annotations: ${request.error?.message}`));
    });
  }

  /**
   * Get summary of all pages with annotations
   * Returns array of { pageUrl, title, highlightCount, checkboxCount, pageNoteCount, lastUpdated }
   */
  async getPagesSummary() {
    await this.open();
    const annotations = await this.getAllAnnotations();

    // Group by pageUrl
    const pageMap = new Map();

    for (const annotation of annotations) {
      const url = annotation.pageUrl;
      if (!pageMap.has(url)) {
        pageMap.set(url, {
          pageUrl: url,
          title: annotation.pageTitle || this.extractTitleFromUrl(url),
          highlightCount: 0,
          checkboxCount: 0,
          pageNoteCount: 0,
          lastUpdated: annotation.updatedAt
        });
      }

      const page = pageMap.get(url);
      if (annotation.annotationType === 'highlight') {
        page.highlightCount++;
      } else if (annotation.annotationType === 'checkbox') {
        page.checkboxCount++;
        if (annotation.checked) {
          page.checkedCount = (page.checkedCount || 0) + 1;
        }
      } else if (annotation.annotationType === 'page-note') {
        page.pageNoteCount++;
      }

      if (annotation.updatedAt > page.lastUpdated) {
        page.lastUpdated = annotation.updatedAt;
      }
    }

    // Convert to array and sort by last updated
    return Array.from(pageMap.values()).sort((a, b) => b.lastUpdated - a.lastUpdated);
  }

  /**
   * Extract a readable title from URL
   */
  extractTitleFromUrl(url) {
    try {
      const urlObj = new URL(url);
      // Get pathname and clean it up
      let title = urlObj.pathname
        .replace(/^\//, '')
        .replace(/\/$/, '')
        .replace(/[-_]/g, ' ')
        .replace(/\.[^.]+$/, ''); // Remove extension

      if (!title) {
        title = urlObj.hostname;
      }

      return title || url;
    } catch {
      return url;
    }
  }

  // ============ Search Operations ============

  /**
   * Search annotations by query string
   * Searches textSnapshot, note, pageUrl, pageTitle
   */
  async searchAnnotations(query, options = {}) {
    await this.open();
    const all = await this.getAllAnnotations();

    if (!query || query.trim() === '') {
      return this.applyFilters(all, options);
    }

    const queryLower = query.toLowerCase().trim();

    const matches = all.filter(a =>
      (a.textSnapshot && a.textSnapshot.toLowerCase().includes(queryLower)) ||
      (a.note && a.note.toLowerCase().includes(queryLower)) ||
      (a.pageUrl && a.pageUrl.toLowerCase().includes(queryLower)) ||
      (a.pageTitle && a.pageTitle.toLowerCase().includes(queryLower))
    );

    return this.applyFilters(matches, options);
  }

  /**
   * Apply filters to annotation results
   */
  applyFilters(annotations, options = {}) {
    let filtered = annotations;

    // Filter by type (OR logic)
    if (options.types && options.types.length > 0) {
      filtered = filtered.filter(a => options.types.includes(a.annotationType));
    }

    // Filter by colorId (OR logic)
    if (options.colorIds && options.colorIds.length > 0) {
      filtered = filtered.filter(a => options.colorIds.includes(a.colorId));
    }

    // Legacy: Filter by intent (OR logic) - for backwards compatibility
    if (options.intents && options.intents.length > 0) {
      const colorIds = options.intents.map(i => INTENT_TO_COLOR_ID[i] || 'default-action');
      filtered = filtered.filter(a => colorIds.includes(a.colorId));
    }

    // Filter by date range
    if (options.dateRange) {
      const now = Date.now();
      let cutoff;

      switch (options.dateRange) {
        case 'today':
          cutoff = now - 24 * 60 * 60 * 1000;
          break;
        case 'week':
          cutoff = now - 7 * 24 * 60 * 60 * 1000;
          break;
        case 'month':
          cutoff = now - 30 * 24 * 60 * 60 * 1000;
          break;
        default:
          cutoff = 0;
      }

      if (cutoff > 0) {
        filtered = filtered.filter(a => (a.updatedAt || a.createdAt || 0) >= cutoff);
      }
    }

    // Sort by updated time descending
    filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    return filtered;
  }

  // ============ Group Operations ============

  async addGroup(group) {
    await this.open();

    const record = {
      ...group,
      id: group.id || this.generateId(),
      createdAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const store = this.getStore('groups', 'readwrite');
      const request = store.add(record);
      request.onsuccess = () => resolve(record);
      request.onerror = () => reject(new Error(`Failed to add group: ${request.error?.message}`));
    });
  }

  async getAllGroups() {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('groups', 'readonly');
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(new Error(`Failed to get groups: ${request.error?.message}`));
    });
  }

  async deleteGroup(id) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('groups', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve({ success: true, id });
      request.onerror = () => reject(new Error(`Failed to delete group: ${request.error?.message}`));
    });
  }

  // ============ Color Operations ============

  /**
   * Add a new custom color
   */
  async addColor(colorData) {
    await this.open();

    // Get max sortOrder
    const colors = await this.getAllColors();
    const maxSortOrder = colors.reduce((max, c) => Math.max(max, c.sortOrder || 0), -1);

    const record = {
      id: colorData.id || this.generateId(),
      name: colorData.name,
      color: colorData.color,
      isDefault: false,
      sortOrder: maxSortOrder + 1,
      usageCount: 0,
      createdAt: Date.now()
    };

    return new Promise((resolve, reject) => {
      const store = this.getStore('colors', 'readwrite');
      const request = store.add(record);
      request.onsuccess = () => resolve(record);
      request.onerror = () => reject(new Error(`Failed to add color: ${request.error?.message}`));
    });
  }

  /**
   * Get all colors sorted by sortOrder
   */
  async getAllColors() {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('colors', 'readonly');
      const request = store.getAll();
      request.onsuccess = () => {
        const colors = request.result || [];
        // Sort by sortOrder
        colors.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
        resolve(colors);
      };
      request.onerror = () => reject(new Error(`Failed to get colors: ${request.error?.message}`));
    });
  }

  /**
   * Get a single color by ID
   */
  async getColor(id) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('colors', 'readonly');
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(new Error(`Failed to get color: ${request.error?.message}`));
    });
  }

  /**
   * Update a color
   */
  async updateColor(id, patch) {
    await this.open();

    return new Promise((resolve, reject) => {
      const store = this.getStore('colors', 'readwrite');
      const getRequest = store.get(id);

      getRequest.onsuccess = () => {
        if (!getRequest.result) {
          reject(new Error(`Color not found: ${id}`));
          return;
        }

        const updated = {
          ...getRequest.result,
          ...patch
        };

        const putRequest = store.put(updated);
        putRequest.onsuccess = () => resolve(updated);
        putRequest.onerror = () => reject(new Error(`Failed to update color: ${putRequest.error?.message}`));
      };

      getRequest.onerror = () => reject(new Error(`Failed to get color: ${getRequest.error?.message}`));
    });
  }

  /**
   * Delete a custom color (fails for default colors)
   * Optionally reassign annotations to a different color
   */
  async deleteColor(id, reassignToColorId = 'default-action') {
    await this.open();

    // Get the color first
    const color = await this.getColor(id);
    if (!color) {
      throw new Error(`Color not found: ${id}`);
    }

    if (color.isDefault) {
      throw new Error('Cannot delete default colors');
    }

    // Reassign annotations using this color
    const annotations = await this.getAllAnnotations();
    for (const annotation of annotations) {
      if (annotation.colorId === id) {
        await this.updateAnnotation(annotation.id, { colorId: reassignToColorId });
      }
    }

    // Delete the color
    return new Promise((resolve, reject) => {
      const store = this.getStore('colors', 'readwrite');
      const request = store.delete(id);
      request.onsuccess = () => resolve({ success: true, id });
      request.onerror = () => reject(new Error(`Failed to delete color: ${request.error?.message}`));
    });
  }

  /**
   * Increment usage count for a color
   */
  async incrementColorUsage(colorId) {
    const color = await this.getColor(colorId);
    if (color) {
      await this.updateColor(colorId, { usageCount: (color.usageCount || 0) + 1 });
    }
  }

  /**
   * Decrement usage count for a color
   */
  async decrementColorUsage(colorId) {
    const color = await this.getColor(colorId);
    if (color && color.usageCount > 0) {
      await this.updateColor(colorId, { usageCount: color.usageCount - 1 });
    }
  }

  // ============ Import/Export Operations ============

  /**
   * Import annotations from backup
   * Skips duplicates based on pageUrl + elementFingerprint
   */
  async importAnnotations(annotations) {
    await this.open();

    let imported = 0;
    let skipped = 0;

    for (const annotation of annotations) {
      try {
        // Generate new ID to avoid conflicts
        const record = {
          ...annotation,
          id: this.generateId(),
          importedAt: Date.now()
        };

        await new Promise((resolve, reject) => {
          const store = this.getStore('annotations', 'readwrite');
          const request = store.add(record);
          request.onsuccess = () => {
            imported++;
            resolve();
          };
          request.onerror = () => {
            // Likely duplicate (unique constraint on pageUrl + elementFingerprint)
            skipped++;
            resolve();
          };
        });
      } catch (error) {
        skipped++;
      }
    }

    return { imported, skipped };
  }
}

// Export singleton instance
export const db = new IndexedDBHelper();
