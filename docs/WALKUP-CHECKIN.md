# Walk-up check-in (no GPS)

Phone-free logbook check-in for clubs: scan a QR on RowSafe → enter name → pick boat → **Start session**. Manager shows them **On water** with a **No GPS** note. **Stop session** on the same page ends the outing and writes it to the logbook.

## URLs

| Page | Path |
|------|------|
| Check-in form | `/walkup` or `/walkup.html?token=CLUB_TOKEN` |
| QR embed (RowSafe corner) | `/walkup-qr-embed.html?token=CLUB_TOKEN` |
| API | `GET/POST /api/walkup` |

Use the club’s existing ingest/org Bearer token in the query string (`token` or `k`). Prefer a club-specific token; do not put a shared master token on a public poster if you can avoid it.

## RowSafe (traccar-overlay)

RowSafe lives outside this repo (`rowsafe-map.html`). Add a bottom-right iframe:

```html
<iframe
  src="https://YOUR-CREWSIGHT-HOST/walkup-qr-embed.html?token=CLUB_TOKEN"
  title="Check in"
  style="position:fixed;right:0;bottom:0;width:140px;height:160px;border:0;z-index:9999;background:transparent"
></iframe>
```

## Behaviour

- Boat list = registered fleet devices (`rnz_devices`).
- Start creates `rnz_sessions` with `source=walkup` (no GPS samples).
- Open walk-up sessions appear in `GET /api/devices` as `online` + `noGps: true`.
- Logbook includes walk-up rows (distance shown as **No GPS**).
- One open walk-up per boat; starting again closes the previous open walk-up on that boat.
