# Examples

Real examples for the Claude Code skills of the `luftqualitaet` plugin, one per skill: a request,
the `luftqualitaet` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `luftqualitaet` 0.0.6.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [luftqualitaet-air-report](#luftqualitaet-air-report) · [luftqualitaet-annual-report](#luftqualitaet-annual-report) · [luftqualitaet-station-finder](#luftqualitaet-station-finder)

## luftqualitaet-air-report

> How has the air been at Leipzig-Mitte today?

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en     # "Leipzig-Mitte" -> station 1613
luftqualitaet --compact components --lang en
luftqualitaet --compact airquality --station 1613 --date-from 2026-09-15 --time-from 1 --date-to 2026-09-15 --time-to 24
luftqualitaet --compact thresholds --use airquality --component 3
luftqualitaet --compact thresholds --use airquality --component 5
```

The request ran at 17:43 CEST. The API reports in CET, so the data went up to the hour ending
15:00 CET, and that last hour only had particulate matter so far. The skill fetched the O₃
and NO₂ bands to explain why an hour counted as level 1.

```
Air quality — Leipzig-Mitte (station 1613, traffic), 15 Sep 2026, hours 01:00–15:00 CET
  Overall: VERY GOOD most of the day, peaking at GOOD (level 1).
  Driving pollutant: O₃ (ozone) around midday, 68–71 µg/m³ (61–120 band = level 1);
    NO₂ once in the morning rush, 23 µg/m³ at 08:00 (21–40 band = level 1).
  Worst hour: 13:00, index 1 (good), O₃ 71 µg/m³.
  PM₁₀ steady at 9–10 µg/m³, PM₂,₅ at 4–5 µg/m³ (level 0 all day).
  11 h very good, 4 h good, 0 h moderate or worse.
  15:00 is flagged incomplete: only PM₁₀/PM₂,₅ reported, no O₃/NO₂ yet.
```

## luftqualitaet-annual-report

> Which stations had the most ozone exceedance days last year?

```bash
luftqualitaet --compact components --lang en                 # O₃ = component 3
luftqualitaet --compact transgression-types --lang en
luftqualitaet --compact transgressions --component 3 --year 2025 --lang en
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

The skill ranked on column `[3]`, the yearly count. The monthly columns add up to it:
1,434 station-days in June and 1,186 in August. For 283 of the 286 stations the 2025 series
runs to 2025-11-30.

```
Most ozone (O₃) exceedance days, 2025 (component 3), top 11 of 286 stations
   1. 37 days  680   Kleiner Feldberg, Glashütten     background · rural    · HE  (50.2219, 8.4461)
   2. 36 days  240   Schwarzwald-Süd, Münstertal      background · rural    · BW  (47.8099, 7.7645)
   2. 36 days  656   Fürth/Odenwald                   background · rural    · HE  (49.6535, 8.8173)
   2. 36 days  679   Wasserkuppe                      background · rural    · HE  (50.4977, 9.9359)
   5. 34 days  1845  Dreißigacker                     background · rural    · TH
   5. 34 days  1948  Schauinsland, Oberried-Hofsgrund background · rural    · UB
   7. 33 days  216   Mannheim-Nord                    background · suburban · BW
   7. 33 days  233   Ludwigsburg                      background · suburban · BW
   7. 33 days  283   Karlsruhe-Nordwest               background · urban    · BW
  10. 32 days  289   Schwäbische Alb, Erpfingen       background · rural    · BW
  10. 32 days  1454  Pfälzerwald-Hortenkopf           background · rural    · RP
  … 275 more
280 of 286 stations had at least one exceedance day. Only 6 had none, including
Rostock-Holbeinplatz, Garz and Dresden-Bergstr.
Every top station is a background site, mostly rural, and most are in Hesse and
Baden-Württemberg. Ozone is the opposite of NO₂, which is worst at traffic stations.
```

Next steps offered: the same ranking for 2024 to compare, or NO₂ exceedances (component 5).

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
