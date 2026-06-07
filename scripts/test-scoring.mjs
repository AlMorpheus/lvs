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
eq('точный 2:1', scorePoints({ home: 2, away: 1 }, { home: 2, away: 1 }, cfg), cfg.exact);
eq('исход+разница 2:1->3:2', scorePoints({ home: 2, away: 1 }, { home: 3, away: 2 }, cfg), cfg.outcome + cfg.goalDiff);
eq('только исход 2:1->4:0', scorePoints({ home: 2, away: 1 }, { home: 4, away: 0 }, cfg), cfg.outcome);
eq('ничья 1:1->2:2', scorePoints({ home: 1, away: 1 }, { home: 2, away: 2 }, cfg), cfg.outcome + cfg.goalDiff);
eq('сумма голов 2:1->0:3', scorePoints({ home: 2, away: 1 }, { home: 0, away: 3 }, cfg), cfg.totalGoals); // сумма 3=3, исход неверный
eq('голы команды больше не считаются 2:0->2:3', scorePoints({ home: 2, away: 0 }, { home: 2, away: 3 }, cfg), 0);
eq('мимо 0:0->1:2', scorePoints({ home: 0, away: 0 }, { home: 1, away: 2 }, cfg), 0);

// Авторы (цена зависит от позиции)
const POS = { 10: 'Attacker', 11: 'Midfielder', 12: 'Defender', 99: 'Goalkeeper', 88: 'Coach' };
eq('нап+пз+защ', scorerPoints([10, 11, 12], [10, 11, 12, 13], POS, cfg).pts, cfg.scorerByPos.Attacker + cfg.scorerByPos.Midfielder + cfg.scorerByPos.Defender);
eq('вратарь дорого', scorerPoints([99], [99], POS, cfg).pts, cfg.scorerByPos.Goalkeeper);
eq('2 из 3 (нап+пз)', scorerPoints([10, 11, 12], [10, 11, 77], POS, cfg).pts, cfg.scorerByPos.Attacker + cfg.scorerByPos.Midfielder);
eq('мимо', scorerPoints([10], [55], POS, cfg).pts, 0);
eq('неизвестная позиция -> default', scorerPoints([88], [88], POS, cfg).pts, cfg.scorerDefault);

// Полный матч: точный счёт 3:0 + 3 нападающих
const POS3 = { 1: 'Attacker', 2: 'Attacker', 3: 'Attacker' };
const perfect = {
  finished: true,
  score: { home: 3, away: 0 },
  scorers: [{ playerId: 1, type: 'normal' }, { playerId: 2, type: 'normal' }, { playerId: 3, type: 'normal' }],
  multiplier: 1.0,
  roundKey: 'group-1',
};
const pBase = cfg.exact + 3 * cfg.scorerByPos.Attacker;
const pf = { score: { home: 3, away: 0 }, scorers: [1, 2, 3] };
eq('идеальный матч база', matchPoints(pf, perfect, cfg, POS3).base, pBase);
eq('округление база×1.3', matchPoints(pf, { ...perfect, multiplier: 1.3 }, cfg, POS3).total, Math.round(pBase * 1.3));
eq('финал +5', matchPoints(pf, { ...perfect, multiplier: 2.0, roundKey: 'final' }, cfg, POS3).total, Math.round(pBase * 2.0) + cfg.exactSpecialBonus);
eq('открытие +5', matchPoints(pf, { ...perfect, isOpening: true }, cfg, POS3).total, Math.round(pBase * 1.0) + cfg.exactSpecialBonus);

// Таблица
const users = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }];
const matches = [
  { id: 'g1', finished: true, score: { home: 1, away: 0 }, scorers: [{ playerId: 1, type: 'normal' }], multiplier: 1.0, roundKey: 'group-1', stage: 'group', home: { id: 1 }, away: { id: 2 } },
];
const bets = {
  a: { matches: { g1: { score: { home: 1, away: 0 }, scorers: [1, 9, 8] } } },
  b: { matches: { g1: { score: { home: 0, away: 0 }, scorers: [] } } },
};
const st = standings(users, matches, bets, null, cfg, { 1: 'Attacker' });
eq('A итог (точный + 1 нап)', st.table[0].total, cfg.exact + cfg.scorerByPos.Attacker);
eq('лидер A', st.table[0].id, 'a');

// Плей-офф: счёт основного времени + итог — оба «точный счёт»
const ko = { finished: true, score: { home: 2, away: 1 }, scoreReg: { home: 1, away: 1 }, scorers: [], multiplier: 2.0, roundKey: 'final', home: { name: 'A' }, away: { name: 'B' } };
const koExpect = Math.round(cfg.exact * 2.0) + cfg.exactSpecialBonus;
eq('плей-офф: ставка 1:1 (осн.время) = точный', matchPoints({ score: { home: 1, away: 1 }, scorers: [] }, ko, cfg, {}).total, koExpect);
eq('плей-офф: ставка 2:1 (итог) = точный', matchPoints({ score: { home: 2, away: 1 }, scorers: [] }, ko, cfg, {}).total, koExpect);
eq('плей-офф: 1:1 помечен как осн.время', matchPoints({ score: { home: 1, away: 1 }, scorers: [] }, ko, cfg, {}).usedReg, true);
eq('плей-офф: 0:0 мимо обоих', matchPoints({ score: { home: 0, away: 0 }, scorers: [] }, ko, cfg, {}).isExact, false);

// Долгосрочные прогнозы
const tr = { finished: true, champion: 5, topScorers: [7] };
const bets2 = { a: { matches: {}, tournament: { champion: 5, topScorer: 7 } }, b: { matches: {}, tournament: { champion: 6, topScorer: 7 } } };
const st2 = standings(users, [], bets2, tr, cfg);
eq('A чемп+бомб', st2.table.find((x) => x.id === 'a').total, cfg.championBonus + cfg.topScorerBonus);
eq('B только бомб', st2.table.find((x) => x.id === 'b').total, cfg.topScorerBonus);

console.log(fails ? `\n❌ Провалено: ${fails}` : '\n✅ Все проверки прошли');
process.exit(fails ? 1 : 0);
