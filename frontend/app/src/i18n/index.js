import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import ca from "./locales/ca.json";
import en from "./locales/en.json";
import es from "./locales/es.json";
import fr from "./locales/fr.json";
import ru from "./locales/ru.json";

const DEFAULT_LANGUAGE = "es";
const SUPPORTED = ["ca", "es", "en", "ru", "fr"];

function detectLanguage() {
  try {
    const saved = localStorage.getItem("appLanguage");
    if (saved && SUPPORTED.includes(saved)) return saved;
  } catch (_) {
    // Ignore storage errors and fallback to navigator/default.
  }

  const browserLang = (navigator.language || "").toLowerCase();
  if (browserLang.startsWith("ca")) return "ca";
  if (browserLang.startsWith("en")) return "en";
  if (browserLang.startsWith("es")) return "es";
  if (browserLang.startsWith("ru")) return "ru";
  if (browserLang.startsWith("fr")) return "fr";
  return DEFAULT_LANGUAGE;
}

i18n.use(initReactI18next).init({
  resources: {
    ca: { translation: ca },
    es: { translation: es },
    en: { translation: en },
    ru: { translation: ru },
    fr: { translation: fr },
  },
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LANGUAGE,
  interpolation: {
    escapeValue: false,
  },
});

i18n.on("languageChanged", (lang) => {
  try {
    localStorage.setItem("appLanguage", lang);
  } catch (_) {
    // Ignore storage errors.
  }
});

export default i18n;
