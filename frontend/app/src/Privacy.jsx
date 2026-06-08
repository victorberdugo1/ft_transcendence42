import logoImage from "../assets/logo.png";

export default function Privacy({ onBack }) {
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
        <h1 className="auth-title">Privacy Policy</h1>
        <p className="auth-subtitle">
          This project is an academic web application created as part of the 42
          curriculum. This page explains what user data is processed and why.
        </p>

        <section className="legal-section">
          <h2>What we collect</h2>
          <p>
            We collect the basic account data needed to create and maintain a
            user profile, such as username, email address, and a hashed password.
            We may also store profile related information like avatar, match
            history, friend relationships, and tournament activity.
          </p>
        </section>

        <section className="legal-section">
          <h2>How we use data</h2>
          <p>
            Account data is used to authenticate users, keep sessions active,
            show profile information, and enable social and gameplay features of
            the platform. We do not use this data for advertising purposes.
          </p>
        </section>

        <section className="legal-section">
          <h2>Cookies and sessions</h2>
          <p>
            The application uses an HttpOnly session cookie named <code>sid</code>.
            This cookie allows the backend to identify an authenticated session
            without exposing the session token to frontend JavaScript.
          </p>
        </section>

        <section className="legal-section">
          <h2>Data retention</h2>
          <p>
            User data is kept only for project functionality and evaluation.
            Since this is an academic project, data may be deleted, reset, or
            replaced during development, testing, or demonstration phases.
          </p>
        </section>

        <section className="legal-section">
          <h2>Contact</h2>
          <p>
            If you need information about the handling of your account data,
            please contact the student team responsible for this project build.
          </p>
        </section>
      </div>
    </div>
  );
}
