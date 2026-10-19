// This file reads money amounts like "$1,639.00", "SEK 19,850" or "€62.00/hr" into plain numbers.

export function parseAmount(text: string): number | null {
  const bare = text
    .replace(/\b[A-Z]{3}\b|[$€]/g, "")
    .replace(/\s*\/\s*[a-z]+$/i, "")
    .trim();
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/.test(bare)) return null;
  return Number(bare.replaceAll(",", ""));
}

export function numbersIn(text: string): number[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(parseAmount).filter((n): n is number => n !== null);
}
