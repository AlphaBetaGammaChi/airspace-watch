# Airspace Watch

A static website (GitHub Pages) that logs which aircraft pass through a
spatial bounding box over time, plus a "who's in the box now" live mode.

- **Data source:** [adsb.lol](https://adsb.lol) — free, keyless,
  ADSBExchange-compatible API (data under ODbL). ~1 req/s rate limit.
- **Recorder:** a GitHub Actions cron job (`poll.yml`) polls the configured
  regions every ~5 minutes and commits snapshots to `docs/data/snapshots/`.
- **Frontend:** `docs/` — Leaflet map, draw a bounding box, pick a time
  window, get the list of flights that transited (grouped into "transits"
  per ICAO24 with 15-min gap splitting), click a row for the track, export CSV.

## Deploy

1. Push this repo to GitHub.
2. Settings → Pages → Source: **Deploy from a branch** → `main` / `docs`.
3. Actions should be enabled by default; the `Poll ADS-B snapshots` workflow
   runs every 5 min. You can trigger it manually via *Run workflow*.
4. Edit `docs/data/regions.json` to set the region(s) you want recorded:

   ```json
   [
     {
       "name": "my-region",
       "bbox": [south, west, north, east],
       "retention_days": 30
     }
   ]
   ```

   `west > east` crosses the antimeridian. Large boxes are automatically
   tiled into ≤240 nm circles (the adsb.lol query limit).

## Caveats

- **Recording only starts when you deploy.** There is no retroactive public
  API for "who was in this box"; the Action builds history going forward.
  For backfill, adsb.lol publishes daily trace archives — not wired in here.
- GitHub's `schedule` has jitter (runs may start minutes late or be skipped
  under load). Transits are reconstructed from ~5-min samples; fast
  crossings of small boxes can be missed entirely.
- ADS-B coverage depends on ground receivers — oceanic/remote gaps exist.
- The drawn query box only returns results where it overlaps a recorded
  region (shown as dashed rectangles on the map).
- To use OpenSky instead: it's OAuth2-only now and credits-limited; credentials
  would go in repo secrets and `scripts/poll.py` would need an OpenSky branch.
  FlightRadar24 has no free API.

## Local dev

```sh
python3 scripts/poll.py           # fetch one snapshot per region
python3 -m http.server -d docs    # serve the site at :8000
```
