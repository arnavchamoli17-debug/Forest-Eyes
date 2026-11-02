#FOREST EYES

**Forest Eyes** (deforestation & 3D Earth) + **DATA**
(Analyzes satellite imagery together with terrain, rain, soil and forest data).

## Project structure

```
frontend/                 everything the browser loads (served as-is)
  index.html              shell: Forest Eyes with DATA toggle
  forest-eyes/            Forest Eyes app (map, 3D globe, Treeko assistant, "Which trees can grow here?" planner)
  DATA/                 DATA page
backend/                  Node.js server, no npm packages needed (Node 22+)
  server.js               HTTP server: serves frontend/ and every /api route
  gemma.js                shared AI client (Amazon Bedrock → Google AI Studio → backup model)
  hazard.js               DATA: gathers data + satellite image, asks AI model
  site.js                 site ground conditions: soil, earthquakes
  soil.js                 instant India soil lookups (SoilGrids grid)
  elevation.js            elevation from AWS Terrain Tiles
  forest-api.js           Forest Eyes API: Treeko chat + Global Forest Watch proxy
  forest-extent.js        tree cover in 2000 inside the analysis box (for the annual deforestation rate)
  trees.js                Forest Eyes tree planner: climate (ERA5), soil, air (CAMS) and per-tree reports
  tree-traits.js          team-sourced tree data (data/tree-traits/): validation and merge
  tdwg.js                 botanical region of a point, for Kew's native / introduced records
  rainfall.js             long-term annual rainfall (CHPclim grid, data/rain_chpclim.bin)
  data/                   India soil grid (SoilGrids) and tree requirements (FAO ECOCROP), prebuilt
  datasets/               real data exports for the demo places (CSV) + sources and licences
  scripts/                rebuild data/ and datasets/ from the original sources
```

## Run locally

```
copy .env.example .env      # then add your keys to .env (never commit it)
npm start                   # or: node backend/server.js
```
Open http://localhost:8080 — useful links: `#lens` (opens DATA).

## Deploy (Render, free)

`render.yaml` describes the service. Push this folder to GitHub, then on render.com:
**New → Blueprint →** pick the repository, paste the secret keys when asked, **Apply**.

## Keys (`.env`, or the host's environment settings)

| Variable | Needed for |
|---|---|
| `GEMINI_API_KEY` | AI model via Google AI Studio (Treeko, DATA) |
| `GFW_API_KEY` | Global Forest Watch tree-loss analysis in Forest Eyes (without it, Global Nature Watch is used) |
| `BEDROCK_API_KEY`, `BEDROCK_MODEL_ID`, `BEDROCK_REGION` | optional: Amazon Bedrock AI model, tried first |

## Data sources

ISRIC SoilGrids 2.0 ·
UMD / Hansen tree cover loss via Global Forest Watch / Global Nature Watch · USGS earthquake catalogue ·
AWS Terrain Tiles · Esri World Imagery · Open-Meteo weather · ERA5 reanalysis · NASA POWER (MERRA-2) · WorldClim 2.1 ·
CHPclim rainfall · CAMS air quality ·
Kew WCVP native ranges ·
FAO ECOCROP tree requirements (via Recocrop) · UNECE critical levels for vegetation. Details and citations: `backend/datasets/README.md`.

All results are screening estimates, not engineering or official hazard assessments.
