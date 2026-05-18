# AnnotatePro Subscription Implementation Guide

## Overview

This guide covers implementing a subscription system for the AnnotatePro browser extension.

**Business Model:**
- **14-day free trial, fully anonymous.** No signup, no email — install and use immediately. Trial timestamp + annotation counter live in `browser.storage.local` alongside the user's annotations. The natural disincentive against trial-farming is that wiping the trial wipes their saved work.
- After trial: paywall blocks annotation *creation*; existing annotations remain viewable (read-only)
- **Account creation happens at the moment of purchase, not before.** Stripe Checkout collects email + payment method. A Supabase profile + subscription row is created by the webhook on successful payment.
- Single account = both browsers (Firefox + Chrome when shipped). Pricing is per user, not per browser
- Firefox is the lead platform. Stealth "Find on Page" feature is Firefox-exclusive (uses `browser.find` API which Chrome doesn't expose). Chrome version, when shipped, omits Find on Page

**Pricing:**
- **Annual:** $25/year
- **No lifetime tier** — annual only, to preserve recurring revenue and avoid perpetual-support liability
- **No monthly tier** — adds billing complexity, $25/year is already in tip-jar territory ($2/mo equivalent)
- Prices are not promised "forever" in marketing copy. Use "$25/year." Existing subscribers grandfather automatically when prices change (standard Stripe behavior on renewal)

**Launch Promotion:**
- **50% off the first year** — $12.50 charge in year one, then $25/year normal at renewal.
- Limited to the first 500 customers OR first 30 days post-launch, whichever comes first.
- Implementation: Stripe coupon with 50% discount, `duration: once` (applies to the first invoice only — since billing is annual, that's exactly year one).
- Marketing: explicit early-supporter framing — "Get in early at half price."
- The discount is surfaced as a **visible promo badge on the trial-expiry paywall** ("🎉 Launch deal — 50% off, first year $12.50") and is auto-applied to the Stripe Checkout session during the launch window. No email capture, no signup ask — just the price drop in the user's face. Users hesitant about paying typically won't hand over an email either; the value pitch has to win on its own.

**Authentication:**
- No authentication at all during the free trial.
- At checkout, Stripe Checkout itself collects the email. After payment, the webhook creates the Supabase auth user + profile + subscription row using that email.
- For subsequent installs / re-installs / cross-browser sync (Chrome when shipped), the user signs in with the same email:
  - Email/password
  - Google OAuth (the email must match the Stripe-collected email for the subscription to apply)

---

## Open architectural questions (decide before building)

These are decisions the rest of this doc leans on. Resolving them changes the implementation in non-trivial ways.

### 1. Payment processor: Stripe vs. Paddle/LemonSqueezy

**Stripe** (this doc's current path): you are the seller of record. You owe sales tax / VAT / GST in every jurisdiction you sell into. EU VAT registration kicks in immediately for digital goods sold to consumers. Stripe Tax can calculate the tax, but you still register and remit yourself.

**Paddle / LemonSqueezy** (Merchant of Record alternative): they handle tax registration, calculation, and remittance globally. Higher fee (~5% + 50¢ vs. Stripe's 2.9% + 30¢) but you stop thinking about tax forever. For a $25/year product going global, this is almost certainly the right call.

**Recommendation:** use Paddle. The fee delta is dwarfed by what you'd pay an accountant to handle even three countries' VAT.

### 2. License verification: online-only vs. signed JWT

**Online-only** (this doc's current path): extension queries Supabase on each check. If Supabase is down, paying users can't annotate. If you ever shut down the service, every customer's extension breaks.

**Signed JWT** (recommended): issue a license token at purchase, signed with a private key. The extension carries the matching public key and verifies the signature locally — no network round-trip required to know whether a user is paid. Tokens carry a short expiry (e.g. 30 days) and silently refresh from the API as they age, with an offline grace period so brief outages don't break paying customers. This is how 1Password and Sublime Text work.

**Recommendation:** signed JWT with online refresh. Same Supabase backend for revocation lookups, but treat them as optional. Failure mode is degraded, not broken.

### 3. AMO listing strategy

Mozilla allows paid extensions but requires upfront disclosure of pricing and trial mechanics in the listing. Submit AnnotatePro as a free extension with an in-extension paywall (the standard pattern; AMO accepts this). Disclose pricing in the listing description and the trial behavior in the screenshots.

### 4. Trial gating mechanism

**Anonymous local trial** (current path): timestamp + counter stored in `browser.storage.local` alongside annotations. Zero install friction — install and use immediately, no email, no account.

**Email-gated trial** (rejected): would require account creation before first use, which kills the install funnel for a local-first product. Sets the wrong tone vs. the privacy-first marketing position.

**Recommendation:** anonymous local. The natural anti-farming defense is that wiping the trial wipes the user's saved annotations — for the conversion-driving majority that's enough friction. The minority who reset storage to game the trial were never going to pay.

Tradeoffs accepted:
- No email captured pre-paywall, and no email-capture form at the paywall either. The mitigation for "no remarketing handle" is a **visible price drop on the paywall** — the 50% launch discount is displayed prominently, so the user makes a decision now rather than later. Email capture was considered and rejected because users hesitant to pay are also hesitant to share email; the form would have low submission rates and add friction without earning conversion.
- Power users can reset by clearing extension storage. Out of scope to defend against.

---

## Architecture

```
┌─────────────────┐      ┌─────────────────────────────────┐
│                 │      │           Supabase              │
│   AnnotatePro   │◄────►│  ┌─────────┐    ┌───────────┐  │
│   Extension     │      │  │  Auth   │    │ PostgreSQL│  │
│                 │      │  └─────────┘    └───────────┘  │
└────────┬────────┘      │        │              │        │
         │               │  ┌─────────────────────┐       │
         │               │  │   Edge Functions    │       │
         │               │  │  (Stripe webhooks)  │       │
         │               │  └──────────┬──────────┘       │
         │               └─────────────┼──────────────────┘
         │                             │
         │               ┌─────────────▼──────────────────┐
         └──────────────►│           Stripe               │
                         │  (Checkout, Subscriptions)     │
                         └────────────────────────────────┘
```

---

## Phase 1: Backend Setup

### 1.1 Create Supabase Project

1. Go to https://supabase.com and create account
2. Create new project (remember the database password)
3. Note your project URL and anon key from Settings > API

### 1.2 Configure Authentication

**Email/Password:**
1. Go to Authentication > Providers
2. Email is enabled by default
3. Configure email templates in Authentication > Email Templates

**Google OAuth:**
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create new project or select existing
3. Go to APIs & Services > OAuth consent screen
   - User Type: External
   - App name: AnnotatePro
   - User support email: your email
   - Developer contact: your email
4. Go to APIs & Services > Credentials
   - Create Credentials > OAuth client ID
   - Application type: Web application
   - Name: AnnotatePro
   - Authorized JavaScript origins:
     - `https://YOUR_PROJECT.supabase.co`
   - Authorized redirect URIs:
     - `https://YOUR_PROJECT.supabase.co/auth/v1/callback`
5. Copy Client ID and Client Secret
6. In Supabase: Authentication > Providers > Google
   - Enable Google
   - Paste Client ID and Client Secret

### 1.3 Create Database Tables

Run this SQL in Supabase SQL Editor:

```sql
-- Profiles table (extends auth.users). A profile only exists for users who
-- have paid (or been gifted access). Trial users have no row here — their
-- trial state lives entirely in the extension's browser.storage.local.
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT,
  plan_tier TEXT DEFAULT 'active', -- 'active', 'expired', 'grandfathered', 'gifted'
  price_id TEXT, -- which Stripe Price the user is on (lets you grandfather later)
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);


-- Subscriptions table (single account = both browsers; no per-platform rows)
CREATE TABLE public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL UNIQUE,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'inactive', -- 'active', 'canceled', 'past_due', 'inactive'
  price_id TEXT, -- locked-in price the user is subscribed at
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.subscriptions ENABLE ROW LEVEL SECURITY;

-- Profiles policies
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can update own profile" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- Subscriptions policies
CREATE POLICY "Users can view own subscription" ON public.subscriptions
  FOR SELECT USING (auth.uid() = user_id);

-- Function to create profile on signup. Note that signup only happens at
-- successful Stripe checkout (via the webhook calling auth.admin.createUser),
-- not at trial start — so any row in profiles corresponds to a paying user.
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email)
  VALUES (NEW.id, NEW.email);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### 1.3.1 Local trial state (browser.storage.local)

The trial is owned entirely by the client. Schema:

```js
// browser.storage.local
{
  trialState: {
    firstUsedAt: 1234567890123,     // Date.now() of first annotation create
    annotationCount: 12,            // running count; informational, not a cap (v1)
    expiredPaywallShownAt: null,    // null until first paywall, then a timestamp
  }
}
```

- `firstUsedAt` is set lazily on the first `createHighlight` / `createCheckbox` / `createPageNote` call. Not on install — installing without using shouldn't burn trial days.
- Trial expires `firstUsedAt + 14 days`.
- After expiry, the paywall blocks creation. Reads, search, export, and viewing existing annotations all keep working.

### 1.4 Set Up Stripe (or Paddle — see Open Question #1)

Stripe setup is described here. If you go with Paddle/LemonSqueezy instead (recommended), the concepts are identical but the dashboard differs — you'd create a single "AnnotatePro Annual" product at $25/year and a launch coupon, then point the extension's checkout link at Paddle's hosted checkout.

**Stripe steps:**

1. Create account at https://stripe.com
2. Go to Products > Add product:
   - **AnnotatePro Annual** — $25.00/year (recurring)
3. Note the Price ID (e.g., `price_xxx`). Store this as your `price_id_current` in your config — the active price for new sign-ups.
4. Create launch promo coupon (Coupons > New):
   - **50% off, duration: once**
   - Name: `launch-half-off-year-one`
   - Restrict to first 500 redemptions
   - With `duration: once` on an annual plan, the discount applies to the first invoice only — $12.50 in year one, $25 at renewal in year two.
5. Go to Developers > API keys, note your keys:
   - Publishable key (for frontend)
   - Secret key (for backend/webhooks)

**Future price changes:** when you raise the price (e.g., to $35/year after launch traction), create a *new* Price object in Stripe (don't edit the existing one). Update `price_id_current` to the new ID. Existing subscriptions on the old Price renew at their original $25/year forever (Stripe's built-in grandfather behavior). Tag each user's `price_id` in their Supabase profile so you always know which cohort they're on.

---

## Phase 2: Stripe Webhooks (Supabase Edge Function)

### 2.1 Create Edge Function

Create file `supabase/functions/stripe-webhook/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.0.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const supabaseUrl = Deno.env.get('SUPABASE_URL')!
const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const webhookSecret = Deno.env.get('STRIPE_WEBHOOK_SECRET')!

serve(async (req) => {
  const signature = req.headers.get('stripe-signature')!
  const body = await req.text()

  let event: Stripe.Event

  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret)
  } catch (err) {
    return new Response(`Webhook Error: ${err.message}`, { status: 400 })
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session
      const userId = session.metadata?.user_id
      const customerId = session.customer as string
      const subscriptionId = session.subscription as string

      const subscription = await stripe.subscriptions.retrieve(subscriptionId)
      const priceId = subscription.items.data[0].price.id

      await supabase.from('subscriptions').upsert({
        user_id: userId,
        stripe_customer_id: customerId,
        stripe_subscription_id: subscriptionId,
        status: 'active',
        price_id: priceId,
        current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
        updated_at: new Date().toISOString(),
      }, { onConflict: 'user_id' })

      // Tag the user's locked-in price so we can grandfather them on future
      // price changes without touching their Stripe subscription.
      await supabase.from('profiles')
        .update({ plan_tier: 'active', price_id: priceId, updated_at: new Date().toISOString() })
        .eq('id', userId)

      break
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription

      await supabase.from('subscriptions')
        .update({
          status: subscription.status === 'active' ? 'active' : subscription.status,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', subscription.id)

      break
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription

      await supabase.from('subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscription.id)

      break
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

### 2.2 Create Checkout Session Function

Create file `supabase/functions/create-checkout/index.ts`:

```typescript
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import Stripe from 'https://esm.sh/stripe@12.0.0?target=deno'

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2023-10-16',
})

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: req.headers.get('Authorization')! } } }
    )

    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const { priceId, couponId } = await req.json()

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      discounts: couponId ? [{ coupon: couponId }] : undefined,
      success_url: 'https://YOUR_DOMAIN/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://YOUR_DOMAIN/canceled',
      metadata: { user_id: user.id },
      customer_email: user.email,
    })

    return new Response(JSON.stringify({ url: session.url }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
```

### 2.3 Deploy Functions

```bash
# Install Supabase CLI
npm install -g supabase

# Login
supabase login

# Link project
supabase link --project-ref YOUR_PROJECT_REF

# Set secrets
supabase secrets set STRIPE_SECRET_KEY=sk_live_xxx
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx

# Deploy
supabase functions deploy stripe-webhook
supabase functions deploy create-checkout
```

### 2.4 Configure Stripe Webhook

1. Go to Stripe Dashboard > Developers > Webhooks
2. Add endpoint: `https://YOUR_PROJECT.supabase.co/functions/v1/stripe-webhook`
3. Select events:
   - `checkout.session.completed`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
4. Copy webhook signing secret to Supabase secrets

---

## Phase 3: Extension Integration

### 3.1 Add Supabase Client

Create file `lib/supabase.js`:

```javascript
import { createClient } from '@supabase/supabase-js'

const supabaseUrl = 'https://YOUR_PROJECT.supabase.co'
const supabaseAnonKey = 'YOUR_ANON_KEY'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    storage: {
      getItem: (key) => browser.storage.local.get(key).then(r => r[key] || null),
      setItem: (key, value) => browser.storage.local.set({ [key]: value }),
      removeItem: (key) => browser.storage.local.remove(key),
    },
    autoRefreshToken: true,
    persistSession: true,
  }
})
```

### 3.2 Update manifest.json

Add to `manifest.json`:

```json
{
  "permissions": [
    "storage",
    "identity"
  ],
  "host_permissions": [
    "https://YOUR_PROJECT.supabase.co/*",
    "https://api.stripe.com/*"
  ]
}
```

### 3.3 Create Auth Module

Create file `background/auth.js`:

```javascript
import { supabase } from '../lib/supabase.js'

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password })
  return { data, error }
}

export async function signIn(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password })
  return { data, error }
}

export async function signInWithGoogle() {
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: browser.identity.getRedirectURL()
    }
  })
  return { data, error }
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  return { error }
}

export async function getUser() {
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

export async function getSession() {
  const { data: { session } } = await supabase.auth.getSession()
  return session
}
```

### 3.4 Create Subscription Module

Create file `background/subscription.js`:

```javascript
import { supabase } from '../lib/supabase.js'

const TRIAL_DAYS = 14
const TRIAL_KEY = 'trialState'

/**
 * Detect current browser platform
 */
export function detectPlatform() {
  const ua = navigator.userAgent
  if (typeof browser !== 'undefined' && browser.runtime?.getBrowserInfo) {
    return 'firefox'
  }
  if (ua.includes('Edg/')) return 'edge'
  if (ua.includes('Chrome')) return 'chrome'
  return 'unknown'
}

/**
 * Read local trial state (anonymous, browser.storage.local).
 */
async function getTrialState() {
  const out = await browser.storage.local.get(TRIAL_KEY)
  return out[TRIAL_KEY] || null
}

async function setTrialState(state) {
  await browser.storage.local.set({ [TRIAL_KEY]: state })
}

/**
 * Called on every annotation create attempt. Lazily starts the trial on the
 * first create — installing without using shouldn't burn trial days.
 */
export async function recordTrialUsage() {
  const existing = await getTrialState()
  if (existing) {
    existing.annotationCount = (existing.annotationCount || 0) + 1
    await setTrialState(existing)
    return existing
  }
  const fresh = {
    firstUsedAt: Date.now(),
    annotationCount: 1,
    expiredPaywallShownAt: null,
  }
  await setTrialState(fresh)
  return fresh
}

/**
 * Get subscription status. Local trial first; only checks Supabase if the
 * user has actually signed in (which only happens after purchase).
 */
export async function getSubscriptionStatus() {
  // 1. Logged in? Trust the server-side subscription state.
  const { data: { user } } = await supabase.auth.getUser()
  if (user) {
    const { data: subscription } = await supabase
      .from('subscriptions')
      .select('status, price_id, current_period_end')
      .eq('user_id', user.id)
      .maybeSingle()

    if (subscription?.status === 'active') {
      return { status: 'active', canCreate: true, priceId: subscription.price_id }
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('plan_tier')
      .eq('id', user.id)
      .maybeSingle()

    if (profile?.plan_tier === 'gifted') {
      return { status: 'gifted', canCreate: true }
    }

    // Signed-in user with a lapsed subscription — show paywall.
    return { status: 'expired', canCreate: false }
  }

  // 2. Not logged in → anonymous trial path.
  const trial = await getTrialState()
  if (!trial) {
    // Never used the extension yet. Allow the first create; it'll start
    // the trial via recordTrialUsage().
    return { status: 'trial_not_started', canCreate: true, daysLeft: TRIAL_DAYS }
  }
  const trialEnd = trial.firstUsedAt + TRIAL_DAYS * 24 * 60 * 60 * 1000
  const now = Date.now()
  if (now < trialEnd) {
    const daysLeft = Math.ceil((trialEnd - now) / (24 * 60 * 60 * 1000))
    return { status: 'trial', canCreate: true, daysLeft }
  }
  return { status: 'expired', canCreate: false }
}

/**
 * Create checkout session for the annual subscription. No login required —
 * Stripe Checkout collects email and the webhook creates the Supabase user
 * on successful payment.
 * @param {string} priceId - Stripe price ID (current active price)
 * @param {string} [couponId] - Optional Stripe coupon (e.g., 'launch-half-off-year-one')
 */
export async function createCheckoutSession(priceId, couponId) {
  // No auth requirement — anonymous checkout is the whole point.
  const response = await supabase.functions.invoke('create-checkout', {
    body: { priceId, couponId }
  })

  if (response.error) {
    throw new Error(response.error.message)
  }

  return response.data.url
}

```

### 3.5 Add Message Handlers to background.js

Add these cases to the message switch in `background/background.js`:

```javascript
// Auth messages
case 'SIGN_UP':
  return auth.signUp(payload.email, payload.password)

case 'SIGN_IN':
  return auth.signIn(payload.email, payload.password)

case 'SIGN_IN_GOOGLE':
  return auth.signInWithGoogle()

case 'SIGN_OUT':
  return auth.signOut()

case 'GET_USER':
  return auth.getUser()

case 'GET_SESSION':
  return auth.getSession()

// Subscription messages
case 'GET_SUBSCRIPTION_STATUS':
  return subscription.getSubscriptionStatus()

case 'CREATE_CHECKOUT':
  return subscription.createCheckoutSession(payload.priceId, payload.couponId)
```

---

## Phase 4: Trial & Paywall UI

### 4.1 Update Popup Header

In `popup/popup.js`, add trial status display. No account check needed during the trial — the status comes from local trial state.

```javascript
import { getSubscriptionStatus } from '../background/subscription.js'

async function updateTrialStatus() {
  const status = await getSubscriptionStatus()
  const statusEl = document.getElementById('subscription-status')

  if (status.status === 'trial' || status.status === 'trial_not_started') {
    statusEl.innerHTML = `<span class="trial-badge">Trial: ${status.daysLeft} day${status.daysLeft !== 1 ? 's' : ''} left</span>`
  } else if (status.status === 'expired') {
    statusEl.innerHTML = `<span class="expired-badge">Trial Expired</span>`
  } else if (status.status === 'active' || status.status === 'gifted') {
    statusEl.innerHTML = `<span class="pro-badge">Pro</span>`
  }
}
```

### 4.2 Paywall Modal — single CTA with visible launch promo

In `content/content.js`, add paywall check before creating annotations. The modal shows the launch promo as a **visible price badge** above the Subscribe button. No email capture — the discount itself is the carrot, and Stripe Checkout collects email at the moment of payment intent.

```javascript
import { getSubscriptionStatus, recordTrialUsage } from '../background/subscription.js'

async function checkCanCreate() {
  const status = await getSubscriptionStatus()
  if (!status.canCreate) {
    showPaywallModal()
    return false
  }
  // First create starts the trial counter (lazy init).
  if (status.status === 'trial_not_started' || status.status === 'trial') {
    await recordTrialUsage()
  }
  return true
}

function showPaywallModal() {
  const launchActive = isWithinLaunchWindow()
  const modal = document.createElement('div')
  modal.className = 'annotatepro-paywall-modal'
  modal.innerHTML = `
    <div class="annotatepro-paywall-content">
      <h2>Your 14-day trial has ended</h2>
      <p>Existing annotations stay viewable. Subscribe to keep creating new ones.</p>

      ${launchActive ? `
      <div class="annotatepro-paywall-promo">
        <span class="promo-badge">🎉 Launch deal</span>
        <div class="promo-headline">
          <span class="promo-price">$12.50</span>
          <span class="promo-strike">$25</span>
          <span class="promo-period">first year</span>
        </div>
        <p class="promo-fineprint">50% off your first year. Renews at $25/year. Limited to the first 500 customers.</p>
      </div>
      ` : ''}

      <div class="annotatepro-paywall-primary">
        <button class="annotatepro-paywall-btn recommended" data-action="subscribe">
          ${launchActive ? 'Subscribe at half price' : 'Subscribe — $25/year'}
          <span class="paywall-note">One account, all browsers</span>
        </button>
      </div>

      <button class="annotatepro-paywall-close">Maybe later</button>
    </div>
  `
  document.body.appendChild(modal)

  modal.querySelector('[data-action="subscribe"]').addEventListener('click', async () => {
    const url = await sendMessage('CREATE_CHECKOUT', {
      priceId: PRICE_ANNUAL_CURRENT,
      couponId: launchActive ? COUPON_LAUNCH : undefined,
    })
    if (url) window.open(url, '_blank')
  })

  modal.querySelector('.annotatepro-paywall-close').addEventListener('click', () => modal.remove())
}

// Modify createHighlight, createCheckbox, createPageNote:
async function createHighlight(intent = 'DEFAULT', color = null) {
  if (!await checkCanCreate()) return
  // ... existing code
}
```

### 4.3 Account UI (post-purchase only)

The popup shows no login UI during the trial — there is no account to log into yet. Login appears only as part of the post-purchase / cross-device flow, when a user installs AnnotatePro on a second browser and needs to claim their existing subscription.

Add to `popup/popup.html`, hidden by default and shown only when subscription status is `expired` AND the user has clicked "I already paid":

```html
<div id="auth-section" class="section" style="display: none;">
  <p class="auth-explainer">Sign in with the email you used at checkout.</p>
  <button id="login-btn" class="btn btn-primary">Sign In</button>
  <button id="google-btn" class="btn btn-secondary">
    <img src="icons/google.svg" width="16" height="16" /> Continue with Google
  </button>
  <div id="logged-in-view" style="display: none;">
    <span id="user-email"></span>
    <button id="logout-btn" class="btn btn-secondary">Sign Out</button>
  </div>
</div>
```

> No "Create Account" CTA — accounts are created server-side by the Stripe webhook on successful payment. Showing a "Create Account" button outside checkout would be confusing.

---

## Testing Checklist

### Trial Flow (anonymous)
- [ ] Fresh install requires NO signup — user can create annotations immediately
- [ ] First create writes `trialState` to `browser.storage.local` with `firstUsedAt` and `annotationCount: 1`
- [ ] Popup header shows "Trial: 14 days left" once the trial has started
- [ ] Installing without using the extension does NOT consume trial days (counter starts on first create, not on install)
- [ ] Trial countdown decreases daily
- [ ] All features work during trial
- [ ] After 14 days, paywall appears on create attempt
- [ ] Existing annotations remain viewable and editable after expiry; only *creation* is blocked
- [ ] Clearing `browser.storage.local` resets the trial — and also wipes saved annotations (the natural disincentive)

### Paywall + Launch Promo
- [ ] Paywall modal renders the launch promo badge ("🎉 Launch deal — $12.50 first year, $25 strikethrough") when within the launch window
- [ ] Outside the launch window, the promo block is hidden and the button reads "Subscribe — $25/year"
- [ ] During the launch window, the Subscribe button reads "Subscribe at half price"
- [ ] "Maybe later" closes the modal without burning trial state or making any network calls
- [ ] "Subscribe" opens Stripe Checkout in a new tab with the launch coupon pre-applied during the launch window
- [ ] No email-capture form, no `early_emails` writes — the only network call from this modal is `CREATE_CHECKOUT`

### Account Creation at Purchase
- [ ] Anonymous user can complete Stripe Checkout without prior signup
- [ ] On successful payment, the webhook creates an `auth.users` entry with the email Stripe collected
- [ ] A `profiles` row is created via the `on_auth_user_created` trigger with `plan_tier = 'active'`
- [ ] A `subscriptions` row is created with the Stripe IDs and the current `price_id`
- [ ] The extension transitions from "expired" to "active" within ~30s of checkout success (via webhook + storage refresh)

### Auth Flow (cross-device only)
- [ ] No "Create Account" CTA exists in the extension UI outside Stripe Checkout
- [ ] On a second browser/install, "Sign In" with the Stripe-collected email reveals the existing subscription
- [ ] Google OAuth: only resolves to an existing account if the Google email matches the Stripe email
- [ ] Logout clears session but does NOT delete local annotations or trial state
- [ ] Session persists across browser restart

### Payment Flow
- [ ] Checkout redirects to Stripe (or Paddle, if MoR chosen)
- [ ] Successful payment creates subscription row tagged with current `price_id`
- [ ] Webhook updates `plan_tier` to 'active' and stores `stripe_subscription_id`
- [ ] User sees "Pro" badge in popup after payment
- [ ] Subscription works on both Firefox and Chrome with the same account
- [ ] Subscription cancellation in Stripe portal flips `plan_tier` to 'canceled' on `current_period_end`

### Launch Promo
- [ ] First 500 customers see 50% off applied to year-one invoice ($12.50)
- [ ] Customer #501 sees full $25 charge
- [ ] Promo coupon stops applying after 30 days regardless of count
- [ ] Year-2 renewal of a launch-promo customer charges full $25 automatically (because `duration: once`)

### Price Changes (post-launch)
- [ ] Creating a new Price in Stripe and updating `price_id_current` does not affect existing subscribers
- [ ] Existing subscribers continue renewing at their original Price ID indefinitely
- [ ] New checkout sessions use the new price
- [ ] `price_id` in profiles correctly reflects each user's locked-in price

### Edge Cases
- [ ] Offline mode: extension uses cached JWT license, allows continued use during outage
- [ ] License JWT expiry triggers silent refresh near expiry
- [ ] Network errors show "couldn't verify, try again" — not a hard paywall
- [ ] Invalid login shows error
- [ ] Expired session refreshes automatically

---

## Granting Free Subscriptions

To give a user free access (beta testers, friends, partners), set their `plan_tier` to `'gifted'` in Supabase:

```sql
-- Grant gifted access by email
UPDATE profiles
SET plan_tier = 'gifted', updated_at = NOW()
WHERE email = 'friend@example.com';

-- Or by user ID
UPDATE profiles
SET plan_tier = 'gifted', updated_at = NOW()
WHERE id = 'uuid-here';

-- Revoke gifted access (reverts to expired)
UPDATE profiles
SET plan_tier = 'expired', updated_at = NOW()
WHERE email = 'friend@example.com';
```

The user will see a "Gifted" badge in the popup and have full access without payment.

---

## Environment Variables

### Supabase Edge Functions
```
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx
SUPABASE_ANON_KEY=eyJxxx
```

### Extension (in lib/supabase.js)
```javascript
const supabaseUrl = 'https://xxx.supabase.co'
const supabaseAnonKey = 'eyJxxx'
```

### Stripe Price IDs
```javascript
// Single active price for new sign-ups. When raising prices later, create a new
// Price in Stripe and update this constant. Existing subscribers grandfather
// automatically because their subscription is bound to the old Price ID.
const PRICE_ANNUAL_CURRENT = 'price_xxx'

// Launch promo coupon — applies 50% off the first invoice only (duration: once).
// On an annual plan that means year one is $12.50, year two renews at full $25.
// Limited to first 500 redemptions in Stripe dashboard config.
const COUPON_LAUNCH = 'launch-half-off-year-one'
```

---

## Files to Create/Modify

### New Files
- `lib/supabase.js` - Supabase client with browser.storage adapter
- `background/auth.js` - Auth functions (only used post-purchase / cross-device sign-in)
- `background/subscription.js` - Anonymous local trial + post-purchase server check
- `styles/paywall.css` - Paywall modal styling (two-CTA layout + email capture form)
- `supabase/functions/stripe-webhook/index.ts` - Webhook handler — creates auth.users + profile + subscription on successful payment
- `supabase/functions/create-checkout/index.ts` - Checkout session creator (no auth required — anonymous checkout)

### Modified Files
- `manifest.json` - Add `identity` permission, `host_permissions` for Supabase
- `background/background.js` - Handle auth/subscription messages
- `content/content.js` - Add `checkCanCreate()` paywall check, `showPaywallModal()`
- `popup/popup.html` - Add auth section, trial/pro badge
- `popup/popup.js` - Add auth handlers, subscription status display
- `popup/popup.css` - Style auth section, badges, trial status
- `dashboard/dashboard.html` - Add account/subscription section
- `dashboard/dashboard.js` - Add subscription management UI
