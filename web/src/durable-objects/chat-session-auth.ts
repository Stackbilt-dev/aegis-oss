const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ConversationOwnership = 'owned' | 'not_owned' | 'not_found';

export function isValidConversationId(id: string): boolean {
  return UUID_RE.test(id);
}

export async function verifyConversationOwnership(
  db: D1Database,
  conversationId: string,
  userId: string,
): Promise<ConversationOwnership> {
  const row = await db.prepare(
    'SELECT user_id FROM conversations WHERE id = ?',
  ).bind(conversationId).first<{ user_id: string | null }>();

  if (!row) return 'not_found';
  return (row.user_id ?? 'operator') === userId ? 'owned' : 'not_owned';
}
