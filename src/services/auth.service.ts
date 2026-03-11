import { userRepository } from '../repositories/user.repository.js';
import type { JwtClaims } from '../lib/jwt.js';

export const authService = {
  async getOrCreateUser(claims: JwtClaims) {
    return userRepository.upsertFromJwt({
      email: claims.email,
      name: claims.name,
      sub: claims.sub,
      role: claims.role,
    });
  },
};
