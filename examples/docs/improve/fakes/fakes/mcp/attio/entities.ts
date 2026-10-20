export type Company = { id: string; name: string };
export type Deal = { id: string; name: string; stage: string; company_id: string };

export type State = {
  companies: Company[];
  deals: Deal[];
  /** The id of a deal whose update the CRM rejects, set by a scenario. */
  failUpdate?: string;
};
