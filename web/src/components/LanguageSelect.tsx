import { useTranslation } from "react-i18next";
import { LANGUAGES, isSupportedLanguage } from "../i18n/languages";
import { setLanguage } from "../i18n";

/** Picks the interface language; the choice is kept in this browser. */
export default function LanguageSelect({ className = "" }: { className?: string }) {
  const { t, i18n } = useTranslation();
  const current = isSupportedLanguage(i18n.resolvedLanguage) ? i18n.resolvedLanguage : "en";
  return (
    <select
      aria-label={t("common.language")}
      value={current}
      onChange={(e) => {
        if (isSupportedLanguage(e.target.value)) void setLanguage(e.target.value);
      }}
      className={`rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-700 ${className}`}
    >
      {LANGUAGES.map((l) => (
        <option key={l.code} value={l.code}>
          {l.name}
        </option>
      ))}
    </select>
  );
}
