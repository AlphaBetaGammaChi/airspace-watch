# airspace-watch wiki

Logs aircraft transiting a bounding box — adsb.lol snapshots via GitHub
Actions cron + a Leaflet frontend on GitHub Pages.

- [CODEBASE_MAP.md](../CODEBASE_MAP.md) · [README.md](../README.md)
- Recorder: `scripts/poll.py` (cron); site: `docs/`; regions:
  `docs/data/regions.json`
- Transit grouping: per ICAO24, 15-min gap splitting; CSV export in UI.
