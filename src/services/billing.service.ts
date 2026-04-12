import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../lib/errors.js';
import { db } from '../db/index.js';
import { webhookEvents } from '../db/schema.js';

const stripe = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY)
  : null;

export const billingService = {
  async createPaymentIntent(userId: string, jobId: string, totalPages: number) {
    if (!stripe) throw Errors.processingFailed('Stripe not configured');

    const amountCents = totalPages * config.PROCESSING_PRICE_PER_PAGE_CENTS;

    // Get or create Stripe customer
    const user = await userRepository.findById(userId);
    if (!user) throw Errors.notFound('User');

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      const customer = await stripe.customers.create({ email: user.email, name: user.name ?? undefined });
      customerId = customer.id;
      await userRepository.update(user.id, { stripeCustomerId: customerId });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      customer: customerId,
      metadata: { jobId, userId },
    });

    // Update job with cost and payment intent
    await billingRepository.updateJobStatus(jobId, {
      processingCostCents: amountCents,
      stripePaymentIntentId: paymentIntent.id,
    });

    // Create charge record
    await billingRepository.createCharge({
      userId,
      jobId,
      amountCents,
      stripePaymentIntentId: paymentIntent.id,
      status: 'pending',
    });

    return { clientSecret: paymentIntent.client_secret!, amountCents };
  },

  async handleWebhook(payload: string | Buffer, signature: string) {
    if (!stripe) throw Errors.processingFailed('Stripe not configured');

    const event = stripe.webhooks.constructEvent(
      payload,
      signature,
      config.STRIPE_WEBHOOK_SECRET
    );

    // Idempotency check: skip already-processed events
    const [existing] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id))
      .limit(1);

    if (existing) {
      console.log(`[Stripe Webhook] Skipping duplicate event ${event.id} (${event.type})`);
      return;
    }

    // Record event before processing
    await db.insert(webhookEvents).values({
      stripeEventId: event.id,
      eventType: event.type,
      status: 'processing',
    });

    try {
      if (event.type === 'payment_intent.succeeded') {
        const pi = event.data.object as Stripe.PaymentIntent;
        const jobId = pi.metadata.jobId;
        console.log(`[Stripe Webhook] payment_intent.succeeded — PI: ${pi.id}, jobId: ${jobId}`);
        if (jobId) {
          await billingRepository.updateJobStatus(jobId, { paid: true });
          const charge = await billingRepository.findChargeByPaymentIntentId(pi.id);
          if (charge) {
            await billingRepository.updateChargeStatus(charge.id, { status: 'paid' });
          }
        }
      }

      if (event.type === 'payment_intent.payment_failed') {
        const pi = event.data.object as Stripe.PaymentIntent;
        console.log(`[Stripe Webhook] payment_intent.payment_failed — PI: ${pi.id}`);
        const charge = await billingRepository.findChargeByPaymentIntentId(pi.id);
        if (charge) {
          await billingRepository.updateChargeStatus(charge.id, { status: 'failed' });
        }
      }

      // Mark event as processed
      await db
        .update(webhookEvents)
        .set({ status: 'processed' })
        .where(eq(webhookEvents.stripeEventId, event.id));
    } catch (err) {
      // Flag failed event for manual review
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[Stripe Webhook] Error processing event ${event.id} (${event.type}):`, errorMsg);
      await db
        .update(webhookEvents)
        .set({ status: 'failed', error: errorMsg })
        .where(eq(webhookEvents.stripeEventId, event.id));
      throw err; // Re-throw so the route handler catches and logs it too
    }
  },

  async refund(paymentIntentId: string) {
    if (!stripe) return;
    await stripe.refunds.create({ payment_intent: paymentIntentId });
    const charge = await billingRepository.findChargeByPaymentIntentId(paymentIntentId);
    if (charge) {
      await billingRepository.updateChargeStatus(charge.id, { status: 'refunded' });
    }
  },

  async getPaymentHistory(userId: string) {
    return billingRepository.findChargesByUserId(userId);
  },
};
