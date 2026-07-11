import LanguageSelector from "@src/components/LanguageSelector.jsx";
import Login from "@src/pages/auth/Login.jsx";
import Register from "@src/pages/auth/Register.jsx";
import { useTranslation } from "react-i18next";
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

function LegalFooter({ onPrivacy, onTerms, t }) {
  return (
    <div className="legal-footer">
      <button type="button" className="auth-link" onClick={onPrivacy}>
        {t("auth.privacy")}
      </button>
      <span className="legal-separator">|</span>
      <button type="button" className="auth-link" onClick={onTerms}>
        {t("auth.terms")}
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
  const { t } = useTranslation();

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-language-row">
          <LanguageSelector variant="auth" compact />
        </div>

        <AuthHeader title={t("auth.title")} />
        <div className="auth-tabs">
          <button
            type="button"
            className={
              view === "login" ? "auth-tab auth-tab-active" : "auth-tab"
            }
            onClick={() => onChangeView("login")}
          >
            {t("auth.tabLogin")}
          </button>
          <button
            type="button"
            className={
              view === "register" ? "auth-tab auth-tab-active" : "auth-tab"
            }
            onClick={() => onChangeView("register")}
          >
            {t("auth.tabRegister")}
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
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} t={t} />
      </div>
    </div>
  );
}
