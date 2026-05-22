# Maven Dependency Compare

Vergleicht mindestens zwei ausgewaehlte Maven-Projekte und startet einen lokalen HTML-Report im Browser.

## Was der Check vergleicht

- `Parent`
  - Parent-POM-Version des Projekts
- `Overrides`
  - lokale `*.version`-Properties wie `$log4j2.version`
  - inklusive Unterschiede und fehlender Properties zwischen Projekten
- `Managed`
  - Eintraege aus `<dependencyManagement>`
- `Direct`
  - Eintraege aus `<dependencies>`

Nicht enthalten:

- keine transitiven Dependencies als eigene Zeilen
- keine komplette Tree-Ansicht fuer jede Zeile, nur die fuer den Compare benoetigten Versionen und Overrides

## Report und Aktionen

- Projekte sind Spalten, Dependencies/Properties sind Zeilen
- hoechste Version pro Zeile ist gruen, niedrigere Versionen sind rot
- `property fehlt` wird gelb markiert
- `bundled ...` zeigt die Provider-Version:
  - rot, wenn lokal unter dem Provider gepinnt
  - gelb, wenn nur informativ abweichend
- Dependency-Namen und konkrete Versionsnummern verlinken auf `mvnrepository.com`

Aktionen im Report:

- `Adopt highest`
- `Adopt highest for all`
- `Adopt property`
- `Adopt properties for all`
- `Remove override`
- `Remove override for all`

## Modi

- `deep`
  - jede relevante `*.version`-Property wird einzeln geprobt
  - genauer, aber langsamer
- `fast`
  - baut pro Projekt eine gemeinsame Baseline ohne die nicht-direkt referenzierten `*.version`-Properties
  - deutlich schneller
  - Override-Zeilen bleiben sichtbar, auch wenn Targets nicht mehr vollstaendig einzeln rueckgemappt werden koennen

## Technische Umsetzung

### Einstieg

- [script.ts](./script.ts)
  - validiert, dass mindestens 2 Maven-Projekte selektiert sind
  - liest den Variant-Parameter `fast | deep`
  - startet den lokalen Compare-Server
- [server.ts](./server.ts)
  - startet einen HTTP-Server auf `127.0.0.1` mit freiem Port
  - oeffnet den Browser automatisch
  - bleibt im Vordergrund aktiv, bis `Ctrl+C` oder Idle-Timeout

### Analyse-Pipeline

- [lib/pom.ts](./lib/pom.ts) ist der Kern
- Pro Projekt laufen diese Schritte:
  1. `pom.xml` als Raw-Modell laden
  2. `mvn help:effective-pom` ausfuehren
  3. passendes Projekt aus Reactor-Output waehlen
  4. Rows fuer `parent`, `managed`, `direct` aufbauen
  5. Override-/Provider-Informationen ermitteln
  6. alle Projekte zu einem `CompareReport` zusammenfuehren

Wichtige Modelle in `lib/pom.ts`:

- `RawPomModel`
  - lokale Properties und direkt aus `pom.xml` gelesene Rows
- `PomDependencyRow`
  - normalisierte Zeile fuer Report und Mutationen
- `ProjectPomAnalysis`
  - Analyse eines Projekts
- `CompareReport`
  - aggregiertes Modell fuer das Frontend

### Effective POM

- Das effektive POM wird immer ueber Maven bestimmt, nicht ueber eigene XML-Vererbung
- Bei Multi-Module-/Reactor-Projekten kann `help:effective-pom` ein `<projects>`-Dokument liefern
- `selectEffectiveProjectRoot(...)` waehlt daraus das passende Projekt anhand von `groupId`/`artifactId`

### Override-Erkennung

Es werden nur `*.version`-artige Properties beruecksichtigt.

Beispiele:

- `log4j2.version`
- `org.mapstruct.version`
- `commons-lang3.version`

Nicht jedes Property wird als Override-Zeile gezeigt. Relevant sind:

- Properties, die in einem Projekt existieren und zwischen Projekten verglichen werden sollen
- fehlende Properties in anderen Projekten werden als `property fehlt` sichtbar
- direkt referenzierte Dependency-Properties bleiben zusaetzlich als normale Dependency-Zeilen sichtbar, aber koennen auch eine Override-Zeile erzeugen, wenn sie als lokaler Versionsanker verglichen werden sollen

### `deep`-Probe

In `deep` wird pro Property ein temp-POM im echten Projektverzeichnis erzeugt:

- lokale Property entfernen
- `help:effective-pom` erneut laufen lassen
- effektive Versionen vorher/nachher vergleichen

Das liefert:

- `providerVersion` fuer betroffene Rows
- die betroffenen Override-Targets
- eine moegliche `propertyProviderValue`

Vorteil:

- sehr praezise Zuordnung je Property

Nachteil:

- teuer, weil pro Property ein weiterer Maven-Lauf noetig ist

### `fast`-Probe

In `fast` wird pro Projekt nur eine gemeinsame Baseline erzeugt:

- alle nicht-direkt referenzierten `*.version`-Properties aus temp-POM entfernen
- ein gemeinsames `help:effective-pom` rechnen
- Differenzen heuristisch auf Properties rueckfuehren

Wichtig:

- `fast` ist nicht mathematisch identisch zu `deep`
- fuer typische Parent-/BOM-Override-Faelle ist es aber deutlich schneller und praktisch ausreichend
- falls die Rueckzuordnung einzelner Targets nicht eindeutig ist, bleiben die Override-Zeilen trotzdem sichtbar

### Report-Rendering

- [lib/report-html.ts](./lib/report-html.ts)
  - liefert die komplette HTML-Seite
  - enthaelt das clientseitige Rendering und die kleinen Aktionen via `fetch`
- Der Report rechnet einige Dinge clientseitig neu:
  - `Show only differences`
  - Projektspalten ausblenden
  - `highest` / `outdated` fuer die sichtbaren Spalten neu berechnen

### Mutationen

Mutationen laufen serverseitig ueber:

- `adoptHighestVersion(...)`
- `removeOverride(...)`

Diese Funktionen:

- analysieren die betroffenen Projekte erneut
- passen `pom.xml` direkt an
- serialisieren XML normalisiert zurueck
- laden danach den Report komplett neu

Wichtiger Tradeoff:

- die XML-Ausgabe ist korrekt, aber nicht whitespace-/comment-preserving

### Dateien mit Logik

- [script.ts](./script.ts)
  - Einstieg fuer devtools
- [server.ts](./server.ts)
  - HTTP-Server, Browser-Start, Shutdown, API-Endpoints
- [lib/pom.ts](./lib/pom.ts)
  - Analyse, Effective-POM-Probes, Report-Modell, Mutationen
- [lib/report-html.ts](./lib/report-html.ts)
  - HTML, Bootstrap, clientseitige Interaktion
- [lib/xml.ts](./lib/xml.ts)
  - leichtgewichtige XML-Helfer fuer Lesen/Schreiben
- [lib/version.ts](./lib/version.ts)
  - Versionsvergleich fuer Highest/Outdated-Entscheidungen

### Wenn du weiterbauen willst

Die wahrscheinlichsten Erweiterungspunkte sind:

- `lib/pom.ts`
  - bessere Heuristik fuer `fast`
  - weitere Row-Typen
  - feinere Provider-Ermittlung
- `lib/report-html.ts`
  - neue Tabellenfilter
  - weitere Aktionen
  - visuelle Verdichtung grosser Projektvergleiche
- `server.ts`
  - zusaetzliche API-Endpunkte
  - Persistenz von UI-Zustaenden
