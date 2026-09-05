/* =====================================================================
 * logger.js — interaction telemetry for the Lisbon hazard-map A/B study
 *
 * Design notes that matter for the science:
 *  - All timings use performance.now() relative to trial start, so network
 *    latency and wall-clock skew CANNOT contaminate the dependent variables.
 *  - Mouse positions are stored as BOTH container pixels (for path length)
 *    and lat/lng (which survive zoom/pan, for spatial analysis).
 *  - One batch per trial => ~12 HTTP requests per participant.
 *  - Failed batches persist to localStorage and are retried on the next
 *    page load, so a dropped connection does not lose a participant.
 *  - Raw traces AND precomputed metrics are both stored, so metric
 *    definitions (e.g. what counts as a "revisit") can be revised later.
 *
 * Usage sketch:
 *    import { Logger } from './logger.js';
 *    const log = new Logger({ supabaseUrl, supabaseAnonKey, trialsVersion });
 *    await log.initSession({ consentGiven: true });
 *    log.startTrial({ trial, interface: 'A', block: 1, trialIndex: 1 });
 *    log.recordMove(x, y, latlng);        // call from map mousemove
 *    log.logEvent('hover_enter', {...});
 *    await log.endTrial({ responseZoneId, correct });
 *    await log.completeSession();
 * ===================================================================== */

const RETRY_KEY = 'hazmap_retry_queue_v1';
const SESSION_KEY = 'hazmap_session_v1';

const GROUPS = {
  G1: { block1: { interface: 'A', set: 'S1' }, block2: { interface: 'B', set: 'S2' } },
  G2: { block1: { interface: 'B', set: 'S1' }, block2: { interface: 'A', set: 'S2' } },
  G3: { block1: { interface: 'A', set: 'S2' }, block2: { interface: 'B', set: 'S1' } },
  G4: { block1: { interface: 'B', set: 'S2' }, block2: { interface: 'A', set: 'S1' } },
};

export class Logger {
  constructor({
    supabaseUrl,
    supabaseAnonKey,
    trialsVersion = '1.0',
    appVersion = '1.0',
    moveHz = 10,              // 10 Hz keeps a 60-participant study ~100 MB
    debug = false,
  }) {
    if (!supabaseUrl || !supabaseAnonKey) {
      throw new Error('Logger requires supabaseUrl and supabaseAnonKey');
    }
    this.url = supabaseUrl.replace(/\/$/, '');
    this.key = supabaseAnonKey;
    this.trialsVersion = trialsVersion;
    this.appVersion = appVersion;
    this.moveInterval = 1000 / moveHz;
    this.moveHz = moveHz;
    this.debug = debug;

    this.session = null;
    this.trial = null;
    this._lastMoveAt = -Infinity;

    // Session-local archive. The results screen replays from this, so it never
    // needs to read from the database — RLS stays insert-only and untouched.
    this.archive = [];

    this._installUnloadHandlers();
    this.retryPending();          // flush anything left over from a past visit
  }

  /* ---------------- internal helpers ---------------- */

  _log(...a) { if (this.debug) console.log('[logger]', ...a); }

  _headers() {
    return {
      'apikey': this.key,
      'Authorization': `Bearer ${this.key}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    };
  }

  /** POST rows to a PostgREST table. Returns true on success. */
  async _post(table, rows, { keepalive = false } = {}) {
    if (!rows || (Array.isArray(rows) && rows.length === 0)) return true;
    try {
      const res = await fetch(`${this.url}/rest/v1/${table}`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify(rows),
        keepalive,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        this._log('POST failed', table, res.status, txt);
        this._queue(table, rows);
        return false;
      }
      return true;
    } catch (err) {
      this._log('POST error', table, err);
      this._queue(table, rows);
      return false;
    }
  }

  /** Persist a failed batch so it can be retried on a later page load. */
  _queue(table, rows) {
    try {
      const q = JSON.parse(localStorage.getItem(RETRY_KEY) || '[]');
      q.push({ table, rows, ts: Date.now() });
      localStorage.setItem(RETRY_KEY, JSON.stringify(q));
    } catch (e) {
      this._log('could not queue for retry', e);
    }
  }

  /** Retry every queued batch. Safe to call at any time. */
  async retryPending() {
    let q;
    try { q = JSON.parse(localStorage.getItem(RETRY_KEY) || '[]'); }
    catch { return; }
    if (!q.length) return;

    this._log(`retrying ${q.length} queued batches`);
    localStorage.removeItem(RETRY_KEY);   // cleared first; failures re-queue
    for (const item of q) {
      await this._post(item.table, item.rows);
    }
  }

  /** Fire-and-forget send that survives page unload. */
  _beacon(table, rows) {
    if (!rows || rows.length === 0) return;
    const url = `${this.url}/rest/v1/${table}?apikey=${encodeURIComponent(this.key)}`;
    const blob = new Blob([JSON.stringify(rows)], { type: 'application/json' });
    let ok = false;
    if (navigator.sendBeacon) ok = navigator.sendBeacon(url, blob);
    if (!ok) this._queue(table, rows);
  }

  _installUnloadHandlers() {
    const flush = () => {
      // If a trial is mid-flight, salvage what we have rather than lose it.
      if (this.trial) {
        const payload = this._buildTrialPayload({ abandoned: true });
        this._beacon('events', payload.events);
        this._beacon('traces', [payload.trace]);
        this._beacon('trials', [payload.trial]);
        this.trial = null;
      }
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  /* ---------------- session ---------------- */

  /**
   * Create the session row.
   * Group assignment: ?g=G1 in the URL wins (lets you balance a small,
   * hand-recruited sample deliberately); otherwise random.
   */
  async initSession({ consentGiven = false, participantCode = null } = {}) {
    const params = new URLSearchParams(location.search);
    const forced = (params.get('g') || '').toUpperCase();
    const groupCode = GROUPS[forced] ? forced
      : ['G1', 'G2', 'G3', 'G4'][Math.floor(Math.random() * 4)];
    const g = GROUPS[groupCode];

    const isTouch = ('ontouchstart' in window) || navigator.maxTouchPoints > 0;
    const fine = window.matchMedia?.('(pointer: fine)')?.matches;

    this.session = {
      session_id: (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random()}`),
      participant_code: participantCode || params.get('p') || null,
      group_code: groupCode,
      block1_interface: g.block1.interface, block1_set: g.block1.set,
      block2_interface: g.block2.interface, block2_set: g.block2.set,
      consent_given: consentGiven,
      pointer_type: fine ? 'mouse' : (isTouch ? 'touch' : 'unknown'),
      is_touch_device: isTouch,
      screen_w: screen.width, screen_h: screen.height,
      viewport_w: window.innerWidth, viewport_h: window.innerHeight,
      device_pixel_ratio: window.devicePixelRatio || 1,
      user_agent: navigator.userAgent,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      locale: navigator.language,
      app_version: this.appVersion,
      trials_version: this.trialsVersion,
    };

    try { sessionStorage.setItem(SESSION_KEY, this.session.session_id); } catch {}
    await this._post('sessions', [this.session]);
    this._log('session', this.session.session_id, groupCode);
    return this.session;
  }

  /** The block/set plan for this participant, for the app to render. */
  getPlan() {
    if (!this.session) throw new Error('initSession() first');
    return {
      sessionId: this.session.session_id,
      groupCode: this.session.group_code,
      block1: { interface: this.session.block1_interface, set: this.session.block1_set },
      block2: { interface: this.session.block2_interface, set: this.session.block2_set },
    };
  }

  /* ---------------- trials ---------------- */

  /** @param trial an entry from trials.json */
  startTrial({ trial, interface: iface, block, trialIndex }) {
    if (!this.session) throw new Error('initSession() first');

    this.trial = {
      spec: trial,
      iface,
      block,
      trialIndex,
      t0: performance.now(),
      startedAtWall: new Date().toISOString(),
      events: [],
      move: { t: [], x: [], y: [], lat: [], lng: [] },
      inspected: new Set(),     // zones seen at least once
      inspectOrder: [],         // hover_enter sequence (revisits derivable)
      nInspections: 0,
      nRevisits: 0,
      nZoom: 0,
      nPan: 0,
      pathPx: 0,
      lastX: null, lastY: null,
      msToFirstInspect: null,
      panelDwellMs: 0,
      _panelEnter: null,
    };
    this._lastMoveAt = -Infinity;
    this.logEvent('trial_start', {});
    return this.trial;
  }

  _now() { return Math.round(performance.now() - this.trial.t0); }

  /**
   * Record a discrete event.
   * type: hover_enter | hover_exit | click | popup_open | popup_close |
   *       panel_update | zoom | pan | prompt_read | window_blur | window_focus
   */
  logEvent(type, { zoneId = null, lat = null, lng = null, zoom = null, extra = null } = {}) {
    if (!this.trial) return;
    const t = this._now();
    const spec = this.trial.spec;
    const isCandidate = zoneId ? (spec.candidates || []).includes(zoneId) : null;
    const isTarget = zoneId ? zoneId === spec.target_zone_id : null;

    this.trial.events.push({
      session_id: this.session.session_id,
      trial_id: spec.trial_id,
      block: this.trial.block,
      t_ms: t,
      type,
      zone_id: zoneId,
      is_candidate: isCandidate,
      is_target: isTarget,
      lat, lng,
      zoom_level: zoom,
      extra,
    });

    // derived counters
    if (type === 'hover_enter' && isCandidate) {
      this.trial.nInspections += 1;
      if (this.trial.msToFirstInspect === null) this.trial.msToFirstInspect = t;
      if (this.trial.inspected.has(zoneId)) this.trial.nRevisits += 1;
      this.trial.inspected.add(zoneId);
      this.trial.inspectOrder.push(zoneId);
    }
    if (type === 'zoom') this.trial.nZoom += 1;
    if (type === 'pan') this.trial.nPan += 1;

    // panel dwell (interface B): time the pointer spends over the side panel
    if (type === 'panel_update') this.trial._panelEnter = t;
    if (type === 'hover_exit' && this.trial._panelEnter !== null) {
      this.trial.panelDwellMs += t - this.trial._panelEnter;
      this.trial._panelEnter = null;
    }
  }

  /**
   * Throttled mouse sample. Call from the map's mousemove handler.
   * @param x,y container pixels; @param latlng {lat,lng} optional
   */
  recordMove(x, y, latlng = null) {
    if (!this.trial) return;
    const now = performance.now();
    if (now - this._lastMoveAt < this.moveInterval) return;
    this._lastMoveAt = now;

    const tr = this.trial;
    if (tr.lastX !== null) {
      tr.pathPx += Math.hypot(x - tr.lastX, y - tr.lastY);
    }
    tr.lastX = x; tr.lastY = y;

    tr.move.t.push(Math.round(now - tr.t0));
    tr.move.x.push(Math.round(x));
    tr.move.y.push(Math.round(y));
    tr.move.lat.push(latlng ? +latlng.lat.toFixed(6) : null);
    tr.move.lng.push(latlng ? +latlng.lng.toFixed(6) : null);
  }

  _buildTrialPayload({ responseZoneId = null, correct = null, timedOut = false, abandoned = false } = {}) {
    const tr = this.trial;
    const spec = tr.spec;
    const isPractice = spec.logged === false || /^PRACTICE/i.test(spec.trial_id);

    const trialRow = {
      session_id: this.session.session_id,
      trial_id: spec.trial_id,
      block: tr.block,
      trial_index: tr.trialIndex,
      is_practice: isPractice,
      interface: tr.iface,
      set_code: spec.set ?? null,
      slot: spec.slot ?? null,
      difficulty: spec.difficulty ?? null,
      attribute: spec.attribute ?? null,
      direction: spec.direction ?? null,
      gap_pct: spec.gap_pct ?? null,
      target_zone_id: spec.target_zone_id,
      response_zone_id: responseZoneId,
      correct,
      timed_out: timedOut,
      ms_to_first_inspect: tr.msToFirstInspect,
      ms_to_response: abandoned ? null : this._now(),
      n_inspections: tr.nInspections,
      n_unique_zones_inspected: tr.inspected.size,
      n_revisits: tr.nRevisits,
      n_zoom: tr.nZoom,
      n_pan: tr.nPan,
      path_px: Math.round(tr.pathPx),
      panel_dwell_ms: Math.round(tr.panelDwellMs),
      n_move_samples: tr.move.t.length,
      started_at_wall: tr.startedAtWall,
    };

    const traceRow = {
      session_id: this.session.session_id,
      trial_id: spec.trial_id,
      block: tr.block,
      sample_hz: this.moveHz,
      n_points: tr.move.t.length,
      points: tr.move,
    };

    return { trial: trialRow, events: tr.events, trace: traceRow };
  }

  /** Finish the trial and upload its batch (trial + events + trace). */
  async endTrial({ responseZoneId = null, correct = null, timedOut = false } = {}) {
    if (!this.trial) return null;
    this.logEvent('trial_end', { zoneId: responseZoneId });

    const payload = this._buildTrialPayload({ responseZoneId, correct, timedOut });
    const spec = this.trial.spec;
    this.trial = null;

    // Keep a local copy for the participant's own results screen.
    this.archive.push({
      spec,
      trial: payload.trial,
      events: payload.events,
      trace: payload.trace,
    });

    // order matters: trials row references the session, events/traces are independent
    await this._post('trials', [payload.trial]);
    await this._post('events', payload.events);
    await this._post('traces', [payload.trace]);

    this._log('trial uploaded', payload.trial.trial_id,
              `${payload.events.length} events, ${payload.trace.n_points} samples`);
    return payload.trial;
  }

  /* ---------------- completion ---------------- */

  /**
   * Mark the session complete via a SECURITY DEFINER function.
   *
   * This deliberately does NOT use PATCH on the table. A direct update has to
   * satisfy RLS, column grants, and PostgREST's need for SELECT privilege on
   * the column in the WHERE clause — three ways to fail silently. The function
   * runs with the owner's rights and returns true only if a row actually
   * changed, so we can tell success from a no-op.
   */
  async completeSession({ abandonedReason = null } = {}) {
    if (!this.session) return false;
    try {
      const res = await fetch(`${this.url}/rest/v1/rpc/complete_session`, {
        method: 'POST',
        headers: this._headers(),
        body: JSON.stringify({
          p_session_id: this.session.session_id,
          p_reason: abandonedReason,
        }),
      });
      const body = await res.text().catch(() => '');
      if (!res.ok) {
        console.warn(
          `[logger] SESSION NOT MARKED COMPLETE (HTTP ${res.status}). ` +
          `It will be excluded from the analysis views. ${body}`
        );
        await this.retryPending();
        return false;
      }
      if (body.trim() === 'false') {
        console.warn('[logger] session was already marked complete — no change made.');
      }
      await this.retryPending();
      return true;
    } catch (e) {
      console.warn('[logger] completeSession network error:', e);
      await this.retryPending();
      return false;
    }
  }
}

/* ---------------------------------------------------------------------
 * Convenience: wire a Leaflet map + zone layer to the logger.
 * Keeps the interface-specific behaviour (A vs B) in the app, not here.
 * ------------------------------------------------------------------- */
export function attachLeafletTelemetry(map, logger) {
  map.on('mousemove', (e) => {
    const p = e.containerPoint;
    logger.recordMove(p.x, p.y, e.latlng);
  });
  map.on('zoomend', () => logger.logEvent('zoom', { zoom: map.getZoom() }));
  map.on('moveend', () => logger.logEvent('pan', { zoom: map.getZoom() }));
  window.addEventListener('blur', () => logger.logEvent('window_blur', {}));
  window.addEventListener('focus', () => logger.logEvent('window_focus', {}));
}

/**
 * Bind one zone polygon. `iface` selects the reveal trigger:
 *   A = click-to-reveal popup, B = hover-to-reveal persistent panel.
 * onReveal(zoneId, props) should update the popup/panel; onAnswer(zoneId)
 * is the participant's committed response.
 */
export function attachZoneHandlers(layer, zoneId, props, logger, iface, { onReveal, onAnswer }) {
  const ll = layer.getBounds?.().getCenter?.();
  const at = () => ({ zoneId, lat: ll?.lat ?? null, lng: ll?.lng ?? null });

  layer.on('mouseover', () => {
    logger.logEvent('hover_enter', at());
    if (iface === 'B') { logger.logEvent('panel_update', at()); onReveal?.(zoneId, props); }
  });
  layer.on('mouseout', () => logger.logEvent('hover_exit', at()));

  layer.on('click', () => {
    logger.logEvent('click', at());
    if (iface === 'A') { logger.logEvent('popup_open', at()); onReveal?.(zoneId, props); }
    onAnswer?.(zoneId);
  });
}
