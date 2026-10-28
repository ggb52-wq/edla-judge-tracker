# EDLA Analyzer

A static website that counts civil orders and written opinions by judge in the U.S. District Court for the Eastern District of Louisiana. The page computes every figure in the browser from the JSON files in `data/`.

## How it updates

`.github/workflows/update.yml` checks the feed about every 15 minutes around the clock (each run makes four passes about 15 minutes apart, then starts the next run). Each pass:

1. reads the court's public CM/ECF RSS feed;
2. lists new written opinions on GovInfo (USCOURTS collection) and, about twice a day, searches the CourtListener API for new order-type docket entries;
3. classifies, de-duplicates, and appends new civil rows to `data/orders.json`, `data/opinions.json`, and the other data files;
4. commits the data when it changed, or else only `data/status.json`. The site re-reads the data on its own, so new rows appear within minutes.

The workflow needs the repository secrets `COURTLISTENER_TOKEN` (a CourtListener API key) and `GOVINFO_API_KEY` (an api.data.gov key). `CLAUDE.md` describes every source and file in detail.

## Data files

| File | Rows |
|---|---|
| `data/orders.json` | civil orders: date, time (Central), judge initials, case, doc #, title, event, source |
| `data/opinions.json` | written opinions: date, judge, case, doc #, title, event, R&R / merits / Rule 12 / Rule 56 flags, source |
| `data/judges.json` | the 16 active district judges, PACER initials, first day on the bench |
| `data/calendar.json` | court holidays, start dates of each log, and the "through" date |
| `data/runs.json` | one row per update that added data |

Baseline: PACER Written Opinions Reports (Jan. 1, 2022, to Oct. 20, 2026, less Dec. 22 to 31, 2025) and PACER Docket Activity Report, civil orders (9/17–10/16/2026).

## Local work

```
python -m unittest discover tests     # offline test of the updater
python -m http.server 8000            # then open http://localhost:8000
```

Methodology and limits: `methodology.html`.
