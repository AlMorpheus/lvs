// Свайп от левого края — открыть боковое меню; свайп влево по открытому меню — закрыть.
// Горизонтальный жест перехватываем (preventDefault), чтобы iOS не трактовал его как «назад».
const EDGE = 30; // зона у левого края, откуда можно начать открытие
const TRIGGER = 55; // порог срабатывания по горизонтали

let ready = false;

export function setupDrawerSwipe({ open, close, isOpen }) {
  if (ready) return; // навешиваем один раз
  ready = true;

  let x0 = 0;
  let y0 = 0;
  let tracking = false;
  let axis = null; // 'x' | 'y'

  document.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        tracking = false;
        return;
      }
      const t = e.touches[0];
      // открыть — только от самого края; закрыть — свайпом влево в любом месте
      if (!isOpen() && t.clientX > EDGE) {
        tracking = false;
        return;
      }
      x0 = t.clientX;
      y0 = t.clientY;
      tracking = true;
      axis = null;
    },
    { passive: true }
  );

  document.addEventListener(
    'touchmove',
    (e) => {
      if (!tracking) return;
      const t = e.touches[0];
      const dx = t.clientX - x0;
      const dy = t.clientY - y0;
      if (axis === null) {
        if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
        axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
        if (axis === 'y') {
          tracking = false; // вертикаль — отдаём прокрутке / pull-to-refresh
          return;
        }
      }
      e.preventDefault(); // горизонталь — перехватываем (гасим системную навигацию «назад»)
    },
    { passive: false }
  );

  const end = (e) => {
    if (!tracking) return;
    tracking = false;
    if (axis !== 'x') return;
    const t = e.changedTouches[0];
    if (!t) return;
    const dx = t.clientX - x0;
    if (!isOpen() && dx > TRIGGER) open();
    else if (isOpen() && dx < -TRIGGER) close();
  };
  document.addEventListener('touchend', end, { passive: true });
  document.addEventListener('touchcancel', end, { passive: true });
}
