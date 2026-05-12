import type { VercelRequest, VercelResponse } from '@vercel/node';
import Stripe from 'stripe';
import { ObjectId } from 'mongodb';
import { connectToDatabase } from './lib/mongodb';
import { sendFoundingMemberReceiptEmail } from './lib/email';

// Raw body required for Stripe signature verification
export const config = { api: { bodyParser: false } };

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not set');
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is not set');

const STRIPE_SECRET_KEY     = process.env.STRIPE_SECRET_KEY as string;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET as string;
const SLACK_WEBHOOK_URL     = process.env.SLACK_WEBHOOK_URL || '';
const FOUNDING_MEMBER_LIMIT = 250;

const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2026-04-22.dahlia' as any });

// Read the raw request body as a Buffer (needed for Stripe signature verification)
async function getRawBody(req: VercelRequest): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer | string) =>
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    );
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// Fire-and-forget Slack notification (non-fatal)
async function notifySlack(text: string): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.error('Slack notification failed:', err);
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const sig = req.headers['stripe-signature'] as string;
  if (!sig) return res.status(400).json({ error: 'Missing stripe-signature header' });

  let event: any;
  try {
    const rawBody = await getRawBody(req);
    event = stripe.webhooks.constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: `Webhook error: ${err.message}` });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      default:
        // Unhandled event types are silently ignored
        break;
    }
    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error(`Error handling webhook event ${event.type}:`, err);
    return res.status(500).json({ error: 'Webhook handler error' });
  }
}

// ── checkout.session.completed ────────────────────────────────────────────────
async function handleCheckoutCompleted(session: any) {
  const userId = session.metadata?.userId;
  const offer  = session.metadata?.offer;

  if (!userId || offer !== 'founding_member') {
    console.error('checkout.session.completed: missing/invalid metadata', session.id);
    return;
  }

  const db   = await connectToDatabase();
  const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  if (!user) {
    console.error('checkout.session.completed: user not found', userId);
    return;
  }

  const subscriptionId = typeof session.subscription === 'string'
    ? session.subscription
    : session.subscription?.id ?? '';

  // Idempotency: skip if this exact subscription was already processed
  if (user.stripeSubscriptionId === subscriptionId && user.foundingMember === true) {
    console.log('checkout.session.completed: already processed', subscriptionId);
    return;
  }

  const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
  const periodEnd    = new Date(subscription.current_period_end * 1000);
  const customerId   = typeof session.customer === 'string'
    ? session.customer
    : session.customer?.id ?? '';

  await db.collection('users').updateOne(
    { _id: new ObjectId(userId) },
    {
      $set: {
        isPro:                        true,
        foundingMember:               true,
        // Preserve original join date if somehow re-processed
        foundingMemberJoinedAt:       user.foundingMemberJoinedAt ?? new Date(),
        stripeCustomerId:             customerId,
        stripeSubscriptionId:         subscriptionId,
        subscriptionStatus:           subscription.status,
        subscriptionCurrentPeriodEnd: periodEnd,
      },
    }
  );

  const foundingCount = await db.collection('users').countDocuments({ foundingMember: true });

  // Receipt email (non-fatal)
  try {
    await sendFoundingMemberReceiptEmail(user.email, user.name || user.email.split('@')[0], periodEnd);
  } catch (err) {
    console.error('Failed to send founding member receipt email:', err);
  }

  await notifySlack(`New Founding Member: ${user.email} - ${foundingCount}/${FOUNDING_MEMBER_LIMIT}`);

  console.log(`Founding member activated: ${user.email} (${foundingCount}/${FOUNDING_MEMBER_LIMIT})`);
}

// ── customer.subscription.deleted ────────────────────────────────────────────
async function handleSubscriptionDeleted(subscription: any) {
  const db = await connectToDatabase();

  const result = await db.collection('users').updateOne(
    { stripeSubscriptionId: subscription.id },
    {
      $set: {
        isPro:                        false,
        subscriptionStatus:           'canceled',
        subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end * 1000),
        // foundingMember and foundingMemberJoinedAt intentionally preserved
      },
    }
  );

  if (result.matchedCount === 0) {
    console.error('subscription.deleted: no user found for subscription', subscription.id);
  } else {
    console.log('Subscription canceled, isPro set to false:', subscription.id);
  }
}

// ── invoice.payment_failed ────────────────────────────────────────────────────
async function handlePaymentFailed(invoice: any) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id ?? '';
  if (!subscriptionId) return;

  console.warn(`Payment failed for subscription: ${subscriptionId}`);

  const db = await connectToDatabase();
  await db.collection('users').updateOne(
    { stripeSubscriptionId: subscriptionId },
    { $set: { subscriptionStatus: 'past_due' } }
  );
}

// ── invoice.payment_succeeded ─────────────────────────────────────────────────
async function handlePaymentSucceeded(invoice: any) {
  const subscriptionId = typeof invoice.subscription === 'string'
    ? invoice.subscription
    : invoice.subscription?.id ?? '';
  if (!subscriptionId) return;

  // On renewal, refresh period end and ensure status is active
  if (invoice.billing_reason === 'subscription_cycle') {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId) as any;
    const db = await connectToDatabase();
    await db.collection('users').updateOne(
      { stripeSubscriptionId: subscriptionId },
      {
        $set: {
          subscriptionStatus:           'active',
          subscriptionCurrentPeriodEnd: new Date(subscription.current_period_end * 1000),
        },
      }
    );
    console.log('Subscription renewed:', subscriptionId);
  }
}
