# airspace-watch codebase map

Static website (GitHub Pages) logging which aircraft pass through a
spatial bounding box over time, plus a "who's in the box now" live mode.
Data: adsb.lol (free, keyless, ~1 req/s).

## Layout

```
airspace-watch/
├── scripts/
│   └── poll.py           # recorder: polls configured regions, writes
│                         #   snapshot JSON (run by GitHub Actions cron ~5 min)
├── docs/                 # the Pages site (deploy from main/docs)
│   ├── index.html        #   Leaflet map UI
│   ├── app.js            #   draw bbox → list transits grouped per ICAO24
│   │                     #   (15-min gap splitting), click → track, CSV export
│   ├── style.css
│   └── data/
│       ├── regions.json  #   regions being recorded (edit this)
│       └── snapshots/    #   committed poll outputs
└── .github/workflows     # poll.yml cron
```

## Deploy

Push to GitHub → Pages source `main`/`docs` → Actions `poll.yml` runs
every ~5 min and commits snapshots to `docs/data/snapshots/`.
