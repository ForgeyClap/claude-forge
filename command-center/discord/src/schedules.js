import path from 'node:path';
import { JsonStore } from './store.js';
import { newId } from './ids.js';

// Idee J: agenda-triggers. "Elke maandag 09:00: draai de tests" of "elke dag 20:00".
// Bewust simpel en voorspelbaar (geen volledige cron-syntax): dagelijks of op een
// vaste weekdag, op een heel uur/minuut. De opdracht loopt daarna door de normale
// pijplijn, dus wachtrij, permissies en usage-guard gelden onverkort.
const DAGEN = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

// "elke dag 08:00 <prompt>" of "maandag 9:00 <prompt>" of "09:00 <prompt>"
export function parseSchedule(input) {
  const text = String(input ?? '').trim();
  const m = text.match(/^(?:(elke\s+dag|dagelijks|[a-z]+dag|zondag)\s+)?(\d{1,2})[:.](\d{2})\s+(.+)$/is);
  if (!m) return null;
  const [, dagRaw, uurRaw, minuutRaw, prompt] = m;
  const hour = Number(uurRaw);
  const minute = Number(minuutRaw);
  if (hour > 23 || minute > 59) return null;
  let weekday = null; // null = elke dag
  if (dagRaw && !/elke\s+dag|dagelijks/i.test(dagRaw)) {
    const idx = DAGEN.indexOf(dagRaw.toLowerCase());
    if (idx === -1) return null;
    weekday = idx;
  }
  return { weekday, hour, minute, prompt: prompt.trim() };
}

export function describeSchedule(s) {
  const wanneer = s.weekday === null ? 'elke dag' : `elke ${DAGEN[s.weekday]}`;
  return `${wanneer} om ${String(s.hour).padStart(2, '0')}:${String(s.minute).padStart(2, '0')}`;
}

export function isDue(schedule, date, lastRunKey) {
  if (schedule.weekday !== null && date.getDay() !== schedule.weekday) return false;
  if (date.getHours() !== schedule.hour) return false;
  if (date.getMinutes() < schedule.minute || date.getMinutes() > schedule.minute + 10) return false;
  const key = `${date.toISOString().slice(0, 10)}-${schedule.hour}`;
  return key !== lastRunKey ? key : false;
}

export class Schedules {
  constructor({ stateDir, audit, onFire, now = () => Date.now() }) {
    this.store = new JsonStore(path.join(stateDir, 'schedules.json'));
    this.audit = audit;
    this.onFire = onFire;
    this.now = now;
    this.data = this.store.load({ items: [] });
    this.timer = null;
  }

  list(threadId = null) {
    return this.data.items.filter((s) => !threadId || s.threadId === threadId);
  }

  add({ threadId, channelId, projectId, senderId, input }) {
    const parsed = parseSchedule(input);
    if (!parsed) return null;
    const item = {
      id: newId('sch'),
      threadId,
      channelId,
      projectId,
      senderId,
      ...parsed,
      createdAt: this.now(),
      lastRunKey: null,
    };
    this.data.items.push(item);
    this.store.save(this.data);
    this.audit?.record('schedule_added', { id: item.id, projectId, when: describeSchedule(item) });
    return item;
  }

  remove(idPrefix) {
    const found = this.data.items.filter((s) => s.id.startsWith(idPrefix));
    if (found.length !== 1) return null;
    this.data.items = this.data.items.filter((s) => s.id !== found[0].id);
    this.store.save(this.data);
    this.audit?.record('schedule_removed', { id: found[0].id });
    return found[0];
  }

  // Elke 5 minuten kijken wat er aan de beurt is.
  tick() {
    const date = new Date(this.now());
    const fired = [];
    for (const s of this.data.items) {
      const key = isDue(s, date, s.lastRunKey);
      if (!key) continue;
      s.lastRunKey = key;
      fired.push(s);
    }
    if (fired.length) {
      this.store.save(this.data);
      for (const s of fired) {
        this.audit?.record('schedule_fired', { id: s.id, projectId: s.projectId });
        this.onFire?.(s);
      }
    }
    return fired;
  }

  start() {
    this.stop();
    this.timer = setInterval(() => this.tick(), 5 * 60 * 1000);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
