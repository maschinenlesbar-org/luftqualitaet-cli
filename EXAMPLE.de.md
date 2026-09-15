# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `luftqualitaet`, eines pro Skill: eine
Anfrage, die `luftqualitaet`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `luftqualitaet` 0.0.6 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [luftqualitaet-air-report](#luftqualitaet-air-report) · [luftqualitaet-annual-report](#luftqualitaet-annual-report) · [luftqualitaet-station-finder](#luftqualitaet-station-finder)

## luftqualitaet-air-report

> Wie war die Luft heute an der Messstation Leipzig-Mitte?

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en     # „Leipzig-Mitte" -> Station 1613
luftqualitaet --compact components --lang en
luftqualitaet --compact airquality --station 1613 --date-from 2026-09-15 --time-from 1 --date-to 2026-09-15 --time-to 24
luftqualitaet --compact thresholds --use airquality --component 3
luftqualitaet --compact thresholds --use airquality --component 5
```

Die Anfrage lief um 17:43 MESZ. Die API liefert MEZ, deshalb reichten die Daten bis zur Stunde,
die um 15:00 MEZ endet, und für diese letzte Stunde lag bisher nur Feinstaub vor. Der Skill hat
die O₃- und NO₂-Bänder abgerufen, um zu erklären, warum eine Stunde als Stufe 1 zählt.

```
Luftqualität – Leipzig-Mitte (Station 1613, traffic), 15.09.2026, Stunden 01:00–15:00 MEZ
  Gesamt: den größten Teil des Tages SEHR GUT, höchstens GUT (Stufe 1).
  Bestimmender Schadstoff: O₃ (Ozon) um die Mittagszeit, 68–71 µg/m³ (Band 61–120 = Stufe 1);
    NO₂ einmal im Morgenverkehr, 23 µg/m³ um 08:00 (Band 21–40 = Stufe 1).
  Schlechteste Stunde: 13:00, Index 1 (gut), O₃ 71 µg/m³.
  PM₁₀ gleichbleibend bei 9–10 µg/m³, PM₂,₅ bei 4–5 µg/m³ (ganztägig Stufe 0).
  11 h sehr gut, 4 h gut, 0 h mäßig oder schlechter.
  15:00 ist als unvollständig markiert: nur PM₁₀/PM₂,₅ gemeldet, noch kein O₃/NO₂.
```

## luftqualitaet-annual-report

> Welche Stationen hatten im vergangenen Jahr die meisten Tage mit Ozon-Überschreitungen?

```bash
luftqualitaet --compact components --lang en                 # O₃ = Komponente 3
luftqualitaet --compact transgression-types --lang en
luftqualitaet --compact transgressions --component 3 --year 2025 --lang en
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

Der Skill hat nach Spalte `[3]` sortiert, der Jahressumme. Die Monatsspalten ergeben zusammen
genau diesen Wert: 1.434 Stationstage im Juni und 1.186 im August. Bei 283 der 286 Stationen
reicht die Reihe für 2025 bis 2025-11-30.

```
Meiste Tage mit Ozon-Überschreitung (O₃), 2025 (Komponente 3), Top 11 von 286 Stationen
   1. 37 Tage  680   Kleiner Feldberg, Glashütten     background · rural    · HE  (50,2219; 8,4461)
   2. 36 Tage  240   Schwarzwald-Süd, Münstertal      background · rural    · BW  (47,8099; 7,7645)
   2. 36 Tage  656   Fürth/Odenwald                   background · rural    · HE  (49,6535; 8,8173)
   2. 36 Tage  679   Wasserkuppe                      background · rural    · HE  (50,4977; 9,9359)
   5. 34 Tage  1845  Dreißigacker                     background · rural    · TH
   5. 34 Tage  1948  Schauinsland, Oberried-Hofsgrund background · rural    · UB
   7. 33 Tage  216   Mannheim-Nord                    background · suburban · BW
   7. 33 Tage  233   Ludwigsburg                      background · suburban · BW
   7. 33 Tage  283   Karlsruhe-Nordwest               background · urban    · BW
  10. 32 Tage  289   Schwäbische Alb, Erpfingen       background · rural    · BW
  10. 32 Tage  1454  Pfälzerwald-Hortenkopf           background · rural    · RP
  … 275 weitere
280 von 286 Stationen hatten mindestens einen Überschreitungstag. Nur 6 hatten keinen,
darunter Rostock-Holbeinplatz, Garz und Dresden-Bergstr.
Alle Spitzenreiter sind Hintergrundstationen, meist ländlich, die meisten in Hessen und
Baden-Württemberg. Beim Ozon ist es umgekehrt wie bei NO₂, das an Verkehrsstationen am höchsten ist.
```

Als Nächstes angeboten: dieselbe Rangliste für 2024 zum Vergleich oder NO₂-Überschreitungen (Komponente 5).

## luftqualitaet-station-finder

> Welche Luftmessstationen gibt es in Leipzig? Gesucht ist eine für Verkehr in der Innenstadt und eine für die Hintergrundbelastung.

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
luftqualitaet --compact station-types --lang en
luftqualitaet --compact station-settings --lang en
```

Die Teilwortsuche nach „Leipzig" im Stationsnamen fand auch Stationen an der „Leipziger Str." in
Frankfurt (Oder), Chemnitz und Berlin. Der Skill hat nur Stationen behalten, deren Ort (idx 3)
Leipzig ist. Die Koordinaten stehen hier mit Breite zuerst, die API speichert die Länge zuerst.

```
Stationen in Leipzig (in Betrieb):
  1613  Leipzig-Mitte          traffic    · urban    · SN  51,3442; 12,3772  Willy-Brandt-Platz/Am Hallischen Tor
  1665  Leipzig Lützner Str.   traffic    · urban    · SN  51,3359; 12,3347  Lützner Str. 34/36
  1647  Leipzig-West           background · suburban · SN  51,3179; 12,2974  Nikolai-Rumjanzew-Str. 100
1 stillgelegte Station ausgelassen: 1670 Leipzig-Thekla (background, in Betrieb bis 2020-12-31).

Verkehr in der Innenstadt: 1613 Leipzig-Mitte. Hintergrund: 1647 Leipzig-West.
```

Als Nächstes angeboten: der heutige Luftqualitätsindex für 1613 oder 1647 mit **luftqualitaet-air-report**.
