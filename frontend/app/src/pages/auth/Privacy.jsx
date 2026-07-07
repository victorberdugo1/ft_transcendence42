import { useTranslation } from "react-i18next";
import logoImage from "../../../assets/logo.png";

export default function Privacy({ onBack }) {
  const { t } = useTranslation();
  const sections = t("privacySections", { returnObjects: true });

  return (
    <div className="auth-page">
      <div className="auth-card legal-card">
        <button type="button" className="auth-link legal-back" onClick={onBack}>
          {t("legal.back")}
        </button>

        <div className="legal-crest">
          <img
            src={logoImage}
            alt={t("legal.appName")}
            className="legal-crest-image"
          />
        </div>

        <p className="auth-eyebrow">{t("legal.appName")}</p>

        <h1 className="auth-title">
          {t("privacyTitle")}
        </h1>

        <p className="auth-subtitle">
          {t("privacyIntro")}
        </p>

        {sections.map((section) => (
          <section className="legal-section" key={section.title}>
            <h2>{section.title}</h2>

            {section.body.map((paragraph) => (
              <p key={paragraph}>{paragraph}</p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
