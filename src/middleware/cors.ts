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
  credentials: true,
});
