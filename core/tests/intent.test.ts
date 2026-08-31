import { test } from 'node:test';
import assert from 'node:assert';
import { detectIntent } from '../src/orchestrator/intent.js';

test('Intent Detection', async (t) => {
  await t.test('detects code intent correctly', () => {
    const result = detectIntent('Please implement a new login function');
    assert.strictEqual(result.intent, 'code');
    assert.strictEqual(result.agent, 'coder');
  });

  await t.test('detects review intent correctly', () => {
    const result = detectIntent('Can you review this pull request and check for any issues?');
    assert.strictEqual(result.intent, 'review');
    assert.strictEqual(result.agent, 'reviewer');
  });

  await t.test('detects research intent correctly', () => {
    const result = detectIntent('Explain how the react lifecycle works');
    assert.strictEqual(result.intent, 'research');
    assert.strictEqual(result.agent, 'researcher');
  });

  await t.test('detects write intent correctly', () => {
    const result = detectIntent('write docs for the new features');
    assert.strictEqual(result.intent, 'write');
    assert.strictEqual(result.agent, 'writer');
  });

  await t.test('defaults to general intent when no keywords match', () => {
    const result = detectIntent('hello there');
    assert.strictEqual(result.intent, 'general');
    assert.strictEqual(result.agent, 'general');
  });

  await t.test('resolves ties using priority (code > review)', () => {
    // Contains 'implement' (code) and 'review' (review)
    const result = detectIntent('review the implement code');
    assert.strictEqual(result.intent, 'code');
  });
});
