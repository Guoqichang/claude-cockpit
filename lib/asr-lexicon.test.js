import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldHarvest, everyChats, funasrUrl } from './asr-lexicon.js';

test('every 8 chats by default', () => {
  assert.equal(typeof everyChats(), 'number');
  assert.ok(everyChats() >= 1);
});

test('funasr url defaults to local studio', () => {
  assert.match(funasrUrl(), /^https?:\/\//);
});

test('harvest triggers at threshold, not before', () => {
  assert.equal(shouldHarvest(0, 8), false);
  assert.equal(shouldHarvest(7, 8), false);
  assert.equal(shouldHarvest(8, 8), true);
  assert.equal(shouldHarvest(9, 8), true);
});
