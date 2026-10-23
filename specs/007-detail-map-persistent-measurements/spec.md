# Feature Specification: Dauerhafte Entfernungsmessungen auf der Detailkarte

**Feature Branch**: `007-detail-map-persistent-measurements`

**Created**: 2026-10-23

**Status**: Draft

**Input**: User description: "Die Entfernungslinie soll dauerhaft sichtbar bleiben, damit mehrere Distanzen gleichzeitig gemessen werden können. Jede Distanzlinie zeigt beim Hover einen schwebenden „X“-Button, über den sie wieder entfernt werden kann." Baut auf `specs/006-detail-map-measure-parcels` auf (Mess-Modus mit zwei Klicks, bereits umgesetzt).

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Mehrere Messungen gleichzeitig sehen (Priority: P1)

Wer eine Auktion prüft, will das Objekt mit mehreren Orten vergleichen, etwa
Bahnhof, Schule und Autobahnauffahrt, und alle Entfernungen zugleich auf der
Karte sehen. Eine abgeschlossene Messung bleibt deshalb stehen, auch wenn die
Person den Mess-Modus beendet oder eine weitere Messung beginnt.

**Why this priority**: Das ist der eigentliche Wunsch. Ohne ihn muss man sich
Zahlen merken oder aufschreiben, denn jede neue Messung löscht die vorige.

**Independent Test**: Auf einer Detailkarte zwei Messungen nacheinander
abschließen und prüfen, dass beide Linien samt Entfernungsangabe sichtbar sind.
Danach den Mess-Modus beenden: Beide bleiben sichtbar.

**Acceptance Scenarios**:

1. **Given** eine Messung A–B ist abgeschlossen, **When** die Person im Mess-Modus erneut klickt, **Then** bleibt die erste Linie samt Beschriftung stehen und der Klick setzt Punkt A einer neuen Messung.
2. **Given** zwei abgeschlossene Messungen sind sichtbar, **When** die Person die zweite Messung beendet, **Then** zeigt die Karte beide Linien, jede mit der eigenen Entfernung in km.
3. **Given** mindestens eine Messung ist abgeschlossen, **When** die Person den Mess-Modus per Button oder Esc beendet, **Then** bleiben alle abgeschlossenen Messungen sichtbar.
4. **Given** der Mess-Modus ist aus, **When** die Person die Karte verschiebt, zoomt oder zwischen Straßen- und Satellitenkarte wechselt, **Then** bleiben die Messungen an ihren geografischen Positionen.
5. **Given** Punkt A einer neuen Messung ist gesetzt, aber noch kein Punkt B, **When** die Person den Mess-Modus beendet, **Then** verschwindet Punkt A, und alle fertigen Messungen bleiben.
6. **Given** der Mess-Modus ist wieder aus und mindestens eine Messung sichtbar, **When** die Person ihn erneut einschaltet, **Then** erscheinen die vorhandenen Messungen weiter, und der nächste Klick beginnt eine neue.

---

### User Story 2 - Einzelne Messung entfernen (Priority: P2)

Wer eine Messung nicht mehr braucht, will genau diese Linie löschen, ohne die
anderen zu verlieren. Dafür zeigt jede Distanzlinie beim Darüberfahren mit der
Maus einen schwebenden „X“-Button. Ein Klick darauf entfernt diese Messung.

**Why this priority**: Ohne Löschen sammelt sich die Karte zu. Es setzt aber
Story 1 voraus, deshalb P2.

**Independent Test**: Zwei Messungen anlegen, mit der Maus über die erste
fahren, auf das „X“ klicken. Nur die erste verschwindet.

**Acceptance Scenarios**:

1. **Given** mehrere Messungen sind sichtbar, **When** die Person mit der Maus über eine der Linien fährt, **Then** erscheint an dieser Linie ein „X“-Button, und an den anderen Linien nicht.
2. **Given** der „X“-Button einer Linie ist sichtbar, **When** die Person darauf klickt, **Then** verschwinden genau diese Linie samt Punkten und Beschriftung, und die übrigen Messungen bleiben unverändert.
3. **Given** der „X“-Button ist sichtbar, **When** die Maus die Linie und den Button verlässt, **Then** verschwindet der Button wieder, die Linie bleibt.
4. **Given** ein Gerät ohne Maus (Touch), **When** die Person eine Linie antippt, **Then** erscheint ihr „X“-Button, und ein Tipp darauf entfernt die Messung. Ein Tipp an anderer Stelle der Karte blendet ihn wieder aus.
5. **Given** der Mess-Modus ist an und Punkt A einer neuen Messung gesetzt, **When** die Person bei einer anderen, fertigen Messung auf „X“ klickt, **Then** wird nur diese entfernt, und Punkt A der laufenden Messung bleibt gesetzt. Der Klick setzt keinen Messpunkt.

---

### Edge Cases

- **Überlappende Linien:** Verlaufen Linien an derselben Stelle (zum Beispiel mehrere vom Objekt aus), zeigt der Hover nur den „X“-Button der obersten, zuletzt angelegten Linie. Andere lassen sich erreichen, indem man an einer Stelle fährt, wo sie getrennt verlaufen, oder die oberste zuerst entfernt.
- **Viele Messungen:** Auch bei 20 Messungen bleibt die Karte flüssig bedienbar. Es gibt kein festes Limit.
- **Beschriftungen überdecken sich:** Liegen die Beschriftungen mehrerer Linien aufeinander, bleiben beide Linien und der „X“-Button der Linie unter dem Zeiger bedienbar. Eine automatische Überlappungsvermeidung gehört nicht zum Umfang.
- **Sehr kurze Linie:** Auch bei einer Linie von wenigen Metern, bei der Punkte und Beschriftung übereinander liegen, ist der „X“-Button erreichbar und überdeckt nicht beide Messpunkte vollständig.
- **Linie am Kartenrand:** Liegt die Mitte einer Linie außerhalb des sichtbaren Ausschnitts, bleibt die Messung bestehen. Der „X“-Button erscheint dort, wo die Person die Linie mit dem Zeiger trifft, und liegt vollständig im sichtbaren Kartenbereich.
- **Seitenwechsel:** Beim Neuladen oder Verlassen der Detailseite sind alle Messungen weg. Wer zu einer anderen Auktion wechselt, startet ohne Messungen.
- **Locale-Wechsel:** Entfernungsangaben aller sichtbaren Messungen folgen sofort dem Zahlenformat der neuen Sprache.
- **Popups:** Das Entfernen einer Messung öffnet kein Marker-Popup und schließt ein offenes nicht.

## Requirements *(mandatory)*

### Functional Requirements

**Messungen bleiben stehen**

- **FR-001**: Jede abgeschlossene Messung (Punkt A, Punkt B, Verbindungslinie, Entfernung in km) MUSS sichtbar bleiben, bis die Person sie entfernt oder die Detailseite verlässt.
- **FR-002**: Eine neue Messung DARF bestehende Messungen NICHT löschen. Ein Klick nach einer abgeschlossenen Messung beginnt eine neue mit Punkt A.
- **FR-003**: Das Beenden des Mess-Modus (Button oder Esc) MUSS alle abgeschlossenen Messungen sichtbar lassen. Eine angefangene Messung, bei der nur Punkt A gesetzt ist, MUSS dabei verworfen werden.
- **FR-004**: Jede Messung MUSS ihre eigene Entfernung als Beschriftung an der Linie zeigen. Die Entfernung MUSS wie bisher geodätisch und in km, in der Sprache der UI, angezeigt werden (Spec 006, FR-003, FR-004, FR-009).
- **FR-005**: Messungen MÜSSEN an ihren geografischen Positionen bleiben, auch bei Verschieben, Zoomen und beim Wechsel der Grundkarte.
- **FR-006**: Wenigstens die Entfernung der zuletzt abgeschlossenen Messung MUSS weiterhin für Screenreader-Nutzer im Hinweisbereich des Mess-Modus bekanntgegeben werden.

**Einzelne Messung entfernen**

- **FR-007**: Beim Darüberfahren mit dem Zeiger MUSS eine Distanzlinie einen schwebenden „X“-Button anzeigen. Der „X“-Button MUSS verschwinden, wenn der Zeiger die Linie und den Button verlässt.
- **FR-008**: Ein Klick auf den „X“-Button MUSS genau die zugehörige Messung entfernen (Punkte, Linie, Beschriftung) und alle anderen unverändert lassen.
- **FR-009**: Auf Geräten ohne Hover MUSS ein Antippen der Linie den „X“-Button einblenden, und ein Tipp auf den Button MUSS die Messung entfernen. Ein Tipp an anderer Stelle der Karte MUSS den Button wieder ausblenden.
- **FR-010**: Der „X“-Button MUSS per Tastatur erreichbar und für Screenreader beschriftet sein (z. B. „Messung entfernen“), und die Beschriftung MUSS in allen UI-Sprachen der App vorliegen.
- **FR-011**: Ein Klick oder Tipp auf den „X“-Button DARF KEINEN Messpunkt setzen und KEIN Marker-Popup öffnen oder schließen.
- **FR-012**: Das Entfernen einer Messung DARF eine gerade laufende Messung (Punkt A gesetzt) NICHT verändern.

**Unverändert aus Spec 006**

- **FR-013**: Alle übrigen Regeln des Mess-Modus bleiben bestehen: Button zum Ein- und Ausschalten, Hinweis, Esc beendet den Modus, Marker-Popups sind im Modus aus, Verschieben und Zoomen setzen keine Punkte.
- **FR-014**: Die Funktion DARF KEINE neue Softwareabhängigkeit einführen.

### Key Entities

- **Messung**: Eine abgeschlossene Strecke aus Punkt A und Punkt B mit der daraus berechneten Entfernung in km. Hat eine eigene Identität, damit genau sie entfernt werden kann. Besteht nur im Browser, solange die Detailkarte offen ist.
- **Laufende Messung**: Eine angefangene Strecke, bei der nur Punkt A gesetzt ist. Es gibt höchstens eine, und sie existiert nur im Mess-Modus.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: Eine Person kann mindestens 10 Messungen gleichzeitig auf einer Detailkarte sehen. Keine ist eine Beschriftung oder eine Linie, die ohne Eingreifen der Person verschwindet.
- **SC-002**: Nach dem Beenden des Mess-Modus sind 100 % der abgeschlossenen Messungen noch sichtbar.
- **SC-003**: Eine Messung lässt sich in höchstens zwei Aktionen entfernen (Zeiger auf die Linie, Klick auf „X“; auf Touch: antippen, tippen).
- **SC-004**: Das Entfernen einer Messung verändert in 100 % der Fälle keine andere Messung.
- **SC-005**: Die Karte bleibt auch mit 20 Messungen ohne spürbare Verzögerung bedienbar (Verschieben, Zoomen und Entfernen reagieren sofort).

## Assumptions

- Messungen werden nicht gespeichert, nicht geteilt und nicht in die URL geschrieben. Beim Neuladen oder Verlassen der Seite sind sie weg (wie in Spec 006).
- Es gibt kein festes Maximum an Messungen. Praktisch relevant sind einstellige Anzahlen.
- Ein einzelner Befehl „Alle entfernen“ gehört nicht zum Umfang, denn jede Messung lässt sich einzeln löschen.
- Das nachträgliche Verschieben von Punkten, mehr als zwei Punkte je Messung, Flächenmessung und Wegstrecken bleiben ausgeschlossen (Spec 006, Annahmen).
- Messungen unterscheiden sich in Farbe und Form nicht voneinander. Die Beschriftung an jeder Linie genügt zur Zuordnung.
- Die Messfunktion gibt es weiterhin nur auf der Detailkarte der Auktion, nicht auf der Suchkarte.
- Der Hover-Bereich der Linie ist so großzügig, dass ein Zeiger ihn auch bei dünner Linie trifft (wie bei Karten üblich einige Pixel Toleranz). Das genaue Maß legt die Planung fest.
