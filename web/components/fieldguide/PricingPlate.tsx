// Plate VII: pricing. One finch for free, a flock for enterprise, and the
// source for anyone who would rather run it themselves.
import Link from 'next/link';
import { Bird } from './Bird';
import PlateHead from './PlateHead';
import { SITEMAP_PATHS } from '@/app/site-paths';

function PerchedFinch() {
  return (
    <svg width="120" height="70" viewBox="0 0 120 70" aria-hidden="true" focusable="false">
      <path d="M0 52 C 40 58, 80 58, 120 50" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" />
      <Bird fill="var(--indigo)" painted transform="translate(62 56) scale(1.3)" />
    </svg>
  );
}

function Flock() {
  const birds: [string, string][] = [
    ['translate(30 54)', 'var(--sage-deep)'],
    ['translate(70 56) scale(-1 1)', 'var(--indigo)'],
    ['translate(108 56)', 'var(--sage-deep)'],
    ['translate(146 55) scale(-1 1)', 'var(--indigo)'],
    ['translate(178 52)', 'var(--sage-deep)'],
  ];
  return (
    <svg width="190" height="70" viewBox="0 0 190 70" aria-hidden="true" focusable="false">
      <path d="M0 50 C 60 58, 130 58, 190 48" fill="none" style={{ stroke: 'var(--indigo)' }} strokeWidth="1.25" />
      <g filter="url(#iw-gouache)">
        {birds.map(([t, fill]) => <Bird key={t} fill={fill} transform={t} />)}
      </g>
    </svg>
  );
}

export const GITHUB_URL = 'https://github.com/DigiBugCat/finch';
export const SELF_HOST_PATH = '/docs/self-host';
// The self-hosting guide ships separately; link to it only once the sitemap
// lists it (site-basics.test ties that list to the pages that exist).
const HAS_SELF_HOST_PAGE = (SITEMAP_PATHS as readonly string[]).includes(SELF_HOST_PATH);

export default function PricingPlate() {
  return (
    <section id="pricing" className="iw-wrap fg-plate" aria-labelledby="fg-pricing-title">
      <PlateHead id="fg-pricing-title" plate="Plate VII · Pricing" title="Free. Enterprise when you need it in writing." />
      <div className="fg-tiers">
        <article className="fg-tier" aria-labelledby="fg-tier-free">
          <div className="fg-tier-top">
            <div className="fg-tier-name">
              <span className="iw-label" id="fg-tier-free">Free</span>
              <span className="fg-tier-price fg-tier-price-accent">$0</span>
            </div>
            <PerchedFinch />
          </div>
          <p>
            Everything finch does, for anyone who signs up: services, machines and keys, OAuth connectors,
            streaming, the CLI and the agent guide. Signing up takes you to your fleet page, where your
            machines and services show up once finch is installed.
          </p>
          <Link href="/sign-up" className="iw-btn iw-btn-primary fg-tier-cta">Create a free account</Link>
        </article>
        <article className="fg-tier" aria-labelledby="fg-tier-ent">
          <div className="fg-tier-top">
            <div className="fg-tier-name">
              <span className="iw-label" id="fg-tier-ent">Enterprise</span>
              <span className="fg-tier-price">A flock</span>
            </div>
            <Flock />
          </div>
          <p>
            For companies running finch across many machines that need an SLA, priority support or a security
            review. Email Aviary, the maker of finch, at <b>hello@aviary.run</b> and a person will reply.
          </p>
          <a href="mailto:hello@aviary.run" className="iw-btn iw-btn-quiet fg-tier-cta">Email us</a>
        </article>
      </div>
      <aside className="fg-oss" aria-labelledby="fg-oss-title">
        <div className="fg-oss-text">
          <span className="iw-label iw-label-indigo" id="fg-oss-title">Open source · MIT</span>
          <p>
            <b>Free and open source.</b> The CLI, the relay and this site are MIT licensed. Fork it, or run
            your own finch on your own Cloudflare account.
          </p>
        </div>
        <div className="fg-oss-links">
          <a href={GITHUB_URL} className="iw-btn iw-btn-quiet">Source on GitHub</a>
          {HAS_SELF_HOST_PAGE && <Link href={SELF_HOST_PATH} className="fg-strong-link">Host it yourself</Link>}
        </div>
      </aside>
    </section>
  );
}
