import { cors } from 'hono/cors';
import { config } from '../lib/config.js';

const allowedOrigins = config.CORS_ORIGIN
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: (origin) => {
    if (!origin) return '';
    return allowedOrigins.includes(origin) ? origin : '';
  },
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
  // Retry-After is not a CORS-safelisted response header, so the browser cannot
  // read it cross-origin unless it is explicitly exposed. The password-change
  // route (routes/users.ts) sends it on 429 so the client can show a wait time.
  exposeHeaders: ['Retry-After'],
  credentials: true,
});
