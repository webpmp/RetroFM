import assert from 'node:assert';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { getOrBuildSongStoryCard } from '../src/services/music/songStoryCardService.js';

console.log('Testing song credit joins...');

const homedir = process.env.HOME || '/root';
const db = new DatabaseSync(path.join(homedir, 'retrofm', 'library.sqlite'));

// Test 1: My Guy (Mary Wells, song_id: 1964-005)
const myGuySong = { id: '1964-005', title: 'My Guy', artist: 'Mary Wells' };
const myGuyCard = await getOrBuildSongStoryCard(myGuySong, '1964-05-01', db);
const myGuyFactTexts = myGuyCard.facts.map((f) => f.factText).join(' ');

console.log('My Guy Facts:');
myGuyCard.facts.forEach((f) => console.log(' -', f.factText));

assert.ok(
  !myGuyFactTexts.includes('Lennon') && !myGuyFactTexts.includes('McCartney'),
  'My Guy must NOT get Lennon and McCartney credits!'
);

// Test 2: Walk On By (Dionne Warwick, song_id: 1964-036)
const walkOnBySong = { id: '1964-036', title: 'Walk On By', artist: 'Dionne Warwick' };
const walkOnByCard = await getOrBuildSongStoryCard(walkOnBySong, '1964-05-01', db);
const walkOnByFactTexts = walkOnByCard.facts.map((f) => f.factText).join(' ');

console.log('\nWalk On By Facts:');
walkOnByCard.facts.forEach((f) => console.log(' -', f.factText));

assert.ok(
  !walkOnByFactTexts.includes('Jerry Herman'),
  'Walk On By must NOT get Jerry Herman credits!'
);

console.log('\n✓ PASS: All credit join checks succeeded!');
