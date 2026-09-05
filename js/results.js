/* =====================================================================
 * results.js — the participant's own results screen.
 *
 * Everything here replays the session archive held in memory by the logger.
 * Nothing is read back from Supabase, so Row Level Security stays
 * insert-only and no new data is exposed.
 *
 * A note on what the heatmap is: it shows CURSOR DWELL, i.e. where the
 * pointer spent time. Cursor position is a rough proxy for where someone
 * was looking, not a measurement of gaze, and the wording in the UI says so.
 * ===================================================================== */

import { CONFIG } from './config.js';

const IFACE_LABEL = { A: 'Popup', B: 'Side panel' };

let reviewMap = null;
let heatLayer = null;
let clickLayer = null;
let zoneLayer = null;
let zonesData = null;
let archive = [];
let selectedIndex = 0;
let heatVisible = true;

/** Build the whole results screen. */
export function renderResults({ archive: sessionArchive, zones, plan }) {
  archive = sessionArchive.filter(a => !a.trial.is_practice);
  zonesData = zones;

  renderScoreSummary(plan);
  renderTrialTable();
  buildReviewMap();
  selectTrial(0);
  wireControls();
}

/* ---------------- score summary ---------------- */

function renderScoreSummary(plan) {
  const n = archive.length;
  const correct = archive.filter(a => a.trial.correct).length;
  const byIface = { A: [], B: [] };
  archive.forEach(a => byIface[a.trial.interface]?.push(a.trial));

  const meanMs = (rows) =>
    rows.length ? Math.round(rows.reduce((s, r) => s + (r.ms_to_response || 0), 0) / rows.length) : 0;

  const el = document.getElementById('score-summary');
  el.innerHTML = `
    <p class="score-headline">You got <strong>${correct} of ${n}</strong> tasks right.</p>
    <div class="score-grid">
      ${scoreCard('Popup layout', byIface.A, meanMs(byIface.A))}
      ${scoreCard('Side panel layout', byIface.B, meanMs(byIface.B))}
    </div>
    <p class="muted small">Session ${plan.sessionId.slice(0, 8)} · group ${plan.groupCode}</p>
  `;
}

function scoreCard(label, rows, meanMs) {
  const correct = rows.filter(r => r.correct).length;
  const revisits = rows.length
    ? (rows.reduce((s, r) => s + (r.n_revisits || 0), 0) / rows.length).toFixed(1)
    : '0';
  return `
    <div class="score-card">
      <h3>${label}</h3>
      <div><span>Correct</span><span>${correct} / ${rows.length}</span></div>
      <div><span>Average time</span><span>${(meanMs / 1000).toFixed(1)} s</span></div>
      <div><span>Zones re-checked</span><span>${revisits}</span></div>
    </div>
  `;
}

/* ---------------- per-trial table ---------------- */

function renderTrialTable() {
  const rows = archive.map((a, i) => {
    const t = a.trial;
    const mark = t.timed_out
      ? '<span class="mark out">Timed out</span>'
      : t.correct
        ? '<span class="mark ok">Correct</span>'
        : '<span class="mark no">Missed</span>';
    return `
      <tr data-index="${i}" class="${i === selectedIndex ? 'is-selected' : ''}">
        <td>${i + 1}</td>
        <td>${IFACE_LABEL[t.interface] || t.interface}</td>
        <td>${t.difficulty}</td>
        <td>${t.response_zone_id ? escapeHtml(t.response_zone_id) : '—'}</td>
        <td>${escapeHtml(t.target_zone_id)}</td>
        <td>${((t.ms_to_response || 0) / 1000).toFixed(1)} s</td>
        <td>${mark}</td>
      </tr>`;
  }).join('');

  document.getElementById('trial-table').innerHTML = `
    <table class="results-table">
      <thead>
        <tr><th>#</th><th>Layout</th><th>Difficulty</th><th>You chose</th>
            <th>Answer</th><th>Time</th><th></th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;

  document.querySelectorAll('#trial-table tr[data-index]').forEach(tr => {
    tr.addEventListener('click', () => selectTrial(Number(tr.dataset.index)));
  });
}

/* ---------------- review map ---------------- */

function buildReviewMap() {
  if (reviewMap) return;
  reviewMap = L.map('review-map', { zoomControl: true });
  L.tileLayer(CONFIG.TILES.url, {
    attribution: CONFIG.TILES.attribution,
    maxZoom: CONFIG.TILES.maxZoom,
  }).addTo(reviewMap);
}

function selectTrial(index) {
  if (!archive[index]) return;
  selectedIndex = index;
  const entry = archive[index];

  document.querySelectorAll('#trial-table tr[data-index]').forEach(tr => {
    tr.classList.toggle('is-selected', Number(tr.dataset.index) === index);
  });

  document.getElementById('review-prompt').textContent = entry.spec.prompt;

  // redraw layers
  [zoneLayer, heatLayer, clickLayer].forEach(l => l && reviewMap.removeLayer(l));
  zoneLayer = heatLayer = clickLayer = null;

  reviewMap.setView(entry.spec.view.center, entry.spec.view.zoom, { animate: false });
  reviewMap.invalidateSize();

  // candidate zones: target outlined green, the choice outlined red if wrong
  const wanted = new Set(entry.spec.candidates);
  const feats = zonesData.features.filter(f => wanted.has(f.properties.zone_id));
  zoneLayer = L.geoJSON(feats, {
    style: (f) => {
      const id = f.properties.zone_id;
      if (id === entry.trial.target_zone_id) {
        return { color: '#15803d', weight: 3, fillColor: '#22c55e', fillOpacity: 0.35 };
      }
      if (id === entry.trial.response_zone_id) {
        return { color: '#b91c1c', weight: 3, fillColor: '#ef4444', fillOpacity: 0.35 };
      }
      return { color: '#16406f', weight: 1, fillColor: '#2563a8', fillOpacity: 0.18 };
    },
    onEachFeature: (f, layer) => {
      const p = f.properties;
      layer.bindTooltip(
        `Zone ${p.zone_id} · ${p.buildings_catchment} buildings`,
        { sticky: true }
      );
    },
  }).addTo(reviewMap);

  drawHeat(entry);
  drawClicks(entry);
  applyHeatVisibility();
}

/** Cursor dwell: each stored sample is one tick of time at that location. */
function drawHeat(entry) {
  const { lat, lng } = entry.trace.points;
  const pts = [];
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] == null || lng[i] == null) continue;
    pts.push([lat[i], lng[i], 1]);
  }
  if (!pts.length || typeof L.heatLayer !== 'function') return;
  heatLayer = L.heatLayer(pts, {
    radius: 22,
    blur: 18,
    maxZoom: 17,
    minOpacity: 0.25,
    gradient: { 0.2: '#3b82f6', 0.45: '#22c55e', 0.7: '#facc15', 1.0: '#dc2626' },
  });
}

function drawClicks(entry) {
  const clicks = entry.events.filter(e => e.type === 'click' && e.lat != null);
  clickLayer = L.layerGroup(
    clicks.map((c, i) =>
      L.circleMarker([c.lat, c.lng], {
        radius: 6,
        color: '#111827',
        weight: 2,
        fillColor: '#ffffff',
        fillOpacity: 0.9,
      }).bindTooltip(`Click ${i + 1} · ${(c.t_ms / 1000).toFixed(1)}s`, { direction: 'top' })
    )
  ).addTo(reviewMap);
}

function applyHeatVisibility() {
  if (!heatLayer) return;
  if (heatVisible) heatLayer.addTo(reviewMap);
  else reviewMap.removeLayer(heatLayer);
}

/* ---------------- controls ---------------- */

function wireControls() {
  const btn = document.getElementById('btn-heat');
  btn.addEventListener('click', () => {
    heatVisible = !heatVisible;
    btn.textContent = heatVisible ? 'Hide interaction heatmap' : 'Show interaction heatmap';
    btn.setAttribute('aria-pressed', String(heatVisible));
    applyHeatVisibility();
  });

  document.getElementById('btn-prev').addEventListener('click', () => {
    selectTrial((selectedIndex - 1 + archive.length) % archive.length);
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    selectTrial((selectedIndex + 1) % archive.length);
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
