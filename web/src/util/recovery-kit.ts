/** The text of the HelixSync recovery kit (docs/encryption.md §9.1): what a
 * user prints or saves next to their recovery code. Built in the browser and
 * never sent anywhere. */
export interface RecoveryKit {
  email: string;
  serverUrl: string;
  code: string;
  generatedAt: Date;
}

export const RECOVERY_KIT_STEPS = [
  "Open the HelixSync sign-in page at the server address above.",
  'Choose "Forgot your password?".',
  "Enter your account email and this recovery code, then pick a new password.",
];

export const RECOVERY_KIT_WARNING =
  "Each code works once: you get a new one after using it. Keep this kit offline and private; anyone with it and your email can reset your password and read your synced data.";

export function recoveryKitDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function recoveryKitText(kit: RecoveryKit): string {
  return [
    "HelixSync recovery kit",
    "",
    `Account: ${kit.email}`,
    `Server: ${kit.serverUrl}`,
    `Recovery code: ${kit.code}`,
    `Generated: ${recoveryKitDate(kit.generatedAt)}`,
    "",
    "If you forget your password:",
    ...RECOVERY_KIT_STEPS.map((step, i) => `  ${i + 1}. ${step}`),
    "",
    RECOVERY_KIT_WARNING,
    "",
  ].join("\n");
}
