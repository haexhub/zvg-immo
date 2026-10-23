# Feature Specification: Entfernung messen und Flurstücke auf der Detailkarte

**Feature Branch**: `006-detail-map-measure-parcels`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Auf der Karte der Auktions-Detailseite (1) Entfernungen messen: Button \"Entfernung messen\" schaltet einen Mess-Modus ein; Klick 1 setzt Punkt A, Klick 2 Punkt B, dann werden Linie und geodätische Distanz in km angezeigt; ein dritter Klick startet eine neue Messung; Esc oder erneuter Button-Klick beendet den Modus; Marker-Popups sind währenddessen deaktiviert. (2) Flurstücke als zuschaltbarer Overlay-Layer im bestehenden Layer-Panel, aus öffentlichen amtlichen Kartendiensten: Deutschland je Bundesland, Frankreich, Italien, Polen, Tschechien. Für Länder ohne Dienst erscheint der Layer nicht. Keine neue Abhängigkeit."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Luftlinie zwischen zwei Punkten messen (Priority: P1)

Wer eine Auktion prüft, will auf der Detailkarte schnell wissen, wie weit das Objekt
von einem bestimmten Ort entfernt ist, etwa vom Bahnhof, vom See oder vom
Nachbarort. Dafür schaltet die Person den Mess-Modus ein, klickt zwei Punkte an und
liest die Entfernung in Kilometern ab.

**Why this priority**: Die Messung funktioniert in jedem Land und auf jeder
Detailseite mit Karte und liefert sofort eine Antwort. Sie hängt von keinem externen
Dienst ab.

**Independent Test**: Detailseite einer Auktion mit Koordinaten öffnen, Mess-Modus
einschalten, zwei Punkte anklicken. Linie und Entfernung erscheinen und stimmen mit
einer Referenzmessung überein.

**Acceptance Scenarios**:

1. **Given** die Detailkarte ist geladen und der Mess-Modus aus, **When** die Person auf „Entfernung messen" klickt, **Then** ist der Modus aktiv, der Button wird als aktiv dargestellt und ein kurzer Hinweis erklärt den nächsten Schritt („Startpunkt setzen").
2. **Given** der Mess-Modus ist aktiv und noch kein Punkt gesetzt, **When** die Person in die Karte klickt, **Then** erscheint dort Punkt A und der Hinweis wechselt zu „Endpunkt setzen".
3. **Given** Punkt A ist gesetzt, **When** die Person einen zweiten Punkt anklickt, **Then** erscheinen Punkt B, eine Verbindungslinie A–B und die Entfernung in km an der Linie.
4. **Given** eine Messung A–B ist abgeschlossen, **When** die Person erneut klickt, **Then** wird die alte Messung entfernt und der Klick setzt einen neuen Punkt A.
5. **Given** der Mess-Modus ist aktiv, **When** die Person Esc drückt oder den Button erneut anklickt, **Then** endet der Modus und Punkte, Linie und Entfernungsangabe verschwinden.
6. **Given** der Mess-Modus ist aktiv, **When** die Person auf einen Umgebungs- oder Gefahren-Marker klickt, **Then** öffnet sich kein Popup, sondern der Klick setzt einen Messpunkt.
7. **Given** der Mess-Modus ist aktiv, **When** die Person die Karte verschiebt oder zoomt, **Then** setzt das keinen Messpunkt und eine bestehende Messung bleibt erhalten.

---

### User Story 2 - Flurstücke rund um das Objekt sehen (Priority: P2)

Wer eine Auktion prüft, will erkennen, wie das Grundstück zugeschnitten ist und wo
die Grenzen zu den Nachbarflurstücken verlaufen. Dafür schaltet die Person im
Layer-Panel der Detailkarte den Layer „Flurstücke" ein und sieht die amtlichen
Flurstücksgrenzen, bei ausreichender Zoomstufe auch die Flurstücksnummern, über der
Grundkarte.

**Why this priority**: Der Mehrwert ist hoch, die Funktion hängt aber von externen
amtlichen Diensten ab, die es nur für einen Teil der Länder gibt.

**Independent Test**: Detailseite einer Auktion in einem unterstützten Gebiet
öffnen, den Layer „Flurstücke" einschalten und so weit hineinzoomen, dass Grenzen
erscheinen. Danach eine Auktion in einem nicht unterstützten Land öffnen: Dort fehlt
der Layer im Panel.

**Acceptance Scenarios**:

1. **Given** eine Auktion liegt in einem unterstützten Gebiet (deutsches Bundesland mit verfügbarem Dienst, Frankreich, Polen, Tschechien oder Spanien), **When** die Person das Layer-Panel öffnet, **Then** gibt es den Eintrag „Flurstücke". Er ist standardmäßig aus.
2. **Given** der Eintrag „Flurstücke" ist eingeschaltet, **When** die Karte nah genug am Objekt ist (etwa Straßenebene), **Then** erscheinen die Flurstücksgrenzen über Straßen- und Satellitenkarte.
3. **Given** der Layer ist eingeschaltet, **When** die Person weit herauszoomt, **Then** blendet sich der Layer aus, statt unlesbar oder sehr langsam zu werden.
4. **Given** eine Auktion liegt in einem Land ohne unterstützten Dienst, **When** die Person das Layer-Panel öffnet, **Then** fehlt der Eintrag „Flurstücke".
5. **Given** der Layer ist eingeschaltet, **When** die Person auf die Karte schaut, **Then** nennt die Kartenattribution die amtliche Datenquelle.

---

### Edge Cases

- Die Messung reicht über eine große Distanz (mehr als 100 km): Die Entfernung wird geodätisch, also auf der Erdkugel, berechnet. Die verzerrte Kartenprojektion verfälscht sie nicht.
- Sehr kurze Distanzen (unter 1 km): Die Anzeige bleibt in km, mit genug Nachkommastellen, um auf etwa 10 m genau zu sein (z. B. „0,35 km").
- A und B liegen auf demselben Punkt: Angezeigt wird „0 km", ohne Fehler.
- Ein Messpunkt liegt teilweise außerhalb des sichtbaren Ausschnitts: Die Messung bleibt bestehen und ist nach dem Zurückschieben wieder sichtbar.
- Der Flurstücksdienst ist langsam, nicht erreichbar oder liefert Fehlerbilder: Die übrige Karte funktioniert unverändert, der Layer bleibt leer. Weder Fehlermeldungsflut noch kaputte Kacheln erscheinen.
- Das Objekt liegt nahe einer Landes- oder Bundeslandgrenze: Ausgewählt wird der Dienst des Gebiets, in dem das Objekt liegt. Jenseits der Grenze darf der Layer lückenhaft sein.
- Die Koordinate der Auktion ist ungenau (z. B. nur Ortsmitte): Der Layer zeigt trotzdem die Flurstücke des Kartenausschnitts. Ein konkretes Flurstück wird nicht hervorgehoben.
- Locale-Wechsel bei aktivem Mess-Modus: Hinweistexte und Zahlenformat folgen der neuen Sprache.

## Requirements *(mandatory)*

### Functional Requirements

**Entfernung messen**

- **FR-001**: Die Detailkarte MUSS einen gut sichtbaren Bedienknopf „Entfernung messen" haben, der den Mess-Modus ein- und ausschaltet. Sein Zustand (aktiv/inaktiv) MUSS erkennbar sein, auch für Screenreader.
- **FR-002**: Im Mess-Modus MUSS der erste Klick in die Karte Punkt A setzen und der zweite Punkt B.
- **FR-003**: Sind beide Punkte gesetzt, MUSS die Karte eine Verbindungslinie A–B und die Entfernung in Kilometern anzeigen.
- **FR-004**: Die Entfernung MUSS als geodätische Luftlinie berechnet werden; die Abweichung von einer Referenz-Großkreisberechnung MUSS unter 0,5 % liegen.
- **FR-005**: Ein Klick nach abgeschlossener Messung MUSS die bisherige Messung verwerfen und eine neue mit Punkt A beginnen.
- **FR-006**: Esc oder ein erneuter Klick auf den Bedienknopf MUSS den Mess-Modus beenden und alle Messgrafiken entfernen.
- **FR-007**: Solange der Mess-Modus aktiv ist, DÜRFEN Klicks auf Karten-Marker KEINE Popups öffnen. Ein bereits offenes Popup MUSS sich beim Einschalten schließen.
- **FR-008**: Verschieben und Zoomen der Karte MUSS im Mess-Modus wie gewohnt funktionieren, ohne Messpunkte zu setzen.
- **FR-009**: Die Entfernung MUSS im Zahlenformat der aktiven UI-Sprache erscheinen; alle neuen Texte MUSS es in allen UI-Sprachen der App geben.

**Flurstücke**

- **FR-010**: Für Auktionen in einem unterstützten Gebiet MUSS das Layer-Panel der Detailkarte einen Eintrag „Flurstücke" anbieten, der standardmäßig ausgeschaltet ist.
- **FR-011**: Unterstützte Gebiete im ersten Schritt sind: jedes deutsche Bundesland, für das ein öffentlich und ohne Zugangsschlüssel nutzbarer amtlicher Flurstücksdienst verfügbar ist, außerdem Frankreich, Polen, Tschechien und Spanien. Welche Bundesländer erfasst sind, MUSS dokumentiert sein. Italien entfällt (Entscheidung am Plan-Gate: Der Dienst ist ohne Server-Proxy nicht darstellbar) und folgt als eigenes Feature.
- **FR-012**: Für Auktionen außerhalb der unterstützten Gebiete DARF der Eintrag „Flurstücke" NICHT erscheinen.
- **FR-013**: Der Flurstücks-Layer MUSS über beiden Grundkarten (Straße, Satellit) lesbar sein und DARF die übrigen Overlays und den Objekt-Pin NICHT verdecken.
- **FR-014**: Der Flurstücks-Layer MUSS unterhalb einer Mindest-Zoomstufe ausgeblendet sein, damit die Karte bei großem Ausschnitt schnell bleibt und die Dienste nicht unnötig belastet werden.
- **FR-015**: Ist der Layer sichtbar, MUSS die Karte die jeweilige amtliche Datenquelle nennen (Attribution), wie es die Nutzungsbedingungen der Dienste verlangen.
- **FR-016**: Fällt ein Flurstücksdienst aus, DARF das die übrige Kartenfunktion NICHT beeinträchtigen.
- **FR-017**: Die Funktion DARF KEINE neue Softwareabhängigkeit und KEINE neuen kostenpflichtigen oder schlüsselpflichtigen Dienste einführen.

### Key Entities

- **Messung**: Gehört nur zur aktuellen Kartenansicht und wird nicht gespeichert. Besteht aus Punkt A, optional Punkt B und der daraus berechneten Entfernung in km.
- **Flurstücksquelle**: Ein amtlicher Kartendienst für ein Gebiet (Land oder Bundesland). Attribute: Gebiet, Anzeigename der Datenquelle (Attribution), Mindest-Zoomstufe. Pro Auktion wird höchstens eine Quelle gewählt, anhand des Gebiets, in dem das Objekt liegt.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Eine Person ermittelt die Entfernung zwischen zwei Punkten auf der Detailkarte in höchstens drei Klicks (Modus an, Punkt A, Punkt B) und unter 10 Sekunden.
- **SC-002**: Gemessene Entfernungen weichen bei Strecken von 100 m bis 500 km um weniger als 0,5 % von einer Referenz-Großkreisberechnung ab.
- **SC-003**: Bei Stichproben mit je mindestens einer Auktion pro unterstütztem Gebiet zeigt der eingeschaltete Flurstücks-Layer auf Straßenebene in jedem Fall sichtbare Flurstücksgrenzen am Objektstandort.
- **SC-004**: Auf Detailseiten nicht unterstützter Länder erscheint der Flurstücks-Eintrag in 100 % der Fälle nicht.
- **SC-005**: Ladezeit und Bedienbarkeit der Detailkarte bleiben bei ausgeschaltetem Flurstücks-Layer gegenüber heute unverändert. Bis der Layer eingeschaltet wird, gehen keine Anfragen an Flurstücksdienste.

## Assumptions

- Die Messung ist eine reine Luftlinie zwischen genau zwei Punkten. Polylinien mit mehreren Stützpunkten, Flächenmessung, Weg- oder Fahrzeitberechnung sowie das Verschieben bereits gesetzter Punkte gehören nicht zum Umfang.
- Messungen werden nicht gespeichert, nicht geteilt und nicht in die URL geschrieben.
- Die Messfunktion gibt es nur auf der Detailkarte der Auktion, nicht auf der Suchkarte.
- Die Entfernung wird immer in km angezeigt (auch unter 1 km); eine Umschaltung auf Meilen ist nicht vorgesehen.
- Der Flurstücks-Layer zeigt die amtliche Darstellung des jeweiligen Dienstes, also Grenzen und, je nach Dienst, Nummern. Optik und Beschriftung variieren deshalb zwischen Ländern und Bundesländern.
- Welches Flurstück zur Auktion gehört, wird nicht ermittelt oder hervorgehoben. Abfragen von Flurstücksdetails per Klick (Eigentümer, Fläche, Nummer) gehören nicht zum Umfang.
- Das Gebiet einer Auktion (Land, bei Deutschland das Bundesland) ergibt sich aus den Daten, die zur Auktion schon vorliegen, oder aus ihrer Koordinate.
- Bundesländer, deren Dienst in der Recherche nicht verlässlich erreichbar ist (bisher Saarland und Bremen), werden nur aufgenommen, wenn bei der Planung ein funktionierender Dienst gefunden wird. Sonst fehlt dort der Layer.
- Die Dienste werden direkt aus dem Browser der Person geladen. Sie erfahren dadurch den Kartenausschnitt, aber keine personenbezogenen Daten. Wie bei den bereits eingebundenen externen Kartenlayern (z. B. Hochwasserrisiko) gilt das als akzeptiert.
- Weitere Länder (z. B. Italien per Proxy, Österreich, Belgien, Skandinavien) folgen bei Bedarf in einem späteren Schritt.
