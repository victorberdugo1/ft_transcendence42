import LanguageSelector from "@src/components/LanguageSelector.jsx";
import PageBackButton from "@src/components/ui/PageBackButton.jsx";
import { useRef } from "react";
import { useTranslation } from "react-i18next";
import logoMiniImage from "../../../assets/logomini.png";
import "./manual.css";

const SECTION_ORDER = ["objective", "arena", "controls", "attacks", "dash", "block", "voltage", "tips"];

const CONTROL_BINDINGS = [
  { key: "move", primary: ["A", "D"], secondary: ["←", "→"] },
  { key: "jump", primary: ["W"], secondary: ["↑"] },
  { key: "attackBlock", primary: ["SPACE"] },
  { key: "dash", primary: ["← ←"], secondary: ["→ →"], noteKey: "dashNote" },
  { key: "crouch", primary: ["S"], secondary: ["↓"] },
];

const TIP_MARKERS = ["01", "02", "03", "04"];

const STAGE_LAYOUTS = [
  {
    main: { left: "3%", right: "3%" },
    platforms: [
      { left: "14%", width: "15%", bottom: "38%", height: "6px" },
      { right: "14%", width: "15%", bottom: "38%", height: "6px" },
      { left: "50%", transform: "translateX(-50%)", width: "15%", bottom: "60%", height: "6px" },
    ],
    player: { left: "30%" },
  },
  {
    main: { left: "3%", right: "3%" },
    platforms: [
      { left: "22%", width: "14%", bottom: "32%", height: "6px" },
      { right: "22%", width: "14%", bottom: "32%", height: "6px" },
      { left: "50%", transform: "translateX(-50%)", width: "14%", bottom: "52%", height: "6px" },
    ],
    player: { left: "60%" },
  },
  {
    main: { left: "31%", right: "31%" },
    platforms: [
      { left: "10%", width: "16%", bottom: "72%", height: "6px" },
      { right: "10%", width: "16%", bottom: "72%", height: "6px" },
      { left: "50%", transform: "translateX(-50%)", width: "14%", bottom: "45%", height: "6px" },
    ],
    player: { left: "50%" },
  },
  {
    main: { left: "3%", right: "3%" },
    platforms: [],
    player: { left: "55%" },
  },
];

function renderParagraphs(items) {
  return items.map((text, index) => <p key={index}>{text}</p>);
}

export default function Manual({ onBack }) {
  const { t } = useTranslation();
  const sectionRefs = useRef({});
  const manual = t("manual", { returnObjects: true });
  const sections = SECTION_ORDER.map((id) => ({ id, ...manual.sections[id] }));
  const controls = manual.sections.controls;
  const attacks = manual.sections.attacks;
  const arena = manual.sections.arena;
  const voltage = manual.sections.voltage;
  const tips = manual.sections.tips;

  function handleSectionJump(sectionId) {
    const target = sectionRefs.current[sectionId];
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="mn-page">
      <div className="mn-topbar">
        <div className="mn-topbar-brand">
          <img src={logoMiniImage} alt="Enuma Fighter" className="mn-topbar-logo" />
          <span className="mn-topbar-label">{manual.hero.eyebrow}</span>
        </div>
        <div className="mn-topbar-actions">
          <LanguageSelector variant="manual" compact />
          <PageBackButton onClick={onBack}>
            ← {manual.backToLobby}
          </PageBackButton>
        </div>
      </div>

      <div className="mn-shell">
        <header className="mn-hero grid grid-cols-[minmax(0,1.4fr)_minmax(280px,0.9fr)] max-[980px]:grid-cols-1 gap-[22px]">
          <div className="mn-hero-copy">
            <p className="mn-hero-kicker">{manual.hero.eyebrow}</p>
            <h1 className="mn-hero-title">{manual.hero.title}</h1>
            <p className="mn-hero-subtitle">{manual.hero.subtitle}</p>
            <p className="mn-hero-description">{manual.hero.description}</p>
          </div>
          <div className="mn-hero-stats">
            {manual.quickFacts.map((fact) => (
              <div key={`${fact.value}-${fact.label}`} className="mn-stat-card">
                <strong>{fact.value}</strong>
                <span>{fact.label}</span>
              </div>
            ))}
          </div>
        </header>

        <div className="mn-layout grid grid-cols-[240px_minmax(0,1fr)] max-[980px]:grid-cols-1 gap-5">
          <aside className="mn-rail">
            <p className="mn-rail-label">{manual.tocLabel}</p>
            <nav className="mn-rail-nav" aria-label={manual.tocLabel}>
              {sections.map((section) => (
                <button
                  key={section.id}
                  type="button"
                  className="mn-rail-link"
                  onClick={() => handleSectionJump(section.id)}
                >
                  <span>{section.num}</span>
                  <strong>{section.title}</strong>
                </button>
              ))}
            </nav>
          </aside>

          <div className="mn-content">
            {sections.map((section) => (
              <section
                key={section.id}
                id={`manual-${section.id}`}
                className="mn-section"
                ref={(node) => {
                  if (node) sectionRefs.current[section.id] = node;
                }}
              >
                <div className="mn-section-heading">
                  <span className="mn-section-num">{section.num}</span>
                  <div>
                    <h2>{section.title}</h2>
                  </div>
                </div>

                {section.id === "objective" && renderParagraphs(section.paragraphs)}

                {section.id === "arena" && (
                  <>
                    {renderParagraphs(arena.intro)}
                    <div className="mn-stage-diagram">
                      <div className="mn-stage-diagram-head">
                        <span className="mn-stage-badge">{arena.stageBadge}</span>
                      </div>
                      <div className="mn-stage-variants">
                        {STAGE_LAYOUTS.map((layout, index) => (
                          <div key={arena.stageNames[index]} className="mn-stage-variant">
                            <div className="mn-stage-inner">
                              <div className="mn-stage-bound mn-stage-bound-l" />
                              <div className="mn-stage-bound mn-stage-bound-r" />
                              <div className="mn-stage-bound mn-stage-bound-b" />
                              <div className="mn-plat mn-plat-main" style={layout.main} />
                              {layout.platforms.map((platform, platformIndex) => (
                                <div key={platformIndex} className="mn-plat" style={platform} />
                              ))}
                              <div className="mn-player-dot" style={layout.player} />
                              <span className="mn-slabel mn-slabel-l">◀ {arena.boundaryLabels.left}</span>
                              <span className="mn-slabel mn-slabel-r">{arena.boundaryLabels.right} ▶</span>
                              <span className="mn-slabel mn-slabel-b">▼ {arena.boundaryLabels.bottom}</span>
                            </div>
                            <div className="mn-stage-name">{arena.stageNames[index]}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                    {renderParagraphs(arena.outro)}
                  </>
                )}

                {section.id === "controls" && (
                  <>
                    <p className="mn-section-intro">{controls.helper}</p>
                    <div className="mn-controls-grid">
                      {CONTROL_BINDINGS.map((binding) => (
                        <div key={binding.key} className="mn-control-card">
                          <span className="mn-control-label">{controls.items[binding.key]}</span>
                          <div className="mn-control-keys">
                            {binding.primary.map((key) => (
                              <kbd key={`${binding.key}-${key}`}>{key}</kbd>
                            ))}
                            {binding.secondary?.length ? <span className="mn-ctrl-or">{controls.or}</span> : null}
                            {binding.secondary?.map((key) => (
                              <kbd key={`${binding.key}-${key}`}>{key}</kbd>
                            ))}
                            {binding.noteKey ? <span className="mn-ctrl-note">({controls[binding.noteKey]})</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {section.id === "attacks" && (
                  <>
                    <p className="mn-section-intro">{attacks.intro}</p>
                    <div className="mn-move-list">
                      {attacks.moves.map((move, index) => (
                        <div key={move.name} className={`mn-move ${index === attacks.moves.length - 1 ? "mn-move-highlight" : ""}`}>
                          <div className="mn-move-input">{move.input}</div>
                          <div className="mn-move-info">
                            <strong>{move.name}</strong>
                            <span>{move.description}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="mn-callout">
                      <span className="mn-callout-label">{attacks.combo.label}</span>
                      <span className="mn-combo-chain">
                        {attacks.combo.hits.map((hit, index) => (
                          <span key={hit}>
                            {index > 0 ? <span className="mn-arrow">▶</span> : null}
                            {hit}
                          </span>
                        ))}
                      </span>
                      <span className="mn-callout-note">{attacks.combo.note}</span>
                    </div>
                    <p>{attacks.outro}</p>
                  </>
                )}

                {section.id === "dash" && (
                  <>
                    {renderParagraphs(section.paragraphs)}
                    <ul className="mn-list">
                      {section.bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </>
                )}

                {section.id === "block" && (
                  <>
                    {renderParagraphs(section.paragraphs)}
                    <ul className="mn-list">
                      {section.bullets.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                    <div className="mn-tip">{section.tip}</div>
                  </>
                )}

                {section.id === "voltage" && (
                  <>
                    {renderParagraphs(voltage.paragraphs)}
                    <div className="mn-voltage-bar">
                      {voltage.states.map((state) => (
                        <div key={state.label} className={`mn-voltage-state mn-voltage-${state.tone}`}>
                          <strong>{state.label}</strong>
                          <small>{state.caption}</small>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {section.id === "tips" && (
                  <ul className="mn-tips-list">
                    {tips.items.map((item, index) => (
                      <li key={item.title}>
                        <span className="mn-tip-icon">{TIP_MARKERS[index] || "00"}</span>
                        <div>
                          <strong>{item.title}</strong>
                          <p>{item.text}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </div>
        </div>

        <footer className="mn-footer">
          <span className="mn-footer-mark">{manual.footer}</span>
        </footer>
      </div>
    </div>
  );
}
