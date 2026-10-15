// Thin seam over google-ads-api so the adapter can be tested with recorded rows.
import { GoogleAdsApi, type Customer, type MutateOperation, type services } from 'google-ads-api';
import type { Row } from './mappers';

export interface GoogleAdsCredentials {
  /** Deprecated: Google retired developer tokens on 2026-09-09 and ignores the header. */
  developerToken?: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager (MCC) account the client accounts are accessed through. */
  loginCustomerId: string;
}

export interface GoogleAdsClient {
  query(customerId: string, gaql: string): Promise<Row[]>;
  /** One atomic mutate request (partial_failure off, design.md「錯誤處理」). */
  mutate(customerId: string, operations: MutateOperation<Record<string, unknown>>[]): Promise<services.IMutateGoogleAdsResponse>;
  /** KeywordPlanIdeaService.GenerateKeywordIdeas. */
  keywordIdeas(customerId: string, request: services.IGenerateKeywordIdeasRequest): Promise<services.IGenerateKeywordIdeaResponse>;
  customer(customerId: string): Customer;
}

export function createGoogleAdsClient(creds: GoogleAdsCredentials): GoogleAdsClient {
  const api = new GoogleAdsApi({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    // google-ads-api 25 always sends a `developer-token` header, and its gRPC path stringifies the
    // value (undefined would go out as "undefined"), so pass '' when unset. Revisit on the API
    // version that rejects the header: the library should drop it then.
    developer_token: creds.developerToken ?? '',
  });
  const customers = new Map<string, Customer>();
  const customer = (customerId: string) => {
    let c = customers.get(customerId);
    if (!c) {
      c = api.Customer({
        customer_id: customerId,
        refresh_token: creds.refreshToken,
        login_customer_id: creds.loginCustomerId.replace(/-/g, ''),
      });
      customers.set(customerId, c);
    }
    return c;
  };
  return {
    customer,
    query: (customerId, gaql) => customer(customerId).query(gaql),
    keywordIdeas: (customerId, request) => customer(customerId).keywordPlanIdeas.generateKeywordIdeas(request as services.GenerateKeywordIdeasRequest),
    mutate: (customerId, operations) => customer(customerId).mutateResources(operations, { partial_failure: false }),
  };
}
