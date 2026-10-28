import assert from 'node:assert';
import { economyLine, economyLines, PricesFile } from '../src/services/djBreak/costOfLiving.js';

console.log('================================================================================');
console.log('            RETROFM COST-OF-LIVING / ECONOMY BREAK TEST SUITE');
console.log('================================================================================\n');

// Sample PricesFile containing observations across various series:
// Some dated strictly before the selected month 1979-05 (e.g. 1978, 1979-03, 1979-04),
// and some dated on or after the selected month 1979-05 (e.g. 1979-05-01, 1979-06-01, 1980).
//
// In costOfLiving.ts:
// - Monthly prices (gasoline, eggs, milk, bread, coffee, beef, earnings) look at lastMonth (1979-04).
// - Statistics (CPI, unemployment) look at published cutoff (2 months back: 1979-03).
// - Weekly mortgage looks at addDays(date, -1) (1979-04-30).
// - Minwage looks at date.
//
// Requirement:
// "for the date 1979-05-01 with a small sample PricesFile, the returned line never uses data dated on or after the selected month."
const samplePrices: PricesFile = {
  fetched: '2026-10-25',
  series: {
    gasoline: {
      title: 'Gasoline',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1978-04-01', 0.65],
        ['1979-04-01', 0.86],
        ['1979-05-01', 9.99], // on selected month - MUST NOT BE USED
        ['1979-06-01', 10.50], // after selected month - MUST NOT BE USED
      ],
    },
    eggs: {
      title: 'Eggs',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1978-04-01', 0.70],
        ['1979-04-01', 0.82],
        ['1979-05-01', 5.00], // on selected month - MUST NOT BE USED
      ],
    },
    cpi: {
      title: 'CPI',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1978-03-01', 64.0],
        ['1979-03-01', 70.4],
        ['1979-04-01', 999.0], // published cutoff for 1979-05 is 2 months back (1979-03), so 1979-04/05 must not be used
        ['1979-05-01', 1200.0], // on selected month - MUST NOT BE USED
      ],
    },
    unemployment: {
      title: 'Unemployment',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1978-03-01', 6.8],
        ['1979-03-01', 5.8],
        ['1979-04-01', 25.0],
        ['1979-05-01', 50.0], // on selected month - MUST NOT BE USED
      ],
    },
    mortgage: {
      title: 'Mortgage Rate',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1979-04-20', 15.25],
        ['1979-05-01', 22.0], // on selected month - MUST NOT BE USED
        ['1979-05-10', 25.0], // after selected month - MUST NOT BE USED
      ],
    },
    minwage: {
      title: 'Minimum Wage',
      start: '1978-01-01',
      end: '1980-01-01',
      obs: [
        ['1979-01-01', 2.90],
        ['1979-05-01', 15.00], // on selected month
      ],
    },
  },
};

const selectedDate = '1979-05-01';

console.log(`Testing economy lines generation for date: ${selectedDate}`);
const allLines = economyLines(samplePrices, selectedDate);
assert.ok(allLines.length > 0, 'Expected economyLines to return lines for sample data');

for (const line of allLines) {
  console.log(`Generated [${line.kind}]: "${line.text}"`);
}

// 1. Verify gasoline price used 1979-04-01 (0.86 / 86 cents), NOT 1979-05-01 (9.99 / nine dollars) or 1979-06-01
const gasLine = allLines.find((l) => l.kind === 'gasoline');
assert.ok(gasLine, 'Gasoline line should be generated');
assert.ok(gasLine.text.includes('eighty-six cents'), `Gasoline line must use April 1979 price (86 cents). Got: "${gasLine.text}"`);
assert.ok(!gasLine.text.includes('nine dollars'), 'Gasoline line must not use May 1979 or later data');
assert.ok(!gasLine.text.includes('ten dollars'), 'Gasoline line must not use June 1979 data');

// 2. Verify eggs price used 1979-04-01 (0.82 / 82 cents), NOT 1979-05-01 ($5.00)
const eggsLine = allLines.find((l) => l.kind === 'eggs');
assert.ok(eggsLine, 'Eggs line should be generated');
assert.ok(eggsLine.text.includes('eighty-two cents'), `Eggs line must use April 1979 price. Got: "${eggsLine.text}"`);
assert.ok(!eggsLine.text.includes('five dollars'), 'Eggs line must not use May 1979 or later data');

// 3. Verify CPI used published cutoff (1979-03-01: 70.4 vs 64.0 -> ~10%), NOT 1979-04 or 1979-05
const cpiLine = allLines.find((l) => l.kind === 'cpi');
assert.ok(cpiLine, 'CPI line should be generated');
assert.ok(cpiLine.text.includes('ten percent'), `CPI line must use published March 1979 data (~10 percent). Got: "${cpiLine.text}"`);
assert.ok(!cpiLine.text.includes('thousand'), 'CPI line must not use May 1979 or later data');

// 4. Verify unemployment used March 1979 (5.8%), NOT April (25%) or May (50%)
const unLine = allLines.find((l) => l.kind === 'unemployment');
assert.ok(unLine, 'Unemployment line should be generated');
assert.ok(unLine.text.includes('five point eight percent'), `Unemployment line must use March 1979 data. Got: "${unLine.text}"`);
assert.ok(!unLine.text.includes('twenty-five') && !unLine.text.includes('fifty'), 'Unemployment line must not use April or May data');

// 5. Verify mortgage rate used latest before date (1979-04-20: 15.25 -> "fifteen and a quarter"), NOT May 1979 (22%)
const mgLine = allLines.find((l) => l.kind === 'mortgage');
assert.ok(mgLine, 'Mortgage line should be generated');
assert.ok(mgLine.text.includes('fifteen and a quarter'), `Mortgage line must use April 1979 data. Got: "${mgLine.text}"`);
assert.ok(!mgLine.text.includes('twenty-two'), 'Mortgage line must not use May 1979 data');

// 6. Verify economyLine randomly picking with recent kinds
const line1 = economyLine(samplePrices, selectedDate, () => 0, ['gasoline']);
assert.ok(line1 !== null, 'economyLine should return a line');
assert.notStrictEqual(line1?.kind, 'gasoline', 'economyLine should avoid recent kinds if possible');

console.log('\n✓ PASS: For date 1979-05-01, the returned line never uses data dated on or after the selected month.');
console.log('================================================================================');
