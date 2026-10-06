// Thin seam over google-ads-api so the adapter can be tested with recorded rows.
import { GoogleAdsApi, type Customer } from 'google-ads-api';
import type { Row } from './mappers';

export interface GoogleAdsCredentials {
  developerToken: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Manager (MCC) account the client accounts are accessed through. */
  loginCustomerId: string;
}

export interface GoogleAdsClient {
  query(customerId: string, gaql: string): Promise<Row[]>;
  customer(customerId: string): Customer;
}

export function createGoogleAdsClient(creds: GoogleAdsCredentials): GoogleAdsClient {
  const api = new GoogleAdsApi({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    developer_token: creds.developerToken,
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
  };
}
