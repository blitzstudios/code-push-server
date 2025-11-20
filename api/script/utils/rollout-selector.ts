// Copyright (c) Microsoft Corporation.
// Licensed under the MIT License.

const DELIMITER = "-";
const MS_PER_MINUTE = 60 * 1000;

export interface RolloutComputationInput {
  rollout?: number;
  holdDurationMinutes?: number;
  rampDurationMinutes?: number;
  uploadTime?: number;
}

function getHashCode(input: string): number {
  let hash: number = 0;

  if (input.length === 0) {
    return hash;
  }

  for (let i = 0; i < input.length; i++) {
    const chr = input.charCodeAt(i);
    hash = (hash << 5) - hash + chr;
  }

  return hash;
}

export function isSelectedForRollout(clientId: string, rollout: number, releaseTag: string): boolean {
  const identifier: string = clientId + DELIMITER + releaseTag;
  const hashValue: number = getHashCode(identifier);
  return Math.abs(hashValue) % 100 < rollout;
}

export function isUnfinishedRollout(rollout: number): boolean {
  return rollout !== null && rollout !== undefined && rollout !== 100;
}

export function getEffectiveRollout(rolloutInput: RolloutComputationInput, now: number = Date.now()): number {
  if (!rolloutInput) {
    return null;
  }

  const rollout = rolloutInput.rollout;
  if (!isUnfinishedRollout(rollout)) {
    return rollout === null || rollout === undefined ? 100 : rollout;
  }

  const uploadTime = rolloutInput.uploadTime;
  const holdDurationMinutes = rolloutInput.holdDurationMinutes || 0;
  const rampDurationMinutes = rolloutInput.rampDurationMinutes || 0;

  const baseRollout = typeof rollout === "number" ? rollout : 0;

  if (!uploadTime) {
    return baseRollout;
  }

  const elapsedMs = now - uploadTime;
  const holdMs = holdDurationMinutes * MS_PER_MINUTE;

  if ((holdMs > 0 && elapsedMs < holdMs) || (holdMs === 0 && elapsedMs < 0)) {
    return baseRollout;
  }

  if (rampDurationMinutes <= 0) {
    return baseRollout;
  }

  const rampMs = rampDurationMinutes * MS_PER_MINUTE;
  const rampElapsed = Math.max(0, elapsedMs - holdMs);
  if (rampElapsed <= 0) {
    return baseRollout;
  }

  const progress = Math.min(1, rampElapsed / rampMs);
  const computed = baseRollout + (100 - baseRollout) * progress;

  return Math.min(100, Math.max(baseRollout, Math.round(computed * 1000) / 1000));
}
