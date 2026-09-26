# Glossar

Ein Nachschlagewerk für die Fachbegriffe und projektspezifischen Begriffe, die in
`luftqualitaet-cli` verwendet werden. Die zugrunde liegende API ist deutsch
(Umweltbundesamt); dieses Glossar nennt den Begriff aus CLI und Client neben dem
deutschen Original, sofern es eines gibt.

> **Übersetzungstabelle** (aus der API). Die CLI folgt diesen Begriffen:
>
> | Deutsch | Englisch / API-Begriff |
> | --- | --- |
> | Luftqualität | air quality |
> | Komponente / Schadstoff | component / pollutant |
> | Messnetz | network |
> | Messumfang / Scope | scope |
> | Station / Messstation | station |
> | Stationstyp | station type |
> | Stationseinstellung | station setting |
> | Überschreitung | transgression / exceedance |
> | Jahresbilanz | annual balance |
> | Grenzwert / Schwellenwert | threshold |
> | Messwert | measure / measurement |
> | Stundenwert | hourly value |

---

## Die Datenquelle

**Umweltbundesamt (UBA).** Die Umweltbehörde des Bundes
(`umweltbundesamt.de`). Sie erhebt und veröffentlicht die amtlichen deutschen
Luftqualitätsdaten, die dieses Tool abfragt.

**Air-Data-API.** Die offene REST-API des UBA für Luftqualitätsdaten, ohne API-Schlüssel.
Dieser Client nutzt den Live-API-Pfad `/api/air-data/v3` auf
`https://luftdaten.umweltbundesamt.de` (die Standard-Basis-URL; die ältere Adresse
`https://www.umweltbundesamt.de/api/air_data/v3` leitet dauerhaft dorthin um).
`--base-url` nimmt nur den Host – den API-Pfad ergänzt die CLI. Sie löst die
OpenAPI-Spezifikation **v2** ab, die unter
[luftqualitaet.api.bund.dev](https://luftqualitaet.api.bund.dev/) veröffentlicht ist.

**Index- und Datenstruktur.** Der Aufbau der meisten API-Antworten: Ein `indices`-Array
benennt die Spalten (das Zeilenlayout), und die Nutzdaten sind eine kompakte Map mit
ID, Code oder Zeitstempel als Schlüssel statt eines Arrays beschrifteter Objekte. Der
Client gibt diese Nutzdaten unverändert als rohes JSON zurück (`JsonObject` / `AirDataResult`),
statt einen strikten Typ pro Endpoint zu raten, denn das Layout hängt von Endpoint und
Parametern ab.

---

## Ressourcen / Endpoints

Der Client stellt zwei Arten von Endpoints bereit: **Daten**-Endpoints (Messwerte und
Aggregationen für eine Station und ein Zeitfenster oder für eine Komponente und ein Jahr)
und **Referenz**-Endpoints (die Nachschlagelisten, die den numerischen IDs ihre Bedeutung geben).

**airquality (`/airquality/json`).** Luftqualitätsindex-Daten für eine Station über
ein Zeitfenster. Der Index hat fünf Stufen, von `0` (sehr gut) bis `4` (sehr schlecht).
CLI: `airquality`.

**airquality-limits (`/airquality/limits`).** Der verfügbare Datumsbereich je Station
für Luftqualitätsdaten – damit ermitteln Sie, welche Zeitfenster Sie abfragen können.
CLI: `airquality-limits`.

**measures (`/measures/json`).** Rohe Messdaten für eine Station über ein Zeitfenster,
für eine Komponente und einen Messumfang: Die Antwort enthält eine Reihe (ein Wert je
Stunde), ohne `component`/`scope` wählt die API also eine aus, statt alle zu liefern.
Die CLI verlangt beide. Eine ID, die die Station nicht misst, ergibt `"data": {}`.
CLI: `measures`.

**measures-limits (`/measures/limits`).** Der verfügbare Datumsbereich je
Messumfang, Komponente und Station für Messwerte. CLI: `measures-limits`.

**annual-balances (`/annualbalances/json`).** *Jahresbilanzen* für eine Komponente und
ein bestimmtes Jahr (`>= 2016`). Jede Zeile besteht aus einer Stations-ID und Kennzahlen,
deren Anzahl und Bedeutung von der Komponente abhängen (für O₃ gibt es keinen
Jahresmittelwert); das Objekt `headers` der Antwort benennt sie nach ihrer Position in der
Zeile, das Array `indices` passt dagegen nicht zu den Zeilen. CLI:
`annual-balances`.

**transgressions (`/transgressions/json`).** Daten zu *Überschreitungen* für eine
Komponente und ein Jahr – wie oft ein Grenzwert überschritten wurde. Das Objekt `headers`
der Antwort gibt an, was die Jahressumme zählt (Stunden oder Tage über welchem Wert);
`day_recent` zeigt, wie weit die Daten des Jahres reichen. CLI:
`transgressions`.

**thresholds (`/thresholds/json`).** Die Grenz- und Schwellenwerte für eine bestimmte
Verwendung `use` (`airquality` oder `measure`), optional je Komponente und Messumfang. CLI:
`thresholds`.

**meta (`/meta/json`).** Kombinierte Metadaten für ein `use` – bündelt Komponenten,
Messumfänge, Messnetze, Stationen usw., die Sie für andere Abfragen brauchen. CLI: `meta`.

### Referenzlisten

**components (`/components/json`).** Die gemessenen **Komponenten** (Schadstoffe):
z. B. PM10, NO₂, O₃, SO₂, CO. CLI: `components`. Jede Zeile enthält eine ID, einen Code
und die Maßeinheit.

**networks (`/networks/json`).** Die **Messnetze** – die Messnetze der Länder und des
Bundes, die die Stationen betreiben. CLI:
`networks`.

**scopes (`/scopes/json`).** Die **Messumfänge** – die Aggregations- bzw.
Mittelungsdefinition einer Messung (z. B. Stundenmittel, 24-Stunden-Mittel, die
Mittelungszeit + die Komponente, für die sie gilt). CLI:
`scopes`.

**station-types (`/stationtypes/json`).** Die Klassifikation der Stationstypen (z. B.
Hintergrund, Verkehr, Industrie). CLI: `station-types`.

**station-settings (`/stationsettings/json`).** Die Klassifikation der
Stationsumgebung (z. B. städtisch, vorstädtisch, ländlich). CLI: `station-settings`.

**transgression-types (`/transgressiontypes/json`).** Der Katalog der
Überschreitungsarten, auf die die Überschreitungsdaten verweisen. CLI:
`transgression-types`.

---

## Wichtige Kennungen & Abfrageparameter

**station.** Die numerische **Stations-ID**, die eine Messstation bezeichnet. Ein
Pflichtparameter von `airquality` und `measures`. Stations-IDs beginnen bei 1, daher
lehnt die CLI `0` schon lokal ab. IDs finden Sie über `meta` / `airquality-limits` /
`measures-limits`.

**component.** Die numerische **Komponenten-ID**, die einen Schadstoff bezeichnet. Pflicht
bei `annual-balances` / `transgressions` / `measures`; optional bei `thresholds`.
Die Zuordnung ID ↔ Schadstoff liefert `components`.

**scope.** Die numerische **Messumfang-ID**, die einen Messumfang (Mittelungsdefinition)
bezeichnet. Pflicht bei `measures`, optional bei `thresholds`. Auflösung über `scopes`.

**year.** Eine vierstellige Jahreszahl für die Jahresaggregationen; das früheste Jahr der
API ist **2016**, daher lehnt die CLI alles darunter ab. `transgressions` ist erst ab
**2019** vollständig: Für 2016–2018 antwortet die API bei manchen Komponenten (NO₂,
PM₁₀) mit HTTP 500, was die CLI mit einem Hinweis meldet.

**Zeitfenster (`date_from` / `time_from` / `date_to` / `time_to`).** Die
Daten-Endpoints adressieren ein Zeitfenster über Startdatum+Stunde und Enddatum+Stunde.
Datumsangaben haben das Format `YYYY-MM-DD`. Stunden sind Werte für das **Stundenende** im
Bereich **1..24** (nicht `0..23`): Stunde `1` ist das Intervall, das um 01:00 Uhr endet,
Stunde `24` endet um Mitternacht. Die Zeiten sind **ganzjährig MEZ (UTC+1)** – so beschriftet
sie die `airquality`-Antwort –, im Sommer liegen sie also eine Stunde hinter der deutschen
Ortszeit. Die CLI prüft das Kalenderdatum und den Stundenbereich und
lehnt ein umgekehrtes Zeitfenster (Beginn nach Ende) ab, bevor eine Anfrage gesendet wird.

---

## Enums / Codes des Clients

Dies sind die geschlossenen Wertemengen, gegen die der Client validiert (definiert in
`src/client/enums.ts`):

**lang (`Lang`).** Antwortsprache für die Bezeichnungen in Referenzlisten und
Metadaten: `de` | `en`. CLI: `--lang`.

**index (`IndexKind`).** Wie eine Referenzliste in der Antwort verschlüsselt ist: `id`
(die numerische ID) | `code` (der Kurzcode). CLI: `--index`.

**use (meta) (`MetaUse`).** Welches Metadatenpaket der Endpoint `meta` liefert:
`airquality` | `measure` | `transgression` | `annualbalance` | `map`. Bei
`use=airquality` ist ein Zeitfenster (`--date-from` + `--date-to`) erforderlich. Bei
den anderen Werten ist es optional, die API wendet es aber ebenfalls an (`use=measure`
liefert dann nur die im Fenster aktiven Stationen). Deshalb prüft die CLI es genauso:
beide Daten oder keines, Stunden nur zusammen mit Daten, fehlende Stunden werden als
`1`/`24` gesendet, kein umgekehrtes Fenster. CLI: `meta --use`.

**use (thresholds) (`ThresholdUse`).** Welche Schwellenwertmenge der Endpoint `thresholds`
liefert: `airquality` | `measure`. CLI: `thresholds --use`.

---

## Such- und API-Konzepte

**Retry / Backoff.** Die API begrenzt die Anfragerate und kann vorübergehend mit **429** /
**503** antworten; die Engine wiederholt solche Anfragen automatisch und wartet dabei das
`Retry-After` der Antwort ab (Sekunden oder ein HTTP-Datum), sonst linear steigend (200 ms,
400 ms, …). Ein `Retry-After` über 30 s wird nicht abgewartet: Der Fehler erscheint sofort
(`--max-retries`, `0..10`, Standard `2`).

**Weiterleitungen.** Die Engine folgt standardmäßig bis zu 5 HTTP-Weiterleitungen
(einstellbar mit `--max-redirects`; `0` schaltet das Folgen ab). Bei einer
**Cross-Origin**-Weiterleitung entfernt sie die Request-Header (und setzt nur die
unbedenklichen `Accept` / `User-Agent` wieder), damit nichts Sensibles an einen anderen
Origin gelangt.

**Obergrenze der Antwortgröße (`maxResponseBytes`).** Eine feste Obergrenze für die Größe
des Antwort-Bodys (Standard 100 MiB; `0` = unbegrenzt), die vor Speichererschöpfung durch
einen feindseligen oder fehlerhaften Endpoint schützt. CLI: `--max-response-bytes`.

**Nur lesend, ohne Authentifizierung.** Die Air-Data-API des UBA benötigt keinen
API-Schlüssel; dieser Client implementiert nur die offenen, lesenden `GET`-Endpoints.

---

> **Bibliothek & Interna.** Begriffe zum TypeScript-Client und seinen Interna –
> `LuftqualitaetClient`, die Request-Engine, Transport, Retry/Backoff, Fehlertypen,
> Query-Builder – stehen jetzt in **[DEVELOPING.md](DEVELOPING.md)**.
