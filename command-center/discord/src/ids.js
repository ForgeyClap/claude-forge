import crypto from 'node:crypto';

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

export function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}
