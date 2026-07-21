// Curated German place names for the location-search autocomplete
// (components/search/LocationAutocomplete.vue), matching zvgscout.com's
// type-ahead: a name + its Bundesland, so a user typing a partial place name
// gets suggestions instead of guessing exact spelling. DE-only for now (see
// server/crawlers/registry.ts's ENABLED_COUNTRIES) — reusable for other
// countries later by adding more `country: 'xx'` entries.
//
// This is a curated selection of state capitals and well-known cities/towns
// (roughly the ~250 largest), not the full ~11,000-entry German municipality
// register (Destatis Gemeindeverzeichnis) — building/verifying that full list
// wasn't practical to do reliably by hand. Expanding coverage later is a
// pure data change here, no component/architecture change needed.

export interface DePlace {
  name: string
  region: string
}

export const DE_PLACES: readonly DePlace[] = [
  // Baden-Württemberg
  { name: 'Stuttgart', region: 'Baden-Württemberg' },
  { name: 'Mannheim', region: 'Baden-Württemberg' },
  { name: 'Karlsruhe', region: 'Baden-Württemberg' },
  { name: 'Freiburg im Breisgau', region: 'Baden-Württemberg' },
  { name: 'Heidelberg', region: 'Baden-Württemberg' },
  { name: 'Heilbronn', region: 'Baden-Württemberg' },
  { name: 'Ulm', region: 'Baden-Württemberg' },
  { name: 'Pforzheim', region: 'Baden-Württemberg' },
  { name: 'Reutlingen', region: 'Baden-Württemberg' },
  { name: 'Esslingen am Neckar', region: 'Baden-Württemberg' },
  { name: 'Ludwigsburg', region: 'Baden-Württemberg' },
  { name: 'Tübingen', region: 'Baden-Württemberg' },
  { name: 'Villingen-Schwenningen', region: 'Baden-Württemberg' },
  { name: 'Konstanz', region: 'Baden-Württemberg' },
  { name: 'Aalen', region: 'Baden-Württemberg' },
  { name: 'Sindelfingen', region: 'Baden-Württemberg' },
  { name: 'Böblingen', region: 'Baden-Württemberg' },
  { name: 'Waiblingen', region: 'Baden-Württemberg' },
  { name: 'Schwäbisch Gmünd', region: 'Baden-Württemberg' },
  { name: 'Baden-Baden', region: 'Baden-Württemberg' },
  { name: 'Offenburg', region: 'Baden-Württemberg' },
  { name: 'Ravensburg', region: 'Baden-Württemberg' },
  { name: 'Friedrichshafen', region: 'Baden-Württemberg' },
  { name: 'Göppingen', region: 'Baden-Württemberg' },
  { name: 'Rastatt', region: 'Baden-Württemberg' },

  // Bayern
  { name: 'München', region: 'Bayern' },
  { name: 'Nürnberg', region: 'Bayern' },
  { name: 'Augsburg', region: 'Bayern' },
  { name: 'Regensburg', region: 'Bayern' },
  { name: 'Ingolstadt', region: 'Bayern' },
  { name: 'Würzburg', region: 'Bayern' },
  { name: 'Fürth', region: 'Bayern' },
  { name: 'Erlangen', region: 'Bayern' },
  { name: 'Bayreuth', region: 'Bayern' },
  { name: 'Bamberg', region: 'Bayern' },
  { name: 'Aschaffenburg', region: 'Bayern' },
  { name: 'Landshut', region: 'Bayern' },
  { name: 'Kempten (Allgäu)', region: 'Bayern' },
  { name: 'Rosenheim', region: 'Bayern' },
  { name: 'Neu-Ulm', region: 'Bayern' },
  { name: 'Schweinfurt', region: 'Bayern' },
  { name: 'Passau', region: 'Bayern' },
  { name: 'Freising', region: 'Bayern' },
  { name: 'Straubing', region: 'Bayern' },
  { name: 'Dachau', region: 'Bayern' },
  { name: 'Coburg', region: 'Bayern' },
  { name: 'Ansbach', region: 'Bayern' },
  { name: 'Weiden in der Oberpfalz', region: 'Bayern' },
  { name: 'Hof', region: 'Bayern' },
  { name: 'Memmingen', region: 'Bayern' },
  { name: 'Amberg', region: 'Bayern' },
  { name: 'Garmisch-Partenkirchen', region: 'Bayern' },
  { name: 'Fürstenfeldbruck', region: 'Bayern' },

  // Berlin
  { name: 'Berlin', region: 'Berlin' },

  // Brandenburg
  { name: 'Potsdam', region: 'Brandenburg' },
  { name: 'Cottbus', region: 'Brandenburg' },
  { name: 'Brandenburg an der Havel', region: 'Brandenburg' },
  { name: 'Frankfurt (Oder)', region: 'Brandenburg' },
  { name: 'Oranienburg', region: 'Brandenburg' },
  { name: 'Falkensee', region: 'Brandenburg' },
  { name: 'Eberswalde', region: 'Brandenburg' },
  { name: 'Bernau bei Berlin', region: 'Brandenburg' },
  { name: 'Königs Wusterhausen', region: 'Brandenburg' },
  { name: 'Neuruppin', region: 'Brandenburg' },
  { name: 'Angermünde', region: 'Brandenburg' },

  // Bremen
  { name: 'Bremen', region: 'Bremen' },
  { name: 'Bremerhaven', region: 'Bremen' },

  // Hamburg
  { name: 'Hamburg', region: 'Hamburg' },

  // Hessen
  { name: 'Frankfurt am Main', region: 'Hessen' },
  { name: 'Wiesbaden', region: 'Hessen' },
  { name: 'Kassel', region: 'Hessen' },
  { name: 'Darmstadt', region: 'Hessen' },
  { name: 'Offenbach am Main', region: 'Hessen' },
  { name: 'Hanau', region: 'Hessen' },
  { name: 'Gießen', region: 'Hessen' },
  { name: 'Marburg', region: 'Hessen' },
  { name: 'Fulda', region: 'Hessen' },
  { name: 'Rüsselsheim am Main', region: 'Hessen' },
  { name: 'Wetzlar', region: 'Hessen' },
  { name: 'Bad Homburg vor der Höhe', region: 'Hessen' },
  { name: 'Limburg an der Lahn', region: 'Hessen' },

  // Mecklenburg-Vorpommern
  { name: 'Rostock', region: 'Mecklenburg-Vorpommern' },
  { name: 'Schwerin', region: 'Mecklenburg-Vorpommern' },
  { name: 'Neubrandenburg', region: 'Mecklenburg-Vorpommern' },
  { name: 'Stralsund', region: 'Mecklenburg-Vorpommern' },
  { name: 'Greifswald', region: 'Mecklenburg-Vorpommern' },
  { name: 'Wismar', region: 'Mecklenburg-Vorpommern' },
  { name: 'Güstrow', region: 'Mecklenburg-Vorpommern' },

  // Niedersachsen
  { name: 'Hannover', region: 'Niedersachsen' },
  { name: 'Braunschweig', region: 'Niedersachsen' },
  { name: 'Osnabrück', region: 'Niedersachsen' },
  { name: 'Oldenburg (Oldb)', region: 'Niedersachsen' },
  { name: 'Wolfsburg', region: 'Niedersachsen' },
  { name: 'Göttingen', region: 'Niedersachsen' },
  { name: 'Salzgitter', region: 'Niedersachsen' },
  { name: 'Hildesheim', region: 'Niedersachsen' },
  { name: 'Delmenhorst', region: 'Niedersachsen' },
  { name: 'Lüneburg', region: 'Niedersachsen' },
  { name: 'Celle', region: 'Niedersachsen' },
  { name: 'Wilhelmshaven', region: 'Niedersachsen' },
  { name: 'Garbsen', region: 'Niedersachsen' },
  { name: 'Hameln', region: 'Niedersachsen' },
  { name: 'Emden', region: 'Niedersachsen' },
  { name: 'Nordhorn', region: 'Niedersachsen' },
  { name: 'Cuxhaven', region: 'Niedersachsen' },

  // Nordrhein-Westfalen
  { name: 'Köln', region: 'Nordrhein-Westfalen' },
  { name: 'Düsseldorf', region: 'Nordrhein-Westfalen' },
  { name: 'Dortmund', region: 'Nordrhein-Westfalen' },
  { name: 'Essen', region: 'Nordrhein-Westfalen' },
  { name: 'Duisburg', region: 'Nordrhein-Westfalen' },
  { name: 'Bochum', region: 'Nordrhein-Westfalen' },
  { name: 'Wuppertal', region: 'Nordrhein-Westfalen' },
  { name: 'Bielefeld', region: 'Nordrhein-Westfalen' },
  { name: 'Bonn', region: 'Nordrhein-Westfalen' },
  { name: 'Münster', region: 'Nordrhein-Westfalen' },
  { name: 'Gelsenkirchen', region: 'Nordrhein-Westfalen' },
  { name: 'Mönchengladbach', region: 'Nordrhein-Westfalen' },
  { name: 'Aachen', region: 'Nordrhein-Westfalen' },
  { name: 'Krefeld', region: 'Nordrhein-Westfalen' },
  { name: 'Oberhausen', region: 'Nordrhein-Westfalen' },
  { name: 'Hagen', region: 'Nordrhein-Westfalen' },
  { name: 'Hamm', region: 'Nordrhein-Westfalen' },
  { name: 'Mülheim an der Ruhr', region: 'Nordrhein-Westfalen' },
  { name: 'Leverkusen', region: 'Nordrhein-Westfalen' },
  { name: 'Solingen', region: 'Nordrhein-Westfalen' },
  { name: 'Herne', region: 'Nordrhein-Westfalen' },
  { name: 'Neuss', region: 'Nordrhein-Westfalen' },
  { name: 'Paderborn', region: 'Nordrhein-Westfalen' },
  { name: 'Bottrop', region: 'Nordrhein-Westfalen' },
  { name: 'Recklinghausen', region: 'Nordrhein-Westfalen' },
  { name: 'Remscheid', region: 'Nordrhein-Westfalen' },
  { name: 'Siegen', region: 'Nordrhein-Westfalen' },
  { name: 'Iserlohn', region: 'Nordrhein-Westfalen' },
  { name: 'Bergisch Gladbach', region: 'Nordrhein-Westfalen' },
  { name: 'Witten', region: 'Nordrhein-Westfalen' },
  { name: 'Moers', region: 'Nordrhein-Westfalen' },
  { name: 'Castrop-Rauxel', region: 'Nordrhein-Westfalen' },
  { name: 'Wesel', region: 'Nordrhein-Westfalen' },
  { name: 'Lünen', region: 'Nordrhein-Westfalen' },
  { name: 'Marl', region: 'Nordrhein-Westfalen' },
  { name: 'Detmold', region: 'Nordrhein-Westfalen' },
  { name: 'Gütersloh', region: 'Nordrhein-Westfalen' },
  { name: 'Minden', region: 'Nordrhein-Westfalen' },
  { name: 'Viersen', region: 'Nordrhein-Westfalen' },

  // Rheinland-Pfalz
  { name: 'Mainz', region: 'Rheinland-Pfalz' },
  { name: 'Ludwigshafen am Rhein', region: 'Rheinland-Pfalz' },
  { name: 'Koblenz', region: 'Rheinland-Pfalz' },
  { name: 'Trier', region: 'Rheinland-Pfalz' },
  { name: 'Kaiserslautern', region: 'Rheinland-Pfalz' },
  { name: 'Worms', region: 'Rheinland-Pfalz' },
  { name: 'Neuwied', region: 'Rheinland-Pfalz' },
  { name: 'Neustadt an der Weinstraße', region: 'Rheinland-Pfalz' },
  { name: 'Speyer', region: 'Rheinland-Pfalz' },
  { name: 'Frankenthal (Pfalz)', region: 'Rheinland-Pfalz' },
  { name: 'Bad Kreuznach', region: 'Rheinland-Pfalz' },
  { name: 'Landau in der Pfalz', region: 'Rheinland-Pfalz' },
  { name: 'Zweibrücken', region: 'Rheinland-Pfalz' },
  { name: 'Pirmasens', region: 'Rheinland-Pfalz' },
  { name: 'Otterberg', region: 'Rheinland-Pfalz' },
  { name: 'Homberg', region: 'Rheinland-Pfalz' },
  { name: 'Bad Bertrich', region: 'Rheinland-Pfalz' },
  { name: 'Bermel', region: 'Rheinland-Pfalz' },

  // Saarland
  { name: 'Saarbrücken', region: 'Saarland' },
  { name: 'Neunkirchen', region: 'Saarland' },
  { name: 'Homburg', region: 'Saarland' },
  { name: 'Völklingen', region: 'Saarland' },
  { name: 'Sankt Ingbert', region: 'Saarland' },
  { name: 'Saarlouis', region: 'Saarland' },

  // Sachsen
  { name: 'Leipzig', region: 'Sachsen' },
  { name: 'Dresden', region: 'Sachsen' },
  { name: 'Chemnitz', region: 'Sachsen' },
  { name: 'Zwickau', region: 'Sachsen' },
  { name: 'Plauen', region: 'Sachsen' },
  { name: 'Görlitz', region: 'Sachsen' },
  { name: 'Freiberg', region: 'Sachsen' },
  { name: 'Bautzen', region: 'Sachsen' },
  { name: 'Pirna', region: 'Sachsen' },
  { name: 'Radebeul', region: 'Sachsen' },

  // Sachsen-Anhalt
  { name: 'Magdeburg', region: 'Sachsen-Anhalt' },
  { name: 'Halle (Saale)', region: 'Sachsen-Anhalt' },
  { name: 'Dessau-Roßlau', region: 'Sachsen-Anhalt' },
  { name: 'Lutherstadt Wittenberg', region: 'Sachsen-Anhalt' },
  { name: 'Halberstadt', region: 'Sachsen-Anhalt' },
  { name: 'Stendal', region: 'Sachsen-Anhalt' },
  { name: 'Merseburg', region: 'Sachsen-Anhalt' },
  { name: 'Naumburg (Saale)', region: 'Sachsen-Anhalt' },

  // Schleswig-Holstein
  { name: 'Kiel', region: 'Schleswig-Holstein' },
  { name: 'Lübeck', region: 'Schleswig-Holstein' },
  { name: 'Flensburg', region: 'Schleswig-Holstein' },
  { name: 'Neumünster', region: 'Schleswig-Holstein' },
  { name: 'Norderstedt', region: 'Schleswig-Holstein' },
  { name: 'Elmshorn', region: 'Schleswig-Holstein' },
  { name: 'Pinneberg', region: 'Schleswig-Holstein' },
  { name: 'Itzehoe', region: 'Schleswig-Holstein' },
  { name: 'Rendsburg', region: 'Schleswig-Holstein' },
  { name: 'Husum', region: 'Schleswig-Holstein' },
  { name: 'Westerland', region: 'Schleswig-Holstein' },

  // Thüringen
  { name: 'Erfurt', region: 'Thüringen' },
  { name: 'Jena', region: 'Thüringen' },
  { name: 'Gera', region: 'Thüringen' },
  { name: 'Weimar', region: 'Thüringen' },
  { name: 'Gotha', region: 'Thüringen' },
  { name: 'Nordhausen', region: 'Thüringen' },
  { name: 'Eisenach', region: 'Thüringen' },
  { name: 'Suhl', region: 'Thüringen' },
  { name: 'Altenburg', region: 'Thüringen' },
] as const

/** Case/diacritic-insensitive prefix+substring match, ranked prefix-first. */
export function filterPlaces(query: string, limit = 8): DePlace[] {
  const q = query.trim().toLocaleLowerCase('de')
  if (q.length < 2) return []
  const starts: DePlace[] = []
  const contains: DePlace[] = []
  for (const place of DE_PLACES) {
    const name = place.name.toLocaleLowerCase('de')
    if (name.startsWith(q)) starts.push(place)
    else if (name.includes(q)) contains.push(place)
  }
  return [...starts, ...contains].slice(0, limit)
}
