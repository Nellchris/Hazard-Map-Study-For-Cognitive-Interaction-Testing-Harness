/* =====================================================================
 * study.js — flow controller.
 *
 * consent -> instructions -> block 1 (practice + 5) -> break
 *         -> block 2 (practice + 5) -> done
 *
 * Interface and trial-set assignment come from the logger's counterbalance
 * plan (group G1-G4), which can be pinned per participant with ?g=G2.
 * ===================================================================== */

import { CONFIG } from './config.js';
import { Logger, attachLeafletTelemetry } from './logger.js';
import { MapView, detailsHtml, fieldsHtml } from './mapview.js';
import { renderResults } from './results.js';

const $ = (id) => document.getElementById(id);

const state = {
  logger: null,
  view: null,
  trials: null,
  plan: null,
  blocks: [],
  blockIndex: 0,
  trialIndex: 0,
  current: null,
  timeoutId: null,
  answered: false,
};

/* ---------------- screen helpers ---------------- */

function show(id) {
  document.querySelectorAll('.screen').forEach(s => (s.hidden = true));
  $(id).hidden = false;
}

function fail(message) {
  $('error-detail').textContent = message;
  show('screen-error');
}

/* ---------------- boot ---------------- */

async function boot() {
  // A laptop with a touchscreen still has a fine pointer, so test for the
  // pointer rather than for touch capability — otherwise we would wrongly
  // turn away participants who do have a mouse.
  const finePointer = window.matchMedia?.('(pointer: fine)')?.matches;
  if (!finePointer) { show('screen-pointer'); return; }

  $('contact-link').href = CONFIG.CONTACT;

  try {
    const res = await fetch(CONFIG.DATA.trials);
    if (!res.ok) throw new Error(`trials.json (${res.status})`);
    state.trials = await res.json();
  } catch (err) {
    fail(`The task list could not be loaded: ${err.message}`);
    return;
  }

  state.logger = new Logger({
    supabaseUrl: CONFIG.SUPABASE_URL,
    supabaseAnonKey: CONFIG.SUPABASE_ANON_KEY,
    trialsVersion: state.trials.version || CONFIG.TRIALS_VERSION,
    appVersion: CONFIG.APP_VERSION,
    moveHz: CONFIG.MOVE_HZ,
  });

  $('consent-box').addEventListener('change', (e) => {
    $('btn-consent').disabled = !e.target.checked;
  });
  $('btn-consent').addEventListener('click', onConsent);
  $('btn-intro').addEventListener('click', () => showBlockIntro());
  $('btn-block').addEventListener('click', () => startBlock());
  $('btn-break').addEventListener('click', () => { state.blockIndex = 1; showBlockIntro(); });

  show('screen-consent');
}

async function onConsent() {
  $('btn-consent').disabled = true;
  await state.logger.initSession({ consentGiven: true });
  state.plan = state.logger.getPlan();

  // Build the two blocks from the counterbalance plan
  const practice = state.trials.practice;
  state.blocks = [
    {
      interface: state.plan.block1.interface,
      set: state.plan.block1.set,
      practice: practice[0],
      trials: state.trials.sets[state.plan.block1.set],
    },
    {
      interface: state.plan.block2.interface,
      set: state.plan.block2.set,
      practice: practice[1],
      trials: state.trials.sets[state.plan.block2.set],
    },
  ];

  // Build the map once and reuse it, so tile loading cost is paid a single
  // time and cannot differ between the two halves.
  try {
    state.view = new MapView('map');
    await state.view.loadZones(CONFIG.DATA.zones);
    state.view.showContext();
  } catch (err) {
    fail(`The map data could not be loaded: ${err.message}`);
    return;
  }
  attachLeafletTelemetry(state.view.map, state.logger);

  show('screen-intro');
}

/* ---------------- blocks ---------------- */

function showBlockIntro() {
  const block = state.blocks[state.blockIndex];
  $('block-title').textContent = state.blockIndex === 0 ? 'First half' : 'Second half';
  $('block-how').textContent = block.interface === 'A'
    ? 'In this half, click a zone to open its details on the map.'
    : 'In this half, point at a zone and its details appear in a panel beside the map.';
  show('screen-block');
}

function startBlock() {
  state.trialIndex = -1;   // -1 = the practice trial
  nextTrial();
}

function nextTrial() {
  const block = state.blocks[state.blockIndex];
  state.trialIndex += 1;

  if (state.trialIndex === 0) return runTrial(block.practice, block, 0);
  const measured = block.trials[state.trialIndex - 1];
  if (measured) return runTrial(measured, block, state.trialIndex);

  // block finished
  if (state.blockIndex === 0) { show('screen-break'); return; }
  finish();
}

/* ---------------- one trial ---------------- */

function runTrial(trial, block, indexWithinBlock) {
  state.current = { trial, block };
  state.answered = false;

  const isPractice = trial.logged === false;
  $('prompt').textContent = trial.prompt;
  $('practice-flag').hidden = !isPractice;
  $('progress').textContent = isPractice
    ? 'Practice'
    : `Task ${indexWithinBlock} of ${block.trials.length}`;
  $('feedback').hidden = true;

  // Interface B is the only one with a panel
  const panel = $('panel');
  panel.hidden = block.interface !== 'B';
  $('panel-empty').hidden = false;
  $('panel-body').hidden = true;

  show('screen-trial');
  state.view.invalidate();          // Leaflet must remeasure after layout change
  state.view.setView(trial.view);

  state.logger.startTrial({
    trial,
    interface: block.interface,
    block: state.blockIndex + 1,
    trialIndex: indexWithinBlock,
  });

  state.view.renderTrial(trial.candidates, block.interface, {
    onHoverEnter: (id, c) => state.logger.logEvent('hover_enter', { zoneId: id, lat: c.lat, lng: c.lng }),
    onHoverExit:  (id, c) => state.logger.logEvent('hover_exit',  { zoneId: id, lat: c.lat, lng: c.lng }),
    onClick:      (id, c) => state.logger.logEvent('click',       { zoneId: id, lat: c.lat, lng: c.lng }),
    onReveal: (id, props, latlng) => reveal(id, props, latlng, block.interface),
  });

  clearTimeout(state.timeoutId);
  state.timeoutId = setTimeout(() => endTrial(null, true), CONFIG.TRIAL_TIMEOUT_MS);
}

/** Show a zone's details — popup for A, side panel for B. Same content. */
function reveal(zoneId, props, latlng, iface) {
  if (iface === 'A') {
    state.logger.logEvent('popup_open', { zoneId, lat: latlng.lat, lng: latlng.lng });
    const popup = state.view.openPopup(latlng, detailsHtml(props));
    const el = popup.getElement();
    el?.querySelector('[data-select]')
      ?.addEventListener('click', () => endTrial(zoneId, false));
  } else {
    state.logger.logEvent('panel_update', { zoneId, lat: latlng.lat, lng: latlng.lng });
    $('panel-empty').hidden = true;
    $('panel-body').hidden = false;
    $('panel-title').textContent = `Zone ${props.zone_id}`;
    $('panel-fields').innerHTML = fieldsHtml(props);
    const btn = $('panel-select');
    btn.onclick = () => endTrial(zoneId, false);
  }
}

async function endTrial(responseZoneId, timedOut) {
  if (state.answered) return;       // guard against double submission
  state.answered = true;
  clearTimeout(state.timeoutId);

  const { trial, block } = state.current;
  const correct = timedOut ? false : responseZoneId === trial.target_zone_id;
  const isPractice = trial.logged === false;

  await state.logger.endTrial({ responseZoneId, correct, timedOut });

  state.view.clearTrial();

  // Feedback on practice only. Giving it on measured trials would let people
  // change strategy mid-block, which would contaminate the comparison.
  if (isPractice) {
    const fb = $('feedback');
    fb.hidden = false;
    fb.innerHTML = timedOut
      ? '<strong>Time ran out.</strong> In the real tasks, answer as quickly as you can.'
      : correct
        ? '<strong>Correct.</strong> That was the practice task — the real ones start now.'
        : `<strong>Not quite.</strong> The answer was zone ${trial.target_zone_id}. The real tasks start now.`;
    setTimeout(nextTrial, CONFIG.PRACTICE_FEEDBACK_MS);
  } else {
    nextTrial();
  }
}

/* ---------------- completion ---------------- */

async function finish() {
  await state.logger.completeSession();
  show('screen-done');
  try {
    renderResults({
      archive: state.logger.archive,
      zones: state.view.zones,
      plan: state.plan,
    });
  } catch (err) {
    // The results screen is a courtesy; never let it hide the fact that the
    // session itself completed and uploaded successfully.
    console.warn('[results] could not render:', err);
  }
}

boot().catch(err => fail(err.message));
