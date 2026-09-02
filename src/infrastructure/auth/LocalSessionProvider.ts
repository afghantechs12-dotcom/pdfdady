import { PrismaClient } from "@prisma/client";
import crypto from "node:crypto";
import type { UserSession } from "@/src/domain/entities/UserSession";
import type { ISessionProvider } from "@/src/application/ports/auth/SessionProvider";

type SessionRow = {
  id: string;
  userId: string;
  token: string;
  expiresAt: Date;
  createdAt: Date;
};

function toDomain(row: SessionRow): UserSession {
  return { id: row.id, userId: row.userId, token: row.token, expiresAt: row.expiresAt, createdAt: row.createdAt };
}

/**
 * Local ISessionProvider — opaque random tokens stored in the `sessions` table,
 * carried in the `pdfdadi_session` cookie (separate from the M1 admin cookie).
 * `get` returns null for expired tokens.
 */
export class LocalSessionProvider implements ISessionProvider {
  constructor(private readonly prisma: PrismaClient) {}

  async create(userId: string, ttlSeconds = 60 * 60 * 24 * 30): Promise<UserSession> {
    const token = crypto.randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000);
    const r = await this.prisma.session.create({ data: { userId, token, expiresAt } });
    return toDomain(r);
  }

  async get(token: string): Promise<UserSession | null> {
    const r = await this.prisma.session.findUnique({ where: { token } });
    if (!r) return null;
    if (r.expiresAt < new Date()) return null;
    return toDomain(r);
  }

  async delete(token: string): Promise<void> {
    try {
      await this.prisma.session.delete({ where: { token } });
    } catch {
      // idempotent
    }
  }
}
