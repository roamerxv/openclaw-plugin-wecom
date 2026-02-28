import { DEFAULT_ACCOUNT_ID } from "./constants.js";

export function normalizeWecomAllowFromEntry(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  return trimmed
    .replace(/^(wecom|wework):/i, "")
    .replace(/^user:/i, "")
    .toLowerCase();
}

export function resolveWecomAllowFrom(cfg, accountId) {
  const wecom = cfg?.channels?.wecom;
  if (!wecom) {
    return [];
  }

  const normalizedAccountId = String(accountId || DEFAULT_ACCOUNT_ID)
    .trim()
    .toLowerCase();
  const accounts = wecom.accounts;
  const account =
    accounts && typeof accounts === "object"
      ? (accounts[accountId] ??
        accounts[
          Object.keys(accounts).find((key) => key.toLowerCase() === normalizedAccountId) ?? ""
        ])
      : undefined;

  const allowFromRaw =
    account?.dm?.allowFrom ?? account?.allowFrom ?? wecom.dm?.allowFrom ?? wecom.allowFrom ?? [];

  if (!Array.isArray(allowFromRaw)) {
    return [];
  }

  return allowFromRaw.map(normalizeWecomAllowFromEntry).filter((entry) => Boolean(entry));
}

export function resolveWecomCommandAuthorized({ cfg, accountId, senderId }) {
  const sender = String(senderId ?? "")
    .trim()
    .toLowerCase();
  if (!sender) {
    return false;
  }

  const allowFrom = resolveWecomAllowFrom(cfg, accountId);
  if (allowFrom.includes("*") || allowFrom.length === 0) {
    return true;
  }
  return allowFrom.includes(sender);
}
