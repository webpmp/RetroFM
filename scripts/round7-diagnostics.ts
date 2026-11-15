import * as fs from 'fs';
import * as path from 'path';
import { getProminentStoryPackets } from '../src/services/news/prominenceStoryService';

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(process.cwd(), 'results', `round7-diagnostics-${ts}.txt`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const lines: string[] = [];
  const log = (msg = '') => {
    console.log(msg);
    lines.push(msg);
    fs.appendFileSync(outPath, msg + '\n', 'utf-8');
  };
  fs.writeFileSync(outPath, '', 'utf-8');

  log(`================================================================================`);
  log(`ROUND 7 RANKING & PRE-1970 CACHE DIAGNOSTICS`);
  log(`Generated: ${ts}`);
  log(`Output File: results/round7-diagnostics-${ts}.txt`);
  log(`================================================================================`);

  // Part A: Pre-1970 cached records for 1969-07-21, 1963-11-22, 1969-08-15
  const pre1970Dates = ['1969-07-21', '1963-11-22', '1969-08-15'];
  log(`\n--- PART A: PRE-1970 TOP CLUSTERS (BEFORE ROUND 7 FIXES) ---`);
  for (const date of pre1970Dates) {
    log(`\n>>> Broadcast Date: ${date}`);
    const { allRankedStories } = await getProminentStoryPackets(date);
    for (let idx = 0; idx < Math.min(5, allRankedStories.length); idx++) {
      const s = allRankedStories[idx];
      const bd = s.scoreBreakdown!;
      log(
        `  Rank #${idx + 1} | Score=${s.prominenceScore.toFixed(1)} [fp=${bd.fpScore.toFixed(1)}, fresh=${bd.freshnessScore.toFixed(1)}, pers=${bd.persistenceScore.toFixed(1)}, vol=${bd.volumeScore.toFixed(1)}, impact=${bd.broadImpactScore.toFixed(1)}, mag=${bd.magnitudeScore.toFixed(1)}, banner=${bd.bannerScore.toFixed(1)}, sameDayFp=${bd.sameDayFpScore.toFixed(1)}, pen=${bd.penalties.toFixed(1)}] | FP=${s.frontPageCount} | Days=${s.dayCount} | Arts=${s.articles.length} | Facts=${s.facts.length} | Title="${s.topicTitle}"`
      );
      log(
        `    Lead Date=${s.leadArticle.pubDate} | Page=${s.leadArticle.printPage} | Headline="${s.leadArticle.headline}"`
      );
      log(`    Lead Abstract: ${JSON.stringify(s.leadArticle.abstract || '')}`);
      log(`    Lead Paragraph: ${JSON.stringify(s.leadArticle.leadParagraph || '')}`);
      for (let i = 0; i < s.facts.length; i++) {
        log(`    Fact[${i + 1}]: ${s.facts[i]}`);
      }
    }
  }

  // Part B: Priority 4 Ranking Issues (7 Round 6 blind dates + 1970-05-05)
  const diagDates: Array<{ date: string; expectedQuery: RegExp; label: string }> = [
    { date: '1964-08-05', expectedQuery: /tonkin|vietnam|torpedo|north vietnam|pt boat/i, label: 'Gulf of Tonkin air strikes' },
    { date: '1972-02-22', expectedQuery: /nixon|mao|peking|chou/i, label: 'Nixon meets Mao in Peking (check lead headline vs SHIFT IN SCHEDULE)' },
    { date: '1978-11-20', expectedQuery: /ryan|guyana|peoples temple|jonestown/i, label: 'Rep. Ryan feared slain in Guyana' },
    { date: '1982-06-07', expectedQuery: /israel|lebanon|PLO|beirut|versailles/i, label: 'Israeli invasion of Lebanon / Versailles summit' },
    { date: '1984-11-07', expectedQuery: /reagan|mondale|landslide|49 states|electoral|re-elected|reelected|second term/i, label: 'National Reagan landslide vs Tristate sweep' },
    { date: '1990-02-12', expectedQuery: /mandela|south africa|freed|prison/i, label: 'Nelson Mandela freed' },
    { date: '1994-06-18', expectedQuery: /simpson|charged|chased|arrested|bronco/i, label: 'O.J. Simpson charged, chased, arrested' },
    { date: '1970-05-05', expectedQuery: /kent state|ohio|guardsmen|4 dead|four dead|campus/i, label: 'Kent State shootings' },
  ];

  log(`\n--- PART B: PRIORITY 4 RANKING DIAGNOSTICS (7 ROUND 6 BLIND DATES + 1970-05-05) ---`);
  for (const item of diagDates) {
    log(`\n================================================================================`);
    log(`Broadcast Date: ${item.date} | Expected: ${item.label}`);
    const { allRankedStories } = await getProminentStoryPackets(item.date);
    for (let idx = 0; idx < Math.min(5, allRankedStories.length); idx++) {
      const s = allRankedStories[idx];
      const bd = s.scoreBreakdown!;
      log(
        `  Rank #${idx + 1} | Total=${s.prominenceScore.toFixed(1)} [fp=${bd.fpScore.toFixed(1)}, fresh=${bd.freshnessScore.toFixed(1)}, pers=${bd.persistenceScore.toFixed(1)}, vol=${bd.volumeScore.toFixed(1)}, impact=${bd.broadImpactScore.toFixed(1)}, mag=${bd.magnitudeScore.toFixed(1)}, banner=${bd.bannerScore.toFixed(1)}, sameDayFp=${bd.sameDayFpScore.toFixed(1)}, pen=${bd.penalties.toFixed(1)}]`
      );
      log(
        `    FP=${s.frontPageCount} | Days=${s.dayCount} | Arts=${s.articles.length} | LeadDate=${s.leadArticle.pubDate} | Title="${s.topicTitle}"`
      );
      for (const a of s.articles.slice(0, 6)) {
        log(`      - [${a.pubDate} p.${a.printPage || '?'} w=${a.wordCount}] "${a.headline}"`);
      }
    }
    log(`  Expected Story Matches in Top 20:`);
    for (let idx = 0; idx < Math.min(20, allRankedStories.length); idx++) {
      const m = allRankedStories[idx];
      if (
        item.expectedQuery.test(m.topicTitle) ||
        m.articles.some(a => item.expectedQuery.test(a.headline))
      ) {
        const bd = m.scoreBreakdown!;
        log(
          `    -> Rank #${idx + 1} | Total=${m.prominenceScore.toFixed(1)} [fp=${bd.fpScore.toFixed(1)}, fresh=${bd.freshnessScore.toFixed(1)}, pers=${bd.persistenceScore.toFixed(1)}, vol=${bd.volumeScore.toFixed(1)}, impact=${bd.broadImpactScore.toFixed(1)}, mag=${bd.magnitudeScore.toFixed(1)}, banner=${bd.bannerScore.toFixed(1)}, sameDayFp=${bd.sameDayFpScore.toFixed(1)}, pen=${bd.penalties.toFixed(1)}] | FP=${m.frontPageCount} | Arts=${m.articles.length} | Title="${m.topicTitle}"`
        );
      }
    }
  }

  console.log(`\nSaved diagnostics to ${outPath}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
