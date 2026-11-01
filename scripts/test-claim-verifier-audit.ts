import { LMStudioScriptWriterProvider } from '../src/services/djBreak/LMStudioScriptWriterProvider.js';

async function main() {
  const provider = new LMStudioScriptWriterProvider();
  const activeModel = await provider.resolveModel();
  console.log(`Using model: ${activeModel}`);

  const FACT_SHEET = `Fact [1]: "Rosanna" by Toto is climbing to number 59 on the Billboard Hot 100 this week.
Fact [2]: "Rosanna" was written by David Paich.
Fact [3]: Twelve people were killed in Hoboken Thursday in a predawn fire that consumed a small four-story hotel largely filled with women and children.
Fact [4]: Smokey Robinson wrote and produced "My Guy" for Mary Wells in 1964.
Fact [5]: Cecil Taylor gave a concert of contemporary jazz on Saturday.`;

  const KNOWN_BAD_LINES = [
    { id: 1, text: "The drum pattern has become widely studied among musicians as the Rosanna shuffle." },
    { id: 2, text: "It was recorded at Bell Sound Studios." },
    { id: 3, text: "Robinson crafted the rhythm specifically for Wells' vocal style." },
    { id: 4, text: "Cecil Taylor, the pioneering pianist, gave a concert on Saturday." },
    { id: 5, text: "Fire investigators in Los Angeles are examining the scene." },
    { id: 6, text: "The fire consumed Pinter's Hotel." },
    { id: 7, text: "Residents escaped the three-story structure." },
    { id: 8, text: "She continues expanding her experimental sound in New York clubs." }
  ];

  const claimsFormatted = KNOWN_BAD_LINES.map(c => `Claim ${c.id}: ${c.text}`).join('\n');

  const systemPrompt = `You are a strict radio broadcast fact verifier.
Verify each numbered claim sentence against the fact sheet.

CRITICAL RULES:
1. If a claim contains ANY detail, adjective, title, praise, or characterization (such as "pioneering", "legendary", "iconic", "virtuoso", studio name, location, number of stories, or drum name) that is NOT explicitly stated in the fact sheet, you MUST output:
[Claim N]: UNSUPPORTED: <reason>
2. General cultural knowledge, external facts, or historical inferences outside the fact sheet are STRICTLY FORBIDDEN.
3. If every detail in the claim is explicitly supported by a fact, output:
[Claim N]: SUPPORTED (Fact <id>)`;

  const userPrompt = `FACT SHEET:
${FACT_SHEET}

CLAIMS TO VERIFY:
${claimsFormatted}

VERDICTS:`;

  console.log("\n=== AUDIT PROMPT PRINTED ===");
  console.log("System Prompt:\n" + systemPrompt);
  console.log("\nUser Prompt:\n" + userPrompt);

  const res = await fetch(`${provider.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: activeModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0.0,
      max_tokens: 600
    })
  });

  if (!res.ok) {
    throw new Error(`API error: ${res.statusText}`);
  }

  const data = await res.json();
  const output = data.choices[0].message.content.trim();
  console.log("\n=== AUDIT VERDICTS RETURNED ===");
  console.log(output);

  // Check that all 8 are marked UNSUPPORTED
  let allFlagged = true;
  for (let i = 1; i <= 8; i++) {
    const regex = new RegExp(`\\[Claim ${i}\\]:\\s*UNSUPPORTED`, 'i');
    if (!regex.test(output)) {
      console.error(`FAILED: Claim ${i} was not marked UNSUPPORTED!`);
      allFlagged = false;
    }
  }

  if (allFlagged) {
    console.log("\nSUCCESS: All 8 known bad lines were correctly flagged as UNSUPPORTED by the verifier!");
  } else {
    process.exit(1);
  }
}

main().catch(console.error);
