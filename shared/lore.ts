import type { Lore } from './types.ts';

const normalize = (value: string) => value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export function answerLoreQuestion(entries: Lore[], question: string): Lore | undefined {
  const query = ` ${normalize(question)} `;
  if (!query.trim()) return;
  return entries.filter(entry => entry.status === 'approved')
    .flatMap(entry => [entry.term, ...entry.aliases].map(alias => ({ entry, alias: normalize(alias) })))
    .filter(({ alias }) => alias && query.includes(` ${alias} `))
    .sort((a, b) => b.alias.length - a.alias.length)[0]?.entry;
}
