// Workers AI chat utility tests — extractText, extractToolCalls, extractUsage, toOpenAiTools
// Pure function tests — no mocking needed

import { describe, it, expect } from 'vitest';
import { extractText, extractToolCalls, extractUsage, toOpenAiTools, type AiChatResponse } from '../src/workers-ai-chat.js';

describe('extractText', () => {
  it('extracts from standard Workers AI format', () => {
    const result: AiChatResponse = { response: 'Hello from Workers AI' };
    expect(extractText(result)).toBe('Hello from Workers AI');
  });

  it('extracts from OpenAI Chat Completions format', () => {
    const result: AiChatResponse = {
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'Hello from GPT-OSS' },
        finish_reason: 'stop',
      }],
    };
    expect(extractText(result)).toBe('Hello from GPT-OSS');
  });

  it('extracts from Responses API format', () => {
    const result: AiChatResponse = {
      output: [{
        type: 'message',
        content: [{ type: 'text', text: 'Response API text' }],
      }],
    };
    expect(extractText(result)).toBe('Response API text');
  });

  it('extracts output_text type from Responses API', () => {
    const result: AiChatResponse = {
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'Output text' }],
      }],
    };
    expect(extractText(result)).toBe('Output text');
  });

  it('returns undefined when no text found', () => {
    const result: AiChatResponse = {};
    expect(extractText(result)).toBeUndefined();
  });

  it('returns undefined for empty choices', () => {
    const result: AiChatResponse = { choices: [] };
    expect(extractText(result)).toBeUndefined();
  });

  it('returns undefined for null content in choices', () => {
    const result: AiChatResponse = {
      choices: [{
        index: 0,
        message: { role: 'assistant', content: null },
        finish_reason: 'stop',
      }],
    };
    expect(extractText(result)).toBeUndefined();
  });

  it('prioritizes response field over choices', () => {
    const result: AiChatResponse = {
      response: 'workers-ai-response',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'completions-response' },
        finish_reason: 'stop',
      }],
    };
    expect(extractText(result)).toBe('workers-ai-response');
  });
});

describe('extractToolCalls', () => {
  it('extracts from standard Workers AI format', () => {
    const result: AiChatResponse = {
      tool_calls: [{
        id: 'tc1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"test"}' },
      }],
    };
    const calls = extractToolCalls(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].function.name).toBe('search');
  });

  it('extracts from OpenAI Chat Completions format', () => {
    const result: AiChatResponse = {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'tc2',
            type: 'function',
            function: { name: 'list_files', arguments: '{}' },
          }],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const calls = extractToolCalls(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('tc2');
    expect(calls[0].function.name).toBe('list_files');
  });

  it('extracts from Responses API format', () => {
    const result: AiChatResponse = {
      output: [{
        type: 'function_call',
        id: 'fc1',
        call_id: 'call_123',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      }],
    };
    const calls = extractToolCalls(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('call_123');
    expect(calls[0].function.name).toBe('get_weather');
  });

  it('returns empty array when no tool calls', () => {
    expect(extractToolCalls({})).toEqual([]);
    expect(extractToolCalls({ response: 'hello' })).toEqual([]);
    expect(extractToolCalls({ choices: [] })).toEqual([]);
  });

  it('filters out malformed tool calls from choices', () => {
    const result: AiChatResponse = {
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'tc1', type: 'function', function: { name: 'good', arguments: '{}' } },
            { id: '', type: 'function', function: undefined as any },
          ],
        },
        finish_reason: 'tool_calls',
      }],
    };
    const calls = extractToolCalls(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('tc1');
  });
});

describe('extractUsage', () => {
  it('extracts standard usage', () => {
    const result: AiChatResponse = {
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const usage = extractUsage(result);
    expect(usage?.prompt_tokens).toBe(100);
    expect(usage?.completion_tokens).toBe(50);
  });

  it('returns undefined when no usage', () => {
    expect(extractUsage({})).toBeUndefined();
  });

  it('handles alternative token field names', () => {
    const result: AiChatResponse = {
      usage: { input_tokens: 200, output_tokens: 80 } as any,
    };
    const usage = extractUsage(result);
    expect(usage?.prompt_tokens).toBe(200);
    expect(usage?.completion_tokens).toBe(80);
  });
});

describe('toOpenAiTools', () => {
  it('converts Anthropic tool format to OpenAI function format', () => {
    const anthropicTools = [
      {
        name: 'search_memory',
        description: 'Search semantic memory',
        input_schema: { type: 'object', properties: { query: { type: 'string' } } },
      },
    ];
    const result = toOpenAiTools(anthropicTools);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('function');
    expect(result[0].function.name).toBe('search_memory');
    expect(result[0].function.description).toBe('Search semantic memory');
    expect(result[0].function.parameters).toEqual(anthropicTools[0].input_schema);
  });

  it('handles empty array', () => {
    expect(toOpenAiTools([])).toEqual([]);
  });

  it('converts multiple tools', () => {
    const tools = [
      { name: 'tool1', description: 'desc1', input_schema: {} },
      { name: 'tool2', description: 'desc2', input_schema: { type: 'object' } },
    ];
    const result = toOpenAiTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe('tool1');
    expect(result[1].function.name).toBe('tool2');
  });
});
