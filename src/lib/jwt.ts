import { jwtVerify } from 'jose';

export interface JwtClaims {
  sub: string;
  email: string;
  name: string;
  role: 'user' | 'admin';
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims> {
  const { payload } = await jwtVerify(
    token,
    new TextEncoder().encode(secret)
  );
  return {
    sub: payload.sub as string,
    email: payload.email as string,
    name: (payload.name as string) ?? '',
    role: (payload.role as 'user' | 'admin') ?? 'user',
  };
}
