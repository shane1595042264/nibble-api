import { count, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export const userRepository = {
  async countAdmins() {
    const [row] = await db
      .select({ n: count() })
      .from(users)
      .where(eq(users.authRole, 'admin'));
    return Number(row?.n ?? 0);
  },

  async findById(id: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return user ?? null;
  },

  async findByEmail(email: string) {
    const [user] = await db
      .select()
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    return user ?? null;
  },

  async upsertFromJwt(data: {
    email: string;
    name: string;
    sub: string;
    role: string;
    googleId?: string;
  }) {
    const existing = await this.findByEmail(data.email);
    if (existing) {
      if (data.googleId && !existing.googleId) {
        await db
          .update(users)
          .set({ googleId: data.googleId })
          .where(eq(users.id, existing.id));
      }
      return existing;
    }
    const [created] = await db
      .insert(users)
      .values({
        email: data.email,
        name: data.name,
        googleId: data.googleId,
        authRole: data.role,
      })
      .returning();
    return created;
  },

  async create(data: {
    email: string;
    name?: string;
    googleId?: string;
    passwordHash?: string;
    avatarUrl?: string;
    authRole?: string;
    stripeCustomerId?: string;
  }) {
    const [created] = await db.insert(users).values(data).returning();
    return created;
  },

  async update(
    id: string,
    data: Partial<{
      email: string;
      name: string;
      googleId: string;
      avatarUrl: string;
      passwordHash: string;
      authRole: string;
      stripeCustomerId: string;
    }>,
  ) {
    const [updated] = await db
      .update(users)
      .set(data)
      .where(eq(users.id, id))
      .returning();
    return updated ?? null;
  },
};
