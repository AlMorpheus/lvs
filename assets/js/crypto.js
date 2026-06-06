// Криптообёртки на libsodium (Argon2id + secretbox + sealed box).
// В браузере подгружаем sumo-сборку (в ней есть crypto_pwhash) через ESM CDN.
import _sodium from 'https://esm.sh/libsodium-wrappers-sumo@0.7.15';

let sodium = null;

export async function initCrypto() {
  if (sodium) return sodium;
  await _sodium.ready;
  sodium = _sodium;
  return sodium;
}

const B64 = () => sodium.base64_variants.ORIGINAL;
export const toB64 = (bytes) => sodium.to_base64(bytes, B64());
export const fromB64 = (str) => sodium.from_base64(str, B64());
const enc = (s) => sodium.from_string(s);
const dec = (b) => sodium.to_string(b);

/** Argon2id: пароль + соль (16 байт b64) -> ключ (Uint8Array). */
export function deriveKey(password, saltB64, kdf) {
  const salt = fromB64(saltB64);
  return sodium.crypto_pwhash(kdf.keyLen, password, salt, kdf.opsLimit, kdf.memLimit, kdf.alg);
}

/** Расшифровать secretbox {nonce, cipher} ключом key. Бросает исключение при неверном ключе. */
export function openSecretbox(wrapped, key) {
  const out = sodium.crypto_secretbox_open_easy(fromB64(wrapped.cipher), fromB64(wrapped.nonce), key);
  if (!out) throw new Error('decrypt-failed');
  return out;
}

/** Зашифровать строку в secretbox ключом key -> {nonce, cipher}. */
export function sealSecretbox(plainStr, key) {
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const cipher = sodium.crypto_secretbox_easy(enc(plainStr), nonce, key);
  return { nonce: toB64(nonce), cipher: toB64(cipher) };
}

export const openSecretboxStr = (wrapped, key) => dec(openSecretbox(wrapped, key));

/**
 * Зашифровать ставку для коммита в репо.
 * Возвращает объект файла: ct + nonce (сама ставка), wrapUser (ключ для автора),
 * wrapAction (ключ для бота, sealed box на публичный ключ Action).
 */
export function encryptBet(betObj, userKey, actionPubB64) {
  const betKey = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const ct = sodium.crypto_secretbox_easy(enc(JSON.stringify(betObj)), nonce, betKey);

  const wuNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const wrapUser = sodium.crypto_secretbox_easy(betKey, wuNonce, userKey);

  const wrapAction = sodium.crypto_box_seal(betKey, fromB64(actionPubB64));

  return {
    v: 1,
    ct: toB64(ct),
    nonce: toB64(nonce),
    wrapUser: toB64(wrapUser),
    wrapUserNonce: toB64(wuNonce),
    wrapAction: toB64(wrapAction),
  };
}

/** Расшифровать собственную ставку (из файла репо) ключом автора. */
export function decryptOwnBet(file, userKey) {
  const betKey = sodium.crypto_secretbox_open_easy(fromB64(file.wrapUser), fromB64(file.wrapUserNonce), userKey);
  if (!betKey) throw new Error('decrypt-failed');
  const plain = sodium.crypto_secretbox_open_easy(fromB64(file.ct), fromB64(file.nonce), betKey);
  if (!plain) throw new Error('decrypt-failed');
  return JSON.parse(dec(plain));
}

/** Расшифровать раскрытые ставки матча (общий ключ друзей SK). */
export function decryptRevealed(file, skBytes) {
  const plain = sodium.crypto_secretbox_open_easy(fromB64(file.ct), fromB64(file.nonce), skBytes);
  if (!plain) throw new Error('decrypt-failed');
  return JSON.parse(dec(plain));
}
