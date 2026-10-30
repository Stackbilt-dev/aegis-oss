import { describe, expect, it, vi } from 'vitest';
import { releaseSandbox } from '../../src/factory/bootstrap.js';

describe('releaseSandbox', () => {
  it('destroys the container', async () => {
    const destroy = vi.fn(async () => undefined);
    await releaseSandbox({ destroy });
    expect(destroy).toHaveBeenCalledOnce();
  });

  it('does not let a failed release change the task outcome', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(releaseSandbox({ destroy: async () => { throw new Error('gone'); } })).resolves.toBeUndefined();
      expect(warn.mock.calls[0][0]).toContain('gone');
    } finally {
      warn.mockRestore();
    }
  });
});
