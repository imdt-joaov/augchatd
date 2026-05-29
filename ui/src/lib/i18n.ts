import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "@/locales/en.json";
import fr from "@/locales/fr.json";

export const SUPPORTED_LOCALES = ["en", "fr"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];
const DEFAULT_LOCALE: SupportedLocale = "en";

function resolveLocale(): SupportedLocale {
  const raw = new URLSearchParams(window.location.search).get("locale");
  if (raw === null) return DEFAULT_LOCALE;
  const normalized = raw.toLowerCase().split("-")[0];
  if ((SUPPORTED_LOCALES as readonly string[]).includes(normalized)) {
    return normalized as SupportedLocale;
  }
  console.warn(
    `augchatd: ?locale=${JSON.stringify(raw)} is not supported; ` +
      `falling back to ${DEFAULT_LOCALE}. Supported: ${SUPPORTED_LOCALES.join(", ")}.`,
  );
  return DEFAULT_LOCALE;
}

const lng = resolveLocale();

void i18n.use(initReactI18next).init({
  resources: {
    en: { common: en },
    fr: { common: fr },
  },
  lng,
  fallbackLng: DEFAULT_LOCALE,
  defaultNS: "common",
  ns: ["common"],
  interpolation: { escapeValue: false },
  returnNull: false,
});

document.documentElement.lang = lng;

export default i18n;
