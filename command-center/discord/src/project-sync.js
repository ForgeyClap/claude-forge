import fs from 'node:fs';
import path from 'node:path';
import { friendlyError } from './friendly-error.js';

// Houdt projectmappen en Discord-kanalen in sync, twee kanten op:
//  - nieuwe map in projectsDir → kanaal + mapping (automatisch, periodiek)
//  - /forge newproject <naam> → map + kanaal + mapping
// channelOps is injecteerbaar (echte DiscordAdmin of een fake in tests).
export const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 90);

export class ProjectSync {
  constructor({ projectsDir, router, audit, channelOps, announce = null }) {
    this.projectsDir = projectsDir;
    this.router = router;
    this.audit = audit;
    this.channelOps = channelOps;
    this.announce = announce;
    this.timer = null;
    // project + reden die de eigenaar al gemeld kreeg: dezelfde weigering wordt niet elke minuut herhaald.
    this.reportedFailures = new Set();
  }

  listProjectDirs() {
    return fs
      .readdirSync(this.projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => d.name);
  }

  // Forge-modus: het project heeft een eigen /forge-installatie → prompts gaan
  // door het Forge-systeem (agents) i.p.v. kale Claude.
  detectForgeMode(projectPath) {
    return fs.existsSync(path.join(projectPath, '.claude', 'commands', 'forge.md'));
  }

  // verifyChannels=true (startup): elk kanaal echt bij Discord controleren/helen.
  // verifyChannels=false (periodiek): alleen Discord-calls voor NIEUWE mappen —
  // steady-state kost de sync dan nul API-verkeer (rate-limit-veilig).
  async syncOnce({ verifyChannels = false, archiveOrphans = false } = {}) {
    const added = [];
    // Bij het opstarten: projecten zonder bestaande map (oude testkanalen buiten
    // de categorie) archiveren, zodat de bot alleen in echte projectkanalen werkt.
    if (archiveOrphans) {
      for (const p of this.router.projects) {
        if (!p.archived && (!p.path || !fs.existsSync(p.path))) {
          this.router.archiveProject(p.projectId);
          this.audit?.record('project_archived_missing_folder', { projectId: p.projectId });
        }
      }
    }
    for (const dir of this.listProjectDirs()) {
      const projectId = slugify(dir);
      if (!projectId) continue;
      const projectPath = path.join(this.projectsDir, dir);
      const forgeMode = this.detectForgeMode(projectPath);
      const existing = this.router.projects.find((p) => p.projectId === projectId);

      let channelId = existing?.forumChannelId ?? null;
      let created = false;
      let migrated = false;
      if (this.channelOps && (!channelId || verifyChannels)) {
        // knownChannelId meegeven: lookup gaat op ID (naam kan een 🔴/🟢-prefix
        // hebben), zodat er nooit een duplicaat-kanaal wordt aangemaakt.
        // Een weigering van Discord voor ÉÉN project (bv. 50013 Missing Permissions: de bot mag geen kanalen
        // maken) mag de sync van de andere projecten niet afbreken en de bot nooit laten crashen (live gevonden
        // 2026-09-28: een niet-opgevangen 403 bij het opstarten legde de hele bot plat). Het project wordt
        // overgeslagen; de volgende sync probeert het stil opnieuw, zodat het vanzelf lukt zodra het recht er is.
        let res;
        try {
          res = await this.channelOps.ensureTextChannel(projectId, { knownChannelId: channelId });
        } catch (err) {
          this.#reportFailure(projectId, dir, err);
          continue;
        }
        this.#clearFailures(projectId);
        ({ created } = res);
        migrated = res.migrated ?? false;
        channelId = res.channelId;
      }
      if (!channelId) continue;

      this.router.registerProject({ projectId, name: dir, forumChannelId: channelId, path: projectPath, forgeMode });
      if (this.router.projects.find((p) => p.projectId === projectId)?.archived) {
        this.router.reactivateProject(projectId);
      }
      if (created || migrated) {
        added.push({ projectId, channelId, migrated });
        this.audit?.record('project_autosynced', { projectId, channelId, migrated });
        await this.announce?.(
          migrated
            ? `Kanaal omgezet naar chat: <#${channelId}> (\`${dir}\`)`
            : `Nieuw project gekoppeld: <#${channelId}> → \`${dir}\``,
        )?.catch?.(() => {});
      }
    }
    return added;
  }

  async createProject(rawName) {
    const projectId = slugify(rawName);
    if (!projectId || projectId.length < 2) {
      throw new Error(`Ongeldige projectnaam: "${rawName}" (gebruik letters/cijfers/koppeltekens)`);
    }
    const projectPath = path.join(this.projectsDir, projectId);
    if (fs.existsSync(projectPath)) throw new Error(`Map bestaat al: ${projectPath}`);
    fs.mkdirSync(projectPath, { recursive: true });
    this.audit?.record('project_folder_created', { projectId, path: projectPath });
    await this.syncOnce();
    const project = this.router.projects.find((p) => p.projectId === projectId);
    if (!project) throw new Error('Sync na aanmaken mislukt — kanaal niet geregistreerd');
    return project;
  }

  // Eén keer per project en reden melden (log + #forge-info); een latere, andere reden wordt wel weer gemeld.
  #reportFailure(projectId, dir, err) {
    const reason = friendlyError(err);
    this.audit?.record('project_sync_failed', { projectId, error: reason });
    const key = `${projectId}\u0000${reason}`;
    if (this.reportedFailures.has(key)) return;
    this.reportedFailures.add(key);
    console.log(`[forge-discord] projectsync: kanaal voor "${dir}" niet gemaakt — ${reason}`);
    this.announce?.(`Kon geen kanaal maken voor \`${dir}\`: ${reason}`)?.catch?.(() => {});
  }

  #clearFailures(projectId) {
    for (const key of this.reportedFailures) if (key.startsWith(`${projectId}\u0000`)) this.reportedFailures.delete(key);
  }

  start(intervalMs = 60_000) {
    this.stop();
    this.timer = setInterval(() => {
      this.syncOnce().catch((err) =>
        this.audit?.record('project_sync_error', { error: String(err?.message ?? err) }),
      );
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    this.#watchFolder();
  }

  // Directe detectie: fs.watch reageert binnen enkele seconden op een nieuwe map
  // (de interval-sync blijft als vangnet voor gemiste events).
  #watchFolder() {
    try {
      this.watcher = fs.watch(this.projectsDir, { persistent: false }, () => {
        clearTimeout(this.debounce);
        this.debounce = setTimeout(() => {
          this.syncOnce().catch((err) =>
            this.audit?.record('project_sync_error', { error: String(err?.message ?? err) }),
          );
        }, 2500); // debounce: map-aanmaak geeft meerdere events
      });
      this.audit?.record('project_folder_watch_started', { dir: this.projectsDir });
    } catch (err) {
      this.audit?.record('project_folder_watch_failed', { error: String(err?.message ?? err) });
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    clearTimeout(this.debounce);
    this.watcher?.close?.();
    this.watcher = null;
  }
}
