import fs from 'fs';
import path from 'path';
import { getProminentStoryPackets, isEligibleCandidateArticle } from '../src/services/news/prominenceStoryService';

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), 'results');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `round6-diagnostics-${timestamp}.txt`);

const lines: string[] = [];
function log(msg = '') {
  console.log(msg);
  lines.push(msg);
}

function readMonthCache(ym: string): any[] {
  const filePath = path.join(process.cwd(), 'cache', 'nyt', `${ym}.json`);
  if (!fs.existsSync(filePath)) return [];
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  if (Array.isArray(raw)) return raw;
  if (raw && Array.isArray(raw.articles)) return raw.articles;
  if (raw && raw.response && Array.isArray(raw.response.docs)) return raw.response.docs;
  return [];
}

function normalizeCacheDoc(doc: any) {
  const pubDateRaw = doc.pub_date || doc.pubDate || '';
  const pubDate = pubDateRaw.slice(0, 10);
  const headline = typeof doc.headline === 'string' ? doc.headline : (doc.headline?.main || doc.headline?.print_headline || '');
  const abstract = doc.abstract || '';
  const leadParagraph = doc.lead_paragraph || doc.leadParagraph || '';
  const snippet = doc.snippet || '';
  const section = doc.section_name || doc.section || '';
  const desk = doc.news_desk || doc.desk || '';
  const printPage = String(doc.print_page || doc.printPage || '');
  const typeOfMaterial = doc.type_of_material || doc.typeOfMaterial || '';
  const wordCount = Number(doc.word_count || doc.wordCount || 0);
  const url = doc.web_url || doc.url || '';
  const id = doc._id || doc.id || url;
  return {
    id,
    headline,
    abstract,
    leadParagraph,
    snippet,
    pubDate,
    section,
    desk,
    printPage,
    typeOfMaterial,
    wordCount,
    url,
    keywords: Array.isArray(doc.keywords) ? doc.keywords.map((k: any) => typeof k === 'string' ? k : (k.value || '')) : [],
  };
}

async function run() {
  log(`================================================================================`);
  log(`ROUND 6 DIAGNOSTICS (Generated ${new Date().toISOString()})`);
  log(`================================================================================`);

  // 1. Check 1965-02-22 (Malcolm X)
  log(`\n--- ITEM 2A: 1965-02-22 (Why Malcolm X was skipped / filtered) ---`);
  const docs1965 = readMonthCache('1965-02').map(normalizeCacheDoc).filter(d => d.pubDate >= '1965-02-15' && d.pubDate <= '1965-02-22');
  const malcolmDocs = docs1965.filter(d => /malcolm/i.test(`${d.headline} ${d.abstract}`));
  log(`Found ${malcolmDocs.length} articles matching "Malcolm" in 1965-02-15..1965-02-22:`);
  for (const d of malcolmDocs) {
    const elig = isEligibleCandidateArticle(d as any, '1965-02-22');
    log(`  [${d.pubDate}] Page="${d.printPage}" Desk="${d.desk}" Type="${d.typeOfMaterial}" Eligible=${elig} Headline="${d.headline}"`);
    log(`    Abstract: ${d.abstract.slice(0, 200)}`);
  }
  const ranked1965 = await getProminentStoryPackets('1965-02-22');
  log(`Top 5 ranked clusters on 1965-02-22:`);
  ranked1965.allRankedStories.slice(0, 5).forEach((s, i) => {
    log(`  #${i + 1} [Score ${s.prominenceScore}] "${s.topicTitle}" (articles: ${s.articles.length}, fp: ${s.frontPageCount})`);
  });
  log(`Packets for #1..#3 on 1965-02-22:`);
  ranked1965.selectedPackets.slice(0, 3).forEach((p, i) => {
    log(`  Packet #${i + 1}: "${p.headline}" (facts: ${p.facts.length}, leadParagraph: "${(p.leadArticle?.leadParagraph || '').slice(0, 120)}")`);
    p.facts.forEach((f, fi) => log(`    Fact ${fi + 1}: ${f.text}`));
  });

  // 2. Check 1980-11-05 (Reagan landslide)
  log(`\n--- ITEM 2B: 1980-11-05 (Why Reagan landslide was skipped) ---`);
  const ranked1980 = await getProminentStoryPackets('1980-11-05');
  log(`Top 5 ranked clusters on 1980-11-05:`);
  ranked1980.allRankedStories.slice(0, 5).forEach((s, i) => {
    log(`  #${i + 1} [Score ${s.prominenceScore}] "${s.topicTitle}" (articles: ${s.articles.length}, fp: ${s.frontPageCount}, dates: [${s.dates.join(', ')}])`);
  });
  log(`Top 3 packets on 1980-11-05:`);
  ranked1980.selectedPackets.forEach((p, i) => {
    log(`  Packet #${i + 1}: "${p.headline}" (facts: ${p.facts.length}, leadDate: ${p.leadArticle?.pubDate || ''})`);
    p.facts.forEach((f, fi) => log(`    Fact ${fi + 1}: ${f.text}`));
  });

  // 3. Check 1968-06-06 (RFK: "KENNEDY IS DEAD, VICTIM OF ASSASSIN")
  log(`\n--- ITEM 3: 1968-06-06 (RFK "KENNEDY IS DEAD, VICTIM OF ASSASSIN") ---`);
  const docs1968 = readMonthCache('1968-06').map(normalizeCacheDoc).filter(d => d.pubDate >= '1968-05-30' && d.pubDate <= '1968-06-06');
  const rfkDocs = docs1968.filter(d => /kennedy/i.test(`${d.headline} ${d.abstract}`) && d.printPage === '1');
  log(`Found ${rfkDocs.length} Page-1 articles matching "Kennedy" in 1968-05-30..1968-06-06:`);
  for (const d of rfkDocs) {
    const elig = isEligibleCandidateArticle(d as any, '1968-06-06');
    log(`  [${d.pubDate}] Page="${d.printPage}" Desk="${d.desk}" Type="${d.typeOfMaterial}" Eligible=${elig} Headline="${d.headline}"`);
    log(`    Abstract: ${d.abstract.slice(0, 250)}`);
  }
  const ranked1968 = await getProminentStoryPackets('1968-06-06');
  log(`All ranked clusters matching "Kennedy" on 1968-06-06:`);
  ranked1968.allRankedStories.forEach((s, i) => {
    if (/kennedy|assassin|sirhan/i.test(s.topicTitle)) {
      log(`  Rank #${i + 1} [Score ${s.prominenceScore}] "${s.topicTitle}"`);
      log(`    Score Breakdown: ${JSON.stringify(s.scoreBreakdown)}`);
    }
  });

  // 4. Check 1971-06-13 and 1971-06-14 Page-1 articles (Pentagon Papers)
  log(`\n--- ITEM 4A: 1971-06-13 and 1971-06-14 Page-1 Articles ---`);
  const docs1971 = readMonthCache('1971-06').map(normalizeCacheDoc);
  for (const targetDate of ['1971-06-13', '1971-06-14']) {
    const fpDocs = docs1971.filter(d => d.pubDate === targetDate && (d.printPage === '1' || d.printPage === 'A1'));
    const ranked = await getProminentStoryPackets(targetDate);
    log(`\nDate ${targetDate} — Total Page-1 articles in cache: ${fpDocs.length}`);
    for (const d of fpDocs) {
      const elig = isEligibleCandidateArticle(d as any, targetDate);
      const matchingClusterIdx = ranked.allRankedStories.findIndex(c => c.articles.some(a => (a as any).id === d.id || a.headline === d.headline));
      const cluster = matchingClusterIdx >= 0 ? ranked.allRankedStories[matchingClusterIdx] : null;
      log(`  [${d.pubDate}] Page=${d.printPage} Desk="${d.desk}" Type="${d.typeOfMaterial}" Eligible=${elig}`);
      log(`    Headline: "${d.headline}"`);
      if (cluster) {
        log(`    Cluster Rank: #${matchingClusterIdx + 1}, Score=${cluster.prominenceScore}, Lead="${cluster.topicTitle}", Breakdown=${JSON.stringify(cluster.scoreBreakdown)}`);
      } else {
        log(`    Cluster: NOT IN ANY CLUSTER (Filtered out or no title)`);
      }
    }
  }

  // 5. Check 1993-02-27 articles matching "Trade Center", "explosion", "blast", or "bomb"
  log(`\n--- ITEM 4B: 1993-02-27 Articles matching Trade Center / explosion / blast / bomb ---`);
  const docs1993 = readMonthCache('1993-02').map(normalizeCacheDoc).filter(d => d.pubDate === '1993-02-27');
  const ranked1993 = await getProminentStoryPackets('1993-02-27');
  const wtcDocs = docs1993.filter(d => /\b(?:trade center|explosion|blast|bomb|bombing)\b/i.test(`${d.headline} ${d.abstract}`));
  log(`Date 1993-02-27 — Matching articles in cache: ${wtcDocs.length}`);
  for (const d of wtcDocs) {
    const elig = isEligibleCandidateArticle(d as any, '1993-02-27');
    const matchingClusterIdx = ranked1993.allRankedStories.findIndex(c => c.articles.some(a => (a as any).id === d.id || a.headline === d.headline));
    const cluster = matchingClusterIdx >= 0 ? ranked1993.allRankedStories[matchingClusterIdx] : null;
    log(`  [${d.pubDate}] Page="${d.printPage}" Section="${d.section}" Desk="${d.desk}" Eligible=${elig}`);
    log(`    Headline: "${d.headline}"`);
    if (cluster) {
      log(`    Cluster Rank: #${matchingClusterIdx + 1}, Score=${cluster.prominenceScore}, Lead="${cluster.topicTitle}", Breakdown=${JSON.stringify(cluster.scoreBreakdown)}`);
    } else {
      log(`    Cluster: EXCLUDED BY FILTER`);
    }
  }

  // 6. Check 1976-07-05 Entebbe cluster facts & source articles
  log(`\n--- ITEM 6: 1976-07-05 Entebbe #1 Cluster Facts and Source Articles ---`);
  const ranked1976 = await getProminentStoryPackets('1976-07-05');
  const topCluster1976 = ranked1976.allRankedStories[0];
  const topPacket1976 = ranked1976.selectedPackets[0];
  if (topCluster1976 && topPacket1976) {
    log(`#1 Cluster Lead: "${topCluster1976.topicTitle}" (Score: ${topCluster1976.prominenceScore}, Articles: ${topCluster1976.articles.length})`);
    log(`Cluster Articles:`);
    for (const a of topCluster1976.articles) {
      log(`  - [${a.pubDate}] Page="${a.printPage}" Words=${a.wordCount} Headline="${a.headline}"`);
      log(`    Abstract: ${(a.abstract || '').slice(0, 180)}`);
      log(`    LeadParagraph: ${(a.leadParagraph || '').slice(0, 180)}`);
    }
    log(`\nCurrent Packet Facts for #1 Cluster:`);
    topPacket1976.facts.forEach((f, idx) => {
      // Find which article in cluster produced this fact
      const srcArt = topCluster1976.articles.find(a =>
        (f.sourceHeadline && a.headline === f.sourceHeadline) ||
        (a.headline && a.headline.includes(f.text.slice(0, 25))) ||
        (a.abstract && a.abstract.includes(f.text.slice(0, 25))) ||
        (a.leadParagraph && a.leadParagraph.includes(f.text.slice(0, 25)))
      );
      log(`  Fact [${idx + 1}]: "${f.text}"`);
      log(`    Source Article: ${srcArt ? `[${srcArt.pubDate}] "${srcArt.headline}" (page=${srcArt.printPage})` : (f.sourceHeadline ? `[${f.date}] "${f.sourceHeadline}"` : 'Resolved/Transformed from cluster article')}`);
    });
  }

  fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
  console.log(`\nWrote diagnostics to ${outFile}`);
}

run().catch(console.error);
