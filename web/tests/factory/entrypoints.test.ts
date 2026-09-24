// The runtime-neutral entry point must load without the Workers runtime:
// consumers import its helpers from MCP handlers, scripts, and Node tests.
// 0.9.0 re-exported the Durable Object from it, which pulled in `cloudflare:`
// modules and broke every such import.

import { describe, expect, it } from 'vitest';
import * as factory from '../../src/factory/index.js';

describe('@stackbilt/aegis-core/factory', () => {
  it('loads under plain Node and exposes the runtime-neutral surface', () => {
    expect(typeof factory.parseAcceptanceSpec).toBe('function');
    expect(typeof factory.externalRepoAdmissionError).toBe('function');
    expect(typeof factory.cloneSiblingCommand).toBe('function');
    expect(factory.taskExecutorDispatchPlugin.name).toBe('task-executor-dispatch');
    expect(factory.taskExecutorRoutes.prefix).toBe('/');
    expect('createTaskExecutorDO' in factory).toBe(false);
    expect('Sandbox' in factory).toBe(false);
  });
});
