import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const archivePath = join(__dirname, '..', 'src', 'data', 'archiveResults.json');

const raw = JSON.parse(readFileSync(archivePath, 'utf-8'));

if (Array.isArray(raw)) {
  console.log('✅ 既に配列形式です。変換不要。');
  process.exit(0);
}

const entries = [];

for (const [year, months] of Object.entries(raw)) {
  for (const [month, days] of Object.entries(months)) {
    for (const [day, data] of Object.entries(days)) {
      const date = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;

      const totalRaces = data.totalRaces ?? (data.races?.length ?? 0);
      const hitRaces = data.hitRaces ?? (data.races?.filter(r => r.hit || r.isHit).length ?? 0);
      const hitRate = totalRaces > 0 ? parseFloat(((hitRaces / totalRaces) * 100).toFixed(1)) : 0;

      const races = (data.races ?? []).map(r => ({
        raceNumber: r.raceNumber,
        raceName: r.raceName,
        betType: r.betType,
        betPoints: r.betPoints,
        isHit: r.isHit ?? r.hit ?? false,
        payout: r.payout ?? 0
      }));

      entries.push({
        date,
        venue: data.venue,
        totalRaces,
        hitRaces,
        missRaces: totalRaces - hitRaces,
        hitRate,
        totalPayout: data.totalPayout ?? 0,
        returnRate: data.returnRate ?? data.recoveryRate ?? 0,
        races,
        migratedAt: new Date().toISOString()
      });
    }
  }
}

entries.sort((a, b) => a.date.localeCompare(b.date));

writeFileSync(archivePath, JSON.stringify(entries, null, 2), 'utf-8');

console.log(`✅ マイグレーション完了: ${entries.length}件`);
for (const e of entries) {
  console.log(`   ${e.date} ${e.venue} ${e.hitRaces}/${e.totalRaces}R 回収率${e.returnRate}%`);
}
