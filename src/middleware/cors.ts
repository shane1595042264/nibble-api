import { cors } from 'hono/cors';
import { config } from '../lib/config.js';

export const corsMiddleware = cors({
  origin: config.CORS_ORIGIN,
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
});
