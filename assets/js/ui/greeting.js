// Интерактивный блок приветствия: здоровается по имени и времени суток,
// напоминает про ставки, поздравляет с праздниками, показывает объявления.
import { h, clear, toast } from './components.js?v=33';
import { loadAnnouncements, saveAnnouncements } from '../bets.js?v=33';

function timeGreeting(name) {
  const hh = new Date().getHours();
  let g;
  if (hh >= 5 && hh < 12) g = 'Доброе утро';
  else if (hh < 18) g = 'Добрый день';
  else if (hh < 23) g = 'Добрый вечер';
  else g = 'Доброй ночи';
  return `${g}, ${name}!`;
}

// Российские праздники (MM-DD) -> поздравление.
const HOLIDAYS = {
  '01-01': 'С Новым годом! 🎄',
  '01-07': 'С Рождеством Христовым! ✨',
  '02-23': 'С Днём защитника Отечества! 🎖️',
  '03-08': 'С Международным женским днём! 💐',
  '05-01': 'С Праздником Весны и Труда! 🌷',
  '05-09': 'С Днём Победы! 🎆',
  '06-12': 'С Днём России! 🇷🇺',
  '11-04': 'С Днём народного единства! 🤝',
  '12-31': 'С наступающим Новым годом! 🎄',
};

function ruPlural(n, one, few, many) {
  const m10 = n % 10, m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

function mmdd() {
  const d = new Date();
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

export async function renderGreeting(host, ctx, info) {
  const S = ctx.S;
  const name = (S.session.name || '').split(' ')[0] || S.session.name;

  const card = h('div', { class: 'greet' });
  host.append(card);

  card.append(h('div', { class: 'greet-hi', text: timeGreeting(name) }));

  const holiday = HOLIDAYS[mmdd()];
  if (holiday) card.append(h('div', { class: 'greet-sub holiday', text: holiday }));

  // Напоминания
  const tips = [];
  if (info.toBet > 0) {
    tips.push(`📝 Не забудь поставить на ${info.toBet} ${ruPlural(info.toBet, 'матч', 'матча', 'матчей')} текущего тура — до начала каждого.`);
  } else if (info.needPick) {
    tips.push('🌟 Самое время выбрать чемпиона и лучшего бомбардира турнира.');
  } else if (info.hasOpen) {
    tips.push('✅ Все доступные ставки сделаны — красавчик! 👏');
  }
  tips.forEach((t) => card.append(h('div', { class: 'greet-tip', text: t })));

  // Объявления организатора
  let data = { items: [] };
  try {
    data = await loadAnnouncements(S.session, S.app);
  } catch {}
  for (const a of data.items || []) {
    const row = h('div', { class: 'greet-ann' }, [h('span', { text: '📢 ' + a.text })]);
    if (S.session.userId === S.app.adminId) {
      row.append(
        h('button', {
          class: 'ann-del',
          title: 'Удалить',
          text: '✕',
          onclick: async () => {
            const items = (data.items || []).filter((x) => x.id !== a.id);
            try {
              await saveAnnouncements(S.session, S.app, items);
              ctx.refreshData && ctx.refreshData();
            } catch {
              toast('Не удалось удалить', 'err');
            }
          },
        })
      );
    }
    card.append(row);
  }

  // Панель админа: написать объявление для всех
  if (S.session.userId === S.app.adminId) {
    const ta = h('textarea', { class: 'input ann-input', rows: 2, placeholder: 'Объявление для всех участников…' });
    const post = h('button', { class: 'btn small', text: 'Опубликовать' });
    post.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (!text) return;
      post.disabled = true;
      post.textContent = 'Публикуем…';
      const items = [...(data.items || []), { id: 'a' + Date.now(), text, createdAt: new Date().toISOString() }];
      try {
        await saveAnnouncements(S.session, S.app, items);
        ta.value = '';
        toast('Объявление опубликовано 📢', 'ok');
        ctx.refreshData && ctx.refreshData();
      } catch {
        toast('Не удалось опубликовать', 'err');
        post.disabled = false;
        post.textContent = 'Опубликовать';
      }
    });
    card.append(h('div', { class: 'greet-admin' }, [h('div', { class: 'greet-admin-label', text: '✍️ Объявление (видят все)' }), ta, post]));
  }
}
