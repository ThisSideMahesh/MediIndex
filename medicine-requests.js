'use strict';
/**
 * MANUAL MEDICINE REQUEST ENGINE — progressive geographic search
 * ==============================================================
 *
 * Server-side domain logic for manual inter-pharmacy medicine requests.
 * Deliberately SEPARATE from the automatic near-expiry redistribution workflow
 * (processNearExpiryRedistribution / medicine_redistribution_requests), which
 * this module never reads or writes.
 *
 * Built as an injectable factory so the future API layer can call it directly
 * and tests can drive it against either adapter without module-cache tricks:
 *
 *     const engine = createMedicineRequestEngine({ db, isPg, haversineKm });
 *     await engine.createRequest({ pharmacyId, userId, medicineName, ... });
 *
 * INVARIANTS THIS MODULE GUARANTEES
 *  - No inventory movement. Nothing here updates medicine_batches or writes
 *    inventory_movements. An accepted offer records a commitment only.
 *  - covered_quantity <= requested_quantity always, enforced by an atomic
 *    conditional UPDATE (CAS) plus the ck_mreq_coverage database constraint.
 *  - Exactly one offer row per (request_id, pharmacy_id), enforced by
 *    uq_mreq_offer, making repeated responses idempotent.
 *  - The requester pharmacy is always supplied by the caller from the
 *    authenticated session; no client-supplied pharmacy id is ever trusted.
 *
 * MEDICINE IDENTITY (MVP): medicines.id is per-pharmacy, so cross-pharmacy
 * matching uses lower(name). MVP therefore requires identical medicine naming
 * across pharmacies. No second identity system is introduced.
 */

// ─── Centralized configuration ───────────────────────────────────────────────
// Progressive search zones in kilometres, ascending. Index 0 is tried first.
const MEDICINE_REQUEST_ZONES_KM = [10, 25, 50, 100];
// Derived — never write the maximum radius twice.
const MEDICINE_REQUEST_MAX_RADIUS_KM = MEDICINE_REQUEST_ZONES_KM[MEDICINE_REQUEST_ZONES_KM.length - 1];
// A contacted pharmacy has this long to respond before its offer EXPIRES.
const OFFER_RESPONSE_WINDOW_MS = 24 * 60 * 60 * 1000;   // 24 hours
// A request stays actionable this long before it EXPIRES.
const MEDICINE_REQUEST_TTL_MS = 72 * 60 * 60 * 1000;    // 72 hours

// Request statuses in which a request is still actionable (accepts offers).
const ACTIONABLE_REQUEST_STATUSES = ['OPEN', 'PARTIALLY_COVERED'];
// Request statuses the REQUESTER may still cancel.
//
// Deliberately broader than ACTIONABLE_REQUEST_STATUSES: "no longer accepting
// offers" is not the same as "no longer cancellable". A request keeps its record
// (and its 72h lifetime) after the search finishes, so the requester must be able
// to close it out rather than wait for it to expire:
//   FULLY_COVERED — search satisfied, awaiting fulfilment
//   NO_COVERAGE   — search exhausted all zones without cover, still within TTL
// Cancelling either is a pure status transition. Neither reserves capacity
// (see RESERVING_REQUEST_STATUSES for FULLY_COVERED, which releases on cancel)
// and neither holds PENDING offers, so no search is restarted and no stock moves.
// EXPIRED is excluded — an elapsed request is final. CANCELLED is handled
// earlier as an idempotent replay.
const CANCELLABLE_REQUEST_STATUSES = ['OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED', 'NO_COVERAGE'];
// Request statuses whose ACCEPTED offers still consume soft-reserved capacity.
// CANCELLED and EXPIRED are absent, so their reservations are released.
// FULLY_COVERED stays reserved until the future controlled fulfilment workflow.
const RESERVING_REQUEST_STATUSES = ['OPEN', 'PARTIALLY_COVERED', 'FULLY_COVERED'];

/** Domain error carrying an HTTP-equivalent status for the future API layer. */
class MedicineRequestError extends Error {
  constructor(code, message, status, details = undefined) {
    super(message);
    this.name = 'MedicineRequestError';
    this.code = code;       // VALIDATION | NOT_FOUND | CONFLICT | FORBIDDEN
    this.status = status;   // 400 | 404 | 409 | 403
    if (details !== undefined) this.details = details;
  }
}
const validationError = (m, d) => new MedicineRequestError('VALIDATION', m, 400, d);
const notFoundError   = (m)    => new MedicineRequestError('NOT_FOUND', m, 404);
const conflictError   = (m, d) => new MedicineRequestError('CONFLICT', m, 409, d);

const toIso = (ms) => new Date(ms).toISOString();
/** Normalizes a timestamp column (PG returns Date, SQLite returns TEXT). */
const toMs = (value) => (value instanceof Date ? value.getTime() : new Date(value).getTime());
const toNum = (value) => (value === null || value === undefined ? 0 : Number(value));

function createMedicineRequestEngine(deps = {}) {
  const { db, isPg = false, haversineKm, isDuplicateError } = deps;
  if (!db) throw new Error('createMedicineRequestEngine requires a db adapter.');
  if (typeof haversineKm !== 'function') throw new Error('createMedicineRequestEngine requires haversineKm.');

  // Clock is injectable so expiry logic is deterministically testable.
  const nowMs = typeof deps.now === 'function' ? deps.now : () => Date.now();

  const isDup = typeof isDuplicateError === 'function'
    ? isDuplicateError
    : (err) => !!(err && (err.code === '23505' ||
        (typeof err.message === 'string' && (
          err.message.includes('UNIQUE constraint') ||
          err.message.includes('duplicate key') ||
          err.message.includes('already exists')))));

  // ─── Dialect helpers ──────────────────────────────────────────────────────
  // expiry_date is DATE in PostgreSQL and TEXT (YYYY-MM-DD) in SQLite; both
  // compare correctly against CURRENT_DATE.
  const TODAY = 'CURRENT_DATE';
  // Write-transaction helper.
  //
  // PostgreSQL: the pool gives each transaction its own connection, so writers
  // run genuinely in parallel and correctness rests on the conditional UPDATE
  // (CAS) plus PostgreSQL re-evaluating the UPDATE predicate after blocking on a
  // locked row.
  //
  // SQLite: node:sqlite DatabaseSync is a single synchronous connection. Because
  // the transaction body awaits, a second overlapping transaction would issue
  // BEGIN while one is already open and fail with "cannot start a transaction
  // within a transaction". Writers are therefore serialized in-process, which
  // matches SQLite's single-writer model. This does not weaken the coverage
  // guarantee: the CAS still validates against freshly committed state, and a
  // loser still receives a clean CONFLICT.
  let writeChain = Promise.resolve();
  const runWriteTransaction = (fn) => {
    if (isPg) return db.transaction(fn);
    const result = writeChain.then(() => db.transaction(fn, true));
    writeChain = result.then(() => undefined, () => undefined);
    return result;
  };

  const zonesFor = (opts = {}) =>
    Array.isArray(opts.zonesKm) && opts.zonesKm.length ? opts.zonesKm : MEDICINE_REQUEST_ZONES_KM;
  const offerWindowFor = (opts = {}) =>
    Number.isFinite(opts.offerResponseWindowMs) ? opts.offerResponseWindowMs : OFFER_RESPONSE_WINDOW_MS;
  const ttlFor = (opts = {}) =>
    Number.isFinite(opts.requestTtlMs) ? opts.requestTtlMs : MEDICINE_REQUEST_TTL_MS;

  // ───────────────────────────────────────────────────────────────────────────
  // STOCK
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Usable stock: non-expired, positive-quantity batches of the named medicine
   * held by the given pharmacy. Expired stock is never counted. Returns 0 when
   * the pharmacy has no catalogue entry at all — which is valid information,
   * not an error.
   */
  async function calculateUsableStock(pharmacyId, medicineName, exec = db) {
    const row = await exec.get(`
      SELECT COALESCE(SUM(b.quantity), 0) AS usable_stock
      FROM medicine_batches b
      JOIN medicines m ON m.id = b.medicine_id
      WHERE m.pharmacy_id = ?
        AND m.active = 1
        AND lower(m.name) = lower(?)
        AND b.quantity > 0
        AND b.expiry_date >= ${TODAY}
    `, [pharmacyId, medicineName]);
    return toNum(row && row.usable_stock);
  }

  /**
   * Quantity this pharmacy has already soft-reserved for the named medicine:
   * the sum of its ACCEPTED offers on requests that are still unresolved.
   * Reservations on CANCELLED/EXPIRED requests are excluded, so cancelling or
   * expiring a request releases its capacity automatically without rewriting
   * any offer row. No inventory is consulted or modified.
   */
  async function calculateReservedStock(pharmacyId, medicineName, exec = db, excludeRequestId = null) {
    const placeholders = RESERVING_REQUEST_STATUSES.map(() => '?').join(', ');
    const params = [pharmacyId, medicineName, ...RESERVING_REQUEST_STATUSES];
    let extra = '';
    if (excludeRequestId !== null && excludeRequestId !== undefined) {
      extra = ' AND o.request_id <> ?';
      params.push(excludeRequestId);
    }
    const row = await exec.get(`
      SELECT COALESCE(SUM(o.offered_quantity), 0) AS reserved
      FROM medicine_request_offers o
      JOIN medicine_requests r ON r.id = o.request_id
      WHERE o.pharmacy_id = ?
        AND o.status = 'ACCEPTED'
        AND lower(r.medicine_name) = lower(?)
        AND r.status IN (${placeholders})${extra}
    `, params);
    return toNum(row && row.reserved);
  }

  /** Offerable stock = usable stock minus outstanding soft reservations (never negative). */
  async function calculateOfferableStock(pharmacyId, medicineName, exec = db, excludeRequestId = null) {
    const [usable, reserved] = [
      await calculateUsableStock(pharmacyId, medicineName, exec),
      await calculateReservedStock(pharmacyId, medicineName, exec, excludeRequestId)
    ];
    return { usableStock: usable, reservedStock: reserved, offerableStock: Math.max(0, usable - reserved) };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // REQUEST CREATION
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Creates a manual medicine request. Idempotent on idempotencyKey.
   *
   * pharmacyId and userId MUST come from the authenticated session — this
   * function never reads a pharmacy id out of client-controlled input.
   */
  async function createRequest(input = {}, opts = {}) {
    const { pharmacyId, userId, medicineName, medicineId, idempotencyKey } = input;

    if (!Number.isInteger(pharmacyId)) throw validationError('An authenticated pharmacy is required.');
    if (!Number.isInteger(userId))     throw validationError('An authenticated user is required.');
    if (typeof idempotencyKey !== 'string' || !idempotencyKey.trim())
      throw validationError('idempotencyKey is required.');
    if (idempotencyKey.trim().length > 64)
      throw validationError('idempotencyKey must be 64 characters or fewer.');

    const quantity = Number(input.requestedQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0)
      throw validationError('requestedQuantity must be a positive whole number.');

    const priority = input.priority === undefined || input.priority === null ? 'NORMAL' : String(input.priority);
    if (!['NORMAL', 'URGENT'].includes(priority))
      throw validationError("priority must be 'NORMAL' or 'URGENT'.");

    const reason = input.reason === undefined || input.reason === null ? null : String(input.reason);
    const key = idempotencyKey.trim();

    // Resolve the medicine inside the requester's OWN catalogue.
    // lower(name) is the approved MVP identity rule.
    let medicine = null;
    if (Number.isInteger(medicineId)) {
      medicine = await db.get(
        'SELECT id, name FROM medicines WHERE id = ? AND pharmacy_id = ? AND active = 1',
        [medicineId, pharmacyId]
      );
    } else if (typeof medicineName === 'string' && medicineName.trim()) {
      medicine = await db.get(
        'SELECT id, name FROM medicines WHERE pharmacy_id = ? AND active = 1 AND lower(name) = lower(?) LIMIT 1',
        [pharmacyId, medicineName.trim()]
      );
    } else {
      throw validationError('medicineName or medicineId is required.');
    }
    if (!medicine) throw notFoundError('Medicine not found in your pharmacy catalogue.');

    const zones = zonesFor(opts);
    const created = nowMs();
    const expiresAt = toIso(created + ttlFor(opts));

    let requestId;
    try {
      const ins = await db.run(`
        INSERT INTO medicine_requests
          (idempotency_key, requester_pharmacy_id, medicine_id, medicine_name,
           requested_quantity, covered_quantity, status, priority, reason,
           current_zone_index, current_radius_km, created_by, expires_at)
        VALUES (?, ?, ?, ?, ?, 0, 'OPEN', ?, ?, 0, ?, ?, ?) RETURNING id
      `, [key, pharmacyId, medicine.id, medicine.name, quantity, priority, reason, zones[0], userId, expiresAt]);
      requestId = Number(ins.lastInsertRowid);
    } catch (err) {
      if (!isDup(err)) throw err;
      // Idempotent replay: return the existing request.
      const existing = await db.get(
        'SELECT * FROM medicine_requests WHERE idempotency_key = ?', [key]
      );
      if (!existing) throw err;
      // Tenant guard: an idempotency key belonging to another pharmacy must not
      // leak that pharmacy's request back to this caller.
      if (Number(existing.requester_pharmacy_id) !== pharmacyId)
        throw conflictError('idempotencyKey already used by another pharmacy.');
      return { request: normalizeRequest(existing), created: false, idempotentReplay: true };
    }

    const request = await db.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]);
    return { request: normalizeRequest(request), created: true, idempotentReplay: false };
  }

  function normalizeRequest(row) {
    if (!row) return null;
    return {
      ...row,
      id: Number(row.id),
      requester_pharmacy_id: Number(row.requester_pharmacy_id),
      medicine_id: Number(row.medicine_id),
      requested_quantity: Number(row.requested_quantity),
      covered_quantity: Number(row.covered_quantity),
      current_zone_index: Number(row.current_zone_index),
      current_radius_km: Number(row.current_radius_km),
      outstanding_quantity: Number(row.requested_quantity) - Number(row.covered_quantity)
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // ELIGIBILITY
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Eligible pharmacies for the request's CURRENT zone, annotated with real
   * Haversine distance and usable stock, ordered by the approved contact
   * priority: stock-bearing first, then nearest first.
   *
   * Eligibility (decision 12) does NOT include having stock or a catalogue
   * entry — those only determine whether the pharmacy can offer or must decline.
   */
  async function findEligiblePharmacies(request, zoneRadiusKm, exec = db) {
    const requester = await exec.get(
      'SELECT id, latitude, longitude FROM pharmacies WHERE id = ?',
      [request.requester_pharmacy_id]
    );
    // Requester without coordinates is not geographically eligible to search.
    // Never invent a distance.
    if (!requester || requester.latitude === null || requester.latitude === undefined ||
        requester.longitude === null || requester.longitude === undefined) {
      return [];
    }
    const rLat = Number(requester.latitude);
    const rLng = Number(requester.longitude);

    const candidates = await exec.query(`
      SELECT p.id, p.name, p.latitude, p.longitude
      FROM pharmacies p
      WHERE p.id <> ?
        AND p.active = 1
        AND p.latitude  IS NOT NULL
        AND p.longitude IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM medicine_request_offers o
          WHERE o.request_id = ? AND o.pharmacy_id = p.id
        )
    `, [request.requester_pharmacy_id, request.id]);

    const eligible = [];
    for (const c of candidates) {
      const distanceKm = haversineKm(rLat, rLng, Number(c.latitude), Number(c.longitude));
      if (distanceKm > zoneRadiusKm) continue;
      const usableStock = await calculateUsableStock(c.id, request.medicine_name, exec);
      eligible.push({
        pharmacyId: Number(c.id),
        pharmacyName: c.name,
        distanceKm: Math.round(distanceKm * 1000) / 1000,
        usableStock
      });
    }

    // Contact priority: stock-bearing pharmacies first (so progressive-search
    // capacity is not wasted), then nearest first within each group.
    eligible.sort((a, b) => {
      const aHas = a.usableStock > 0 ? 0 : 1;
      const bHas = b.usableStock > 0 ? 0 : 1;
      if (aHas !== bHas) return aHas - bHas;
      return a.distanceKm - b.distanceKm;
    });
    return eligible;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // PROGRESSIVE SEARCH
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Advances a request through the progressive geographic search. Idempotent and
   * safe to call repeatedly; the future API layer invokes it explicitly (there
   * is no scheduler).
   *
   * Expansion rule: expand only when the capacity already pending in the
   * current zone cannot satisfy the outstanding quantity. A pharmacy that has
   * been contacted but not yet responded still counts as pending capacity, so
   * farther pharmacies are never contacted while nearer capacity is unresolved.
   * An unanswered offer expires after the response window, which releases the
   * block and lets the search continue — silence cannot stall a request forever.
   */
  async function advanceRequest(requestId, opts = {}) {
    const zones = zonesFor(opts);
    const offerWindowMs = offerWindowFor(opts);
    const now = nowMs();
    const nowIso = toIso(now);

    // Tenant guard for API exposure: when a requester pharmacy is supplied, the
    // request must belong to it. A mismatch yields NOT_FOUND rather than
    // FORBIDDEN so the existence of another tenant's request is not disclosed.
    if (opts.requesterPharmacyId !== undefined && opts.requesterPharmacyId !== null) {
      const owned = await db.get(
        'SELECT id FROM medicine_requests WHERE id = ? AND requester_pharmacy_id = ?',
        [requestId, opts.requesterPharmacyId]
      );
      if (!owned) throw notFoundError('Medicine request not found.');
    }

    const summary = {
      requestId: Number(requestId),
      changed: false,
      waiting: false,
      contacted: [],
      expiredOffers: 0,
      zonesAdvanced: 0,
      status: null,
      zoneIndex: null,
      outstanding: 0
    };

    let request = normalizeRequest(await db.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
    if (!request) throw notFoundError('Medicine request not found.');

    // Terminal states are never re-processed.
    if (!ACTIONABLE_REQUEST_STATUSES.includes(request.status)) {
      summary.status = request.status;
      summary.zoneIndex = request.current_zone_index;
      summary.outstanding = Math.max(0, request.outstanding_quantity);
      return summary;
    }

    // 1. Expire offers whose response window has lapsed. This removes their
    //    capacity from the pending pool and unblocks expansion.
    const expired = await db.run(`
      UPDATE medicine_request_offers
      SET status = 'EXPIRED'
      WHERE request_id = ? AND status = 'PENDING' AND respond_by < ?
    `, [request.id, nowIso]);
    summary.expiredOffers = toNum(expired && expired.changes);
    if (summary.expiredOffers > 0) summary.changed = true;

    // 2. Already covered? Finish without contacting anyone else.
    if (request.covered_quantity >= request.requested_quantity) {
      await finalizeRequest(request.id, 'FULLY_COVERED');
      summary.changed = true;
      summary.status = 'FULLY_COVERED';
      summary.zoneIndex = request.current_zone_index;
      summary.outstanding = 0;
      return summary;
    }

    // 3. Request lifetime elapsed?
    if (toMs(request.expires_at) <= now) {
      await finalizeRequest(request.id, 'EXPIRED');
      summary.changed = true;
      summary.status = 'EXPIRED';
      summary.zoneIndex = request.current_zone_index;
      summary.outstanding = request.outstanding_quantity;
      return summary;
    }

    let zoneIndex = request.current_zone_index;

    // 4. Walk zones until pending capacity can cover the outstanding quantity,
    //    or every zone is exhausted.
    for (;;) {
      const outstanding = request.requested_quantity - request.covered_quantity;
      if (outstanding <= 0) break;

      const pendingCapacity = toNum((await db.get(`
        SELECT COALESCE(SUM(usable_stock_at_contact), 0) AS capacity
        FROM medicine_request_offers
        WHERE request_id = ? AND status = 'PENDING'
      `, [request.id])).capacity);

      // Nearer capacity is still unresolved — do not expand, do not spam.
      if (pendingCapacity >= outstanding) {
        summary.waiting = true;
        break;
      }

      const need = outstanding - pendingCapacity;
      const zoneRadiusKm = zones[zoneIndex];
      const candidates = await findEligiblePharmacies(request, zoneRadiusKm);

      if (candidates.length > 0) {
        const stockBearing = candidates.filter(c => c.usableStock > 0);
        const zeroStock    = candidates.filter(c => c.usableStock === 0);
        const zoneStock    = stockBearing.reduce((sum, c) => sum + c.usableStock, 0);

        let toContact;
        if (zoneStock >= need) {
          // The zone's stock-bearing pharmacies can satisfy what we still need:
          // contact the minimal nearest-first prefix only. Zero-stock and
          // no-catalogue pharmacies are left undisturbed.
          toContact = [];
          let acc = 0;
          for (const c of stockBearing) {
            toContact.push(c);
            acc += c.usableStock;
            if (acc >= need) break;
          }
        } else {
          // The zone cannot satisfy the outstanding quantity even using all of
          // its stock-bearing capacity. We will expand anyway, so contact every
          // remaining eligible pharmacy in this zone — including zero-stock and
          // no-catalogue ones — so the requester has a complete record of who
          // was asked and they can respond DECLINED / no stock.
          toContact = [...stockBearing, ...zeroStock];
        }

        for (const c of toContact) {
          const inserted = await insertOffer({
            requestId: request.id,
            pharmacyId: c.pharmacyId,
            zoneIndex,
            distanceKm: c.distanceKm,
            usableStock: c.usableStock,
            respondBy: toIso(now + offerWindowMs)
          });
          if (inserted) {
            summary.contacted.push({
              pharmacyId: c.pharmacyId,
              pharmacyName: c.pharmacyName,
              distanceKm: c.distanceKm,
              usableStock: c.usableStock,
              zoneIndex
            });
            summary.changed = true;
          }
        }

        if (toContact.length > 0) {
          // Re-evaluate with the freshly contacted capacity before expanding.
          continue;
        }
      }

      // Nothing left to contact in this zone — expand or give up.
      if (zoneIndex < zones.length - 1) {
        zoneIndex += 1;
        summary.zonesAdvanced += 1;
        summary.changed = true;
        await db.run(
          'UPDATE medicine_requests SET current_zone_index = ?, current_radius_km = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
          [zoneIndex, zones[zoneIndex], request.id]
        );
        request.current_zone_index = zoneIndex;
        request.current_radius_km = zones[zoneIndex];
        continue;
      }

      // Final zone exhausted with quantity still outstanding.
      await finalizeRequest(request.id, 'NO_COVERAGE');
      summary.changed = true;
      summary.status = 'NO_COVERAGE';
      summary.zoneIndex = zoneIndex;
      summary.outstanding = outstanding;
      return summary;
    }

    const fresh = normalizeRequest(await db.get('SELECT * FROM medicine_requests WHERE id = ?', [request.id]));
    summary.status = fresh.status;
    summary.zoneIndex = fresh.current_zone_index;
    summary.outstanding = Math.max(0, fresh.outstanding_quantity);
    return summary;
  }

  /** Inserts a PENDING offer. Returns false when the pharmacy was already contacted. */
  async function insertOffer({ requestId, pharmacyId, zoneIndex, distanceKm, usableStock, respondBy }) {
    try {
      await db.run(`
        INSERT INTO medicine_request_offers
          (request_id, pharmacy_id, zone_index, distance_km,
           usable_stock_at_contact, status, respond_by)
        VALUES (?, ?, ?, ?, ?, 'PENDING', ?)
      `, [requestId, pharmacyId, zoneIndex, distanceKm, usableStock, respondBy]);
      return true;
    } catch (err) {
      // uq_mreq_offer — a concurrent advance already contacted this pharmacy.
      if (isDup(err)) return false;
      throw err;
    }
  }

  /**
   * Moves a request to a terminal/covered status and supersedes any offer that
   * is no longer actionable. ACCEPTED offers keep their status as an audit
   * record; reservation release is driven by the request status, not by
   * rewriting offer rows.
   */
  async function finalizeRequest(requestId, status, exec = db) {
    await exec.run(
      'UPDATE medicine_requests SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, requestId]
    );
    await exec.run(
      "UPDATE medicine_request_offers SET status = 'SUPERSEDED' WHERE request_id = ? AND status = 'PENDING'",
      [requestId]
    );
  }

  // ───────────────────────────────────────────────────────────────────────────
  // OFFER
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A contacted pharmacy offers (accepts) a quantity. The offer counts toward
   * coverage immediately — there is no requester-side approval step.
   *
   * Concurrency: coverage is applied with an atomic conditional UPDATE, so two
   * pharmacies offering the last N units simultaneously can never push
   * covered_quantity past requested_quantity. The loser receives a CONFLICT and
   * leaves no partial state behind, because the whole operation is one
   * transaction.
   *
   * Quantities are never silently clamped — exceeding offerable stock or the
   * outstanding quantity raises a CONFLICT.
   */
  async function submitOffer(input = {}, opts = {}) {
    const { requestId, pharmacyId } = input;
    if (!Number.isInteger(requestId))  throw validationError('requestId is required.');
    if (!Number.isInteger(pharmacyId)) throw validationError('An authenticated pharmacy is required.');
    const quantity = Number(input.offeredQuantity);
    if (!Number.isInteger(quantity) || quantity <= 0)
      throw validationError('offeredQuantity must be a positive whole number.');
    const userId = Number.isInteger(input.userId) ? input.userId : null;

    const now = nowMs();
    const nowIso = toIso(now);

    const result = await runWriteTransaction(async (tx) => {
      const request = normalizeRequest(await tx.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
      if (!request) throw notFoundError('Medicine request not found.');

      // The requester can never offer against its own request.
      if (request.requester_pharmacy_id === pharmacyId)
        throw notFoundError('No pending request response found for your pharmacy.');

      // Must hold an offer row for this request (i.e. have been contacted).
      const offer = await tx.get(
        'SELECT * FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?',
        [requestId, pharmacyId]
      );
      if (!offer) throw notFoundError('No pending request response found for your pharmacy.');

      // Idempotent replay: an identical already-recorded offer is returned as-is.
      if (offer.status === 'ACCEPTED') {
        if (toNum(offer.offered_quantity) === quantity) {
          return {
            request,
            offer: normalizeOffer(offer),
            idempotentReplay: true,
            accepted: false
          };
        }
        throw conflictError('Your pharmacy has already responded to this request.',
          { recordedQuantity: toNum(offer.offered_quantity) });
      }
      if (offer.status !== 'PENDING')
        throw conflictError(`This request response is no longer actionable (${offer.status}).`,
          { offerStatus: offer.status });

      // The 24h response window must not have lapsed.
      if (toMs(offer.respond_by) <= now)
        throw conflictError('The response window for this request has expired.', { offerStatus: 'EXPIRED' });

      // The request itself must still be actionable and unexpired.
      if (!ACTIONABLE_REQUEST_STATUSES.includes(request.status))
        throw conflictError(`This request is no longer accepting offers (${request.status}).`,
          { requestStatus: request.status });
      if (toMs(request.expires_at) <= now)
        throw conflictError('This request has expired.', { requestStatus: 'EXPIRED' });

      // Validate against live stock and live outstanding quantity.
      const { usableStock, offerableStock } =
        await calculateOfferableStock(pharmacyId, request.medicine_name, tx, requestId);
      if (quantity > offerableStock)
        throw conflictError('Offered quantity exceeds your available stock.',
          { usableStock, offerableStock, offeredQuantity: quantity });

      const outstanding = request.requested_quantity - request.covered_quantity;
      if (quantity > outstanding)
        throw conflictError('Offered quantity exceeds the outstanding quantity for this request.',
          { outstanding, offeredQuantity: quantity });

      // ── Atomic coverage application (CAS) ──
      const cas = await tx.run(`
        UPDATE medicine_requests
        SET covered_quantity = covered_quantity + ?,
            status = CASE WHEN covered_quantity + ? >= requested_quantity
                          THEN 'FULLY_COVERED' ELSE 'PARTIALLY_COVERED' END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
          AND status IN ('OPEN', 'PARTIALLY_COVERED')
          AND covered_quantity + ? <= requested_quantity
      `, [quantity, quantity, requestId, quantity]);
      if (toNum(cas.changes) !== 1) {
        const current = normalizeRequest(await tx.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
        throw conflictError('The outstanding quantity changed before your offer was applied.', {
          outstanding: current ? Math.max(0, current.outstanding_quantity) : 0,
          requestStatus: current ? current.status : null
        });
      }

      // Guarded offer transition — also protects against a concurrent duplicate.
      const upd = await tx.run(`
        UPDATE medicine_request_offers
        SET status = 'ACCEPTED', offered_quantity = ?, responded_by = ?, responded_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'PENDING'
      `, [quantity, userId, offer.id]);
      if (toNum(upd.changes) !== 1)
        throw conflictError('Your pharmacy has already responded to this request.');

      const updatedRequest = normalizeRequest(await tx.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));

      // Fully covered: stop the search and retire the remaining PENDING offers.
      if (updatedRequest.covered_quantity >= updatedRequest.requested_quantity) {
        await tx.run(
          "UPDATE medicine_request_offers SET status = 'SUPERSEDED' WHERE request_id = ? AND status = 'PENDING'",
          [requestId]
        );
      }

      const updatedOffer = await tx.get('SELECT * FROM medicine_request_offers WHERE id = ?', [offer.id]);
      return {
        request: updatedRequest,
        offer: normalizeOffer(updatedOffer),
        idempotentReplay: false,
        accepted: true
      };
    });

    return result;
  }

  function normalizeOffer(row) {
    if (!row) return null;
    return {
      ...row,
      id: Number(row.id),
      request_id: Number(row.request_id),
      pharmacy_id: Number(row.pharmacy_id),
      zone_index: Number(row.zone_index),
      distance_km: Number(row.distance_km),
      usable_stock_at_contact: Number(row.usable_stock_at_contact),
      offered_quantity: row.offered_quantity === null || row.offered_quantity === undefined
        ? null : Number(row.offered_quantity)
    };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // DECLINE
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * A contacted pharmacy declines. Records who responded and when, preserving
   * audit information. Idempotent: repeating a decline returns the recorded one.
   * Never touches inventory or coverage.
   */
  async function declineRequest(input = {}) {
    const { requestId, pharmacyId } = input;
    if (!Number.isInteger(requestId))  throw validationError('requestId is required.');
    if (!Number.isInteger(pharmacyId)) throw validationError('An authenticated pharmacy is required.');
    const userId = Number.isInteger(input.userId) ? input.userId : null;
    const reason = input.reason === undefined || input.reason === null ? null : String(input.reason);

    return runWriteTransaction(async (tx) => {
      const request = normalizeRequest(await tx.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
      if (!request) throw notFoundError('Medicine request not found.');
      if (request.requester_pharmacy_id === pharmacyId)
        throw notFoundError('No pending request response found for your pharmacy.');

      const offer = await tx.get(
        'SELECT * FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?',
        [requestId, pharmacyId]
      );
      if (!offer) throw notFoundError('No pending request response found for your pharmacy.');

      if (offer.status === 'DECLINED') {
        return { offer: normalizeOffer(offer), declined: false, idempotentReplay: true };
      }
      if (offer.status !== 'PENDING') {
        throw conflictError(`This request response is no longer actionable (${offer.status}).`,
          { offerStatus: offer.status });
      }

      const upd = await tx.run(`
        UPDATE medicine_request_offers
        SET status = 'DECLINED', decline_reason = ?, responded_by = ?, responded_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'PENDING'
      `, [reason, userId, offer.id]);
      if (toNum(upd.changes) !== 1)
        throw conflictError('Your pharmacy has already responded to this request.');

      const updated = await tx.get('SELECT * FROM medicine_request_offers WHERE id = ?', [offer.id]);
      return { offer: normalizeOffer(updated), declined: true, idempotentReplay: false };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // CANCEL
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * The requesting pharmacy cancels its own request. Tenant-safe: a pharmacy
   * that does not own the request gets NOT_FOUND (no existence disclosure).
   * Stops new offers, releases soft reservations (by virtue of the CANCELLED
   * request status), and preserves all historical offer rows. Never modifies
   * medicine_batches.
   */
  async function cancelRequest(input = {}) {
    const { requestId, pharmacyId } = input;
    if (!Number.isInteger(requestId))  throw validationError('requestId is required.');
    if (!Number.isInteger(pharmacyId)) throw validationError('An authenticated pharmacy is required.');

    return runWriteTransaction(async (tx) => {
      const request = normalizeRequest(await tx.get(
        'SELECT * FROM medicine_requests WHERE id = ? AND requester_pharmacy_id = ?',
        [requestId, pharmacyId]
      ));
      if (!request) throw notFoundError('Medicine request not found.');

      if (request.status === 'CANCELLED')
        return { request, cancelled: false, idempotentReplay: true };
      if (!CANCELLABLE_REQUEST_STATUSES.includes(request.status))
        throw conflictError(`This request can no longer be cancelled (${request.status}).`,
          { requestStatus: request.status });

      await finalizeRequest(requestId, 'CANCELLED', tx);
      const updated = normalizeRequest(await tx.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
      return { request: updated, cancelled: true, idempotentReplay: false };
    });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // EXPIRY SWEEP
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Bulk expiry maintenance. Callable explicitly by the future API layer; no
   * scheduler is introduced here. Expiring a request releases its soft
   * reservations automatically because reservation is computed from request
   * status. Inventory is never touched.
   */
  async function expireDue(opts = {}) {
    const nowIso = toIso(nowMs());
    const pharmacyId = Number.isInteger(opts.pharmacyId) ? opts.pharmacyId : null;

    let offers;
    let stale;
    if (pharmacyId === null) {
      // Unscoped sweep — internal service use only. Never exposed directly to a
      // tenant, because it would mutate other tenants' rows.
      offers = await db.run(
        "UPDATE medicine_request_offers SET status = 'EXPIRED' WHERE status = 'PENDING' AND respond_by < ?",
        [nowIso]
      );
      stale = await db.query(
        "SELECT id FROM medicine_requests WHERE status IN ('OPEN', 'PARTIALLY_COVERED') AND expires_at < ?",
        [nowIso]
      );
    } else {
      // Tenant-scoped sweep: only offers addressed to this pharmacy or belonging
      // to a request this pharmacy owns, and only this pharmacy's own requests.
      offers = await db.run(`
        UPDATE medicine_request_offers SET status = 'EXPIRED'
        WHERE status = 'PENDING' AND respond_by < ?
          AND (pharmacy_id = ?
               OR request_id IN (SELECT id FROM medicine_requests WHERE requester_pharmacy_id = ?))
      `, [nowIso, pharmacyId, pharmacyId]);
      stale = await db.query(`
        SELECT id FROM medicine_requests
        WHERE status IN ('OPEN', 'PARTIALLY_COVERED') AND expires_at < ?
          AND requester_pharmacy_id = ?
      `, [nowIso, pharmacyId]);
    }

    for (const row of stale) await finalizeRequest(Number(row.id), 'EXPIRED');
    return { expiredOffers: toNum(offers && offers.changes), expiredRequests: stale.length };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // READ MODELS
  // ───────────────────────────────────────────────────────────────────────────

  /** Request detail with offers. Visible to the requester or any contacted pharmacy. */
  async function getRequestDetail(requestId, pharmacyId) {
    const request = normalizeRequest(await db.get('SELECT * FROM medicine_requests WHERE id = ?', [requestId]));
    if (!request) throw notFoundError('Medicine request not found.');

    const isRequester = request.requester_pharmacy_id === pharmacyId;
    if (!isRequester) {
      const own = await db.get(
        'SELECT id FROM medicine_request_offers WHERE request_id = ? AND pharmacy_id = ?',
        [requestId, pharmacyId]
      );
      // No relationship to this request — do not disclose its existence.
      if (!own) throw notFoundError('Medicine request not found.');
    }

    const offers = (await db.query(`
      SELECT o.*, p.name AS pharmacy_name
      FROM medicine_request_offers o
      JOIN pharmacies p ON p.id = o.pharmacy_id
      WHERE o.request_id = ?
      ORDER BY o.zone_index ASC, o.distance_km ASC
    `, [requestId])).map(normalizeOffer);

    return {
      request,
      // A contacted pharmacy sees only its own response, never its competitors'.
      offers: isRequester ? offers : offers.filter(o => o.pharmacy_id === pharmacyId),
      coveredQuantity: request.covered_quantity,
      remainingQuantity: Math.max(0, request.outstanding_quantity),
      viewerRole: isRequester ? 'REQUESTER' : 'RECIPIENT'
    };
  }

  /**
   * Requests raised by this pharmacy, with an offer summary the requester is
   * legitimately entitled to see. Supports status and medicine filters plus
   * limit/offset pagination. Offer summaries are fetched in one grouped query
   * rather than per row.
   */
  async function listRequestsForPharmacy(pharmacyId, filters = {}) {
    const params = [pharmacyId];
    let clause = '';
    if (filters.status && filters.status !== 'ALL') {
      clause += ' AND status = ?';
      params.push(filters.status);
    }
    if (typeof filters.medicineName === 'string' && filters.medicineName.trim()) {
      clause += ' AND lower(medicine_name) = lower(?)';
      params.push(filters.medicineName.trim());
    }
    const limit = Number.isInteger(filters.limit) && filters.limit > 0 && filters.limit <= 200 ? filters.limit : 50;
    const offset = Number.isInteger(filters.offset) && filters.offset >= 0 ? filters.offset : 0;

    const totalRow = await db.get(
      `SELECT COUNT(*) AS n FROM medicine_requests WHERE requester_pharmacy_id = ?${clause}`, params
    );

    const rows = await db.query(
      `SELECT * FROM medicine_requests WHERE requester_pharmacy_id = ?${clause}
       ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    const requests = rows.map(normalizeRequest);

    if (requests.length > 0) {
      const ids = requests.map(r => r.id);
      const holes = ids.map(() => '?').join(', ');
      const summary = await db.query(`
        SELECT request_id, status, COUNT(*) AS c, COALESCE(SUM(offered_quantity), 0) AS qty
        FROM medicine_request_offers
        WHERE request_id IN (${holes})
        GROUP BY request_id, status
      `, ids);
      const byRequest = new Map(ids.map(id => [id, { contacted: 0, byStatus: {}, acceptedQuantity: 0 }]));
      for (const row of summary) {
        const entry = byRequest.get(Number(row.request_id));
        if (!entry) continue;
        entry.byStatus[row.status] = toNum(row.c);
        entry.contacted += toNum(row.c);
        if (row.status === 'ACCEPTED') entry.acceptedQuantity += toNum(row.qty);
      }
      for (const r of requests) r.offerSummary = byRequest.get(r.id);
    }

    return { requests, total: toNum(totalRow && totalRow.n), limit, offset };
  }

  /**
   * Requests awaiting this pharmacy's response, annotated with live usable and
   * offerable stock so the caller can decide whether Offer is possible or the
   * pharmacy must Decline (usableStock = 0).
   */
  async function listIncomingForPharmacy(pharmacyId) {
    const rows = await db.query(`
      SELECT o.id AS offer_id, o.request_id, o.distance_km, o.zone_index,
             o.usable_stock_at_contact, o.respond_by, o.status AS offer_status,
             r.medicine_name, r.requested_quantity, r.covered_quantity,
             r.priority, r.reason, r.status AS request_status, r.created_at,
             r.requester_pharmacy_id, p.name AS requester_name
      FROM medicine_request_offers o
      JOIN medicine_requests r ON r.id = o.request_id
      JOIN pharmacies p ON p.id = r.requester_pharmacy_id
      WHERE o.pharmacy_id = ?
        AND o.status = 'PENDING'
        AND r.status IN ('OPEN', 'PARTIALLY_COVERED')
      ORDER BY r.priority DESC, o.distance_km ASC
    `, [pharmacyId]);

    const out = [];
    for (const row of rows) {
      const { usableStock, reservedStock, offerableStock } =
        await calculateOfferableStock(pharmacyId, row.medicine_name, db, Number(row.request_id));
      const outstanding = Number(row.requested_quantity) - Number(row.covered_quantity);
      out.push({
        offerId: Number(row.offer_id),
        requestId: Number(row.request_id),
        requesterPharmacyId: Number(row.requester_pharmacy_id),
        requesterName: row.requester_name,
        medicineName: row.medicine_name,
        requestedQuantity: Number(row.requested_quantity),
        coveredQuantity: Number(row.covered_quantity),
        outstandingQuantity: Math.max(0, outstanding),
        distanceKm: Number(row.distance_km),
        zoneIndex: Number(row.zone_index),
        priority: row.priority,
        reason: row.reason,
        usableStock,
        reservedStock,
        offerableStock,
        // The server decides actionability; the client must not recompute eligibility.
        canOffer: offerableStock > 0 && outstanding > 0,
        maxOfferableQuantity: Math.max(0, Math.min(offerableStock, outstanding)),
        offerStatus: row.offer_status,
        requestStatus: row.request_status,
        respondBy: row.respond_by,
        requestedAt: row.created_at
      });
    }
    return out;
  }

  return {
    // configuration
    MEDICINE_REQUEST_ZONES_KM,
    MEDICINE_REQUEST_MAX_RADIUS_KM,
    OFFER_RESPONSE_WINDOW_MS,
    MEDICINE_REQUEST_TTL_MS,
    ACTIONABLE_REQUEST_STATUSES,
    CANCELLABLE_REQUEST_STATUSES,
    RESERVING_REQUEST_STATUSES,
    // commands
    createRequest,
    advanceRequest,
    submitOffer,
    declineRequest,
    cancelRequest,
    expireDue,
    // queries
    calculateUsableStock,
    calculateReservedStock,
    calculateOfferableStock,
    findEligiblePharmacies,
    getRequestDetail,
    listRequestsForPharmacy,
    listIncomingForPharmacy
  };
}

module.exports = {
  createMedicineRequestEngine,
  MedicineRequestError,
  MEDICINE_REQUEST_ZONES_KM,
  MEDICINE_REQUEST_MAX_RADIUS_KM,
  OFFER_RESPONSE_WINDOW_MS,
  MEDICINE_REQUEST_TTL_MS
};
