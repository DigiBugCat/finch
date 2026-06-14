import Nav from '@/components/Nav';
import Hero from '@/components/Hero';
import ClientStrip from '@/components/ClientStrip';
import ValuePillars from '@/components/ValuePillars';
import HowItWorks from '@/components/HowItWorks';
import Abilities from '@/components/Abilities';
import FlockSplit from '@/components/FlockSplit';
import Safety from '@/components/Safety';
import Beta from '@/components/Beta';
import Faq from '@/components/Faq';
import FinalCta from '@/components/FinalCta';
import Footer from '@/components/Footer';

export default function Home() {
  return (
    <>
      <Nav />
      <span id="top" />
      <Hero />
      <ClientStrip />
      <ValuePillars />
      <HowItWorks />
      <Abilities />
      <FlockSplit />
      <Safety />
      <Beta />
      <Faq />
      <FinalCta />
      <Footer />
    </>
  );
}
