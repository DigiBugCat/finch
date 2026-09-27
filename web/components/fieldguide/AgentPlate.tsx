// Plate V: for agents. The one paragraph to paste, the same setup typed by
// hand, and the session it produces.
import AgentSession from './AgentSession';
import CopyPromptButton from './CopyPromptButton';
import PlateHead from './PlateHead';
import { AGENT_PROMPT, MANUAL_STEPS } from './prompt';

export default function AgentPlate() {
  return (
    <section id="agents" className="iw-wrap fg-plate" aria-labelledby="fg-agents-title">
      <PlateHead
        id="fg-agents-title"
        plate="Plate V · For agents"
        title="Hand your agent one paragraph"
        lede="It installs finch, publishes your server, proves it works and connects it to itself. The one step that needs you is a tap on your phone."
      />
      <div className="fg-agents">
        <div className="fg-agents-left">
          <div className="fg-prompt-card">
            <span className="iw-label">Paste this into Claude Code, Codex or Cursor</span>
            <p className="fg-prompt" data-testid="agent-prompt">{AGENT_PROMPT}</p>
            <CopyPromptButton />
          </div>
          <div className="fg-by-hand">
            <span className="fg-by-hand-h">Prefer to type it yourself?</span>
            <pre><code>{MANUAL_STEPS.join('\n')}</code></pre>
          </div>
        </div>
        <AgentSession />
      </div>
    </section>
  );
}
