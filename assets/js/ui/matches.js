// Экран «Матчи»: карточки, форма ставки (до свистка) и раскрытие ставок (после).
import { h, clear, flagEl, fmtDateTime, countdown, toast } from './components.js?v=8';
import { maxPotential, matchPoints, roundUnlocked, explainMatch } from '../scoring.mjs?v=8';
import { submitBet, loadOwnBet, loadRevealed, listOwnBets, loadOwnTournament } from '../bets.js?v=8';
import { forceOnboard, teamLabel, playerLabel } from './onboarding.js?v=8';
import { renderGreeting } from './greeting.js?v=8';

const ROUND_ORDER = ['test', 'group-1', 'group-2', 'group-3', 'r16', 'qf', 'sf', 'third', 'final'];
const ROUND_LABELS = {
  test: 'Товарищеские (тест)',
  'group-1': 'Групповой этап · 1 тур',
  'group-2': 'Групповой этап · 2 тур',
  'group-3': 'Групповой этап · 3 тур',
  r16: '1/8 финала',
  qf: '1/4 финала',
  sf: '1/2 финала',
  third: 'Матч за 3-е место',
  final: 'Финал',
};

const ownBetCache = new Map(); // matchId -> bet | null

function buildPlayerIndex(S) {
  const idx = new Map();
  for (const players of Object.values(S.squads || {})) {
    for (const p of players || []) idx.set(String(p.id), p.name);
  }
  for (const m of S.matches) for (const s of m.scorers || []) if (s.playerId) idx.set(String(s.playerId), s.name);
  return idx;
}

function unlocked(m, S) {
  return roundUnlocked(m.roundKey, S.matches);
}
function bettingOpen(m, S) {
  return unlocked(m, S) && !m.finished && Date.now() < new Date(m.date).getTime();
}
function started(m) {
  return m.finished || Date.now() >= new Date(m.date).getTime();
}

function statusBadge(m, S) {
  if (m.finished) return h('span', { class: 'badge ft', text: 'Завершён' });
  if (started(m)) return h('span', { class: 'badge live', text: 'LIVE' });
  if (!unlocked(m, S)) return h('span', { class: 'badge locked', text: '🔒 Скоро' });
  const cd = countdown(m.date);
  return h('span', { class: 'badge open', text: cd || 'Открыт' });
}

function rankOf(team, S) {
  const r = S.fifa?.teams?.[team?.name];
  return r != null ? r : null;
}
function nameEl(team, S) {
  const r = rankOf(team, S);
  return h('span', { class: 'name' }, [team?.name || '?', r != null ? h('small', { class: 'rank', text: ' #' + r }) : '']);
}
function teamRow(m, idx, S) {
  const showScore = started(m) && m.score;
  return h('div', { class: 'teams' }, [
    h('div', { class: 'team home' }, [flagEl(m.home), nameEl(m.home, S)]),
    h('div', { class: 'score' }, showScore
      ? [
          `${m.score.home} : ${m.score.away}`,
          m.scoreReg && (m.scoreReg.home !== m.score.home || m.scoreReg.away !== m.score.away)
            ? h('small', { class: 'reg-note', text: `осн. ${m.scoreReg.home}:${m.scoreReg.away}` })
            : '',
        ]
      : [h('span', { class: 'vs', text: 'vs' })]),
    h('div', { class: 'team away' }, [flagEl(m.away), nameEl(m.away, S)]),
  ]);
}

function scorerSelect(m, S, value) {
  const sel = h('select', { class: 'input' }, [h('option', { value: '', text: '— игрок —' })]);
  for (const team of [m.home, m.away]) {
    const players = (S.squads || {})[team?.id] || (S.squads || {})[String(team?.id)] || [];
    if (!players.length) continue;
    const og = h('optgroup', { label: team.name });
    for (const p of players) og.append(h('option', { value: String(p.id), text: p.name, selected: String(p.id) === String(value) }));
    sel.append(og);
  }
  return sel;
}

function chips(items) {
  return h('div', { class: 'chips' }, items.map((c) => h('span', { class: 'chip ' + (c.cls || '') }, c.text)));
}

// ---- форма ставки (до свистка) ----
function betForm(card, m, S, ctx, existing) {
  const cfg = S.app.scoring;
  const hb = { v: existing?.score?.home ?? 0 };
  const ab = { v: existing?.score?.away ?? 0 };

  const hv = h('span', { class: 'val', text: hb.v });
  const av = h('span', { class: 'val', text: ab.v });
  const step = (state, span, d) => () => {
    state.v = Math.max(0, Math.min(20, state.v + d));
    span.textContent = state.v;
  };

  const stepper = h('div', { class: 'stepper-wrap' }, [
    h('div', { class: 'stepper' }, [
      h('button', { type: 'button', text: '−', onclick: step(hb, hv, -1) }),
      hv,
      h('button', { type: 'button', text: '+', onclick: step(hb, hv, +1) }),
    ]),
    h('div', { class: 'stepper-mid', text: ':' }),
    h('div', { class: 'stepper' }, [
      h('button', { type: 'button', text: '−', onclick: step(ab, av, -1) }),
      av,
      h('button', { type: 'button', text: '+', onclick: step(ab, av, +1) }),
    ]),
  ]);

  const hasSquads = ((S.squads || {})[m.home?.id]?.length || (S.squads || {})[m.away?.id]?.length);
  const s1 = scorerSelect(m, S, existing?.scorers?.[0]);
  const s2 = scorerSelect(m, S, existing?.scorers?.[1]);
  const s3 = scorerSelect(m, S, existing?.scorers?.[2]);

  const scorersBlock = hasSquads
    ? h('div', { class: 'scorers' }, [h('div', { class: 'label', text: 'Три автора голов' }), s1, s2, s3])
    : h('div', { class: 'potential', text: 'Составы команд появятся ближе к матчу — пока можно поставить только счёт.' });

  const save = h('button', { class: 'btn', text: existing ? 'Обновить ставку' : 'Сохранить ставку' });
  const cancel = h('button', { class: 'btn ghost', text: 'Отмена' });

  async function doSave() {
    const scorers = [s1.value, s2.value, s3.value].filter(Boolean);
    save.disabled = cancel.disabled = true;
    save.textContent = 'Сохраняем…';
    try {
      const bet = { score: { home: hb.v, away: ab.v }, scorers };
      await submitBet(ctx.S.session, S.app, m.id, bet);
      ownBetCache.set(m.id, bet);
      toast('Ставка сохранена ⚽', 'ok');
      rerenderCard(card, m, S, ctx);
    } catch (e) {
      console.error(e);
      toast('Не удалось сохранить ставку', 'err');
      save.disabled = cancel.disabled = false;
      save.textContent = existing ? 'Обновить ставку' : 'Сохранить ставку';
    }
  }
  save.addEventListener('click', doSave);
  cancel.addEventListener('click', () => rerenderCard(card, m, S, ctx));

  return h('div', { class: 'betform' }, [
    stepper,
    scorersBlock,
    h('div', { class: 'potential' }, ['Максимум за матч: ', h('b', { text: '+' + maxPotential(m, cfg) }), ` (множитель ×${m.multiplier ?? 1})`]),
    h('div', { class: 'form-actions' }, [cancel, save]),
  ]);
}

// ---- детализация очков ----
function bdLine(label, pts, opts = {}) {
  const right = opts.right != null ? opts.right : pts > 0 ? '+' + pts : pts < 0 ? String(pts) : '+0';
  return h('div', { class: 'bd-row ' + (opts.cls || '') }, [
    h('span', { class: 'bd-label', text: label }),
    h('span', { class: 'bd-pts', text: right }),
  ]);
}
function breakdownPanel(bet, m, S, idx) {
  const ex = explainMatch(bet, m, S.app.scoring);
  if (!ex) return h('div', { class: 'breakdown' }, [bdLine('Нет данных', 0)]);
  const rows = [];
  if (ex.regUsed) rows.push(h('div', { class: 'bd-note', text: `⏱ Зачёт по счёту основного времени ${ex.actual.home}:${ex.actual.away} (был доп. тайм)` }));
  ex.scoreItems.forEach((it) => rows.push(bdLine(it.label, it.pts)));
  ex.scorerItems.forEach((s) =>
    rows.push(bdLine((s.correct ? '✓ ' : '✗ ') + (idx.get(String(s.playerId)) || 'игрок'), s.pts, { cls: s.correct ? '' : 'miss' }))
  );
  if (ex.hat) rows.push(bdLine('Хет-трик прогноза', ex.hat));
  rows.push(bdLine('База', ex.base, { cls: 'bd-strong' }));
  if (ex.multiplier !== 1) rows.push(bdLine(`× коэффициент ${ex.multiplier}`, null, { right: '= ' + ex.afterMult }));
  if (ex.special) rows.push(bdLine('Бонус за точный счёт', ex.special));
  rows.push(bdLine('Итого за матч', ex.total, { cls: 'bd-total' }));
  return h('div', { class: 'breakdown' }, rows);
}

// ---- раскрытые ставки (после свистка) ----
async function revealBlock(m, S, ctx, idx) {
  const wrap = h('div', { class: 'bet-summary' }, [h('div', { class: 'potential', text: 'Загружаем ставки…' })]);
  const revealed = await loadRevealed(ctx.S.session, m.id);
  clear(wrap);
  if (!revealed || !Object.keys(revealed).length) {
    wrap.append(h('div', { class: 'potential', text: 'Ставки появятся здесь после обработки ботом.' }));
    return wrap;
  }
  const standRow = (uid) => (S.standings.table || []).find((r) => r.id === uid);
  const nameOf = (uid) => S.users.find((u) => u.id === uid)?.name || uid;
  if (m.finished) wrap.append(h('div', { class: 'potential', text: 'Нажми на участника — покажу, как набраны очки.' }));

  // свои ставки сверху
  const entries = Object.entries(revealed).sort((a, b) => (a[0] === ctx.S.session.userId ? -1 : b[0] === ctx.S.session.userId ? 1 : 0));
  for (const [uid, bet] of entries) {
    const res = m.finished ? standRow(uid)?.perMatch?.[m.id] : null;
    const pts = res ? h('span', { class: 'pts' + (res.total > 0 ? '' : ' zero'), text: '+' + res.total }) : '';
    const scn = (bet.scorers || []).map((id) => idx.get(String(id)) || '—').join(', ');
    const caret = m.finished ? h('span', { class: 'caret', text: ' ▾' }) : '';
    const head = h('div', { class: 'row' + (m.finished ? ' clickable' : '') + (uid === ctx.S.session.userId ? ' me' : '') }, [
      h('span', {}, [h('b', { text: nameOf(uid) + (uid === ctx.S.session.userId ? ' · ты' : '') }), bet.scorers?.length ? ` · ${scn}` : '']),
      h('span', {}, [`${bet.score.home}:${bet.score.away} `, pts, caret]),
    ]);
    const holder = h('div', {});
    if (m.finished) {
      head.addEventListener('click', () => {
        if (holder.firstChild) {
          clear(holder);
          caret.textContent = ' ▾';
        } else {
          holder.append(breakdownPanel(bet, m, S, idx));
          caret.textContent = ' ▴';
        }
      });
    }
    wrap.append(head, holder);
  }
  return wrap;
}

function rerenderCard(card, m, S, ctx) {
  const idx = buildPlayerIndex(S);
  clear(card);
  card.append(
    h('div', { class: 'match-top' }, [
      h('span', { text: fmtDateTime(m.date) + (m.isOpening ? ' · Матч открытия' : '') }),
      h('span', {}, [h('span', { class: 'badge mult', text: '×' + (m.multiplier ?? 1) }), ' ', statusBadge(m, S)]),
    ]),
    teamRow(m, idx, S)
  );

  if (!m.finished && !started(m) && !unlocked(m, S)) {
    // тур ещё закрыт — откроется после завершения предыдущего
    card.append(
      h('div', { class: 'bet-summary' }, [
        h('div', { class: 'potential', text: '🔒 Ставки откроются после завершения предыдущего тура.' }),
      ])
    );
  } else if (bettingOpen(m, S)) {
    const existing = ownBetCache.get(m.id);
    if (existing) {
      const scn = (existing.scorers || []).map((id) => idx.get(String(id)) || '—');
      card.append(
        h('div', { class: 'bet-summary' }, [
          h('div', { class: 'row' }, [h('span', { text: 'Твоя ставка' }), h('span', { class: 'chip', text: `${existing.score.home}:${existing.score.away}` })]),
          scn.length ? chips(scn.map((n) => ({ text: n }))) : '',
        ])
      );
    }
    card.append(
      h('div', { class: 'cta-row' }, [
        h('button', {
          class: existing ? 'btn ghost small' : 'btn small',
          text: existing ? 'Изменить ставку' : 'Сделать ставку',
          onclick: () => {
            const form = betForm(card, m, S, ctx, ownBetCache.get(m.id));
            card.querySelector('.betform')?.remove();
            card.append(form);
          },
        }),
      ])
    );
  } else {
    // заблокировано — показать раскрытые ставки
    revealBlock(m, S, ctx, idx).then((b) => card.append(b));
  }
}

export async function renderMatches(view, ctx) {
  const S = ctx.S;
  view.append(h('h1', { class: 'view-title' }, [h('span', { class: 'accent', text: 'Матчи' }), ' и ставки']));

  if (!S.matches.length) {
    view.append(h('div', { class: 'empty' }, [h('div', { class: 'big', text: '📅' }), h('p', { text: 'Расписание ещё не загружено. Оно появится после первого запуска бота (GitHub Action).' })]));
    return;
  }

  const openingFuture = S.app.tournament?.openingKickoff ? Date.now() < new Date(S.app.tournament.openingKickoff).getTime() : true;

  // Блок приветствия (наполняется ниже, когда известны ставки)
  const greetHost = h('div', { id: 'greetHost' });
  view.append(greetHost);

  // Баннер: прогноз чемпиона/бомбардира
  const banner = h('div', { class: 'jackpot-note', id: 'futuresBanner', hidden: true });
  view.append(banner);

  const listWrap = h('div', { id: 'matchList' });
  view.append(listWrap);

  // own bets
  let own = { matchIds: new Set(), hasTournament: false };
  try {
    own = await listOwnBets(S.session, S.app);
  } catch (e) {
    console.warn('Не удалось получить список ставок', e);
  }

  let pick = null;
  try {
    pick = await loadOwnTournament(S.session, S.app);
  } catch {}
  const hasPick = pick && (pick.champion != null || pick.topScorer != null);

  // Блок приветствия: считаем, на сколько матчей ещё не поставлено
  const openNow = S.matches.filter((m) => bettingOpen(m, S));
  const toBet = openNow.filter((m) => !own.matchIds.has(m.id)).length;
  renderGreeting(greetHost, ctx, { toBet, needPick: !hasPick && openingFuture, hasOpen: openNow.length > 0 });

  clear(banner);
  const blocks = [];
  if (hasPick) {
    const champ = pick.champion != null ? teamLabel(S, pick.champion) || 'не выбран' : 'не выбран';
    const scorer = pick.topScorer != null ? playerLabel(S, pick.topScorer) || 'не выбран' : 'не выбран';
    blocks.push(h('div', {}, ['🌟 ', h('b', { text: 'Твой прогноз' }), ' — 🏆 ', champ, ' · 👟 ', scorer]));
  } else if (openingFuture) {
    blocks.push(h('div', {}, ['🌟 Ты ещё не выбрал ', h('b', { text: 'чемпиона' }), ' и ', h('b', { text: 'лучшего бомбардира' }), ' турнира.']));
  }
  if (openingFuture) {
    blocks.push(
      h('div', { style: 'margin-top:10px' }, [
        h('button', { class: hasPick ? 'btn ghost small' : 'btn small', text: hasPick ? 'Изменить прогноз' : 'Сделать прогноз', onclick: () => forceOnboard(ctx) }),
      ])
    );
  } else if (hasPick) {
    blocks.push(h('div', { class: 'potential', style: 'margin-top:6px', text: 'Прогноз закрыт — турнир начался.' }));
  }
  if (blocks.length) {
    banner.hidden = false;
    blocks.forEach((b) => banner.append(b));
  } else {
    banner.hidden = true;
  }

  // Предзагрузим собственные открытые ставки для префилла
  const openMatches = S.matches.filter((m) => bettingOpen(m, S) && own.matchIds.has(m.id));
  await Promise.all(
    openMatches.map(async (m) => {
      if (ownBetCache.has(m.id)) return;
      try {
        ownBetCache.set(m.id, await loadOwnBet(S.session, S.app, m.id));
      } catch {
        ownBetCache.set(m.id, null);
      }
    })
  );

  // Группировка по турам
  const groups = {};
  for (const m of S.matches) (groups[m.roundKey] ||= []).push(m);
  const keys = Object.keys(groups).sort((a, b) => {
    const ia = ROUND_ORDER.indexOf(a), ib = ROUND_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  for (const key of keys) {
    const locked = !roundUnlocked(key, S.matches);
    listWrap.append(h('div', { class: 'round-head', text: (ROUND_LABELS[key] || key) + (locked ? ' · 🔒' : '') }));
    const ms = groups[key].sort((a, b) => new Date(a.date) - new Date(b.date));
    for (const m of ms) {
      const card = h('div', { class: 'match' });
      rerenderCard(card, m, S, ctx);
      listWrap.append(card);
    }
  }
}
