import { describe, it, expect } from 'vitest';
import { parseJsonResponse } from '../../src/kernel/scheduled/dreaming/llm.js';

describe('parseJsonResponse', () => {
  it('parses valid JSON', () => {
    const result = parseJsonResponse<{ facts: string[] }>('{"facts": ["one", "two"]}');
    expect(result).toEqual({ facts: ['one', 'two'] });
  });

  it('strips markdown code fences', () => {
    const result = parseJsonResponse<{ value: number }>('```json\n{"value": 42}\n```');
    expect(result).toEqual({ value: 42 });
  });

  it('strips code fences without language tag', () => {
    const result = parseJsonResponse<{ ok: boolean }>('```\n{"ok": true}\n```');
    expect(result).toEqual({ ok: true });
  });

  it('handles leading/trailing whitespace', () => {
    const result = parseJsonResponse<{ x: number }>('  \n  {"x": 1}  \n  ');
    expect(result).toEqual({ x: 1 });
  });

  it('returns null for invalid JSON', () => {
    const result = parseJsonResponse<unknown>('not json at all');
    expect(result).toBeNull();
  });

  it('returns null for empty string', () => {
    const result = parseJsonResponse<unknown>('');
    expect(result).toBeNull();
  });

  it('returns null for truncated JSON', () => {
    const result = parseJsonResponse<unknown>('{"facts": [{"topic": "aegis"');
    expect(result).toBeNull();
  });

  it('parses nested objects', () => {
    const input = '```json\n{"connections": [{"topic_a": "aegis", "topic_b": "finance", "insight": "cost correlation"}]}\n```';
    const result = parseJsonResponse<{ connections: Array<{ topic_a: string; topic_b: string; insight: string }> }>(input);
    expect(result?.connections).toHaveLength(1);
    expect(result?.connections[0].topic_a).toBe('aegis');
  });
});
