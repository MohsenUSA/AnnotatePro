# AnnotatePro — Security, Anti-Cloning, and Competitive Positioning

_Snapshot: 2026-05-16. Strategy reference. Revisit annually or when business
context changes significantly._

This doc covers two related questions:

1. **What can we actually do to prevent paid-extension cloning?** What's possible, what's theatre, and what fits AnnotatePro's local-first positioning.
2. **Who are our actual competitors in web annotation, and how does our $25/yr position?**

---

## Part 1 — The security and anti-cloning reality

### What you cannot do

Browser extensions are JavaScript bundles shipped to user devices. Anyone can:

1. Download the extension from AMO (it's just a `.xpi`, which is a zip).
2. Unpack it with `unzip` or any archive tool.
3. Read or modify any `.js`, `.css`, `.html`, `manifest.json`.
4. Re-pack it under a different name and publish on AMO/Chrome Web Store.

**There is no DRM for extensions.** No browser provides a sandbox that prevents this. Anyone telling you otherwise is wrong or selling something. Obfuscation (Terser, javascript-obfuscator) only slows casual readers by minutes — `prettier` and a coffee break gets a determined attacker to readable code.

### What you can do

Goal is not "make the code unreadable" — it's **"make the paid features impossible to replicate without you."** Defenses, ranked by effectiveness:

| Defense | Strength | Notes |
|---|---|---|
| **Server-bound paid features** | Strongest | Clone can fork the JS but can't fork your backend. Forces clone-ers to also rebuild infrastructure — usually not worth it |
| **JWT-signed licenses (Ed25519 / RSA)** | Strong as a license check, weak alone | Private key stays on your server; public key in the extension verifies signatures locally. Clones can't *forge* valid licenses, but they can *remove* the verification |
| **Trademark registration + DMCA** | Strong, slow to acquire | $250 US / TEAS Plus. Takes 6–9 months. AMO and Chrome Web Store have well-trodden complaint processes — clones using your name go down within days *if* you have the trademark already |
| **Continuous shipping + brand trust** | Moderate, compounds over time | A clone is a one-time fork. Two weeks later you've shipped 3 updates and clones lag |
| **AMO trust signals** | Moderate | Verified publisher, reviews, install count. Users generally pick the original; clones look sketchy |
| **Code obfuscation** | Weak | Use as light friction only. Don't rely on it |
| **Anti-debugging / integrity self-checks** | Theatre | Do not waste time on this. Patched out in an hour. Spend the time on a trademark filing instead |

### The JWT licensing path (load-bearing)

Standard architecture used by 1Password, Sublime Text, and most paid indie tools:

1. Generate an Ed25519 keypair. Private key stays on your server forever. Public key ships in the extension binary.
2. After successful payment, your backend mints a JWT containing `{ user_id, email, expires_at, plan }`, signed with the private key.
3. Extension verifies the JWT signature locally on every paid-feature check — no network call needed for normal use.
4. JWT expires every 30 days; extension silently refreshes from your API before expiry. Offline grace period of a few days so brief outages don't break paying users.

**What a clone can do:**

- Read the public key — useless without the private key.
- Try to forge a JWT — fails signature verification.
- **Remove the verification entirely** — yields a "free Pro" clone. This is the real threat.

JWT alone doesn't prevent the third attack. It needs to be combined with one of:
- Server-bound paid features (clone can't run those features without your backend), OR
- Trademark enforcement (DMCA clones that strip the paywall and reuse your name), OR
- Both.

### Threat model by stage

Clone risk is not constant. It scales with how much value a clone would extract.

| Stage | Clone risk | Defense priority |
|---|---|---|
| Pre-launch / first months | Near zero. Nobody clones a product without a known audience | Ship the JWT licensing; file the trademark |
| ~500–2000 paying users | Low. Some scrapers, no serious clones | Watch AMO catalog. Trademark should be filed by now |
| 5000+ paying users / $50k+ ARR | Real. Clones start appearing | Active enforcement. Trademark must be in hand to act in days, not months |
| Major recognition / press | High. Counterfeit listings, support scams | Pay an attorney monthly for monitoring + filings |

Most indie tools never reach the bottom row. Plan for the second-to-bottom row at launch.

---

## Part 2 — How local-first changes the defense calculus

AnnotatePro is intentionally local-first. All annotations live in IndexedDB on the user's machine. There is no cloud sync, no server-side data, no telemetry. Privacy-first is not a feature gap — it is **the deliberate brand position.**

This makes the strongest anti-cloning defense ("server-bound paid features") harder to apply, because adding cloud features compromises the brand promise.

### Two paths

#### Path A — Stay purely local. Defend with brand and trademark only.

License verification is the only server touch. Everything else runs entirely on-device.

**What this costs defensively:** a motivated cloner can rip out the JWT check and ship "AnnotatePro Free" on AMO. There is no technical defense.

**What works in your favor:**
- This is the same model **Obsidian** uses. Core is local, Sync is a separate add-on. Clones of the free core are theoretically possible but Obsidian survives via trademark + brand + product velocity.
- Same story for KeePassXC, Tridactyl, Vimium, Standard Notes core.
- For the model to work, the privacy-first positioning needs to be **loud and central** in marketing. Not a bullet point — the headline.

#### Path B — Add end-to-end encrypted sync as an opt-in.

The Standard Notes / Bitwarden reconciliation: there *is* a server, but the server **cannot read your data**. Annotations encrypted client-side before upload, decrypted only on the user's devices, user's passphrase derives the key.

**How it preserves privacy-first:**
- Server stores opaque ciphertext blobs. You as the developer literally cannot read user annotations.
- Privacy promise upgrades from "we don't have a server" to "we have a server that can't see your data" — arguably stronger because it's cryptographically provable.
- Sync is opt-in. Users who want pure local turn it off.

**How it solves clone defense:**
- Clone can fork the JS bundle. Can't replicate the sync backend. Paying sync users notice and don't migrate to clones.

**Costs:**
- ~2–3 weeks for v1 (passphrase → Argon2 → AES-GCM → Supabase). Crypto isn't the hard part; UX is (key recovery, multi-device pairing, forgotten passphrase flow — which by design you cannot rescue).
- Supabase storage costs (small).
- One more thing users hate when it breaks.

### Recommended sequence

| Phase | When | Path |
|---|---|---|
| Launch | Now | Path A. JWT licensing, $25/yr, no sync. Trademark filed |
| Server-bound paid v2 | After ~2000 paying users | Path B. Opt-in E2EE sync. Same $25/yr; sync is a value-add not a separate SKU |
| Real-time sync / collaboration | After ~5000 users | Bidirectional sync with conflict resolution. May warrant a price bump for new users (existing grandfather) |

You can launch on Path A without compromise. Path B is a future option that doesn't betray the brand if executed properly (E2EE, opt-in, transparent docs).

**Do not** ship cloud sync that reads user data, even with a "we promise not to look" disclaimer. That is worse than no sync at all for the privacy-first audience.

---

## Part 3 — Practical security checklist

Things to do (or actively avoid) at each stage:

### At launch
- [ ] Trademark registered (or filing in progress) for "AnnotatePro"
- [ ] JWT-based license verification implemented (Ed25519, 30-day expiry, silent refresh)
- [ ] Extension contains only the **public** key. No private keys, no admin tokens, no API secrets
- [ ] Privacy-first positioning is the lead marketing line, not a bullet
- [ ] AMO listing discloses the trial mechanic and pricing
- [ ] Minified but not aggressively obfuscated (debuggability > tamper resistance)

### First 12 months
- [ ] Google Alert for "AnnotatePro" + common typo variants
- [ ] Watch AMO and Chrome Web Store catalogs periodically
- [ ] Establish a contact at Mozilla AMO support — useful when you need to escalate a complaint
- [ ] Document the trademark registration so DMCA filings are quick if needed

### Avoid
- Anti-debugging code, runtime integrity checks against your own files
- Bundling shared secrets in the extension
- Promising specific behaviors in marketing that you can't deliver ("100% uncloneable," "uncrackable encryption" etc.)
- Reactive feature pivots when clones appear — ship your own roadmap

---

## Part 4 — Competitive landscape

The privacy-first business model examples (Obsidian, Standard Notes, Logseq, Cryptee) are useful for pricing and architecture *patterns*. None of them are **web annotation tools**, so they don't compete for the same users.

### Direct competitors — web annotation tools

| Tool | Storage | Pricing | OSS | Notes |
|---|---|---|---|---|
| **Hypothesis** (h.io) | Cloud | Free for individuals; $5/mo groups; Edu tiers | Yes | The de facto standard in academic web annotation. Open W3C standard for the data model. Annotations stored on their servers (publicly or privately) |
| **Memex** (WorldBrain) | **Local-first**, optional sync | Has pivoted: paid → community-supported → web3-flavored | Yes | The closest direct competitor in concept. Multiple business-model pivots and scope creep have left it barely shipping |
| **Liner** | Cloud | $13/mo Pro, freemium with monthly limits | No | VC-funded. Pivoted from "highlighter" to AI workspace. Heavy on AI summarization and shareable highlights |
| **Diigo** | Cloud | Premium $40/yr, Pro $59/yr | No | Long-running (~2006). Dated UI, declining mindshare, still has paying loyal users |
| **Readwise** + **Reader** | Cloud | $9.99/mo or $99/yr | No | More aggregator than annotator. Pulls from Kindle/Pocket/Instapaper. Reader does PDF/web. Strong community, opinionated UX |
| **Glasp** | Cloud | Free; freemium model emerging | No | Social highlighter. "What did this person highlight?" graph. Growing |
| **Weava** | Cloud | Freemium; Premium ~$5/mo | No | Academic research, citation tooling baked in |
| **AnnotatePro** | **Local** | $25/yr | No | Local-first, privacy-first, Firefox-targeted |

### Adjacent / business-model reference points (not direct competitors)

These tools are not in the same product category but are useful templates for how local-first products charge and defend themselves.

| Tool | Category | Privacy model | Pricing | OSS |
|---|---|---|---|---|
| **Obsidian** | Knowledge base / markdown | Local files; opt-in E2EE Sync | Free personal; $50/yr commercial; Sync $96/yr; Publish $192/yr | No |
| **Standard Notes** | Notes | E2EE always; server stores ciphertext only | Free basic; Pro $90/yr (sync + editors + everything) | Yes |
| **Logseq** | Outliner / KB | Local files; E2EE sync optional | Free core; Pro $60/yr (sync only) | Yes |
| **Cryptee** | Encrypted docs/photos | E2EE always | $36/yr (10GB) → $120/yr (unlimited) | Partially |

### Feature-rich comparison

Split into four tables by category. **Y** = yes, **—** = no, **~** = partial / limited / planned. All data current as of the snapshot date at the top of this doc.

#### Core annotation features

| Feature | Hypothesis | Memex | Liner | Diigo | Readwise/Reader | Glasp | Weava | AnnotatePro |
|---|---|---|---|---|---|---|---|---|
| Text highlighting | Y (1 color) | Y (colors) | Y (colors) | Y (colors) | Y | Y (colors) | Y (colors) | **Y (custom colors)** |
| Sticky / inline notes | Y | Y | Y | Y | Y | Y | Y | Y |
| Tags | Y | Y | Y | Y | Y | Y | Y (folders) | ~ planned |
| Page-level notes | — | Y | Y | Y | Y | Y | Y | Y |
| Persistence across reloads | Y | Y | Y | Y | Y | Y | Y | Y |
| **Interactive checkboxes** | — | — | — | — | — | — | — | **Y (unique)** |
| **Screenshot annotation** | — | Y | ~ | Y | — | — | — | **Y (full editor: pen, shapes, text, undo)** |
| PDF annotation | Y | Y | Y | Y | Y (Reader) | Y | Y | Y |
| Find on page | — | ~ | Y | ~ | Y | ~ | ~ | **Y (native, undetectable)** |
| Sidebar viewer | Y | Y | Y | Y | Y | Y | Y | Y |
| **QR code generation** | — | — | — | — | — | — | — | **Y** |
| **Clipboard history** | — | — | — | — | — | — | — | **Y** |

#### Storage, sync, sharing

| Feature | Hypothesis | Memex | Liner | Diigo | Readwise/Reader | Glasp | Weava | AnnotatePro |
|---|---|---|---|---|---|---|---|---|
| Local-only mode | — | Y | — | — | — | — | — | **Y (only mode)** |
| Cloud sync | Y | Optional | Y | Y | Y | Y | Y | — |
| Cross-device | Y | Y | Y | Y | Y | Y | Y | — |
| Public sharing | Y | Y | Y | Y | ~ | **Y (default)** | Y | — |
| Social / discovery | Y (public streams) | Spaces | Y | Y (legacy) | — | **Y (core feature)** | ~ | — |
| Groups / collaboration | **Y (Edu focus)** | Y | — | Y | — | Communities | Y | ~ planned |
| Export (Markdown) | Y (via API) | Y | Y | Y | **Y (many formats)** | Y | Y | Y |
| Export to Notion/Obsidian/Roam | ~ | ~ | ~ | ~ | **Y (deep integrations)** | Y | ~ | — |
| Import | ~ | Y | ~ | Y | **Y** | ~ | ~ | Y |

#### Privacy, account, platform

| Feature | Hypothesis | Memex | Liner | Diigo | Readwise/Reader | Glasp | Weava | AnnotatePro |
|---|---|---|---|---|---|---|---|---|
| E2E encryption | — | Y (sync) | — | — | — | — | — | N/A (no cloud) |
| **Truly local data** | — | Y | — | — | — | — | — | **Y (only one)** |
| Works without account | — | Y | — | — | — | — | — | **Y** |
| Account required for sync | Y | Optional | Y | Y | Y | Y | Y | — |
| Open source | **Y** | Y | — | — | — | — | — | — |
| Firefox support | Y | Y | Y | Y | Y | Y | Y | **Y (primary)** |
| Chrome support | Y | Y | Y | Y | Y | Y | Y | — (planned, no Find) |
| Safari support | Bookmarklet | — | Y | Y | Y | Y | — | — |
| Edge support | Y | ~ | Y | Y | Y | ~ | ~ | — |
| Mobile (iOS/Android) | — | — | **Y** | ~ | **Y** | ~ | ~ | — |
| Public API | **Y** | Y | ~ | Y | Y | ~ | — | — |

#### AI, citation, advanced

| Feature | Hypothesis | Memex | Liner | Diigo | Readwise/Reader | Glasp | Weava | AnnotatePro |
|---|---|---|---|---|---|---|---|---|
| AI summarization | — | (dropped) | **Y (core)** | — | **Y (Ghostreader)** | Y (YouTube + AI) | Y | — |
| AI chat with highlights | — | — | **Y** | — | Y | ~ | ~ | — |
| Spaced repetition | — | — | — | — | **Y (core)** | — | — | — |
| Citation export (BibTeX, RIS) | Y | — | ~ | Y | ~ | — | **Y (core)** | — |
| Web Annotations W3C standard | **Y (defines it)** | ~ | — | — | — | — | — | — |
| YouTube transcript annotation | — | — | Y | — | — | **Y** | — | — |
| Email/RSS/article-mode reader | — | ~ | — | — | **Y (Reader app)** | — | — | — |

---

## Part 5 — What this means for AnnotatePro

### Where you actually sit

**Every other paid web annotation tool is cloud-first.** This is not a coincidence — sync is the obvious feature for "I annotated on my laptop, want it on my phone," and storing user data unlocks AI features, social graphs, analytics. The whole category has marched toward cloud-by-default.

AnnotatePro is doing the opposite. **That is a real, deliberate niche.**

### Three things that differentiate AnnotatePro

1. **You are the only local-first paid option in active development.** Memex is barely shipping. Every other paid tool is cloud. This is a category position, not a feature.
2. **Your pricing is the indie sweet spot.** $25/yr is half of Diigo Premium, a fifth of Liner Pro, slightly cheaper than Readwise. You are the cheapest *paid privacy-first* option in the category.
3. **Firefox-targeted in a Chrome-default world.** Privacy-conscious users are disproportionately on Firefox. The browser choice doubles as audience filtering.

### Lessons from each competitor

- **Hypothesis** — gravitational center. Free, open, academic. You will not out-compete them on price or breadth. Your wedge is "I'd like to annotate the web but I don't want my annotations on someone else's server." Steal their data model — adopt the W3C Web Annotations format for export, so users have portability and you don't lock them in. That's a real trust signal.
- **Memex** — the cautionary tale. Tried to do too much (highlights + bookmarks + sharing + AI + crypto), pivoted business model repeatedly, lost user trust. **Stay narrow. Commit to one business model. Don't pivot.**
- **Liner** — the anti-position foil. Useful as marketing contrast: *"AnnotatePro is the Liner alternative for people who don't want their highlights training an LLM."*
- **Obsidian** (adjacent) — pricing structure worth borrowing later. Free core + paid sync as a separate SKU is a clean model that eliminates most cloning incentive structurally. Not where you start, but possibly where you end up.

### Recommended marketing position

> **AnnotatePro — annotate the web, locally. Your highlights live on your device, not on our servers. No accounts. No tracking. No cloud. $25/year.**

This is a position none of the cloud-first competitors can copy without rebuilding their stack. It earns trust now and earns the right to ship opt-in E2EE sync later without users feeling betrayed.

### Feature analysis — what's unique, what's missing

A read of the feature tables above, focused on AnnotatePro specifically.

#### Genuinely unique features

These exist in AnnotatePro and in *no other* tool in the category:

- **Interactive checkboxes** on annotations. Useful for "todo on this page," "I've read this section," "I've verified this fact" workflows. No one else has them.
- **Screenshot annotation with a real mini editor** — pen, line, rectangle, circle, text, eraser, undo/redo. Diigo and Memex have basic screenshot capture; you have the full editor.
- **QR code generation** from a selection. Niche but unusual.
- **Clipboard history tied to pages.** Useful, sticky, and a real differentiator for power users.
- **Native browser find with zero detection footprint** (Firefox-only, via `browser.find` API). No other tool — paid or free — does this.
- **Local-only by default**. Memex is the only other tool that even offered this, and Memex is barely shipping.

#### Clear gaps vs. the field

Things every competitor has that AnnotatePro doesn't:

| Gap | Severity | Compatible with privacy-first? |
|---|---|---|
| Tags | High — every tool has this | Yes, ship soon |
| Export to Notion / Obsidian / Roam (Markdown integrations) | High — Readwise's killer feature | Yes, export-only is fine |
| Citation export (BibTeX, RIS) | Medium — opens academic segment | Yes, cheap to add |
| Sync across devices | Medium — major friction for cross-device users | Only via E2EE (Path B); see Part 2 |
| Mobile apps | Medium — competitors with mobile have higher engagement | Hard for a browser-extension product; mobile = browser plugins on Android Firefox |
| AI features (summarization, chat) | Strategic question, not a "gap" | No — opting out is the position |
| Public sharing / social | N/A — incompatible with local-first | No, intentional |
| Groups / collaboration | Medium for academic; low for indie | Possible later with E2EE multi-user, complex |

#### Three near-term priorities the table suggests

1. **Ship tags.** It's the most visible gap and not contentious from a privacy standpoint. Already noted as "planned"; should be near-term.
2. **Add export to Notion / Obsidian / Roam-compatible Markdown formats.** Privacy-first users are exactly the Obsidian audience. The integration is one-way (export-only), so it costs nothing privacy-wise and earns goodwill.
3. **Add BibTeX / RIS citation export.** Cheap to build, opens an entire research-focused user segment. Hypothesis has groups but doesn't have great citation export — there's a wedge.

These three keep AnnotatePro feature-competitive without compromising the local-first position. They're also the kind of items that make reviews not complain about missing table-stakes features.

### Clone risk in this specific market

Lower than my initial framing suggested. Reasons:

- **The audience is small and self-selecting.** Privacy-conscious annotators are not the kind of users who install random "AnnotatePro Free" clones from sketchy AMO listings. They specifically chose the trusted local tool.
- **The category is sleepy.** Web annotation isn't an aggressive market — no one is scaling clones across categories the way they do for ad blockers, password managers, or VPNs.
- **Memex going dormant is your tailwind.** The most natural cloner of a local-first annotation tool just stopped shipping.

So: ship the current plan ($25/yr, JWT licensing, no sync, no server-side data). Marketing and trademark do more for you than any technical defense at this scale.

---

## Open questions worth revisiting later

These don't need answers now but should be re-evaluated annually:

- **When does Path B (E2EE sync) make business sense?** Likely when ARR plateaus and existing users start asking for cross-device support. Don't preempt this.
- **Should the doc model become open?** Adopting the W3C Web Annotations standard for the export format gives users a real portability story. Worth doing soon.
- **Should the source eventually be opened?** Standard Notes, Logseq, Memex are all OSS. Obsidian isn't. There's no consensus on which works better for paid privacy tools. Defer.
- **At what user count does trademark monitoring become worth paying for?** Probably ~5k paying users. Until then, manual Google Alerts are sufficient.
