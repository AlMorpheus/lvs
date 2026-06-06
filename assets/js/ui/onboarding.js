// Онбординг: прогноз чемпиона и лучшего бомбардира турнира (большие бонусы).
import { h, clear, toast } from './components.js';
import { submitTournament, loadOwnTournament } from '../bets.js';

let shownThisSession = false;

const normLast = (name) =>
  (name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
const normTeam = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function uniqueTeams(S) {
  const map = new Map();
  for (const m of S.matches) {
    for (const t of [m.home, m.away]) if (t?.id != null && !map.has(String(t.id))) map.set(String(t.id), t);
  }
  return [...map.values()];
}

// Команды: сначала фавориты (по коэффициентам), затем остальные по алфавиту.
function orderedTeams(S) {
  const teams = uniqueTeams(S);
  const byName = new Map(teams.map((t) => [t.name, t]));
  const used = new Set();
  const fav = [];
  for (const n of S.favTeams?.order || []) {
    const t = byName.get(n);
    if (t && !used.has(String(t.id))) {
      fav.push(t);
      used.add(String(t.id));
    }
  }
  const rest = teams.filter((t) => !used.has(String(t.id))).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return { fav, rest };
}

function rawPlayers(S) {
  const teamName = {};
  for (const t of uniqueTeams(S)) teamName[String(t.id)] = t.name;
  const out = [];
  for (const [tid, players] of Object.entries(S.squads || {})) {
    for (const p of players || []) out.push({ id: String(p.id), name: p.name, team: teamName[String(tid)] || '' });
  }
  return out;
}

// Бомбардиры: сначала фавориты (сопоставление по фамилии+команде), затем по командам и алфавиту.
function orderedPlayers(S) {
  const players = rawPlayers(S);
  const used = new Set();
  const fav = [];
  for (const f of S.favScorers?.order || []) {
    const fl = normLast(f.name);
    const ft = normTeam(f.team);
    const cand =
      players.find((p) => !used.has(p.id) && normLast(p.name) === fl && normTeam(p.team) === ft) ||
      players.find((p) => !used.has(p.id) && normLast(p.name) === fl);
    if (cand) {
      fav.push(cand);
      used.add(cand.id);
    }
  }
  const rest = players
    .filter((p) => !used.has(p.id))
    .sort((a, b) => (a.team || '').localeCompare(b.team || '') || a.name.localeCompare(b.name));
  return [...fav, ...rest];
}

function openingLocked(S) {
  const k = S.app.tournament?.openingKickoff;
  return k ? Date.now() >= new Date(k).getTime() : false;
}

function buildOverlay(ctx, existing) {
  const S = ctx.S;
  const { fav, rest } = orderedTeams(S);
  const players = orderedPlayers(S);
  const sc = S.app.scoring;

  const champOpt = (t) => h('option', { value: String(t.id), text: t.name, selected: String(t.id) === String(existing?.champion) });
  const champSel = h('select', { class: 'input' }, [
    h('option', { value: '', text: '— команда —' }),
    fav.length ? h('optgroup', { label: '⭐ Фавориты' }, fav.map(champOpt)) : null,
    rest.length ? h('optgroup', { label: 'Остальные (по алфавиту)' }, rest.map(champOpt)) : null,
  ]);

  const dl = h('datalist', { id: 'playersDL' }, players.map((p) => h('option', { value: `${p.name} — ${p.team}` })));
  const labelOf = (id) => {
    const p = players.find((x) => x.id === String(id));
    return p ? `${p.name} — ${p.team}` : '';
  };
  const scorerInput = h('input', { class: 'input', list: 'playersDL', placeholder: 'Начни вводить имя', value: existing ? labelOf(existing.topScorer) : '' });

  const err = h('p', { class: 'error-msg' });
  const save = h('button', { class: 'btn', text: 'Сохранить прогноз' });
  const later = h('button', { class: 'btn ghost', text: 'Позже' });

  const overlay = h('div', { class: 'onboard' }, [
    h('div', { class: 'onboard-card' }, [
      h('div', { style: 'font-size:38px;text-align:center', text: '🌟' }),
      h('h1', { text: 'Прогноз на весь турнир' }),
      h('p', { class: 'lead-text', text: 'Один раз до матча открытия. После стартового свистка изменить нельзя.' }),
      h('label', { class: 'field' }, [
        h('span', {}, ['Чемпион мира', h('span', { class: 'bonus-tag', text: '+' + sc.championBonus })]),
        champSel,
      ]),
      h('label', { class: 'field' }, [
        h('span', {}, ['Лучший бомбардир', h('span', { class: 'bonus-tag', text: '+' + sc.topScorerBonus })]),
        scorerInput,
        dl,
      ]),
      players.length ? '' : h('p', { class: 'potential', text: 'Списки игроков подтянутся ботом — бомбардира можно будет выбрать позже.' }),
      err,
      h('div', { class: 'form-actions' }, [later, save]),
    ]),
  ]);

  later.addEventListener('click', () => overlay.remove());

  save.addEventListener('click', async () => {
    err.textContent = '';
    const champion = champSel.value || null;
    let topScorer = null;
    if (scorerInput.value.trim()) {
      const p = players.find((x) => `${x.name} — ${x.team}` === scorerInput.value.trim());
      if (!p) return (err.textContent = 'Выбери бомбардира из списка');
      topScorer = p.id;
    }
    if (!champion && !topScorer) return (err.textContent = 'Выбери хотя бы один прогноз');

    save.disabled = later.disabled = true;
    save.textContent = 'Сохраняем…';
    try {
      await submitTournament(S.session, S.app, { champion, topScorer });
      toast('Прогноз сохранён 🌟', 'ok');
      overlay.remove();
      document.getElementById('futuresBanner')?.setAttribute('hidden', '');
    } catch (e) {
      console.error(e);
      err.textContent = 'Не удалось сохранить. Попробуй ещё раз.';
      save.disabled = later.disabled = false;
      save.textContent = 'Сохранить прогноз';
    }
  });

  return overlay;
}

/** Принудительно открыть модалку прогноза (кнопка из баннера). */
export async function forceOnboard(ctx) {
  if (openingLocked(ctx.S)) {
    toast('Матч открытия уже начался — прогноз закрыт', 'err');
    return;
  }
  let existing = null;
  try {
    existing = await loadOwnTournament(ctx.S.session, ctx.S.app);
  } catch {}
  document.body.append(buildOverlay(ctx, existing));
}

/** Автопоказ при первом входе, если прогноза ещё нет и матч открытия впереди. */
export async function maybeOnboard(ctx) {
  if (shownThisSession || openingLocked(ctx.S) || !ctx.S.matches.length) return;
  shownThisSession = true;
  let existing = null;
  try {
    existing = await loadOwnTournament(ctx.S.session, ctx.S.app);
  } catch {
    return;
  }
  if (existing) return;
  document.body.append(buildOverlay(ctx, null));
}
