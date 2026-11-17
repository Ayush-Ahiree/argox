import React from "react";
import { T } from "./theme.jsx";
import { SiteNav, SiteFooter, CSS as HOME_CSS } from "./Home.jsx";

/**
 * Public marketing/legal pages: /pricing, /terms, /refunds. They share the
 * homepage's nav, footer and styles, and are prerendered to
 * dist/<page>/index.html at build time (scripts/prerender.mjs) like the
 * homepage.
 *
 * Keep PLANS in sync with what billing actually enforces once payments
 * are wired up -- until then the page says paid plans aren't live.
 */

export const CONTACT_EMAIL = "support@getargox.com";
export const LEGAL_UPDATED = "November 17, 2026";

export const PAGES = {
  pricing: {
    title: "Pricing | Argox AI Agent Firewall",
    description: "Argox pricing: every blocking rule is free. Pay for more projects, longer history, OpenTelemetry export and team features.",
  },
  terms: {
    title: "Terms of Service | Argox",
    description: "The terms that govern your use of Argox, the data firewall for AI agents.",
  },
  refunds: {
    title: "Refund Policy | Argox",
    description: "Argox subscriptions are non-refundable. Cancel any time and keep access until the end of your billing period.",
  },
};

export function pageFromPath(path) {
  const m = path.match(/^\/(pricing|terms|refunds)\/?$/);
  return m ? m[1] : null;
}

export default function SitePage({ page, onSignIn, onGetStarted }) {
  const Body = { pricing: Pricing, terms: Terms, refunds: Refunds }[page];
  return (
    <div className="ax-home">
      <style>{HOME_CSS + CSS}</style>
      <SiteNav onSignIn={onSignIn} onGetStarted={onGetStarted} />
      <main>
        <Body onGetStarted={onGetStarted} />
      </main>
      <SiteFooter onSignIn={onSignIn} />
    </div>
  );
}

// ---------------------------------------------------------------- pricing

const PLANS = [
  {
    name: "Free",
    price: "$0",
    per: "forever",
    blurb: "Full protection for one developer.",
    cta: "Get started",
    features: [
      "Every blocking rule and policy",
      "Claude Code hooks, Python SDK and tool-call API",
      "1 project",
      "7 days of event history",
      "Community support",
    ],
  },
  {
    name: "Pro",
    price: "$19",
    per: "per month",
    blurb: "For developers running agents every day.",
    cta: "Get started",
    featured: true,
    features: ["Everything in Free", "Up to 10 projects", "90 days of event history", "OpenTelemetry export", "Email support"],
  },
  {
    name: "Team",
    price: "$29",
    per: "per user / month",
    blurb: "Shared policy and visibility for a team.",
    cta: "Get started",
    features: ["Everything in Pro", "Unlimited projects", "Team members and shared projects", "1 year of event history", "Priority support"],
  },
  {
    name: "Enterprise",
    price: "Custom",
    per: "",
    blurb: "Self-hosting, custom retention and security review.",
    cta: "Contact us",
    href: `mailto:${CONTACT_EMAIL}?subject=Argox%20Enterprise`,
    features: ["Everything in Team", "Self-hosted deployment", "Custom data retention", "SSO", "Security questionnaire and DPA"],
  },
];

const PRICING_FAQ = [
  {
    q: "Is any protection locked behind a paid plan?",
    a: "No. Every blocking rule, taint check and policy toggle is on the Free plan. Paid plans add projects, history, export and team features.",
  },
  {
    q: "Can I cancel any time?",
    a: "Yes. Cancel from your account and you keep paid features until the end of the billing period you already paid for. You won't be charged again.",
  },
  {
    q: "Do you offer refunds?",
    a: "No. Payments are non-refundable, so start on the Free plan to try Argox first. See the refund policy for details.",
  },
  {
    q: "What happens to my data if I downgrade?",
    a: "Your policy and projects stay. Event history older than your new plan's limit is deleted.",
  },
];

function Pricing({ onGetStarted }) {
  return (
    <>
      <section className="ax-hero ax-page-hero">
        <div className="ax-wrap">
          <div className="ax-label">Pricing</div>
          <h1 className="ax-h1 ax-page-h1">Every block is free. Pay for scale.</h1>
          <p className="ax-lede">
            The firewall itself is never paywalled. Upgrade when you need more projects, longer history or a team.
          </p>
          <div className="ax-early">Paid plans aren't live yet. Every feature is free during early access.</div>
        </div>
      </section>
      <section className="ax-section ax-pricing-section">
        <div className="ax-wrap">
          <div className="ax-plans">
            {PLANS.map((p) => (
              <div key={p.name} className={`ax-plan${p.featured ? " featured" : ""}`}>
                {p.featured && <div className="ax-plan-badge">Most popular</div>}
                <div className="ax-plan-name">{p.name}</div>
                <div className="ax-plan-price">
                  <span>{p.price}</span>
                  {p.per && <small>{p.per}</small>}
                </div>
                <p className="ax-plan-blurb">{p.blurb}</p>
                {p.href ? (
                  <a className="ax-btn ax-btn-outline ax-plan-cta" href={p.href}>{p.cta}</a>
                ) : (
                  <button className={`ax-btn ax-plan-cta${p.featured ? "" : " ax-btn-outline"}`} onClick={onGetStarted}>{p.cta}</button>
                )}
                <ul className="ax-plan-list">
                  {p.features.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
          <p className="ax-plan-fine">
            Prices in USD, excluding applicable taxes. Payments are non-refundable; see the <a href="/refunds">refund policy</a>.
          </p>

          <div className="ax-faq-wrap ax-pricing-faq">
            <h2 className="ax-h2">Billing questions</h2>
            <div className="ax-faq">
              {PRICING_FAQ.map((f) => (
                <details key={f.q} className="ax-faq-item">
                  <summary><h3>{f.q}</h3></summary>
                  <p>{f.a}</p>
                </details>
              ))}
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

// ------------------------------------------------------------------ legal

function LegalDoc({ title, children }) {
  return (
    <section className="ax-section ax-legal-section">
      <div className="ax-wrap ax-legal">
        <h1 className="ax-h2 ax-legal-h1">{title}</h1>
        <p className="ax-legal-updated">Last updated: {LEGAL_UPDATED}</p>
        {children}
      </div>
    </section>
  );
}

const Mail = () => <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;

function Terms() {
  return (
    <LegalDoc title="Terms of Service">
      <p>
        These Terms of Service ("Terms") govern your use of Argox, including the website at getargox.com, the hosted
        dashboard and API, the Argox command-line tool, and the Python SDK (together, the "Service"). By creating an
        account or using the Service you agree to these Terms. If you use the Service on behalf of an organization,
        you agree on its behalf and confirm you have authority to do so.
      </p>

      <h2>1. The Service</h2>
      <p>
        Argox inspects tool calls made by AI agents and can allow, block or ask for confirmation of those calls based
        on the policy you configure. We may change, add or remove features over time.
      </p>

      <h2>2. No guarantee of security</h2>
      <p>
        Argox is one layer of defence. It reduces the risk of AI agents leaking data or taking harmful actions, but it
        does not detect or block every attack, leak or destructive action, and it can be bypassed or misconfigured.
        Depending on your setup, tool calls may be allowed if the Service is unreachable or times out. You remain
        responsible for your systems, your agents, your credentials and your data, and for reviewing what your agents
        do. Do not rely on Argox as your only security control.
      </p>

      <h2>3. Your account</h2>
      <p>
        You must provide accurate information and keep your login credentials and API keys secure. You are
        responsible for all activity under your account and its API keys. Tell us promptly at <Mail /> if you believe
        your account or a key has been compromised. You must be at least 18 years old to use the Service.
      </p>

      <h2>4. Your data</h2>
      <p>
        To work, the Service receives metadata about your agents' tool calls, such as tool names, file paths,
        commands, destinations and classification results. You keep all rights to your data. You grant us a limited
        licence to host, process and display it only to provide, secure and improve the Service. We try to redact
        secret values before storing events, but you should avoid sending us data you are not allowed to share. We
        delete event history according to your plan's retention period, and you can ask us to delete your account
        and its data at any time.
      </p>

      <h2>5. Acceptable use</h2>
      <p>You agree not to:</p>
      <ul>
        <li>use the Service to break the law or to attack, probe or disrupt systems you are not authorized to test;</li>
        <li>try to access other customers' data or bypass the Service's authentication, limits or billing;</li>
        <li>reverse engineer the Service except where the law expressly allows it;</li>
        <li>resell or provide the Service to third parties without our written permission;</li>
        <li>overload the Service or use it in a way that harms other users.</li>
      </ul>

      <h2>6. Plans, payment and renewal</h2>
      <p>
        Some features require a paid plan. Paid plans are billed in advance on a recurring monthly or yearly basis and
        renew automatically until cancelled. Payments are handled by our payment provider, which may act as the
        merchant of record and whose terms also apply to your purchase. Prices exclude taxes unless stated otherwise.
        We may change prices for future billing periods and will give you at least 30 days' notice by email. If a
        payment fails we may downgrade or suspend your paid features.
      </p>

      <h2>7. Cancellation and refunds</h2>
      <p>
        You can cancel at any time. Cancellation takes effect at the end of the current billing period, and you keep
        paid features until then. All payments are non-refundable, as described in our{" "}
        <a href="/refunds">Refund Policy</a>.
      </p>

      <h2>8. Suspension and termination</h2>
      <p>
        We may suspend or terminate your access if you breach these Terms, fail to pay, or if your use creates a
        security or legal risk for us or other users. Where reasonable we will tell you first. You may stop using the
        Service and delete your account at any time. Sections 2, 4, 9, 10, 11 and 13 survive termination.
      </p>

      <h2>9. Intellectual property</h2>
      <p>
        The Service, including its software, design and content, belongs to us and our licensors. These Terms give
        you a limited, non-exclusive, non-transferable right to use it while your account is active. If you send us
        feedback, we may use it without any obligation to you.
      </p>

      <h2>10. Disclaimer of warranties</h2>
      <p>
        The Service is provided "as is" and "as available", without warranties of any kind, express or implied,
        including warranties of merchantability, fitness for a particular purpose, non-infringement, and that the
        Service will be uninterrupted, error-free or will detect every threat.
      </p>

      <h2>11. Limitation of liability</h2>
      <p>
        To the maximum extent permitted by law, we are not liable for any indirect, incidental, special,
        consequential or punitive damages, or for any loss of data, profits, revenue or goodwill, including losses
        caused by actions an AI agent took or data it leaked, whether or not the Service flagged or blocked them. Our
        total liability for any claim relating to the Service is limited to the amount you paid us in the 12 months
        before the claim. If you have not paid us anything, for example on the Free plan, we have no liability to you
        and the Service is provided free of charge entirely at your own risk.
      </p>

      <h2>12. Changes to these Terms</h2>
      <p>
        We may update these Terms. If a change is material we will notify you by email or in the dashboard at least
        14 days before it takes effect. Continuing to use the Service after that means you accept the new Terms.
      </p>

      <h2>13. Governing law</h2>
      <p>
        These Terms are governed by the laws of India. Any dispute will be resolved in the courts of India, unless
        the law of your country of residence gives you the right to bring a claim locally.
      </p>

      <h2>14. Contact</h2>
      <p>
        Questions about these Terms: <Mail />.
      </p>
    </LegalDoc>
  );
}

function Refunds() {
  return (
    <LegalDoc title="Refund Policy">
      <p className="ax-legal-callout">
        <strong>All payments are final and non-refundable.</strong> Try Argox on the Free plan before you upgrade:
        every blocking rule is available there.
      </p>

      <h2>No refunds</h2>
      <p>
        We do not offer refunds or credits for subscription fees, including for partial billing periods, unused
        time, downgrades, unused seats or projects, or months in which you did not use the Service. This applies to
        monthly and yearly plans.
      </p>

      <h2>Cancelling</h2>
      <p>
        You can cancel any time from your account's billing settings. Your plan stays active until the end of the
        period you have already paid for and will not renew after that. We don't charge cancellation fees.
      </p>

      <h2>Exceptions</h2>
      <ul>
        <li>
          <strong>Billing errors.</strong> If you were charged twice or charged an amount that doesn't match your plan,
          contact us within 30 days and we will refund the incorrect amount.
        </li>
        <li>
          <strong>Where the law requires it.</strong> Nothing in this policy limits any refund right you have under
          the consumer protection laws that apply to you.
        </li>
      </ul>

      <h2>Price changes</h2>
      <p>
        If we raise prices we will email you at least 30 days before the new price applies, so you can cancel before
        you are charged.
      </p>

      <h2>Contact</h2>
      <p>
        Billing questions: <Mail />. See also our <a href="/terms">Terms of Service</a>.
      </p>
    </LegalDoc>
  );
}

const CSS = `
.ax-page-hero { padding: 72px 0 40px; }
.ax-page-h1 { font-size: clamp(36px, 6vw, 60px); }
.ax-early { display: inline-block; margin-top: 24px; padding: 8px 14px; border-radius: 6px; border: 1px solid ${T.border}; background: ${T.surface}; font-size: 14px; color: ${T.inkSecondary}; }
.ax-pricing-section { padding-top: 24px; }
.ax-plans { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.ax-plans > * { min-width: 0; }
.ax-plan { position: relative; display: flex; flex-direction: column; padding: 24px 22px; border-radius: 10px; border: 1px solid ${T.border}; background: ${T.surface}; }
.ax-plan.featured { border-color: ${T.accent}; box-shadow: 0 0 0 1px ${T.accent}, 0 20px 50px -24px rgba(2,88,65,0.35); }
.ax-plan-badge { position: absolute; top: -11px; left: 22px; padding: 2px 10px; border-radius: 999px; background: ${T.accent}; color: ${T.page}; font-size: 12px; font-weight: 600; }
.ax-plan-name { font-size: 15px; font-weight: 600; color: ${T.inkSecondary}; }
.ax-plan-price { display: flex; align-items: baseline; gap: 8px; margin-top: 10px; }
.ax-plan-price span { font-family: ${T.fontSerif}; font-size: 42px; font-weight: 500; letter-spacing: -0.02em; line-height: 1; }
.ax-plan-price small { font-size: 13px; color: ${T.inkMuted}; }
.ax-plan-blurb { margin-top: 12px !important; font-size: 14.5px; line-height: 1.5; color: ${T.inkSecondary}; min-height: 44px; }
.ax-home .ax-plan-cta { margin-top: 20px; width: 100%; }
.ax-home .ax-btn-outline { background: transparent; color: ${T.ink} !important; border-color: ${T.borderStrong}; }
.ax-plan-list { list-style: none; padding: 20px 0 0; margin: 20px 0 0; border-top: 1px solid ${T.border}; display: flex; flex-direction: column; gap: 10px; font-size: 14.5px; color: ${T.inkSecondary}; }
.ax-plan-list li { position: relative; padding-left: 22px; line-height: 1.45; }
.ax-plan-list li::before { content: ""; position: absolute; left: 2px; top: 5px; width: 10px; height: 5px; border-left: 2px solid ${T.accent}; border-bottom: 2px solid ${T.accent}; transform: rotate(-45deg); }
.ax-plan-fine { margin-top: 20px !important; font-size: 13px; color: ${T.inkMuted}; text-align: center; }
.ax-plan-fine a, .ax-legal a { color: ${T.accent} !important; text-decoration: underline !important; text-underline-offset: 3px; }
.ax-pricing-faq { margin: 88px auto 0; }

.ax-legal-section { padding: 64px 0 96px; }
.ax-legal { max-width: 760px; }
.ax-legal-h1 { margin: 0; }
.ax-legal-updated { margin-top: 10px !important; font-size: 14px; color: ${T.inkMuted}; }
.ax-legal h2 { font-size: 19px; font-weight: 600; margin: 40px 0 0; }
.ax-legal p, .ax-legal li { font-size: 16px; line-height: 1.7; color: ${T.inkSecondary}; }
.ax-legal p { margin-top: 12px !important; }
.ax-legal ul { margin: 12px 0 0; padding-left: 22px; }
.ax-legal li + li { margin-top: 8px; }
.ax-legal strong { color: ${T.ink}; font-weight: 600; }
.ax-legal-callout { margin-top: 28px !important; padding: 16px 18px; border-radius: 8px; border: 1px solid ${T.border}; border-left: 3px solid ${T.accent}; background: ${T.surface}; }

@media (max-width: 1000px) { .ax-plans { grid-template-columns: repeat(2, 1fr); row-gap: 24px; } }
@media (max-width: 560px) {
  .ax-plans { grid-template-columns: 1fr; }
  .ax-plan-blurb { min-height: 0; }
  .ax-page-hero { padding: 48px 0 24px; }
  .ax-legal-section { padding: 40px 0 72px; }
}
`;
