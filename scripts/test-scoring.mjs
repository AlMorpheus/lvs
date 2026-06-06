// Проверки модуля очков. Запуск: npm test
import { scorePoints, scorerPoints, matchPoints, standings } from '../assets/js/scoring.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(readFileSync(join(ROOT, 'config/app.json'), 'utf8')).scoring;

let fails = 0;
function eq(name, got, exp) {
  const ok = JSON.stringify(got) === JSON.stringify(exp);
  if (!ok) fails++;
  console.log((ok ? 'OK   ' : 'FAIL ') + name + `  got=${got} exp=${exp}`);
}

// Очки за счёт
eq('точный 2:1', scorePoints({ home: 2, away: 1 }, { home: 2, away: 1 }, cfg), 20);
eq('исход+разница 2:1->3:2', scorePoints({ home: 2, away: 1 }, { home: 3, away: 2 }, cfg), 12);
eq('только исход 2:1->4:0', scorePoints({ home: 2, away: 1 }, { home: 4, away: 0 }, cfg), 7);
eq('ничья 1:1->2:2', scorePoints({ home: 1, away: 1 }, { home: 2, away: 2 }, cfg), 12);
eq('сумма голов 2:1->0:3', scorePoints({ home: 2, away: 1 }, { home: 0, away: 3 }, cfg), 5); // сумма 3=3
eq('голы одной команды 2:0->2:3', scorePoints({ home: 2, away: 0 }, { home: 2, away: 3 }, cfg), 4);
eq('мимо 0:0->1:2', scorePoints({ home: 0, away: 0 }, { home: 1, away: 2 }, cfg), 0);

// Авторы
eq('3 из 3 очки', scorerPoints([10, 11, 12], [10, 11, 12, 13], 4, cfg).pts, 12);
eq('3 из 3 хет-трик', scorerPoints([10, 11, 12], [10, 11, 12], 3, cfg).hat, 3);
eq('хет-трик не даётся при 2 голах', scorerPoints([10, 11, 12], [10, 11], 2, cfg).hat, 0);
eq('2 из 3', scorerPoints([10, 11, 12], [10, 11, 99], 5, cfg).pts, 8);

// Полный матч
const perfect = {
  finished: true,
  score: { home: 3, away: 0 },
  scorers: [{ playerId: 1, type: 'normal' }, { playerId: 2, type: 'normal' }, { playerId: 3, type: 'normal' }],
  multiplier: 1.0,
  roundKey: 'group-1',
};
eq('идеальный матч база=35', matchPoints({ score: { home: 3, away: 0 }, scorers: [1, 2, 3] }, perfect, cfg).base, 35);
eq('округление 35*1.3=46', matchPoints({ score: { home: 3, away: 0 }, scorers: [1, 2, 3] }, { ...perfect, multiplier: 1.3 }, cfg).total, 46);
eq('финал +5', matchPoints({ score: { home: 3, away: 0 }, scorers: [1, 2, 3] }, { ...perfect, multiplier: 2.0, roundKey: 'final' }, cfg).total, 75);
eq('открытие +5', matchPoints({ score: { home: 3, away: 0 }, scorers: [1, 2, 3] }, { ...perfect, isOpening: true }, cfg).total, 40);

// Таблица + джекпот тура
const users = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const matches = [
  { id: 'g1', finished: true, score: { home: 1, away: 0 }, scorers: [{ playerId: 1, type: 'normal' }], multiplier: 1.0, roundKey: 'group-1', stage: 'group', home: { id: 1 }, away: { id: 2 } },
];
const bets = {
  a: { matches: { g1: { score: { home: 1, away: 0 }, scorers: [1, 9, 8] } } },
  b: { matches: { g1: { score: { home: 0, away: 0 }, scorers: [] } } },
};
const st = standings(users, matches, bets, null, cfg);
eq('A итог с джекпотом=34', st.table[0].total, 34); // 20 + 4 + 10
eq('лидер A', st.table[0].id, 'a');

// Долгосрочные прогнозы
const tr = { finished: true, champion: 5, topScorers: [7] };
const bets2 = { a: { matches: {}, tournament: { champion: 5, topScorer: 7 } }, b: { matches: {}, tournament: { champion: 6, topScorer: 7 } } };
const st2 = standings(users, [], bets2, tr, cfg);
eq('A чемп+бомб=150', st2.table.find((x) => x.id === 'a').total, 150);
eq('B только бомб=50', st2.table.find((x) => x.id === 'b').total, 50);

console.log(fails ? `\n❌ Провалено: ${fails}` : '\n✅ Все проверки прошли');
process.exit(fails ? 1 : 0);
