// Экран входа: выбор участника + пароль (пароль расшифровывает вшитый токен).
import { h, clear, brandStrip } from './components.js?v=23';

export function renderLogin(root, { users, onLogin }) {
  const err = h('p', { class: 'error-msg' });

  const userSel = h(
    'select',
    { class: 'input' },
    [h('option', { value: '', text: '— выбери себя —', disabled: true, selected: true })].concat(
      users.map((u) => h('option', { value: u.id, text: u.name }))
    )
  );
  const pass = h('input', { class: 'input', type: 'password', placeholder: 'Пароль', autocomplete: 'current-password' });
  const btn = h('button', { class: 'btn', text: 'Войти' });

  async function submit() {
    err.textContent = '';
    if (!userSel.value) return (err.textContent = 'Выбери участника');
    if (!pass.value) return (err.textContent = 'Введи пароль');
    btn.disabled = true;
    btn.textContent = 'Проверяем…';
    try {
      await onLogin(userSel.value, pass.value);
    } catch (e) {
      err.textContent = e.message === 'invalid' ? 'Неверный пароль' : 'Не получилось войти. Попробуй ещё раз.';
      btn.disabled = false;
      btn.textContent = 'Войти';
    }
  }

  pass.addEventListener('keydown', (e) => e.key === 'Enter' && submit());
  btn.addEventListener('click', submit);

  clear(root).append(
    h('div', { class: 'login' }, [
      h('div', { class: 'login-card' }, [
        h('div', { class: 'login-logo mark' }),
        h('h1', { text: 'ЛВС' }),
        h('p', { class: 'login-sub', text: 'FIFA World Cup 26' }),
        brandStrip(),
        h('label', { class: 'field' }, [h('span', { text: 'Участник' }), userSel]),
        h('label', { class: 'field' }, [h('span', { text: 'Пароль' }), pass]),
        btn,
        err,
      ]),
    ])
  );
}
