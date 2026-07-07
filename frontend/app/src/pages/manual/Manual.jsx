import { useTranslation } from "react-i18next";
import logoMiniImage from "../../../assets/logomini.png";
import "./manual.css";

// ── Manual ────────────────────────────────────────────────────────────────────
// In-game manual page. Unified with the rest of the app: same dark glass /
// neon shell as Profile and Lobby, with a parchment "ancient tome" reading
// surface inside for the actual manual content. Sticky topbar (logo + back
// button) stays accessible while scrolling.

const SECTIONS = [
  {
    id:    "objective",
    num:   "I",
    title: "OBJECTIVE",
    content: (
      <>
        <p>
          Knock your opponent off the stage. Each player starts with{" "}
          <strong>3 stocks</strong>. Lose all three and the match is over.
        </p>
        <p>
          There's no health bar — instead, every hit you take raises your{" "}
          <span className="mn-term">Voltage</span>. Watch the arc around your
          portrait: it starts cool blue and creeps through yellow as you take
          damage. The higher it climbs, the farther you fly on the next hit.
          A clean hit at low voltage barely nudges you; that same hit when your
          arc is burning red can send you off the edge entirely. Fall past the
          edge and you lose a stock, with the arc resetting to blue on your next life.
        </p>
      </>
    ),
  },
  {
    id:    "arena",
    num:   "II",
    title: "THE ARENA",
    content: (
      <>
        <p>
          Every stage has one wide main platform at ground level. Most also have
          elevated perches — their exact positions vary by stage. Fall off any
          edge or get launched far enough past the boundaries and you lose a
          stock; your arc resets to blue on respawn.
        </p>

        {/* Stage variants grid — layouts from STAGE_DRAW[] in main.c */}
        <div className="mn-stage-diagram">
          <span className="mn-stage-badge">Stage Layouts</span>
          <div className="mn-stage-variants">

            {/* Stage 0 — Karnamru: ground hw 7.3, plats L(-4,1.4) R(4,1.4) C(0,2.6) */}
            <div className="mn-stage-variant">
              <div className="mn-stage-inner">
                <div className="mn-stage-bound mn-stage-bound-l" />
                <div className="mn-stage-bound mn-stage-bound-r" />
                <div className="mn-stage-bound mn-stage-bound-b" />
                <div className="mn-plat mn-plat-main" style={{ left: "3%", right: "3%" }} />
                <div className="mn-plat" style={{ left: "14%", width: "15%", bottom: "38%", height: "6px" }} />
                <div className="mn-plat" style={{ right: "14%", width: "15%", bottom: "38%", height: "6px" }} />
                <div className="mn-plat" style={{ left: "50%", transform: "translateX(-50%)", width: "15%", bottom: "60%", height: "6px" }} />
                <div className="mn-player-dot" />
                <span className="mn-slabel mn-slabel-l">◀ VOID</span>
                <span className="mn-slabel mn-slabel-r">VOID ▶</span>
                <span className="mn-slabel mn-slabel-b">▼ ABYSS</span>
              </div>
              <div className="mn-stage-name">Karnamru</div>
            </div>

            {/* Stage 1 — Surya: ground hw 7.3, plats L(-3,1.1) R(3,1.1) C(0,2.2) — más compacto */}
            <div className="mn-stage-variant">
              <div className="mn-stage-inner">
                <div className="mn-stage-bound mn-stage-bound-l" />
                <div className="mn-stage-bound mn-stage-bound-r" />
                <div className="mn-stage-bound mn-stage-bound-b" />
                <div className="mn-plat mn-plat-main" style={{ left: "3%", right: "3%" }} />
                <div className="mn-plat" style={{ left: "22%", width: "14%", bottom: "32%", height: "6px" }} />
                <div className="mn-plat" style={{ right: "22%", width: "14%", bottom: "32%", height: "6px" }} />
                <div className="mn-plat" style={{ left: "50%", transform: "translateX(-50%)", width: "14%", bottom: "52%", height: "6px" }} />
                <div className="mn-player-dot" style={{ left: "60%" }} />
                <span className="mn-slabel mn-slabel-l">◀ VOID</span>
                <span className="mn-slabel mn-slabel-r">VOID ▶</span>
                <span className="mn-slabel mn-slabel-b">▼ ABYSS</span>
              </div>
              <div className="mn-stage-name">Surya</div>
            </div>

            {/* Stage 2 — Vayusvara: ground hw 3.0 (estrecho), plats L(-3.5,3.2) R(3.5,3.2) C(0,1.9) */}
            <div className="mn-stage-variant">
              <div className="mn-stage-inner">
                <div className="mn-stage-bound mn-stage-bound-l" />
                <div className="mn-stage-bound mn-stage-bound-r" />
                <div className="mn-stage-bound mn-stage-bound-b" />
                {/* suelo estrecho: hw=3.0 sobre un mundo de -8..8 → ~37% del ancho */}
                <div className="mn-plat mn-plat-main" style={{ left: "31%", right: "31%" }} />
                {/* plats laterales más altas, centro más bajo */}
                <div className="mn-plat" style={{ left: "10%", width: "16%", bottom: "72%", height: "6px" }} />
                <div className="mn-plat" style={{ right: "10%", width: "16%", bottom: "72%", height: "6px" }} />
                <div className="mn-plat" style={{ left: "50%", transform: "translateX(-50%)", width: "14%", bottom: "45%", height: "6px" }} />
                <div className="mn-player-dot" style={{ left: "50%" }} />
                <span className="mn-slabel mn-slabel-l">◀ VOID</span>
                <span className="mn-slabel mn-slabel-r">VOID ▶</span>
                <span className="mn-slabel mn-slabel-b">▼ ABYSS</span>
              </div>
              <div className="mn-stage-name">Vayusvara</div>
            </div>

            {/* Stage 3 — Daat: ground hw 7.3, 0 plataformas flotantes */}
            <div className="mn-stage-variant">
              <div className="mn-stage-inner">
                <div className="mn-stage-bound mn-stage-bound-l" />
                <div className="mn-stage-bound mn-stage-bound-r" />
                <div className="mn-stage-bound mn-stage-bound-b" />
                <div className="mn-plat mn-plat-main" style={{ left: "3%", right: "3%" }} />
                <div className="mn-player-dot" style={{ left: "55%" }} />
                <span className="mn-slabel mn-slabel-l">◀ VOID</span>
                <span className="mn-slabel mn-slabel-r">VOID ▶</span>
                <span className="mn-slabel mn-slabel-b">▼ ABYSS</span>
              </div>
              <div className="mn-stage-name">Daat</div>
            </div>

          </div>
        </div>

        <p>
          The red dashed lines mark the{" "}
          <span className="mn-term">Void Boundaries</span>. Cross any of them —
          sides or bottom — and you forfeit a stock. On stages with floating
          platforms, you can pass through them from below by jumping up into
          them.
        </p>
      </>
    ),
  },
  {
    id:    "controls",
    num:   "III",
    title: "CONTROLS",
    content: (
      <div className="mn-controls">
        <div className="mn-ctrl-group">
          <div className="mn-ctrl-label">MOVE</div>
          <div className="mn-ctrl-keys">
            <kbd>A</kbd> <kbd>D</kbd>
            <span className="mn-ctrl-or">or</span>
            <kbd>←</kbd> <kbd>→</kbd>
          </div>
        </div>
        <div className="mn-ctrl-group">
          <div className="mn-ctrl-label">JUMP</div>
          <div className="mn-ctrl-keys">
            <kbd>W</kbd>
            <span className="mn-ctrl-or">or</span>
            <kbd>↑</kbd>
          </div>
        </div>
        <div className="mn-ctrl-group">
          <div className="mn-ctrl-label">ATTACK / BLOCK</div>
          <div className="mn-ctrl-keys">
            <kbd>SPACE</kbd>
          </div>
        </div>
        <div className="mn-ctrl-group">
          <div className="mn-ctrl-label">DASH</div>
          <div className="mn-ctrl-keys">
            <kbd>← ←</kbd>
            <span className="mn-ctrl-or">or</span>
            <kbd>→ →</kbd>
            <span className="mn-ctrl-note">(double-tap)</span>
          </div>
        </div>
        <div className="mn-ctrl-group">
          <div className="mn-ctrl-label">CROUCH</div>
          <div className="mn-ctrl-keys">
            <kbd>S</kbd>
            <span className="mn-ctrl-or">or</span>
            <kbd>↓</kbd>
          </div>
        </div>
      </div>
    ),
  },
  {
    id:    "attacks",
    num:   "IV",
    title: "ATTACKS",
    content: (
      <>
        <p>
          A single tap of <kbd>SPACE</kbd> swings — chain up to three hits by
          tapping again right after each one connects. Wait too long between
          hits and the chain breaks, dropping you back to the first swing.
        </p>
        <div className="mn-move-list">
          <div className="mn-move">
            <div className="mn-move-input"><kbd>SPACE</kbd></div>
            <div className="mn-move-info">
              <strong>Normal Attack</strong>
              <span>Tap to swing. Chains into up to 3 hits if you keep tapping right after each landed hit.</span>
            </div>
          </div>
          <div className="mn-move">
            <div className="mn-move-input"><kbd>SPACE</kbd> in air</div>
            <div className="mn-move-info">
              <strong>Aerial Attack</strong>
              <span>Hit while airborne. Breaks your combo chain. Good for intercepting jumps.</span>
            </div>
          </div>
          <div className="mn-move">
            <div className="mn-move-input"><kbd>↓</kbd> + <kbd>SPACE</kbd></div>
            <div className="mn-move-info">
              <strong>Crouch Attack</strong>
              <span>Low strike that hits crouching opponents. Breaks combo chain.</span>
            </div>
          </div>
          <div className="mn-move mn-move-highlight">
            <div className="mn-move-input"><kbd>→→</kbd> then <kbd>SPACE</kbd></div>
            <div className="mn-move-info">
              <strong>Dash Attack ★</strong>
              <span>Most powerful move. Swing the instant your dash ends. Wider range, 1.65× knockback. One use per dash.</span>
            </div>
          </div>
        </div>
        <div className="mn-callout">
          <span className="mn-callout-label">COMBO</span>
          <span className="mn-combo-chain">
            <span>Hit 1</span>
            <span className="mn-arrow">▶</span>
            <span>Hit 2</span>
            <span className="mn-arrow">▶</span>
            <span>Hit 3</span>
          </span>
          <span className="mn-callout-note">tap again quickly to keep the chain going</span>
        </div>
        <p>
          Each combo hit also raises your own voltage multiplier on the next
          attack you land — and the opponent's voltage at the same time, since
          knockback scales off both fighters' totals. A finished 3-hit chain at
          high voltage hits far harder than the same three swings thrown in
          isolation.
        </p>
      </>
    ),
  },
  {
    id:    "dash",
    num:   "V",
    title: "DASH",
    content: (
      <>
        <p>
          Double-tap a direction to burst forward in a quick speed boost. The dash{" "}
          <strong>cancels all knockback</strong> the moment it fires — your fighter's
          drift stops dead and resets, which makes the dash your main escape tool
          when you're being juggled at high voltage.
        </p>
        <ul className="mn-list">
          <li>Needs a brief moment to recharge between dashes.</li>
          <li>You can't block right as a dash ends — there's a short beat before your guard's back up.</li>
          <li>Swing the instant your dash ends to land the Dash Attack — don't waste it.</li>
        </ul>
        <p>
          Used offensively, dashing straight into an opponent and following up
          with the Dash Attack is the fastest way to close distance and land
          the hardest hit in the game. Used defensively, it buys you a clean
          reset out of a bad position — just remember you can't block again
          right away.
        </p>
      </>
    ),
  },
  {
    id:    "block",
    num:   "VI",
    title: "BLOCKING",
    content: (
      <>
        <p>
          Hold <kbd>SPACE</kbd> for a beat to enter block stance. Sharply reduces
          how far you get knocked back and how fast your voltage arc climbs.
          You can still move slowly while blocking — it's a stance, not a freeze.
        </p>
        <ul className="mn-list">
          <li>Cannot block in the air.</li>
          <li>Cannot block right after a dash — your guard needs a moment to come back up.</li>
          <li>Cannot block while attacking.</li>
          <li>
            Cannot block when your arc is{" "}
            <strong className="mn-danger">fully red</strong> — your only
            options are to jump and dash.
          </li>
        </ul>
        <div className="mn-tip">
          💡 Holding block slowly drains your voltage arc. At high charge it can
          pull you back from the red zone — but every moment you're holding it, you're not
          moving fast enough to react to a dash coming the other way.
        </div>
      </>
    ),
  },
  {
    id:    "voltage",
    num:   "VII",
    title: "VOLTAGE",
    content: (
      <>
        <p>
          The arc around your portrait tells you everything. It starts a cool
          blue when you're fresh, drifts through yellow as you absorb hits, and
          bleeds into deep red as you enter the danger zone. The farther along
          it is, the farther you'll fly when you get hit.
        </p>
        <p>
          The arc doesn't grow at a steady pace — early hits move it faster than
          later ones. The real danger comes when it maxes out and the arc starts
          flashing red and orange:{" "}
          <span className="mn-term">Critical State</span>. Block is disabled and
          almost any hit will launch you off stage. If you see your opponent
          flashing, one clean hit is all it takes.
        </p>
        <div className="mn-voltage-bar">
          <div className="mn-voltage-safe">🔵 Blue<br /><small>Safe</small></div>
          <div className="mn-voltage-warn">🟡 Yellow<br /><small>Danger</small></div>
          <div className="mn-voltage-crit">🔴 Red flash<br /><small>Critical</small></div>
        </div>
      </>
    ),
  },
  {
    id:    "tips",
    num:   "VIII",
    title: "PRO TIPS",
    content: (
      <ul className="mn-tips-list">
        <li>
          <span className="mn-tip-icon">⚡</span>
          <span><strong>Save the Dash Attack.</strong> Wait until your opponent's arc is deep yellow or red — that's when it almost guarantees a launch.</span>
        </li>
        <li>
          <span className="mn-tip-icon">🔄</span>
          <span><strong>Double Jump.</strong> You have 2 jumps. Both reset on landing. Use the second jump mid-air to recover after being launched.</span>
        </li>
        <li>
          <span className="mn-tip-icon">🛡️</span>
          <span><strong>Pre-block.</strong> Block takes a moment to kick in once you hold SPACE. Start holding it early — don't wait for the attack to land, it'll already be too late.</span>
        </li>
        <li>
          <span className="mn-tip-icon">💥</span>
          <span><strong>Collision bounce.</strong> Players overlapping push each other apart — if you're both moving toward each other, you both bounce back; if only one of you is moving, the still player gets shoved instead. Use it to reposition your opponent for a follow-up hit.</span>
        </li>
      </ul>
    ),
  },
];

export default function Manual({ onBack }) {
  const { t } = useTranslation();

  return (
    <div className="mn-page">
      {/* ── Sticky topbar: logo + back button, always visible ── */}
      <div className="mn-topbar">
        <img src={logoMiniImage} alt="Enuma Fighter" className="mn-topbar-logo" />
        <button type="button" className="mn-back-btn" onClick={onBack}>
          ← {t("manual.backToLobby")}
        </button>
      </div>

      <div className="mn-shell">
        <div className="mn-tome">

        {/* ── Corner ornaments ── */}
        {["tl", "tr", "bl", "br"].map((pos) => (
          <div key={pos} className={`mn-corner mn-corner-${pos}`} aria-hidden="true">
            <svg viewBox="0 0 60 60" xmlns="http://www.w3.org/2000/svg">
              <path d="M2 2 L2 24 L6 24 L6 6 L24 6 L24 2 Z" fill="currentColor" />
              <path d="M2 2 L14 14" stroke="currentColor" strokeWidth="1" fill="none" opacity="0.5" />
              <rect x="10" y="10" width="4" height="4" fill="currentColor" opacity="0.4" />
            </svg>
          </div>
        ))}

        {/* ── Cover ── */}
        <header className="mn-cover">
          <div className="mn-cover-eyebrow">{t("manual.coverEyebrow")}</div>
          <h1 className="mn-cover-title">ENUMA<br />FIGHTER</h1>
          <div className="mn-cover-divider" aria-hidden="true">
            <span>✦</span><span>✦</span><span>✦</span>
          </div>
          <p className="mn-cover-sub">{t("manual.coverSub")}</p>
        </header>

        {/* ── Body ── */}
        <div className="mn-body">
          {SECTIONS.map((sec) => (
            <section key={sec.id} className="mn-section">
              <div className="mn-section-header">
                <span className="mn-section-num">{sec.num}</span>
                <h2 className="mn-section-title">{sec.title}</h2>
              </div>
              <div className="mn-section-body">{sec.content}</div>
            </section>
          ))}
        </div>

        {/* ── Footer ── */}
        <footer className="mn-footer">
          <span className="mn-footer-mark">ENUMA FIGHTER · REV 1.0</span>
        </footer>

      </div>
      </div>
    </div>
  );
}
