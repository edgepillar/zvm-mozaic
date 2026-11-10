// A key-value store in IndexedDB, for what is too big for localStorage: a
// full draft is six megabytes of bytes. One object store, opened once.

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open('mozaic', 1)
    req.onupgradeneeded = () => req.result.createObjectStore('kv')
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest,
  afterRead?: (value: T, store: IDBObjectStore) => void): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const transaction = d.transaction('kv', mode)
        const store = transaction.objectStore('kv')
        const req = fn(store)
        let result: T
        req.onsuccess = () => {
          result = req.result as T
          try { afterRead?.(result, store) }
          catch (error) { reject(error); transaction.abort() }
        }
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => reject(transaction.error ?? req.error ?? new Error('IndexedDB transaction failed'))
      }),
  )
}

export const get = (key: string) => run<Uint8Array | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null)

/** A transform reads the last committed value and updates it in the same transaction. */
export function put(key: string, value: Uint8Array | ((current: Uint8Array | null) => Uint8Array | null)): Promise<void> {
  if (typeof value !== 'function') return run<void>('readwrite', s => value.length ? s.put(value, key) : s.delete(key))
  return run<Uint8Array | undefined>('readwrite', s => s.get(key), (saved, store) => {
    const current = saved ?? null
    const next = value(current)
    // Keep an intentional empty draft distinct from a key that has never been migrated.
    if (next !== null && next !== current) store.put(next, key)
  }).then(() => undefined)
}
