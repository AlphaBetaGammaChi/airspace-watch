#!/usr/bin/env python3
"""Poll adsb.lol for aircraft inside configured regions and append snapshots
to docs/data/snapshots/<region>/<YYYY-MM-DD>.jsonl.

Regions are configured in docs/data/regions.json:

    [
      {
        "name": "use-ne",
        "bbox": [south, west, north, east],
        "retention_days": 30
      }
    ]

bbox uses WGS84 decimal degrees. west > east means the box crosses the
antimeridian. The adsb.lol API only offers point+radius queries, so large
boxes are covered by a grid of circles and results filtered to the exact
rectangle before writing.
"""

import datetime
import json
import math
import pathlib
import sys
import time
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
DATA = ROOT / "docs" / "data"
REGIONS_FILE = DATA / "regions.json"
SNAPSHOTS = DATA / "snapshots"

API = "https://api.adsb.lol/v2/lat/{lat:.5f}/lon/{lon:.5f}/dist/{dist}"
MAX_RADIUS_NM = 240          # adsb.lol dist limit is ~250 nm; keep margin
NM_PER_DEG_LAT = 60.0
TIMEOUT = 30
KEEP = ("hex", "flight", "lat", "lon", "alt_baro", "alt_geom",
        "gs", "track", "r", "t", "squawk", "seen_pos")


def tiles_for_bbox(south, west, north, east):
    """Yield (center_lat, center_lon, radius_nm) circles covering the bbox.

    Handles antimeridian boxes by splitting on 180/-180.
    """
    lon_ranges = [(west, east)] if west <= east else [(west, 180.0), (-180.0, east)]
    tiles = []
    for w, e in lon_ranges:
        dlat, dlon = north - south, e - w
        lat_mid = math.radians((south + north) / 2.0)
        ny = max(1, math.ceil(dlat * NM_PER_DEG_LAT / (2 * MAX_RADIUS_NM)))
        nx = max(1, math.ceil(dlon * NM_PER_DEG_LAT * math.cos(lat_mid) / (2 * MAX_RADIUS_NM)))
        for iy in range(ny):
            for ix in range(nx):
                s2 = south + dlat * iy / ny
                n2 = south + dlat * (iy + 1) / ny
                w2 = w + dlon * ix / nx
                e2 = w + dlon * (ix + 1) / nx
                clat, clon = (s2 + n2) / 2.0, (w2 + e2) / 2.0
                r = NM_PER_DEG_LAT * math.hypot(
                    (n2 - s2) / 2.0, (e2 - w2) / 2.0 * math.cos(math.radians(clat)))
                tiles.append((clat, clon, min(MAX_RADIUS_NM, math.ceil(r))))
    return tiles


def in_bbox(lat, lon, south, west, north, east):
    if not (south <= lat <= north):
        return False
    if west <= east:
        return west <= lon <= east
    return lon >= west or lon <= east


def fetch_circle(lat, lon, dist):
    url = API.format(lat=lat, lon=lon, dist=dist)
    req = urllib.request.Request(url, headers={"User-Agent": "airspace-watch/1.0"})
    for attempt in (0, 1):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.load(resp)
        except Exception as exc:
            if attempt:
                print(f"  ! fetch failed {url}: {exc}", file=sys.stderr)
                return None
            time.sleep(2)
    return None


def poll_region(region):
    name = region["name"]
    south, west, north, east = region["bbox"]
    seen = {}
    for lat, lon, dist in tiles_for_bbox(south, west, north, east):
        body = fetch_circle(lat, lon, dist)
        if body and body.get("ac"):
            for ac in body["ac"]:
                alat, alon = ac.get("lat"), ac.get("lon")
                if alat is None or alon is None:
                    continue
                if in_bbox(alat, alon, south, west, north, east):
                    seen[ac["hex"]] = {k: ac.get(k) for k in KEEP}
        time.sleep(1.1)  # ~1 req/s rate limit

    now = datetime.datetime.now(datetime.timezone.utc)
    record = {"t": int(now.timestamp()), "ac": list(seen.values())}
    outdir = SNAPSHOTS / name
    outdir.mkdir(parents=True, exist_ok=True)
    outfile = outdir / (now.strftime("%Y-%m-%d") + ".jsonl")
    with outfile.open("a") as fh:
        fh.write(json.dumps(record, separators=(",", ":")) + "\n")
    print(f"{name}: {len(seen)} aircraft -> {outfile.relative_to(ROOT)}")


def prune(region):
    days = int(region.get("retention_days", 30))
    cutoff = datetime.date.today() - datetime.timedelta(days=days)
    outdir = SNAPSHOTS / region["name"]
    if not outdir.is_dir():
        return
    for f in outdir.glob("*.jsonl"):
        try:
            if datetime.date.fromisoformat(f.stem) < cutoff:
                f.unlink()
                print(f"{region['name']}: pruned {f.name}")
        except ValueError:
            continue


def main():
    regions = json.loads(REGIONS_FILE.read_text())
    for region in regions:
        poll_region(region)
        prune(region)


if __name__ == "__main__":
    main()
