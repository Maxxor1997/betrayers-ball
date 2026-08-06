export type { NewGameSetup } from "@/app/components/NewGameModal";

/** A flip the human has tapped/clicked but not yet confirmed. */
export interface PendingFlip {
  instanceId: string;
  label: string;
}
