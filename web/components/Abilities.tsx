export default function Abilities() {
  return (
    <section className="sec" id="abilities">
      <div className="wrap">
        <div className="sec-head">
          <span className="sec-tag">ABILITIES</span>
          <h2>What will yours do?</h2>
          <p>Pick from ready-made abilities or write your own. Each one becomes a tool your AI can reach for.</p>
        </div>
        <div className="ability-grid">
          <div className="ability">
            <div className="ability-ic">🖨️</div>
            <h4>Print things</h4>
            <p className="quote">"Hey Claude, print this shipping label."</p>
            <p className="who">→ your home printer</p>
          </div>
          <div className="ability">
            <div className="ability-ic">📚</div>
            <h4>Search your notes</h4>
            <p className="quote">"Find what I wrote about the cabin trip."</p>
            <p className="who">→ private docs, kept on your machine</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🎙️</div>
            <h4>Transcribe audio</h4>
            <p className="quote">"Turn this voice memo into notes."</p>
            <p className="who">→ your own transcription, offline</p>
          </div>
          <div className="ability">
            <div className="ability-ic">💸</div>
            <h4>Crunch finances</h4>
            <p className="quote">"How much did I spend on groceries?"</p>
            <p className="who">→ your ledgers, never leaving home</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🌐</div>
            <h4>Read the web</h4>
            <p className="quote">"Summarize this page for me."</p>
            <p className="who">→ clean, readable pages on demand</p>
          </div>
          <div className="ability">
            <div className="ability-ic">🏠</div>
            <h4>Run your home</h4>
            <p className="quote">"Kick off tonight's backup."</p>
            <p className="who">→ lights, backups, the NAS in the closet</p>
          </div>
        </div>
      </div>
    </section>
  );
}
