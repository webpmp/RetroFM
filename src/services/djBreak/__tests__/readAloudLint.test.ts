// @ts-ignore
import { describe, it, expect } from 'bun:test';
import { lintReadAloudScript } from '../breakValidator.js';

describe('lintReadAloudScript (Round 6 Item 1)', () => {
  it('rejects the 1962-10-23 bad script (4+ consecutive all-caps words and index abbreviations)', () => {
    const bad1962 =
      "From the front page of today's Times: U.S. IMPOSES ARMS BLOCKADE ON CUBA ON FINDING OFFENSIVE MISSILE SITES; KENNEDY READY FOR SOVIET SHOWDOWN; Sov Ships Watched, Air Force Moves rapidly to Complete Dispersal After Calling Explains Action to Halt Threat to Hemisphere — 7-Step Plan Set. Kennedy links orders to discovery of missiles in Cuba, TV-radio address; text; illus; reactions in Havana, Washington and major capitals. Next up is 'Every Breath You Take' by The Police.";
    const res = lintReadAloudScript(bad1962);
    expect(res.valid).toBe(false);
    expect(res.rejectedReason).toBeDefined();
  });

  it('rejects the 1968-06-06 bad script (index abbreviations exchs/repts and semicolon chains)', () => {
    const bad1968 =
      "From the front page of today's Times: North Vietnamese negotiators contend Hanoi responded to Johnson's bombing restrictions by entering official talks; assert next move of total bombing halt is up to United States; North Vietnamese argument produces sharp exchs; Xuan Thuy asks Harriman when United States will stop bombing and meet other requests; Harriman links step toward peace to restraint in Demilitarized Zone. Right now, The Police and 'Every Breath You Take.'";
    const res = lintReadAloudScript(bad1968);
    expect(res.valid).toBe(false);
    expect(res.rejectedReason).toMatch(/semicolon|abbreviation/i);
  });

  it('rejects the 1970-05-05 bad script (broken OCR word "Univer sity", semicolon chain, and abbreviations)', () => {
    const bad1970 =
      "From the front page of today's Times: Four students at Kent State Univer sity, two of them women, were shot to death this afternoon by a volley of National Guard gunfire. Guard quickly reinforced in Kent, Ohio, as shootings turn moderate student body hostile; witnesses say killing was unprovoked; guard office says rocks were being thrown at troops; campus sealed off under ct order; illus. Here's The Police with 'Every Breath You Take.'";
    const res = lintReadAloudScript(bad1970);
    expect(res.valid).toBe(false);
    expect(res.rejectedReason).toMatch(/semicolon|broken|abbreviation/i);
  });

  it('rejects the 1975-04-30 bad script (day abbreviation "Apr 29", semicolon chain, and index abbreviations Amers/mil)', () => {
    const bad1975 =
      "From the front page of today's Times: Pres Ford on Apr 29 announces completion of evacuation of Amers from Saigon and Vietnam; white Christmas' was broadcast over Amer Forces Radio the morning of Apr 29 as signal to remaining Amers in Saigon to report inside Ton Son Nhut Air Base. Saigon airport, scene of mounting chaos and panic as Vietnamese struggle to board outgoing Amer planes, comes under rocket and artillery attacks from North Vietnamese Army on Apr 29. Up next, 'Every Breath You Take' from The Police.";
    const res = lintReadAloudScript(bad1975);
    expect(res.valid).toBe(false);
    expect(res.rejectedReason).toMatch(/abbreviation|date|semicolon/i);
  });

  it('rejects the 1988-07-04 bad script (repeated duplicate sentences)', () => {
    const bad1988 =
      "From the front page of today's Times: The United States Navy in the Persian Gulf shot down an Iranian airline jet yesterday after mistaking it for an attacking fighter plane. Iranian authorities said all 290 people aboard the aircraft had been killed in the disaster over the Strait of Hormuz. The United States Navy in the Persian Gulf shot down an Iranian airline jet today after mistaking it for an attacking fighter plane. Coming up, 'Every Breath You Take' by The Police.";
    const res = lintReadAloudScript(bad1988);
    expect(res.valid).toBe(false);
    expect(res.rejectedReason).toMatch(/duplicate/i);
  });

  it('accepts clean spoken radio prose with a natural handoff', () => {
    const cleanScript =
      "From the front page of today's Times: The United States Navy shot down an Iranian passenger jet over the Persian Gulf yesterday after mistaking the airliner for an attacking fighter plane. Iranian authorities said all 290 people aboard the aircraft died in the disaster over the Strait of Hormuz. Next up is 'Roll With It' by Steve Winwood.";
    const res = lintReadAloudScript(cleanScript);
    expect(res.valid).toBe(true);
  });
});
