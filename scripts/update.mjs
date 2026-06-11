// Задача GitHub Action: тянем данные с API-Football, расшифровываем ставки,
// считаем очки, раскрываем ставки начавшихся матчей, пишем JSON в data/.
//
// Секреты (env): API_FOOTBALL_KEY, ACTION_PRIVATE_KEY (b64), SHARED_KEY (b64).
// Коммит/пуш делает workflow после запуска этого скрипта.

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { standings as computeStandings, matchMultiplier, buildPosIndex } from '../assets/js/scoring.mjs';

// ESM-сборка libsodium-sumo в npm битая — грузим CJS-вариант.
const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers-sumo');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const P = (...x) => join(ROOT, ...x);

await _sodium.ready;
const sodium = _sodium;
const B64 = sodium.base64_variants.ORIGINAL;
const fromB64 = (s) => sodium.from_base64(s, B64);
const toB64 = (b) => sodium.to_base64(b, B64);

const API_KEY = process.env.API_FOOTBALL_KEY;
const ACTION_PRIV = process.env.ACTION_PRIVATE_KEY;
const SHARED = process.env.SHARED_KEY;

const readJSON = (rel, fb) => (existsSync(P(rel)) ? JSON.parse(readFileSync(P(rel), 'utf8')) : fb);
const writeJSON = (rel, obj) => writeFileSync(P(rel), JSON.stringify(obj, null, 2) + '\n');

const app = readJSON('config/app.json', {});
const usersCfg = readJSON('config/users.json', { users: [] }).users;
const fifa = readJSON('data/fifa-ranking.json', { teams: {} });
const overrides = readJSON('data/overrides.json', { matches: {} });
const cfg = app.scoring;

// ---------- накопительный справочник игроков ----------
// id -> { name, pos, team }. Имена/позиции НЕ теряются, когда заявку (lineup) усекают
// до матчевой — иначе ранее выбранный игрок перестаёт находиться по id («—» без флага).
const playerDir = readJSON('data/players.json', {});
function recordPlayer(p, teamId) {
  if (p?.id == null) return;
  const id = String(p.id);
  const cur = playerDir[id] || {};
  playerDir[id] = {
    name: p.name || cur.name || null,
    pos: p.pos || cur.pos || null,
    team: teamId != null ? String(teamId) : cur.team || null,
  };
}

// ---------- API-Football ----------
const API_BASE = 'https://v3.football.api-sports.io';
let apiCalls = 0;
async function api(path, params = {}) {
  if (!API_KEY) throw new Error('Нет API_FOOTBALL_KEY');
  const qs = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
  apiCalls++;
  const res = await fetch(url, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API ${path} -> ${res.status}`);
  const data = await res.json();
  if (data.errors && Object.keys(data.errors).length) console.warn('API errors:', JSON.stringify(data.errors));
  return data.response || [];
}

// ---------- стадия / тур из строки round ----------
function classifyRound(round = '') {
  const r = round.toLowerCase();
  const md = (round.match(/-\s*(\d+)/) || [])[1];
  if (r.includes('group') || r.includes('groups')) return { stage: 'group', roundKey: `group-${md || 1}` };
  if (r.includes('16') || r.includes('round of 16')) return { stage: 'r16', roundKey: 'r16' };
  if (r.includes('quarter')) return { stage: 'qf', roundKey: 'qf' };
  if (r.includes('semi')) return { stage: 'sf', roundKey: 'sf' };
  if (r.includes('3rd') || r.includes('third')) return { stage: 'third', roundKey: 'third' };
  if (r.includes('final')) return { stage: 'final', roundKey: 'final' };
  return { stage: 'group', roundKey: `group-${md || 1}` };
}

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const norm = (s) => (s || '').toLowerCase().trim();

// Момент завершения матча: фиксируем при первом переходе в «завершён» и больше не трогаем.
// По нему фронт ещё час держит матч наверху (успеть посмотреть начисленные очки), потом — в архив.
// Если матч уже шёл задолго до этого запуска (>4 ч после свистка) — он завершился не «только что»,
// ставим метку в прошлое (по свистку), чтобы старые матчи не всплывали наверх.
function finishedAtFor(finished, prevM, dateIso) {
  if (!finished) return null;
  if (prevM?.finishedAt) return prevM.finishedAt;
  const ko = new Date(dateIso).getTime();
  return Date.now() - ko > 4 * 3600 * 1000 ? dateIso : new Date().toISOString();
}

function rankOf(teamName) {
  const t = fifa.teams || {};
  if (t[teamName] != null) return t[teamName];
  const key = Object.keys(t).find((k) => norm(k) === norm(teamName));
  return key ? t[key] : null;
}

// ---------- сбор матчей ----------
async function buildMatches() {
  const prev = readJSON('data/matches.json', []);
  const prevById = new Map((Array.isArray(prev) ? prev : []).map((m) => [String(m.id), m]));

  let fixtures = [];
  try {
    fixtures = await api('/fixtures', { league: app.api.leagueId, season: app.api.season });
  } catch (e) {
    console.error('Не удалось получить расписание, оставляю прежнее:', e.message);
    return Array.isArray(prev) ? prev : [];
  }

  const ranksById = {}; // teamId -> rank (для множителя)
  const matches = [];
  for (const f of fixtures) {
    const { stage, roundKey } = classifyRound(f.league?.round);
    const home = { id: f.teams?.home?.id, name: f.teams?.home?.name, flag: f.teams?.home?.logo };
    const away = { id: f.teams?.away?.id, name: f.teams?.away?.name, flag: f.teams?.away?.logo };
    if (home.id != null) ranksById[home.id] = rankOf(home.name);
    if (away.id != null) ranksById[away.id] = rankOf(away.name);

    const finished = FINISHED.has(f.fixture?.status?.short);
    const prevM = prevById.get(String(f.fixture?.id));
    const m = {
      id: String(f.fixture?.id),
      date: f.fixture?.date,
      status: f.fixture?.status?.short,
      round: f.league?.round,
      roundKey,
      stage,
      home,
      away,
      score: f.goals?.home != null ? { home: f.goals.home, away: f.goals.away } : null,
      // счёт основного времени (для плей-офф: 1:1 в осн. + 2:1 итог — оба «точный счёт»)
      scoreReg: f.score?.fulltime?.home != null ? { home: f.score.fulltime.home, away: f.score.fulltime.away } : null,
      finished,
      finishedAt: finishedAtFor(finished, prevM, f.fixture?.date),
      scorers: prevM?.scorers || [],
      multiplierOverride: overrides.matches?.[String(f.fixture?.id)]?.multiplier ?? null,
    };
    matches.push(m);
  }

  // матч открытия — самый ранний
  matches.sort((a, b) => new Date(a.date) - new Date(b.date));
  if (matches[0]) matches[0].isOpening = true;

  // множители
  for (const m of matches) m.multiplier = matchMultiplier(m, ranksById, app.multipliers);

  // extra-матчи (товарищеские/тест) — ОДИН батч-запрос, НЕ влияют на «матч открытия»
  const extra = overrides.extraFixtures || [];
  if (extra.length) {
    const multById = {};
    extra.forEach((e) => (multById[String(e.id)] = e.multiplier ?? 1));
    let resp = [];
    try {
      resp = await api('/fixtures', { ids: extra.map((e) => e.id).join('-') });
    } catch (e) {
      console.warn('extra fixtures batch:', e.message);
    }
    const byId = {};
    for (const f of resp) byId[String(f.fixture?.id)] = f;
    for (const e of extra) {
      const id = String(e.id);
      const f = byId[id];
      if (f) {
        const prevM = prevById.get(id);
        matches.push({
          id,
          date: f.fixture?.date,
          status: f.fixture?.status?.short,
          round: f.league?.name || 'Товарищеский матч',
          roundKey: 'test',
          stage: 'friendly',
          isExtra: true,
          home: { id: f.teams?.home?.id, name: f.teams?.home?.name, flag: f.teams?.home?.logo },
          away: { id: f.teams?.away?.id, name: f.teams?.away?.name, flag: f.teams?.away?.logo },
          score: f.goals?.home != null ? { home: f.goals.home, away: f.goals.away } : null,
          scoreReg: f.score?.fulltime?.home != null ? { home: f.score.fulltime.home, away: f.score.fulltime.away } : null,
          finished: FINISHED.has(f.fixture?.status?.short),
          finishedAt: finishedAtFor(FINISHED.has(f.fixture?.status?.short), prevM, f.fixture?.date),
          scorers: prevM?.scorers || [],
          multiplier: multById[id],
        });
      } else if (prevById.get(id)) {
        matches.push(prevById.get(id)); // API не отдал — берём прошлую версию, чтобы матч не исчез
      }
    }
  }

  // авторы голов — только для завершённых без кэша
  for (const m of matches) {
    if (m.finished && (!m.scorers || !m.scorers.length)) {
      try {
        const events = await api('/fixtures/events', { fixture: m.id });
        m.scorers = events
          .filter((e) => norm(e.type) === 'goal' && norm(e.detail) !== 'missed penalty')
          .map((e) => ({
            playerId: e.player?.id,
            name: e.player?.name,
            teamId: e.team?.id,
            minute: e.time?.elapsed,
            type: norm(e.detail) === 'own goal' ? 'own' : 'normal',
          }));
      } catch (e) {
        console.warn(`Не удалось получить события матча ${m.id}:`, e.message);
      }
    }
  }
  return matches;
}

// ---------- составы ----------
// Кэшируем составы; для команд ближайших матчей обновляем заявку (травмы и т.п.).
async function fetchSquad(tid) {
  const resp = await api('/players/squads', { team: tid });
  const players = resp[0]?.players || [];
  return players.map((p) => ({ id: p.id, name: p.name, pos: p.position, number: p.number }));
}

async function updateSquads(matches, doDailyRefresh) {
  const squads = readJSON('data/squads.json', {});
  const now = Date.now();
  const soon = now + 36 * 3600 * 1000;

  const allTeams = new Set();
  const priority = new Set(); // команды, играющие в ближайшие ~1.5 суток
  for (const m of matches) {
    const ko = new Date(m.date).getTime();
    for (const t of [m.home, m.away]) {
      if (t?.id == null) continue;
      allTeams.add(String(t.id));
      if (ko >= now - 3 * 3600 * 1000 && ko <= soon) priority.add(String(t.id));
    }
  }

  const MAX = 14; // бережём дневную квоту API
  let fetched = 0;

  // 1) раз в день обновляем заявки команд ближайших матчей (травмы и т.п.)
  if (doDailyRefresh) {
    for (const tid of priority) {
      if (fetched >= MAX) break;
      try {
        const players = await fetchSquad(tid);
        if (players.length) { squads[tid] = players; fetched++; }
      } catch (e) {
        console.warn(`Состав команды ${tid} не обновлён:`, e.message);
      }
    }
  }
  // 2) добираем отсутствующие
  for (const tid of allTeams) {
    if (fetched >= MAX) break;
    if (squads[tid]?.length) continue;
    try {
      squads[tid] = await fetchSquad(tid);
      fetched++;
    } catch (e) {
      console.warn(`Состав команды ${tid} не получен:`, e.message);
    }
  }
  return squads;
}

// Точный состав на матч из заявки (lineups): для игр, которые вот-вот начнутся/идут.
// Заменяет общий (часто устаревший для сборных) состав реальной заявкой на игру.
const LINEUP_POS = { G: 'Goalkeeper', D: 'Defender', M: 'Midfielder', F: 'Attacker' };
async function applyLineups(matches, squads) {
  const now = Date.now();
  let used = 0;
  const MAX = 8;
  for (const m of matches) {
    if (m.finished) continue;
    const ko = new Date(m.date).getTime();
    if (ko > now + 120 * 60 * 1000 || ko < now - 4 * 3600 * 1000) continue; // окно: за 2 ч до и до +4 ч после
    if (used >= MAX) break;
    try {
      const resp = await api('/fixtures/lineups', { fixture: m.id });
      if (!resp.length) continue;
      for (const t of resp) {
        const tid = String(t.team?.id);
        const list = [...(t.startXI || []), ...(t.substitutes || [])]
          .map((e) => ({ id: e.player?.id, name: e.player?.name, number: e.player?.number, pos: LINEUP_POS[e.player?.pos] || null }))
          .filter((p) => p.id != null);
        if (list.length) squads[tid] = list;
      }
      used++;
    } catch (e) {
      console.warn('lineups', m.id, e.message);
    }
  }
}

// ---------- прогнозы betanalyse.pro (внешний AI-источник) ----------
// Тянем публичную статику соседнего проекта (lvs-fixtures.json) и оставляем по матчу
// только то, что нужно: прогноз счёта и трёх авторов голов. Матчи совпадают по id (API-Football).
const POS_RU_ABBR = { 'нападающий': 'нап', 'полузащитник': 'пз', 'защитник': 'защ', 'вратарь': 'вр' };
const BETANALYSE_URL = 'https://erastfandorin2004.github.io/betprediction/data/lvs-fixtures.json';
async function fetchExpertPredictions() {
  let days;
  try {
    const res = await fetch(BETANALYSE_URL);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    days = await res.json();
  } catch (e) {
    console.warn('Прогнозы betanalyse.pro не получены:', e.message);
    return null; // не трогаем прежний файл
  }
  const out = {};
  for (const d of days || []) {
    for (const f of d.fixtures || []) {
      const p = f?.prediction;
      if (!p || !p.score || p.score.home == null) continue;
      out[String(f.id)] = {
        score: { home: p.score.home, away: p.score.away },
        scorers: (p.scorers || []).slice(0, 3).map((s) => ({
          name: s.name,
          team: s.team === 'away' ? 'away' : 'home',
          pos: POS_RU_ABBR[(s.position || '').toLowerCase()] || null,
        })),
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

// ---------- виртуальный игрок betanalyse.pro ----------
// Полноценный участник: на свистке фиксируем его ПОСЛЕДНИЙ прогноз как ставку и считаем очки.
const AI_ID = 'betanalyse';
const AI_NAME = '🤖 Шеф';

const _norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const _lastName = (s) => _norm(s).split(/\s+/).pop().replace(/[^a-zа-яё]/g, '');

// Имя автора из прогноза -> id игрока по составу нужной команды (для подсчёта очков как у людей).
function resolveScorerId(predScorer, m, squads) {
  const team = predScorer.team === 'away' ? m.away : m.home;
  const squad = squads[team?.id] || squads[String(team?.id)] || [];
  if (!squad.length) return null;
  const full = _norm(predScorer.name);
  const last = _lastName(predScorer.name);
  const hit = squad.find((p) => _norm(p.name) === full) || squad.find((p) => _lastName(p.name) === last);
  return hit ? String(hit.id) : null;
}

// Фиксация ставки ИИ: на матч, который УЖЕ начался, берём текущий (=последний, ~за час до игры
// актуализированный) прогноз и замораживаем его. До свистка не трогаем; зафиксированное — навсегда.
function lockAiBets(matches, aiPred, squads) {
  const store = readJSON('data/ai-bets.json', {});
  const now = Date.now();
  let changed = false;
  for (const m of matches) {
    if (now < new Date(m.date).getTime()) continue; // ещё не начался — даём прогнозу актуализироваться
    if (store[m.id]) continue;                        // уже зафиксировано на момент свистка
    const pred = aiPred?.[m.id];
    if (!pred || !pred.score) continue;               // нет прогноза — зафиксируем на следующем прогоне
    const scorers = (pred.scorers || []).map((s) => resolveScorerId(s, m, squads)).filter(Boolean);
    store[m.id] = { score: { home: pred.score.home, away: pred.score.away }, scorers, lockedAt: new Date().toISOString() };
    changed = true;
    console.log(`🤖 betanalyse.pro: зафиксирована ставка на ${m.id} ${pred.score.home}:${pred.score.away} (авторов ${scorers.length})`);
  }
  if (changed) writeJSON('data/ai-bets.json', store);
  return store;
}

// ---------- результат турнира (чемпион + бомбардиры) ----------
async function tournamentResult(matches) {
  const final = matches.find((m) => m.roundKey === 'final');
  if (!final || !final.finished || !final.score) return null;
  const champion = final.score.home > final.score.away ? final.home?.id : final.away?.id;
  let topScorers = [];
  try {
    const ts = await api('/players/topscorers', { league: app.api.leagueId, season: app.api.season });
    const goalsOf = (x) => x.statistics?.[0]?.goals?.total || 0;
    const max = Math.max(0, ...ts.map(goalsOf));
    topScorers = ts.filter((x) => goalsOf(x) === max && max > 0).map((x) => x.player?.id);
  } catch (e) {
    console.warn('Топ-бомбардиры не получены:', e.message);
  }
  return { finished: true, champion, topScorers };
}

// ---------- расшифровка ставок ----------
function commitTime(relPath) {
  try {
    const out = execSync(`git log -1 --format=%cI -- "${relPath}"`, { cwd: ROOT }).toString().trim();
    return out || null;
  } catch {
    return null;
  }
}

function decryptBetFile(file) {
  const botPub = fromB64(app.actionPublicKey);
  const botPriv = fromB64(ACTION_PRIV);
  const betKey = sodium.crypto_box_seal_open(fromB64(file.wrapAction), botPub, botPriv);
  if (!betKey) throw new Error('seal_open failed');
  const plain = sodium.crypto_secretbox_open_easy(fromB64(file.ct), fromB64(file.nonce), betKey);
  if (!plain) throw new Error('secretbox_open failed');
  return JSON.parse(sodium.to_string(plain));
}

function readAllBets(matches) {
  const kickoffById = new Map(matches.map((m) => [m.id, new Date(m.date).getTime()]));
  const openingKickoff = matches.find((m) => m.isOpening)?.date;
  const openingMs = openingKickoff ? new Date(openingKickoff).getTime() : Infinity;

  const bets = {};
  for (const u of usersCfg) {
    bets[u.id] = { matches: {}, tournament: null };
    const dir = P('data/bets', u.id);
    if (!existsSync(dir)) continue;
    for (const fname of readdirSync(dir)) {
      if (!fname.endsWith('.json')) continue;
      const rel = `data/bets/${u.id}/${fname}`;
      let parsed;
      try {
        parsed = decryptBetFile(JSON.parse(readFileSync(P(rel), 'utf8')));
      } catch (e) {
        console.warn(`Не расшифровал ${rel}:`, e.message);
        continue;
      }
      const ct = commitTime(rel);
      const ctMs = ct ? new Date(ct).getTime() : (parsed.submittedAt ? new Date(parsed.submittedAt).getTime() : 0);

      if (fname === '_tournament.json') {
        if (ctMs <= openingMs) bets[u.id].tournament = { champion: parsed.champion ?? null, topScorer: parsed.topScorer ?? null };
        else console.warn(`Прогноз турнира ${u.id} закоммичен после свистка — игнор`);
        continue;
      }
      const matchId = fname.replace(/\.json$/, '');
      const ko = kickoffById.get(matchId);
      if (ko == null) continue;
      if (ctMs > ko) {
        console.warn(`Ставка ${rel} закоммичена после свистка — игнор`);
        continue;
      }
      bets[u.id].matches[matchId] = { score: parsed.score, scorers: parsed.scorers || [], submittedAt: parsed.submittedAt };
    }
  }
  return bets;
}

// Добираем профили выбранных игроков, которых нет в справочнике (выпали из заявки/состава),
// чтобы их имя и позиция всегда отображались и учитывались в очках. Каждый — один раз.
async function recoverPickedPlayers(bets) {
  const ids = new Set();
  for (const u of Object.values(bets)) for (const mb of Object.values(u.matches || {})) for (const id of mb.scorers || []) ids.add(String(id));
  let used = 0;
  const MAX = 25; // бережём квоту: профиль тянем единожды на игрока
  for (const id of ids) {
    if (playerDir[id]?.name) continue;
    if (used >= MAX) break;
    try {
      const resp = await api('/players/profiles', { player: id });
      const pl = resp[0]?.player;
      if (pl) {
        recordPlayer({ id, name: pl.name, pos: pl.position }, null);
        used++;
      }
    } catch (e) {
      console.warn('профиль игрока', id, e.message);
    }
  }
}

// ---------- раскрытие ставок начавшихся матчей ----------
// sig — необратимый хэш содержимого (не раскрывает ставки), чтобы не перезаписывать файл зря.
function payloadSig(payload) {
  return toB64(sodium.crypto_generichash(16, sodium.from_string(JSON.stringify(payload))));
}
function writeReveals(matches, bets) {
  const SK = fromB64(SHARED);
  const dir = P('data/revealed');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const now = Date.now();
  for (const m of matches) {
    if (now < new Date(m.date).getTime()) continue; // ещё не начался
    const payload = {};
    for (const u of usersCfg) {
      const b = bets[u.id]?.matches?.[m.id];
      if (b) payload[u.id] = { score: b.score, scorers: b.scorers, submittedAt: b.submittedAt };
    }
    const aib = bets[AI_ID]?.matches?.[m.id]; // ставка виртуального игрока betanalyse.pro
    if (aib) payload[AI_ID] = { score: aib.score, scorers: aib.scorers, submittedAt: aib.submittedAt };
    const sig = payloadSig(payload);
    const rel = `data/revealed/${m.id}.json`;
    if (existsSync(P(rel))) {
      try {
        if (JSON.parse(readFileSync(P(rel), 'utf8')).sig === sig) continue; // не изменилось — не перезаписываем
      } catch {}
    }
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(sodium.from_string(JSON.stringify(payload)), nonce, SK);
    writeJSON(rel, { v: 1, sig, nonce: toB64(nonce), ct: toB64(cipher) });
  }
}

// ---------- main ----------
async function main() {
  const matches = await buildMatches();
  writeJSON('data/matches.json', matches);

  // составы освежаем не чаще раза в день (травмы), чтобы частый запуск не жёг квоту API
  const today = new Date().toISOString().slice(0, 10);
  app.tournament = app.tournament || {};
  const doDailyRefresh = app.tournament.squadsRefreshedOn !== today;
  const squads = await updateSquads(matches, doDailyRefresh);
  await applyLineups(matches, squads); // точная заявка для ближайших/идущих матчей
  writeJSON('data/squads.json', squads);

  // пополняем накопительный справочник игроков из составов и авторов голов
  for (const [tid, arr] of Object.entries(squads)) for (const p of arr || []) recordPlayer(p, tid);
  for (const m of matches) for (const s of m.scorers || []) recordPlayer({ id: s.playerId, name: s.name }, null);

  // конфиг — только при реальных изменениях (чтобы частый цикл не плодил коммиты)
  const opening = matches.find((m) => m.isOpening);
  let appChanged = false;
  if (opening && app.tournament.openingKickoff !== opening.date) { app.tournament.openingKickoff = opening.date; appChanged = true; }
  if (doDailyRefresh) { app.tournament.squadsRefreshedOn = today; appChanged = true; }
  if (appChanged) { app.tournament.lastUpdated = new Date().toISOString(); writeJSON('config/app.json', app); }

  const bets = readAllBets(matches);

  // betanalyse.pro: прогноз НЕ публикуем (ставка Шефа скрыта до свистка, как у участников).
  // Свежего запроса достаточно для фиксации ставки на старте матча.
  const aiPred = (await fetchExpertPredictions()) || {};
  const aiBets = lockAiBets(matches, aiPred, squads);
  bets[AI_ID] = {
    matches: Object.fromEntries(Object.entries(aiBets).map(([id, b]) => [id, { score: b.score, scorers: b.scorers, submittedAt: b.lockedAt }])),
    tournament: overrides.aiTournament || null, // прогноз ИИ на чемпиона/бомбардира (правка организатора)
  };

  await recoverPickedPlayers(bets); // имена/позиции выбранных авторов (в т.ч. у ИИ)
  writeReveals(matches, bets);      // раскрытие включает ставку betanalyse.pro

  // справочник игроков пишем только при изменении
  const prevDir = readJSON('data/players.json', null);
  if (JSON.stringify(prevDir) !== JSON.stringify(playerDir)) writeJSON('data/players.json', playerDir);

  const tr = await tournamentResult(matches);
  const posMap = buildPosIndex(squads);
  // позиции из справочника — на случай игроков, отсутствующих в текущем составе
  for (const [id, p] of Object.entries(playerDir)) if (p.pos && posMap[id] == null) posMap[id] = p.pos;
  const usersForStandings = [...usersCfg.map((u) => ({ id: u.id, name: u.name })), { id: AI_ID, name: AI_NAME }];
  const result = computeStandings(usersForStandings, matches, bets, tr, cfg, posMap);

  // Прогнозы (чемпион/бомбардир) сразу публикуем в таблицу — видно, кто за кого болеет.
  for (const row of result.table) {
    const pick = bets[row.id]?.tournament;
    if (!pick) continue;
    if (pick.champion != null) row.champion = pick.champion;
    if (pick.topScorer != null) row.topScorer = pick.topScorer;
  }

  // таблицу пишем только если содержимое изменилось (без учёта метки времени)
  const prev = readJSON('data/standings.json', null);
  const same = prev && JSON.stringify([prev.table, prev.rounds, prev.tournamentResult]) === JSON.stringify([result.table, result.rounds, tr]);
  if (!same) writeJSON('data/standings.json', { ...result, tournamentResult: tr, updatedAt: new Date().toISOString() });

  console.log(`✅ Обновлено. Матчей: ${matches.length}. Запросов к API: ${apiCalls}.`);
}

main().catch((e) => {
  console.error('Сбой update.mjs:', e);
  process.exit(1);
});
