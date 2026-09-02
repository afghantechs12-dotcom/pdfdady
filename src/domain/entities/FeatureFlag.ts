/**
 * FeatureFlag domain entity.
 *
 * A runtime toggle evaluated through the FeatureFlagService. `value` is an
 * optional JSON-serializable string for nuanced flags (rollout percentages,
 * variant keys). Domain entities carry no ORM or framework types — they are
 * plain data contracts the application and infrastructure layers map to/from.
 */
export interface FeatureFlag {
  key: string;
  enabled: boolean;
  value: string | null;
  updatedAt: Date;
}
