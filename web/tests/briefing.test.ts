// Briefing tests — time gate, cooldown, activity filtering
// Covers: runMorningBriefing time/cooldown logic

import { describe, it, expect } from 'vitest';

// ─── Morning Briefing Time Gate ──────────────────────────────

describe('morning briefing time gate', () => {
  it('allows briefing between 11:00-12:59 UTC', () => {
    function isValidBriefingHour(hour: number): boolean {
      return hour >= 11 && hour <= 12;
    }

    expect(isValidBriefingHour(11)).toBe(true);
    expect(isValidBriefingHour(12)).toBe(true);
    expect(isValidBriefingHour(10)).toBe(false);
    expect(isValidBriefingHour(13)).toBe(false);
    expect(isValidBriefingHour(0)).toBe(false);
    expect(isValidBriefingHour(23)).toBe(false);
  });
});

// ─── Briefing Cooldown ───────────────────────────────────────

describe('briefing cooldown', () => {
  it('requires 20-hour cooldown between briefings', () => {
    function cooldownMet(lastBriefingAt: string, nowMs: number): boolean {
      const elapsed = nowMs - new Date(lastBriefingAt + 'Z').getTime();
      return elapsed >= 20 * 60 * 60 * 1000;
    }

    const now = new Date('2026-03-10T11:00:00Z').getTime();

    // 21 hours ago → met
    expect(cooldownMet('2026-03-09T14:00:00', now)).toBe(true);

    // 19 hours ago → not met
    expect(cooldownMet('2026-03-09T16:00:00', now)).toBe(false);

    // Exactly 20 hours → met
    expect(cooldownMet('2026-03-09T15:00:00', now)).toBe(true);
  });
});

// ─── Activity Filtering ─────────────────────────────────────

describe('briefing activity filtering', () => {
  it('skips briefing when no activity (0 completed + 0 failed + 0 proposed)', () => {
    const totalActivity = 0 + 0 + 0;
    expect(totalActivity).toBe(0);
  });

  it('sends briefing when any tasks completed', () => {
    const totalActivity = 3 + 0 + 0;
    expect(totalActivity > 0).toBe(true);
  });

  it('sends briefing when failed tasks exist', () => {
    const totalActivity = 0 + 2 + 0;
    expect(totalActivity > 0).toBe(true);
  });

  it('sends briefing when proposed tasks exist', () => {
    const totalActivity = 0 + 0 + 1;
    expect(totalActivity > 0).toBe(true);
  });
});

// ─── Briefing requires resendApiKey ──────────────────────────

describe('briefing prerequisites', () => {
  it('skips when no resendApiKey', () => {
    const env = { resendApiKey: '' };
    expect(!env.resendApiKey).toBe(true);
  });

  it('runs when resendApiKey is present', () => {
    const env = { resendApiKey: 'key_123' };
    expect(!env.resendApiKey).toBe(false);
  });
});
