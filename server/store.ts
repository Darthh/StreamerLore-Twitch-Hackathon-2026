import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSeed, DEMO_PROFILE, type Snapshot } from './seed.ts';

export function createStore(filename: string, demo: boolean) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS votes (lore_id TEXT NOT NULL, voter TEXT NOT NULL, PRIMARY KEY (lore_id, voter)); CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
  db.prepare('INSERT OR IGNORE INTO metadata (key, value) VALUES (?, ?)').run('cookie_secret', randomBytes(32).toString('hex'));
  const secret = (db.prepare('SELECT value FROM metadata WHERE key = ?').get('cookie_secret') as { value: string }).value;
  const saved = db.prepare('SELECT value FROM snapshot WHERE id = 1').get() as { value: string } | undefined;
  let snapshot: Snapshot = saved ? JSON.parse(saved.value) : createSeed(demo);
  if (demo && snapshot.channel.login === 'pixelpilot') {
    Object.assign(snapshot.channel, DEMO_PROFILE);
    const rename = (value: string) => value.replace(/\bPixel\b/g, 'TheDarthh');
    snapshot.stream.summary = snapshot.stream.summary.map(rename);
    for (const moment of snapshot.moments) if (moment.source === 'demo') moment.body = rename(moment.body);
    for (const lore of snapshot.lore) if (lore.source === 'demo') { lore.explanation = rename(lore.explanation); lore.origin = rename(lore.origin); }
  }
  const save = () => db.prepare('INSERT INTO snapshot (id, value) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET value = excluded.value').run(JSON.stringify(snapshot));
  save();
  return {
    cookieSecret: Buffer.from(secret, 'hex'),
    read: (): Snapshot => structuredClone(snapshot),
    update(fn: (draft: Snapshot) => void) {
      const next = structuredClone(snapshot);
      fn(next);
      const previous = snapshot;
      snapshot = next;
      try { save(); } catch (error) { snapshot = previous; throw error; }
      return structuredClone(snapshot);
    },
    vote(id: string, voter: string) {
      const item = snapshot.lore.find(entry => entry.id === id && ['approved', 'nominated'].includes(entry.status));
      if (!item) return { error: 'That lore entry is not available for voting.', status: 404 };
      if (db.prepare('SELECT 1 FROM votes WHERE lore_id = ? AND voter = ?').get(id, voter)) return { error: 'You have already voted for this entry.', status: 409 };
      const next = structuredClone(snapshot);
      const target = next.lore.find(entry => entry.id === id)!;
      target.votes++;
      if (target.status === 'nominated' && target.votes >= 5) target.status = 'approved';
      db.exec('BEGIN');
      try {
        db.prepare('INSERT INTO votes (lore_id, voter) VALUES (?, ?)').run(id, voter);
        db.prepare('UPDATE snapshot SET value = ? WHERE id = 1').run(JSON.stringify(next));
        db.exec('COMMIT'); snapshot = next;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      return { entry: structuredClone(target) };
    },
    reset() {
      const next = createSeed(demo);
      db.exec('BEGIN');
      try {
        db.prepare('DELETE FROM votes').run();
        db.prepare('UPDATE snapshot SET value = ? WHERE id = 1').run(JSON.stringify(next));
        db.exec('COMMIT'); snapshot = next;
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    },
    close: () => db.close(),
  };
}
export type Store = ReturnType<typeof createStore>;
