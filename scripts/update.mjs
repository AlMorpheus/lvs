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

// ---------- раскрытие ставок начавшихся матчей ----------
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
    const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
    const cipher = sodium.crypto_secretbox_easy(sodium.from_string(JSON.stringify(payload)), nonce, SK);
    writeJSON(`data/revealed/${m.id}.json`, { v: 1, nonce: toB64(nonce), ct: toB64(cipher) });
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

  // конфиг сохраняем всегда: дата матча открытия, метки времени
  const opening = matches.find((m) => m.isOpening);
  if (opening) app.tournament.openingKickoff = opening.date;
  if (doDailyRefresh) app.tournament.squadsRefreshedOn = today;
  app.tournament.lastUpdated = new Date().toISOString();
  writeJSON('config/app.json', app);

  const bets = readAllBets(matches);
  writeReveals(matches, bets);

  const tr = await tournamentResult(matches);
  const posMap = buildPosIndex(squads);
  const result = computeStandings(usersCfg.map((u) => ({ id: u.id, name: u.name })), matches, bets, tr, cfg, posMap);
  writeJSON('data/standings.json', { ...result, tournamentResult: tr, updatedAt: new Date().toISOString() });

  console.log(`✅ Обновлено. Матчей: ${matches.length}. Запросов к API: ${apiCalls}.`);
}

main().catch((e) => {
  console.error('Сбой update.mjs:', e);
  process.exit(1);
});
