import type { TFunction } from "i18next";
import i18n from "../i18n";

/** The text of the HelixSync recovery kit (docs/encryption.md §9.1): what a
 * user prints or saves next to their recovery code. Built in the browser and
 * never sent anywhere. Worded in the interface language. */
export interface RecoveryKit {
  email: string;
  serverUrl: string;
  code: string;
  generatedAt: Date;
}

export function recoveryKitSteps(t: TFunction = i18n.t): string[] {
  return [t("kit.step1"), t("kit.step2", { forgot: t("login.forgot") }), t("kit.step3")];
}

export function recoveryKitWarning(t: TFunction = i18n.t): string {
  return t("kit.warning");
}

/** ISO date (YYYY-MM-DD): unambiguous in every language. */
export function recoveryKitDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function recoveryKitText(kit: RecoveryKit, t: TFunction = i18n.t): string {
  return [
    t("kit.title"),
    "",
    `${t("kit.account")}: ${kit.email}`,
    `${t("kit.server")}: ${kit.serverUrl}`,
    `${t("kit.recoveryCode")}: ${kit.code}`,
    `${t("kit.generated")}: ${recoveryKitDate(kit.generatedAt)}`,
    "",
    t("kit.ifForget"),
    ...recoveryKitSteps(t).map((step, i) => `  ${i + 1}. ${step}`),
    "",
    recoveryKitWarning(t),
    "",
  ].join("\n");
}
