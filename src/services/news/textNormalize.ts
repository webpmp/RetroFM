/**
 * @license
 * SPDX-License-Identifier: MIT
 *
 * Round 7: dependency-free text normalization shared by the news service and the break validator.
 */

/**
 * Round 7 P3: Acronyms that may legitimately appear in ALL CAPS in spoken prose.
 * Any other all-caps word of 2+ letters in news prose is lowercased (normalizeLoneAllCapsWords)
 * or rejected by the read-aloud lint.
 */
export const KNOWN_ACRONYMS = new Set([
  'US', 'USA', 'UN', 'UK', 'USSR', 'NATO', 'SEATO', 'CENTO', 'OPEC', 'EEC', 'ABM', 'ICBM', 'SALT', 'MIRV', 'DMZ',
  'FBI', 'CIA', 'FDA', 'EPA', 'FAA', 'FCC', 'FTC', 'SEC', 'ICC', 'IRS', 'NLRB', 'NASA', 'LEM', 'IRA', 'PLO', 'ANC',
  'SWAPO', 'AFP', 'AP', 'UPI', 'TV', 'FM', 'AM', 'PM', 'GOP', 'AFL', 'CIO', 'UAW', 'UMW', 'DNA', 'RNA', 'AIDS',
  'HIV', 'DDT', 'LSD', 'GNP', 'GDP', 'CEO', 'NAACP', 'CORE', 'SNCC', 'ROTC', 'GI', 'GIS', 'MIA', 'POW', 'POWS',
  'NBC', 'CBS', 'ABC', 'BBC', 'CNN', 'PBS', 'MTV', 'DJ', 'OK', 'II', 'III', 'IV', 'VI', 'VII', 'VIII', 'IX', 'XI',
  'DC', 'BC', 'AD', 'MX', 'SDI', 'INF', 'START', 'KGB', 'IBM', 'AT', 'RCA', 'TWA', 'NFL', 'NBA', 'NHL', 'NCAA',
  'UNICEF', 'UNESCO', 'OAS', 'SST', 'HUD', 'NYU', 'UCLA', 'MIT', 'IMF', 'GATT', 'NAFTA', 'EC', 'EU', 'PCB', 'PCBS',
]);

/**
 * Round 7 P3: Lowercases lone ALL-CAPS words (2+ letters) in prose that are not known acronyms,
 * leaving quoted strings (song titles) and explicitly exempt words (artist names) untouched.
 * Example: "no FOREIGNERS would establish" -> "no foreigners would establish".
 */
export function normalizeLoneAllCapsWords(text: string, exemptWords: string[] = []): string {
  if (!text) return '';
  const exempt = new Set(exemptWords.map((w) => w.replace(/[^A-Za-z]/g, '').toUpperCase()).filter(Boolean));
  // Split on double-quoted spans so song titles in quotes are never altered
  return text
    .split(/("[^"]*"|“[^”]*”)/)
    .map((chunk, i) => {
      if (i % 2 === 1) return chunk;
      return chunk.replace(/\b([A-Z][A-Z'’]*[A-Z])\b(?!\.[A-Z])/g, (word, _w, offset: number, whole: string) => {
        const bare = word.replace(/['’]/g, '');
        if (bare.length < 2) return word;
        if (KNOWN_ACRONYMS.has(bare) || exempt.has(bare)) return word;
        // Leave dotted acronyms like "U.S." alone (preceded by '.')
        if (offset > 0 && whole[offset - 1] === '.') return word;
        // Leave 4+ word all-caps runs to the lint (they indicate a raw headline, which must be rejected, not disguised)
        const lower = word.toLowerCase();
        const atSentenceStart = offset === 0 || /[.!?]\s+$/.test(whole.slice(0, offset));
        return atSentenceStart ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
      });
    })
    .join('');
}

