import fs from 'node:fs';
import path from 'node:path';

// Atomic JSON-bestandsopslag: schrijf naar .tmp en rename, zodat een crash
// nooit een half geschreven state-bestand achterlaat.
export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
  }

  load(fallback) {
    try {
      // BOM-tolerant: externe tools (bv. PowerShell) schrijven soms UTF-8-met-BOM.
      return JSON.parse(fs.readFileSync(this.filePath, 'utf8').replace(/^﻿/, ''));
    } catch (err) {
      if (err.code === 'ENOENT') return structuredClone(fallback);
      throw err;
    }
  }

  save(data) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.filePath);
  }
}

// Append-only JSONL-log (audit ledger, processed-message ledger).
export class JsonlLog {
  constructor(filePath) {
    this.filePath = filePath;
  }

  append(entry) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`);
  }

  readAll() {
    try {
      return fs
        .readFileSync(this.filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
  }
}
