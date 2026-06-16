import {
  getConversionPointsByEventType,
  trackConversion,
} from '@line-crm/db';

export interface ConversionTrackPayload {
  friendId?: string;
  eventData?: Record<string, unknown>;
}

/** Map fireEvent types to additional conversion_point.event_type values. */
const CONVERSION_EVENT_ALIASES: Record<string, string[]> = {
  cv_fire: ['purchase'],
};

export function resolveConversionEventTypes(eventType: string): string[] {
  const types = new Set<string>([eventType]);
  for (const alias of CONVERSION_EVENT_ALIASES[eventType] ?? []) {
    types.add(alias);
  }
  return [...types];
}

/** Record conversion_events for all CV points whose event_type matches this event. */
export async function trackConversionsForEvent(
  db: D1Database,
  eventType: string,
  payload: ConversionTrackPayload,
): Promise<void> {
  if (!payload.friendId) return;

  const metadata =
    payload.eventData && Object.keys(payload.eventData).length > 0
      ? JSON.stringify(payload.eventData)
      : null;

  const trackedPointIds = new Set<string>();

  for (const lookupType of resolveConversionEventTypes(eventType)) {
    const points = await getConversionPointsByEventType(db, lookupType);
    for (const point of points) {
      if (trackedPointIds.has(point.id)) continue;
      trackedPointIds.add(point.id);
      await trackConversion(db, {
        conversionPointId: point.id,
        friendId: payload.friendId,
        metadata,
      });
    }
  }
}
