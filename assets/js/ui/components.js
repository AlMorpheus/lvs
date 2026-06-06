// Мелкие помощники для DOM и форматирования.

/** Создать элемент: h('div', {class:'x', onclick:fn, text:'hi'}, [child, ...]) */
export function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    el.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Фирменная мультиколор-полоса (плоские сегменты палитры FWC26). */
export function brandStrip() {
  return h('div', { class: 'brandstrip' }, [0, 1, 2, 3, 4].map(() => h('i', {})));
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

let toastTimer = null;
export function toast(message, type = '') {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.className = 'toast ' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 3200);
}

const dtFmt = new Intl.DateTimeFormat('ru-RU', {
  day: 'numeric',
  month: 'long',
  hour: '2-digit',
  minute: '2-digit',
});
const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });

export function fmtDateTime(iso) {
  if (!iso) return '';
  return dtFmt.format(new Date(iso));
}
export function fmtTime(iso) {
  if (!iso) return '';
  return timeFmt.format(new Date(iso));
}

/** Сколько осталось до времени iso (короткой строкой) или null, если уже прошло. */
export function countdown(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60000);
  const d = Math.floor(m / 1440);
  const hh = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `через ${d} д ${hh} ч`;
  if (hh > 0) return `через ${hh} ч ${mm} мин`;
  return `через ${mm} мин`;
}

/** Флаг команды: <img> по URL, либо эмодзи, либо инициалы. */
export function flagEl(team) {
  if (team?.flag) return h('span', { class: 'flag' }, [h('img', { src: team.flag, alt: '', width: 30, height: 22 })]);
  if (team?.emoji) return h('span', { class: 'flag', text: team.emoji });
  const code = (team?.code || team?.name || '?').slice(0, 2).toUpperCase();
  return h('span', { class: 'flag', text: code });
}

export const initials = (name) =>
  (name || '?')
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
