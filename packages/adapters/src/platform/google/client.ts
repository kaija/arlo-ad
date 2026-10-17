// Thin seam over google-ads-api so the adapter can be tested with recorded rows.
import { GoogleAdsApi, type Customer, type MutateOperation, type services } from 'google-ads-api';
import type { Row } from './mappers';

export interface GoogleAdsCredentials {
  /** Deprecated: Google retired developer tokens on 2026-09-09 and ignores the header. Unset or empty: no header. */
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
  const developerToken = creds.developerToken || undefined;
  const api = new GoogleAdsApi({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    // Required by the library's types; the header is dropped below when no token is set.
    developer_token: developerToken ?? '',
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
      if (!developerToken) omitDeveloperTokenHeader(c);
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

/**
 * Removes `developer-token` from the headers of every call this Customer makes. google-ads-api 25
 * always sets the header, and the API answers an empty value with DEVELOPER_TOKEN_PARAMETER_MISSING,
 * although tokens were retired on 2026-09-09 and requests without the header succeed. gRPC and REST
 * calls both read the protected `callHeaders` getter from the instance, so an own getter covers both.
 */
function omitDeveloperTokenHeader(c: Customer): void {
  const proto = Object.getPrototypeOf(c) as object;
  Object.defineProperty(c, 'callHeaders', {
    configurable: true,
    get() {
      const { 'developer-token': _omitted, ...headers } = Reflect.get(proto, 'callHeaders', c) as Record<string, string>;
      return headers;
    },
  });
}
