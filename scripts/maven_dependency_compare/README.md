# Maven Dependency Compare

Vergleicht ausgewaehlte Maven-Projekte in einem interaktiven HTML-Report.

## Was geprueft wird

- `Parent`
  - Version des Parent-POMs

- `Overrides`
  - lokale Properties wie `$tomcat.version`
  - nur wenn sie effektiv gebuendelte Parent-/BOM-Versionen ueberschreiben

- `Managed`
  - Eintraege aus `<dependencyManagement>`

- `Direct`
  - direkt verwendete Dependencies aus `<dependencies>`

## Was der Report zeigt

- Projekte als Spalten
- Versionen pro Projekt
- hoechste Version grün, niedrigere rot
- lokale Property-Overrides als Badge
- Hinweis, wenn eine Property eine Version kuenstlich unter der gebuendelten Provider-Version haelt

## Aktionen

- `Adopt highest`
  - hebt eine Version auf die hoechste im Vergleich sichtbare Version

- `Remove override`
  - entfernt einen lokalen Property-Override, wenn sauber auf die Provider-Version zurueckgefallen werden kann

## Wichtige Details

- es werden nur Top-Level-Projekte verglichen
- keine transitive Dependency-Liste als eigene Zeilen
- Override-Properties werden als eigene Zeilen dargestellt, z. B. `$log4j2.version`
