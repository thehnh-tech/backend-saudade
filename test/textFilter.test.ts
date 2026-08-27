import { describe, expect, it } from "vitest";

import { checkUserText } from "../src/around/textFilter.js";

// The filter is a first-line guard on the two texts broadcast to strangers
// (an around's name, a pseudo). The cases that matter most here are the ones
// that must PASS: a filter that refuses ordinary party names is worse than no
// filter at all, because the real recourse is the report flow.

describe("checkUserText — legitimate text is not refused", () => {
  const legitimateNames = [
    "Soiree chez Lea",
    "Anniv de Marc 30 ans",
    "Rooftop Lausanne",
    "Apero 18h30 au bord du lac",
    "Nouvel an 01.01.2026 20h",
    "Afterwork 2026",
    "Le point de rendez-vous",
    // The "word inside a word" trap: every one of these contains a listed term
    // as a raw substring, and none of them may be refused.
    "Popcorn & Netflix",     // porn
    "Negroni Night",         // negre/negro
    "Analyse de match",      // anal
    "Cul-de-sac party",      // cul
    "Scunthorpe United",     // the classic
    "Assassin's Creed LAN",  // ass
    "Fromage rape et vin",   // rape, once the accents are stripped
    "Concert au Sat",        // an @sat lookalike, without the @
    "Bassin de la Louve"     // -ass-
  ];

  for (const name of legitimateNames) {
    it(`accepts the around name ${JSON.stringify(name)}`, () => {
      expect(checkUserText(name, "aroundName")).toEqual({ ok: true });
    });
  }

  const legitimatePseudos = ["nightowl2026", "guest12", "j.doe", "pma-demo", "partygoer", "NightOwl", "user123456"];

  for (const pseudo of legitimatePseudos) {
    it(`accepts the pseudo ${JSON.stringify(pseudo)}`, () => {
      expect(checkUserText(pseudo, "pseudo")).toEqual({ ok: true });
    });
  }

  it("accepts an empty or blank value (nothing to filter)", () => {
    expect(checkUserText("", "aroundName")).toEqual({ ok: true });
    expect(checkUserText("   ", "aroundName")).toEqual({ ok: true });
  });
});

describe("checkUserText — contact channels", () => {
  const contactNames = [
    "Rejoins https://evil.example",
    "viens sur monsite.com",
    "www.truc.xyz",
    "ecris a moi@gmail.com",
    "appelle 06 12 34 56 78",
    "tel +41 79 123 45 67",
    "insta: bidule",
    "snap@toto",
    "@monhandle",
    "instagram dot com slash x"
  ];

  for (const name of contactNames) {
    it(`refuses ${JSON.stringify(name)} as contact_info`, () => {
      expect(checkUserText(name, "aroundName")).toEqual({ ok: false, reason: "contact_info" });
    });
  }

  it("refuses a pseudo that is a phone number or a domain", () => {
    expect(checkUserText("0612345678", "pseudo")).toEqual({ ok: false, reason: "contact_info" });
    expect(checkUserText("mysite.com", "pseudo")).toEqual({ ok: false, reason: "contact_info" });
  });

  it("does not apply the bare-handle rule to a pseudo (no @ is possible there)", () => {
    // The rule is off for pseudos on purpose: PSEUDO_PATTERN already forbids
    // "@", so the only thing the rule could do there is create false positives.
    expect(checkUserText("insta.fan", "pseudo")).toEqual({ ok: true });
  });
});

describe("checkUserText — prohibited terms and their cheap obfuscations", () => {
  const cases: [string, string][] = [
    ["salope", "plain"],
    ["Grosse Salope", "inside a sentence"],
    ["s4l0pe", "leetspeak"],
    ["SALOOOPE", "repeated letters"],
    ["s.a.l.o.p.e", "separators between letters"],
    ["salopes", "trailing plural"],
    ["sieg heil", "multi-word"],
    ["siegheil", "multi-word, no space"],
    ["gangbang party", "explicit"],
    ["porn night", "explicit"],
    ["n1gger", "slur, leetspeak"],
    ["bougnoule", "slur"]
  ];

  for (const [value, label] of cases) {
    it(`refuses ${JSON.stringify(value)} (${label})`, () => {
      expect(checkUserText(value, "aroundName")).toEqual({ ok: false, reason: "prohibited_term" });
    });
  }

  it("refuses a prohibited term written with accents", () => {
    expect(checkUserText("sàlöpe", "aroundName")).toEqual({ ok: false, reason: "prohibited_term" });
  });

  it("refuses a prohibited term split by a zero-width character", () => {
    // U+200B built from its code point: an invisible character must never sit
    // literally in a source file.
    const zeroWidthSpace = String.fromCodePoint(0x200b);
    expect(checkUserText(`salo${zeroWidthSpace}pe`, "aroundName")).toEqual({ ok: false, reason: "prohibited_term" });
  });

  it("applies the same list to pseudos", () => {
    expect(checkUserText("bougnoule", "pseudo")).toEqual({ ok: false, reason: "prohibited_term" });
  });
});

describe("checkUserText — contract", () => {
  it("never throws, whatever it is given", () => {
    expect(() => checkUserText(undefined as unknown as string, "aroundName")).not.toThrow();
    expect(checkUserText(undefined as unknown as string, "aroundName")).toEqual({ ok: true });
    expect(() => checkUserText("x".repeat(5000), "aroundName")).not.toThrow();
  });

  it("reports contact_info first when a value is both", () => {
    expect(checkUserText("salope.com", "aroundName")).toEqual({ ok: false, reason: "contact_info" });
  });
});
