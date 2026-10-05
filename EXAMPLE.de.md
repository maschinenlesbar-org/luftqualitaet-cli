# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `luftqualitaet`, eines pro Skill: eine
Anfrage, die `luftqualitaet`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 6. Oktober 2026 zwischen 01:29 und 01:31 Uhr MESZ mit `luftqualitaet` 0.3.0
gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [luftqualitaet-air-report](#luftqualitaet-air-report) · [luftqualitaet-annual-report](#luftqualitaet-annual-report) · [luftqualitaet-station-finder](#luftqualitaet-station-finder)

## luftqualitaet-air-report

> Wie war die Luft heute an der Messstation Leipzig-Mitte?

```bash
luftqualitaet --compact --timeout 60000 meta --use measure --lang en     # „Leipzig-Mitte" -> Station 1613
luftqualitaet --compact components --lang en
luftqualitaet --compact airquality --station 1613 --date-from 2026-10-06 --time-from 1 --date-to 2026-10-06 --time-to 24
luftqualitaet --compact airquality --station 1613 --date-from 2026-10-05 --time-from 1 --date-to 2026-10-05 --time-to 24
luftqualitaet --compact thresholds --use airquality --component 3
luftqualitaet --compact thresholds --use airquality --component 5
luftqualitaet --compact thresholds --use airquality --component 9
```

Die Anfrage lief um 01:29 MESZ (00:29 MEZ), für heute gab es also noch keine Stunden: Das erste
Zeitfenster kam mit `"data": {}` zurück, dazu der Hinweis der CLI, dass eine unbekannte
Stations-ID genauso aussieht. Die ID stammte aus dem Katalog, also ging der Skill wie
vorgesehen einen Tag zurück. Seine Daten reichten bis zur Stunde, die um 20:00 MEZ endet. Der
Skill hat die O₃-, NO₂- und PM₂,₅-Bänder abgerufen, um zu erklären, warum eine Stunde als
Stufe 1 zählt (PM₂,₅ nach Scope 6).

```
Luftqualität – Leipzig-Mitte (Station 1613, traffic), 05.10.2026, Stunden bis 01:00–20:00 MEZ
  Für heute liegen noch keine Daten vor (00:29 MEZ), daher gestern.
  Gesamt: den ganzen Tag SEHR GUT oder GUT – höchstens Stufe 1.
  Bestimmender Schadstoff: NO₂ im Morgenverkehr, 23–24 µg/m³ in den Stunden bis 07:00–09:00
    und 21 µg/m³ in denen bis 11:00–12:00 (Band 21–40 = Stufe 1);
    O₃ 70 µg/m³ in der Stunde bis 14:00 (Band 61–120 = Stufe 1);
    PM₂,₅ 12 µg/m³ am Abend (Band 11–20 = Stufe 1).
  9 h gut, 8 h sehr gut, 0 h mäßig oder schlechter.
  Keine Stunde ist vollständig. Bis 14:00 wurden nur O₃/NO₂ gemeldet, ab 18:00 nur
  PM₁₀/PM₂,₅, und die Stunden bis 15:00–17:00 fehlen. Neueste Stunde: bis 20:00 MEZ
  (21:00 Ortszeit), Stufe 1, PM₁₀ 19 µg/m³, PM₂,₅ 12 µg/m³.
```

## luftqualitaet-annual-report

> Welche Stationen hatten im vergangenen Jahr die meisten Tage mit Ozon-Überschreitungen?

```bash
luftqualitaet --compact components --lang en                 # O₃ = Komponente 3
luftqualitaet --compact annual-balances --component 3 --year 2025 --lang en
luftqualitaet --compact --timeout 60000 meta --use measure --lang en
```

2025 ist ein abgeschlossenes Jahr, und seine Jahresbilanz liegt vor (das UBA veröffentlicht sie
im Juni des Folgejahres). Der Skill hat deshalb nach der Jahresbilanz sortiert, die auf den
endgültigen Daten des UBA beruht, und nicht nach `transgressions`, der vorläufigen Tabelle des
laufenden Jahres. Er hat `.headers` gelesen und nach Spalte `3` sortiert, „Number of days with
highest daily 8-hour averages above 120 µg/m³“; 268 der 275 Zeilen haben diesen Wert.

```
Meiste Tage mit Ozon-Überschreitung (höchster 8-Stunden-Mittelwert des Tages über 120 µg/m³), 2025
– Jahresbilanz (UBA, endgültige Daten), Top 11 von 268 Stationen
   1. 40 Tage  240   Schwarzwald-Süd, Münstertal       background · rural    · BW  (47,8099; 7,7645)
   2. 37 Tage  680   Kleiner Feldberg, Glashütten      background · rural    · HE  (50,2219; 8,4461)
   3. 36 Tage  656   Fürth/Odenwald                    background · rural    · HE  (49,6535; 8,8173)
   3. 36 Tage  679   Wasserkuppe                       background · rural    · HE  (50,4977; 9,9359)
   3. 36 Tage  1846  Neuhaus                           background · rural    · TH  (50,5000; 11,1346)
   6. 35 Tage  283   Karlsruhe-Nordwest                background · urban    · BW
   7. 34 Tage  289   Schwäbische Alb, Erpfingen        background · rural    · BW
   7. 34 Tage  1845  Dreißigacker                      background · rural    · TH
   7. 34 Tage  1948  Schauinsland, Oberried-Hofsgrund  background · rural    · UB
  10. 32 Tage  216   Mannheim-Nord                     background · suburban · BW
  10. 32 Tage  1454  Pfälzerwald-Hortenkopf            background · rural    · RP
  … 257 weitere
266 von 268 Stationen hatten mindestens einen Überschreitungstag; nur Rostock-Holbeinplatz und
Garz hatten keinen. 41 Stationen hatten 2025 mehr als 25 Tage; der Zielwert erlaubt 25 Tage im
Mittel über 3 Jahre (Spalte 4), und darüber liegen 11 Stationen.
Alle Spitzenreiter sind Hintergrundstationen, meist ländlich, die meisten in Baden-Württemberg
und Hessen. Beim Ozon ist es umgekehrt wie bei NO₂, das an Verkehrsstationen am höchsten ist.
```

Als Nächstes angeboten: der bisherige Stand dieses Jahres aus `transgressions` (vorläufig) oder
dieselbe Rangliste für 2024 zum Vergleich.

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
