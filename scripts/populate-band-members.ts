import { DatabaseSync } from 'node:sqlite';
import path from 'path';

const homedir = process.env.HOME || '/root';
const dbPath = path.join(homedir, 'retrofm', 'library.sqlite');
const db = new DatabaseSync(dbPath);

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS band_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    band_name TEXT NOT NULL,
    member_name TEXT NOT NULL,
    begin_date TEXT,
    end_date TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_band_members_band ON band_members(band_name);
  CREATE INDEX IF NOT EXISTS idx_band_members_member ON band_members(member_name);
`);

async function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchMB(url: string, retries = 3): Promise<any> {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'RetroFM/1.0 ( webpmp@gmail.com )',
          'Accept': 'application/json',
        },
      });
      if (res.status === 503 || res.status === 429) {
        await delay(2000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (i >= retries) return null;
      await delay(1500 * (i + 1));
    }
  }
  return null;
}

const keyBands: { name: string; mbid?: string; aliases?: string[] }[] = [
  { name: 'The Beatles', mbid: 'b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d' },
  { name: 'The Dave Clark Five', mbid: '3cf5c846-9d33-4f9e-a89a-0744747c34b6' },
  { name: 'The Beach Boys', mbid: 'eb0064f5-7033-40e1-bb9b-aa558cb79377' },
  { name: 'The Rolling Stones', mbid: 'b071f9fa-14b0-4217-8e97-eb41da73f598' },
  { name: 'The Doors', mbid: '9efff43b-3b29-447a-8276-0092147a27a0' },
  { name: 'The Byrds', mbid: '2927915c-89cf-4482-a7ab-b7b51447041e' },
  { name: 'The Kinks', mbid: 'f9b5c2a7-5c5f-4a34-bb64-c75c87915b4f' },
  { name: 'The Who', mbid: '9fcaa4e3-94c7-4972-8a90-ee8827f272a8' },
  { name: 'The Monkees', mbid: 'a1dc1d57-0130-47e2-8947-f5da11ec26d3' },
  { name: 'Simon & Garfunkel', mbid: '5378f473-b313-4d47-a9e9-0db834214f63' },
  { name: 'The Mamas & The Papas', mbid: 'c28308cb-e866-4c40-8fb3-a00be59fb950' },
  { name: 'The Lovin\' Spoonful', mbid: '5561a0d7-eb0c-43f1-bdce-e11a3db1a4d8' },
  { name: 'The Hollies', mbid: '12b8d9aa-56a9-4672-911e-ec95376cd7d2' },
  { name: 'The Zombies', mbid: '9d2d0c24-bcba-4f67-8629-d5c22538f192' },
  { name: 'Creedence Clearwater Revival', mbid: '1079361d-f517-4002-a400-472097e3cb04' },
  { name: 'Led Zeppelin', mbid: '678d88b2-87b0-403b-b63d-5da7465aecc3' },
  { name: 'Queen', mbid: '0383dadf-2a4e-4d10-a46a-e6e041da9180' },
  { name: 'Eagles', mbid: 'f46bd570-5768-462e-b875-ee326fba82a4' },
  { name: 'Fleetwood Mac', mbid: 'bd13909f-1c29-4c27-a874-d4aaf27c5b1a' },
  { name: 'Chicago', mbid: '034ef5d9-c0bb-48aa-b552-6ef8fec8a230' },
  { name: 'Aerosmith', mbid: '3d2b98e5-556f-440e-b836-73808bedd0fa' },
  { name: 'Genesis', mbid: '8e3fcd7d-bba1-4099-a65c-6065eb009218' },
  { name: 'Blondie', mbid: '5be97135-430b-4654-be8c-ca0a76cfdc8a' },
  { name: 'The Police', mbid: '9e53f84d-ef44-4c68-b8f8-624b45a00d83' },
  { name: 'The Cars', mbid: '1cbb8864-8395-442a-9f2d-8e4cb0bc86f0' },
  { name: 'The J. Geils Band', mbid: '6ca4f794-ae2b-4560-9112-2d1c640e3b62' },
  { name: 'Huey Lewis & The News', mbid: '0dbfaea5-f485-48fa-a477-8097b6920150' },
  { name: 'Duran Duran', mbid: '435c1448-6043-4a34-b233-726164933794' },
  { name: 'Dire Straits', mbid: '614e3800-7af9-4190-86fb-44d493303ada' },
  { name: 'The Doobie Brothers', mbid: '96b92a2a-b620-4ee8-b2ef-3bcda1978280' },
  { name: 'Earth, Wind & Fire', mbid: '57e754fb-cf74-4cc6-8a7e-f63aa0ebff9e' },
  { name: 'Bee Gees', mbid: 'bfcca110-ab11-46a8-a0c6-81740f167242' },
  { name: 'ABBA', mbid: 'd87e52c5-bb8d-4da8-b942-2799494303e1' },
  { name: 'Pink Floyd', mbid: '83d91898-7763-47d7-b03b-b92132375c47' },
  { name: 'Heart', mbid: '312e345b-c015-4674-a69d-2139e5595914' },
  { name: 'Foreigner', mbid: '5165d21e-dd82-4f39-9d7a-115f5a8c2275' },
  { name: 'Journey', mbid: '66e138a2-259a-4c28-98fb-eb077cb54c15' },
  { name: 'The Clash', mbid: '8f92167d-0775-40b9-8cbe-3b32e01fb331' },
  { name: 'U2', mbid: 'a3cb23fc-acd3-4ce0-8f36-1e5aa6a18432' },
  { name: 'R.E.M.', mbid: 'ea40072b-e7b3-406a-a28a-669c3a37b605' },
  { name: 'The Drifters', mbid: '9e2d3f58-0653-4007-bcb7-1746fcdd9363' },
  { name: 'The Platters', mbid: '3fb55c03-3ad9-4341-8d0b-7c4c49aefca0' },
  { name: 'The Shirelles', mbid: 'a8540ea0-1a74-4c22-8b70-1348a77a74a0' },
  { name: 'The Temptations', mbid: '12d93be7-c533-4f9e-a89a-0744747c34b6' },
  { name: 'The Supremes', mbid: 'd9b62f4b-2f6a-4b92-96cb-8d0ff48ff78b' },
  { name: 'The 4 Seasons', mbid: 'd1969a53-4623-452c-8068-d069dc2a1148' },
  { name: 'The Four Tops', mbid: '79a557b7-5f21-4f9e-a9b0-96f7c870a417' },
  { name: 'The Miracles', mbid: '44ef3381-807a-40a2-b91c-7164bdf9f086' },
  { name: 'The Isley Brothers', mbid: 'd3f6d7ce-c625-4a6c-94c6-43b9df72e259' },
  { name: 'The Spinners', mbid: '46387d85-d853-41bb-a634-118e778401ee' },
  { name: 'The O\'Jays', mbid: '8cfdbd27-6f8e-4a62-8509-5a21c1071d79' },
  { name: 'The Righteous Brothers', mbid: 'b36511a2-fffa-41dc-a5ce-b1187498c894' },
  { name: 'The Young Rascals', mbid: 'e5917aa1-404c-419b-a0e2-63259e87f3b8' },
  { name: 'The Brothers Four', mbid: '051dc5d8-c7b4-4e7d-9477-8fa29810f135' },
  { name: 'The Ventures', mbid: 'bb7c9db1-356a-4dc9-9e8c-8be985efbcce' },
  { name: 'The Fendermen', mbid: '4a034293-ea5e-4bb0-8a62-581333792370' },
  { name: 'The Dovells', mbid: '7dffcb5d-4f10-449e-ba23-9f8ce307a0a0' },
  { name: 'The Highwaymen', mbid: '30ba81b4-bf53-48ee-a010-0931df250266' },
  { name: 'The Marcels', mbid: 'f5fca78c-5727-464a-bf98-04f861fcb9e3' },
  { name: 'The String-A-Longs', mbid: 'b9d3e86c-ecf2-4fc4-b153-e51c89be6f2d' },
  { name: 'The Belmonts', mbid: 'd9b04768-45e0-47b6-94a2-1dc31f855d04' },
  { name: 'The Jordanaires', mbid: 'cf951833-2ba3-4424-bca5-b82aafe8e42f' },
];

async function run() {
  const checkExisting = db.prepare('SELECT count(*) as c FROM band_members WHERE band_name = ?');
  const insertStmt = db.prepare(`
    INSERT INTO band_members (band_name, member_name, begin_date, end_date)
    VALUES (?, ?, ?, ?)
  `);

  console.log(`Checking/populating band members for ${keyBands.length} top library groups...`);

  for (const b of keyBands) {
    const existing = (checkExisting.get(b.name) as any)?.c || 0;
    if (existing > 0) {
      console.log(`  [Skip] ${b.name} already has ${existing} members.`);
      continue;
    }

    let mbid = b.mbid;
    if (!mbid) {
      await delay(1100);
      const searchUrl = `https://musicbrainz.org/ws/2/artist?query=artist:"${encodeURIComponent(b.name)}"&fmt=json`;
      const searchData = await fetchMB(searchUrl);
      mbid = searchData?.artists?.[0]?.id;
    }

    if (!mbid) {
      console.log(`  [Not found] Could not find MBID for ${b.name}`);
      continue;
    }

    await delay(1100);
    const artistUrl = `https://musicbrainz.org/ws/2/artist/${mbid}?inc=artist-rels&fmt=json`;
    const artistData = await fetchMB(artistUrl);
    if (!artistData) {
      console.log(`  [Failed] Failed to fetch relations for ${b.name}`);
      continue;
    }

    const relations = (artistData.relations || []).filter((r: any) => r.type === 'member of band');
    let added = 0;
    for (const rel of relations) {
      const memberName = rel.artist?.name;
      if (memberName) {
        insertStmt.run(b.name, memberName, rel.begin || null, rel.end || null);
        added++;
      }
    }
    console.log(`  [Populated] ${b.name}: added ${added} members.`);
  }

  const totalMembers = (db.prepare('SELECT count(*) as c FROM band_members').get() as any)?.c || 0;
  console.log(`Finished. Total band members in database: ${totalMembers}.`);
}

run().catch(console.error);
