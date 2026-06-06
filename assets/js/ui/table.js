// Экран «Таблица»: лидерборд + разбивка очков + победители туров.
import { h, clear } from './components.js?v=11';

const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉', 4: '🪵' };
const ROUND_LABELS = {
  test: 'Тест',
  'group-1': 'Групповой 1 тур',
  'group-2': 'Групповой 2 тур',
  'group-3': 'Групповой 3 тур',
  r16: '1/8 финала',
  qf: '1/4 финала',
  sf: '1/2 финала',
  third: 'За 3-е место',
  final: 'Финал',
};

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
    if (row.jackpotPts) sub.push(`Джекпоты +${row.jackpotPts}`);
    if (row.futuresPts) sub.push(`Прогнозы +${row.futuresPts}`);
    if (row.exactCount) sub.push(`Точных ${row.exactCount}`);
    lead.append(
      h('div', { class: 'lead-row' + (row.rank === 1 ? ' top1' : '') + (row.id === me ? ' me' : '') }, [
        h('div', { class: 'rank' }, MEDALS[row.rank] ? h('span', { class: 'medal', text: MEDALS[row.rank] }) : String(row.rank)),
        h('div', { class: 'who' }, [
          h('b', { text: row.name + (row.id === me ? ' · ты' : '') }),
          h('small', { text: sub.join(' · ') }),
        ]),
        h('div', { class: 'total', text: row.total }),
      ])
    );
  }
  view.append(lead);

  // Победители туров (джекпоты)
  const rounds = S.standings.rounds || {};
  const won = Object.values(rounds).filter((r) => r.winners && r.winners.length);
  if (won.length) {
    const note = h('div', { class: 'jackpot-note' }, [h('div', {}, [h('b', { text: '🎯 Джекпоты туров (+' + (S.app.scoring.roundJackpot) + ')' })])]);
    const nameOf = (uid) => S.users.find((u) => u.id === uid)?.name || uid;
    for (const r of won) {
      note.append(
        h('div', { class: 'row', style: 'display:flex;justify-content:space-between;margin-top:6px' }, [
          h('span', { text: ROUND_LABELS[r.key] || r.key }),
          h('span', { text: r.winners.map(nameOf).join(', ') + ` (${r.leadPts})` }),
        ])
      );
    }
    view.append(note);
  }
}
