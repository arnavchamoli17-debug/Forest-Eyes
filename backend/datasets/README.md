# Datasets

Real data used by the Earth Intelligence Platform, exported for the demo places in `places.csv`.
Regenerate with `node scripts/export-datasets.js`. Retrieved: 2026-10-15T13:50:44.483Z.

The live app queries the same sources on demand for any place on Earth; these files are snapshots.

| File | Rows | Source | Licence / terms |
|---|---|---|---|
| `hydrorivers_reaches_demo.csv` | 377 | HydroRIVERS v1.0 (HydroSHEDS): river reaches within 50 km (catchment >= 1000 km2; >= 100 km2 in the India region). The full network (998,251 reaches: 905,279 worldwide + 92,972 extra in the India region) is in `data/hydrorivers.bin` + `data/hydrorivers_geom.bin`, built by `scripts/build-rivers.py`. India soil grid: `data/soil_india.bin` (`scripts/build-soil-india.py`). | HydroSHEDS licence, attribution required |
| `tree_cover_loss_demo.csv` | 72 | Tree cover loss 2021-2024, natural forest, 10 km box (UMD / Hansen et al., via Global Nature Watch analytics API) | CC BY 4.0 |
| `river_discharge_glofas_demo.csv` | 6660 | GloFAS v4 daily river discharge (Copernicus Emergency Management Service) via Open-Meteo Flood API | CC BY 4.0 |
| `earthquakes_usgs_demo.csv` | 59 | USGS ComCat earthquakes M5+ within 150 km since 1970 | Public domain |

Also used live (not exported): ISRIC SoilGrids 2.0 (CC BY 4.0), AWS Terrain Tiles (various open DEMs),
Esri World Imagery (attribution required), Open-Meteo weather (CC BY 4.0).

## Deforestation rating (Forest Eyes)

The severity card rates the **annual deforestation rate**: tree cover lost 2001-2024 (UMD/Hansen, >=30 % canopy, via the
GFW Data API or Global Nature Watch) as a share of the tree cover in 2000 in the same box, compound form
r = 100 / t x ln(A2000 / (A2000 - loss)) (Puyravaud 2003). Scale: low < 0.3, mid 0.3-1.0, high 1.0-2.0, very high > 2.0 %/yr
(project thresholds). Tree cover in 2000 is counted from GFW's `umd_tree_cover_density_2000/v1.8/tcd_30` map tiles at zoom 12
(`forest-extent.js`, an estimate; coarser zooms overcount by 6-12 %, so they are not used up to a 50 km radius).

## Forest Eyes tree planner ("Which trees can grow here?")

| Data | What it is used for | Source / terms |
|---|---|---|
| `data/tree-species.json` (92 trees) | Each tree's temperature, rainfall, soil pH, texture and light ranges, growing-season length and killing temperature | FAO ECOCROP, as packaged in the Recocrop R package (Hijmans, github.com/cropmodels/Recocrop, GPL-3). Built by `scripts/build-tree-species.py` from `inst/parameters/ecocrop.rds`. The package notes the values are expert opinion, not field-validated optima. Species list and English/Indian names are ours. |
| ERA5 reanalysis, last 5 full years (live) | Monthly temperature, winter lows; sunshine hours from solar radiation (FAO-56 Angstrom-Prescott, a = 0.25, b = 0.50); rainfall only where CHPclim has no land cell | Copernicus Climate Change Service / ECMWF, via the Open-Meteo archive API (`models=era5_seamless`), CC BY 4.0. |
| `data/rain_chpclim.bin` | Annual rainfall (long-term mean): India region at 0.05°, world at 0.1° (`rainfall.js`) | CHPclim v1, Climate Hazards Group, UC Santa Barbara (satellite + rain-gauge climatology), data.chc.ucsb.edu/products/CHPclim/v1. Built by `scripts/build-rainfall.py` from the 12 monthly GeoTIFFs. Replaces ERA5 rainfall, which was far off at town scale (2021-2025 ERA5 vs CHPclim: Srinagar 2673 vs 699 mm, Pune 1454 vs 798, Dehradun 1350 vs 1734). Users can still enter their own value. |
| NASA POWER daily, last 5 full years (live, fallback 1) | Same figures as ERA5 when ERA5 (Open-Meteo) does not answer; temperatures moved to the point's altitude (standard lapse rate, 6.5 °C/km) because the ~50 km grid cell can sit hundreds of metres off (Dehradun: cell 1404 m, town 652 m) | NASA Langley Research Center POWER Project (MERRA-2 reanalysis; radiation CERES/MERRA-2), power.larc.nasa.gov, `community=AG`. Free, no key. |
| `data/climate_worldclim.bin` | (1) Seasons for planting advice: dry month = rain (mm) ≤ 2 × mean temperature (°C), Bagnouls–Gaussen; (2) fallback 2, offline, when ERA5 and NASA POWER both fail: monthly temperatures, coldest-month nights, sunshine. No daily record, so frost is only checked one way (an average night below the frost-kill temperature fails the tree; otherwise it is marked "not checked") | WorldClim 2.1, 1970-2000 monthly normals (Fick & Hijmans 2017), CC BY 4.0, geodata.ucdavis.edu/climate/worldclim/2_1/base (10 arc-minute files). Built by `scripts/build-climate-worldclim.py`: India region at 10′, world at 0.5°, plus the world 10′ elevation as the altitude reference offline. |
| `data/soil_global.bin` | Soil pH and texture outside India when the SoilGrids API fails or has no soil at the exact point (towns, water): average over a 0.2° (~22 km) cell, labelled as such | ISRIC SoilGrids 2.0 aggregated to 5 km (files.isric.org/soilgrids/latest/data_aggregated/5000m), CC BY 4.0, reprojected to 0.2° by averaging. Built by `scripts/build-soil-global.py`. |
| `data/tree-native.json` | Native / introduced status of each tree by TDWG region ("Native here", "Introduced here", "Not recorded here") | Kew *World Checklist of Vascular Plants* (WCVP), read through GBIF (dataset f382f0ce-323a-4091-bb9f-add557f3a9a2), CC BY 4.0. Built by `scripts/build-native-ranges.js`. |
| `data/tdwg-level3.geojson` | Which TDWG botanical region a point is in (`tdwg.js`) | TDWG *World Geographical Scheme for Recording Plant Distributions*, level 3 (github.com/tdwg/wgsrpd). The repository states no licence; widely used for WCVP/POWO data. |
| `data/tree-traits/*.json` | Extra trees and traits added by the team, every value with source, page and quote, checked by a person | See `data/tree-traits/README.md`; checked with `scripts/check-tree-traits.js`. |
| CAMS global, last 365 days (live) | O3 (AOT40, daylight hours, worst 6 months), SO2 (annual and winter half-year means), NOx (NO2 + NO as NO2) | Copernicus Atmosphere Monitoring Service via the Open-Meteo air-quality API, modelled (~40 km). |
| Critical levels for vegetation | SO2 20 ug/m3 (forests, Table 3.1), NOx 30 ug/m3 annual (Table 3.2), O3 AOT40 5 ppm h for trees (Table 3.17) | UNECE CLRTAP *Manual on Methodologies and Criteria for Modelling and Mapping Critical Loads and Levels*, chapter 3 (German Environment Agency, Texte 123/2024). |

**Validation** (`scripts/validate-tree-fit.js`, 2026-10-28, CHPclim rainfall): RECALL = of the checked trees with ≥3
GBIF records near a place (30 km; 10 km for hill towns), the share the app accepts as able to grow there.
- 9 "tuned" places (used to adjust the frost and sunshine rules): 87 % (136/157); the app accepted 2–68 of 92 trees per place.
- 5 "holdout" places, not looked at while tuning (Pune, Bhopal, Guwahati, Srinagar, Chennai): 76 % (82/108).
  Their misses led to the soil-texture change above, so a 5-place "fresh" set (Hyderabad, Lucknow, Ahmedabad,
  Ranchi, Thiruvananthapuram) is in the script for an unbiased figure; re-run it to get that number.
Most remaining misses are city trees that need more rain than the place gets (kadam, saptaparni in Delhi and Pune:
planted and watered) or planted non-natives (teak in Dehradun). Precision is not measured (absence from GBIF is weak
evidence, and GBIF city records include planted trees). One run uses many Open-Meteo calls: run it at most once an hour.

Our own choices (documented in `frontend/forest-eyes/tree-fit.js`): sunshine hours per ECOCROP light class
(very bright 7, clear skies 5, cloudy skies 3, light shade 1.5, heavy shade 0 h/day); modelled soil pH up to 0.5
outside a tree's range counts as "with care", not "unsuitable"; ECOCROP's killing temperature of 0 means "no input"
and is treated as unknown. Three rules were changed after validation showed them rejecting trees that grow there:
a tree Kew records as native in the place's region is not ruled out by ECOCROP's frost limit when a normal winter is
at most 3 °C colder than it (banj oak, horse chestnut at Shimla); sunshine never rules a tree out (the hours
conversion is uncalibrated; wild cherry in London); soil texture never rules a tree out (banyan, shisham, mahua on
the Deccan's clay). Team trees: up to 15 % beyond the recorded rainfall and 2 °C beyond the recorded mean
temperature is "with care"; a normal winter more than 5 °C below the lowest recorded temperature rules it out.

## Citations
- Lehner, B., Grill, G. (2013). Global river hydrography and network routing: baseline data and new approaches to study the world's large river systems. *Hydrological Processes*, 27(15), 2171-2186.
- Hansen, M. C. et al. (2013). High-resolution global maps of 21st-century forest cover change. *Science*, 342(6160), 850-853.
- Harrigan, S. et al. (2020). GloFAS-ERA5 operational global river discharge reanalysis 1979-present. *Earth System Science Data*, 12, 2043-2060.
- Poggio, L. et al. (2021). SoilGrids 2.0: producing soil information for the globe with quantified spatial uncertainty. *SOIL*, 7, 217-240.
- Allen, R. G., Pereira, L. S., Raes, D., Smith, M. (1998). *Crop evapotranspiration*. FAO Irrigation and Drainage Paper 56. FAO, Rome.
- Funk, C. et al. (2015). A global satellite-assisted precipitation climatology. *Earth System Science Data*, 7, 275-287.
- Hersbach, H. et al. (2020). The ERA5 global reanalysis. *Quarterly Journal of the Royal Meteorological Society*, 146, 1999-2049.
- Puyravaud, J.-P. (2003). Standardizing the calculation of the annual rate of deforestation. *Forest Ecology and Management*, 177, 593-596.
- Govaerts, R. et al. (2021). The World Checklist of Vascular Plants, a continuously updated resource for exploring global plant diversity. *Scientific Data*, 8, 215.
- Hijmans, R. J. Recocrop: Estimating Environmental Suitability for Plants (R package, version 0.4-0). https://github.com/cropmodels/Recocrop
- Fick, S. E., Hijmans, R. J. (2017). WorldClim 2: new 1-km spatial resolution climate surfaces for global land areas. *International Journal of Climatology*, 37, 4302-4315.
- Gelaro, R. et al. (2017). The Modern-Era Retrospective Analysis for Research and Applications, Version 2 (MERRA-2). *Journal of Climate*, 30, 5419-5454.
- Bagnouls, F., Gaussen, H. (1957). Les climats biologiques et leur classification. *Annales de Géographie*, 66, 193-220.
- ISO 2533:1975, *Standard Atmosphere* (temperature lapse rate 6.5 K per km in the troposphere).
- UNECE (2024). *Manual on Methodologies and Criteria for Modelling and Mapping Critical Loads and Levels and Air Pollution Effects, Risks, and Trends*, chapter 3. German Environment Agency, Texte 123/2024.
