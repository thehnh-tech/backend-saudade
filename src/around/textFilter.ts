import { PROHIBITED_TERMS } from "./prohibitedTerms.js";

// ---------------------------------------------------------------------------
// A-priori filter for the two pieces of user free text this product pushes to
// people who never asked for them: the NAME of an around (broadcast as the
// notification announcing that around to every radar-enabled stranger inside
// the radius — it lands on locked screens) and the PSEUDO shown next to it.
//
// This is a first-line guard, NOT moderation. It is honest about what it does:
//
// WHAT IT CATCHES
//   * contact channels: http(s) URLs, bare domains on a common TLD, e-mail
//     addresses, phone numbers, social-network handles ("@someone",
//     "insta: ...", "snap: ..."). An around name must not be a broadcast
//     channel pointing strangers somewhere else.
//   * the short, documented list of hate/explicit terms in prohibitedTerms.ts,
//     including the cheap obfuscations: accents, leetspeak ("s4l0pe"),
//     repeated letters ("salooope"), separators between letters
//     ("s.a.l.o.p.e") and a trailing plural.
//
// WHAT IT DOES NOT CATCH — and never will
//   * anything in the many languages the term list does not cover, any novel
//     spelling, phonetic rewrite, homoglyph (a Cyrillic "a" for a Latin one),
//     emoji rebus, or simply an insult aimed at one specific person by name.
//   * TLDs outside the list below, and phone numbers written out in words.
//   * everything that is objectionable without containing a listed token.
// The recourse the Terms actually promise (§6) is the REPORT flow, open to
// anyone who sees the name — including someone who only received the push and
// never joined: POST /api/arounds/:id/report.
//
// It never throws: callers get a typed result and turn it into a 400.
// ---------------------------------------------------------------------------

export type TextFilterReason = "contact_info" | "prohibited_term";
export type TextFilterResult = { ok: true } | { ok: false; reason: TextFilterReason };
export type UserTextKind = "aroundName" | "pseudo";

// Common TLDs only, and deliberately WITHOUT the ones that are also ordinary
// French/English words ("at", "in", "it", "no", "to", "st", "sh"): a bare
// "foo.bar" on an exotic TLD is not caught, but a scheme ("https://") or a
// "www." prefix is, whatever the TLD.
const TLDS = [
  "com", "net", "org", "info", "biz", "xyz", "app", "io", "co", "me", "tv", "cc", "gg",
  "link", "live", "site", "online", "shop", "club", "ly",
  "fr", "ch", "be", "lu", "ca", "uk", "de", "es", "nl", "pt", "pl", "se", "dk", "fi",
  "cz", "ie", "ru", "us", "eu"
].join("|");

// Deliberately narrow: only the platforms whose name is a routing instruction
// ("insta:", "snap@") and never an ordinary French or English word.
const SOCIAL_KEYWORDS = [
  "insta", "instagram", "snap", "snapchat", "tiktok", "telegram", "whatsapp",
  "discord", "onlyfans", "twitter", "facebook", "linkedin", "threema", "viber",
  "wechat", "messenger"
].join("|");

// Soft hyphen, zero-width spaces/joiners, word joiner, BOM: invisible on
// screen, but they split a word in two for any naive matcher. Written as
// escapes on purpose — these characters must never appear literally in source.
const INVISIBLE = new RegExp("[\\u00ad\\u200b-\\u200f\\u2060\\ufeff]", "g");
const COMBINING_MARKS = new RegExp("[\\u0300-\\u036f]", "g");

function stripDiacritics(value: string) {
  return value.normalize("NFD").replace(COMBINING_MARKS, "");
}

// Shared first stage: lowercase, no accents, no invisible characters,
// whitespace collapsed. PUNCTUATION IS PRESERVED — the contact rules need the
// dots, the "@" and the digits exactly as typed.
function baseNormalize(value: string) {
  return stripDiacritics(value.toLowerCase())
    .replace(INVISIBLE, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Second stage, term matching only: the usual character substitutions. Applied
// AFTER the contact rules have run, because it would eat the "@" they need.
const LEET: Record<string, string> = {
  "4": "a", "@": "a", "3": "e", "1": "i", "!": "i", "|": "i", "0": "o", "$": "s", "5": "s", "7": "t"
};

function deleet(value: string) {
  return value.replace(/[4@31!|0$57]/g, (character) => LEET[character] ?? character);
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Compiles one entry of PROHIBITED_TERMS into a regex tolerant to the cheap
// obfuscations, and ONLY matching on a word boundary so an entry can never fire
// inside a longer legitimate word ("porn" must not match "popcorn").
//   - every letter may be repeated:            saloooope
//   - any non-alphanumeric run between them:   s.a.l.o.p.e / "white power"
//   - an optional plural suffix:               salopes / encules
// The boundary is `[a-z]`, not `[a-z0-9]`: after the leetspeak pass a leftover
// digit is as good as a separator.
// The letter classes and the separator class are disjoint, so these patterns
// cannot backtrack catastrophically (inputs are 60 chars max anyway).
function compileTerm(term: string): RegExp {
  const letters = [...baseNormalize(term).replace(/[^a-z0-9]/g, "")];
  const body = letters.map((letter) => `${escapeRegex(letter)}+`).join("[^a-z0-9]*");
  return new RegExp(`(?<![a-z])${body}(?:e?s)?(?![a-z])`);
}

const COMPILED_TERMS = PROHIBITED_TERMS.map(compileTerm);

// "instagram dot com" written out. Only "dot" — never the French "point",
// which is an ordinary word ("le point de rendez-vous").
function undot(value: string) {
  return value.replace(/\s*[([]?\s*dot\s*[)\]]?\s*/g, ".");
}

const URL_SCHEME = /(?:https?|ftp):\/\//;
const WWW_PREFIX = /(?<![a-z0-9])www\.[a-z0-9-]/;
const EMAIL = new RegExp(`[a-z0-9._%+-]+\\s*@\\s*[a-z0-9.-]+\\.(?:${TLDS})(?![a-z])`);
const DOMAIN = new RegExp(`(?<![a-z0-9@.])[a-z0-9][a-z0-9-]*\\.(?:${TLDS})(?![a-z0-9])`);
const SOCIAL_KEYWORD = new RegExp(`(?<![a-z])(?:${SOCIAL_KEYWORDS})\\s*[:=@/]`);
// A bare handle. 4+ characters so a venue shorthand ("@sat") is not swept up;
// a name is still free to say "soiree a lausanne" instead of "@lausanne".
const BARE_HANDLE = /(?:^|[^a-z0-9._-])@[a-z0-9._-]{4,}/;
// Digit runs held together by the usual phone separators.
const DIGIT_RUN = /\d[\d\s.()/+-]*\d/g;
// A 4-digit group starting with 19 or 20 is a year, not a phone fragment. It is
// dropped before counting, otherwise "Nouvel an 01.01.2026 20h" (10 digits in
// one run) would be refused as a phone number.
const YEAR_GROUP = /^(?:19|20)\d\d$/;

type Rules = {
  minPhoneDigits: number;
  checkBareHandle: boolean;
};

// A pseudo is already constrained to 3-24 chars of [a-zA-Z0-9._-] by
// PSEUDO_PATTERN (no space, no "@"), and digits are perfectly normal in one
// ("nightowl2026"), so the bare-handle rule is pointless there and the phone
// threshold is raised by one digit to keep numeric pseudos usable. An around
// name is free text up to 60 chars, so it gets the strict variant.
const RULES: Record<UserTextKind, Rules> = {
  aroundName: { minPhoneDigits: 9, checkBareHandle: true },
  pseudo: { minPhoneDigits: 10, checkBareHandle: false }
};

function looksLikePhoneNumber(value: string, minDigits: number) {
  for (const match of value.matchAll(DIGIT_RUN)) {
    const digits = (match[0].match(/\d+/g) ?? [])
      .filter((group) => !YEAR_GROUP.test(group))
      .join("").length;
    if (digits >= minDigits) return true;
  }
  return false;
}

function hasContactInfo(value: string, rules: Rules) {
  const text = undot(value);
  if (URL_SCHEME.test(text)) return true;
  if (WWW_PREFIX.test(text)) return true;
  if (EMAIL.test(text)) return true;
  if (DOMAIN.test(text)) return true;
  if (SOCIAL_KEYWORD.test(text)) return true;
  if (rules.checkBareHandle && BARE_HANDLE.test(text)) return true;
  return looksLikePhoneNumber(text, rules.minPhoneDigits);
}

function hasProhibitedTerm(value: string) {
  const text = deleet(value);
  return COMPILED_TERMS.some((pattern) => pattern.test(text));
}

/**
 * Checks one piece of user-supplied text. Returns a typed verdict, never
 * throws — an unexpected failure inside the filter fails OPEN (the text is
 * accepted, the incident logged) because the report flow, not this function,
 * is the recourse the Terms promise: a bug here must not make the app
 * impossible to use.
 */
export function checkUserText(value: string, kind: UserTextKind): TextFilterResult {
  try {
    if (typeof value !== "string") return { ok: true };
    const normalized = baseNormalize(value);
    if (!normalized) return { ok: true };
    const rules = RULES[kind] ?? RULES.aroundName;
    if (hasContactInfo(normalized, rules)) return { ok: false, reason: "contact_info" };
    if (hasProhibitedTerm(normalized)) return { ok: false, reason: "prohibited_term" };
    return { ok: true };
  } catch (error) {
    console.error("[around:textFilter] check failed, accepting the text", error);
    return { ok: true };
  }
}
