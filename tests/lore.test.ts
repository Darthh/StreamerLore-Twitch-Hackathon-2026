import test from 'node:test';
import assert from 'node:assert/strict';
import { answerLoreQuestion } from '../shared/lore.ts';
import { createSeed } from '../server/seed.ts';

test('viewer questions resolve approved terms and aliases without inventing answers', () => {
  const { lore } = createSeed(true);
  assert.equal(answerLoreQuestion(lore, 'Why does everyone keep saying refrigerator?')?.id, 'refrigerator');
  assert.equal(answerLoreQuestion(lore, 'What is “hold my milk”?')?.id, 'hold-the-milk');
  assert.equal(answerLoreQuestion(lore, 'Explain wall friend'), undefined);
  assert.equal(answerLoreQuestion(lore, 'What is the summit tax?'), undefined);
  assert.equal(answerLoreQuestion(lore, 'What is an unknown joke?'), undefined);
  assert.equal(answerLoreQuestion(lore, 'milkshake'), undefined);
});

test('question matching prefers the most specific phrase and handles normalized text', () => {
  const first = createSeed(true).lore[0];
  const entries = [ { ...first, id: 'short', term: 'Milk', aliases: [] }, { ...first, id: 'long', term: 'Hold the milk', aliases: [] } ];
  assert.equal(answerLoreQuestion(entries, 'Why HOLD THE MILK!?')?.id, 'long');
  assert.equal(answerLoreQuestion(entries, ''), undefined);
});
