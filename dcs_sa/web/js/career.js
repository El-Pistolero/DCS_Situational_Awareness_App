// The Career page: every mission DCS SA has analysed, added up.
//
// Records are written when a recording is opened, so the career grows as you
// review your flights.  Everything here is your own shots and kills, not the
// mission's, and it is grouped by DCS pilot profile.

import { el } from "./util.js";

const $ = (id) => document.getElementById(id);
const AIR = new Set(["fixedwing", "rotorcraft", "air"]);

const pct = (v) => (v == null ? "—" : `${Math.round(v * 100)}%`);
const n0 = (v) => (v == null ? "—" : Math.round(v).toLocaleString());
const hours = (h) => (!h ? "0" : h < 1 ? `${Math.round(h * 60)} min` : `${h.toFixed(1)} h`);

function tile(k, v, s) {
  return el("div", { class: "cr-tile" }, el("div", { class: "k" }, k), el("div", { class: "v" }, v),
    s ? el("div", { class: "s" }, s) : null);
}

function table(head, rows) {
  const t = el("table", { class: "cr" });
  t.append(el("thead", {}, el("tr", {}, ...head.map((h) => el("th", {}, h)))));
  const body = el("tbody");
  for (const r of rows) body.append(r);
  t.append(body);
  return t;
}

/** A right-aligned number with a proportional bar, so the big ones stand out. */
function barCell(value, max, text) {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 60)) : 2;
  return el("td", { class: "num" }, el("span", { class: "bar-cell" },
    el("span", {}, text ?? n0(value)), el("span", { class: "b", style: { width: `${w}px` } })));
}

// Everything on this page is a sum of individual shots; clicking a figure
// shows exactly which ones, and which mission each came from.
let DATA = null;

function missionOf(key) {
  return (DATA?.missions || []).find((m) => m.key === key);
}

/** Every shot and kill across the included missions, each tagged with its mission. */
function allEvents() {
  const out = [];
  for (const m of DATA?.missions || []) {
    if (m.included === false) continue;
    for (const e of m.events || []) out.push({ ...e, key: m.key, mission: m.title || m.key });
  }
  return out;
}

const clock = (t) => (t == null ? "—" : `${String(Math.floor(t / 60)).padStart(2, "0")}:${String(Math.floor(t % 60)).padStart(2, "0")}`);

function outcomeLabel(e) {
  if (e.outcome === "kill") return "kill";
  if (e.decoyed) return "flare";
  if (e.scored === "hit") return "hit";
  if (e.scored === "miss") return "miss";
  return e.outcome || "—";
}

/** Open the list behind a figure: what it counted, and where each came from. */
function drill(title, filter, note) {
  const rows = allEvents().filter(filter);
  const box = document.getElementById("drill");
  box.innerHTML = "";
  box.classList.remove("hidden");
  box.append(el("div", { class: "dr-head" },
    el("h3", {}, title),
    el("span", { class: "muted" }, `${rows.length} ${rows.length === 1 ? "entry" : "entries"}`),
    el("span", { class: "sp" }),
    el("button", { onclick: () => box.classList.add("hidden") }, "Close")));
  if (note) box.append(el("p", { class: "cr-note" }, note));
  if (!rows.length) {
    box.append(el("p", { class: "muted" }, "Nothing counted towards this yet."));
  } else {
    const t = table(["Time", "Weapon", "Target", "Result", "Mission", ""],
      rows.map((e) => el("tr", {},
        el("td", { class: "num" }, clock(e.t)),
        el("td", {}, e.weapon || "—"),
        el("td", {}, e.target || "—"),
        el("td", {}, el("span", { class: `dr-res r-${outcomeLabel(e)}` }, outcomeLabel(e))),
        el("td", { class: "muted" }, e.mission),
        el("td", {}, el("button", { class: "linklike",
          onclick: () => { location.href = `/#rec=${e.key}`; } }, "View")))));
    box.append(t);
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

/** A figure you can click, with the list it stands for. */
function clickable(text, title, filter, note) {
  return el("button", { class: "figure", title: "Show what this counted",
    onclick: () => drill(title, filter, note) }, text);
}

function weaponRows(byWeapon) {
  const rows = Object.entries(byWeapon).sort((a, b) => b[1].fired - a[1].fired);
  const max = Math.max(1, ...rows.map(([, w]) => w.fired));
  return rows.map(([name, w]) => {
    const decided = w.hits + w.misses;
    const of = (f) => (e) => e.weapon === name && e.outcome !== "kill" && f(e);
    return el("tr", {},
      el("td", {}, name),
      el("td", { class: "num" }, el("span", { class: "bar-cell" },
        clickable(n0(w.fired), `${name}: every shot`, of(() => true)),
        el("span", { class: "b", style: { width: `${Math.max(2, Math.round((w.fired / max) * 60))}px` } }))),
      el("td", { class: "num" }, clickable(n0(w.hits), `${name}: hits`, of((e) => e.scored === "hit"))),
      el("td", { class: "num" }, clickable(n0(w.misses), `${name}: misses`, of((e) => e.scored === "miss"))),
      el("td", { class: "num" }, clickable(n0(w.kills), `${name}: kills`, (e) => e.weapon === name && e.outcome === "kill")),
      el("td", { class: "num" }, clickable(n0(w.decoyed || 0), `${name}: went for a flare`,
        of((e) => e.decoyed), "These are estimates: the missile's predicted miss to a flare dropped well below its predicted miss to the jet.")),
      el("td", { class: "num" }, decided ? pct(w.hits / decided) : "—"));
  });
}

function againstRows(against, onlyAir) {
  const rows = Object.entries(against)
    .filter(([, a]) => (onlyAir ? AIR.has(a.category) : !AIR.has(a.category)))
    .sort((a, b) => b[1].kills - a[1].kills || b[1].shotAt - a[1].shotAt);
  const max = Math.max(1, ...rows.map(([, a]) => a.kills));
  return rows.map(([name, a]) => el("tr", {},
    el("td", {}, name),
    el("td", { class: "num" }, el("span", { class: "bar-cell" },
      clickable(n0(a.kills), `${name}: kills`, (e) => e.target === name && e.outcome === "kill"),
      el("span", { class: "b", style: { width: `${Math.max(2, Math.round((a.kills / max) * 60))}px` } }))),
    el("td", { class: "num" }, clickable(n0(a.shotAt), `${name}: shots at it`,
      (e) => e.target === name && e.outcome !== "kill"))));
}

function missionRows(missions, reload) {
  return [...missions].reverse().map((m) => {
    const when = m.startedAt ? new Date(m.startedAt).toLocaleString()
      : m.modified ? new Date(m.modified * 1000).toLocaleString() : "—";
    const included = m.included !== false;
    // Untick a mission to leave it out of every figure above: a coop sortie,
    // a test flight, someone else's jet.
    const tick = el("input", { type: "checkbox", checked: included, title: "Count this mission in the totals",
      onclick: (e) => e.stopPropagation(),
      onchange: async (e) => {
        const want = e.target.checked;
        try {
          await fetch("/api/career/include", { method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ key: m.key, included: want }) });
          reload();
        } catch { e.target.checked = !want; }
      } });
    const row = el("tr", { class: `click${included ? "" : " off"}` },
      el("td", {}, el("label", { class: "mi-tick", onclick: (e) => e.stopPropagation() }, tick)),
      el("td", {}, m.title || m.key),
      el("td", {}, m.aircraft || "—"),
      el("td", {}, when),
      el("td", { class: "num" }, hours((m.duration || 0) / 3600)),
      el("td", { class: "num" }, n0(m.kills)),
      el("td", { class: "num" }, `${n0(m.hits)}/${n0(m.shots)}`),
      el("td", {}, m.lost ? "lost" : (m.grades || []).join(" ") || ""),
      el("td", {},
        el("button", { class: "linklike", onclick: (e) => { e.stopPropagation(); missionDetail(m); } }, "Detail"),
        el("button", { class: "linklike", onclick: (e) => { e.stopPropagation(); location.href = `/#rec=${m.key}`; } }, "View")));
    row.onclick = () => missionDetail(m);
    return row;
  });
}

/** One mission opened up: every shot it contributed, and what the app logged reading it. */
function missionDetail(m) {
  const box = document.getElementById("drill");
  box.innerHTML = "";
  box.classList.remove("hidden");
  box.append(el("div", { class: "dr-head" },
    el("h3", {}, m.title || m.key),
    el("span", { class: "muted" }, `${m.aircraft || "?"} · ${hours((m.duration || 0) / 3600)}`
      + (m.included === false ? " · not counted" : "")),
    el("span", { class: "sp" }),
    el("button", { onclick: () => { location.href = `/#rec=${m.key}`; } }, "View mission"),
    el("button", { onclick: () => box.classList.add("hidden") }, "Close")));

  const events = m.events || [];
  if (events.length) {
    box.append(table(["Time", "Weapon", "Target", "Result"], events.map((e) => el("tr", {},
      el("td", { class: "num" }, clock(e.t)),
      el("td", {}, e.weapon || "—"),
      el("td", {}, e.target || "—"),
      el("td", {}, el("span", { class: `dr-res r-${outcomeLabel(e)}` }, outcomeLabel(e)))))));
  } else {
    box.append(el("p", { class: "muted" }, "No shots recorded in this mission."));
  }

  const log = m.log || [];
  box.append(el("h4", { class: "dr-sub" }, "What DCS SA logged reading this mission"));
  if (!log.length) {
    box.append(el("p", { class: "muted" }, "Nothing was logged. This mission was recorded before logs were kept; reopen it to capture one."));
  } else {
    const pre = el("div", { class: "con-body dr-log" });
    for (const r of log) {
      pre.append(el("div", { class: `con-row lvl-${(r.level || "info").toLowerCase()}` },
        el("span", { class: "con-lv" }, r.level === "WARNING" ? "WARN" : (r.level || "").slice(0, 5)),
        el("span", { class: "con-src" }, r.source || ""),
        el("span", { class: "con-msg" }, r.message || "")));
    }
    box.append(pre);
  }
  box.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function render(data) {
  DATA = data;
  const box = $("career");
  box.innerHTML = "";
  const t = data.totals;
  if (!t.missions) {
    box.append(el("div", { class: "cr-empty" },
      el("p", {}, "No missions recorded yet."),
      el("p", { class: "muted" },
        "Open a flight from the recordings list and it is added here. Demo flights count too, so you can see what this page looks like.")));
    return;
  }

  const isShot = (e) => e.outcome !== "kill";
  box.append(el("h2", {}, "Totals"));
  box.append(el("div", { class: "cr-tiles" },
    tile("Missions", n0(t.missions), hours(t.hours)),
    tile("Kills", clickable(n0(t.kills), "Every kill", (e) => e.outcome === "kill"),
      `${n0(t.airKills)} air · ${n0(t.groundKills)} ground`),
    tile("Accuracy", clickable(pct(t.accuracy), "Every decided shot", (e) => isShot(e) && e.scored),
      `${n0(t.hits)} hit of ${n0(t.decided)} decided`),
    tile("Shots fired", clickable(n0(t.shots), "Every shot", isShot),
      t.shots > t.decided ? `${n0(t.shots - t.decided)} undecided` : ""),
    tile("Decoyed", clickable(n0(Object.values(t.byWeapon).reduce((a, w) => a + (w.decoyed || 0), 0)),
      "Shots that went for a flare", (e) => isShot(e) && e.decoyed,
      "Estimates: the missile's predicted miss to a flare dropped well below its predicted miss to the jet."),
      "went for a flare"),
    tile("Guns", n0(t.guns.rounds), `${n0(t.guns.bursts)} bursts · ${n0(t.guns.kills)} kills`),
    tile("Lost", n0(t.losses), t.losses ? "times shot down" : "never shot down")));
  box.append(el("p", { class: "cr-note" },
    "Against aircraft only a kill counts as a hit: a jet that flew home is not one you shot down. "
    + "Against ground and ships, damage counts. Shots still in flight when the recording ended are left out "
    + "rather than counted as misses."));

  const air = againstRows(t.against, true);
  if (air.length) {
    box.append(el("h2", {}, "Against aircraft"));
    box.append(table(["Type", "Killed", "Shot at"], air));
  }
  const ground = againstRows(t.against, false);
  if (ground.length) {
    box.append(el("h2", {}, "Against ground and ships"));
    box.append(table(["Type", "Killed", "Shot at"], ground));
  }

  if (Object.keys(t.byWeapon).length) {
    box.append(el("h2", {}, "By weapon"));
    box.append(table(["Weapon", "Fired", "Hit", "Missed", "Kills", "Flare", "Accuracy"], weaponRows(t.byWeapon)));
  }

  const jets = Object.entries(t.byAircraft).sort((a, b) => b[1].missions - a[1].missions);
  if (jets.length > 1) {
    box.append(el("h2", {}, "By airframe"));
    box.append(table(["Airframe", "Missions", "Hours", "Kills", "Shots"],
      jets.map(([name, a]) => el("tr", {},
        el("td", {}, name),
        el("td", { class: "num" }, n0(a.missions)),
        el("td", { class: "num" }, hours(a.hours)),
        el("td", { class: "num" }, n0(a.kills)),
        el("td", { class: "num" }, n0(a.shots))))));
  }

  if (Object.keys(t.grades).length) {
    box.append(el("h2", {}, "Landing grades"));
    box.append(el("div", { class: "cr-tiles" },
      ...Object.entries(t.grades).map(([g, c]) => tile(`Grade ${g}`, n0(c)))));
  }

  const counted = data.missions.filter((m) => m.included !== false).length;
  box.append(el("h2", {}, `Missions (${data.missions.length})`));
  box.append(el("p", { class: "cr-note" },
    `Untick a mission to leave it out of every figure above. ${counted} of ${data.missions.length} counted.`));
  box.append(table(["", "Mission", "Airframe", "When", "Length", "Kills", "Hits/shots", "", ""],
    missionRows(data.missions, () => load(data.profile))));
}

async function load(profile) {
  try {
    const res = await fetch(`/api/career?profile=${encodeURIComponent(profile || "all")}`);
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const sel = $("profile");
    if (sel.options.length !== data.profiles.length + 1) {
      sel.innerHTML = "";
      sel.append(el("option", { value: "all" }, "All pilots"));
      for (const p of data.profiles) sel.append(el("option", { value: p }, p));
      // Default to the pilot DCS says is flying, when the career holds them.
      const want = profile || (data.profiles.includes(data.current) ? data.current : "all");
      sel.value = want;
      if (want !== (profile || "all")) return load(want);
    }
    render(data);
  } catch (err) {
    $("career").innerHTML = "";
    $("career").append(el("div", { class: "cr-empty" }, `Could not load the career: ${err.message}`));
  }
}

$("back").onclick = () => { location.href = "/"; };
$("profile").onchange = (e) => load(e.target.value);
load(null);
