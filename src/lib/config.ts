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
});

export const config = envSchema.parse(process.env);
export type Config = z.infer<typeof envSchema>;
