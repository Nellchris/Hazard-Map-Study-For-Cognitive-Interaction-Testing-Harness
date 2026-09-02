/* Study configuration.
 *
 * The anon key is public by design on a static site — Row Level Security
 * (insert-only) is what protects the data, not secrecy of this string.
 * See supabase_migration.sql.
 */
export const CONFIG = {
  SUPABASE_URL: 'https://koyfbydopxuyncgswzxj.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_n-2LCXKqV0jYMyTfifIyMg_8hQmup5i',

  CONTACT: 'mailto:you@example.com',

  // Versions are written to every session row, so a mid-study change to the
  // trials or the app can be identified and filtered during analysis.
  APP_VERSION: '1.0',
  TRIALS_VERSION: '1.0',

  MOVE_HZ: 10,              // mouse sampling rate
  TRIAL_TIMEOUT_MS: 120000, // 2 minutes, then the trial is recorded as timed out
  PRACTICE_FEEDBACK_MS: 2600,

  DATA: {
    trials: 'data/trials.json',
    zones: 'data/zones.geojson',
  },

  // Muted basemap so the uniform candidate colour stays dominant.
  TILES: {
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
};
