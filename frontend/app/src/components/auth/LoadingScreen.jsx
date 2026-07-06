import logoImage from "../../../assets/logo.png";

function AuthHeader({ title, subtitle }) {
  return (
    <>
      <div className="auth-brandmark">
        <img
          src={logoImage}
          alt="Enuma Fighter logo"
          className="auth-brandmark-image"
        />
      </div>
      <p className="auth-eyebrow">ft_transcendence</p>
      <h1 className="auth-title">{title}</h1>
      {subtitle ? <p className="auth-subtitle">{subtitle}</p> : null}
    </>
  );
}

function LegalFooter({ onPrivacy, onTerms }) {
  return (
    <div className="legal-footer">
      <button type="button" className="auth-link" onClick={onPrivacy}>
        Privacy Policy
      </button>
      <span className="legal-separator">|</span>
      <button type="button" className="auth-link" onClick={onTerms}>
        Terms of Service
      </button>
    </div>
  );
}

export default function LoadingScreen({ onPrivacy, onTerms }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader
          title="Checking session"
          subtitle={
            <>
              The app is asking the backend whether the <code>sid</code> cookie
              is still valid.
            </>
          }
        />
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}
