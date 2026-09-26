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

function weaponRows(byWeapon) {
  const rows = Object.entries(byWeapon).sort((a, b) => b[1].fired - a[1].fired);
  const max = Math.max(1, ...rows.map(([, w]) => w.fired));
  return rows.map(([name, w]) => {
    const decided = w.hits + w.misses;
    return el("tr", {},
      el("td", {}, name),
      barCell(w.fired, max),
      el("td", { class: "num" }, n0(w.hits)),
      el("td", { class: "num" }, n0(w.misses)),
      el("td", { class: "num" }, n0(w.kills)),
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
    barCell(a.kills, max),
    el("td", { class: "num" }, n0(a.shotAt))));
}

function missionRows(missions) {
  return [...missions].reverse().map((m) => {
    const when = m.startedAt ? new Date(m.startedAt).toLocaleString()
      : m.modified ? new Date(m.modified * 1000).toLocaleString() : "—";
    const row = el("tr", { class: "click", title: "Open this debrief" },
      el("td", {}, m.title || m.key),
      el("td", {}, m.aircraft || "—"),
      el("td", {}, when),
      el("td", { class: "num" }, hours((m.duration || 0) / 3600)),
      el("td", { class: "num" }, n0(m.kills)),
      el("td", { class: "num" }, `${n0(m.hits)}/${n0(m.shots)}`),
      el("td", {}, m.lost ? "lost" : (m.grades || []).join(" ") || ""));
    row.onclick = () => { location.href = `/#rec=${m.key}`; };
    return row;
  });
}

function render(data) {
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

  box.append(el("h2", {}, "Totals"));
  box.append(el("div", { class: "cr-tiles" },
    tile("Missions", n0(t.missions), hours(t.hours)),
    tile("Kills", n0(t.kills), `${n0(t.airKills)} air · ${n0(t.groundKills)} ground`),
    tile("Accuracy", pct(t.accuracy), `${n0(t.hits)} hit of ${n0(t.decided)} decided`),
    tile("Shots fired", n0(t.shots), t.shots > t.decided ? `${n0(t.shots - t.decided)} undecided` : ""),
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
    box.append(table(["Weapon", "Fired", "Hit", "Missed", "Kills", "Accuracy"], weaponRows(t.byWeapon)));
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

  box.append(el("h2", {}, `Missions (${data.missions.length})`));
  box.append(table(["Mission", "Airframe", "When", "Length", "Kills", "Hits/shots", ""],
    missionRows(data.missions)));
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
