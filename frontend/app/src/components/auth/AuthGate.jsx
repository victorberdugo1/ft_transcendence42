import Login from "@src/pages/auth/Login.jsx";
import Register from "@src/pages/auth/Register.jsx";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import logoImage from "../../../assets/logo.png";

const LANGUAGE_OPTIONS = [
  { code: "ca", flag: "🇦🇩" },
  { code: "es", flag: "🇪🇸" },
  { code: "en", flag: "🇬🇧" },
];

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
  const { t, i18n } = useTranslation();
  const [isLanguageOpen, setIsLanguageOpen] = useState(false);
  const languageMenuRef = useRef(null);
  const currentLanguage = (i18n.resolvedLanguage || i18n.language || "es").slice(0, 2);

  const activeLang =
    LANGUAGE_OPTIONS.find(({ code }) => code === currentLanguage) || LANGUAGE_OPTIONS[0];

  useEffect(() => {
    function handleClickOutside(event) {
      if (!languageMenuRef.current?.contains(event.target)) {
        setIsLanguageOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsLanguageOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, []);

  function handleLanguageSelect(languageCode) {
    i18n.changeLanguage(languageCode);
    setIsLanguageOpen(false);
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-language-row" ref={languageMenuRef}>
          <button
            type="button"
            className="auth-language-trigger"
            aria-label={t("language.label")}
            aria-haspopup="menu"
            aria-expanded={isLanguageOpen}
            onClick={() => setIsLanguageOpen((prev) => !prev)}
          >
            <span className="auth-language-flag" aria-hidden="true">
              {activeLang.flag}
            </span>
          </button>

          {isLanguageOpen ? (
            <div className="auth-language-menu" role="menu" aria-label={t("language.label")}>
              {LANGUAGE_OPTIONS.map(({ code, flag }) => (
                <button
                  key={code}
                  type="button"
                  className={
                    code === currentLanguage
                      ? "auth-language-option auth-language-option-active"
                      : "auth-language-option"
                  }
                  role="menuitemradio"
                  aria-checked={code === currentLanguage}
                  onClick={() => handleLanguageSelect(code)}
                >
                  <span className="auth-language-flag" aria-hidden="true">{flag}</span>
                  <span>{t(`language.${code}`)}</span>
                </button>
              ))}
            </div>
          ) : null}
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
