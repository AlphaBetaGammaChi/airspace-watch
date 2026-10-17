/* Airspace Watch — query ADS-B snapshots logged by the repo's GitHub Action,
 * plus a live "who's in the box now" mode against the adsb.lol API. */

"use strict";

const map = L.map("map", { worldCopyJump: true }).setView([41, -75], 6);
L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 18,
  attribution: "&copy; OpenStreetMap contributors",
}).addTo(map);

const drawnLayer = new L.LayerGroup().addTo(map);
const regionLayer = new L.LayerGroup().addTo(map);
const trackLayer = new L.LayerGroup().addTo(map);
let queryBox = null; // {south, west, north, east}
let lastTransits = [];

const $ = (id) => document.getElementById(id);
const status = (msg, isError) => {
  $("status").textContent = msg;
  $("status").classList.toggle("error", !!isError);
};

// ---------- drawing ----------

const drawControl = new L.Control.Draw({
  draw: { rectangle: true, polygon: false, polyline: false, circle: false,
          marker: false, circlemarker: false },
  edit: { featureGroup: drawnLayer },
});
map.addControl(drawControl);

map.on(L.Draw.Event.CREATED, (e) => {
  drawnLayer.clearLayers();
  drawnLayer.addLayer(e.layer);
  setBox(e.layer.getBounds());
});

map.on("draw:deleted", () => setBox(null));

function setBox(bounds) {
  if (!bounds) {
    queryBox = null;
    $("box-info").textContent = "no box drawn";
    $("clear-box").disabled = true;
    return;
  }
  queryBox = {
    south: bounds.getSouth(), west: bounds.getWest(),
    north: bounds.getNorth(), east: bounds.getEast(),
  };
  const f = (v) => v.toFixed(3);
  $("box-info").textContent =
    `lat ${f(queryBox.south)}..${f(queryBox.north)}  ` +
    `lon ${f(queryBox.west)}..${f(queryBox.east)}`;
  $("clear-box").disabled = false;
}

$("draw-box").onclick = () => new L.Draw.Rectangle(map).enable();
$("clear-box").onclick = () => { drawnLayer.clearLayers(); setBox(null); };

function inBox(lat, lon, box) {
  if (lat < box.south || lat > box.north) return false;
  if (box.west <= box.east) return lon >= box.west && lon <= box.east;
  return lon >= box.west || lon <= box.east; // antimeridian
}

// ---------- recorded regions ----------

async function loadRegions() {
  try {
    const regions = await (await fetch("data/regions.json")).json();
    const sel = $("regions");
    regions.forEach((r, i) => {
      const [s, w, n, e] = r.bbox;
      L.rectangle([[s, w], [n, e]],
        { color: "#555", weight: 1, dashArray: "6 6", fill: false })
        .bindTooltip(`recording: ${r.name}`)
        .addTo(regionLayer);
      const opt = document.createElement("option");
      opt.value = r.name;
      opt.textContent = r.name;
      opt.selected = i === 0;
      sel.appendChild(opt);
    });
  } catch (err) {
    status("could not load data/regions.json", true);
  }
}

// ---------- snapshot log query ----------

function utcDatesBetween(t0, t1) {
  const dates = [];
  const d = new Date(Date.UTC(
    t0.getUTCFullYear(), t0.getUTCMonth(), t0.getUTCDate()));
  const end = Date.UTC(t1.getUTCFullYear(), t1.getUTCMonth(), t1.getUTCDate());
  for (; d.getTime() <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function fetchSnapshots(region, date) {
  const resp = await fetch(`data/snapshots/${region}/${date}.jsonl`);
  if (!resp.ok) return [];
  const text = await resp.text();
  return text.split("\n").filter(Boolean).map(JSON.parse);
}

$("query").onclick = async () => {
  if (!queryBox) return status("draw a box first", true);
  const regions = [...$("regions").selectedOptions].map((o) => o.value);
  if (!regions.length) return status("select at least one recorded region", true);
  const t0 = new Date($("t0").value), t1 = new Date($("t1").value);
  if (isNaN(t0) || isNaN(t1) || t1 <= t0)
    return status("invalid time range", true);

  trackLayer.clearLayers();
  status("fetching snapshots…");
  const dates = utcDatesBetween(t0, t1);
  const t0s = t0.getTime() / 1000, t1s = t1.getTime() / 1000;

  const sightings = new Map(); // hex -> [{t, lat, lon, alt, flight, type, reg}]
  let files = 0, empty = 0;
  for (const region of regions) {
    for (const date of dates) {
      const snaps = await fetchSnapshots(region, date);
      if (!snaps.length) { empty++; continue; }
      files++;
      for (const snap of snaps) {
        if (snap.t < t0s || snap.t > t1s) continue;
        for (const ac of snap.ac || []) {
          if (!inBox(ac.lat, ac.lon, queryBox)) continue;
          if (!sightings.has(ac.hex)) sightings.set(ac.hex, []);
          sightings.get(ac.hex).push({
            t: snap.t, lat: ac.lat, lon: ac.lon,
            alt: ac.alt_baro === "ground" ? 0 : (ac.alt_baro ?? ac.alt_geom),
            flight: (ac.flight || "").trim(), type: ac.t, reg: ac.r,
          });
        }
      }
    }
  }

  lastTransits = buildTransits(sightings);
  renderTable(lastTransits);
  status(`query done — ${files} data files, ${empty} missing, ` +
         `${lastTransits.length} transits`);
};

const TRANSIT_GAP_S = 15 * 60;

function buildTransits(sightings) {
  const transits = [];
  for (const [hex, pts] of sightings) {
    pts.sort((a, b) => a.t - b.t);
    let cur = [];
    for (const p of pts) {
      if (cur.length && p.t - cur[cur.length - 1].t > TRANSIT_GAP_S) {
        transits.push(makeTransit(hex, cur));
        cur = [];
      }
      cur.push(p);
    }
    if (cur.length) transits.push(makeTransit(hex, cur));
  }
  return transits.sort((a, b) => a.first - b.first);
}

function makeTransit(hex, pts) {
  const alts = pts.map((p) => p.alt).filter((a) => typeof a === "number");
  return {
    hex,
    callsign: [...pts].reverse().find((p) => p.flight)?.flight || "(none)",
    type: pts.find((p) => p.type)?.type || "",
    reg: pts.find((p) => p.reg)?.reg || "",
    first: pts[0].t, last: pts[pts.length - 1].t,
    minAlt: alts.length ? Math.min(...alts) : null,
    maxAlt: alts.length ? Math.max(...alts) : null,
    pts,
  };
}

// ---------- results ----------

const fmtTime = (s) =>
  new Date(s * 1000).toISOString().slice(5, 16).replace("T", " ") + "Z";

function renderTable(transits) {
  const tbody = $("results-table").querySelector("tbody");
  tbody.innerHTML = "";
  transits.forEach((tr, i) => {
    const row = tbody.insertRow();
    row.innerHTML =
      `<td>${esc(tr.callsign)}</td><td>${tr.hex}</td><td>${esc(tr.type)}</td>` +
      `<td>${esc(tr.reg)}</td><td>${fmtTime(tr.first)}</td>` +
      `<td>${fmtTime(tr.last)}</td>` +
      `<td>${tr.minAlt ?? "?"}–${tr.maxAlt ?? "?"}</td><td>${tr.pts.length}</td>`;
    row.onclick = () => showTrack(tr);
  });
  $("export").disabled = !transits.length;
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function showTrack(tr) {
  trackLayer.clearLayers();
  L.polyline(tr.pts.map((p) => [p.lat, p.lon]),
    { color: "#d40000", weight: 2 }).addTo(trackLayer);
  L.circleMarker([tr.pts[0].lat, tr.pts[0].lon],
    { radius: 4, color: "#007a00" }).addTo(trackLayer);
  L.circleMarker([tr.pts[tr.pts.length - 1].lat, tr.pts[tr.pts.length - 1].lon],
    { radius: 4, color: "#0000c8" }).addTo(trackLayer);
}

$("export").onclick = () => {
  const rows = [["callsign", "icao24", "type", "reg",
                 "first_seen_utc", "last_seen_utc", "min_alt_ft", "max_alt_ft"]];
  for (const tr of lastTransits) {
    rows.push([tr.callsign, tr.hex, tr.type, tr.reg,
               new Date(tr.first * 1000).toISOString(),
               new Date(tr.last * 1000).toISOString(),
               tr.minAlt ?? "", tr.maxAlt ?? ""]);
  }
  const csv = rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`)
                            .join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "transits.csv";
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- live mode ----------

$("live").onclick = async () => {
  if (!queryBox) return status("draw a box first", true);
  const clat = (queryBox.south + queryBox.north) / 2;
  const clon = (queryBox.west + queryBox.east) / 2;
  const dist = Math.min(250, Math.ceil(60 * Math.hypot(
    (queryBox.north - queryBox.south) / 2,
    (queryBox.east - queryBox.west) / 2 * Math.cos(clat * Math.PI / 180))));
  status("querying adsb.lol…");
  try {
    const resp = await fetch(
      `https://api.adsb.lol/v2/lat/${clat.toFixed(5)}/lon/${clon.toFixed(5)}/dist/${dist}`);
    const body = await resp.json();
    const pts = (body.ac || [])
      .filter((ac) => ac.lat != null && inBox(ac.lat, ac.lon, queryBox));
    const sightings = new Map();
    for (const ac of pts) {
      sightings.set(ac.hex, [{
        t: Math.floor(body.now / 1000), lat: ac.lat, lon: ac.lon,
        alt: ac.alt_baro === "ground" ? 0 : (ac.alt_baro ?? ac.alt_geom),
        flight: (ac.flight || "").trim(), type: ac.t, reg: ac.r,
      }]);
    }
    lastTransits = buildTransits(sightings);
    renderTable(lastTransits);
    status(`live: ${lastTransits.length} aircraft in box right now`);
  } catch (err) {
    status(`live query failed: ${err.message}`, true);
  }
};

// ---------- init ----------

(function init() {
  const now = new Date(), ago = new Date(now - 3600e3);
  const toLocal = (d) => new Date(d - d.getTimezoneOffset() * 60e3)
    .toISOString().slice(0, 16);
  $("t0").value = toLocal(ago);
  $("t1").value = toLocal(now);
  loadRegions();
})();
