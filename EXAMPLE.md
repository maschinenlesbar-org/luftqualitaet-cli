# Examples

Real examples for the Claude Code skills of the `luftqualitaet` plugin, one per skill: a request,
the `luftqualitaet` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 6 October 2026, between 01:29 and 01:31 CEST, with
`luftqualitaet` 0.3.0.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [luftqualitaet-air-report](#luftqualitaet-air-report) · [luftqualitaet-annual-report](#luftqualitaet-annual-report) · [luftqualitaet-station-finder](#luftqualitaet-station-finder)

## luftqualitaet-air-report

> How has the air been at Leipzig-Mitte today?

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en     # "Leipzig-Mitte" -> station 1613
luftqualitaet --compact components --lang en
luftqualitaet --compact airquality --station 1613 --date-from 2026-10-06 --time-from 1 --date-to 2026-10-06 --time-to 24
luftqualitaet --compact airquality --station 1613 --date-from 2026-10-05 --time-from 1 --date-to 2026-10-05 --time-to 24
luftqualitaet --compact thresholds --use airquality --component 3
luftqualitaet --compact thresholds --use airquality --component 5
luftqualitaet --compact thresholds --use airquality --component 9
```

The request ran at 01:29 CEST (00:29 CET), so today had no hours yet: the first window came
back `"data": {}` with the CLI's note that an unknown station id looks the same. The id came
from the catalogue, so the skill stepped back a day, as it says. Its data went up to the hour
ending 20:00 CET. The skill fetched the O₃, NO₂ and PM₂,₅ bands to explain why an hour counted
as level 1 (PM₂,₅ on scope 6).

```
Air quality — Leipzig-Mitte (station 1613, traffic), 5 Oct 2026, hours ending 01:00–20:00 CET
  Today has no data yet (00:29 CET), so this is yesterday.
  Overall: VERY GOOD or GOOD all day — level 1 at most.
  Driving pollutant: NO₂ in the morning rush, 23–24 µg/m³ in the hours ending 07:00–09:00
    and 21 µg/m³ in those ending 11:00–12:00 (21–40 band = level 1);
    O₃ 70 µg/m³ in the hour ending 14:00 (61–120 band = level 1);
    PM₂,₅ 12 µg/m³ in the evening (11–20 band = level 1).
  9 h good, 8 h very good, 0 h moderate or worse.
  No hour is complete. Until 14:00 only O₃/NO₂ were reported, from 18:00 only PM₁₀/PM₂,₅,
  and the hours ending 15:00–17:00 are missing. Newest hour: ending 20:00 CET
  (21:00 local time), level 1, PM₁₀ 19 µg/m³, PM₂,₅ 12 µg/m³.
```

## luftqualitaet-annual-report

> Which stations had the most ozone exceedance days last year?

```bash
luftqualitaet --compact components --lang en                 # O₃ = component 3
luftqualitaet --compact annual-balances --component 3 --year 2025 --lang en
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

2025 is a completed year and its annual balance is out (UBA publishes it in June of the
following year), so the skill ranked on the annual balance, from UBA's final data, and not on
`transgressions`, the running year's preliminary table. It read `.headers` and ranked on
column `3`, "Number of days with highest daily 8-hour averages above 120 µg/m³"; 268 of the
275 rows have that figure.

```
Most ozone (O₃) exceedance days (highest daily 8-hour mean above 120 µg/m³), 2025
— annual balance (UBA, final data), top 11 of 268 stations
   1. 40 days  240   Schwarzwald-Süd, Münstertal       background · rural    · BW  (47.8099, 7.7645)
   2. 37 days  680   Kleiner Feldberg, Glashütten      background · rural    · HE  (50.2219, 8.4461)
   3. 36 days  656   Fürth/Odenwald                    background · rural    · HE  (49.6535, 8.8173)
   3. 36 days  679   Wasserkuppe                       background · rural    · HE  (50.4977, 9.9359)
   3. 36 days  1846  Neuhaus                           background · rural    · TH  (50.5000, 11.1346)
   6. 35 days  283   Karlsruhe-Nordwest                background · urban    · BW
   7. 34 days  289   Schwäbische Alb, Erpfingen        background · rural    · BW
   7. 34 days  1845  Dreißigacker                      background · rural    · TH
   7. 34 days  1948  Schauinsland, Oberried-Hofsgrund  background · rural    · UB
  10. 32 days  216   Mannheim-Nord                     background · suburban · BW
  10. 32 days  1454  Pfälzerwald-Hortenkopf            background · rural    · RP
  … 257 more
266 of 268 stations had at least one exceedance day; only Rostock-Holbeinplatz and Garz
had none. 41 stations had more than 25 days in 2025; the target value allows 25 days as a
3-year average (column 4), and 11 stations are above that.
Every top station is a background site, mostly rural, most in Baden-Württemberg and Hesse.
Ozone is the opposite of NO₂, which is worst at traffic stations.
```

Next steps offered: this year's count so far from `transgressions` (preliminary), or the same
ranking for 2024 to compare.

## luftqualitaet-station-finder

> Which air-quality stations are there in Leipzig? I'd like one for city-centre traffic and one for background air.

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
luftqualitaet --compact station-types --lang en
luftqualitaet --compact station-settings --lang en
```

Matching "Leipzig" as a substring of the station name also found "Leipziger Str." stations
in Frankfurt (Oder), Chemnitz and Berlin. The skill kept only stations whose city
(idx 3) is Leipzig. Coordinates are shown lat first. The API stores them lon first.

```
Stations in Leipzig (active):
  1613  Leipzig-Mitte          traffic    · urban    · SN  51.3442, 12.3772  Willy-Brandt-Platz/Am Hallischen Tor
  1665  Leipzig Lützner Str.   traffic    · urban    · SN  51.3359, 12.3347  Lützner Str. 34/36
  1647  Leipzig-West           background · suburban · SN  51.3179, 12.2974  Nikolai-Rumjanzew-Str. 100
Dropped 1 decommissioned station: 1670 Leipzig-Thekla (background, active until 2020-12-31).

City-centre traffic: 1613 Leipzig-Mitte. Background: 1647 Leipzig-West.
```

Next steps offered: today's air-quality index for 1613 or 1647 via **luftqualitaet-air-report**.
