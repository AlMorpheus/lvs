// Запись/чтение файлов в репозитории через GitHub Contents API.
// Токен передаётся в каждый вызов (он живёт только в памяти сессии, в репо его нет).

const API = 'https://api.github.com';

function utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function headers(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

/** Прочитать файл -> { text, sha } или null, если файла нет. */
export async function getFile(repo, path, token) {
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${repo.branch}`;
  const res = await fetch(url, { headers: headers(token), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub GET ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return { text: b64ToUtf8(data.content), sha: data.sha };
}

/** Список файлов в директории -> [{name, path, sha}] или [] если её нет. */
export async function getDir(repo, path, token) {
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${path}?ref=${repo.branch}`;
  const res = await fetch(url, { headers: headers(token), cache: 'no-store' });
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`GitHub GET dir ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return Array.isArray(data) ? data.map((f) => ({ name: f.name, path: f.path, sha: f.sha })) : [];
}

/** Создать/обновить файл (контент — строка). Ретрай при конфликте sha (409/422). */
export async function putFile(repo, path, contentStr, message, token) {
  const url = `${API}/repos/${repo.owner}/${repo.name}/contents/${path}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    let sha;
    try {
      const existing = await getFile(repo, path, token);
      sha = existing?.sha;
    } catch {
      sha = undefined;
    }
    const body = { message, content: utf8ToB64(contentStr), branch: repo.branch };
    if (sha) body.sha = sha;

    const res = await fetch(url, { method: 'PUT', headers: headers(token), body: JSON.stringify(body) });
    if (res.ok) return await res.json();
    if (res.status === 409 || res.status === 422) continue; // sha устарел — перечитаем и повторим
    throw new Error(`GitHub PUT ${res.status}: ${await res.text()}`);
  }
  throw new Error('GitHub PUT: не удалось после нескольких попыток');
}

/** Проверка валидности токена (на форме настройки/диагностики). */
export async function checkToken(repo, token) {
  const res = await fetch(`${API}/repos/${repo.owner}/${repo.name}`, { headers: headers(token), cache: 'no-store' });
  return res.ok;
}
