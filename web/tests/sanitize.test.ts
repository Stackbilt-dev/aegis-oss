// sanitizeForBlog tests — PII stripping, entity replacement, sensitive pattern redaction

import { describe, it, expect } from 'vitest';
import { sanitizeForBlog } from '../src/sanitize.js';

describe('sanitizeForBlog', () => {
  describe('entity replacements', () => {
    it('replaces "Stackbilt LLC" with [Company]', () => {
      expect(sanitizeForBlog('Founded Stackbilt LLC in 2025')).toContain('[Company]');
    });

    it('replaces "Citizens Reunited, PBC" with [Partner Org]', () => {
      expect(sanitizeForBlog('Working with Citizens Reunited, PBC')).toContain('[Partner Org]');
    });

    it('replaces "Citizens Reunited" without PBC', () => {
      expect(sanitizeForBlog('Citizens Reunited project')).toContain('[Partner Org]');
    });

    it('replaces "Kurt Overmier" with [Operator]', () => {
      expect(sanitizeForBlog('Kurt Overmier is the founder')).toContain('[Operator]');
    });

    it('replaces "Tamlyn Overmier" with [Client]', () => {
      expect(sanitizeForBlog('Tamlyn Overmier requested changes')).toContain('[Client]');
    });

    it('replaces "businessops-copilot" with [internal-service]', () => {
      expect(sanitizeForBlog('bound to businessops-copilot')).toContain('[internal-service]');
    });

    it('replaces "stackbilt-memory" with [memory-service]', () => {
      expect(sanitizeForBlog('data in stackbilt-memory')).toContain('[memory-service]');
    });

    it('is case-insensitive for entities', () => {
      expect(sanitizeForBlog('STACKBILT LLC')).toContain('[Company]');
      expect(sanitizeForBlog('kurt overmier')).toContain('[Operator]');
    });
  });

  describe('sensitive patterns', () => {
    it('redacts EIN (XX-XXXXXXX)', () => {
      expect(sanitizeForBlog('EIN: 12-3456789')).toContain('[EIN-REDACTED]');
    });

    it('redacts UUIDs', () => {
      expect(sanitizeForBlog('ID: a0a3b1c7-43ac-49d3-a481-d0aa7c396576')).toContain('[ID-REDACTED]');
    });

    it('redacts API tokens (aegis_*)', () => {
      expect(sanitizeForBlog('token: aegis_0536a9669f99fd3b85b99f908b32f9f2')).toContain('[TOKEN-REDACTED]');
    });

    it('redacts email addresses', () => {
      expect(sanitizeForBlog('email: admin@stackbilt.dev')).toContain('[EMAIL-REDACTED]');
    });

    it('redacts US phone numbers', () => {
      expect(sanitizeForBlog('call 555-123-4567')).toContain('[PHONE-REDACTED]');
      expect(sanitizeForBlog('call +1 555-123-4567')).toContain('[PHONE-REDACTED]');
    });

    it('redacts IP addresses', () => {
      expect(sanitizeForBlog('server at 192.168.1.1')).toContain('[IP-REDACTED]');
    });

    it('redacts dollar amounts with cents', () => {
      expect(sanitizeForBlog('total: $1,234.56')).toContain('[AMOUNT-REDACTED]');
      expect(sanitizeForBlog('cost: $10.42')).toContain('[AMOUNT-REDACTED]');
    });

    it('preserves round dollar amounts', () => {
      expect(sanitizeForBlog('about $500 total')).toContain('$500');
    });

    it('redacts 32-char hex (Cloudflare account IDs)', () => {
      expect(sanitizeForBlog('account: 3ede775d1472c2c8e7fd90dbf492aa63')).toContain('[ACCOUNT-REDACTED]');
    });

    it('redacts URLs with token/secret/key/auth', () => {
      expect(sanitizeForBlog('endpoint: https://example.com/api?token=abc')).toContain('[URL-REDACTED]');
      expect(sanitizeForBlog('url: https://example.com/auth/callback')).toContain('[URL-REDACTED]');
    });
  });

  describe('combined behavior', () => {
    it('handles multiple replacements in one string', () => {
      const input = 'Kurt Overmier at Stackbilt LLC (admin@stackbilt.dev)';
      const result = sanitizeForBlog(input);
      expect(result).toContain('[Operator]');
      expect(result).toContain('[Company]');
      expect(result).toContain('[EMAIL-REDACTED]');
      expect(result).not.toContain('Kurt Overmier');
      expect(result).not.toContain('Stackbilt LLC');
      expect(result).not.toContain('admin@stackbilt.dev');
    });

    it('passes through safe content unchanged', () => {
      const safe = 'Today we shipped a new feature for the dashboard.';
      expect(sanitizeForBlog(safe)).toBe(safe);
    });
  });
});
