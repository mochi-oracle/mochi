export interface TdxCollateral {
  pck_crl_issuer_chain: string;
  root_ca_crl: string;
  pck_crl: string;
  tcb_info_issuer_chain: string;
  tcb_info: string;
  tcb_info_signature: string;
  qe_identity_issuer_chain: string;
  qe_identity: string;
  qe_identity_signature: string;
}

export interface CollateralSource {
  get(fmspc: string, ca: "platform" | "processor"): Promise<TdxCollateral>;
}

export class StaticCollateralSource implements CollateralSource {
  constructor(private readonly collateral: TdxCollateral) {}

  async get(_fmspc: string, _ca: "platform" | "processor"): Promise<TdxCollateral> {
    return this.collateral;
  }
}

/** Validate the string fields in a fixture or externally supplied collateral object. */
export function parseCollateralJson(value: unknown): TdxCollateral {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collateral shape");
  const source = value as Record<string, unknown>;
  const keys = [
    "pck_crl_issuer_chain",
    "root_ca_crl",
    "pck_crl",
    "tcb_info_issuer_chain",
    "tcb_info",
    "tcb_info_signature",
    "qe_identity_issuer_chain",
    "qe_identity",
    "qe_identity_signature",
  ] as const;
  const output = {} as TdxCollateral;
  for (const key of keys) {
    if (typeof source[key] !== "string") throw new Error("collateral shape");
    output[key] = source[key] as never;
  }
  return output;
}
