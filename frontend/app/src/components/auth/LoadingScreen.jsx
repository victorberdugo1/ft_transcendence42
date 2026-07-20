import { useState } from "react";
import { useTranslation } from "react-i18next";
import logoImage from "../../../assets/logo.png";

function readPostMatchReloadFlag() {
  try {
    return sessionStorage.getItem("postMatchReload") === "1";
  } catch (_) {
    return false;
  }
}

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

export default function LoadingScreen({ onPrivacy, onTerms }) {
  const { t } = useTranslation();
  // Captured once at mount: a full reload right after a match sets this flag
  // just before reloading, but ws-client.js clears it once the socket
  // reopens, so we snapshot it here instead of re-reading on every render.
  const [isPostMatchReload] = useState(readPostMatchReloadFlag);

  return (
    <div className="auth-page">
      <div className="auth-card">
        <AuthHeader
          title={t(isPostMatchReload ? "auth.returningToLobby" : "auth.checkingSession")}
          subtitle={t(isPostMatchReload ? "auth.returningToLobbySubtitle" : "auth.checkingSessionSubtitle")}
        />
        <LegalFooter onPrivacy={onPrivacy} onTerms={onTerms} t={t} />
      </div>
    </div>
  );
}
