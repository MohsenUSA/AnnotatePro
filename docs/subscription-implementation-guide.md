# AnnotatePro Subscription Implementation Guide

## Overview

This guide covers implementing a subscription system for the AnnotatePro browser extension using Supabase (auth + database) and Stripe (payments).

**Business Model:**
- 3-day free trial with full features
- After trial: paywall blocks all annotation creation
- Existing annotations remain viewable (read-only)

**Pricing (per browser):**
- Monthly: $3/month
- Annual: $30/year (2 months free)
- Lifetime: $100 one-time

**Bundle Pricing (all browsers):**
- Monthly: $5/month
- Annual: $50/year
- Lifetime: $150 one-time

**Authentication:**
- Email/password
- Google OAuth

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
-- Profiles table (extends auth.users)
CREATE TABLE public.profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  email TEXT,
  trial_start TIMESTAMPTZ DEFAULT NOW(),
  plan_tier TEXT DEFAULT 'trial', -- 'trial', 'expired', 'pro', 'lifetime', 'gifted'
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Subscriptions table (platform-specific)
CREATE TABLE public.subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES auth.users(id) NOT NULL,
  platform TEXT NOT NULL, -- 'firefox', 'chrome', 'edge', 'all' (bundle)
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  status TEXT DEFAULT 'inactive', -- 'active', 'canceled', 'past_due', 'inactive'
  plan_type TEXT, -- 'monthly', 'annual', 'lifetime'
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  UNIQUE(user_id, platform) -- one subscription per platform per user
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

-- Function to create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, email, trial_start)
  VALUES (NEW.id, NEW.email, NOW());
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Trigger for new user signup
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### 1.4 Set Up Stripe

1. Create account at https://stripe.com
2. Go to Products > Add products:

   **Single Browser:**
   - **AnnotatePro Monthly** - $3.00/month (recurring)
   - **AnnotatePro Annual** - $30.00/year (recurring)
   - **AnnotatePro Lifetime** - $100.00 (one-time)

   **All Browsers Bundle:**
   - **AnnotatePro Bundle Monthly** - $5.00/month (recurring)
   - **AnnotatePro Bundle Annual** - $50.00/year (recurring)
   - **AnnotatePro Bundle Lifetime** - $150.00 (one-time)

3. Note the Price IDs (e.g., `price_xxx`)
4. Go to Developers > API keys, note your keys:
   - Publishable key (for frontend)
   - Secret key (for backend/webhooks)

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
      const platform = session.metadata?.platform // 'firefox', 'chrome', 'edge', or 'all'
      const planType = session.metadata?.plan_type
      const customerId = session.customer as string

      if (planType === 'lifetime') {
        // One-time lifetime purchase
        await supabase.from('subscriptions').upsert({
          user_id: userId,
          platform: platform,
          stripe_customer_id: customerId,
          status: 'active',
          plan_type: 'lifetime',
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,platform' })
      } else {
        // Recurring subscription (monthly/annual)
        const subscriptionId = session.subscription as string
        const subscription = await stripe.subscriptions.retrieve(subscriptionId)

        await supabase.from('subscriptions').upsert({
          user_id: userId,
          platform: platform,
          stripe_customer_id: customerId,
          stripe_subscription_id: subscriptionId,
          status: 'active',
          plan_type: subscription.items.data[0].plan.interval === 'year' ? 'annual' : 'monthly',
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,platform' })
      }

      break
    }

    case 'customer.subscription.updated': {
      const subscription = event.data.object as Stripe.Subscription
      const subscriptionId = subscription.id

      // Update by subscription ID (user may have multiple subscriptions)
      await supabase.from('subscriptions')
        .update({
          status: subscription.status === 'active' ? 'active' : subscription.status,
          current_period_end: new Date(subscription.current_period_end * 1000).toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('stripe_subscription_id', subscriptionId)

      break
    }

    case 'customer.subscription.deleted': {
      const subscription = event.data.object as Stripe.Subscription
      const subscriptionId = subscription.id

      // Cancel this specific subscription (user may have others)
      await supabase.from('subscriptions')
        .update({ status: 'canceled', updated_at: new Date().toISOString() })
        .eq('stripe_subscription_id', subscriptionId)

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

    const { priceId, platform, isLifetime } = await req.json()

    const session = await stripe.checkout.sessions.create({
      mode: isLifetime ? 'payment' : 'subscription',
      payment_method_types: ['card'],
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: 'https://YOUR_DOMAIN/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://YOUR_DOMAIN/canceled',
      metadata: {
        user_id: user.id,
        platform: platform, // 'firefox', 'chrome', 'edge', or 'all' for bundle
        plan_type: isLifetime ? 'lifetime' : 'subscription'
      },
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

const TRIAL_DAYS = 3

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
 * Get subscription status for current platform
 */
export async function getSubscriptionStatus() {
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    // Not logged in - check local trial
    return checkLocalTrial()
  }

  const platform = detectPlatform()

  // Check for active subscription (platform-specific OR bundle)
  const { data: subscriptions } = await supabase
    .from('subscriptions')
    .select('platform, status, plan_type')
    .eq('user_id', user.id)
    .eq('status', 'active')

  // Check if user has bundle (all browsers) or platform-specific subscription
  const hasBundle = subscriptions?.some(s => s.platform === 'all')
  const hasPlatform = subscriptions?.some(s => s.platform === platform)

  if (hasBundle || hasPlatform) {
    const sub = subscriptions.find(s => s.platform === 'all' || s.platform === platform)
    return { status: sub.plan_type, canCreate: true, platform: sub.platform }
  }

  // Check for gifted access in profile
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan_tier, trial_start')
    .eq('id', user.id)
    .single()

  if (profile?.plan_tier === 'gifted') {
    return { status: 'gifted', canCreate: true }
  }

  // Check trial
  if (profile?.trial_start) {
    const trialStart = new Date(profile.trial_start)
    const trialEnd = new Date(trialStart.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
    const now = new Date()

    if (now < trialEnd) {
      const daysLeft = Math.ceil((trialEnd - now) / (24 * 60 * 60 * 1000))
      return { status: 'trial', canCreate: true, daysLeft }
    }
  }

  return { status: 'expired', canCreate: false, platform }
}

async function checkLocalTrial() {
  // For users who haven't signed up yet
  const result = await browser.storage.local.get('localTrialStart')

  if (!result.localTrialStart) {
    // First time - start trial
    await browser.storage.local.set({ localTrialStart: Date.now() })
    return { status: 'trial', canCreate: true, daysLeft: TRIAL_DAYS }
  }

  const trialStart = new Date(result.localTrialStart)
  const trialEnd = new Date(trialStart.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000)
  const now = new Date()

  if (now < trialEnd) {
    const daysLeft = Math.ceil((trialEnd - now) / (24 * 60 * 60 * 1000))
    return { status: 'trial', canCreate: true, daysLeft }
  }

  return { status: 'expired', canCreate: false }
}

/**
 * Create checkout session
 * @param {string} priceId - Stripe price ID
 * @param {boolean} isBundle - Whether this is an all-browsers bundle
 * @param {boolean} isLifetime - Whether this is a lifetime purchase
 */
export async function createCheckoutSession(priceId, isBundle = false, isLifetime = false) {
  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    throw new Error('Must be logged in to subscribe')
  }

  const platform = isBundle ? 'all' : detectPlatform()

  const response = await supabase.functions.invoke('create-checkout', {
    body: { priceId, platform, isLifetime }
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
  return subscription.createCheckoutSession(
    payload.priceId,
    payload.isBundle,
    payload.isLifetime
  )
```

---

## Phase 4: Trial & Paywall UI

### 4.1 Update Popup Header

In `popup/popup.js`, add trial status display:

```javascript
import { getSubscriptionStatus } from '../background/subscription.js'

async function updateTrialStatus() {
  const status = await getSubscriptionStatus()
  const statusEl = document.getElementById('subscription-status')

  if (status.status === 'trial') {
    statusEl.innerHTML = `<span class="trial-badge">Trial: ${status.daysLeft} day${status.daysLeft !== 1 ? 's' : ''} left</span>`
  } else if (status.status === 'expired') {
    statusEl.innerHTML = `<span class="expired-badge">Trial Expired</span>`
  } else if (status.status === 'pro') {
    statusEl.innerHTML = `<span class="pro-badge">Pro</span>`
  }
}
```

### 4.2 Paywall Modal

In `content/content.js`, add paywall check before creating annotations:

```javascript
import { getSubscriptionStatus } from '../background/subscription.js'

async function checkCanCreate() {
  const status = await getSubscriptionStatus()

  if (!status.canCreate) {
    showPaywallModal()
    return false
  }

  return true
}

function showPaywallModal() {
  const modal = document.createElement('div')
  modal.className = 'annotatepro-paywall-modal'
  modal.innerHTML = `
    <div class="annotatepro-paywall-content">
      <h2>Trial Expired</h2>
      <p>Your 3-day free trial has ended. Subscribe to continue creating annotations.</p>
      <p>Your existing annotations are still viewable.</p>
      <h3>This Browser Only</h3>
      <div class="annotatepro-paywall-options">
        <button class="annotatepro-paywall-btn" data-price="monthly">$3/month</button>
        <button class="annotatepro-paywall-btn" data-price="annual">$30/year</button>
        <button class="annotatepro-paywall-btn" data-price="lifetime">$100 lifetime</button>
      </div>
      <h3>All Browsers (Firefox, Chrome, Edge)</h3>
      <div class="annotatepro-paywall-options bundle">
        <button class="annotatepro-paywall-btn" data-price="bundle-monthly">$5/month</button>
        <button class="annotatepro-paywall-btn" data-price="bundle-annual">$50/year</button>
        <button class="annotatepro-paywall-btn recommended" data-price="bundle-lifetime">$150 lifetime</button>
      </div>
      <button class="annotatepro-paywall-close">Maybe Later</button>
    </div>
  `
  document.body.appendChild(modal)

  // Handle button clicks...
}

// Modify createHighlight, createCheckbox, createPageNote:
async function createHighlight(intent = 'DEFAULT', color = null) {
  if (!await checkCanCreate()) return
  // ... existing code
}
```

### 4.3 Login UI

Add to `popup/popup.html`:

```html
<div id="auth-section" class="section" style="display: none;">
  <div id="logged-out-view">
    <button id="login-btn" class="btn btn-primary">Sign In</button>
    <button id="signup-btn" class="btn btn-secondary">Create Account</button>
    <button id="google-btn" class="btn btn-secondary">
      <img src="icons/google.svg" width="16" height="16" /> Continue with Google
    </button>
  </div>
  <div id="logged-in-view" style="display: none;">
    <span id="user-email"></span>
    <button id="logout-btn" class="btn btn-secondary">Sign Out</button>
  </div>
</div>
```

---

## Testing Checklist

### Trial Flow
- [ ] First install shows "Trial: 3 days left"
- [ ] Trial countdown decreases daily
- [ ] All features work during trial
- [ ] After 3 days, paywall appears on creation attempt
- [ ] Existing annotations remain viewable

### Auth Flow
- [ ] Email signup creates profile with trial_start
- [ ] Email login works
- [ ] Google OAuth login works
- [ ] Logout clears session
- [ ] Session persists across browser restart

### Payment Flow (Single Browser)
- [ ] Checkout redirects to Stripe
- [ ] Successful payment creates subscription with correct platform
- [ ] Webhook updates database with platform
- [ ] User sees "Pro" badge after payment
- [ ] Subscription only works on purchased browser
- [ ] Subscription cancellation removes access

### Payment Flow (Bundle)
- [ ] Bundle checkout sets platform = 'all'
- [ ] Bundle subscription works on Firefox
- [ ] Bundle subscription works on Chrome
- [ ] Bundle subscription works on Edge

### Lifetime Purchases
- [ ] Lifetime uses mode: 'payment' (not subscription)
- [ ] Lifetime sets plan_type: 'lifetime'
- [ ] No recurring billing for lifetime
- [ ] Lifetime access persists indefinitely

### Edge Cases
- [ ] Offline mode uses cached subscription status
- [ ] Network errors show appropriate message
- [ ] Invalid login shows error
- [ ] Expired session refreshes automatically
- [ ] User with expired single-browser sub sees paywall on other browsers
- [ ] User can have both single-browser and bundle (edge case)

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
// Single browser
const PRICE_MONTHLY = 'price_xxx'
const PRICE_ANNUAL = 'price_xxx'
const PRICE_LIFETIME = 'price_xxx'

// All browsers bundle
const PRICE_BUNDLE_MONTHLY = 'price_xxx'
const PRICE_BUNDLE_ANNUAL = 'price_xxx'
const PRICE_BUNDLE_LIFETIME = 'price_xxx'
```

---

## Files to Create/Modify

### New Files
- `lib/supabase.js` - Supabase client with browser.storage adapter
- `background/auth.js` - Authentication functions (signUp, signIn, signOut, Google OAuth)
- `background/subscription.js` - Subscription/trial logic, platform detection
- `styles/paywall.css` - Paywall modal styling
- `supabase/functions/stripe-webhook/index.ts` - Webhook handler
- `supabase/functions/create-checkout/index.ts` - Checkout session creator

### Modified Files
- `manifest.json` - Add `identity` permission, `host_permissions` for Supabase
- `background/background.js` - Handle auth/subscription messages
- `content/content.js` - Add `checkCanCreate()` paywall check, `showPaywallModal()`
- `popup/popup.html` - Add auth section, trial/pro badge
- `popup/popup.js` - Add auth handlers, subscription status display
- `popup/popup.css` - Style auth section, badges, trial status
- `dashboard/dashboard.html` - Add account/subscription section
- `dashboard/dashboard.js` - Add subscription management UI
