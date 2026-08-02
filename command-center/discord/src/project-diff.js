import fs from 'node:fs';
import path from 'node:path';

// "Wat heb je nou eigenlijk gedaan?" — toont de recentst gewijzigde bestanden in
// een projectmap, in platte taal. Geen git nodig (veel projecten zijn geen repo).
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.claude-flow', 'dist', 'build', '.next', 'coverage',
  'temporary screenshots', 'state', 'transcripts', '.cache', 'venv', '__pycache__',
]);

export function scanRecent(dir, { sinceMs = 3600 * 1000, max = 20, now = Date.now } = {}) {
  const cutoff = now() - sinceMs;
  const found = [];
  const walk = (current, depth = 0) => {
    if (depth > 6 || found.length > 500) return;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env.example') continue;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name)) continue;
        walk(path.join(current, e.name), depth + 1);
        continue;
      }
      const full = path.join(current, e.name);
      try {
        const st = fs.statSync(full);
        if (st.mtimeMs >= cutoff) {
          found.push({ file: path.relative(dir, full), mtime: st.mtimeMs, size: st.size });
        }
      } catch {
        // bestand verdween tussendoor
      }
    }
  };
  walk(dir);
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, max);
}

export function formatDiff(project, files, { hours, now = Date.now } = {}) {
  if (!project?.path) return 'Dit kanaal heeft geen projectmap.';
  if (files.length === 0) return `Geen bestandswijzigingen in \`${project.projectId}\` in de laatste ${hours} uur.`;
  const ago = (ms) => {
    const m = Math.round((now() - ms) / 60000);
    return m < 60 ? `${m}m geleden` : `${Math.round(m / 60)}u geleden`;
  };
  const kb = (b) => (b < 1024 ? `${b} B` : `${Math.round(b / 1024)} KB`);
  const lines = files.slice(0, 12).map((f) => `• ${f.file} — ${kb(f.size)}, ${ago(f.mtime)}`);
  const rest = files.length > 12 ? `\n…en nog ${files.length - 12} bestanden` : '';
  return `📝 **Gewijzigd in ${project.projectId}** (laatste ${hours} uur)\n${lines.join('\n')}${rest}`;
}
