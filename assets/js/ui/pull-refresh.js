// Pull-to-refresh для домашнего web-app на iOS: в standalone нет нативного PTR.
// В обычном браузере не включаем — там работает родной pull-to-refresh.
const THRESHOLD = 70; // насколько потянуть, чтобы сработало
const MAX = 120; // максимум смещения индикатора
const DAMP = 0.5; // сопротивление (тянем «тяжелее», чем палец)

function enabled() {
  try {
    if (localStorage.getItem('ptrForce') === '1') return true; // ручной хук для проверки
  } catch {}
  return (
    window.navigator.standalone === true ||
    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches)
  );
}

export function setupPullToRefresh(onRefresh) {
  if (!enabled()) return; // только standalone — обычный Safari не трогаем
  if (document.getElementById('ptr')) return; // навешиваем один раз

  const el = document.createElement('div');
  el.id = 'ptr';
  el.className = 'ptr';
  el.innerHTML = '<div class="ptr-ring"></div>';
  document.body.appendChild(el);
  const ring = el.querySelector('.ptr-ring');

  let startY = 0;
  let active = false;
  let dist = 0;
  let busy = false;

  const move = (y) => (el.style.transform = `translate(-50%, ${y}px)`);

  document.addEventListener(
    'touchstart',
    (e) => {
      if (busy || e.touches.length !== 1 || window.scrollY > 0) {
        active = false;
        return;
      }
      startY = e.touches[0].clientY;
      active = true;
      dist = 0;
      el.style.transition = 'none'; // во время жеста — без задержки
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!active || busy) return;
      if (window.scrollY > 0) {
        active = false;
        return;
      }
      const dy = e.touches[0].clientY - startY;
      if (dy <= 0) {
        active = false;
        el.style.opacity = '0';
        return;
      }
      e.preventDefault(); // гасим bounce, ведём свой индикатор
      dist = Math.min(MAX, dy * DAMP);
      const p = Math.min(1, dist / THRESHOLD);
      el.style.opacity = String(p);
      move(dist);
      ring.style.transform = `rotate(${p * 300}deg)`;
      el.classList.toggle('ready', dist >= THRESHOLD);
    },
    { passive: false }
  );

  const end = async () => {
    if (!active || busy) {
      active = false;
      return;
    }
    active = false;
    el.style.transition = 'transform 0.25s ease, opacity 0.25s ease';
    if (dist >= THRESHOLD) {
      busy = true;
      ring.style.transform = ''; // отдаём вращение CSS-анимации
      el.classList.add('spin');
      el.style.opacity = '1';
      move(THRESHOLD);
      try {
        await onRefresh();
      } catch (err) {
        console.warn('Pull-to-refresh:', err);
      }
      await new Promise((r) => setTimeout(r, 300)); // спиннер не должен моргнуть
      el.classList.remove('spin', 'ready');
      el.style.opacity = '0';
      move(0);
      busy = false;
    } else {
      el.classList.remove('ready');
      el.style.opacity = '0';
      move(0);
    }
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
