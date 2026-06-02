import { describe, expect, it, vi } from 'vitest';
import { isValidConversationId, verifyConversationOwnership } from '../src/durable-objects/chat-session-auth.js';

function makeDb(row: { user_id: string | null } | null) {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn().mockResolvedValue(row),
      })),
    })),
  } as unknown as D1Database;
}

describe('chat-session auth helpers', () => {
  it('accepts only UUID conversation ids', () => {
    expect(isValidConversationId('018f9e54-7f61-4e01-8a04-7b54c23b2e10')).toBe(true);
    expect(isValidConversationId('conv-1')).toBe(false);
    expect(isValidConversationId('../other')).toBe(false);
  });

  it('reports owned conversations', async () => {
    await expect(
      verifyConversationOwnership(makeDb({ user_id: 'operator' }), '018f9e54-7f61-4e01-8a04-7b54c23b2e10', 'operator'),
    ).resolves.toBe('owned');
  });

  it('treats legacy null user_id rows as operator-owned', async () => {
    await expect(
      verifyConversationOwnership(makeDb({ user_id: null }), '018f9e54-7f61-4e01-8a04-7b54c23b2e10', 'operator'),
    ).resolves.toBe('owned');
  });

  it('distinguishes missing and foreign conversations', async () => {
    await expect(
      verifyConversationOwnership(makeDb(null), '018f9e54-7f61-4e01-8a04-7b54c23b2e10', 'operator'),
    ).resolves.toBe('not_found');

    await expect(
      verifyConversationOwnership(makeDb({ user_id: 'other-user' }), '018f9e54-7f61-4e01-8a04-7b54c23b2e10', 'operator'),
    ).resolves.toBe('not_owned');
  });
});
