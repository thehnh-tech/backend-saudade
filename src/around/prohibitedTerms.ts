// ---------------------------------------------------------------------------
// Prohibited terms for the a-priori filter of textFilter.ts.
//
// SCOPE — read this before adding anything.
// This list is deliberately SHORT, and it is NOT a moderation system. It is a
// first-line guard on the two pieces of free text this product broadcasts to
// people who never opted into them: the name of an around (pushed as a
// notification to strangers nearby) and the pseudo shown next to it. The real
// recourse is the report flow (POST /api/arounds/:id/report, plus the existing
// photo and user reports), reviewed by a human within 24 h.
//
// WHAT IS IN
//   * unambiguous hate slurs (racist, antisemitic, homophobic, transphobic)
//   * explicit nazi rallying cries
//   * explicit pornographic vocabulary — the kind that only ever appears as an
//     advertisement or an insult, never in the name of a party
//   * child-abuse and bestiality vocabulary
//
// WHAT IS DELIBERATELY OUT — and why
//   * ordinary vulgarity ("putain", "merde", "fuck", "shit"): ubiquitous in
//     French casual speech and in nightlife names. Blocking it would produce
//     constant false positives for no compliance gain — §5 of the Terms bans
//     hateful and pornographic content, not swearing.
//   * words that are legitimate in another context, because the normalisation
//     that defeats obfuscation also erases the difference: "viol" (violence,
//     violet, violon), "rape" (French "râpé" once accents are stripped),
//     "chatte" (a cat), "cul" (cul-de-sac), "con" (concert, confiance),
//     "pédale" (a bicycle part), "negro" (Negroni, "negro spiritual").
//     Every one of them is a false-positive generator; they are left to the
//     report flow, which is the mechanism the Terms actually promise.
//   * every language other than French and English. Not covered. Reports are.
//
// This list will always be incomplete and is trivially bypassable by anyone who
// tries (a novel spelling, another language, an emoji, a homoglyph, a phonetic
// rewrite). It is a speed bump against the lazy case, nothing more. Do not
// describe it as exhaustive anywhere, in code or in the product.
//
// MATCHING (implemented in textFilter.ts, not here)
// Each entry is compiled into a regex that tolerates repeated letters
// ("saloooope"), separators between letters ("s.a.l.o.p.e"), accents, the
// common leetspeak substitutions, and a trailing plural — but ONLY on word
// boundaries, so an entry can never match inside a longer legitimate word.
// Write entries in plain lowercase letters; spaces are allowed and are matched
// loosely (they also match "no space at all").
// ---------------------------------------------------------------------------

export const PROHIBITED_TERMS: readonly string[] = [
  // --- racist / antisemitic slurs (FR) ---
  "bougnoule",
  "negresse",
  "bicot",
  "youpin",
  // --- racist / antisemitic slurs (EN) ---
  "nigger",
  "nigga",
  "kike",
  "chink",
  "gook",
  "wetback",
  // --- homophobic / transphobic slurs ---
  "gouine",
  "faggot",
  "tranny",
  "shemale",
  // --- nazi rallying cries ---
  "sieg heil",
  "heil hitler",
  "white power",
  "gas the jews",
  // --- explicit pornographic vocabulary (FR) ---
  "salope",
  "grosse pute",
  "suce ma bite",
  "nique ta mere",
  "encule",
  "branlette",
  "sodomie",
  "ejaculation",
  "fellation",
  // --- explicit pornographic vocabulary (EN) ---
  "blowjob",
  "cumshot",
  "creampie",
  "deepthroat",
  "gangbang",
  "bukkake",
  "porn",
  "porno",
  "pornhub",
  "onlyfans",
  // --- child abuse / bestiality ---
  "pedophile",
  "pedophilie",
  "zoophilie",
  "child porn",
  "jailbait"
];
