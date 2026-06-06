// Разовая настройка турнира (запускается ЛОКАЛЬНО организатором).
//
//   1) создай GitHub fine-grained токен (доступ только к этому репо, Contents: read & write)
//   2) впиши имена участников в config/participants.json  (массив строк)
//   3) запусти:   GH_TOKEN=github_pat_xxx  node scripts/setup.mjs
//
// Скрипт:
//   • генерирует пару ключей бота и общий ключ друзей (SK);
//   • на каждого участника создаёт сильный пароль, шифрует токен и SK под него;
//   • пишет config/users.json и обновляет config/app.json (публичный ключ бота);
//   • кладёт логины/пароли и серверные секреты в SECRETS.txt (он в .gitignore).
//
// Токен в открытом виде в репозиторий НЕ попадает.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// ESM-сборка libsodium-sumo в npm битая — грузим CJS-вариант.
const require = createRequire(import.meta.url);
const _sodium = require('libsodium-wrappers-sumo');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...x) => join(ROOT, ...x);

await _sodium.ready;
const sodium = _sodium;
const B64 = sodium.base64_variants.ORIGINAL;
const toB64 = (b) => sodium.to_base64(b, B64);

function translit(s) {
  const m = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
  return s.toLowerCase().split('').map((c) => (m[c] != null ? m[c] : c)).join('').replace(/[^a-z0-9]+/g, '').slice(0, 16);
}

const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // без похожих символов
function password() {
  const need = 8;
  const bytes = sodium.randombytes_buf(need);
  let s = '';
  for (let i = 0; i < need; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.match(/.{1,4}/g).join('-'); // xxxx-xxxx (короткий, удобный для ввода)
}

function wrap(plainBytesOrStr, key) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const msg = typeof plainBytesOrStr === 'string' ? sodium.from_string(plainBytesOrStr) : plainBytesOrStr;
  const cipher = sodium.crypto_secretbox_easy(msg, nonce, key);
  return { nonce: toB64(nonce), cipher: toB64(cipher) };
}

async function getToken() {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN.trim();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const t = (await rl.question('Вставь GitHub fine-grained токен: ')).trim();
  rl.close();
  return t;
}

// ---------- участники ----------
const partFile = p('config/participants.json');
if (!existsSync(partFile)) {
  console.error('Нет config/participants.json. Создай его: ["Имя1","Имя2", ...]');
  process.exit(1);
}
const names = JSON.parse(readFileSync(partFile, 'utf8'));
if (!Array.isArray(names) || !names.length) {
  console.error('config/participants.json должен быть непустым массивом имён.');
  process.exit(1);
}

const token = await getToken();
if (!token || !/^github_pat_|^ghp_/.test(token)) {
  console.error('Похоже, это не GitHub токен. Прерываю.');
  process.exit(1);
}

const app = JSON.parse(readFileSync(p('config/app.json'), 'utf8'));
const kdf = app.kdf;

// ключи бота + общий ключ друзей
const botKeys = sodium.crypto_box_keypair();
const SK = sodium.crypto_secretbox_keygen();

const usedIds = new Set();
const users = [];
const creds = [];

for (let i = 0; i < names.length; i++) {
  const name = String(names[i]).trim();
  let id = translit(name) || `u${i + 1}`;
  while (usedIds.has(id)) id += (i + 1);
  usedIds.add(id);

  const pass = password();
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const userKey = sodium.crypto_pwhash(kdf.keyLen, pass, salt, kdf.opsLimit, kdf.memLimit, kdf.alg);

  users.push({
    id,
    name,
    salt: toB64(salt),
    wrappedToken: wrap(token, userKey),
    wrappedSK: wrap(SK, userKey),
  });
  creds.push({ id, name, pass });
}

// записать config/users.json
writeFileSync(p('config/users.json'), JSON.stringify({ users }, null, 2) + '\n');

// обновить публичный ключ бота в app.json
app.actionPublicKey = toB64(botKeys.publicKey);
writeFileSync(p('config/app.json'), JSON.stringify(app, null, 2) + '\n');

// SECRETS.txt (в .gitignore — НЕ коммитить)
let out = '';
out += '════════════════════════════════════════════════════════\n';
out += '  СЕКРЕТЫ ТУРНИРА — НЕ КОММИТЬ В РЕПОЗИТОРИЙ\n';
out += '════════════════════════════════════════════════════════\n\n';
out += '── Логины и пароли участников (раздай каждому лично) ──\n\n';
for (const c of creds) out += `${c.name}\n  логин:  ${c.id}\n  пароль: ${c.pass}\n\n`;
out += '\n── Секреты для GitHub → Settings → Secrets and variables → Actions ──\n\n';
out += `ACTION_PRIVATE_KEY = ${toB64(botKeys.privateKey)}\n`;
out += `SHARED_KEY         = ${toB64(SK)}\n`;
out += `API_FOOTBALL_KEY   = <вставь свой ключ с dashboard.api-football.com>\n`;
writeFileSync(p('SECRETS.txt'), out);

console.log('\n✅ Готово.');
console.log('   • config/users.json и config/app.json обновлены (можно коммитить).');
console.log('   • SECRETS.txt создан (НЕ коммить — он уже в .gitignore).');
console.log('   • Добавь ACTION_PRIVATE_KEY, SHARED_KEY, API_FOOTBALL_KEY в секреты репозитория.');
console.log(`   • Участников: ${users.length}.`);
