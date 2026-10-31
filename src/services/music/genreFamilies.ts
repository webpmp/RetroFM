/**
 * Static Genre Specificity Rank & Deterministic Primary Genre Resolution
 *
 * Every song in RetroFM belongs to exactly one genre station.
 * Where a song carries multiple genre tags, the primary genre is chosen
 * using the most specific tag (highest specificity rank).
 * If two tags have equal specificity rank, the first one listed is used.
 *
 * This assignment is deterministic and runs once when the library loads,
 * ensuring completely disjoint genre station pools and consistent station
 * membership across sessions.
 */

export interface GenreRankInfo {
  genre: string;
  rank: number; // Higher rank = more specific (e.g. Eurodance = 3 > Dance = 1)
}

/**
  * Static genre taxonomy map with specificity rankings.
  * Easy to inspect and edit.
  */
export const GENRE_TAXONOMY: Record<string, GenreRankInfo[]> = {
  // Family: Dance / Electronic
  dance_electronic: [
    { genre: "Dance", rank: 1 },
    { genre: "Electronic", rank: 1 },
    { genre: "Disco", rank: 2 },
    { genre: "Electro", rank: 2 },
    { genre: "Freestyle", rank: 2 },
    { genre: "EDM", rank: 2 },
    { genre: "Electropop", rank: 2 },
    { genre: "Synthwave", rank: 2 },
    { genre: "Eurodance", rank: 3 }
  ],
  // Family: Hip-Hop / Rap
  hip_hop_rap: [
    { genre: "Hip-Hop", rank: 1 },
    { genre: "Rap", rank: 1 },
    { genre: "Urban Contemporary", rank: 1 },
    { genre: "Golden Age Hip-Hop", rank: 2 },
    { genre: "Boom Bap", rank: 2 },
    { genre: "Gangsta Rap", rank: 2 },
    { genre: "G-Funk", rank: 2 },
    { genre: "Crunk", rank: 2 },
    { genre: "Trap", rank: 2 },
    { genre: "Mumble Rap", rank: 2 },
    { genre: "Lofi Hip-Hop", rank: 2 },
    { genre: "Drift Phonk", rank: 2 }
  ],
  // Family: R&B / Soul
  rnb_soul: [
    { genre: "R&B", rank: 1 },
    { genre: "Soul", rank: 1 },
    { genre: "Motown", rank: 2 },
    { genre: "Funk", rank: 2 },
    { genre: "Philadelphia Soul", rank: 2 },
    { genre: "Contemporary R&B", rank: 2 }
  ],
  // Family: Rock
  rock: [
    { genre: "Rock", rank: 1 },
    { genre: "Rock and Roll", rank: 1 },
    { genre: "AOR", rank: 1 },
    { genre: "Soft Rock", rank: 2 },
    { genre: "Hard Rock", rank: 2 },
    { genre: "Arena Rock", rank: 2 },
    { genre: "Heartland Rock", rank: 2 },
    { genre: "Southern Rock", rank: 2 },
    { genre: "Blues Rock", rank: 2 },
    { genre: "Surf Rock", rank: 2 },
    { genre: "Garage Rock", rank: 2 },
    { genre: "Glam Rock", rank: 2 },
    { genre: "Glam Metal", rank: 2 },
    { genre: "Glam Metal / Hair Metal", rank: 2 },
    { genre: "Hair Metal", rank: 2 },
    { genre: "Progressive Rock", rank: 2 },
    { genre: "Psychedelic Rock", rank: 2 },
    { genre: "Punk Rock", rank: 2 },
    { genre: "New Wave", rank: 2 },
    { genre: "New Romantic", rank: 2 },
    { genre: "College Rock", rank: 2 },
    { genre: "Alternative Rock", rank: 2 },
    { genre: "Grunge", rank: 2 },
    { genre: "Britpop", rank: 2 },
    { genre: "British Invasion", rank: 2 },
    { genre: "Post-Grunge", rank: 2 },
    { genre: "Nu-Metal", rank: 2 },
    { genre: "Emo", rank: 2 },
    { genre: "Indie Rock", rank: 2 }
  ],
  // Family: Pop
  pop: [
    { genre: "Pop", rank: 1 },
    { genre: "CHR", rank: 1 },
    { genre: "Adult Contemporary", rank: 2 },
    { genre: "Easy Listening", rank: 2 },
    { genre: "Synth-Pop", rank: 2 },
    { genre: "Teen Pop", rank: 2 },
    { genre: "Baroque Pop", rank: 2 },
    { genre: "Indie Pop", rank: 2 },
    { genre: "Bedroom Pop", rank: 2 },
    { genre: "Hyperpop", rank: 2 }
  ],
  // Family: Country
  country: [
    { genre: "Country", rank: 1 },
    { genre: "Country Pop", rank: 2 },
    { genre: "Outlaw Country", rank: 2 }
  ],
  // Family: Folk
  folk: [
    { genre: "Folk", rank: 1 },
    { genre: "Folk Rock", rank: 2 },
    { genre: "Singer-Songwriter", rank: 2 }
  ],
  // Family: Reggae
  reggae: [
    { genre: "Reggae", rank: 1 },
    { genre: "Early Reggae", rank: 2 },
    { genre: "Ska", rank: 2 }
  ],
  // Family: Latin
  latin: [
    { genre: "Latin", rank: 1 },
    { genre: "Reggaeton", rank: 2 },
    { genre: "Regional Mexican", rank: 2 }
  ],
  // Family: Jazz & Blues
  jazz_blues: [
    { genre: "Jazz", rank: 1 },
    { genre: "Blues", rank: 1 },
    { genre: "Bossa Nova", rank: 2 },
    { genre: "Jazz Fusion", rank: 2 }
  ],
  // Family: African
  african: [
    { genre: "Afrobeats", rank: 1 },
    { genre: "Amapiano", rank: 2 }
  ],
  // Family: Gospel
  gospel: [
    { genre: "Gospel", rank: 1 }
  ]
};

const GENRE_RANK_MAP = new Map<string, number>();

for (const members of Object.values(GENRE_TAXONOMY)) {
  for (const m of members) {
    GENRE_RANK_MAP.set(m.genre.toLowerCase(), m.rank);
  }
}

/**
 * Gets the specificity rank of a genre name (default 1).
 */
export function getGenreSpecificityRank(genre: string): number {
  return GENRE_RANK_MAP.get(genre.trim().toLowerCase()) ?? 1;
}

/**
 * Deterministically resolves the single primary genre for a song from its genre tags.
 *
 * Rules:
 * 1. Picks the most specific tag (highest specificity rank, e.g. Eurodance > Dance, Gangsta Rap > Hip-Hop, Contemporary R&B > R&B).
 * 2. If tags are equally specific (same rank), breaks ties by preserving the first one listed.
 * 3. Fallback to "Pop" if no genre tags exist.
 *
 * @param rawGenres Comma-separated string or array of genre tags
 * @returns Canonical single primary genre
 */
export function determinePrimaryGenre(rawGenres: string | string[] | null | undefined): string {
  if (!rawGenres) return "Pop";

  const tags: string[] = Array.isArray(rawGenres)
    ? rawGenres.map((g) => g.trim()).filter(Boolean)
    : rawGenres
        .split(",")
        .map((g) => g.trim())
        .filter(Boolean);

  if (tags.length === 0) return "Pop";
  if (tags.length === 1) return tags[0];

  let best = tags[0];
  let bestRank = getGenreSpecificityRank(best);

  for (let i = 1; i < tags.length; i++) {
    const candidateRank = getGenreSpecificityRank(tags[i]);
    if (candidateRank > bestRank) {
      best = tags[i];
      bestRank = candidateRank;
    }
  }

  return best;
}
