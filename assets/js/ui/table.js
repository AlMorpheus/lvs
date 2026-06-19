// Экран «Таблица»: лидерборд + разбивка очков + прогноз (чемпион/бомбардир).
import { h, flagSrc } from './components.js?v=58';
import { openPlayerHistory } from './matches.js?v=58';
import { teamById, scorerInfo } from './onboarding.js?v=58';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };

const surname = (name) => {
  const parts = String(name || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : name || '';
};

function flagImg(team) {
  const src = team && flagSrc(team);
  return src ? h('img', { class: 'pick-flag', src, alt: team.name || '', loading: 'lazy' }) : null;
}

// Прогноз участника на турнир: флаг чемпиона + бомбардир (виден после свистка открытия).
function picksRow(S, row) {
  const champ = row.champion != null ? teamById(S, row.champion) : null;
  const scr = row.topScorer != null ? scorerInfo(S, row.topScorer) : null;
  if (!champ && !scr) return null;

  const items = [];
  if (champ) {
    items.push(
      h('span', { class: 'pick', title: 'Чемпион: ' + champ.name }, [
        h('span', { class: 'pick-ic', text: '🏆' }),
        flagImg(champ) || h('span', { class: 'pick-name', text: champ.name }),
      ])
    );
  }
  if (scr) {
    items.push(
      h('span', { class: 'pick', title: 'Бомбардир: ' + scr.name + ' — ' + scr.team }, [
        h('span', { class: 'pick-ic', text: '👟' }),
        flagImg({ name: scr.team }),
        h('span', { class: 'pick-name', text: surname(scr.name) }),
      ].filter(Boolean))
    );
  }
  return h('div', { class: 'picks' }, items);
}

export function renderTable(view, ctx) {
  const S = ctx.S;
  const me = S.session.userId;
  const table = S.standings.table || [];

  view.append(h('h1', { class: 'view-title' }, [h('span', { class: 'accent', text: 'Таблица' }), ' лидеров']));

  if (!table.length) {
    view.append(
      h('div', { class: 'empty' }, [
        h('div', { class: 'big', text: '🏆' }),
        h('p', { text: 'Очки появятся после первых сыгранных матчей. Ставьте прогнозы — и таблица оживёт!' }),
      ])
    );
    return;
  }

  const lead = h('div', { class: 'lead' });
  for (const row of table) {
    const sub = [];
    if (row.futuresPts) sub.push(`Прогнозы +${row.futuresPts}`);
    if (row.exactCount) sub.push(`Точных ${row.exactCount}`);
    const picks = picksRow(S, row);
    lead.append(
      h('div', {
        class: 'lead-row clickable' + (row.id === me ? ' me' : ''),
        onclick: () => openPlayerHistory(ctx, row.id, row.name),
      }, [
        h('div', { class: 'rank' }, MEDALS[row.rank] ? h('span', { class: 'medal', text: MEDALS[row.rank] }) : String(row.rank)),
        h('div', { class: 'who' }, [
          h('b', { text: row.name }),
          picks || '',
          sub.length ? h('small', { text: sub.join(' · ') }) : '',
        ]),
        h('div', { class: 'total' }, [String(row.total), h('span', { class: 'go-chev', text: '›' })]),
      ])
    );
  }
  view.append(lead);
}
