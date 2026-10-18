# EDLA Judge Tracker

A static website that counts civil orders and written opinions by judge in the U.S. District Court for the Eastern District of Louisiana. The page computes every figure in the browser from the JSON files in `data/`.

## How it updates

`.github/workflows/update.yml` runs `scripts/update.py` every 15 minutes on weekdays (7 AM to 9 PM Central) and every 3 hours on weekends. The script:

1. reads the court's public CM/ECF RSS feed;
2. queries the CourtListener API for new order-type docket entries (assigned judge, event type) and for documents flagged free on PACER (the Written Opinions Report);
3. classifies, de-duplicates, and appends new civil rows to `data/orders.json` and `data/opinions.json`;
4. commits only when one of those two files changed. GitHub Pages then republishes the site.

The workflow needs one repository secret, `COURTLISTENER_TOKEN`, holding a free CourtListener API key.

## Data files

| File | Rows |
|---|---|
| `data/orders.json` | civil orders: date, time (Central), judge initials, case, doc #, title, event, source |
| `data/opinions.json` | written opinions: date, judge, case, doc #, title, event, R&R / merits / Rule 12 / Rule 56 flags, source |
| `data/judges.json` | the 16 active district judges, PACER initials, first day on the bench |
| `data/calendar.json` | court holidays, start dates of each log, and the "through" date |
| `data/runs.json` | one row per update that added data |

Baseline: PACER Written Opinions Report (1/10–10/16/2026) and PACER Docket Activity Report, civil orders (9/17–10/16/2026).

## Local work

```
python -m unittest discover tests     # offline test of the updater
python -m http.server 8000            # then open http://localhost:8000
```

Methodology and limits: `methodology.html`.
