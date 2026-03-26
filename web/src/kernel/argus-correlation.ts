/**
 * ARGUS Correlation Engine + Incident Clustering
 *
 * Pearson correlation with lag detection identifies causal ordering between metrics.
 * Union-find clustering groups related alerts by temporal proximity + correlation.
 */

// ─── Types ───────────────────────────────────────────────────

export interface CorrelationResult {
  metricA: string;
  metricB: string;
  coefficient: number; // -1 to +1
  lagMinutes: number;  // A leads B by N minutes (0 = simultaneous)
  strength: 'strong' | 'moderate' | 'weak' | 'none';
  direction: 'positive' | 'negative' | 'none';
}

export interface MetricSnapshot {
  timestamp: number;
  metrics: Record<string, number>;
}

/** Minimal diagnosis shape needed by the clustering engine */
export interface ArgusDiagnosis {
  diagnosisId: string;
  tenantId: string;
  stage: string;
  metricName: string;
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  createdAt: number; // epoch ms
}

export interface IncidentCluster {
  incidentId: string;
  tenantId: string;
  stage: string;
  startTime: number;
  endTime: number;
  diagnoses: ArgusDiagnosis[];
  rootCause: RootCause | null;
  correlations: CorrelationResult[];
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  status: 'active' | 'resolved';
}

export interface RootCause {
  metric: string;
  diagnosis: ArgusDiagnosis;
  confidence: number; // 0-1
  reasoning: string;
}

export interface RelatedDiagnosis {
  diagnosis: ArgusDiagnosis;
  relationship: 'same_incident' | 'correlated' | 'temporal';
  correlation?: CorrelationResult;
  timeDeltaMinutes: number;
}

// ─── Constants ───────────────────────────────────────────────

const CLUSTERING_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const CORRELATION_THRESHOLD = 0.5; // |r| >= 0.5 for clustering

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

// ─── Correlation Engine ──────────────────────────────────────

/**
 * Calculate Pearson correlation coefficient between two arrays
 */
export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length === 0) {
    return 0;
  }

  const n = x.length;
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((acc, xi, i) => acc + xi * y[i], 0);
  const sumX2 = x.reduce((acc, xi) => acc + xi * xi, 0);
  const sumY2 = y.reduce((acc, yi) => acc + yi * yi, 0);

  const numerator = n * sumXY - sumX * sumY;
  const denominator = Math.sqrt(
    (n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY)
  );

  if (denominator === 0) {
    return 0;
  }

  return numerator / denominator;
}

/**
 * Classify correlation strength
 */
export function classifyCorrelation(r: number): {
  strength: 'strong' | 'moderate' | 'weak' | 'none';
  direction: 'positive' | 'negative' | 'none';
} {
  const absR = Math.abs(r);

  if (absR < 0.3) {
    return { strength: 'none', direction: 'none' };
  }

  const direction = r > 0 ? 'positive' : 'negative';

  if (absR >= 0.7) {
    return { strength: 'strong', direction };
  } else if (absR >= 0.5) {
    return { strength: 'moderate', direction };
  } else {
    return { strength: 'weak', direction };
  }
}

/**
 * Extract time series for a specific metric from snapshots
 */
function extractTimeSeries(
  snapshots: MetricSnapshot[],
  metricName: string
): { timestamps: number[]; values: number[] } {
  const timestamps: number[] = [];
  const values: number[] = [];

  for (const snapshot of snapshots) {
    if (metricName in snapshot.metrics) {
      timestamps.push(snapshot.timestamp);
      values.push(snapshot.metrics[metricName]);
    }
  }

  return { timestamps, values };
}

/**
 * Apply a lag (shift) to a time series
 * Positive lag means the series happened earlier (leads the other)
 */
function applyLag(values: number[], lagSteps: number): number[] {
  if (lagSteps === 0) {
    return values;
  }

  if (lagSteps > 0) {
    return values.slice(lagSteps);
  } else {
    return values.slice(0, values.length + lagSteps);
  }
}

/**
 * Find optimal lag between two time series that maximizes correlation
 * Returns lag in number of snapshot intervals (typically 5 minutes each)
 */
export function findOptimalLag(
  valuesA: number[],
  valuesB: number[],
  maxLagSteps: number = 3 // Max 15 minutes at 5-min intervals
): { lag: number; coefficient: number } {
  let bestLag = 0;
  let bestCoefficient = 0;

  for (let lag = -maxLagSteps; lag <= maxLagSteps; lag++) {
    let shiftedA: number[];
    let shiftedB: number[];

    if (lag >= 0) {
      shiftedA = applyLag(valuesA, lag);
      shiftedB = valuesB.slice(lag);
    } else {
      shiftedA = valuesA.slice(-lag);
      shiftedB = applyLag(valuesB, -lag);
    }

    const minLen = Math.min(shiftedA.length, shiftedB.length);
    if (minLen < 3) continue;

    const r = pearsonCorrelation(
      shiftedA.slice(0, minLen),
      shiftedB.slice(0, minLen)
    );

    if (Math.abs(r) > Math.abs(bestCoefficient)) {
      bestCoefficient = r;
      bestLag = lag;
    }
  }

  return { lag: bestLag, coefficient: bestCoefficient };
}

/**
 * Calculate correlation between two metrics from snapshot history
 */
export function calculateCorrelation(
  snapshots: MetricSnapshot[],
  metricA: string,
  metricB: string,
  snapshotIntervalMinutes: number = 5
): CorrelationResult {
  const seriesA = extractTimeSeries(snapshots, metricA);
  const seriesB = extractTimeSeries(snapshots, metricB);

  const commonTimestamps = new Set(
    seriesA.timestamps.filter((t) => seriesB.timestamps.includes(t))
  );

  if (commonTimestamps.size < 3) {
    return {
      metricA,
      metricB,
      coefficient: 0,
      lagMinutes: 0,
      strength: 'none',
      direction: 'none',
    };
  }

  const alignedA: number[] = [];
  const alignedB: number[] = [];

  for (let i = 0; i < seriesA.timestamps.length; i++) {
    if (commonTimestamps.has(seriesA.timestamps[i])) {
      alignedA.push(seriesA.values[i]);
    }
  }

  for (let i = 0; i < seriesB.timestamps.length; i++) {
    if (commonTimestamps.has(seriesB.timestamps[i])) {
      alignedB.push(seriesB.values[i]);
    }
  }

  const { lag, coefficient } = findOptimalLag(alignedA, alignedB);
  const lagMinutes = lag * snapshotIntervalMinutes;
  const classification = classifyCorrelation(coefficient);

  return {
    metricA,
    metricB,
    coefficient: Math.round(coefficient * 1000) / 1000,
    lagMinutes,
    strength: classification.strength,
    direction: classification.direction,
  };
}

/**
 * Calculate correlations between all metric pairs in snapshot history
 * Filters to only return meaningful correlations (|r| >= 0.3)
 */
export function calculateAllCorrelations(
  snapshots: MetricSnapshot[],
  snapshotIntervalMinutes: number = 5
): CorrelationResult[] {
  const metricNames = new Set<string>();
  for (const snapshot of snapshots) {
    for (const metric of Object.keys(snapshot.metrics)) {
      metricNames.add(metric);
    }
  }

  const metrics = Array.from(metricNames);
  const results: CorrelationResult[] = [];

  for (let i = 0; i < metrics.length; i++) {
    for (let j = i + 1; j < metrics.length; j++) {
      const correlation = calculateCorrelation(
        snapshots,
        metrics[i],
        metrics[j],
        snapshotIntervalMinutes
      );

      if (correlation.strength !== 'none') {
        results.push(correlation);
      }
    }
  }

  results.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
  return results;
}

/**
 * Find metrics correlated with a specific metric
 */
export function findCorrelatedMetrics(
  snapshots: MetricSnapshot[],
  targetMetric: string,
  snapshotIntervalMinutes: number = 5
): CorrelationResult[] {
  const metricNames = new Set<string>();
  for (const snapshot of snapshots) {
    for (const metric of Object.keys(snapshot.metrics)) {
      if (metric !== targetMetric) {
        metricNames.add(metric);
      }
    }
  }

  const results: CorrelationResult[] = [];

  for (const metric of metricNames) {
    const correlation = calculateCorrelation(
      snapshots,
      targetMetric,
      metric,
      snapshotIntervalMinutes
    );

    if (correlation.strength !== 'none') {
      results.push(correlation);
    }
  }

  results.sort((a, b) => Math.abs(b.coefficient) - Math.abs(a.coefficient));
  return results;
}

// ─── Incident Clustering ─────────────────────────────────────

function getMaxSeverity(
  diagnoses: ArgusDiagnosis[]
): 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' {
  let maxRank = 0;
  let maxSeverity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW' = 'LOW';

  for (const d of diagnoses) {
    const rank = SEVERITY_RANK[d.severity] || 0;
    if (rank > maxRank) {
      maxRank = rank;
      maxSeverity = d.severity;
    }
  }

  return maxSeverity;
}

function areTemporallyClose(d1: ArgusDiagnosis, d2: ArgusDiagnosis): boolean {
  return Math.abs(d1.createdAt - d2.createdAt) <= CLUSTERING_WINDOW_MS;
}

function areCorrelated(
  d1: ArgusDiagnosis,
  d2: ArgusDiagnosis,
  correlations: CorrelationResult[]
): CorrelationResult | null {
  for (const corr of correlations) {
    const metrics = [corr.metricA, corr.metricB];
    if (
      metrics.includes(d1.metricName) &&
      metrics.includes(d2.metricName) &&
      Math.abs(corr.coefficient) >= CORRELATION_THRESHOLD
    ) {
      return corr;
    }
  }
  return null;
}

/**
 * Cluster diagnoses into groups based on temporal proximity and correlation.
 * Uses union-find with 15-minute window + |r| >= 0.5 threshold.
 */
export function clusterDiagnoses(
  diagnoses: ArgusDiagnosis[],
  correlations: CorrelationResult[]
): ArgusDiagnosis[][] {
  if (diagnoses.length === 0) return [];
  if (diagnoses.length === 1) return [[diagnoses[0]]];

  const sorted = [...diagnoses].sort((a, b) => a.createdAt - b.createdAt);

  // Union-Find
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  function find(id: string): string {
    if (!parent.has(id)) {
      parent.set(id, id);
      rank.set(id, 0);
    }
    if (parent.get(id) !== id) {
      parent.set(id, find(parent.get(id)!));
    }
    return parent.get(id)!;
  }

  function union(id1: string, id2: string): void {
    const root1 = find(id1);
    const root2 = find(id2);
    if (root1 === root2) return;

    const rank1 = rank.get(root1) || 0;
    const rank2 = rank.get(root2) || 0;

    if (rank1 < rank2) {
      parent.set(root1, root2);
    } else if (rank1 > rank2) {
      parent.set(root2, root1);
    } else {
      parent.set(root2, root1);
      rank.set(root1, rank1 + 1);
    }
  }

  for (const d of sorted) {
    find(d.diagnosisId);
  }

  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const d1 = sorted[i];
      const d2 = sorted[j];

      if (d1.tenantId !== d2.tenantId || d1.stage !== d2.stage) {
        continue;
      }

      if (!areTemporallyClose(d1, d2)) {
        break;
      }

      if (
        d1.metricName === d2.metricName ||
        areCorrelated(d1, d2, correlations)
      ) {
        union(d1.diagnosisId, d2.diagnosisId);
      }
    }
  }

  const clusters = new Map<string, ArgusDiagnosis[]>();
  for (const d of sorted) {
    const root = find(d.diagnosisId);
    if (!clusters.has(root)) {
      clusters.set(root, []);
    }
    clusters.get(root)!.push(d);
  }

  return Array.from(clusters.values());
}

/**
 * Determine root cause from a cluster of diagnoses.
 * Uses earliest-trigger heuristic boosted by lag-correlation evidence.
 */
export function determineRootCause(
  cluster: ArgusDiagnosis[],
  correlations: CorrelationResult[]
): RootCause | null {
  if (cluster.length === 0) return null;
  if (cluster.length === 1) {
    return {
      metric: cluster[0].metricName,
      diagnosis: cluster[0],
      confidence: 1.0,
      reasoning: 'Single diagnosis in incident',
    };
  }

  const sorted = [...cluster].sort((a, b) => a.createdAt - b.createdAt);
  const earliest = sorted[0];

  const relevantCorrelations = correlations.filter((c) => {
    const metrics = [c.metricA, c.metricB];
    return (
      metrics.includes(earliest.metricName) &&
      c.lagMinutes !== 0 &&
      Math.abs(c.coefficient) >= CORRELATION_THRESHOLD
    );
  });

  if (relevantCorrelations.length > 0) {
    const leadsOthers = relevantCorrelations.some((c) => {
      if (c.lagMinutes > 0 && c.metricA === earliest.metricName) return true;
      if (c.lagMinutes < 0 && c.metricB === earliest.metricName) return true;
      return false;
    });

    if (leadsOthers) {
      const bestCorr = relevantCorrelations.reduce((best, curr) =>
        Math.abs(curr.coefficient) > Math.abs(best.coefficient) ? curr : best
      );

      return {
        metric: earliest.metricName,
        diagnosis: earliest,
        confidence: Math.abs(bestCorr.coefficient),
        reasoning: `${earliest.metricName} occurred first and has ${bestCorr.strength} correlation with subsequent alerts (r=${bestCorr.coefficient}, leads by ${Math.abs(bestCorr.lagMinutes)} min)`,
      };
    }
  }

  return {
    metric: earliest.metricName,
    diagnosis: earliest,
    confidence: 0.6,
    reasoning: `${earliest.metricName} was the first metric to trigger an alert in this incident window`,
  };
}

/**
 * Create incidents from diagnoses and correlations.
 * Groups via union-find clustering, then infers root cause per cluster.
 */
export function createIncidents(
  diagnoses: ArgusDiagnosis[],
  correlations: CorrelationResult[]
): IncidentCluster[] {
  const clusters = clusterDiagnoses(diagnoses, correlations);

  return clusters.map((cluster) => {
    const sorted = [...cluster].sort((a, b) => a.createdAt - b.createdAt);
    const startTime = sorted[0].createdAt;
    const endTime = sorted[sorted.length - 1].createdAt;

    const clusterMetrics = new Set(cluster.map((d) => d.metricName));
    const relevantCorrelations = correlations.filter((c) => {
      return clusterMetrics.has(c.metricA) && clusterMetrics.has(c.metricB);
    });

    return {
      incidentId: crypto.randomUUID(),
      tenantId: sorted[0].tenantId,
      stage: sorted[0].stage,
      startTime,
      endTime,
      diagnoses: sorted,
      rootCause: determineRootCause(cluster, correlations),
      correlations: relevantCorrelations,
      severity: getMaxSeverity(cluster),
      status: 'active' as const,
    };
  });
}

/**
 * Find diagnoses related to a specific diagnosis
 */
export function findRelatedDiagnoses(
  targetDiagnosis: ArgusDiagnosis,
  allDiagnoses: ArgusDiagnosis[],
  correlations: CorrelationResult[],
  snapshots?: MetricSnapshot[]
): RelatedDiagnosis[] {
  const related: RelatedDiagnosis[] = [];
  const targetTime = targetDiagnosis.createdAt;

  const candidates = allDiagnoses.filter(
    (d) =>
      d.diagnosisId !== targetDiagnosis.diagnosisId &&
      d.tenantId === targetDiagnosis.tenantId &&
      d.stage === targetDiagnosis.stage
  );

  let effectiveCorrelations = correlations;
  if (snapshots && snapshots.length > 0 && correlations.length === 0) {
    effectiveCorrelations = findCorrelatedMetrics(
      snapshots,
      targetDiagnosis.metricName
    );
  }

  for (const candidate of candidates) {
    const timeDeltaMs = candidate.createdAt - targetTime;
    const timeDeltaMinutes = Math.round(timeDeltaMs / 60000);

    if (Math.abs(timeDeltaMs) <= CLUSTERING_WINDOW_MS) {
      const correlation = areCorrelated(
        targetDiagnosis,
        candidate,
        effectiveCorrelations
      );

      if (
        candidate.metricName === targetDiagnosis.metricName ||
        correlation
      ) {
        related.push({
          diagnosis: candidate,
          relationship: 'same_incident',
          correlation: correlation || undefined,
          timeDeltaMinutes,
        });
        continue;
      }

      related.push({
        diagnosis: candidate,
        relationship: 'temporal',
        timeDeltaMinutes,
      });
      continue;
    }

    const correlation = areCorrelated(
      targetDiagnosis,
      candidate,
      effectiveCorrelations
    );
    if (correlation) {
      related.push({
        diagnosis: candidate,
        relationship: 'correlated',
        correlation,
        timeDeltaMinutes,
      });
    }
  }

  const relationshipRank = {
    same_incident: 3,
    correlated: 2,
    temporal: 1,
  };

  related.sort((a, b) => {
    const rankDiff =
      relationshipRank[b.relationship] - relationshipRank[a.relationship];
    if (rankDiff !== 0) return rankDiff;
    return Math.abs(a.timeDeltaMinutes) - Math.abs(b.timeDeltaMinutes);
  });

  return related;
}
