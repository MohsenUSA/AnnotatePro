/**
 * IndexedDB Helper for AnnotatePro
 * Background-owned singleton for all database operations
 */

const DB_NAME = 'annotatepro-db';
const DB_VERSION = 1;

class IndexedDBHelper {
  constructor() {
    this.db = null;
    this.openPromise = null;
  }

  async open() {
    if (this.db) return this.db;
    if (this.openPromise) return this.openPromise;

    this.openPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        const oldVersion = event.oldVersion;

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

    return this.openPromise;
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
