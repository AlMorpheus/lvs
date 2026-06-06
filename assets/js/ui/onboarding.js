// Онбординг: прогноз чемпиона и лучшего бомбардира турнира (большие бонусы).
import { h, clear, toast } from './components.js';
import { submitTournament, loadOwnTournament } from '../bets.js';

let shownThisSession = false;

function uniqueTeams(S) {
  const map = new Map();
  for (const m of S.matches) {
    for (const t of [m.home, m.away]) if (t?.id != null && !map.has(String(t.id))) map.set(String(t.id), t);
  }
  return [...map.values()].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
}

function allPlayers(S) {
  const teamName = {};
  for (const t of uniqueTeams(S)) teamName[String(t.id)] = t.name;
  const out = [];
  for (const [tid, players] of Object.entries(S.squads || {})) {
    for (const p of players || []) out.push({ id: String(p.id), name: p.name, team: teamName[String(tid)] || '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

function openingLocked(S) {
  const k = S.app.tournament?.openingKickoff;
  return k ? Date.now() >= new Date(k).getTime() : false;
}

function buildOverlay(ctx, existing) {
  const S = ctx.S;
  const teams = uniqueTeams(S);
  const players = allPlayers(S);
  const sc = S.app.scoring;

  const champSel = h('select', { class: 'input' }, [h('option', { value: '', text: '— команда —' })].concat(
    teams.map((t) => h('option', { value: String(t.id), text: t.name, selected: String(t.id) === String(existing?.champion) }))
  ));

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
