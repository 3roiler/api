import settingsService from './settings.js';

/**
 * „Für dich"-Algorithmus-Konfiguration. Wird vom Dashboard tunable
 * gehalten, damit Gewichte und Fenstergrößen ohne Deploy angepasst
 * werden können. Defaults entsprechen den ursprünglich hartcodierten
 * Werten in `clipService.listPersonalFeed`, damit eine frische Instanz
 * sich identisch zu pre-Settings verhält.
 */

export const SETTING_FORYOU_W_MATCHING = 'clips.foryou.weight_matching';
export const SETTING_FORYOU_W_QUALITY = 'clips.foryou.weight_quality';
export const SETTING_FORYOU_W_RECENCY = 'clips.foryou.weight_recency';
export const SETTING_FORYOU_RECENCY_DAYS = 'clips.foryou.recency_window_days';
export const SETTING_FORYOU_FRESH_DAYS = 'clips.foryou.freshness_pool_days';
export const SETTING_FORYOU_MIN_SCORE = 'clips.foryou.min_positive_score';

export interface ForYouSettings {
  weightMatching: number;
  weightQuality: number;
  weightRecency: number;
  recencyWindowDays: number;
  freshnessPoolDays: number;
  minPositiveScore: number;
}

export const FORYOU_DEFAULTS: ForYouSettings = {
  weightMatching: 0.55,
  weightQuality: 0.30,
  weightRecency: 0.15,
  recencyWindowDays: 30,
  freshnessPoolDays: 14,
  minPositiveScore: 3
};

export async function readForYouSettings(): Promise<ForYouSettings> {
  const [
    weightMatching,
    weightQuality,
    weightRecency,
    recencyWindowDays,
    freshnessPoolDays,
    minPositiveScore
  ] = await Promise.all([
    settingsService.getSettingValue<number>(SETTING_FORYOU_W_MATCHING, FORYOU_DEFAULTS.weightMatching),
    settingsService.getSettingValue<number>(SETTING_FORYOU_W_QUALITY, FORYOU_DEFAULTS.weightQuality),
    settingsService.getSettingValue<number>(SETTING_FORYOU_W_RECENCY, FORYOU_DEFAULTS.weightRecency),
    settingsService.getSettingValue<number>(SETTING_FORYOU_RECENCY_DAYS, FORYOU_DEFAULTS.recencyWindowDays),
    settingsService.getSettingValue<number>(SETTING_FORYOU_FRESH_DAYS, FORYOU_DEFAULTS.freshnessPoolDays),
    settingsService.getSettingValue<number>(SETTING_FORYOU_MIN_SCORE, FORYOU_DEFAULTS.minPositiveScore)
  ]);
  return {
    weightMatching,
    weightQuality,
    weightRecency,
    recencyWindowDays,
    freshnessPoolDays,
    minPositiveScore
  };
}
