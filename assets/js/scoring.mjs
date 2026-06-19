// Единый модуль подсчёта очков. Импортируется И фронтендом (браузер), И GitHub Action (Node).
// Никаких внешних зависимостей и обращений к DOM/сети — только чистые функции.

/** Исход матча по счёту: 'H' — победа хозяев, 'D' — ничья, 'A' — победа гостей. */
export function outcome(home, away) {
  if (home > away) return 'H';
  if (home < away) return 'A';
  return 'D';
}

/**
 * Очки за угаданный счёт (макс scoreBlockMax).
 * bet/actual = { home, away } — целые числа.
 */
export function scorePoints(bet, actual, cfg) {
  if (bet.home === actual.home && bet.away === actual.away) return cfg.exact; // точный счёт = джекпот

  let pts = 0;
  if (outcome(bet.home, bet.away) === outcome(actual.home, actual.away)) {
    pts += cfg.outcome; // угадан исход
    if (bet.home - bet.away === actual.home - actual.away) pts += cfg.goalDiff; // + разница мячей
  }
  if (bet.home + bet.away === actual.home + actual.away) pts += cfg.totalGoals; // суммарные голы (только если счёт не угадан)

  return Math.min(pts, cfg.scoreBlockMax);
}

/** Очки за угаданного автора по его позиции. */
export function scorerValue(pos, cfg) {
  return cfg.scorerByPos?.[pos] ?? cfg.scorerDefault ?? 2;
}

/**
 * Очки за авторов голов. Цена угаданного автора зависит от его позиции
 * (нападающий/полузащитник/защитник/вратарь). posMap — { playerId(строка): позиция }.
 *
 * Одного игрока можно выбрать НЕСКОЛЬКО раз (ставка на дубль/хет-трик): каждый пик
 * приносит очки, но не больше, чем игрок реально забил голов (min(пиков, голов)).
 * Напр. выбрал игрока 3 раза, он забил 2 — зачтутся два пика, третий пустой.
 */
export function scorerPoints(betScorers, actualScorers, posMap, cfg) {
  const picks = (betScorers || []).filter((x) => x != null).map(String); // дубли НЕ убираем
  const credits = {}; // сколько голов игрока ещё можно «закрыть» пиками
  for (const id of (actualScorers || []).map(String)) credits[id] = (credits[id] || 0) + 1;
  let pts = 0;
  let correct = 0;
  const perPick = [];
  for (const id of picks) {
    const hit = (credits[id] || 0) > 0; // остался ли незачтённый гол этого игрока
    const pos = posMap ? posMap[id] : null;
    const val = hit ? scorerValue(pos, cfg) : 0;
    if (hit) {
      credits[id] -= 1;
      correct += 1;
      pts += val;
    }
    perPick.push({ playerId: id, correct: hit, pts: val, pos });
  }
  return { pts, correct, perPick };
}

/** Голы, засчитываемые автору прогноза (исключаем автоголы). */
export function realScorerIds(match) {
  return (match.scorers || []).filter((s) => s.type !== 'own').map((s) => s.playerId);
}

/**
 * Позиции для подсчёта ИМЕННО этого матча: позиция автора гола, зафиксированная по матчу
 * (match.scorers[].pos), имеет приоритет над общей картой. Так сыгранный матч держит
 * засчитанную позицию, а будущие матчи берут актуальную (официальную) из posMap.
 */
function matchPosMap(match, posMap) {
  let mp = posMap;
  for (const s of match.scorers || []) {
    if (s && s.pos && s.playerId != null) {
      if (mp === posMap) mp = { ...(posMap || {}) };
      mp[String(s.playerId)] = s.pos;
    }
  }
  return mp;
}

/** Карта playerId(строка) -> позиция, из составов (squads.json). */
export function buildPosIndex(squads) {
  const map = {};
  for (const ps of Object.values(squads || {})) for (const p of ps || []) if (p && p.id != null) map[String(p.id)] = p.pos;
  return map;
}

/**
 * Множитель сложности матча.
 * match.stage ∈ 'group'|'r16'|'qf'|'sf'|'final'|'third'
 * ranks — { [teamId]: fifaRank }. Если ранга нет — считаем команду «слабой» (большой ранг).
 * Ручное переопределение: match.multiplierOverride.
 */
export function matchMultiplier(match, ranks, cfg) {
  if (match.multiplierOverride != null) return match.multiplierOverride;
  if (match.isOpening) return cfg.opening ?? cfg.knockoutQfPlus; // матч открытия — ×2.0

  const stage = match.stage;
  if (stage === 'qf' || stage === 'sf' || stage === 'final' || stage === 'third') return cfg.knockoutQfPlus;
  if (stage === 'r16') return cfg.round16; // 1/8 финала — ×2.0

  // Групповой этап
  const big = 999;
  const rh = (ranks && ranks[match.home?.id]) ?? big;
  const ra = (ranks && ranks[match.away?.id]) ?? big;
  if (rh <= cfg.topMatchMaxRank && ra <= cfg.topMatchMaxRank) return cfg.groupTopMatch; // топ-матч группы
  if (Math.abs(rh - ra) > cfg.favoriteRankDiff) return cfg.groupFavorite; // явный фаворит
  return cfg.groupEqual; // примерно равные
}

/** Особый матч для бонуса за точный счёт (бонус отключён: exactSpecialBonus=0, список пуст). */
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
 * Счета, по которым проверяется ставка. В плей-офф к итогу (с доп. временем)
 * добавляется счёт основного времени — ставка засчитывается по лучшему из них.
 * Так и угадавший «1:1 в основное», и угадавший «2:1 итог» получают точный счёт.
 */
export function scoreCandidates(match) {
  const out = [];
  if (match.score && match.score.home != null) out.push({ score: match.score, reg: false });
  const r = match.scoreReg;
  if (r && r.home != null && (!match.score || r.home !== match.score.home || r.away !== match.score.away)) {
    out.push({ score: r, reg: true });
  }
  return out;
}

/** Лучший кандидат счёта по очкам за счёт. */
function bestCandidate(bet, match, cfg) {
  const cands = scoreCandidates(match);
  let best = { sp: -1, c: cands[0] || { score: match.score, reg: false } };
  for (const c of cands) {
    const sp = scorePoints(bet.score, c.score, cfg);
    if (sp > best.sp) best = { sp, c };
  }
  const isExactAny = cands.some((c) => bet.score.home === c.score.home && bet.score.away === c.score.away);
  return { ...best, isExactAny };
}

/**
 * Полный расчёт очков пользователя за один матч.
 * Возвращает разбивку и итог (с учётом множителя; спец-бонус за точный счёт отключён).
 * Если результата нет или ставки нет — возвращает null.
 */
export function matchPoints(bet, match, cfg, posMap) {
  if (!bet || !isFinished(match)) return null;

  const best = bestCandidate(bet, match, cfg);
  const sp = best.sp;
  const actualScorers = realScorerIds(match);
  const { pts: scp, correct } = scorerPoints(bet.scorers, actualScorers, matchPosMap(match, posMap), cfg);

  const base = sp + scp;
  const multiplier = match.multiplier ?? 1;
  let total = Math.round(base * multiplier);

  const isExact = best.isExactAny;
  const special = isExact && isSpecialBonusMatch(match, cfg) ? cfg.exactSpecialBonus : 0;
  total += special;

  return { scorePts: sp, scorerPts: scp, correctScorers: correct, base, multiplier, special, total, isExact, usedReg: best.c.reg };
}

/**
 * Подробный разбор начисленных очков за матч (для объяснения участнику).
 * Возвращает структурированные позиции; названия игроков подставляет фронтенд.
 */
export function explainMatch(bet, match, cfg, posMap) {
  if (!bet || !isFinished(match)) return null;
  const best = bestCandidate(bet, match, cfg);
  const actual = best.c.score;
  const regUsed = best.c.reg;
  const isExact = bet.score.home === actual.home && bet.score.away === actual.away;

  const scoreItems = [];
  let scorePts;
  if (isExact) {
    scorePts = cfg.exact;
    scoreItems.push({ label: `Точный счёт ${actual.home}:${actual.away}`, pts: cfg.exact });
  } else {
    let p = 0;
    if (outcome(bet.score.home, bet.score.away) === outcome(actual.home, actual.away)) {
      scoreItems.push({ label: 'Угадан исход', pts: cfg.outcome });
      p += cfg.outcome;
      if (bet.score.home - bet.score.away === actual.home - actual.away) {
        scoreItems.push({ label: 'Угадана разница мячей', pts: cfg.goalDiff });
        p += cfg.goalDiff;
      }
    }
    if (bet.score.home + bet.score.away === actual.home + actual.away) {
      scoreItems.push({ label: `Сумма голов (${actual.home + actual.away})`, pts: cfg.totalGoals });
      p += cfg.totalGoals;
    }
    if (!scoreItems.length) scoreItems.push({ label: 'Счёт не угадан', pts: 0 });
    scorePts = Math.min(p, cfg.scoreBlockMax);
    if (p > cfg.scoreBlockMax) scoreItems.push({ label: `Ограничение максимумом за счёт`, pts: cfg.scoreBlockMax - p });
  }

  const actualScorers = realScorerIds(match);
  const { perPick, pts: scorerPts } = scorerPoints(bet.scorers, actualScorers, matchPosMap(match, posMap), cfg);
  const scorerItems = perPick; // { playerId, correct, pts, pos }

  const base = scorePts + scorerPts;
  const multiplier = match.multiplier ?? 1;
  const afterMult = Math.round(base * multiplier);
  const special = best.isExactAny && isSpecialBonusMatch(match, cfg) ? cfg.exactSpecialBonus : 0;

  return { isExact: best.isExactAny, regUsed, actual, scoreItems, scorerItems, scorePts, scorerPts, base, multiplier, afterMult, special, total: afterMult + special };
}

/** Очки за точный счёт здесь (с учётом коэффициента и спец-бонуса) — для подсказки. */
export function maxPotential(match, cfg) {
  const multiplier = match.multiplier ?? 1;
  let total = Math.round(cfg.exact * multiplier);
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
export function standings(users, matches, bets, tournamentResult, cfg, posMap) {
  const byUser = {};
  for (const u of users) {
    byUser[u.id] = {
      id: u.id,
      name: u.name,
      matchPts: 0,
      futuresPts: 0,
      total: 0,
      exactCount: 0,
      perMatch: {}, // matchId -> result разбивки
    };
  }

  const finishedMatches = matches.filter(isFinished);

  // Очки за матчи
  for (const m of finishedMatches) {
    for (const u of users) {
      const bet = bets[u.id]?.matches?.[m.id];
      const res = matchPoints(bet, m, cfg, posMap);
      if (!res) continue;
      const acc = byUser[u.id];
      acc.matchPts += res.total;
      acc.perMatch[m.id] = res;
      if (res.isExact) acc.exactCount += 1;
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
    a.total = a.matchPts + a.futuresPts;
  }

  const table = Object.values(byUser).sort(
    (a, b) => b.total - a.total || b.exactCount - a.exactCount || a.name.localeCompare(b.name)
  );
  table.forEach((row, i) => (row.rank = i + 1));

  return { table, rounds: {} };
}
