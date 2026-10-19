// This file works out which currency a service report uses, by plain rules and never by the LLM.
// An ISO code wins. Then a bare "$" means USD, and "€" means EUR. Anything else stays unknown.

import type { Currency } from "./schema";

const ISO_CODES =
  /\b(USD|EUR|AUD|CAD|SEK|ZAR|GBP|NOK|DKK|CHF|CLP|PEN|BRL|MXN|ARS|RUB|CNY|INR|JPY|NZD|ZMW|KZT|IDR|PHP)\b/g;

export function resolveCurrency(fileText: string): Currency | null {
  const lines = fileText.split("\n").map((line) => line.trim());
  const hits = lines.flatMap((line) => [...line.matchAll(ISO_CODES)].map((match) => ({ code: match[1], line })));
  if (new Set(hits.map((hit) => hit.code)).size > 1) return null;
  if (hits.length) {
    const prose = hits.find((hit) => !hit.line.startsWith("|"));
    return { code: hits[0].code, source: prose ? "iso_code" : "header", quote: (prose ?? hits[0]).line };
  }
  const dollar = lines.find((line) => line.includes("$"));
  if (dollar) return { code: "USD", source: "sign_usd", quote: dollar };
  const euro = lines.find((line) => line.includes("€"));
  if (euro) return { code: "EUR", source: "sign_eur", quote: euro };
  return null;
}
