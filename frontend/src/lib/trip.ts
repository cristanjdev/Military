/** Stages of an issued firearm's trip: camp -> assigned destination (90-minute hold) -> camp. */
export type TripStage = "at_camp" | "outbound" | "on_site" | "returning" | "back_at_camp";

export const TRIP_STAGE_LABEL: Record<TripStage, string> = {
  at_camp: "At camp, not yet left",
  outbound: "Heading to destination",
  on_site: "At destination",
  returning: "Returning to camp",
  back_at_camp: "Back at camp",
};

/** The destination can still change until the firearm gets there. */
export function destinationChangeable(stage?: TripStage | null): boolean {
  return !stage || stage === "at_camp" || stage === "outbound";
}

/** Trip notification types that sound the alarm (security alerts). */
export const TRIP_ALARM_TYPES = ["premature_departure", "off_route", "camp_exit_after_return"];
