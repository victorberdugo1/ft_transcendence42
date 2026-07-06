import Login from "@src/pages/auth/Login.jsx";
import Register from "@src/pages/auth/Register.jsx";
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

export default function AuthGate({
  view,
  onChangeView,
  onLogin,
  onPrivacy,
  onTerms,
}) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader title="Sign in to play" />
        <div className="auth-tabs">
          <button
            type="button"
            className={
              view === "login" ? "auth-tab auth-tab-active" : "auth-tab"
            }
            onClick={() => onChangeView("login")}
          >
            Login
          </button>
          <button
            type="button"
            className={
              view === "register" ? "auth-tab auth-tab-active" : "auth-tab"
            }
            onClick={() => onChangeView("register")}
          >
            Register
          </button>
        </div>
        {view === "login" ? (
          <Login
            onLogin={onLogin}
            onSwitchToRegister={() => onChangeView("register")}
          />
        ) : (
          <Register
            onLogin={onLogin}
            onSwitchToLogin={() => onChangeView("login")}
          />
        )}
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} />
      </div>
    </div>
  );
}
