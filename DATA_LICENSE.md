# Data license

> **This tool does not include, host, or redistribute any data.**
> `luftqualitaet-cli` is a *client*. It only accesses data served live by the
> **Umweltbundesamt (UBA)**. That data is the UBA's and is governed by **their**
> terms, summarized below. The license of this CLI's own source code is a separate
> matter — see [LICENSING.md](LICENSING.md).

| | |
|---|---|
| **Data provider** | Umweltbundesamt (UBA, German Environment Agency) |
| **API / source** | `https://www.umweltbundesamt.de/api/air_data/v3` → `https://luftdaten.umweltbundesamt.de/api/air-data/v3` |
| **Data license** | **Datenlizenz Deutschland – Namensnennung – Version 2.0 (`dl-de/by-2-0`)** |
| **License text** | https://www.govdata.de/dl-de/by-2-0 |
| **Attribution** | **Required** (3 elements — see below). |
| **Commercial use** | Allowed (`dl-de/by-2-0` permits commercial and non-commercial use). |
| **Redistribution / modification** | Permitted — copy, distribute, present, modify, pass to third parties — provided the Quellenvermerk is retained and any change disclosed. |

## Attribution

`dl-de/by-2-0` requires a Quellenvermerk with three elements: (1) the provider
name, (2) the license note + link, (3) a reference to the dataset. If you modified
the data, also state that.

```
Datenquelle: Umweltbundesamt,
Datenlizenz Deutschland – Namensnennung – Version 2.0 (dl-de/by-2-0),
https://www.govdata.de/dl-de/by-2-0 —
abgerufen über die UBA Air Data API (https://luftdaten.umweltbundesamt.de/api/air-data/v3)
```

## Notes & caveats

- The license is **not** restated inline on the v3 API doc page (which only links
  Impressum/Datenschutz); the binding `dl-de/by-2-0` designation comes from the
  official GDI-DE metadata record ("Luftdaten Deutschland API") and GovData entries.
- Current-year data is **provisional** ("vorläufig geprüft"); validated data is
  published in June of the following year.
- The API has since advanced to v4; v3 still resolves but is superseded.

## Sources

- https://gdk.gdi-de.org/geonetwork/srv/api/records/ef8e4f9a-029e-4ea9-ab94-f4c6f34a745a — GDI-DE record (`dl-de/by-2-0`)
- https://www.govdata.de/dl-de/by-2-0 — license text
- https://luftdaten.umweltbundesamt.de/api/air-data/v4/doc — current API docs

---

*Good-faith summary compiled 2026-06-16; not legal advice. The provider's terms
are authoritative and can change — verify at the source before relying on the
data, especially for any commercial or redistribution use.*
