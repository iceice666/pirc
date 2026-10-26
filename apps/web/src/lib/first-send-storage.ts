/** Critical first-send storage: a successful write means its transaction committed. */
import type { FirstDraft } from './first-send';
export interface DraftStore {
  list(scope: string): Promise<FirstDraft[]>;
  get(scope: string, id: string): Promise<FirstDraft | undefined>;
  update(
    scope: string,
    id: string,
    change: (before: FirstDraft | undefined) => FirstDraft | undefined,
  ): Promise<FirstDraft | undefined>;
}
export class BrowserDraftStore implements DraftStore {
  #database?: Promise<IDBDatabase>;
  #open(): Promise<IDBDatabase> {
    return (this.#database ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('Local draft storage is unavailable. Your message has not been sent.'));
        return;
      }
      const request = indexedDB.open('pirc-first-send-v1', 1);
      let failed = false;
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore('drafts', { keyPath: ['scope', 'operationId'] })
          .createIndex('scope', 'scope');
      request.onerror = () => {
        failed = true;
        reject(request.error);
      };
      request.onblocked = () => {
        failed = true;
        reject(new Error('Close older pirc tabs to open local draft storage.'));
      };
      request.onsuccess = () => {
        if (failed) {
          request.result.close();
          return;
        }
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          this.#database = undefined;
        };
        resolve(db);
      };
    }).catch((error) => {
      this.#database = undefined;
      throw error;
    }));
  }
  async list(scope: string): Promise<FirstDraft[]> {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const request = tx.objectStore('drafts').index('scope').getAll(scope);
      tx.oncomplete = () => resolve(request.result as FirstDraft[]);
      tx.onabort = () => reject(tx.error ?? new Error('Local draft read failed.'));
      tx.onerror = () => {};
    });
  }
  async get(scope: string, id: string): Promise<FirstDraft | undefined> {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readonly');
      const request = tx.objectStore('drafts').get([scope, id]);
      tx.oncomplete = () => resolve(request.result as FirstDraft | undefined);
      tx.onabort = () => reject(tx.error ?? new Error('Local draft read failed.'));
      tx.onerror = () => {};
    });
  }

  async update(
    scope: string,
    id: string,
    change: (before: FirstDraft | undefined) => FirstDraft | undefined,
  ): Promise<FirstDraft | undefined> {
    const db = await this.#open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('drafts', 'readwrite', { durability: 'strict' });
      const store = tx.objectStore('drafts');
      const request = store.get([scope, id]);
      let result: FirstDraft | undefined, failure: unknown;
      request.onsuccess = () => {
        try {
          result = change(request.result as FirstDraft | undefined);
          if (result) {
            if (result.scope !== scope || result.operationId !== id)
              throw new Error('Draft identity changed.');
            store.put(result);
          } else store.delete([scope, id]);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = () =>
        reject(failure ?? tx.error ?? new Error('Local draft save failed. Your message is kept.'));
      tx.onerror = () => {};
    });
  }
}
