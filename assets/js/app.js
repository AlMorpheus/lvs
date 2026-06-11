// Точка входа: загрузка данных, сессия, оболочка, роутинг.
import { initCrypto } from './crypto.js?v=49';
import { loadConfig, getApp, getUsers, getSession, login, logout } from './auth.js?v=49';
import { h, clear, toast, initials, brandStrip } from './ui/components.js?v=49';
import { renderLogin } from './ui/login.js?v=49';
import { renderMatches, renderHistory } from './ui/matches.js?v=49';
import { renderTable } from './ui/table.js?v=49';
import { renderRules } from './ui/rules.js?v=49';
import { maybeOnboard } from './ui/onboarding.js?v=49';
import { setupPullToRefresh } from './ui/pull-refresh.js?v=49';
import { setupDrawerSwipe } from './ui/drawer-swipe.js?v=49';

const root = document.getElementById('root');

export const S = {
  app: null,
  users: [],
  session: null,
  matches: [],
  squads: {},
  players: {},
  standings: { table: [], rounds: {} },
  fifa: {},
  favTeams: { order: [] },
  favScorers: { order: [] },
};

const NAV = [
  { id: 'matches', icon: '⚽', label: 'Матчи' },
  { id: 'history', icon: '📜', label: 'История' },
  { id: 'table', icon: '🏆', label: 'Таблица' },
  { id: 'rules', icon: '📖', label: 'Правила' },
];

const bust = () => `?t=${Date.now()}`;
async function tryJSON(path, fallback) {
  try {
    const res = await fetch(path + bust(), { cache: 'no-store' });
    if (!res.ok) return fallback;
    return await res.json();
  } catch {
    return fallback;
  }
}

export async function loadPublicData() {
  const [matches, squads, players, standings, fifa, favTeams, favScorers] = await Promise.all([
    tryJSON('data/matches.json', []),
    tryJSON('data/squads.json', {}),
    tryJSON('data/players.json', {}),
    tryJSON('data/standings.json', { table: [], rounds: {} }),
    tryJSON('data/fifa-ranking.json', { teams: {} }),
    tryJSON('data/fav-teams.json', { order: [] }),
    tryJSON('data/fav-scorers.json', { order: [] }),
  ]);
  S.matches = Array.isArray(matches) ? matches : matches.matches || [];
  S.squads = squads || {};
  S.players = players || {};
  S.standings = standings && standings.table ? standings : { table: [], rounds: {} };
  S.fifa = fifa || { teams: {} };
  S.favTeams = favTeams || { order: [] };
  S.favScorers = favScorers || { order: [] };
}

// ---------- Оболочка ----------
function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, [
    h('a', { class: 'brand', href: '#matches', 'aria-label': 'На главную', onclick: (e) => { e.preventDefault(); navigate('matches'); } }, [
      h('img', { class: 'brand-logo', src: 'assets/img/logo.png?v=49', alt: 'ЛВС', width: 52, height: 52 }),
      h('div', {}, [h('small', { text: 'FIFA World Cup 26' })]),
    ]),
    h('nav', { class: 'nav', id: 'nav' }, NAV.map((n) =>
      h('a', { href: `#${n.id}`, dataset: { view: n.id }, onclick: (e) => { e.preventDefault(); navigate(n.id); } }, [
        h('span', { class: 'ic', text: n.icon }),
        h('span', { text: n.label }),
      ])
    )),
    h('div', { class: 'spacer' }),
    brandStrip(),
    h('div', { class: 'user-box' }, [
      h('div', { class: 'who' }, [
        h('span', { class: 'avatar', text: initials(S.session.name) }),
        h('span', { text: S.session.name }),
      ]),
      h('button', { onclick: doLogout, text: 'Выйти' }),
    ]),
  ]);

  const backdrop = h('div', { class: 'backdrop', id: 'backdrop', onclick: closeDrawer });

  const topbar = h('header', { class: 'topbar' }, [
    h('button', { class: 'burger', onclick: openDrawer, 'aria-label': 'Меню' }, [h('span', { class: 'burger-lines' })]),
    h('div', { class: 'title', id: 'topTitle' }, [h('span', { text: 'Матчи' })]),
  ]);

  const view = h('section', { class: 'content', id: 'view' });
  const main = h('div', { class: 'main' }, [topbar, view]);

  return h('div', { class: 'shell' }, [sidebar, backdrop, main]);
}

function openDrawer() {
  document.getElementById('sidebar')?.classList.add('open');
  document.getElementById('backdrop')?.classList.add('show');
}
function closeDrawer() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('backdrop')?.classList.remove('show');
}

function setActiveNav(viewId) {
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === viewId));
  const labels = { matches: 'Матчи', history: 'История', table: 'Таблица', rules: 'Правила' };
  const t = document.getElementById('topTitle');
  if (t) clear(t).append(h('span', { text: labels[viewId] || 'Матчи' }));
}

const ctx = {
  S,
  toast,
  refreshData: async () => {
    await loadPublicData();
    route();
  },
  goTable: () => navigate('table'),
};

// Переход без добавления записи в историю — чтобы свайп «назад» не кидал на прошлый экран.
function navigate(id) {
  if (location.hash !== '#' + id) history.replaceState(null, '', '#' + id);
  route();
}

function route() {
  const viewId = (location.hash.replace('#', '') || 'matches').split('?')[0];
  const known = NAV.some((n) => n.id === viewId) ? viewId : 'matches';
  setActiveNav(known);
  closeDrawer();
  const view = document.getElementById('view');
  if (!view) return;
  clear(view);
  if (known === 'matches') renderMatches(view, ctx);
  else if (known === 'history') renderHistory(view, ctx);
  else if (known === 'table') renderTable(view, ctx);
  else if (known === 'rules') renderRules(view, ctx);
}

// Периодическое автообновление: участники постоянно меняют ставки/прогнозы, всегда нужен
// СВЕЖИЙ снимок. Перерисовываем только при реальном изменении данных и не мешаем активному
// вводу (открытая форма ставки/модалка/фокус в поле — пропускаем тик).
let autoRefreshStarted = false;
function startAutoRefresh() {
  if (autoRefreshStarted) return;
  autoRefreshStarted = true;
  const sig = () =>
    JSON.stringify({
      t: (S.standings.table || []).map((r) => [r.id, r.total, r.rank, r.champion, r.topScorer]),
      m: S.matches.map((m) => [m.id, m.finished, m.score?.home, m.score?.away, m.multiplier]),
    });
  const tick = async () => {
    if (document.hidden) return;
    if (document.querySelector('.betform, .onboard, .history-overlay')) return; // не рвём активный ввод
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'SELECT' || ae.tagName === 'TEXTAREA')) return;
    try {
      const before = sig();
      await loadPublicData();
      if (sig() !== before) route(); // перерисовываем только когда данные реально изменились
    } catch {}
  };
  setInterval(tick, 45000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); }); // и при возврате в приложение
}

function doLogout() {
  logout();
  S.session = null;
  location.hash = '';
  location.reload(); // полный сброс кэшей в памяти (прогноз/ставки) при смене пользователя
}

function showLogin() {
  clear(root);
  renderLogin(root, {
    users: getUsers(),
    onLogin: async (userId, password) => {
      S.session = await login(userId, password);
      await startApp();
    },
  });
}

async function startApp() {
  clear(root);
  root.append(buildShell());
  if (!location.hash) history.replaceState(null, '', '#matches');
  route();
  setupPullToRefresh(ctx.refreshData); // свайп-вниз-обновление для домашнего web-app
  setupDrawerSwipe({ open: openDrawer, close: closeDrawer, isOpen: () => !!document.getElementById('sidebar')?.classList.contains('open') });
  startAutoRefresh(); // периодически подтягиваем свежие ставки/прогнозы (всегда последняя версия)
  // онбординг (чемпион + бомбардир), если ещё не выбрано и не заблокировано
  maybeOnboard(ctx);
}

window.addEventListener('hashchange', () => {
  if (S.session) route();
});

async function boot() {
  try {
    await loadConfig(); // только fetch конфигов — без обращения к CDN
    S.app = getApp();
    S.users = getUsers();
    await loadPublicData();
  } catch (e) {
    clear(root).append(
      h('div', { class: 'boot' }, [h('div', { class: 'boot-ball', text: '⚠️' }), h('p', { text: 'Ошибка загрузки конфигурации. Проверьте config/app.json и config/users.json.' })])
    );
    console.error(e);
    return;
  }
  S.session = getSession();
  if (S.session) {
    try {
      await initCrypto(); // нужна для расшифровки при восстановленной сессии
    } catch (e) {
      console.error('Не загрузилась крипто-библиотека', e);
    }
    await startApp();
  } else {
    showLogin(); // крипто подгрузится при самом входе
  }
}

boot();
