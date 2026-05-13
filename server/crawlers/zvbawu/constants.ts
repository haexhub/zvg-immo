import type { RegionInfo } from '../types'

export const ZVBAWU_BASE = 'https://xn--zvbaw-ova.de'
export const UA = 'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/130.0'

export const COUNTRY = 'de'

export const DE_REGIONS: readonly RegionInfo[] = [
  { code: 'bw', name: 'Baden-Württemberg' },
] as const

// 35 BW Amtsgerichte as published on the zvbawü.de index page. The {slug}.{id}
// suffix is the canonical court id; both parts together form the URL path. The
// list is fetched once and cached at module load — see fetchCourts() — but we
// keep this static fallback so a transient failure of the index page does not
// block the whole crawl.
export const BW_COURTS_FALLBACK: ReadonlyArray<{ slug: string; name: string }> = [
  { slug: 'albstadt.92332', name: 'Albstadt' },
  { slug: 'baden-baden.35828', name: 'Baden-Baden' },
  { slug: 'balingen.92384', name: 'Balingen' },
  { slug: 'biberach.34641', name: 'Biberach' },
  { slug: 'bruchsal-vollstreckungsgericht.31058', name: 'Bruchsal' },
  { slug: 'calw.2433', name: 'Calw' },
  { slug: 'crailsheim.92447', name: 'Crailsheim' },
  { slug: 'emmendingen.19130', name: 'Emmendingen' },
  { slug: 'freiburg.4387', name: 'Freiburg' },
  { slug: 'freudenstadt.4386', name: 'Freudenstadt' },
  { slug: 'hechingen.92578', name: 'Hechingen' },
  { slug: 'heidenheim.34642', name: 'Heidenheim' },
  { slug: 'karlsruhe.2', name: 'Karlsruhe' },
  { slug: 'kehl.92622', name: 'Kehl' },
  { slug: 'konstanz.2593', name: 'Konstanz' },
  { slug: 'lahrschwarzwald.92644', name: 'Lahr/Schwarzwald' },
  { slug: 'loerrach.92669', name: 'Lörrach' },
  { slug: 'mannheim.2739', name: 'Mannheim' },
  { slug: 'mosbach.2313', name: 'Mosbach' },
  { slug: 'offenburg.92753', name: 'Offenburg' },
  { slug: 'pforzheim.328', name: 'Pforzheim' },
  { slug: 'rastatt.2244', name: 'Rastatt' },
  { slug: 'ravensburg.92793', name: 'Ravensburg' },
  { slug: 'reutlingen.92798', name: 'Reutlingen' },
  { slug: 'rottweil.2494', name: 'Rottweil' },
  { slug: 'schwaebisch-hall.164701', name: 'Schwäbisch Hall' },
  { slug: 'sigmaringen.92848', name: 'Sigmaringen' },
  { slug: 'tettnang.92890', name: 'Tettnang' },
  { slug: 'tuebingen.92898', name: 'Tübingen' },
  { slug: 'tuttlingen.92899', name: 'Tuttlingen' },
  { slug: 'ueberlingen.92900', name: 'Überlingen' },
  { slug: 'ulm.11794', name: 'Ulm' },
  { slug: 'vaihingen-an-der-enz.92905', name: 'Vaihingen an der Enz' },
  { slug: 'waldshut-tiengen.84736', name: 'Waldshut-Tiengen' },
  { slug: 'wolfach.92953', name: 'Wolfach' },
]
