// GA4 Data API (ADR-0021, Requirement 16.3): daily sessions and key events (conversions) for
// paid Google traffic, compared with Google Ads conversions to spot tracking gaps.
import { BetaAnalyticsDataClient } from '@google-analytics/data';

/** GA4's paid Google Ads traffic. */
export const GOOGLE_CPC = 'google / cpc';

export interface Ga4DailyRow {
  date: string;
  sourceMedium: string;
  sessions: number;
  /** Key events (GA4 renamed "conversions" to key events). */
  conversions: number;
}

export interface Ga4Adapter {
  fetchDaily(propertyId: string, range: { from: string; to: string }): Promise<Ga4DailyRow[]>;
}

interface ReportResponse {
  rows?: { dimensionValues?: { value?: string | null }[] | null; metricValues?: { value?: string | null }[] | null }[] | null;
}

const PROPERTY = /^\d+$/;

/** GA4 dates come back as YYYYMMDD. */
export function mapGa4Report(response: ReportResponse): Ga4DailyRow[] {
  return (response.rows ?? []).flatMap((r) => {
    const [date, sourceMedium] = (r.dimensionValues ?? []).map((d) => d.value ?? '');
    const [sessions, conversions] = (r.metricValues ?? []).map((m) => Number(m.value ?? 0));
    if (!date || !/^\d{8}$/.test(date)) return [];
    return [{ date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`, sourceMedium: sourceMedium ?? '', sessions: sessions ?? 0, conversions: conversions ?? 0 }];
  });
}

/** `serviceAccountJson`: GA4_SERVICE_ACCOUNT_JSON (needs Viewer on the property). */
export function createGa4Adapter(serviceAccountJson: string): Ga4Adapter {
  const credentials = JSON.parse(serviceAccountJson) as { client_email: string; private_key: string; project_id?: string };
  const client = new BetaAnalyticsDataClient({ credentials, projectId: credentials.project_id });
  return {
    async fetchDaily(propertyId, range) {
      if (!PROPERTY.test(propertyId)) throw new Error(`invalid GA4 property id: ${propertyId}`);
      const [response] = await client.runReport({
        property: `properties/${propertyId}`,
        dateRanges: [{ startDate: range.from, endDate: range.to }],
        dimensions: [{ name: 'date' }, { name: 'sessionSourceMedium' }],
        metrics: [{ name: 'sessions' }, { name: 'keyEvents' }],
        dimensionFilter: { filter: { fieldName: 'sessionSourceMedium', stringFilter: { matchType: 'EXACT', value: GOOGLE_CPC } } },
        limit: 10_000,
      });
      return mapGa4Report(response);
    },
  };
}

/** In-memory GA4 for tests. */
export class FakeGa4Adapter implements Ga4Adapter {
  readonly calls: { propertyId: string; from: string; to: string }[] = [];
  private readonly rows = new Map<string, Ga4DailyRow[]>();

  set(propertyId: string, rows: Ga4DailyRow[]): this {
    this.rows.set(propertyId, rows);
    return this;
  }

  async fetchDaily(propertyId: string, range: { from: string; to: string }): Promise<Ga4DailyRow[]> {
    this.calls.push({ propertyId, ...range });
    return (this.rows.get(propertyId) ?? []).filter((r) => r.date >= range.from && r.date <= range.to);
  }
}
