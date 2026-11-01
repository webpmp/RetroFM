import { resolveRelativeTimeWords } from '../src/services/news/almanacService.js';
import assert from 'assert';

console.log('Testing relative time resolution for Mitchum Cannes article...');

const artText = 'Last night a patrician Robert Mitchum, accompanied by his two grown sons, Jim and Chris, stood on the stage of the Palais du Festival and announced that the 44th Cannes Film Festival was officially open.';
const printDate = '1991-05-11'; // Saturday paper

const res = resolveRelativeTimeWords(artText, printDate);
console.log('Original Print Date:', printDate);
console.log('Resolved Event Date:', res.eventDate);
console.log('Resolved Text:', res.text);

assert.ok(res.text.includes('Thursday night'), 'Expected "Thursday night" from "last night" in Saturday May 11 paper');
assert.strictEqual(res.eventDate, '1991-05-09', 'Event date must be Thursday, 1991-05-09');

console.log('✓ PASS: Relative time resolution test succeeded.\n');
