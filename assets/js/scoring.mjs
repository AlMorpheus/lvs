// Единый модуль подсчёта очков. Импортируется И фронтендом (браузер), И GitHub Action (Node).
// Никаких внешних зависимостей и обращений к DOM/сети — только чистые функции.

/** Исход матча по счёту: 'H' — победа хозяев, 'D' — ничья, 'A' — победа гостей. */
export function outcome(home, away) {
  if (home > away) return 'H';
  if (home < away) return 'A';
  return 'D';
}

/**
 * Очки за угаданный счёт (макс scoreBlockMax = 20).
 * bet/actual = { home, away } — целые числа.
 */
export function scorePoints(bet, actual, cfg) {
  if (bet.home === actual.home && bet.away === actual.away) return cfg.exact; // точный счёт = джекпот

  let pts = 0;
  if (outcome(bet.home, bet.away) === outcome(actual.home, actual.away)) {
    pts += cfg.outcome; // угадан исход
    if (bet.home - bet.away === actual.home - actual.away) pts += cfg.goalDiff; // + разница мячей
  }
  if (bet.home === actual.home) pts += cfg.teamGoals; // голы хозяев точно
  if (bet.away === actual.away) pts += cfg.teamGoals; // голы гостей точно
  if (bet.home + bet.away === actual.home + actual.away) pts += cfg.totalGoals; // суммарные голы

  return Math.min(pts, cfg.scoreBlockMax);
}

/**
 * Очки за авторов голов.
 * betScorers   — массив playerId (до 3, прогноз).
 * actualScorers — массив playerId реально забивших (БЕЗ автоголов; дубликаты допустимы).
 * totalGoals   — всего голов в матче (для условия хет-трика «3+ голов»).
 */
export function scorerPoints(betScorers, actualScorers, totalGoals, cfg) {
  const picks = [...new Set((betScorers || []).filter((x) => x != null))];
  const scored = new Set(actualScorers || []);
  let correct = 0;
  for (const id of picks) if (scored.has(id)) correct += 1;

  const pts = correct * cfg.scorerEach;
  const allThree = picks.length >= cfg.scorersPerBet && correct >= cfg.scorersPerBet;
  const hat = allThree && totalGoals >= 3 ? cfg.hatTrick : 0;
  return { pts, hat, correct };
}

/** Голы, засчитываемые автору прогноза (исключаем автоголы). */
export function realScorerIds(match) {
  return (match.scorers || []).filter((s) => s.type !== 'own').map((s) => s.playerId);
}

/**
 * Множитель сложности матча.
 * match.stage ∈ 'group'|'r16'|'qf'|'sf'|'final'|'third'
 * ranks — { [teamId]: fifaRank }. Если ранга нет — считаем команду «слабой» (большой ранг).
 * Ручное переопределение: match.multiplierOverride.
 */
export function matchMultiplier(match, ranks, cfg) {
  if (match.multiplierOverride != null) return match.multiplierOverride;

  const stage = match.stage;
  if (stage === 'qf' || stage === 'sf' || stage === 'final' || stage === 'third') return cfg.knockoutQfPlus;
  if (stage === 'r16') return cfg.round16;

  // Групповой этап
  const big = 999;
  const rh = (ranks && ranks[match.home?.id]) ?? big;
  const ra = (ranks && ranks[match.away?.id]) ?? big;
  if (rh <= cfg.topMatchMaxRank && ra <= cfg.topMatchMaxRank) return cfg.groupTopMatch; // топ-матч группы
  if (Math.abs(rh - ra) > cfg.favoriteRankDiff) return cfg.groupFavorite; // явный фаворит
  return cfg.groupEqual; // примерно равные
}

/** Матч с бонусом +5 за точный счёт: открытие, 1/8, 1/4, 1/2, финал. */
export function isSpecialBonusMatch(match, cfg) {
  const rounds = cfg.specialExactBonusRounds || [];
  if (match.isOpening && rounds.includes('opening')) return true;
  return rounds.includes(match.roundKey);
}

/** Завершён ли матч (есть финальный счёт). */
export function isFinished(match) {
  return match.finished === true && match.score && match.score.home != null && match.score.away != null;
}

// Порядок туров и от какого тура зависит открытие ставок.
export const ROUND_SEQUENCE = ['group-1', 'group-2', 'group-3', 'r16', 'qf', 'sf', 'third', 'final'];
const ROUND_PREV = { 'group-2': 'group-1', 'group-3': 'group-2', r16: 'group-3', qf: 'r16', sf: 'qf', third: 'sf', final: 'sf' };

/**
 * Открыт ли тур для ставок. Тур открывается, когда ПОЛНОСТЬЮ завершён предыдущий
 * (1-й тур группы открыт всегда; плей-офф — после предыдущей стадии).
 */
export function roundUnlocked(roundKey, matches) {
  const prev = ROUND_PREV[roundKey];
  if (!prev) return true;
  const prevMatches = matches.filter((m) => m.roundKey === prev);
  if (!prevMatches.length) return true; // нет данных предыдущего тура — не блокируем
  return prevMatches.every(isFinished);
}

/**
 * Полный расчёт очков пользователя за один матч.
 * Возвращает разбивку и итог (с учётом множителя и спец-бонуса +5).
 * Если результата нет или ставки нет — возвращает null.
 */
export function matchPoints(bet, match, cfg) {
  if (!bet || !isFinished(match)) return null;

  const actual = { home: match.score.home, away: match.score.away };
  const sp = scorePoints(bet.score, actual, cfg);
  const actualScorers = realScorerIds(match);
  const totalGoals = actual.home + actual.away;
  const { pts: scp, hat, correct } = scorerPoints(bet.scorers, actualScorers, totalGoals, cfg);

  const base = sp + scp + hat;
  const multiplier = match.multiplier ?? 1;
  let total = Math.round(base * multiplier);

  const isExact = bet.score.home === actual.home && bet.score.away === actual.away;
  const special = isExact && isSpecialBonusMatch(match, cfg) ? cfg.exactSpecialBonus : 0;
  total += special;

  return { scorePts: sp, scorerPts: scp, hat, correctScorers: correct, base, multiplier, special, total, isExact };
}

/**
 * Сколько очков ставка МОЖЕТ принести максимум (для подсказки на форме до матча).
 */
export function maxPotential(match, cfg) {
  const multiplier = match.multiplier ?? 1;
  const base = cfg.scoreBlockMax + cfg.scorerEach * cfg.scorersPerBet + cfg.hatTrick;
  let total = Math.round(base * multiplier);
  if (isSpecialBonusMatch(match, cfg)) total += cfg.exactSpecialBonus;
  return total;
}

/**
 * Итоговая таблица.
 * users    — [{ id, name }]
 * matches  — [match]
 * bets     — { [userId]: { matches: { [matchId]: bet }, tournament: {champion, topScorer} } }
 *            bet матча: { score:{home,away}, scorers:[id,id,id] }
 * tournamentResult — { finished, champion: teamId, topScorers: [playerId] } | null
 * Возвращает { table, rounds } где table отсортирована по убыванию total.
 */
export function standings(users, matches, bets, tournamentResult, cfg) {
  const byUser = {};
  for (const u of users) {
    byUser[u.id] = {
      id: u.id,
      name: u.name,
      matchPts: 0,
      jackpotPts: 0,
      futuresPts: 0,
      total: 0,
      exactCount: 0,
      perMatch: {}, // matchId -> result разбивки
      perRound: {}, // roundKey -> сумма очков за тур (матчевые, без джекпота)
    };
  }

  const finishedMatches = matches.filter(isFinished);

  // Очки за матчи
  for (const m of finishedMatches) {
    for (const u of users) {
      const bet = bets[u.id]?.matches?.[m.id];
      const res = matchPoints(bet, m, cfg);
      if (!res) continue;
      const acc = byUser[u.id];
      acc.matchPts += res.total;
      acc.perMatch[m.id] = res;
      acc.perRound[m.roundKey] = (acc.perRound[m.roundKey] || 0) + res.total;
      if (res.isExact) acc.exactCount += 1;
    }
  }

  // Джекпот тура: +N лидеру(ам) полностью завершённого тура
  const rounds = {};
  for (const m of matches) {
    (rounds[m.roundKey] ||= { key: m.roundKey, total: 0, finished: 0, winners: [], leadPts: 0 }).total += 1;
    if (isFinished(m)) rounds[m.roundKey].finished += 1;
  }
  for (const key of Object.keys(rounds)) {
    const r = rounds[key];
    if (r.total === 0 || r.finished < r.total) continue; // тур ещё не доигран
    let best = -Infinity;
    for (const u of users) best = Math.max(best, byUser[u.id].perRound[key] || 0);
    if (best <= 0) continue;
    r.leadPts = best;
    for (const u of users) {
      if ((byUser[u.id].perRound[key] || 0) === best) {
        byUser[u.id].jackpotPts += cfg.roundJackpot;
        r.winners.push(u.id);
      }
    }
  }

  // Долгосрочные прогнозы (чемпион / бомбардир) — в самом конце
  if (tournamentResult && tournamentResult.finished) {
    const topSet = new Set(tournamentResult.topScorers || []);
    for (const u of users) {
      const pred = bets[u.id]?.tournament;
      if (!pred) continue;
      if (pred.champion != null && pred.champion === tournamentResult.champion) byUser[u.id].futuresPts += cfg.championBonus;
      if (pred.topScorer != null && topSet.has(pred.topScorer)) byUser[u.id].futuresPts += cfg.topScorerBonus;
    }
  }

  for (const u of users) {
    const a = byUser[u.id];
    a.total = a.matchPts + a.jackpotPts + a.futuresPts;
  }

  const table = Object.values(byUser).sort(
    (a, b) => b.total - a.total || b.exactCount - a.exactCount || a.name.localeCompare(b.name)
  );
  table.forEach((row, i) => (row.rank = i + 1));

  return { table, rounds };
}
