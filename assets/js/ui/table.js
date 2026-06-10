// Экран «Таблица»: лидерборд + разбивка очков.
import { h, clear } from './components.js?v=37';
import { openPlayerHistory } from './matches.js?v=37';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '🪵' };

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
    lead.append(
      h('div', {
        class: 'lead-row clickable' + (row.id === me ? ' me' : ''),
        onclick: () => openPlayerHistory(ctx, row.id, row.name),
      }, [
        h('div', { class: 'rank' }, MEDALS[row.rank] ? h('span', { class: 'medal', text: MEDALS[row.rank] }) : String(row.rank)),
        h('div', { class: 'who' }, [
          h('b', { text: row.name }),
          h('small', { text: sub.join(' · ') }),
        ]),
        h('div', { class: 'total' }, [String(row.total), h('span', { class: 'go-chev', text: '›' })]),
      ])
    );
  }
  view.append(lead);
}
