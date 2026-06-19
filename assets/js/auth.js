// Загрузка конфигурации, вход (распаковка вшитого токена и общего ключа), сессия.
import { initCrypto, deriveKey, openSecretbox, openSecretboxStr } from './crypto.js?v=58';

// base64 без зависимости от sodium (sodium ORIGINAL = стандартный base64 с паддингом).
const b64ToBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64 = (b) => btoa(String.fromCharCode(...b));

let _app = null;
let _users = null;
let _session = null;

const bust = () => `?t=${Date.now()}`;

async function getJSON(path) {
  const res = await fetch(path + bust(), { cache: 'no-store' });
  if (!res.ok) throw new Error(`Не удалось загрузить ${path} (${res.status})`);
  return res.json();
}

export async function loadConfig() {
  if (_app && _users) return { app: _app, users: _users };
  [_app, _users] = await Promise.all([getJSON('config/app.json'), getJSON('config/users.json')]);
  return { app: _app, users: _users };
}

export function getApp() {
  return _app;
}

export function getUsers() {
  return _users?.users || [];
}

const SS_KEY = 'lvs.session';

export function getSession() {
  if (_session) return _session;
  const raw = localStorage.getItem(SS_KEY);
  if (!raw) return null;
  try {
    const s = JSON.parse(raw);
    _session = { userId: s.userId, name: s.name, token: s.token, sk: b64ToBytes(s.sk), userKey: b64ToBytes(s.userKey) };
    return _session;
  } catch {
    localStorage.removeItem(SS_KEY);
    return null;
  }
}

/** Вход. Возвращает сессию или бросает 'invalid' при неверном пароле. */
export async function login(userId, password) {
  await initCrypto();
  await loadConfig();
  const user = getUsers().find((u) => u.id === userId);
  if (!user) throw new Error('invalid');

  const userKey = deriveKey(password, user.salt, _app.kdf);
  let token, sk;
  try {
    token = openSecretboxStr(user.wrappedToken, userKey);
    sk = openSecretbox(user.wrappedSK, userKey);
  } catch {
    throw new Error('invalid'); // неверный пароль -> расшифровка не удалась
  }

  _session = { userId, name: user.name, token, sk, userKey };
  localStorage.setItem(
    SS_KEY,
    JSON.stringify({ userId, name: user.name, token, sk: bytesToB64(sk), userKey: bytesToB64(userKey) })
  );
  return _session;
}

export function logout() {
  _session = null;
  localStorage.removeItem(SS_KEY);
}
