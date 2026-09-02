/**
 * User session domain entity. `token` is an opaque random id stored in a
 * `pdfdadi_session` cookie (separate from the M1 admin `pdfdadi_admin` cookie);
 * the row is looked up to authenticate requests. Expires after `expiresAt`.
 */
export interface UserSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
}
