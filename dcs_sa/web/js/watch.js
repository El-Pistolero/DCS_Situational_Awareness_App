// "New recording" banner: notices when Tacview writes a new .acmi after a
// mission, parses it in the background and offers to open the debrief.

import { api, el, fmtClock } from "./util.js";

const POLL_MS = 15000;
const DISMISS_KEY = "dcs-sa.dismissedRecordings";
const pref = (k, d) => { try { return localStorage.getItem(`dcs-sa.${k}`) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem(`dcs-sa.${k}`, v); } catch { /* ignore */ } };

function dismissed() {
  try { return new Set(JSON.parse(sessionStorage.getItem(DISMISS_KEY) || "[]")); } catch { return new Set(); }
}
function dismiss(key) {
  const s = dismissed();
  s.add(key);
  try { sessionStorage.setItem(DISMISS_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
}

/**
 * host: element the banner is placed in; placement: "top" | "bottom".
 * openHere(key): open the debrief for a recording.
 * isIdle(): may a ready recording be opened without a click (auto-open)?
 * onNew(rec): called when a banner appears (e.g. to update a status line).
 */
export function watchRecordings({ host, placement = "top", openHere, isIdle = () => false, onNew = () => {} }) {
  let known = null;              // keys present at start (never announced)
  const pending = new Map();     // key -> size seen on the previous poll
  const banners = new Map();     // key -> banner element
  let busy = false;

  async function poll() {
    if (busy) return;
    busy = true;
    try {
      const { body } = await api("/api/recordings");
      const recs = body.recordings || [];
      if (!known) { known = new Set(recs.map((r) => r.key)); return; }
      const gone = dismissed();
      for (const r of recs) {
        if (known.has(r.key) || r.sample || gone.has(r.key) || banners.has(r.key)) continue;
        // Tacview may still be writing (or zipping) the file: wait until its
        // size is the same on two consecutive polls.
        const prev = pending.get(r.key);
        pending.set(r.key, r.size);
        if (prev === undefined || prev !== r.size) continue;
        pending.delete(r.key);
        known.add(r.key);
        announce(r);
      }
    } catch { /* app not reachable; try again later */ } finally { busy = false; }
  }

  function announce(r) {
    const title = el("span", { class: "ttl" }, `New recording: '${r.name}' · just now`);
    const open = el("button", { class: "primary", onclick: () => { close(); openHere(r.key); } }, "Open debrief");
    const auto = el("input", { type: "checkbox", checked: pref("autoOpenNew", "0") === "1",
      onchange: (e) => setPref("autoOpenNew", e.target.checked ? "1" : "0") });
    const box = el("div", { class: `banner ${placement}`, role: "status" },
      title, open, el("label", {}, auto, "Auto-open"),
      el("button", { class: "ghost", onclick: () => { dismiss(r.key); close(); } }, "Dismiss"));
    const close = () => { box.remove(); banners.delete(r.key); };
    banners.set(r.key, box);
    host.append(box);
    onNew(r);
    prewarm(r, title, open, close);
  }

  async function prewarm(r, title, open, close) {
    try {
      for (let i = 0; i < 300; i++) {
        const { body } = await api(`/api/recording/${r.key}/load`);
        if (body.state === "ready") break;
        if (body.state === "error") { title.textContent = `New recording: '${r.name}' (could not be read)`; return; }
        await new Promise((res) => setTimeout(res, 2000));
      }
      const { body: s } = await api(`/api/recording/${r.key}/summary`);
      if (!banners.has(r.key)) return;
      title.textContent = `New recording: '${s.title || r.name}' · ${fmtClock(s.duration)} · ${s.aircraftCount} aircraft`;
      open.textContent = "Open debrief ✓";
      if (pref("autoOpenNew", "0") === "1" && isIdle()) { close(); openHere(r.key); }
    } catch { /* leave the banner as it is */ }
  }

  poll();
  const timer = setInterval(poll, POLL_MS);
  window.addEventListener("focus", poll);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") poll(); });
  return { poll, stop: () => clearInterval(timer) };
}
