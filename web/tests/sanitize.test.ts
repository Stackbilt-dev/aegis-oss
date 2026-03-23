// sanitizeForBlog tests — PII stripping, entity replacement, sensitive pattern redaction

import { describe, it, expect } from 'vitest';
import { sanitizeForBlog } from '../src/sanitize.js';

describe('sanitizeForBlog', () => {
  describe('entity replacements', () => {
    it('replaces "ExampleCo LLC" with [Company]', () => {
      expect(sanitizeForBlog('Founded ExampleCo LLC in 2025')).toContain('[Company]');
    });

    it('replaces "Citizens Reunited, PBC" with [Partner Org]', () => {
      expect(sanitizeForBlog('Working with Citizens Reunited, PBC')).toContain('[Partner Org]');
    });

    it('replaces "Citizens Reunited" without PBC', () => {
      expect(sanitizeForBlog('Citizens Reunited project')).toContain('[Partner Org]');
    });

    it('replaces "Jane Doe" with [Operator]', () => {
      expect(sanitizeForBlog('Jane Doe is the founder')).toContain('[Operator]');
    });

    it('replaces "John Doe" with [Client]', () => {
      expect(sanitizeForBlog('John Doe requested changes')).toContain('[Client]');
    });

    it('replaces "bizops-copilot" with [internal-service]', () => {
      expect(sanitizeForBlog('bound to bizops-copilot')).toContain('[internal-service]');
    });

    it('replaces "aegis-memory" with [memory-service]', () => {
      expect(sanitizeForBlog('data in aegis-memory')).toContain('[memory-service]');
    });

    it('is case-insensitive for entities', () => {
      expect(sanitizeForBlog('EXAMPLECO LLC')).toContain('[Company]');
      expect(sanitizeForBlog('jane doe')).toContain('[Operator]');
    });
  });

  describe('sensitive patterns', () => {
    it('redacts EIN (XX-XXXXXXX)', () => {
      expect(sanitizeForBlog('EIN: 12-3456789')).toContain('[EIN-REDACTED]');
    });

    it('redacts UUIDs', () => {
      expect(sanitizeForBlog('ID: a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toContain('[ID-REDACTED]');
    });

    it('redacts API tokens (aegis_*)', () => {
      expect(sanitizeForBlog('token: aegis_abc123def456abc123def456abc123de')).toContain('[TOKEN-REDACTED]');
    });

    it('redacts email addresses', () => {
      expect(sanitizeForBlog('email: admin@example.com')).toContain('[EMAIL-REDACTED]');
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
      expect(sanitizeForBlog('account: abc123def456abc123def456abc123de')).toContain('[ACCOUNT-REDACTED]');
    });

    it('redacts URLs with token/secret/key/auth', () => {
      expect(sanitizeForBlog('endpoint: https://example.com/api?token=abc')).toContain('[URL-REDACTED]');
      expect(sanitizeForBlog('url: https://example.com/auth/callback')).toContain('[URL-REDACTED]');
    });
  });

  describe('combined behavior', () => {
    it('handles multiple replacements in one string', () => {
      const input = 'Jane Doe at ExampleCo LLC (admin@example.com)';
      const result = sanitizeForBlog(input);
      expect(result).toContain('[Operator]');
      expect(result).toContain('[Company]');
      expect(result).toContain('[EMAIL-REDACTED]');
      expect(result).not.toContain('Jane Doe');
      expect(result).not.toContain('ExampleCo LLC');
      expect(result).not.toContain('admin@example.com');
    });

    it('passes through safe content unchanged', () => {
      const safe = 'Today we shipped a new feature for the dashboard.';
      expect(sanitizeForBlog(safe)).toBe(safe);
    });
  });
});
