import fs from "fs";
import path from "path";

// List of dates and their actual lead article pub_date & expected event
const auditQueries = [
  { targetDate: "1981-03-30", file: "1981-03.json", query: "HAIG IS TROUBLED BY TROOP MOVES ON POLISH BORDER" },
  { targetDate: "1989-11-09", file: "1989-11.json", query: "BONN TIES MORE AID FOR EAST GERMANY TO FREE ELECTIONS" },
  { targetDate: "1969-08-15", file: "1969-08.json", query: "BRITISH AIRLIFTING TROOPS TO ULSTER" },
  { targetDate: "1985-07-13", file: "1985-07.json", query: "FOREIGN AID BILL MAY BE VETOED OVER STRICTURES" },
  { targetDate: "1985-07-13", file: "1985-07.json", query: "MEDICARE MAY PAY PART OF REAGAN'S SURGERY" },
  { targetDate: "1985-07-13", file: "1985-07.json", query: "'LIVE AID' CONCERT IS AIMING FOR THE SKY" },
  { targetDate: "1963-11-22", file: "1963-11.json", query: "KENNEDY PLEDGES SPACE ADVANCES" },
  { targetDate: "1980-05-18", file: "1980-05.json", query: "Homeowners Are Bitter and Fearful as Results of Study Are Released" },
  // Also find the actual post-event breaking news articles published the next day:
  { targetDate: "1981-03-31 (Post-shooting)", file: "1981-03.json", query: "Reagan Wounded in Chest by Gunman" },
  { targetDate: "1963-11-23 (Post-assassination)", file: "1963-11.json", query: "Gov. Connally Shot; Mrs. Kennedy Safe" },
  { targetDate: "1985-07-14 (Post-surgery)", file: "1985-07.json", query: "Reagan's Surgeons Remove Growth From His Intestine" }
];

console.log("================================================================================");
console.log("ITEM 1: DIRECT CACHE AUDIT FROM DISK (RAW JSON RECORDS)");
console.log("================================================================================\n");

for (const item of auditQueries) {
  const filePath = path.resolve("cache/nyt", item.file);
  const rawData = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const articles = rawData.articles || [];
  
  const found = articles.find((a: any) => 
    a.headline && a.headline.toLowerCase().includes(item.query.toLowerCase())
  );

  console.log(`--------------------------------------------------------------------------------`);
  console.log(`TARGET: ${item.targetDate} | QUERY: "${item.query}"`);
  console.log(`FILE: ${filePath}`);
  if (!found) {
    console.log(`NOT FOUND IN CACHE FILE.`);
  } else {
    console.log(`RAW JSON RECORD:`);
    console.log(JSON.stringify({
      pub_date: found.pubDate,
      print_page: found.printPage,
      print_section: found.printSection,
      headline: found.headline,
      section: found.section,
      desk: found.desk,
      first_200_chars: (found.abstract || found.snippet || "").slice(0, 200)
    }, null, 2));
  }
}
