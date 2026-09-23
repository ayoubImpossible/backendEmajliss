'use strict';

/**
 * Cache mémoire à durée de vie, volontairement minimal.
 *
 * Sert deux besoins mesurés pendant l'audit :
 *  - éviter d'appeler /auth/current à chaque requête (la latence était doublée) ;
 *  - éviter de redemander à HumHub le titre d'un contenu déjà vu dans le fil.
 *
 * Pas de dépendance externe : quelques centaines d'entrées, un seul processus.
 * Si l'API passe un jour derrière plusieurs instances, remplacer par Redis.
 */

class TtlCache {
  /**
   * Sentinel stored in the cache to represent a null result.
   * This allows caching failed fetches (404s, timeouts) so they are not
   * retried on every request, while still returning null to callers.
   */
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
    // Remise en fin de Map : approximation LRU suffisante ici.
    this.map.delete(key);
    this.map.set(key, entry);
    // Return sentinel as-is so getOrSet can detect it
    return entry.value;
  }

  set(key, value) {
    if (this.map.size >= this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /**
   * Récupère, ou calcule puis mémorise.
   * Les valeurs nulles sont mémorisées sous forme de sentinelle pour éviter de
   * retenter les requêtes échouées (404, timeout) à chaque appel.
   */
  async getOrSet(key, factory) {
    const hit = this.get(key);
    if (hit !== undefined) {
      return hit === TtlCache.NULL_SENTINEL ? null : hit;
    }
    const value = await factory();
    // Cache nulls too — as a sentinel — so failed fetches aren't retried every request
    this.set(key, value ?? TtlCache.NULL_SENTINEL);
    return value ?? null;
  }

  /** Éviction explicite des entrées expirées — utilisée par le nettoyage périodique. */
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

/**
 * Exécute des tâches en parallèle avec une limite de concurrence.
 * Évite d'ouvrir 20 connexions simultanées vers HumHub pour une page de fil.
 */
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
