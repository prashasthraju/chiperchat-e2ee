// Thrown for any non-2xx answer from the CipherChat server. `data` carries the
// server's structured detail; the SDK reads `data.code === "STALE_DEVICE"` to
// repair sessions with a reinstalled device.
export class RelayHttpError extends Error {
  override name = "RelayHttpError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

export class UnsupportedRelayFeatureError extends Error {
  override name = "UnsupportedRelayFeatureError";

  constructor(feature: string) {
    super(`CipherChat relay does not support ${feature}`);
  }
}

// This browser already holds the keys of a different account.
export class LocalDeviceOwnedByOtherUserError extends Error {
  override name = "LocalDeviceOwnedByOtherUserError";

  constructor(readonly ownerUserId: string) {
    super(`This browser holds the encryption keys of "${ownerUserId}"`);
  }
}
