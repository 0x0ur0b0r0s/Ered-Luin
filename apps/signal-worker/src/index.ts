/** G0 worker shell; collection waits for a later gate to add persistent budget accounting. */
export const signalWorkerStatus = {
  enabled: false,
  externalRequestsEnabled: false,
  schedule: null,
} as const;
