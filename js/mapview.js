/* =====================================================================
 * mapview.js — the shared map component.
 *
 * Both interfaces use this same map, the same zone geometry, the same
 * colours and the same field set. Exactly two things differ:
 *   A: details reveal on CLICK, in a popup anchored on the map
 *   B: details reveal on HOVER, in a side panel that persists
 * Commitment is symmetric: in both, the answer is a "Select this zone"
 * button inside the revealed details.
 * ===================================================================== */

import { CONFIG } from './config.js';

const STYLE = {
  // every non-candidate zone: muted, non-interactive context
  context: { color: '#97a1ac', weight: 1, opacity: 0.5, fillOpacity: 0.18, interactive: false },
  // every candidate: ONE colour, regardless of its true severity
  candidate: { color: '#16406f', weight: 2, opacity: 0.9, fillColor: '#2563a8', fillOpacity: 0.55, interactive: false },
  candidateActive: { color: '#16406f', weight: 3, opacity: 1, fillColor: '#16406f', fillOpacity: 0.75, interactive: false },
  // invisible fat stroke that makes the thin bands easy to hit
  hit: { color: '#000', weight: 18, opacity: 0, fillOpacity: 0, className: 'zone-hit' },
};

export class MapView {
  constructor(containerId) {
    this.map = L.map(containerId, {
      zoomControl: true,
      attributionControl: true,
      preferCanvas: false, // SVG renderer: needed for per-path pointer-events
    });
    L.tileLayer(CONFIG.TILES.url, {
      attribution: CONFIG.TILES.attribution,
      maxZoom: CONFIG.TILES.maxZoom,
    }).addTo(this.map);

    this.zones = null;
    this.contextLayer = null;
    this.trialLayer = L.layerGroup().addTo(this.map);
    this.byId = new Map();      // zone_id -> { visible, hit, props }
    this.activeId = null;
  }

  async loadZones(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Could not load zones (${res.status})`);
    this.zones = await res.json();

    this.props = new Map();
    for (const f of this.zones.features) {
      this.props.set(f.properties.zone_id, f.properties);
    }
    return this.zones;
  }

  /** Faint background layer of every zone, drawn once. */
  showContext() {
    if (this.contextLayer) return;
    this.contextLayer = L.geoJSON(this.zones, { style: STYLE.context }).addTo(this.map);
  }

  /**
   * Draw one trial's candidates.
   * @param {string[]} candidateIds
   * @param {'A'|'B'} iface
   * @param handlers { onHoverEnter, onHoverExit, onClick, onReveal }
   */
  renderTrial(candidateIds, iface, handlers) {
    this.clearTrial();

    const wanted = new Set(candidateIds);
    const features = this.zones.features.filter(f => wanted.has(f.properties.zone_id));

    for (const feature of features) {
      const id = feature.properties.zone_id;

      // visible shape — not interactive; the hit layer owns the events so
      // that thin bands are still comfortable to point at
      const visible = L.geoJSON(feature, { style: STYLE.candidate });
      const hit = L.geoJSON(feature, { style: STYLE.hit });

      visible.addTo(this.trialLayer);
      hit.addTo(this.trialLayer);

      const centre = visible.getBounds().getCenter();
      const entry = { id, visible, hit, centre, props: feature.properties };
      this.byId.set(id, entry);

      hit.on('mouseover', () => {
        handlers.onHoverEnter?.(id, centre);
        if (iface === 'B') {
          this.setActive(id);
          handlers.onReveal?.(id, this.props.get(id), centre);
        }
      });

      hit.on('mouseout', () => handlers.onHoverExit?.(id, centre));

      hit.on('click', (e) => {
        handlers.onClick?.(id, centre);
        if (iface === 'A') {
          this.setActive(id);
          handlers.onReveal?.(id, this.props.get(id), e.latlng || centre);
        }
      });
    }
  }

  /** Highlight the zone whose details are currently shown. */
  setActive(id) {
    if (this.activeId && this.byId.has(this.activeId)) {
      this.byId.get(this.activeId).visible.setStyle(STYLE.candidate);
    }
    this.activeId = id;
    if (id && this.byId.has(id)) {
      this.byId.get(id).visible.setStyle(STYLE.candidateActive);
    }
  }

  clearTrial() {
    this.trialLayer.clearLayers();
    this.byId.clear();
    this.activeId = null;
    this.map.closePopup();
  }

  /** Same starting view for a given trial in both interfaces. */
  setView(view) {
    this.map.setView(view.center, view.zoom, { animate: false });
  }

  /** Interface A: popup anchored at the clicked zone. */
  openPopup(latlng, html) {
    return L.popup({ closeButton: true, autoPan: true, maxWidth: 300 })
      .setLatLng(latlng)
      .setContent(html)
      .openOn(this.map);
  }

  invalidate() { this.map.invalidateSize(); }
}

/* ---------------------------------------------------------------------
 * The details block. Rendered from the SAME function for both interfaces,
 * so the information content is provably identical and only its container
 * (popup vs panel) differs.
 * ------------------------------------------------------------------- */
export function fieldsHtml(props) {
  const rows = [
    ['Severity', capitalise(props.severity)],
    ['Flood depth', props.depth_band],
    ['Exposed buildings', Number(props.buildings_catchment).toLocaleString()],
    ['Built-up area', `${Math.round(props.building_area_m2).toLocaleString()} m²`],
  ];
  return rows
    .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`)
    .join('');
}

export function detailsHtml(props, { withButton = true } = {}) {
  return `
    <h2 class="panel-title">Zone ${escapeHtml(props.zone_id)}</h2>
    <dl class="fields">${fieldsHtml(props)}</dl>
    ${withButton ? '<button class="btn btn-select" data-select>Select this zone</button>' : ''}
  `;
}

function capitalise(s) { return String(s).charAt(0).toUpperCase() + String(s).slice(1); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
