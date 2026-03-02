const PREFIX = "evt_";

export function generateId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef && typeof cryptoRef.randomUUID === "function") {
    return `${PREFIX}${cryptoRef.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  }

  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${PREFIX}${time}${random}`.slice(0, 20);
}
