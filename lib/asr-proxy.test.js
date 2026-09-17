import test from 'node:test';
import assert from 'node:assert/strict';
import { dictateWsUrl } from './asr-proxy.js';

test('http funasr url becomes ws dictate', () => {
  assert.equal(dictateWsUrl('http://127.0.0.1:8780'), 'ws://127.0.0.1:8780/ws/dictate');
});

test('trailing slash and path are stripped', () => {
  assert.equal(dictateWsUrl('http://127.0.0.1:8780/listen/'), 'ws://127.0.0.1:8780/ws/dictate');
});

test('https becomes wss', () => {
  assert.equal(dictateWsUrl('https://asr.local'), 'wss://asr.local/ws/dictate');
});
