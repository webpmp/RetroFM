import { getOrBuildAlmanac } from '../src/services/news/almanacService.js';
import { computeNewsDateTier } from '../src/services/news/relativeTime.js';

const testDates = ['1964-05-01', '1977-05-11', '1985-07-13', '1995-05-15', '2008-10-15', '2009-05-12'];

async function run() {
  for (const date of testDates) {
    console.log(`\n=======================================================`);
    console.log(`POOLS AND TOP HEADLINES FOR ${date}`);
    console.log(`=======================================================`);
    const almanac = await getOrBuildAlmanac(date);
    
    const tieredMajor: any[] = [];
    const tieredMusic: any[] = [];
    
    for (const e of almanac.entries) {
      const artDate = e.printDate || e.eventDate;
      const tierMajor = computeNewsDateTier(artDate, date, 'major_news');
      const tierMusic = computeNewsDateTier(artDate, date, 'music_news');
      if (tierMajor && e.category === 'major_news') tieredMajor.push({ ...e, tierInfo: tierMajor });
      if (tierMusic && e.category === 'music') tieredMusic.push({ ...e, tierInfo: tierMusic });
    }
    
    tieredMajor.sort((a, b) => {
      const sA = a.interestScore || 50;
      const sB = b.interestScore || 50;
      if (sB !== sA) return sB - sA;
      const fpA = (a.printSection === '1' || a.printSection === 'A' || a.section === 'Front Page') ? 1 : 0;
      const fpB = (b.printSection === '1' || b.printSection === 'A' || b.section === 'Front Page') ? 1 : 0;
      if (fpB !== fpA) return fpB - fpA;
      return (b.printDate || '').localeCompare(a.printDate || '');
    });

    tieredMusic.sort((a, b) => {
      const sA = a.interestScore || 50;
      const sB = b.interestScore || 50;
      if (sB !== sA) return sB - sA;
      const fpA = (a.printSection === '1' || a.printSection === 'A' || a.section === 'Front Page') ? 1 : 0;
      const fpB = (b.printSection === '1' || b.printSection === 'A' || b.section === 'Front Page') ? 1 : 0;
      if (fpB !== fpA) return fpB - fpA;
      return (b.printDate || '').localeCompare(a.printDate || '');
    });
    
    console.log(`Total Almanac Entries: ${almanac.entries.length}`);
    console.log(`major_news eligible (0..3d): ${tieredMajor.length} (capped at ${Math.min(40, tieredMajor.length)})`);
    console.log(`music_news eligible (0..7d): ${tieredMusic.length} (capped at ${Math.min(40, tieredMusic.length)})`);
    
    // Check if Blandy is in any pool
    const blandyEntries = almanac.entries.filter((e: any) => /blandy/i.test(e.headline || '') || /blandy/i.test(e.summary || ''));
    if (blandyEntries.length > 0) {
      console.log(`WARNING: Blandy article found in almanac for ${date}! Headline: ${blandyEntries[0].headline}`);
    } else if (date === '2009-05-12' || date === '2008-10-15') {
      console.log(`CONFIRMED: Blandy article is completely absent from almanac entries for ${date}.`);
    }

    console.log(`\n--- TOP 15 MAJOR NEWS HEADLINES (${date}) ---`);
    tieredMajor.slice(0, 15).forEach((e, idx) => {
      console.log(`${idx + 1}. [score=${e.interestScore}] (${e.printDate}) "${e.headline}" (section: ${e.section}) [${e.tierInfo.timePhrase}]`);
    });
    
    console.log(`\n--- TOP 15 MUSIC NEWS HEADLINES (${date}) ---`);
    tieredMusic.slice(0, 15).forEach((e, idx) => {
      console.log(`${idx + 1}. [score=${e.interestScore}] (${e.printDate}) "${e.headline}" (section: ${e.section}) [${e.tierInfo.timePhrase}]`);
    });
  }
}

run().catch(console.error);
