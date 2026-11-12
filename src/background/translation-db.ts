export const TRANSLATION_DB_NAME = 'margin_translation_db_v1';
export const TRANSLATION_DB_VERSION = 1;
export const TRANSLATION_STORE_NAME = 'translations';

export const DEFAULT_PERSISTENT_MAX_ENTRIES = 15_000;
export const DEFAULT_PERSISTENT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export interface TranslationEntryMeta {
  providerId?: string;
  model?: string;
  fromLang?: string;
  toLang?: string;
  scene?: string;
}

export interface TranslationDbRecord {
  key: string;
  value: string;
  updatedAt: number;
  expiresAt: number;
  meta?: TranslationEntryMeta;
}

export interface TranslationPersistenceWriteItem {
  key: string;
  value: string;
  meta?: TranslationEntryMeta;
}

export interface TranslationPersistenceAdapter {
  readonly isAvailable: boolean;
  getMany(keys: readonly string[], now?: number): Promise<Map<string, string>>;
  putMany(
    entries: readonly TranslationPersistenceWriteItem[],
    now?: number,
  ): Promise<void>;
  count(now?: number): Promise<number>;
  clear(): Promise<void>;
}

export interface InMemoryPersistenceAdapterOptions {
  maxEntries?: number;
  ttlMs?: number;
  nowFn?: () => number;
  available?: boolean;
}

/**
 * Injectable async persistence adapter for deterministic unit testing of L2
 * persistence, L2->L1 promotion, 30-day TTL expiry, and capacity pruning in
 * environments without browser IndexedDB.
 */
export class InMemoryPersistenceAdapter
  implements TranslationPersistenceAdapter
{
  private readonly records = new Map<string, TranslationDbRecord>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private readonly available: boolean;

  constructor(options: InMemoryPersistenceAdapterOptions = {}) {
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? DEFAULT_PERSISTENT_MAX_ENTRIES,
    );
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_PERSISTENT_TTL_MS);
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.available = options.available ?? true;
  }

  get isAvailable(): boolean {
    return this.available;
  }

  private pruneExpired(currentNow: number): void {
    for (const [k, rec] of this.records.entries()) {
      if (rec.expiresAt <= currentNow) {
        this.records.delete(k);
      }
    }
  }

  private pruneCapacity(): void {
    if (this.records.size <= this.maxEntries) {
      return;
    }
    const sortedOldestFirst = Array.from(this.records.values()).sort(
      (a, b) => a.updatedAt - b.updatedAt,
    );
    const excess = this.records.size - this.maxEntries;
    for (let i = 0; i < excess; i++) {
      const victim = sortedOldestFirst[i];
      if (victim) {
        this.records.delete(victim.key);
      }
    }
  }

  async getMany(
    keys: readonly string[],
    now?: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.available || keys.length === 0) {
      return out;
    }
    const currentNow = now ?? this.nowFn();
    for (const key of keys) {
      const rec = this.records.get(key);
      if (!rec) continue;
      if (rec.expiresAt <= currentNow) {
        this.records.delete(key);
        continue;
      }
      // Refresh recency order and timestamp on L2 read hit
      this.records.delete(key);
      const refreshed: TranslationDbRecord = {
        ...rec,
        updatedAt: currentNow,
      };
      this.records.set(key, refreshed);
      out.set(key, rec.value);
    }
    return out;
  }

  async putMany(
    entries: readonly TranslationPersistenceWriteItem[],
    now?: number,
  ): Promise<void> {
    if (!this.available || entries.length === 0) {
      return;
    }
    const currentNow = now ?? this.nowFn();
    this.pruneExpired(currentNow);

    for (const entry of entries) {
      if (!entry.key) continue;
      if (this.records.has(entry.key)) {
        this.records.delete(entry.key);
      }
      this.records.set(entry.key, {
        key: entry.key,
        value: entry.value,
        updatedAt: currentNow,
        expiresAt: currentNow + this.ttlMs,
        ...(entry.meta ? { meta: entry.meta } : {}),
      });
    }

    this.pruneCapacity();
  }

  async count(now?: number): Promise<number> {
    if (!this.available) return 0;
    const currentNow = now ?? this.nowFn();
    this.pruneExpired(currentNow);
    return this.records.size;
  }

  async clear(): Promise<void> {
    if (!this.available) return;
    this.records.clear();
  }
}

export interface IndexedDbTranslationAdapterOptions {
  dbName?: string;
  storeName?: string;
  maxEntries?: number;
  ttlMs?: number;
  nowFn?: () => number;
  idbFactory?: IDBFactory | null;
}

function detectGlobalIdbFactory(
  explicit?: IDBFactory | null,
): IDBFactory | null {
  if (explicit !== undefined) {
    return explicit;
  }
  try {
    if (
      typeof globalThis.indexedDB !== 'undefined' &&
      globalThis.indexedDB &&
      typeof globalThis.indexedDB.open === 'function'
    ) {
      return globalThis.indexedDB;
    }
  } catch {
    // Ignore SecurityError in sandboxed/restricted contexts
  }
  return null;
}

function idbRequestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () =>
      reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function idbTransactionComplete(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () =>
      reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * MV3 Service Worker IndexedDB L2 persistence store (`margin_translation_db_v1`).
 * Automatically degrades to a zero-throw no-op when `indexedDB` is unavailable
 * (such as Node/jsdom Vitest runs or restricted browser contexts).
 */
export class IndexedDbTranslationAdapter
  implements TranslationPersistenceAdapter
{
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private readonly idbFactory: IDBFactory | null;
  private dbPromise: Promise<IDBDatabase | null> | null = null;
  private permanentlyFailed = false;

  constructor(options: IndexedDbTranslationAdapterOptions = {}) {
    this.dbName = options.dbName ?? TRANSLATION_DB_NAME;
    this.storeName = options.storeName ?? TRANSLATION_STORE_NAME;
    this.maxEntries = Math.max(
      1,
      options.maxEntries ?? DEFAULT_PERSISTENT_MAX_ENTRIES,
    );
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_PERSISTENT_TTL_MS);
    this.nowFn = options.nowFn ?? (() => Date.now());
    this.idbFactory = detectGlobalIdbFactory(options.idbFactory);
  }

  get isAvailable(): boolean {
    return Boolean(this.idbFactory) && !this.permanentlyFailed;
  }

  private openDatabase(): Promise<IDBDatabase | null> {
    if (!this.idbFactory || this.permanentlyFailed) {
      return Promise.resolve(null);
    }
    if (this.dbPromise) {
      return this.dbPromise;
    }

    this.dbPromise = new Promise<IDBDatabase | null>((resolve) => {
      try {
        const openReq = this.idbFactory!.open(
          this.dbName,
          TRANSLATION_DB_VERSION,
        );

        openReq.onupgradeneeded = () => {
          const db = openReq.result;
          if (!db.objectStoreNames.contains(this.storeName)) {
            const store = db.createObjectStore(this.storeName, {
              keyPath: 'key',
            });
            store.createIndex('byUpdatedAt', 'updatedAt', { unique: false });
            store.createIndex('byExpiresAt', 'expiresAt', { unique: false });
          }
        };

        openReq.onsuccess = () => {
          const db = openReq.result;
          db.onversionchange = () => {
            db.close();
            this.dbPromise = null;
          };
          resolve(db);
        };

        openReq.onerror = () => {
          this.permanentlyFailed = true;
          this.dbPromise = null;
          resolve(null);
        };

        openReq.onblocked = () => {
          this.dbPromise = null;
          resolve(null);
        };
      } catch {
        this.permanentlyFailed = true;
        this.dbPromise = null;
        resolve(null);
      }
    });

    return this.dbPromise;
  }

  async getMany(
    keys: readonly string[],
    now?: number,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.isAvailable || keys.length === 0) {
      return out;
    }
    const db = await this.openDatabase();
    if (!db) return out;

    const currentNow = now ?? this.nowFn();
    const uniqueKeys = Array.from(new Set(keys));
    const expiredKeys: string[] = [];

    try {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);

      const records = await Promise.all(
        uniqueKeys.map((k) =>
          idbRequestToPromise<TranslationDbRecord | undefined>(store.get(k)),
        ),
      );
      await idbTransactionComplete(tx);

      for (const rec of records) {
        if (!rec) continue;
        if (rec.expiresAt <= currentNow) {
          expiredKeys.push(rec.key);
          continue;
        }
        out.set(rec.key, rec.value);
      }
    } catch {
      return out;
    }

    if (expiredKeys.length > 0) {
      void this.deleteKeysQuietly(db, expiredKeys);
    }

    return out;
  }

  private async deleteKeysQuietly(
    db: IDBDatabase,
    keys: readonly string[],
  ): Promise<void> {
    try {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);
      for (const key of keys) {
        store.delete(key);
      }
      await idbTransactionComplete(tx);
    } catch {
      // Ignore opportunistic cleanup failures
    }
  }

  async putMany(
    entries: readonly TranslationPersistenceWriteItem[],
    now?: number,
  ): Promise<void> {
    if (!this.isAvailable || entries.length === 0) {
      return;
    }
    const db = await this.openDatabase();
    if (!db) return;

    const currentNow = now ?? this.nowFn();

    try {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);

      for (const entry of entries) {
        if (!entry.key) continue;
        const record: TranslationDbRecord = {
          key: entry.key,
          value: entry.value,
          updatedAt: currentNow,
          expiresAt: currentNow + this.ttlMs,
          ...(entry.meta ? { meta: entry.meta } : {}),
        };
        store.put(record);
      }

      await idbTransactionComplete(tx);
      await this.pruneStoreIfNeeded(db, currentNow);
    } catch {
      // Never fail live translation RPCs due to IndexedDB storage quota/errors
    }
  }

  private async pruneStoreIfNeeded(
    db: IDBDatabase,
    currentNow: number,
  ): Promise<void> {
    try {
      const tx = db.transaction(this.storeName, 'readwrite');
      const store = tx.objectStore(this.storeName);

      // 1. Delete expired records via `byExpiresAt` index when IDBKeyRange is available
      if (
        typeof IDBKeyRange !== 'undefined' &&
        store.indexNames.contains('byExpiresAt')
      ) {
        const expIndex = store.index('byExpiresAt');
        const range = IDBKeyRange.upperBound(currentNow);
        await new Promise<void>((resolve) => {
          const cursorReq = expIndex.openCursor(range);
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = () => resolve();
        });
      }

      // 2. Cap total entries at `this.maxEntries` (evicting oldest `updatedAt` first)
      const total = await idbRequestToPromise<number>(store.count());
      if (total > this.maxEntries && store.indexNames.contains('byUpdatedAt')) {
        let toDelete = total - this.maxEntries;
        const updIndex = store.index('byUpdatedAt');
        await new Promise<void>((resolve) => {
          const cursorReq = updIndex.openCursor(null, 'next');
          cursorReq.onsuccess = () => {
            const cursor = cursorReq.result;
            if (cursor && toDelete > 0) {
              cursor.delete();
              toDelete--;
              cursor.continue();
            } else {
              resolve();
            }
          };
          cursorReq.onerror = () => resolve();
        });
      }

      await idbTransactionComplete(tx);
    } catch {
      // Ignore pruning errors
    }
  }

  async count(now?: number): Promise<number> {
    if (!this.isAvailable) return 0;
    const db = await this.openDatabase();
    if (!db) return 0;

    const currentNow = now ?? this.nowFn();
    try {
      const tx = db.transaction(this.storeName, 'readonly');
      const store = tx.objectStore(this.storeName);
      if (
        typeof IDBKeyRange !== 'undefined' &&
        store.indexNames.contains('byExpiresAt')
      ) {
        const expIndex = store.index('byExpiresAt');
        const validCount = await idbRequestToPromise<number>(
          expIndex.count(IDBKeyRange.lowerBound(currentNow, true)),
        );
        await idbTransactionComplete(tx);
        return validCount;
      }
      const countVal = await idbRequestToPromise<number>(store.count());
      await idbTransactionComplete(tx);
      return countVal;
    } catch {
      return 0;
    }
  }

  async clear(): Promise<void> {
    if (!this.isAvailable) return;
    const db = await this.openDatabase();
    if (!db) return;

    try {
      const tx = db.transaction(this.storeName, 'readwrite');
      tx.objectStore(this.storeName).clear();
      await idbTransactionComplete(tx);
    } catch {
      // Ignore clear errors
    }
  }
}
