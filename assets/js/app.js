// Точка входа: загрузка данных, сессия, оболочка, роутинг.
import { initCrypto } from './crypto.js?v=55';
import { loadConfig, getApp, getUsers, getSession, login, logout } from './auth.js?v=55';
import { h, clear, toast, initials, brandStrip } from './ui/components.js?v=55';
import { renderLogin } from './ui/login.js?v=55';
import { renderMatches, renderHistory } from './ui/matches.js?v=55';
import { renderTable } from './ui/table.js?v=55';
import { renderRules } from './ui/rules.js?v=55';
import { maybeOnboard } from './ui/onboarding.js?v=55';
import { setupPullToRefresh } from './ui/pull-refresh.js?v=55';
import { setupDrawerSwipe } from './ui/drawer-swipe.js?v=55';
import { pushSupported, pushState, enablePush, disablePush, registerSW, isIOS, isStandalone } from './push.js?v=55';
import { maybeShowInstallPrompt, showInstallPrompt } from './ui/install-prompt.js?v=55';

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
      h('img', { class: 'brand-logo', src: 'assets/img/logo.png?v=55', alt: 'ЛВС', width: 52, height: 52 }),
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
      h('button', { class: 'push-btn', id: 'pushBtn', onclick: togglePush, text: '🔔 Уведомления' }),
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
  if (known === 'matches') renderMatches(view, ctx).then(() => focusMatchFromHash());
  else if (known === 'history') renderHistory(view, ctx);
  else if (known === 'table') renderTable(view, ctx);
  else if (known === 'rules') renderRules(view, ctx);
}

// Диплинк из пуша: #matches?m=<id> — подсвечиваем и прокручиваем к нужному матчу.
function focusMatchFromHash() {
  const q = location.hash.split('?')[1];
  const mid = q && new URLSearchParams(q).get('m');
  if (!mid) return;
  // снимаем параметр сразу, чтобы автообновление не прокручивало повторно каждые 30 с
  history.replaceState(null, '', '#matches');
  const el = document.getElementById('m-' + mid);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 2200);
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
  setInterval(tick, 30000);
  // обновляемся при любом возврате в приложение: на iOS JS в фоне засыпает, и
  // событие может прийти любым из этих (visibilitychange/focus/pageshow).
  const onActive = () => { if (!document.hidden) tick(); };
  document.addEventListener('visibilitychange', onActive);
  window.addEventListener('focus', onActive);
  window.addEventListener('pageshow', onActive);
}

function doLogout() {
  logout();
  S.session = null;
  location.hash = '';
  location.reload(); // полный сброс кэшей в памяти (прогноз/ставки) при смене пользователя
}

// ---------- Уведомления (web push) ----------
// Кнопка в сайдбаре подстраивается под состояние: не поддерживается / нужен home-screen на iOS /
// запрещено / выкл / вкл. Подписку шифруем и кладём в репо, бот шлёт пуш при смене состава.
async function refreshPushBtn() {
  const btn = document.getElementById('pushBtn');
  if (!btn) return;
  const st = await pushState();
  const map = {
    unsupported: { text: '🔕 Уведомления недоступны', dis: true },
    'needs-standalone': { text: '🔔 Включить уведомления', dis: false },
    denied: { text: '🔕 Уведомления запрещены', dis: true },
    off: { text: '🔔 Включить уведомления', dis: false },
    on: { text: '🔔 Уведомления включены', dis: false },
  };
  const v = map[st] || map.off;
  btn.textContent = v.text;
  btn.disabled = v.dis;
  btn.dataset.state = st;
}

let pushBusy = false;
async function togglePush() {
  if (pushBusy) return;
  pushBusy = true;
  const btn = document.getElementById('pushBtn');
  const st = btn?.dataset.state;
  try {
    if (isIOS() && !isStandalone()) {
      closeDrawer(); // прячем боковое меню, показываем полноэкранную инструкцию
      showInstallPrompt();
      return;
    }
    if (st === 'on') {
      await disablePush(S.session, S.app);
      toast('Уведомления выключены');
    } else {
      await enablePush(S.session, S.app);
      toast('Готово! Пришлём пуш, когда обновятся составы.');
    }
  } catch (e) {
    const msg = {
      unsupported: 'Этот браузер не умеет уведомления.',
      'needs-standalone': 'На iPhone сначала добавьте приложение на экран «Домой».',
      denied: 'Уведомления запрещены — включите их для сайта в настройках браузера.',
      'no-vapid': 'Уведомления пока не настроены на сервере.',
    }[e.message] || 'Не получилось включить уведомления. Попробуйте ещё раз.';
    toast(msg, '', 5000);
    console.warn('push toggle:', e);
  } finally {
    pushBusy = false;
    refreshPushBtn();
  }
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
  if (pushSupported()) registerSW(); // регистрируем воркер заранее (где поддержка есть)
  refreshPushBtn(); // подгоняем подпись кнопки под состояние (вкл/выкл/нужен home-screen/нет)
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
  // подсказка «добавь на экран Домой» тем, кто открыл сайт во вкладке браузера (не в PWA)
  setTimeout(maybeShowInstallPrompt, 1800);
}

boot();
