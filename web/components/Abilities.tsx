export default function Abilities() {
  return (
    <section className="sec" id="abilities">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">ABILITIES</span>
          <h2>What can you put behind it?</h2>
          <p>Bring any MCP server, ready-made or your own. Finch wraps it in auth and a URL. Each one becomes a tool your agent can call.</p>
        </div>
        <div className="ability-grid">
          <div className="ability">
            <div className="ability-ic">🖨️</div>
            <h4>Print things</h4>
            <p className="quote">"Hey Claude, print this shipping label."</p>
            <p className="who">→ the thermal printer on your desk</p>
          </div>
          <div className="ability">
            <div className="ability-ic">📚</div>
            <h4>Search your notes</h4>
            <p className="quote">"Find what I wrote about the cabin trip."</p>
            <p className="who">→ a vault index that never leaves the box</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🎙️</div>
            <h4>Transcribe audio</h4>
            <p className="quote">"Turn this voice memo into notes."</p>
            <p className="who">→ local Whisper, no upload</p>
          </div>
          <div className="ability">
            <div className="ability-ic">💸</div>
            <h4>Crunch finances</h4>
            <p className="quote">"How much did I spend on groceries?"</p>
            <p className="who">→ your ledgers, parsed in place</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🌐</div>
            <h4>Read the web</h4>
            <p className="quote">"Summarize this page for me."</p>
            <p className="who">→ a fetch tool on your own residential IP</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🏠</div>
            <h4>Run your home</h4>
            <p className="quote">"Kick off tonight's backup."</p>
            <p className="who">→ lights, backups, whatever the box can reach</p>
          </div>
        </div>
      </div>
    </section>
  );
}
