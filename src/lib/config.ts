import { z } from 'zod';
import 'dotenv/config';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  JWT_SECRET: z.string().min(1),
  PORT: z.coerce.number().default(4000),
  CORS_ORIGIN: z.string().default('http://localhost:3000'),
  R2_ENDPOINT: z.string().default(''),
  R2_ACCESS_KEY_ID: z.string().default(''),
  R2_SECRET_ACCESS_KEY: z.string().default(''),
  R2_BUCKET_NAME: z.string().default('nibble-pdfs'),
  ANTHROPIC_API_KEY: z.string().default(''),
  MATHPIX_APP_ID: z.string().default(''),
  MATHPIX_APP_KEY: z.string().default(''),
  STRIPE_SECRET_KEY: z.string().default(''),
  STRIPE_WEBHOOK_SECRET: z.string().default(''),
  PROCESSING_PRICE_PER_PAGE_CENTS: z.coerce.number().default(5),
  MAX_UPLOAD_SIZE_MB: z.coerce.number().default(100),
  FREE_AI_EMAILS: z.string().default(''),
  // Personal-website knowledge base — POST /api/knowledge/notes accepts vocab pushes.
  // Empty string disables the forwarder (vocab writes will 503).
  KNOWLEDGE_BASE_URL: z
    .string()
    .default('https://shanebackend-production.up.railway.app'),
  KNOWLEDGE_BASE_PAT: z.string().default(''),
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
