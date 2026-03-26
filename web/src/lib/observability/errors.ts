// In-memory error tracker for per-cron-run error aggregation.
// Deduplicates errors by type and tracks occurrence counts.

interface ErrorDetails {
  name: string;
  message: string;
  stack?: string;
}

interface TrackedError {
  id: string;
  timestamp: number;
  error: ErrorDetails;
  occurrences: number;
  firstSeen: number;
  lastSeen: number;
}

export interface ErrorStats {
  total: number;
  unique: number;
  byType: Record<string, number>;
}

export class InMemoryErrorTracker {
  private errors: Map<string, TrackedError> = new Map();

  track(error: Error): void {
    const errorId = `${error.name}:${error.message.slice(0, 100)}`;
    const existing = this.errors.get(errorId);
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = Date.now();
    } else {
      this.errors.set(errorId, {
        id: errorId,
        timestamp: Date.now(),
        error: { name: error.name, message: error.message, stack: error.stack },
        occurrences: 1,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      });
    }
  }

  getErrorStats(): ErrorStats {
    const byType: Record<string, number> = {};
    let total = 0;
    for (const tracked of this.errors.values()) {
      total += tracked.occurrences;
      byType[tracked.error.name] = (byType[tracked.error.name] ?? 0) + tracked.occurrences;
    }
    return { total, unique: this.errors.size, byType };
  }
}
