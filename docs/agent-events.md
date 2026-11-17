# Agent events: the durable event inbox

Step 1 of the always-on run model ([#100](https://github.com/Stackbilt-dev/aegis-oss/issues/100)). Module: `@stackbilt/aegis-core/kernel/events`. Table: `agent_events` (in `web/schema.sql`; existing databases need `web/migrations/0002_agent_events.sql`).

## Why

Before this module, every source of work started its own run: chat, webhooks, scheduled tasks, other agents. That design has several problems:

- When a run crashes, its work is lost.
- A redelivered webhook runs twice.
- Two quick user messages produce two replies.
- Nothing records what is waiting or what failed.

The inbox puts one durable list in front of all of them. Sources only insert, and one runner per principal does the work.

```
source ──enqueueEvent──▶ agent_events ──claimBatch──▶ run ──complete / fail / defer──▶ agent_events
                                ▲                       │
                                └──── renewClaim ───────┘  (while the run is long)
```

## Lifecycle

| Status | Meaning | Next |
|---|---|---|
| `pending` | Waiting. Claimable once `available_at` has passed. | `claimed` |
| `claimed` | Held by one run until `lease_until`. | `done`, `pending` (retry), `failed`, `deferred`, or `claimed` by another run if the lease lapses |
| `done` | Settled by the run. | none |
| `failed` | Out of attempts, `retry: false`, or the lease lapsed with no attempts left. The reason is in `error`. | none |
| `deferred` | Parked while the run waits outside itself (e.g. an approval). The reason is in `defer_reason`. The answer arrives as a **new** event; resuming the run is #100 step 2. | none (for now) |

## Semantics

### Dedup
- `(principal, source, source_id)` is unique, so the same delivery ID can safely appear in two principals' inboxes.
- Dedup lasts as long as the row. Re-enqueueing a delivery that is already `done` or `failed` returns the original ID with `duplicate: true` and inserts nothing.
- Omit `sourceId` (or pass an empty string) to skip dedup.
- There is no pruning yet. Retention, and therefore how long dedup lasts, will be set when pruning lands.

### Claims and leases
- `claimBatch` claims up to `limit` ready events for one principal, oldest first, in a single `UPDATE … RETURNING` statement. Two concurrent claims can't take the same row.
- A claim holds its events for `leaseMs` (default 10 min), stored per row as `lease_until`.
- Each claim sets only its own lease. A caller passing a short `leaseMs` can't take events from a claim whose lease is still live.
- A long run must call `renewClaim(claimId)` well before `leaseUntil`. It returns how many events the claim still holds. Fewer than claimed means another run took some after a lapse, and 0 means stop.
- **Fencing protects the row, not the outside world.** Settling and renewing require the run's `claimId`, so a run that lost its lease can't overwrite the newer run's result. Any side effects it already caused (a sent message, an API call) have still happened. Renew on time, and make side effects idempotent where you can.

### Attempts and retries
- Each event stores its own `max_attempts` (default 3, set at enqueue, max 20). Every claim counts as an attempt.
- `failEvent` puts the event back to `pending` after a backoff (default 30 s × attempts so far) while attempts remain. Otherwise, or with `retry: false`, it fails the event.
- A lease that lapses with no attempts left is failed by the next `claimBatch`, which reports it in `exhausted`.

### Limits and validation
- Payloads must be JSON-serialisable and at most 256 KB once serialised. `undefined` becomes `{}`, and `null` is stored as `null`.
- `limit` (1–100), `leaseMs` (up to 24 h) and `maxAttempts` must be finite numbers of at least 1. Dates must be valid. Anything else throws before touching the database.
- Timestamps are ISO 8601 strings from `Date#toISOString()` and are compared as text. Don't write rows with SQLite's `datetime('now')`, which uses a different format.

## Runner

Modules: `@stackbilt/aegis-core/kernel/runner` (the loop, with no Durable Object code) and `@stackbilt/aegis-core/durable-objects/agent-runner` (the DO).

```ts
import { createAgentRunnerDO, enqueueAndNotify } from '@stackbilt/aegis-core/durable-objects/agent-runner';

export const AgentRunnerDO = createAgentRunnerDO<Env>({
  async handle(events, ctx, env) {
    // One run for the whole batch. Check ctx.signal before side effects.
    // Return nothing (all done), one outcome for all, or { [event.id]: outcome }.
  },
});

// In any handler, instead of doing the work inline:
await enqueueAndNotify(env.DB, env.AGENT_RUNNER, { source: 'github', sourceId: deliveryId, kind: 'webhook', payload });
```

Wrangler: bind `AGENT_RUNNER` to `AgentRunnerDO` (see `wrangler.toml.example`).

### How a run happens
1. A source calls `enqueueEvent` and then `notifyRunner` (`enqueueAndNotify` does both). The runner for that principal, `idFromName(principal)`, sets an alarm `debounceMs` (default 2 s) after the **first** notify. Later notifies never push it back. This makes a burst of events one run.
2. The alarm calls `runUntilIdle`. Each run is `drainOnce`: claim up to `batchLimit` events, call `handle` once, then settle each event. It repeats until nothing is ready, up to `maxRunsPerAlarm` runs (default 5). If that limit is hit, the runner sets the next alarm for now.
3. Afterwards, the runner sets its next alarm for `nextReadyAt`: the earliest retry backoff or claim lease that could lapse. A crashed run's events therefore come back without any outside poke.

Durable Object alarms never overlap, so a principal has at most one active run. Events that arrive mid-run wait for the next run, which starts as soon as this one ends. Folding them into the current run, or interrupting it, is not supported yet.

### Outcomes
| Handler result | Effect |
|---|---|
| returns nothing | every event `done` |
| `{ status: 'done' }` / `'failed'` / `'deferred'` / `'retry'` | applied to every event |
| `{ [eventId]: outcome }` | per event. An event missing from the map is **retried**, not dropped. |
| throws | every event retried with the error message (a final failure once `max_attempts` is used) |

While `handle` runs, the lease is renewed every `leaseMs / 3`. `ctx.renew()` renews it on demand. `ctx.signal` aborts once the run holds none of its events; stop side effects when it does. A settle refused because the claim was lost counts as `lost` in the summary.

`GET /status` on the DO returns the principal, the next alarm, and the last alarm's totals. `onResult` receives every alarm's full result, for logging.

### Safety net
A lost notify (for example, the Worker failing between the insert and the notify) leaves an event pending with no alarm. Have your hourly cron call `notifyRunner` for each active principal, so nothing waits longer than an hour.

## Not yet

- Folding events that arrive mid-run into the current run, or interrupting it
- Resuming deferred events from approvals (step 2)
- The outbox (step 3) and timers (step 4)
- Pruning old `done`/`failed` rows
