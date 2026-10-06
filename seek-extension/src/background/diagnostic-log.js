export const FuguangDiagnosticLog = (() => {
  const DB_NAME = "liusheng-diagnostic-log";
  const STORE_NAME = "events";
  const MAX_ENTRIES = 2000;

  function sanitizeText(value, maxLength = 1000) {
    return String(value || "")
      .replace(/chrome-extension:\/\/[a-p]{32}\//gi, "")
      .replace(/(?:https?|wss?):\/\/[^\s<>"'`]+/gi, value => {
        try {
          return `${new URL(value).origin}/[redacted]`;
        } catch {
          return "[redacted-url]";
        }
      })
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
      .replace(/\b(api[_-]?key|access[_-]?token|authorization|token|secret|secure)\s*[:=]\s*["']?[^\s"'&,;]+/gi,
        "$1=[REDACTED]")
      .replace(/\bsk-[a-z0-9_-]{8,}/gi, "[REDACTED]")
      .slice(0, maxLength);
  }

  function normalizeEvent(input = {}) {
    const requestedTimestamp = Number(input.timestamp);
    const timestamp = Number.isFinite(requestedTimestamp) && requestedTimestamp > 0 &&
      requestedTimestamp < 8.64e15 ? requestedTimestamp : Date.now();
    const details = {};
    for (const key of [
      "sourceKind", "sourceHost", "phase", "chunkIndex", "httpStatus", "errorCode", "provider",
      "tabId", "pageScheme", "queueWaitMs", "asrMs", "translationMs",
      "sourceDisplayMs", "translationDisplayMs", "refinementDisplayMs", "queueDepth", "droppedChunks"
    ]) {
      if (input.details?.[key] !== undefined && input.details[key] !== null) {
        details[key] = typeof input.details[key] === "number"
          ? input.details[key]
          : sanitizeText(input.details[key], 120);
      }
    }
    return {
      timestamp,
      time: new Date(timestamp).toISOString(),
      jobId: String(input.jobId || "").slice(0, 100),
      runToken: String(input.runToken || "").slice(0, 100),
      event: String(input.event || "unknown").slice(0, 80),
      level: ["info", "warning", "error"].includes(input.level) ? input.level : "info",
      status: String(input.status || "").slice(0, 80),
      stage: String(input.stage || "").slice(0, 80),
      message: sanitizeText(input.message, 1000),
      stack: sanitizeText(input.stack, 4000),
      details
    };
  }

  function create(options = {}) {
    const indexedDb = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDb?.open) {
      return createMemory(options);
    }
    const maxEntries = Math.max(1, Number(options.maxEntries) || MAX_ENTRIES);
    let dbPromise;

    function open() {
      if (!dbPromise) {
        const request = indexedDb.open(options.dbName || DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            db.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
          }
        };
        dbPromise = requestToPromise(request)
          .then(db => {
            db.onversionchange = () => {
              db.close();
              dbPromise = null;
            };
            return db;
          })
          .catch(error => {
            dbPromise = null;
            throw error;
          });
      }
      return dbPromise;
    }

    async function append(input) {
      const db = await open();
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const done = transactionToPromise(transaction);
      done.catch(() => {});
      const store = transaction.objectStore(STORE_NAME);
      try {
        const id = await requestToPromise(store.add(normalizeEvent(input)));
        const keys = await requestToPromise(store.getAllKeys());
        for (const key of keys.slice(0, Math.max(0, keys.length - maxEntries))) {
          await requestToPromise(store.delete(key));
        }
        await done;
        return id;
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
    }

    async function list({ jobId = "", limit = maxEntries } = {}) {
      const db = await open();
      const transaction = db.transaction(STORE_NAME, "readonly");
      const done = transactionToPromise(transaction);
      done.catch(() => {});
      try {
        const events = await requestToPromise(transaction.objectStore(STORE_NAME).getAll());
        await done;
        return events
          .filter(event => !jobId || event.jobId === jobId)
          .slice(-Math.min(maxEntries, Math.max(1, Number(limit) || maxEntries)));
      } catch (error) {
        await done.catch(() => {});
        throw error;
      }
    }

    return { append, list };
  }

  function createMemory(options = {}) {
    const maxEntries = Math.max(1, Number(options.maxEntries) || MAX_ENTRIES);
    const events = [];
    return {
      async append(input) {
        const id = (events.at(-1)?.id || 0) + 1;
        events.push({ ...normalizeEvent(input), id });
        events.splice(0, Math.max(0, events.length - maxEntries));
        return id;
      },
      async list({ jobId = "", limit = maxEntries } = {}) {
        return events.filter(event => !jobId || event.jobId === jobId)
          .slice(-Math.min(maxEntries, Math.max(1, Number(limit) || maxEntries)));
      }
    };
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Diagnostic log request failed."));
    });
  }

  function transactionToPromise(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("Diagnostic log transaction aborted."));
      transaction.onerror = () => reject(transaction.error || new Error("Diagnostic log transaction failed."));
    });
  }

  return { create, createMemory, sanitizeText };
})();
