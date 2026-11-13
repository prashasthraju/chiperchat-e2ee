export interface Device {
  id: string;
  userId: string;
  createdAt: string;
}

// Opaque serialized public bundle.
// The crypto package controls its internal format.
export interface PublicPreKeyBundle {
  deviceId: string;
  protocol: "signal";
  serializedBundle: string;
}