import fs from 'node:fs';
import path from 'node:path';

// Idee H: project-geheugen op lange termijn. Per project een kort, leesbaar
// .txt-bestand met wat er is gebeurd en besloten. Dat wordt bij een VERSE sessie
// meegegeven, zodat de eigenaar niet steeds context hoeft te herhalen.
// Bewust plat en kort: het gaat mee in elke prompt, dus geen roman.
const MAX_ENTRIES = 40;
const MAX_CHARS = 2500;

export class ProjectMemory {
  constructor({ baseDir, audit, now = () => Date.now() }) {
    this.baseDir = baseDir;
    this.audit = audit;
    this.now = now;
  }

  #file(projectId) {
    return path.join(this.baseDir, projectId, 'FORGE_GESCHIEDENIS.txt');
  }

  read(projectId) {
    try {
      return fs.readFileSync(this.#file(projectId), 'utf8');
    } catch {
      return '';
    }
  }

  // Compacte samenvatting voor de systeemprompt (nieuwste bovenaan, afgekapt).
  summary(projectId) {
    const raw = this.read(projectId);
    if (!raw.trim()) return '';
    const lines = raw.split('\n').filter((l) => l.trim().startsWith('- '));
    const recent = lines.slice(-12).reverse();
    if (recent.length === 0) return '';
    return `Eerdere opdrachten in dit project (nieuwste eerst):\n${recent.join('\n')}`.slice(
      0,
      MAX_CHARS,
    );
  }

  // Eén regel per afgeronde opdracht: datum, wat gevraagd is, wat eruit kwam.
  append(projectId, { prompt, answer, ok = true }) {
    if (!projectId) return null;
    const file = this.#file(projectId);
    const stamp = new Date(this.now()).toISOString().slice(0, 16).replace('T', ' ');
    const kort = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
    const line = `- [${stamp}] ${ok ? '' : '(mislukt) '}"${kort(prompt, 90)}" -> ${kort(answer, 150)}`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const existing = this.read(projectId);
      const header = existing
        ? existing.split('\n').filter((l) => !l.trim().startsWith('- ')).join('\n')
        : [
            'FORGE PROJECT-GESCHIEDENIS',
            'Automatisch bijgehouden door de Discord-bot. Nieuwste onderaan.',
            'Dit bestand wordt bij een nieuw gesprek als context meegegeven.',
            '',
          ].join('\n');
      const entries = existing.split('\n').filter((l) => l.trim().startsWith('- '));
      entries.push(line);
      const kept = entries.slice(-MAX_ENTRIES);
      fs.writeFileSync(file, `${header.trimEnd()}\n${kept.join('\n')}\n`, 'utf8');
      this.audit?.record('project_memory_appended', { projectId, entries: kept.length });
      return line;
    } catch (err) {
      this.audit?.record('project_memory_failed', {
        projectId,
        error: String(err?.message ?? err),
      });
      return null;
    }
  }
}
