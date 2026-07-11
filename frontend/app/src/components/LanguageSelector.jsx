import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "./language-selector.css";

const LANGUAGE_OPTIONS = [
  { code: "ca", flag: "🇦🇩" },
  { code: "es", flag: "🇪🇸" },
  { code: "en", flag: "🇬🇧" },
  { code: "ru", flag: "🇷🇺" },
];

export default function LanguageSelector({ variant = "manual", compact = false }) {
  const { t, i18n } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const menuRef = useRef(null);
  const currentLanguage = (i18n.resolvedLanguage || i18n.language || "es").slice(0, 2);
  const activeLanguage =
    LANGUAGE_OPTIONS.find(({ code }) => code === currentLanguage) || LANGUAGE_OPTIONS[0];

  useEffect(() => {
    if (!isOpen) return undefined;

    function handleClickOutside(event) {
      if (!menuRef.current?.contains(event.target)) {
        setIsOpen(false);
      }
    }

    function handleEscape(event) {
      if (event.key === "Escape") {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [isOpen]);

  function handleLanguageSelect(languageCode) {
    const hasResources = !!i18n.getResourceBundle(languageCode, "translation");
    if (!hasResources) {
      setIsOpen(false);
      return;
    }
    i18n.changeLanguage(languageCode);
    setIsOpen(false);
  }

  const rootClassName = compact
    ? `langsel langsel-${variant} langsel-compact`
    : `langsel langsel-${variant}`;

  return (
    <div className={rootClassName} ref={menuRef}>
      <button
        type="button"
        className="langsel-trigger"
        aria-label={t("language.label")}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="langsel-trigger-main">
          <span className="langsel-flag" aria-hidden="true">{activeLanguage.flag}</span>
          <span className="langsel-code">{currentLanguage.toUpperCase()}</span>
        </span>
        <span className={isOpen ? "langsel-arrow langsel-arrow-open" : "langsel-arrow"} aria-hidden="true">
          ▾
        </span>
      </button>

      {isOpen ? (
        <div className="langsel-menu" role="menu" aria-label={t("language.label")}>
          {LANGUAGE_OPTIONS.map(({ code, flag }) => (
            <button
              key={code}
              type="button"
              className={code === currentLanguage ? "langsel-option langsel-option-active" : "langsel-option"}
              role="menuitemradio"
              aria-checked={code === currentLanguage}
              onClick={() => handleLanguageSelect(code)}
            >
              <span className="langsel-option-main">
                <span className="langsel-flag" aria-hidden="true">{flag}</span>
                <span>{t(`language.${code}`)}</span>
              </span>
              {code === currentLanguage ? <span className="langsel-check">●</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
