import { Hono } from 'hono';
import { z } from 'zod';
import { billingService } from '../services/billing.service.js';

export const billingRoutes = new Hono();

const createPaymentSchema = z.object({
  jobId: z.string(),
});

// Create payment intent
billingRoutes.post('/create-payment', async (c) => {
  const user = c.get('user');
  const body = await c.req.json();
  const { jobId } = createPaymentSchema.parse(body);
  const result = await billingService.createPaymentIntent(user.id, jobId);
  return c.json(result);
});

// Stripe webhook (no auth — verified by signature)
billingRoutes.post('/webhook', async (c) => {
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);
  const body = await c.req.text();
  await billingService.handleWebhook(body, signature);
  return c.json({ received: true });
});

// Payment history
billingRoutes.get('/history', async (c) => {
  const user = c.get('user');
  const history = await billingService.getPaymentHistory(user.id);
  return c.json(history);
});
