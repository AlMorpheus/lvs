// Экран «Матчи»: карточки, форма ставки (до свистка) и раскрытие ставок (после).
import { h, clear, flagEl, flagSrc, fmtDateTime, countdown, toast } from './components.js?v=39';
import { maxPotential, roundUnlocked, explainMatch, buildPosIndex } from '../scoring.mjs?v=39';
import { submitBet, loadOwnBet, loadRevealed, listOwnBets, loadOwnTournament } from '../bets.js?v=39';
import { forceOnboard, teamLabel, playerLabel } from './onboarding.js?v=39';
import { renderGreeting } from './greeting.js?v=39';

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

// Завершённый матч ещё час висит наверху (рядом с «идут сейчас»), чтобы все успели
// посмотреть результат и начисленные очки, и только потом уходит в архив.
const RECENT_FINISHED_MS = 60 * 60 * 1000;

// Виртуальный игрок betanalyse.pro — его ставка фиксируется на свистке и раскрывается как у всех.
const AI_ID = 'betanalyse';

function buildPlayerIndex(S) {
  const idx = new Map();
  // накопительный справочник — основа (имена не теряются при усечении заявки)
  for (const [id, p] of Object.entries(S.players || {})) if (p?.name) idx.set(String(id), p.name);
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
// Завершён, но ещё в «часовом окне» — держим наверху, не в архиве.
function recentlyFinished(m) {
  return m.finished && m.finishedAt && Date.now() < new Date(m.finishedAt).getTime() + RECENT_FINISHED_MS;
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

const POS_ORDER = { Attacker: 0, Midfielder: 1, Defender: 2, Goalkeeper: 3 };
const POS_ABBR = { Attacker: 'нап', Midfielder: 'пз', Defender: 'защ', Goalkeeper: 'вр' };

// id игроков-лидеров — из закешированного списка фаворитов-бомбардиров, без API.
let _favIdsCache = null;
function favScorerIdSet(S) {
  if (_favIdsCache) return _favIdsCache;
  const norm = (s) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const last = (s) => norm((s || '').trim().split(/\s+/).pop()).replace(/[^a-z]/g, '');
  const teamName = {};
  for (const mm of S.matches || []) for (const t of [mm.home, mm.away]) if (t?.id != null) teamName[String(t.id)] = t.name;
  const fav = (S.favScorers && S.favScorers.order) || [];
  const set = new Set();
  for (const [tid, players] of Object.entries(S.squads || {})) {
    const tn = norm(teamName[String(tid)] || '');
    for (const p of players || []) {
      if (fav.some((f) => last(f.name) === last(p.name) && norm(f.team) === tn)) set.add(String(p.id));
    }
  }
  _favIdsCache = set;
  return set;
}

// Сортировка состава: нападающие → пз → защ → вр; внутри — лидеры, затем номер.
function sortSquad(players, S) {
  const fav = favScorerIdSet(S);
  return [...players].sort((a, b) => {
    const pa = POS_ORDER[a.pos] ?? 4, pb = POS_ORDER[b.pos] ?? 4;
    if (pa !== pb) return pa - pb;
    const fa = fav.has(String(a.id)) ? 0 : 1, fb = fav.has(String(b.id)) ? 0 : 1;
    if (fa !== fb) return fa - fb;
    return (a.number || 999) - (b.number || 999) || (a.name || '').localeCompare(b.name || '');
  });
}

function scorerSelect(m, S, value) {
  const sel = h('select', { class: 'input' }, [h('option', { value: '', text: '— игрок —' })]);
  for (const team of [m.home, m.away]) {
    const raw = (S.squads || {})[team?.id] || (S.squads || {})[String(team?.id)] || [];
    if (!raw.length) continue;
    const og = h('optgroup', { label: team.name });
    for (const p of sortSquad(raw, S)) {
      const ab = POS_ABBR[p.pos];
      og.append(h('option', { value: String(p.id), text: ab ? `${p.name} · ${ab}` : p.name, selected: String(p.id) === String(value) }));
    }
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
    h('div', { class: 'potential' }, ['Точный счёт здесь: ', h('b', { text: '+' + maxPotential(m, cfg) }), ` · коэффициент ×${m.multiplier ?? 1}. Автор: нап +${cfg.scorerByPos.Attacker}, пз +${cfg.scorerByPos.Midfielder}, защ +${cfg.scorerByPos.Defender}, вр +${cfg.scorerByPos.Goalkeeper}.`]),
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
let _posIdx = null;
function posIndex(S) {
  if (_posIdx) return _posIdx;
  const idx = buildPosIndex(S.squads);
  for (const [id, p] of Object.entries(S.players || {})) if (p?.pos && idx[String(id)] == null) idx[String(id)] = p.pos;
  return (_posIdx = idx);
}
// «Фамилия · поз» (нап/пз/защ/вр) для отображения авторов в ставке.
function nameWithPos(id, S, idx) {
  const nm = idx.get(String(id)) || '—';
  const ab = POS_ABBR[posIndex(S)[String(id)]];
  return ab ? `${nm} · ${ab}` : nm;
}
// Команда игрока в рамках матча (по составу), чтобы показать флаг.
function teamOfPlayer(id, m, S) {
  const inSquad = (team) => ((S.squads || {})[team?.id] || (S.squads || {})[String(team?.id)] || []).some((p) => String(p.id) === String(id));
  if (inSquad(m.home)) return m.home;
  if (inSquad(m.away)) return m.away;
  // запасной вариант — команда из справочника игроков
  const t = (S.players || {})[String(id)]?.team;
  if (t != null) {
    if (String(m.home?.id) === String(t)) return m.home;
    if (String(m.away?.id) === String(t)) return m.away;
  }
  return null;
}
function miniFlag(team) {
  const src = flagSrc(team);
  if (src) return h('span', { class: 'chip-flag' }, [h('img', { src, alt: '', loading: 'lazy' })]);
  if (team?.emoji) return h('span', { class: 'chip-flag', text: team.emoji });
  return '';
}
// Чип автора: флаг команды + «Фамилия · поз».
function scorerChip(id, m, S, idx) {
  return h('span', { class: 'chip' }, [miniFlag(teamOfPlayer(id, m, S)), nameWithPos(id, S, idx)]);
}

// Фамилия из полного имени betanalyse.pro («Cody Gakpo» → «Gakpo», «Virgil van Dijk» → «van Dijk»).
function surname(name) {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : name || '—';
}
// Отдельная строка в списке ставок: прогноз betanalyse.pro (счёт + три автора).
function aiPredictionEntry(ai, m) {
  const chip = (s) =>
    h('span', { class: 'chip' }, [
      miniFlag(s.team === 'away' ? m.away : m.home),
      s.pos ? `${surname(s.name)} · ${s.pos}` : surname(s.name),
    ]);
  const scorerEls = (ai.scorers || []).map(chip);
  return h('div', { class: 'reveal-entry ai' }, [
    h('div', { class: 'reveal-head' }, [
      h('div', { class: 'reveal-who' }, [
        h('a', { class: 'ai-link', href: `https://erastfandorin2004.github.io/betprediction/lvs#m-${m.id}`, target: '_blank', rel: 'noopener noreferrer' }, [
          h('span', { class: 'ai-ava', text: '🤖' }),
          h('b', { text: 'betanalyse.pro' }),
        ]),
      ]),
      h('div', { class: 'reveal-score' }, [h('span', { class: 'rscore', text: `${ai.score.home}:${ai.score.away}` })]),
    ]),
    scorerEls.length ? h('div', { class: 'chips reveal-scorers' }, scorerEls) : '',
  ]);
}
function breakdownPanel(bet, m, S, idx) {
  const ex = explainMatch(bet, m, S.app.scoring, posIndex(S));
  if (!ex) return h('div', { class: 'breakdown' }, [bdLine('Нет данных', 0)]);
  const rows = [];
  if (ex.regUsed) rows.push(h('div', { class: 'bd-note', text: `⏱ Зачёт по счёту основного времени ${ex.actual.home}:${ex.actual.away} (был доп. тайм)` }));
  ex.scoreItems.forEach((it) => rows.push(bdLine(it.label, it.pts)));
  ex.scorerItems.forEach((s) => {
    const ab = POS_ABBR[s.pos];
    const nm = (idx.get(String(s.playerId)) || 'игрок') + (ab ? ' · ' + ab : '');
    rows.push(bdLine((s.correct ? '✓ ' : '✗ ') + nm, s.pts, { cls: s.correct ? '' : 'miss' }));
  });
  rows.push(bdLine('База', ex.base, { cls: 'bd-strong' }));
  if (ex.multiplier !== 1) rows.push(bdLine(`× коэффициент ${ex.multiplier}`, null, { right: '= ' + ex.afterMult }));
  if (ex.special) rows.push(bdLine('Бонус за точный счёт', ex.special));
  rows.push(bdLine('Итого за матч', ex.total, { cls: 'bd-total' }));
  return h('div', { class: 'breakdown' }, rows);
}

// Кнопка «Как набраны очки» + сворачиваемый разбор. Возвращает [кнопка, контейнер].
function breakdownToggle(bet, m, S, idx) {
  const holder = h('div', { class: 'reveal-bd' });
  const label = h('span', { text: 'Как набраны очки' });
  const chev = h('span', { class: 'reveal-chev', text: '▾' });
  const toggle = h('button', { class: 'reveal-toggle', type: 'button' }, [label, chev]);
  toggle.addEventListener('click', () => {
    if (holder.firstChild) {
      clear(holder);
      toggle.classList.remove('open');
      label.textContent = 'Как набраны очки';
      chev.textContent = '▾';
    } else {
      holder.append(breakdownPanel(bet, m, S, idx));
      toggle.classList.add('open');
      label.textContent = 'Скрыть разбор';
      chev.textContent = '▴';
    }
  });
  return [toggle, holder];
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
  const nameOf = (uid) => (uid === AI_ID ? 'betanalyse.pro' : S.users.find((u) => u.id === uid)?.name || uid);
  if (m.finished) wrap.append(h('div', { class: 'potential', text: 'Жми «Как набраны очки» под ставкой — покажу разбор.' }));

  // порядок: своя ставка → betanalyse.pro → остальные
  const rank = (uid) => (uid === ctx.S.session.userId ? 0 : uid === AI_ID ? 1 : 2);
  const entries = Object.entries(revealed).sort((a, b) => rank(a[0]) - rank(b[0]));
  for (const [uid, bet] of entries) {
    const me = uid === ctx.S.session.userId;
    const isAI = uid === AI_ID;
    const res = m.finished ? standRow(uid)?.perMatch?.[m.id] : null;
    const pts = res ? h('span', { class: 'pts' + (res.total > 0 ? '' : ' zero'), text: '+' + res.total }) : '';
    const scorerEls = (bet.scorers || []).map((id) => scorerChip(id, m, S, idx));

    const whoChildren = isAI
      ? [h('a', { class: 'ai-link', href: `https://erastfandorin2004.github.io/betprediction/lvs#m-${m.id}`, target: '_blank', rel: 'noopener noreferrer' }, [
          h('span', { class: 'ai-ava', text: '🤖' }),
          h('b', { text: 'betanalyse.pro' }),
        ])]
      : [h('b', { text: nameOf(uid) }), me ? h('span', { class: 'you-tag', text: 'я' }) : ''];

    const entry = h('div', { class: 'reveal-entry' + (me ? ' me' : '') + (isAI ? ' ai' : '') }, [
      h('div', { class: 'reveal-head' }, [
        h('div', { class: 'reveal-who' }, whoChildren),
        h('div', { class: 'reveal-score' }, [h('span', { class: 'rscore', text: `${bet.score.home}:${bet.score.away}` }), pts]),
      ]),
      scorerEls.length ? h('div', { class: 'chips reveal-scorers' }, scorerEls) : '',
    ]);

    if (m.finished) entry.append(...breakdownToggle(bet, m, S, idx));
    wrap.append(entry);
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
      const scorerEls = (existing.scorers || []).map((id) => scorerChip(id, m, S, idx));
      card.append(
        h('div', { class: 'bet-summary' }, [
          h('div', { class: 'row' }, [h('span', { text: 'Твоя ставка' }), h('span', { class: 'chip', text: `${existing.score.home}:${existing.score.away}` })]),
          scorerEls.length ? h('div', { class: 'chips' }, scorerEls) : '',
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
    // заблокировано — показать раскрытые ставки (прогноз betanalyse.pro внутри)
    revealBlock(m, S, ctx, idx).then((b) => card.append(b));
  }

  // До начала матча показываем прогноз betanalyse.pro отдельным блоком.
  // Он обновляется на их стороне примерно за час до игры — бот тянет свежую версию
  // каждые 2 минуты, так что здесь всегда актуальный прогноз.
  if (!started(m)) {
    const ai = S.aiPredictions?.[m.id];
    if (ai) card.append(h('div', { class: 'bet-summary' }, [aiPredictionEntry(ai, m)]));
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

  // Идущие сейчас — всегда вверху; следом только что завершённые (ещё час); затем предстоящие.
  // Давно сыгранные — в отдельном разделе «История» (чтобы не скроллить вниз главной).
  const live = S.matches.filter((m) => started(m) && !m.finished);
  const recent = S.matches.filter((m) => recentlyFinished(m));
  const upcoming = S.matches.filter((m) => !started(m));

  if (live.length) {
    listWrap.append(h('div', { class: 'live-banner' }, [h('span', { class: 'live-dot' }), 'Идут сейчас']));
    renderGroups(listWrap, live, ctx, false);
  }

  if (recent.length) {
    listWrap.append(h('div', { class: 'live-banner done' }, [h('span', { class: 'live-dot done' }), 'Только что сыграли — проверь очки']));
    renderGroups(listWrap, recent, ctx, true); // свежие сверху
  }

  if (upcoming.length) {
    renderGroups(listWrap, upcoming, ctx, false);
  } else if (!live.length && !recent.length) {
    listWrap.append(h('div', { class: 'empty' }, [h('div', { class: 'big', text: '⚽' }), h('p', { text: 'Предстоящих матчей нет — все сыгранные смотри в разделе «История».' })]));
  }
}

// Экран «История»: все сыгранные матчи со ставками всех участников и разбором очков
// (то, что раньше было свёрнутым архивом внизу главной — теперь отдельным разделом).
export async function renderHistory(view, ctx) {
  const S = ctx.S;
  view.append(h('h1', { class: 'view-title' }, [h('span', { class: 'accent', text: 'История' }), ' матчей']));

  const finished = S.matches.filter((m) => m.finished);
  if (!finished.length) {
    view.append(h('div', { class: 'empty' }, [h('div', { class: 'big', text: '📜' }), h('p', { text: 'Сыгранных матчей пока нет — они появятся здесь после первых игр турнира.' })]));
    return;
  }

  const listWrap = h('div', { id: 'historyList' });
  view.append(listWrap);
  renderGroups(listWrap, finished, ctx, true); // свежие туры и матчи — сверху
}

// Рендер матчей, сгруппированных по турам. reverse — порядок туров и матчей от свежих к старым (для архива).
function renderGroups(container, matches, ctx, reverse) {
  const S = ctx.S;
  const groups = {};
  for (const m of matches) (groups[m.roundKey] ||= []).push(m);
  let keys = Object.keys(groups).sort((a, b) => {
    const ia = ROUND_ORDER.indexOf(a), ib = ROUND_ORDER.indexOf(b);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  if (reverse) keys = keys.reverse();
  for (const key of keys) {
    const locked = !roundUnlocked(key, S.matches);
    container.append(h('div', { class: 'round-head', text: (ROUND_LABELS[key] || key) + (locked ? ' · 🔒' : '') }));
    const ms = groups[key].sort((a, b) => (reverse ? new Date(b.date) - new Date(a.date) : new Date(a.date) - new Date(b.date)));
    for (const m of ms) {
      const card = h('div', { class: 'match' });
      rerenderCard(card, m, S, ctx);
      container.append(card);
    }
  }
}

// Карточка матча в истории игрока — один в один как на главной (.match).
function historyCard(m, bet, res, S, idx) {
  const pts = res ? h('span', { class: 'pts' + (res.total > 0 ? '' : ' zero'), text: '+' + res.total }) : '';
  const scorerEls = (bet.scorers || []).map((id) => scorerChip(id, m, S, idx));
  const entry = h('div', { class: 'reveal-entry' }, [
    h('div', { class: 'reveal-head' }, [
      h('div', { class: 'reveal-who' }, [h('b', { text: 'Прогноз' })]),
      h('div', { class: 'reveal-score' }, [h('span', { class: 'rscore', text: `${bet.score.home}:${bet.score.away}` }), pts]),
    ]),
    scorerEls.length ? h('div', { class: 'chips reveal-scorers' }, scorerEls) : '',
  ]);
  entry.append(...breakdownToggle(bet, m, S, idx));
  return h('div', { class: 'match' }, [
    h('div', { class: 'match-top' }, [
      h('span', { text: fmtDateTime(m.date) }),
      h('span', {}, [h('span', { class: 'badge mult', text: '×' + (m.multiplier ?? 1) }), ' ', h('span', { class: 'badge ft', text: 'Завершён' })]),
    ]),
    teamRow(m, idx, S),
    h('div', { class: 'bet-summary' }, [entry]),
  ]);
}

// История участника: все его сыгранные матчи с разбором очков (вызывается из таблицы).
// Полноэкранная панель в стиле главной: фон страницы, колонка контента, заголовки туров, карточки .match.
export async function openPlayerHistory(ctx, userId, name) {
  const S = ctx.S;
  const idx = buildPlayerIndex(S);
  const row = (S.standings.table || []).find((r) => r.id === userId);

  const inner = h('div', { class: 'history-inner' });
  const overlay = h('div', { class: 'history-overlay' }, [inner]);
  const close = () => overlay.remove();

  inner.append(
    h('div', { class: 'history-top' }, [
      h('h1', { class: 'view-title' }, [h('span', { class: 'accent', text: name })]),
      h('button', { class: 'btn ghost small', text: 'Закрыть', onclick: close }),
    ])
  );

  if (row) {
    const stat = [h('div', { class: 'hstat' }, [h('b', { text: row.total }), h('small', { text: 'всего' })])];
    if (row.matchPts != null) stat.push(h('div', { class: 'hstat' }, [h('b', { text: row.matchPts }), h('small', { text: 'за матчи' })]));
    if (row.futuresPts) stat.push(h('div', { class: 'hstat' }, [h('b', { text: '+' + row.futuresPts }), h('small', { text: 'прогнозы' })]));
    if (row.exactCount) stat.push(h('div', { class: 'hstat' }, [h('b', { text: row.exactCount }), h('small', { text: 'точных' })]));
    inner.append(h('div', { class: 'history-stats' }, stat));
  }

  const listHost = h('div', { class: 'history-list' }, [h('div', { class: 'potential', text: 'Загружаем историю…' })]);
  inner.append(listHost);
  document.body.append(overlay);

  // собираем ставки участника по сыгранным матчам
  const mine = [];
  for (const m of S.matches.filter((x) => x.finished)) {
    let rev = null;
    try {
      rev = await loadRevealed(S.session, m.id);
    } catch {}
    const bet = rev && rev[userId];
    if (bet) mine.push({ m, bet });
  }

  clear(listHost);
  if (!mine.length) {
    listHost.append(h('div', { class: 'empty' }, [h('div', { class: 'big', text: '⚽' }), h('p', { text: 'Пока нет сыгранных матчей с раскрытыми ставками.' })]));
    return;
  }

  // группируем по турам и показываем как на главной (свежие туры сверху)
  const groups = {};
  for (const it of mine) (groups[it.m.roundKey] ||= []).push(it);
  const keys = Object.keys(groups)
    .sort((a, b) => {
      const ia = ROUND_ORDER.indexOf(a), ib = ROUND_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    })
    .reverse();
  for (const key of keys) {
    listHost.append(h('div', { class: 'round-head', text: ROUND_LABELS[key] || key }));
    const items = groups[key].sort((a, b) => new Date(b.m.date) - new Date(a.m.date));
    for (const { m, bet } of items) listHost.append(historyCard(m, bet, row?.perMatch?.[m.id], S, idx));
  }
}
