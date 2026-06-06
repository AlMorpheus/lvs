// Точка входа: загрузка данных, сессия, оболочка, роутинг.
import { initCrypto } from './crypto.js';
import { loadConfig, getApp, getUsers, getSession, login, logout } from './auth.js';
import { h, clear, toast, initials } from './ui/components.js';
import { renderLogin } from './ui/login.js';
import { renderMatches } from './ui/matches.js';
import { renderTable } from './ui/table.js';
import { renderRules } from './ui/rules.js';
import { maybeOnboard } from './ui/onboarding.js';

const root = document.getElementById('root');

export const S = {
  app: null,
  users: [],
  session: null,
  matches: [],
  squads: {},
  standings: { table: [], rounds: {} },
  fifa: {},
};

const NAV = [
  { id: 'matches', icon: '⚽', label: 'Матчи' },
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
  const [matches, squads, standings, fifa] = await Promise.all([
    tryJSON('data/matches.json', []),
    tryJSON('data/squads.json', {}),
    tryJSON('data/standings.json', { table: [], rounds: {} }),
    tryJSON('data/fifa-ranking.json', { teams: {} }),
  ]);
  S.matches = Array.isArray(matches) ? matches : matches.matches || [];
  S.squads = squads || {};
  S.standings = standings && standings.table ? standings : { table: [], rounds: {} };
  S.fifa = fifa || { teams: {} };
}

// ---------- Оболочка ----------
function buildShell() {
  const sidebar = h('aside', { class: 'sidebar', id: 'sidebar' }, [
    h('div', { class: 'brand' }, [
      h('span', { class: 'ball', text: '⚽' }),
      h('div', {}, [h('div', { text: 'Кубок друзей' }), h('small', { text: 'Чемпионат мира 2026' })]),
    ]),
    h('nav', { class: 'nav', id: 'nav' }, NAV.map((n) =>
      h('a', { href: `#${n.id}`, dataset: { view: n.id } }, [
        h('span', { class: 'ic', text: n.icon }),
        h('span', { text: n.label }),
      ])
    )),
    h('div', { class: 'spacer' }),
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
    h('button', { class: 'burger', onclick: openDrawer, 'aria-label': 'Меню', text: '☰' }),
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
  const labels = { matches: 'Матчи', table: 'Таблица', rules: 'Правила' };
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
  goTable: () => (location.hash = '#table'),
};

function route() {
  const viewId = (location.hash.replace('#', '') || 'matches').split('?')[0];
  const known = NAV.some((n) => n.id === viewId) ? viewId : 'matches';
  setActiveNav(known);
  closeDrawer();
  const view = document.getElementById('view');
  if (!view) return;
  clear(view);
  if (known === 'matches') renderMatches(view, ctx);
  else if (known === 'table') renderTable(view, ctx);
  else if (known === 'rules') renderRules(view, ctx);
}

function doLogout() {
  logout();
  S.session = null;
  location.hash = '';
  showLogin();
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
  if (!location.hash) location.hash = '#matches';
  route();
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
