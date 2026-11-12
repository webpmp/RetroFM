import fs from 'fs';
import path from 'path';

// Stopwords
const STOPWORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by','from','as','is','was','were','be','been','are',
  'this','that','it','its','he','she','they','we','you','has','had','have','will','would','can','could','not','no','up','out',
  'about','into','over','after','before','under','between','more','one','two','three','four','five','six','seven','eight','nine','ten',
  'new','york','times','said','says','report','reports','reported','today','yesterday','week','day','first','last','may','april',
  'march','june','july','city','here','there','years','year','set','sets','back','take','takes','put','puts','get','gets','make',
  'makes','called','held','part','show','shows','see','sees','seen','told','tells','made','line','case','plan','plans','meet',
  'urges','unit','man','men','people','group','state','states','united','official','officials','aide','aides','action','bid','bids',
  'move','moves','lead','leads','led','end','ends','open','opens','head','heads','view','views','news','article','section','page',
  'repts','reptdly','photo','advt','no title','article 1','article 2','article 3','front page 1','front page 2',
  'saturday','sunday','monday','tuesday','wednesday','thursday','friday',
  'says','told','asked','asks','told','take','takes','gave','gives','given','come','comes','came'
]);

function tokenize(text: string): string[] {
  return (text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}

function isFrontPage(a: any): boolean {
  const p = String(a.printPage || '').trim();
  const sec = String(a.printSection || '').trim().toUpperCase();
  if (p !== '1' && p !== '01' && p !== 'A1') return false;
  return sec === 'A' || sec === '1' || sec === '';
}

function extractKeyPhrases(a: any) {
  const h = a.headline || '';
  const kws = a.keywords || [];
  const phrases = new Set<string>();

  kws.forEach((kw: string) => {
    const norm = kw.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    if (norm.length > 3 && norm !== 'united states' && norm !== 'new york' && norm !== 'new york city') {
      phrases.add(norm);
    }
  });

  const text = `${h} ${a.abstract || ''}`.toLowerCase();
  const TOPIC_PATTERNS = [
    /\bcivil rights\b/g,
    /\blive aid\b/g,
    /\bstar wars\b/g,
    /\bair quality\b/g,
    /\bvietnam\b/g,
    /\bantiwar\b/g,
    /\bamtrak\b/g,
    /\bsoyuz\b/g,
    /\bberrigan\b/g,
    /\bcyprus\b/g,
    /\bgoldwater\b/g,
    /\bsouth africa\b/g,
    /\bbeirut\b/g,
    /\bacheson\b/g,
    /\bcongo\b/g,
    /\btshombe\b/g,
    /\bpolyp\b/g,
    /\bcolon\b/g,
    /\boperation today\b/g,
    /\bsurgery\b/g,
    /\bforeign aid\b/g
  ];
  for (const pat of TOPIC_PATTERNS) {
    if (pat.test(text)) {
      phrases.add(pat.source.replace(/\\b/g, ''));
    }
  }

  const tokens = tokenize(h);
  return {
    phrases,
    tokens: new Set(tokens),
    headline: h,
    article: a
  };
}

function shouldClusterTogether(item1: any, item2: any): boolean {
  for (const p of item1.phrases) {
    if (item2.phrases.has(p)) {
      return true;
    }
  }

  let overlap = 0;
  let hasRare = false;
  for (const t of item1.tokens) {
    if (item2.tokens.has(t)) {
      overlap++;
      if (t.length >= 7) hasRare = true;
    }
  }

  if (overlap >= 2 || (overlap >= 1 && hasRare)) {
    return true;
  }

  return false;
}

function clusterArticles(articles: any[]): any[][] {
  const items = articles.map(extractKeyPhrases);
  const clusters: any[] = [];

  for (const item of items) {
    let bestCluster: any = null;
    for (const cl of clusters) {
      let matchCount = 0;
      for (const rep of cl.items.slice(0, 5)) {
        if (shouldClusterTogether(item, rep)) {
          matchCount++;
          break;
        }
      }
      if (matchCount > 0) {
        bestCluster = cl;
        break;
      }
    }

    if (bestCluster) {
      bestCluster.items.push(item);
    } else {
      clusters.push({ items: [item] });
    }
  }

  return clusters.map(c => c.items.map((i: any) => i.article));
}

function isEligible(a: any, targetDate: string): boolean {
  if (!a.pubDate || a.pubDate > targetDate) return false;
  const h = (a.headline || '').trim();
  const t = (a.typeOfMaterial || '').trim().toLowerCase();
  const d = (a.desk || '').trim().toLowerCase();
  const s = (a.section || '').trim().toLowerCase();
  const k = (a.keywords || []).map((x: string) => x.toLowerCase());
  const isFP = isFrontPage(a);

  if (/no title/i.test(h) || /summer sessions/i.test(h)) return false;
  if (t === 'letter' || t === 'correction' || t === 'obituary' || t === 'schedule' || t === 'statistics' || t === 'classified') return false;
  if (/^letter|^letters to the editor|^in memoriam|^obituary|^deaths elsewhere/i.test(h)) return false;
  if (/crossword|bridge|chess|weather|sports results|box score|quotation of the day|advertising:/i.test(h)) return false;
  if (d.includes('sports') || s.includes('sports')) return false;
  if (k.some((x: string) => ['baseball', 'basketball', 'football', 'hockey', 'golf', 'horse racing', 'tennis', 'boxing'].includes(x))) return false;
  if ((d.includes('metropolitan') || s.includes('metropolitan') || s.includes('society') || d.includes('society') || s.includes('style') || d.includes('style')) && !isFP) return false;
  if (/\b(?:dining out|restaurants?|cafe|shopping spree|summer home|fire island|merchandise|bridal|wedding|wed to|engaged to)\b/i.test(h)) return false;
  if (/\b(?:earnings soar|dividend|quarterly profit|shares traded|stock prices|real estate|zoning|tonsorial|market values?)\b/i.test(h)) return false;
  return true;
}

const BROAD_IMPACT_REGEX = /\b(?:war|peace|protest\w*|antiwar|anti-war|demonstrat\w*|veteran|vietnam|cambodia|laos|soviet|russia\w*|moscow|china|peking|treaty|summit|disarm\w*|president\w*|congress|senat\w*|white house|pentagon|supreme court|court|indict\w*|trial|verdict|crime|fbi|conspiracy|bomb\w*|hijack\w*|disaster|earthquake|flood|hurricane|space|apollo|soyuz|orbit|astronaut|cosmonaut|amtrak|railroad|railpax|strike|civil rights|desegregat\w*|integration|busing|marijuana|pollution|clean air|national|historic|live aid|surgery|cancer|polyp)\b/i;

function scoreStory(articles: any[], broadcastDate: string) {
  const days = new Set(articles.map((a: any) => a.pubDate));
  const frontPages = articles.filter(isFrontPage);
  const count = articles.length;
  const dayCount = days.size;
  const fpCount = frontPages.length;

  let score = 0;

  if (fpCount > 0) {
    score += 40 + Math.min(30, (fpCount - 1) * 10);
  }

  if (dayCount >= 3) {
    score += 30 + (dayCount - 3) * 5;
  } else if (dayCount === 2) {
    score += 15;
  }

  if (count >= 4) {
    score += 25;
  } else if (count >= 2) {
    score += count * 6;
  }

  const totalWords = articles.reduce((sum: number, a: any) => sum + (a.wordCount || 350), 0);
  if (totalWords >= 3000) score += 15;
  else if (totalWords >= 1500) score += 10;

  const combinedText = articles.map((a: any) => `${a.headline} ${a.abstract || ''} ${(a.keywords || []).join(' ')}`).join(' ');
  if (BROAD_IMPACT_REGEX.test(combinedText)) {
    score += 30;
  }

  if (count === 1) score -= 25;
  if (fpCount === 0) score -= 30;

  if (/\b(?:local|borough|suburb|zoning|bridge toll|clocks set ahead|daylight time|hearing on)\b/i.test(combinedText) && !/\b(?:vietnam|war|nixon|amtrak|space|soviet|antiwar|berrigan|civil rights|live aid|reagan)\b/i.test(combinedText)) {
    score -= 25;
  }

  const sortedArticles = [...articles].sort((a: any, b: any) => {
    const fpA = isFrontPage(a) ? 1 : 0;
    const fpB = isFrontPage(b) ? 1 : 0;
    if (fpB !== fpA) return fpB - fpA;
    if (b.pubDate !== a.pubDate) return b.pubDate.localeCompare(a.pubDate);
    return (b.wordCount || 0) - (a.wordCount || 0);
  });

  return {
    score,
    leadArticle: sortedArticles[0],
    articles,
    dayCount,
    fpCount,
    dates: Array.from(days).sort()
  };
}

function testDate(dateStr: string) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const primaryFile = path.resolve(process.cwd(), `cache/nyt/${dateStr.slice(0, 7)}.json`);
  let raw = JSON.parse(fs.readFileSync(primaryFile, 'utf8')).articles || [];
  if (d <= 7) {
    const prevYear = m === 1 ? y - 1 : y;
    const prevMonth = m === 1 ? 12 : m - 1;
    const prevStr = `${prevYear}-${prevMonth < 10 ? '0' + prevMonth : prevMonth}`;
    const prevFile = path.resolve(process.cwd(), `cache/nyt/${prevStr}.json`);
    if (fs.existsSync(prevFile)) {
      raw = [...JSON.parse(fs.readFileSync(prevFile, 'utf8')).articles, ...raw];
    }
  }

  const dObj = new Date(Date.UTC(y, m - 1, d));
  dObj.setUTCDate(dObj.getUTCDate() - 7);
  const startStr = dObj.toISOString().split('T')[0];

  const windowArts = raw.filter((a: any) => a.pubDate >= startStr && a.pubDate <= dateStr);
  const eligible = windowArts.filter((a: any) => isEligible(a, dateStr));
  const clusters = clusterArticles(eligible);
  const scored = clusters.map(c => scoreStory(c, dateStr));
  scored.sort((a, b) => b.score - a.score);

  console.log('================================================================');
  console.log(`TOP 10 STORIES FOR: ${dateStr} (Window: ${startStr} to ${dateStr})`);
  console.log(`Total Window Articles: ${windowArts.length} | Eligible: ${eligible.length} | Clusters: ${clusters.length}`);
  console.log('================================================================');
  scored.slice(0, 10).forEach((s, idx) => {
    console.log(`${idx + 1}. [Score ${s.score}] ${s.leadArticle.headline}`);
    console.log(`   Articles: ${s.articles.length} across ${s.dayCount} days (${s.dates.join(', ')}), Front Page: ${s.fpCount}`);
    console.log(`   Lead: ${s.leadArticle.pubDate} [P.${s.leadArticle.printPage}]`);
    console.log(`   Snippet: ${(s.leadArticle.abstract || s.leadArticle.snippet || '').slice(0, 120)}...`);
  });
  console.log('\n');
}

testDate('1971-05-01');
testDate('1985-07-13');
testDate('1964-07-04');
