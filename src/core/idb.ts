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

function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return open().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const transaction = d.transaction('kv', mode)
        const req = fn(transaction.objectStore('kv'))
        let result: T
        req.onsuccess = () => { result = req.result as T }
        req.onerror = () => reject(req.error)
        transaction.oncomplete = () => resolve(result)
        transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
        transaction.onerror = () => reject(transaction.error ?? req.error ?? new Error('IndexedDB transaction failed'))
      }),
  )
}

export const get = (key: string) => run<Uint8Array | undefined>('readonly', (s) => s.get(key)).then((v) => v ?? null)

/** An empty value deletes the key. */
export const put = (key: string, value: Uint8Array) => run<void>('readwrite', (s) => (value.length ? s.put(value, key) : s.delete(key)))
