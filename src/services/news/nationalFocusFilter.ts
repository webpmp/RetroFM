/**
 * @license
 * SPDX-License-Identifier: MIT
 */

export interface NationalFocusEvaluation {
  keep: boolean;
  reason: string;
  isFrontPage: boolean;
  desk?: string;
  section?: string;
  matchedNycLocation?: string;
  matchedNycTeam?: string;
}

/**
 * Evaluates whether an NYT archive article doc satisfies the National Focus criteria:
 *
 * Keep rules:
 * - Ran on front page (print_section: 'A', print_page: '1' or '01')
 * - Desk is National, Foreign, Washington, Business, Financial, Science, Arts, Culture, Style, or Weekend
 * - Sports item about a league, national event, or championship (World Series, playoffs, Super Bowl, Olympics, All-Star games, etc.)
 *
 * Exclude rules:
 * - Desk is Metropolitan, Metro, or section is "New York"
 * - Tagged with NYC-area location (New York City, Manhattan, Brooklyn, Queens, Bronx, Staten Island, Long Island, Westchester)
 *   UNLESS it meets a keep condition above because it ran on the front page or the National or Foreign desk.
 * - Sports stories focused on a single NYC team (Yankees, Mets, Giants, Jets, Knicks, Rangers, Islanders, Nets, Devils)
 *   unless they are about a championship, playoff, or national event.
 */
export function evaluateNYTNationalFocus(doc: any): NationalFocusEvaluation {
  const printSec = (doc.print_section || '').trim().toUpperCase();
  const printPage = String(doc.print_page || '').trim();
  const isFrontPage = printSec === 'A' && (printPage === '1' || printPage === '01');

  const rawDesk = (doc.news_desk || '').trim();
  const desk = rawDesk.toLowerCase();
  const rawSection = (doc.section_name || '').trim();
  const section = rawSection.toLowerCase();

  const isNationalOrForeignDesk =
    desk.includes('national') ||
    desk.includes('foreign') ||
    desk.includes('washington');

  // Keep desk criteria: National, Foreign, Washington, Business, Financial, Science, Arts, Culture, Style, Weekend
  const keepDeskRegex = /\b(national|foreign|washington|business|financial|science|arts|cultural|culture|style|weekend)\b/i;
  const hasKeepDesk = keepDeskRegex.test(desk);

  // Sports detection & national sports events
  const combinedText = `${doc.headline?.main || ''} ${doc.headline?.print_headline || ''} ${doc.abstract || ''} ${doc.snippet || ''} ${doc.lead_paragraph || ''}`.toLowerCase();
  const isSports = desk.includes('sport') || section.includes('sport');
  const nationalSportsRegex = /\b(world series|playoff|playoffs|super bowl|olympic|olympics|all-star|all star|championship|stanley cup|wimbledon|us open|pga|masters|world cup|indy 500|kentucky derby|nba finals|final four|pennant)\b/i;
  const isNationalSports = isSports && nationalSportsRegex.test(combinedText);

  // NYC sports teams
  const nycTeams = [
    'yankees',
    'mets',
    'giants',
    'jets',
    'knicks',
    'rangers',
    'islanders',
    'nets',
    'devils',
  ];

  let isNycTeamSports = false;
  let matchedNycTeam = '';
  if (isSports) {
    if (Array.isArray(doc.keywords)) {
      for (const k of doc.keywords) {
        if ((k.name === 'organizations' || k.name === 'subject') && k.value) {
          const val = k.value.toLowerCase();
          for (const team of nycTeams) {
            if (val.includes(team)) {
              isNycTeamSports = true;
              matchedNycTeam = k.value;
              break;
            }
          }
        }
        if (isNycTeamSports) break;
      }
    }

    if (!isNycTeamSports) {
      for (const team of nycTeams) {
        const teamRegex = new RegExp(`\\b${team}\\b`, 'i');
        if (teamRegex.test(combinedText)) {
          isNycTeamSports = true;
          matchedNycTeam = team;
          break;
        }
      }
    }
  }

  // Metro desk or New York section
  const isMetroDeskOrSection =
    desk.includes('metropolitan') ||
    desk.includes('metro') ||
    section === 'new york' ||
    section.includes('metro');

  // NYC-area location tags in keywords
  const nycLocations = [
    'new york city',
    'manhattan',
    'brooklyn',
    'queens',
    'bronx',
    'staten island',
    'long island',
    'westchester',
  ];

  let hasNycLocation = false;
  let matchedNycLocation = '';
  if (Array.isArray(doc.keywords)) {
    for (const k of doc.keywords) {
      if (k.name === 'glocations' && k.value) {
        const val = k.value.toLowerCase();
        for (const loc of nycLocations) {
          if (val.includes(loc)) {
            hasNycLocation = true;
            matchedNycLocation = k.value;
            break;
          }
        }
      }
      if (hasNycLocation) break;
    }
  }

  // --- Rule Evaluation Hierarchy ---

  // 1. NYC Sports team check:
  // "exclude sports stories focused on a single NYC team unless they are about a championship, playoff, or national event"
  if (isNycTeamSports && !isNationalSports) {
    return {
      keep: false,
      reason: `NYC local team sports coverage (${matchedNycTeam || 'NYC Team'}) without national championship/playoff event`,
      isFrontPage,
      desk: rawDesk,
      section: rawSection,
      matchedNycTeam,
    };
  }

  // 2. Metro desk / section or NYC location tag check:
  // "unless it also meets a 'keep' condition above because it ran on the front page or the National or Foreign desk"
  if (isMetroDeskOrSection || hasNycLocation) {
    if (isFrontPage) {
      return {
        keep: true,
        reason: 'Front page coverage (Section A, Page 1) overrides NYC local tag/desk',
        isFrontPage: true,
        desk: rawDesk,
        section: rawSection,
        matchedNycLocation,
      };
    }

    if (isNationalOrForeignDesk) {
      return {
        keep: true,
        reason: `National/Foreign desk (${rawDesk}) overrides local NYC tag`,
        isFrontPage: false,
        desk: rawDesk,
        section: rawSection,
        matchedNycLocation,
      };
    }

    const locReason = isMetroDeskOrSection
      ? `NYC Metro desk/section (${rawDesk || rawSection})`
      : `Tagged with NYC-area location (${matchedNycLocation})`;

    return {
      keep: false,
      reason: locReason,
      isFrontPage: false,
      desk: rawDesk,
      section: rawSection,
      matchedNycLocation,
    };
  }

  // 3. Keep criteria:
  if (isFrontPage) {
    return {
      keep: true,
      reason: 'Front page (Section A, Page 1)',
      isFrontPage: true,
      desk: rawDesk,
      section: rawSection,
    };
  }

  if (hasKeepDesk) {
    return {
      keep: true,
      reason: `National-interest desk (${rawDesk})`,
      isFrontPage: false,
      desk: rawDesk,
      section: rawSection,
    };
  }

  if (isNationalSports) {
    return {
      keep: true,
      reason: 'National sports league, championship, or national sporting event',
      isFrontPage: false,
      desk: rawDesk,
      section: rawSection,
    };
  }

  // 4. Default non-national items (society desks, local classifieds, regional obituaries, etc.)
  return {
    keep: false,
    reason: `Non-national desk (${rawDesk || 'Unspecified'}) without front page or national focus criteria`,
    isFrontPage: false,
    desk: rawDesk,
    section: rawSection,
  };
}
