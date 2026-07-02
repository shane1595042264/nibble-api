import Stripe from 'stripe';
import { eq } from 'drizzle-orm';
import { config } from '../lib/config.js';
import { billingRepository } from '../repositories/billing.repository.js';
import { bookRepository } from '../repositories/book.repository.js';
import { userRepository } from '../repositories/user.repository.js';
import { Errors } from '../lib/errors.js';
import { db } from '../db/index.js';
import { webhookEvents } from '../db/schema.js';

const stripe = config.STRIPE_SECRET_KEY
  ? new Stripe(config.STRIPE_SECRET_KEY)
  : null;

/**
 * How long a webhook_events row may sit in 'processing' before we treat it as
 * abandoned (the handler crashed mid-flight) rather than a genuinely in-flight
 * concurrent delivery. Biased short: reprocessing is idempotent, so the worst
 * case for a truly-concurrent delivery is a harmless double-run, whereas
 * misclassifying a crash-stuck row as "in flight" would permanently drop the
 * event — the exact failure this fix exists to prevent.
 */
export const WEBHOOK_PROCESSING_STALE_MS = 60_000;

export type WebhookAction = 'skip' | 'process';

/**
 * Decide whether an incoming Stripe event should be (re)processed or skipped,
 * given the existing webhook_events row (if any).
 *
 * Fixes the original bug where ANY existing row — including 'failed' and
 * crash-stuck 'processing' — was skipped, permanently dropping a paid job on a
 * single transient failure and defeating Stripe's automatic retry safety net.
 */
export function classifyWebhookEvent(
  existing: { status: string; createdAt: Date | string } | undefined,
  nowMs: number,
): WebhookAction {
  if (!existing) return 'process';
  // Already handled successfully — short-circuit to avoid duplicate side effects.
  if (existing.status === 'processed') return 'skip';
  if (existing.status === 'processing') {
    const ageMs = nowMs - new Date(existing.createdAt).getTime();
    // Recent 'processing' row: a concurrent delivery is likely still running.
    // Old 'processing' row: the prior handler crashed — reprocess to recover.
    return ageMs < WEBHOOK_PROCESSING_STALE_MS ? 'skip' : 'process';
  }
  // 'failed' (or any unknown status): reprocess. The business steps are
  // idempotent set-operations, so re-running is safe and unlocks the job.
  return 'process';
}

export const billingService = {
  async createPaymentIntent(userId: string, jobId: string) {
    if (!stripe) throw Errors.processingFailed('Stripe not configured');

    // Look up totalPages server-side from the processing job's fileHash → book catalog
    const job = await billingRepository.findJobById(jobId);
    if (!job) throw Errors.notFound('Processing job');
    if (job.userId !== userId) throw Errors.forbidden('Job does not belong to user');

    const catalog = await bookRepository.findCatalogByHash(job.fileHash);
    if (!catalog) throw Errors.notFound('Book catalog entry');

    const totalPages = catalog.totalPages ?? 0;
    if (totalPages <= 0) throw Errors.processingFailed('Book has no page count');

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

    // Reuse an existing reusable PI for this job instead of minting a new one
    // each call. Prevents double-charge from two tabs, orphan PIs in the Stripe
    // dashboard, and pending-row growth in processingCharges.
    const REUSABLE_STATES = new Set<Stripe.PaymentIntent.Status>([
      'requires_payment_method',
      'requires_confirmation',
      'requires_action',
    ]);

    if (job.stripePaymentIntentId) {
      try {
        const prev = await stripe.paymentIntents.retrieve(job.stripePaymentIntentId);
        if (REUSABLE_STATES.has(prev.status) && prev.amount === amountCents) {
          return { clientSecret: prev.client_secret!, amountCents };
        }
        // Price changed (catalog totalPages drift) or different reusable amount —
        // cancel the prev PI before minting a new one so it doesn't linger.
        if (REUSABLE_STATES.has(prev.status)) {
          await stripe.paymentIntents.cancel(prev.id);
        }
        // Any other status (canceled, succeeded, processing, requires_capture):
        // fall through and mint a fresh PI without canceling — Stripe rejects
        // cancel on those states.
      } catch (err) {
        // PI was deleted out from under us or the id is unknown — mint a new one.
        if (!(err instanceof Stripe.errors.StripeInvalidRequestError)) throw err;
      }
    }

    const paymentIntent = await stripe.paymentIntents.create(
      {
        amount: amountCents,
        currency: 'usd',
        customer: customerId,
        metadata: { jobId, userId },
      },
      {
        // Collapses network-retry duplicates for the same logical attempt.
        // Including amountCents in the key means a price change naturally
        // gets a fresh key without us tracking nonces ourselves.
        idempotencyKey: `pi-create:${jobId}:${amountCents}`,
      },
    );

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

    // Idempotency check. Only 'processed' rows are true duplicates. A 'failed'
    // row (transient error on a prior delivery) or a crash-stuck 'processing'
    // row must be REPROCESSED, not skipped — otherwise a single transient
    // failure permanently drops a paid job while Stripe stops retrying.
    const [existing] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.stripeEventId, event.id))
      .limit(1);

    if (classifyWebhookEvent(existing, Date.now()) === 'skip') {
      console.log(
        `[Stripe Webhook] Skipping event ${event.id} (${event.type}) — existing status='${existing?.status}'`,
      );
      return;
    }

    if (existing) {
      // Reprocessing a failed/crash-stuck event: reset the existing row rather
      // than inserting (stripe_event_id is UNIQUE — a fresh insert would throw).
      await db
        .update(webhookEvents)
        .set({ status: 'processing', error: null })
        .where(eq(webhookEvents.stripeEventId, event.id));
    } else {
      // First delivery: record before processing. onConflictDoNothing tolerates
      // a truly-concurrent second delivery that raced past the SELECT above; if
      // it inserted first we get zero rows back and let that delivery own it.
      const inserted = await db
        .insert(webhookEvents)
        .values({
          stripeEventId: event.id,
          eventType: event.type,
          status: 'processing',
        })
        .onConflictDoNothing()
        .returning();
      if (inserted.length === 0) {
        console.log(
          `[Stripe Webhook] Skipping event ${event.id} (${event.type}) — concurrent delivery already recorded it`,
        );
        return;
      }
    }

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
