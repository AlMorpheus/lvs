// Полноэкранная подсказка «Добавьте на экран „Домой"» для тех, кто открыл сайт во вкладке
// браузера (не в установленном PWA). На iOS это единственный способ получать пуши; плюс
// приложение работает на весь экран и стабильнее. Не надоедаем: после закрытия молчим 7 дней.
import { h } from './components.js?v=57';
import { isIOS, isStandalone } from '../push.js?v=57';

const KEY = 'lvs.a2hs.dismissedAt';
const SNOOZE_MS = 7 * 24 * 3600 * 1000;

// Android/desktop Chrome умеют нативную установку — ловим событие, чтобы показать кнопку.
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

// Safari на iOS (именно в нём есть «На экран „Домой"»); Chrome/Firefox на iOS — другой UA.
const isIOSSafari = () => isIOS() && /safari/i.test(navigator.userAgent) && !/(crios|fxios|edgios|opios)/i.test(navigator.userAgent);

function snoozed() {
  try {
    return Date.now() - (+localStorage.getItem(KEY) || 0) < SNOOZE_MS;
  } catch {
    return false;
  }
}
function snooze() {
  try {
    localStorage.setItem(KEY, String(Date.now()));
  } catch {}
}

// иконка «Поделиться» (квадрат со стрелкой вверх) — как в Safari
const SHARE_SVG =
  '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 15V3"/><path d="m8 7 4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';

function benefit(icon, text) {
  return h('li', {}, [h('span', { class: 'a2hs-ic', text: icon }), h('span', { text })]);
}

// Принудительно показать инструкцию (например, по тапу «🔔 Уведомления» на iPhone-вкладке).
export function showInstallPrompt() {
  if (document.getElementById('a2hs')) return;
  showOverlay(isIOS());
}

export function maybeShowInstallPrompt() {
  if (document.getElementById('a2hs')) return; // уже на экране
  let force = false;
  try {
    force = localStorage.getItem('a2hsForce') === '1';
  } catch {}
  if (force) return showOverlay(true); // ручной предпросмотр (iOS-вариант)
  if (isStandalone()) return; // уже установлено — незачем
  if (snoozed()) return; // недавно закрыли
  const ios = isIOS();
  if (!ios && !deferredPrompt) return; // десктоп/браузер без установки — не мешаем
  showOverlay(ios);
}

function showOverlay(ios) {
  const overlay = h('div', { class: 'a2hs-overlay', id: 'a2hs' });
  const close = () => {
    snooze();
    overlay.remove();
  };

  const benefits = h('ul', { class: 'a2hs-benefits' }, [
    benefit('🔔', 'Уведомления о стартовых составах и напоминания о матчах'),
    benefit('⚡', 'Открывается на весь экран, без панелей браузера — быстрее'),
    benefit('📲', 'Иконка на экране «Домой», как обычное приложение'),
    benefit('✅', 'Стабильнее: меньше «вылетов» и белых экранов'),
  ]);

  let action;
  if (ios) {
    const note = isIOSSafari()
      ? ''
      : h('p', { class: 'a2hs-note', text: 'Важно: это работает в Safari. Откройте сайт в Safari, если вы в другом браузере.' });
    action = h('div', {}, [
      h('ol', { class: 'a2hs-steps' }, [
        h('li', { html: `Нажмите <span class="a2hs-share">${SHARE_SVG}</span> «Поделиться» в панели Safari` }),
        h('li', { html: 'Выберите <b>«На экран „Домой"»</b>' }),
        h('li', { html: 'Откройте ЛВС с новой иконки 🎉' }),
      ]),
      note,
    ]);
  } else {
    // Android/Chrome — нативная установка одной кнопкой
    const btn = h('button', {
      class: 'btn',
      text: 'Установить приложение',
      onclick: async () => {
        if (!deferredPrompt) return close();
        deferredPrompt.prompt();
        try {
          await deferredPrompt.userChoice;
        } catch {}
        deferredPrompt = null;
        close();
      },
    });
    action = h('div', { class: 'a2hs-actions' }, [btn]);
  }

  const card = h('div', { class: 'a2hs-card' }, [
    h('button', { class: 'a2hs-x', text: '✕', 'aria-label': 'Закрыть', onclick: close }),
    h('img', { class: 'a2hs-logo', src: 'assets/img/logo.png?v=57', alt: 'ЛВС', width: 64, height: 64 }),
    h('h2', { class: 'a2hs-title', text: 'Установите ЛВС на экран «Домой»' }),
    h('p', { class: 'a2hs-sub', text: 'Так удобнее — и только так приходят уведомления о матчах:' }),
    benefits,
    action,
    h('button', { class: 'a2hs-later', text: 'Позже', onclick: close }),
  ]);

  overlay.append(card);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.body.appendChild(overlay);
}
