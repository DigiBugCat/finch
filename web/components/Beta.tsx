import Link from 'next/link';

const TIERS = [
  {
    name: 'Hobby',
    price: 'Free',
    note: 'for you & small groups',
    blurb: 'Free for you and a few friends. No artificial limits.',
    highlight: true,
    cta: { label: 'Get started →', href: '/sign-up', style: 'btn-amber' },
    features: [
      'Unlimited services & boxes',
      'Up to 3 users',
      'Hosted MCP endpoints + hub domain',
      'OAuth at the door',
      'Live traffic view',
    ],
  },
  {
    name: 'Team',
    price: 'TBD',
    note: 'flat monthly',
    blurb: 'Control which users and agents can reach which services.',
    cta: { label: 'Get started →', href: '/sign-up', style: 'btn-ghost' },
    features: [
      'Everything in Hobby',
      'Unlimited users, roles & admin',
      'ACLs: per-user and per-agent access by tag, group, or key',
      'Custom domains',
      'Audit logs',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    note: 'talk to us',
    blurb: 'Need SSO, an SLA, or something bespoke? Let’s talk.',
    cta: { label: 'Contact us', href: 'mailto:hello@aviary.run', style: 'btn-ghost' },
    features: [
      'Everything in Team',
      'SSO / SAML',
      'SLA & priority support',
      'Dedicated onboarding',
    ],
  },
];

export default function Beta() {
  return (
    <section className="sec sec-bg2" id="pricing">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">PRICING</span>
          <h2>Plans</h2>
        </div>

        <div className="tiers">
          {TIERS.map((t) => (
            <div key={t.name} className={`tier${t.highlight ? ' tier-hi' : ''}`}>
              {t.highlight && <span className="tier-badge">FREE IN BETA</span>}
              <h3 className="tier-name">{t.name}</h3>
              <div className="tier-price">
                <span className="tier-amt">{t.price}</span>
                <span className="tier-note">{t.note}</span>
              </div>
              <p className="tier-blurb">{t.blurb}</p>
              <ul className="tier-feats">
                {t.features.map((f) => (
                  <li key={f}><span className="tier-check">✓</span>{f}</li>
                ))}
              </ul>
              <Link className={`btn btn-md ${t.cta.style} tier-cta`} href={t.cta.href}>
                {t.cta.label}
              </Link>
            </div>
          ))}
        </div>

        <p className="tier-foot">
          Everything above is free while we&apos;re in beta. Questions? Email{' '}
          <a href="mailto:hello@aviary.run">hello@aviary.run</a>.
        </p>
      </div>
    </section>
  );
}
