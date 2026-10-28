'use strict';



class TtlCache {
 
  static NULL_SENTINEL = Symbol('null_result');

  /**
   * @param {number} ttlMs durée de vie d'une entrée
   * @param {number} maxEntries au-delà, les plus anciennes sont évincées
   */
  constructor(ttlMs, maxEntries = 2000) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

 
  async getOrSet(key, factory) {
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit === TtlCache.NULL_SENTINEL ? null : hit;
    }
    const value = await factory();
    this.set(key, value ?? TtlCache.NULL_SENTINEL);
    return value ?? null;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) this.map.delete(key);
    }
  }

  clear() {
    this.map.clear();
  }

  delete(key) {
    this.map.delete(key);
  }

  get size() {
    return this.map.size;
  }
}


async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      try {
        results[index] = await worker(items[index], index);
      } catch (_) {
        results[index] = null;
      }
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { TtlCache, mapLimit };
