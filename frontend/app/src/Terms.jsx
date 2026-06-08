import logoImage from "../assets/logo.png";

export default function Terms({ onBack }) {
  return (
    <div className="auth-page">
      <div className="auth-card legal-card">
        <button type="button" className="auth-link legal-back" onClick={onBack}>
          Back
        </button>

        <div className="legal-crest">
          <img src={logoImage} alt="Enuma Fighter logo" className="legal-crest-image" />
        </div>

        <p className="auth-eyebrow">ft_transcendence</p>
        <h1 className="auth-title">Terms of Service</h1>
        <p className="auth-subtitle">
          These terms describe the expected use of this academic platform and
          the limits of the service provided by the student team.
        </p>

        <section className="legal-section">
          <h2>Use of the platform</h2>
          <p>
            The service is intended for gameplay, profile management, social
            interaction, and project evaluation within the scope of the
            ft_transcendence project.
          </p>
        </section>

        <section className="legal-section">
          <h2>Accounts</h2>
          <p>
            Users are responsible for the accuracy of the information they
            provide during registration and for the activity associated with
            their account while logged in.
          </p>
        </section>

        <section className="legal-section">
          <h2>Acceptable behavior</h2>
          <p>
            Users must not attempt to abuse the platform, impersonate other
            users, interfere with gameplay sessions, or use social features to
            harass or spam other participants.
          </p>
        </section>

        <section className="legal-section">
          <h2>Availability</h2>
          <p>
            This project is provided as is for learning and evaluation. The team
            does not guarantee uninterrupted availability, permanent storage, or
            production level reliability.
          </p>
        </section>

        <section className="legal-section">
          <h2>Academic project notice</h2>
          <p>
            This website is a student project. Features, data, and access rules
            may change at any time as part of development, testing, correction,
            or peer evaluation.
          </p>
        </section>
      </div>
    </div>
  );
}
