// Stub — full implementation not yet extracted to OSS

export function dashboardPage(data: any): string {
  return '<html><body>dashboard</body></html>';
}

export async function getDashboardData(db: D1Database): Promise<Record<string, unknown>> {
  return { version: '0.0.0' };
}
