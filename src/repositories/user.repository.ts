import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema.js';

export const userRepository = {
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
    // Use the provided googleId, or fall back to 'sub' if 'sub' is expected to be the Google ID.
    // This ensures googleId is populated for Google sign-ups even if not explicitly passed as 'googleId'.
    const effectiveGoogleId = data.googleId || data.sub;

    const existing = await this.findByEmail(data.email);
    if (existing) {
      // If an existing user is found by email, update their googleId if it's missing
      // and we have an effectiveGoogleId from the JWT data.
      if (effectiveGoogleId && !existing.googleId) {
        const [updatedUser] = await db
          .update(users)
          .set({ googleId: effectiveGoogleId })
          .where(eq(users.id, existing.id))
          .returning(); // Return the updated user object
        return updatedUser || existing; // Return updated user if available, else existing
      }
      return existing;
    }

    // If no existing user is found by email, create a new one.
    const [created] = await db
      .insert(users)
      .values({
        email: data.email,
        name: data.name,
        googleId: effectiveGoogleId, // Use effectiveGoogleId for creation
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
