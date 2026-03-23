// Stub — full implementation not yet extracted to OSS

export async function ensureOnBoard(
  db: D1Database,
  githubToken: string,
  projectId: string,
  repo: string,
  issueNumber: number,
  title: string,
  status: string,
): Promise<void> {
  throw new Error('not implemented');
}

export async function moveBoardItemLocal(
  db: D1Database,
  repo: string,
  issueNumber: number,
  status: 'queued' | 'in_progress' | 'shipped' | 'blocked' | 'backlog',
): Promise<void> {
  throw new Error('not implemented');
}

export async function linkTaskToBoard(
  db: D1Database,
  taskId: string,
  repo: string,
  issueNumber: number,
): Promise<void> {
  throw new Error('not implemented');
}
