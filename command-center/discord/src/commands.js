import { QueueState } from './queue.js';
import { MODELS, EFFORTS } from './runner-claude.js';
import { SubscriptionUsage } from './subscription-usage.js';
import { scanRecent, formatDiff } from './project-diff.js';
import { describeSchedule } from './schedules.js';

const HELP = [
  '**Forge-commando\'s in deze thread:**',
  '`/forge status` — actieve runs + wachtrij-diepte',
  '`/forge queue` — open items in deze thread',
  '`/forge stop` — stop de actieve run (checkpoint bewaard)',
  '`/forge interrupt` — stop + eerstvolgende prompt krijgt voorrang',
  '`/forge confirm <item>` — bevestig een oude (>expiry) opdracht',
  '`/forge retry <item>` — zet een gefaald item terug in de wachtrij',
  '`/forge remove <item>` — verwijder een wachtend item',
  '`/forge resend <delivery>` — verstuur een mislukt eindrapport opnieuw',
  '`/forge newproject <naam>` — maak projectmap + kanaal aan',
  '`/forge write on|off` — schrijfrechten voor dit project (bestanden aanmaken/wijzigen)',
  '`/forge model <fable|opus|sonnet|haiku>` — model voor dit project',
  '`/forge effort <low|medium|high|xhigh|max>` — denkdiepte voor dit project',
  '`/forge usage [uren]` — abonnement-verbruik + wat deze bot verbruikte',
  '`/forge diff [uren]` — welke bestanden zijn er echt gewijzigd',
  '`/forge reset` — chat nu opruimen (transcript wordt bewaard)',
  '`/forge session reset` — start een vers gesprek in dit kanaal',
  '`/forge schedule <elke dag|maandag|…> <uu:mm> <opdracht>` — plan een opdracht',
  '`/forge schedules` — geplande opdrachten (en `/forge unschedule <id>`)',
  '`/forge briefing` — stuur de dagbriefing nu',
  '`/forge pause` / `/forge resume` — bot handmatig pauzeren of hervatten',
  '`/forge memory` — wat ik van dit project onthouden heb',
  '`/forge help` — dit overzicht',
].join('\n');

// Item-ID's zijn lang; owners mogen een unieke prefix typen.
function findByPrefix(list, idPrefix) {
  const matches = list.filter((x) => x.id.startsWith(idPrefix));
  return matches.length === 1 ? matches[0] : null;
}

export function isCommand(content) {
  return typeof content === 'string' && content.trim().startsWith('/forge');
}

// Wordt door de gateway aangeroepen NA permission- en route-checks.
export async function handleCommand({ msg, gateway, replyFn = null }) {
  const { queue, scheduler, outbox, transport } = gateway;
  const reply = (text) => (replyFn ? replyFn(text) : transport.send(msg.threadId, text));
  const parts = msg.content.trim().split(/\s+/);
  const cmd = parts[1] ?? 'help';
  const arg = parts.slice(2).join(' '); // meerwoordige argumenten (bv. newproject Super Bot)

  switch (cmd) {
    case 'status': {
      const s = gateway.status();
      const depth = Object.entries(s.queueDepth)
        .map(([k, v]) => `${k}:${v}`)
        .join(' · ') || 'leeg';
      await reply(`Status — actieve runs: ${s.activeRuns} · wachtrij: ${depth}`);
      return { handled: true, command: 'status' };
    }
    case 'queue': {
      const open = queue.items.filter(
        (i) =>
          i.threadId === msg.threadId &&
          [QueueState.QUEUED, QueueState.WAITING_FOR_CONFIRMATION, QueueState.RUNNING, QueueState.STARTING, QueueState.FAILED, QueueState.DEAD_LETTER].includes(i.state),
      );
      // Max 10 tonen: anders loopt het bericht over de Discord-limiet.
      const shown = open.slice(-10);
      await reply(
        shown.length
          ? shown.map((i) => `\`${i.id.slice(0, 12)}…\` ${i.state} — ${i.content.slice(0, 55)}`).join('\n') +
              (open.length > shown.length ? `\n_…en ${open.length - shown.length} ouder(e) items_` : '')
          : 'Wachtrij voor deze thread is leeg.',
      );
      return { handled: true, command: 'queue' };
    }
    case 'stop': {
      const stopped = scheduler.stop(msg.threadId);
      await reply(stopped ? 'Run gestopt — checkpoint bewaard.' : 'Geen actieve run in deze thread.');
      return { handled: true, command: 'stop' };
    }
    case 'interrupt': {
      const stopped = scheduler.interrupt(msg.threadId);
      await reply(
        stopped
          ? 'Run onderbroken. Stuur je correctie-prompt; die krijgt voorrang.'
          : 'Geen actieve run om te onderbreken.',
      );
      return { handled: true, command: 'interrupt' };
    }
    case 'confirm': {
      const item = findByPrefix(queue.items, arg);
      const ok = item && queue.confirm(item.id);
      if (ok) scheduler.tick();
      await reply(ok ? `Bevestigd — \`${item.id.slice(0, 12)}…\` staat in de wachtrij.` : 'Item niet gevonden (of niet in bevestig-status). Gebruik `/forge queue`.');
      return { handled: true, command: 'confirm' };
    }
    case 'retry': {
      const item = findByPrefix(queue.items, arg);
      const ok = item && queue.requeue(item.id);
      if (ok) scheduler.tick();
      await reply(ok ? `Opnieuw in wachtrij: \`${item.id.slice(0, 12)}…\`` : 'Item niet gevonden of niet in FAILED-status.');
      return { handled: true, command: 'retry' };
    }
    case 'remove': {
      const item = findByPrefix(queue.items, arg);
      const ok = item && queue.remove(item.id);
      await reply(ok ? `Verwijderd: \`${item.id.slice(0, 12)}…\`` : 'Item niet gevonden of niet meer open.');
      return { handled: true, command: 'remove' };
    }
    case 'resend': {
      const delivery = findByPrefix(outbox.list(), arg);
      const res = delivery && (await outbox.resend(delivery.id));
      await reply(
        res
          ? `Resend → status: ${res.delivery.state}`
          : 'Delivery niet gevonden of niet in een herzendbare status.',
      );
      return { handled: true, command: 'resend' };
    }
    case 'newproject': {
      if (!gateway.projectSync) {
        await reply('Projectsync is niet actief op deze service.');
        return { handled: true, command: 'newproject' };
      }
      try {
        const project = await gateway.projectSync.createProject(arg);
        await reply(
          `Project aangemaakt ✅ — <#${project.forumChannelId}> → \`${project.path}\``,
        );
      } catch (err) {
        await reply(`Aanmaken mislukt: ${String(err?.message ?? err)}`);
      }
      return { handled: true, command: 'newproject' };
    }
    case 'write': {
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      if (!route?.projectId) {
        await reply('Kon het project van dit kanaal niet bepalen.');
        return { handled: true, command: 'write' };
      }
      if (arg !== 'on' && arg !== 'off') {
        const p = gateway.router.projects.find((x) => x.projectId === route.projectId);
        await reply(
          `Schrijfmodus voor \`${route.projectId}\`: **${p?.permissionMode === 'acceptEdits' ? 'AAN' : 'UIT'}** — gebruik \`/forge write on\` of \`/forge write off\`.`,
        );
        return { handled: true, command: 'write' };
      }
      const mode = arg === 'on' ? 'acceptEdits' : 'default';
      gateway.router.setPermissionMode(route.projectId, mode);
      await reply(
        arg === 'on'
          ? `🔓 Schrijfmodus AAN voor \`${route.projectId}\` — runs mogen nu bestanden aanmaken/wijzigen in de projectmap.`
          : `🔒 Schrijfmodus UIT voor \`${route.projectId}\` — runs zijn weer read-only.`,
      );
      return { handled: true, command: 'write' };
    }
    case 'model':
    case 'effort': {
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      const project = gateway.router.projects.find((p) => p.projectId === route?.projectId);
      if (!project) {
        await reply('Kon het project van dit kanaal niet bepalen.');
        return { handled: true, command: cmd };
      }
      const allowed = cmd === 'model' ? Object.keys(MODELS) : EFFORTS;
      if (!allowed.includes(arg)) {
        const current = project[cmd] ?? '(standaard)';
        await reply(
          `${cmd === 'model' ? 'Model' : 'Effort'} voor \`${project.projectId}\`: **${current}**\nKies uit: ${allowed.map((a) => `\`${a}\``).join(' · ')}`,
        );
        return { handled: true, command: cmd };
      }
      gateway.router.setRunOption(project.projectId, cmd, arg);
      await reply(
        `✅ ${cmd === 'model' ? 'Model' : 'Effort'} voor \`${project.projectId}\` staat nu op **${arg}** (geldt vanaf de volgende opdracht).`,
      );
      return { handled: true, command: cmd };
    }
    case 'usage': {
      const hours = Number.parseInt(arg, 10) || 24;
      const blocks = [];
      // 1) Abonnement (dezelfde bron als /usage in Claude Code).
      if (gateway.subscriptionUsage) {
        const sub = await gateway.subscriptionUsage.get();
        blocks.push(`📊 **Abonnement**\n${SubscriptionUsage.format(sub)}`);
      }
      // 2) Wat deze bot zelf heeft verbruikt.
      if (gateway.usage) {
        const s = gateway.usage.summary({ sinceMs: hours * 3600 * 1000 });
        const perProject = Object.entries(s.perProject)
          .sort((a, b) => b[1].runs - a[1].runs)
          .slice(0, 5)
          .map(([id, v]) => `• ${id}: ${v.runs}${v.costUsd ? ` ($${v.costUsd.toFixed(2)})` : ''}`)
          .join('\n');
        blocks.push(
          [
            `🤖 **Deze bot, laatste ${hours} uur**`,
            `runs: ${s.runs} · rekentijd: ${s.totalMinutes} min`,
            s.costUsd ? `kosten: $${s.costUsd}` : 'kosten: via abonnement',
            `tokens in/uit: ${s.inputTokens.toLocaleString('nl-NL')} / ${s.outputTokens.toLocaleString('nl-NL')}`,
            perProject,
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      await reply(blocks.join('\n\n') || 'Geen verbruiksgegevens beschikbaar.');
      return { handled: true, command: 'usage' };
    }
    case 'diff': {
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      const project = gateway.router.projects.find((p) => p.projectId === route?.projectId);
      const hours = Number.parseInt(arg, 10) || 1;
      if (!project?.path) {
        await reply('Dit kanaal heeft geen projectmap.');
        return { handled: true, command: 'diff' };
      }
      const files = scanRecent(project.path, { sinceMs: hours * 3600 * 1000 });
      await reply(formatDiff(project, files, { hours }));
      return { handled: true, command: 'diff' };
    }
    case 'reset': {
      if (!gateway.chatReset) {
        await reply('Chat-reset is niet actief op deze service.');
        return { handled: true, command: 'reset' };
      }
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      const project = gateway.router.projects.find((p) => p.projectId === route?.projectId);
      // Eerst antwoorden (de purge wist straks ook dit kanaal, inclusief een
      // deferred slash-antwoord), daarna opruimen.
      await reply('🧹 Opruimen gestart — het transcript komt hieronder in de chat.');
      const res = await gateway.chatReset.resetChannel(project);
      if (res.skipped) {
        await gateway.transport
          .send(
            msg.threadId,
            res.reason === 'busy'
              ? '⏸️ Nu niet: er loopt een opdracht in dit kanaal. Ik ruim automatisch op zodra hij klaar is.'
              : `Niets opgeruimd (${res.reason}).`,
          )
          .catch(() => {});
      }
      return { handled: true, command: 'reset' };
    }
    case 'schedule': {
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      if (!gateway.schedules || !route?.projectId) {
        await reply('Plannen kan hier niet (geen project of planner actief).');
        return { handled: true, command: 'schedule' };
      }
      const created = gateway.schedules.add({
        threadId: msg.threadId,
        channelId: msg.channelId,
        projectId: route.projectId,
        senderId: msg.senderId,
        input: arg,
      });
      await reply(
        created
          ? `🗓️ Gepland: **${describeSchedule(created)}** — "${created.prompt.slice(0, 80)}"\nID: \`${created.id.slice(0, 12)}\``
          : 'Kon dat niet lezen. Voorbeeld: `/forge schedule elke dag 08:00 draai de tests` of `/forge schedule maandag 9:00 maak een rapport`.',
      );
      return { handled: true, command: 'schedule' };
    }
    case 'schedules': {
      const list = gateway.schedules?.list(msg.threadId) ?? [];
      await reply(
        list.length
          ? list
              .map((s) => `\`${s.id.slice(0, 12)}\` ${describeSchedule(s)} — ${s.prompt.slice(0, 60)}`)
              .join('\n')
          : 'Nog niets gepland in dit kanaal.',
      );
      return { handled: true, command: 'schedules' };
    }
    case 'unschedule': {
      const removed = gateway.schedules?.remove(arg);
      await reply(removed ? `🗑️ Verwijderd: ${describeSchedule(removed)}` : 'Geen planning met dat ID gevonden.');
      return { handled: true, command: 'unschedule' };
    }
    case 'briefing': {
      if (!gateway.briefing) {
        await reply('Briefing is niet actief op deze service.');
        return { handled: true, command: 'briefing' };
      }
      const text = await gateway.briefing.build();
      await reply(text);
      return { handled: true, command: 'briefing' };
    }
    case 'pause': {
      if (!gateway.usageGuard) {
        await reply('Pauzeren is niet beschikbaar.');
        return { handled: true, command: 'pause' };
      }
      gateway.usageGuard.pauseManually();
      await reply('⏸️ Gepauzeerd. Nieuwe opdrachten blijven in de wachtrij tot `/forge resume`.');
      return { handled: true, command: 'pause' };
    }
    case 'resume': {
      if (!gateway.usageGuard) {
        await reply('Hervatten is niet beschikbaar.');
        return { handled: true, command: 'resume' };
      }
      gateway.usageGuard.resumeManually();
      gateway.scheduler.tick();
      await reply('▶️ Hervat — ik pak de wachtrij weer op.');
      return { handled: true, command: 'resume' };
    }
    case 'memory': {
      const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
      const text = gateway.projectMemory?.summary(route?.projectId) ?? '';
      await reply(
        text
          ? `🧠 **Wat ik van dit project weet**\n${text.slice(0, 1500)}`
          : 'Nog geen geschiedenis voor dit project — die bouw ik op na je eerste opdrachten.',
      );
      return { handled: true, command: 'memory' };
    }
    case 'session': {
      if (arg === 'reset' && gateway.sessionStore) {
        const route = gateway.router.resolveRoute({ channelId: msg.channelId, threadId: msg.threadId });
        if (route?.conversationId) gateway.sessionStore.clear(route.conversationId);
        await reply('Gespreksgeheugen gewist — volgende prompt start een vers gesprek.');
      } else {
        await reply('Gebruik: `/forge session reset`');
      }
      return { handled: true, command: 'session' };
    }
    default: {
      await reply(HELP);
      return { handled: true, command: 'help' };
    }
  }
}
