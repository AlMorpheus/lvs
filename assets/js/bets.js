// Высокоуровневые операции со ставками: шифрование + запись/чтение в репо.
import { encryptBet, decryptOwnBet, decryptRevealed } from './crypto.js?v=17';
import { putFile, getFile, getDir } from './github.js?v=17';

const betPath = (userId, matchId) => `data/bets/${userId}/${matchId}.json`;
const tournamentPath = (userId) => `data/bets/${userId}/_tournament.json`;

/** Сохранить ставку на матч. betObj = { score:{home,away}, scorers:[id,id,id] }. */
export async function submitBet(session, app, matchId, betObj) {
  const file = encryptBet({ ...betObj, submittedAt: new Date().toISOString() }, session.userKey, app.actionPublicKey);
  const path = betPath(session.userId, matchId);
  await putFile(app.repo, path, JSON.stringify(file, null, 2), `bet: ${session.userId} → ${matchId}`, session.token);
}

// Кэш прогноза в памяти: undefined — ещё не знаем, null — нет, объект — прогноз.
// Нужен, потому что GitHub Contents API сразу после записи может вернуть старое.
let tournamentCache;

/** Сохранить долгосрочный прогноз. predObj = { champion: teamId, topScorer: playerId }. */
export async function submitTournament(session, app, predObj) {
  const file = encryptBet({ ...predObj, submittedAt: new Date().toISOString() }, session.userKey, app.actionPublicKey);
  const path = tournamentPath(session.userId);
  await putFile(app.repo, path, JSON.stringify(file, null, 2), `tournament pick: ${session.userId}`, session.token);
  tournamentCache = { champion: predObj.champion ?? null, topScorer: predObj.topScorer ?? null };
}

/** Множество matchId, на которые у меня уже есть ставка, + флаг наличия прогноза турнира. */
export async function listOwnBets(session, app) {
  const files = await getDir(app.repo, `data/bets/${session.userId}`, session.token);
  const matchIds = new Set();
  let hasTournament = false;
  for (const f of files) {
    if (!f.name.endsWith('.json')) continue;
    const id = f.name.replace(/\.json$/, '');
    if (id === '_tournament') hasTournament = true;
    else matchIds.add(id);
  }
  return { matchIds, hasTournament };
}

/** Загрузить собственную ставку на матч (или null). */
export async function loadOwnBet(session, app, matchId) {
  const f = await getFile(app.repo, betPath(session.userId, matchId), session.token);
  if (!f) return null;
  return decryptOwnBet(JSON.parse(f.text), session.userKey);
}

/** Загрузить собственный долгосрочный прогноз (или null). Кэш в памяти важнее GitHub. */
export async function loadOwnTournament(session, app) {
  if (tournamentCache !== undefined) return tournamentCache;
  const f = await getFile(app.repo, tournamentPath(session.userId), session.token);
  tournamentCache = f ? decryptOwnBet(JSON.parse(f.text), session.userKey) : null;
  return tournamentCache;
}

// ---------- Объявления организатора ----------
const ANN_PATH = 'data/announcements.json';
let annCache; // undefined — не загружали; объект — данные

/** Загрузить объявления { items:[{id,text,createdAt}] }. Через GitHub (свежо для всех). */
export async function loadAnnouncements(session, app) {
  if (annCache !== undefined) return annCache;
  try {
    const f = await getFile(app.repo, ANN_PATH, session.token);
    annCache = f ? JSON.parse(f.text) : { items: [] };
  } catch {
    annCache = { items: [] };
  }
  if (!annCache.items) annCache.items = [];
  return annCache;
}

/** Сохранить объявления (только админ). Обновляет кэш сразу. */
export async function saveAnnouncements(session, app, items) {
  const data = { items };
  await putFile(app.repo, ANN_PATH, JSON.stringify(data, null, 2), `announcement by ${session.userId}`, session.token);
  annCache = data;
}

/** Раскрытые ставки матча (после свистка): { [userId]: bet } или null. */
export async function loadRevealed(session, matchId) {
  const res = await fetch(`data/revealed/${matchId}.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) return null;
  const file = await res.json();
  try {
    return decryptRevealed(file, session.sk);
  } catch {
    return null;
  }
}
