// Conversion tracking health (ADR-0021, Requirements 16.1, 16.2). Pure: given what Google Ads
// reports about each conversion action, decide whether tracking looks broken.

export type HealthStatus = 'ok' | 'warn' | 'critical';

export interface ConversionActionHealthInput {
  externalId: string;
  name: string;
  status: string;
  primary: boolean;
  lastConversionAt: Date | null;
  conversions30d: number;
  /** Offline / enhanced conversions upload summary, when the action uploads conversions. */
  ecDiagnostics?: { status?: string | null; alerts?: unknown[] | null; totalEventCount?: number; successfulEventCount?: number } | null;
}

export interface HealthIssue {
  code: 'SILENT' | 'NOT_ENABLED' | 'NO_CONVERSIONS_30D' | 'UPLOAD_NEEDS_ATTENTION' | 'NO_RECENT_UPLOAD' | 'UPLOAD_ERRORS';
  severity: Exclude<HealthStatus, 'ok'>;
  message: string;
}

export interface ConversionActionHealth {
  externalId: string;
  name: string;
  status: HealthStatus;
  issues: HealthIssue[];
  /** Average conversions per day over the last 30 days. */
  dailyAverage: number;
  hoursSinceLast: number | null;
}

export interface HealthOptions {
  /** A primary action this long without conversions is suspect (Requirement 16.2: 24h). */
  silentHours?: number;
  /** ...if it usually converts at least this many times a day. */
  minDailyAverage?: number;
  /** Upload success rate below which diagnostics count as errors. */
  minUploadSuccessRate?: number;
}

const worst = (issues: readonly HealthIssue[]): HealthStatus => (issues.some((i) => i.severity === 'critical') ? 'critical' : issues.length ? 'warn' : 'ok');

export function assessConversionAction(a: ConversionActionHealthInput, now: Date, opts: HealthOptions = {}): ConversionActionHealth {
  const silentHours = opts.silentHours ?? 24;
  const minDaily = opts.minDailyAverage ?? 1;
  const dailyAverage = a.conversions30d / 30;
  const hoursSinceLast = a.lastConversionAt ? Math.max(0, (now.getTime() - a.lastConversionAt.getTime()) / 3_600_000) : null;
  const issues: HealthIssue[] = [];
  const enabled = a.status === 'ENABLED';

  if (a.primary && !enabled) issues.push({ code: 'NOT_ENABLED', severity: 'warn', message: `主要轉換動作狀態為 ${a.status}` });
  if (a.primary && enabled) {
    if (dailyAverage >= minDaily && (hoursSinceLast === null || hoursSinceLast > silentHours)) {
      issues.push({
        code: 'SILENT',
        severity: 'critical',
        message: `已 ${hoursSinceLast === null ? '超過 30 天' : `${Math.floor(hoursSinceLast)} 小時`}沒有轉換（過去 30 天日均 ${dailyAverage.toFixed(1)}），追蹤可能失效`,
      });
    } else if (a.conversions30d === 0) {
      issues.push({ code: 'NO_CONVERSIONS_30D', severity: 'warn', message: '近 30 天沒有任何轉換' });
    }
  }

  const d = a.ecDiagnostics;
  if (d) {
    if (d.status === 'NEEDS_ATTENTION') issues.push({ code: 'UPLOAD_NEEDS_ATTENTION', severity: 'warn', message: '轉換上傳診斷需要注意' });
    if (d.status === 'NO_RECENT_UPLOAD') issues.push({ code: 'NO_RECENT_UPLOAD', severity: a.primary ? 'critical' : 'warn', message: '最近沒有轉換上傳' });
    const total = d.totalEventCount ?? 0;
    const rate = total > 0 ? (d.successfulEventCount ?? 0) / total : null;
    if ((d.alerts?.length ?? 0) > 0 || (rate !== null && rate < (opts.minUploadSuccessRate ?? 0.9))) {
      issues.push({ code: 'UPLOAD_ERRORS', severity: 'warn', message: `上傳有錯誤${rate === null ? '' : `（成功率 ${Math.round(rate * 100)}%）`}` });
    }
  }
  return { externalId: a.externalId, name: a.name, status: worst(issues), issues, dailyAverage, hoursSinceLast };
}

export interface TrackingHealth {
  status: HealthStatus;
  actions: ConversionActionHealth[];
  /** No enabled primary action at all: nothing optimizes toward a goal. */
  noPrimary: boolean;
}

export function assessTracking(actions: readonly ConversionActionHealthInput[], now: Date, opts?: HealthOptions): TrackingHealth {
  const assessed = actions.map((a) => assessConversionAction(a, now, opts));
  const noPrimary = !actions.some((a) => a.primary && a.status === 'ENABLED');
  const status = noPrimary ? 'critical' : assessed.some((a) => a.status === 'critical') ? 'critical' : assessed.some((a) => a.status === 'warn') ? 'warn' : 'ok';
  return { status, actions: assessed, noPrimary };
}
