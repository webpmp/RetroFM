import { filterHindsightAndFutureFacts } from '../src/services/music/songStoryCardService.js';
import assert from 'node:assert';

console.log('Testing date-eligibility choke point on Hello, Dolly! and Don\'t You Want Me...');

// Test 1: Hello, Dolly! on 1964-05-01
const helloDollyFacts = [
  'Produced by Mickey Kapp; Composed by Jerry Herman; Lyrics by Jerry Herman.',
  'Hello, Dolly! is a 1964 album by Louis Armstrong, released by Kapp Records.',
  'The title track won the Grammy Award for Song of the Year in 1965.',
  'Louis Armstrong and his All Stars recorded the song in New York City.',
];

const filtered1964 = filterHindsightAndFutureFacts(helloDollyFacts, '1964-05-01');
console.log('Hello Dolly filtered:', filtered1964);

assert(!filtered1964.some(f => f.includes('Grammy')), 'Must not contain Grammy');
assert(!filtered1964.some(f => f.includes('1964 album')), 'Must not contain 1964 album');
assert(filtered1964.some(f => f.includes('Jerry Herman')), 'Must contain Jerry Herman');

// Test 2: Don't You Want Me on 1982-05-01
const dontYouWantMeFacts = [
  'Written by Jo Callis, Philip Oakey, Philip Adrian Wright.',
  'It has sold over 1.56 million copies in the UK.',
  'It was the band\'s most commercially successful track and was the 1981 UK Christmas number one single.',
  'It was released on 27 November 1981 by Virgin Records as the fourth single from their third studio album, Dare (1981).',
];

const filtered1982 = filterHindsightAndFutureFacts(dontYouWantMeFacts, '1982-05-01');
console.log('Don\'t You Want Me filtered:', filtered1982);

assert(!filtered1982.some(f => f.includes('sold over')), 'Must not contain sold over');
assert(!filtered1982.some(f => f.includes('most commercially successful')), 'Must not contain most commercially successful');
assert(filtered1982.some(f => f.includes('Written by')), 'Must contain Written by');
assert(filtered1982.some(f => f.includes('27 November 1981')), 'Must contain release date');

console.log('Choke point tests passed successfully!');
