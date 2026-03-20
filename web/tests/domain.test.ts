// Domain pre-filter tests — regex-based domain tagging with confidence scoring

import { describe, it, expect } from 'vitest';
import { domainPreFilter } from '../src/kernel/domain.js';

describe('domainPreFilter', () => {
  describe('domain matching', () => {
    it('tags legal queries', () => {
      const result = domainPreFilter('What is the LLC filing status?');
      expect(result.domain).toBe('legal');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags finance queries', () => {
      const result = domainPreFilter('What is the current revenue and burn rate?');
      expect(result.domain).toBe('finance');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags technical queries', () => {
      const result = domainPreFilter('Deploy the worker to Cloudflare');
      expect(result.domain).toBe('technical');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags software queries', () => {
      const result = domainPreFilter('Refactor the API endpoint for typescript');
      expect(result.domain).toBe('software');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags AI/ML queries', () => {
      const result = domainPreFilter('How does the LLM inference pipeline work?');
      expect(result.domain).toBe('ai_ml');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags creative queries', () => {
      const result = domainPreFilter('Write a blog post about our design');
      expect(result.domain).toBe('creative');
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('tags operations queries', () => {
      const result = domainPreFilter('What is the project sprint workflow?');
      expect(result.domain).toBe('operations');
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe('fallback behavior', () => {
    it('returns general with low confidence for no matches', () => {
      const result = domainPreFilter('hello there');
      expect(result.domain).toBe('general');
      expect(result.confidence).toBe(0.3);
    });

    it('returns general with low confidence for ties', () => {
      // 'deploy' matches technical, 'api' matches software — 1 match each = tie
      const result = domainPreFilter('deploy api');
      expect(result.domain).toBe('general');
      expect(result.confidence).toBe(0.3);
    });
  });

  describe('confidence scoring', () => {
    it('increases confidence with more signal matches', () => {
      const single = domainPreFilter('LLC');
      const multi = domainPreFilter('LLC filing compliance corporate');
      expect(multi.confidence).toBeGreaterThan(single.confidence);
    });

    it('confidence is ratio of matched signals to total signals', () => {
      // legal has 8 patterns; matching 1 gives confidence = 1/8 = 0.125
      const result = domainPreFilter('LLC');
      expect(result.domain).toBe('legal');
      expect(result.confidence).toBeCloseTo(1 / 8, 3);
    });
  });

  describe('case insensitivity', () => {
    it('matches regardless of case', () => {
      expect(domainPreFilter('CLOUDFLARE WORKER').domain).toBe('technical');
      expect(domainPreFilter('llm Model inference').domain).toBe('ai_ml');
      expect(domainPreFilter('REVENUE cost').domain).toBe('finance');
    });
  });
});
