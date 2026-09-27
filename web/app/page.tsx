// The landing: finch as a field guide, seven plates in Indigo Wash.
// Server-rendered; only the gate dial, the agent session, the sighting log and
// the copy buttons hydrate.
import SiteNav from '@/components/fieldguide/SiteNav';
import SiteFooter from '@/components/fieldguide/SiteFooter';
import HeroPlate from '@/components/fieldguide/HeroPlate';
import BandPlate from '@/components/fieldguide/BandPlate';
import FieldRecording from '@/components/fieldguide/FieldRecording';
import GateDial from '@/components/fieldguide/GateDial';
import AgentPlate from '@/components/fieldguide/AgentPlate';
import SightingLog from '@/components/fieldguide/SightingLog';
import PricingPlate from '@/components/fieldguide/PricingPlate';
import '@/components/fieldguide/landing.css';

export default function Home() {
  return (
    <>
      <SiteNav />
      <main>
        <HeroPlate />
        <BandPlate />
        <FieldRecording />
        <GateDial />
        <AgentPlate />
        <SightingLog />
        <PricingPlate />
      </main>
      <SiteFooter />
    </>
  );
}
